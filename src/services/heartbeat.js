import cron from 'node-cron';
import { toSessionId } from './coreagent.js';

/** 动态巡检项的名称（由 AI 通过 mgmt_heartbeat_set 配置） */
export const DYNAMIC_CHECK_NAME = '动态巡检';

/**
 * 心跳机制
 * 定期执行系统自检和环境优化检查
 * 支持每个检查项单独设置 interval（cron 表达式）
 *
 * 检查项来源有两类：
 *   1. 静态检查项：config/heartbeat.yaml 的 heartbeat.checks
 *   2. 动态检查项：AI 通过 mgmt_heartbeat_get / mgmt_heartbeat_set 维护的内容，
 *      持久化在 heartbeat.yaml 的 heartbeat.dynamic_prompt 字段。
 *      之所以不与 checks 合并存放，是为了避免 WebUI 保存配置时被整块覆盖丢失。
 */
class Heartbeat {
  constructor(agent, config = {}) {
    this.agent = agent;
    this.enabled = config.enabled !== false;
    this.interval = config.interval || '*/5 * * * *'; // 全局默认 interval
    this.checks = config.checks || [];
    this.tasks = [];            // 静态检查项任务列表
    this.dynamicTask = null;    // 动态巡检任务
    this.taskContent = config.dynamic_prompt || '';
    this.onWarning = null;      // 警告回调: (message, result) => {}
    this._onDynamicChanged = null; // 动态巡检内容变更回调（用于持久化）
  }

  /**
   * 设置警告回调
   */
  setOnWarning(handler) {
    this.onWarning = handler;
  }

  /**
   * 设置动态巡检内容变更回调（用于写入 heartbeat.yaml）
   * @param {Function} handler - 接收 (content) 的回调
   */
  setOnDynamicChanged(handler) {
    this._onDynamicChanged = handler;
  }

  /**
   * 销毁一个 node-cron 任务
   *
   * node-cron v4 会把任务登记进全局 registry，只 stop() 只是停掉定时器、
   * 记录仍留在表里（心跳每次 reload 都会重建任务，会越积越多）。
   * 必须 destroy() 才会触发 task:destroyed 让 registry 摘除；
   * v3 没有 destroy()，退化用 stop()。
   */
  _destroyTask(task) {
    if (!task) return;
    if (typeof task.destroy === 'function') task.destroy();
    else task.stop();
  }

  /**
   * 启动心跳
   * 每个 check 使用自己的 interval，若未设置则使用全局 interval
   */
  start() {
    if (!this.enabled) {
      console.log('[Heartbeat] Disabled, skipping...');
      return;
    }

    console.log(`[Heartbeat] Starting (default interval: ${this.interval})`);

    for (const check of this.checks) {
      const checkInterval = check.interval || this.interval;

      const task = cron.schedule(checkInterval, async () => {
        await this._runCheck(check);
      }, {
        timezone: 'Asia/Shanghai',
      });

      this.tasks.push(task);
      console.log(`[Heartbeat] Scheduled "${check.name}" (${checkInterval})`);
    }

    // 动态巡检项（AI 可通过 mgmt_heartbeat_set 调整）
    this.dynamicTask = this._scheduleDynamic();
    if (this.dynamicTask) {
      console.log(`[Heartbeat] Scheduled "${DYNAMIC_CHECK_NAME}" (${this.interval})`);
    }

    console.log(`[Heartbeat] Started (${this.tasks.length} static + ${this.dynamicTask ? 1 : 0} dynamic check task(s))`);
  }

  /**
   * 停止心跳
   */
  stop() {
    for (const task of this.tasks) {
      this._destroyTask(task);
    }
    this.tasks = [];

    this._destroyTask(this.dynamicTask);
    this.dynamicTask = null;
    console.log('[Heartbeat] Stopped');
  }

  /**
   * 为动态巡检内容创建调度任务；内容为空时返回 null
   * @returns {object|null} node-cron 任务
   */
  _scheduleDynamic() {
    const content = (this.taskContent || '').trim();
    if (!content) return null;

    return cron.schedule(this.interval, async () => {
      await this._runCheck({ name: DYNAMIC_CHECK_NAME, prompt: content });
    }, {
      timezone: 'Asia/Shanghai',
    });
  }

