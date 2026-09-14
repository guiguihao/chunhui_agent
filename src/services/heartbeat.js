import cron from 'node-cron';

/**
 * 心跳机制
 * 定期执行系统自检和环境优化检查
 * 支持每个检查项单独设置 interval（cron 表达式）
 */
class Heartbeat {
  constructor(agent, config = {}) {
    this.agent = agent;
    this.enabled = config.enabled !== false;
    this.interval = config.interval || '*/5 * * * *'; // 全局默认 interval
    this.checks = config.checks || [];
    this.tasks = [];       // 独立任务列表（替换原来的单一 task）
    this.taskContent = '';
    this.onWarning = null; // 警告回调: (message, result) => {}
  }

  /**
   * 设置警告回调
   */
  setOnWarning(handler) {
    this.onWarning = handler;
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

    console.log(`[Heartbeat] Started (${this.tasks.length} check task(s))`);
  }

  /**
   * 停止心跳
   */
  stop() {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
    console.log('[Heartbeat] Stopped');
  }

  /**
   * 执行单个检查项
   */
  async _runCheck(check) {
    try {
      console.log(`[Heartbeat] Check: ${check.name}`);

      if (this.agent && typeof this.agent.decide === 'function') {
        const result = await this.agent.decide(check.prompt, {
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
  }

  getTaskContent() {
    return this.taskContent;
  }

  setTaskContent(content) {
    this.taskContent = content;
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
    const needRestart = config.interval && config.interval !== this.interval;

    if (config.enabled !== undefined) this.enabled = config.enabled;
    if (config.interval) this.interval = config.interval;
    if (config.checks) this.checks = config.checks;

    if (needRestart || config.checks) {
      this.stop();
      this.start();
    }
  }
}

export default Heartbeat;