  /**
   * 重新调度动态巡检（内容变更后立即生效，无需重启）
   */
  _rescheduleDynamic() {
    this._destroyTask(this.dynamicTask);
    this.dynamicTask = null;
    this.dynamicTask = this._scheduleDynamic();
  }

  /**
   * 执行单个检查项
   */
  async _runCheck(check) {
    try {
      console.log(`[Heartbeat] Check: ${check.name}`);

      if (this.agent && typeof this.agent.decide === 'function') {
        const result = await this.agent.decide(check.prompt, {
          // 每个巡检项独占会话，避免不同巡检项与定时任务共享上下文
          sessionId: toSessionId('hb', check.name),
          appendSystemPrompt: `当前检查项: ${check.name}\n如果发现异常，请在返回的 JSON 中设置 "is_warning": true 并提供 "reply" 说明情况。`,
        });
        console.log(`[Heartbeat] ${check.name} result:`, result);

        // 警告检测
        if (result && (result.is_warning === true || result.alert === true || result.level === 'error' || result.level === 'warning')) {
          const warningMsg = result.reply || result.response || result.content || `检测到异常: ${check.name}`;
          console.warn(`[Heartbeat] ⚠️ Warning in ${check.name}: ${warningMsg}`);
          if (this.onWarning) {
            await this.onWarning(warningMsg, result);
          }
        }
      } else if (this.agent && typeof this.agent.runBackgroundTask === 'function') {
        const result = await this.agent.runBackgroundTask(check.prompt);
        console.log(`[Heartbeat] ${check.name} result:`, result);
      }
    } catch (error) {
      console.error(`[Heartbeat] Check failed (${check.name}):`, error.message);
    }
  }

  /**
   * 手动执行全部检查（兼容原来的 beat()）
   */
  async beat() {
    console.log('[Heartbeat] Beat...');
    for (const check of this.checks) {
      await this._runCheck(check);
    }
    const content = (this.taskContent || '').trim();
    if (content) {
      await this._runCheck({ name: DYNAMIC_CHECK_NAME, prompt: content });
    }
  }

  /**
   * 读取动态巡检指令内容
   * @returns {string}
   */
  getTaskContent() {
    return this.taskContent || '';
  }

  /**
   * 更新动态巡检指令内容并立即重新调度
   *
   * 此前该方法只写入一个无人消费的字段，AI 调用 mgmt_heartbeat_set 后
   * 会收到「已更新心跳任务」但实际巡检内容并未改变，属于对模型的诱导性反馈。
   *
   * @param {string} content - 巡检指令；传空值表示清除动态巡检
   */
  setTaskContent(content) {
    this.taskContent = (content || '').trim();
    this._rescheduleDynamic();

    if (this.taskContent) {
      console.log(`[Heartbeat] Dynamic check updated (${this.taskContent.substring(0, 40)}...)`);
    } else {
      console.log('[Heartbeat] Dynamic check cleared');
    }

    if (this._onDynamicChanged) {
      this._onDynamicChanged(this.taskContent);
    }
  }

  /**
   * 手动触发心跳
   */
  async trigger() {
    console.log('[Heartbeat] Manual trigger');
    await this.beat();
  }

  /**
   * 更新配置并重启
   */
  updateConfig(config) {
    const prevEnabled = this.enabled;
    const prevInterval = this.interval;
    const prevDynamic = this.taskContent;

    const checksChanged = Boolean(config.checks) && config.checks !== this.checks;

    if (config.enabled !== undefined) this.enabled = config.enabled;
    if (config.interval) this.interval = config.interval;
    if (config.checks) this.checks = config.checks;
    // 热更新时同步动态巡检内容（WebUI 会回传该字段）
    if (config.dynamic_prompt !== undefined) this.taskContent = config.dynamic_prompt || '';

    const needRestart =
      checksChanged ||
      prevInterval !== this.interval ||
      prevEnabled !== this.enabled ||
      prevDynamic !== this.taskContent;

    // 此前仅依赖 interval 变化判断重启，导致「先禁用再启用（interval 未变）」
    // 的场景不会重启，心跳会永久停摆。此处额外检查是否尚无运行的任务。
    if (needRestart || this.tasks.length === 0) {
      this.stop();
      this.start();
    }
  }
}

export default Heartbeat;

