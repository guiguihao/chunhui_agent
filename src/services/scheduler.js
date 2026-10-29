import cron from 'node-cron';

/**
 * Cron 定时任务调度
 * 根据 config/cron.yaml 配置执行定时任务
 */
class Scheduler {
  constructor() {
    this.tasks = new Map();
  }

  /**
   * 注册定时任务
   * @param {string} id - 任务 ID
   * @param {string} cronExpression - Cron 表达式
   * @param {Function} handler - 执行函数
   * @param {object} options - 可选参数
   *   - autoStart: 是否立即启动，默认 true
   *   - enabled: 期望启用状态，默认同 autoStart（决定 startAll() 是否恢复它）
   */
  register(id, cronExpression, handler, options = {}) {
    if (this.tasks.has(id)) {
      console.warn(`[Scheduler] Task ${id} already exists, replacing...`);
      this.unregister(id);
    }

    const scheduled = options.autoStart !== false;
    // 期望启用状态：优先取显式 enabled，否则与是否立即调度保持一致
    const enabled = options.enabled !== undefined ? options.enabled !== false : scheduled;

    const task = cron.schedule(cronExpression, async () => {
      console.log(`[Scheduler] Executing: ${id} (${options.name || 'unnamed'})`);
      try {
        await handler();
      } catch (error) {
        console.error(`[Scheduler] Error in task ${id}:`, error.message);
      }
    }, {
      scheduled,
      timezone: options.timezone || 'Asia/Shanghai',
    });

    this.tasks.set(id, { task, handler, options, cronExpression, running: scheduled, enabled });
    console.log(`[Scheduler] Registered: ${id} - "${cronExpression}" (${scheduled ? 'enabled' : 'disabled'})`);
  }

  /**
   * 批量注册任务
   *
   * 注意：禁用（enabled: false）的任务同样会被注册，只是不启动调度。
   * 这样 listTasks() / saveCronTasks() 才能完整反映 cron.yaml 的内容，
   * 否则被禁用的任务会在下次持久化时被静默丢弃（历史 bug）。
   *
   * @param {Array} tasksConfig - 任务配置数组
   * @param {Function} executor - 执行函数 (接收 prompt 参数)
   */
  registerTasks(tasksConfig, executor) {
    for (const taskConfig of tasksConfig) {
      const enabled = taskConfig.enabled !== false;

      if (!enabled) {
        console.log(`[Scheduler] Registering disabled task (not scheduled): ${taskConfig.id}`);
      }

      this.register(
        taskConfig.id,
        taskConfig.cron,
        async () => {
          console.log(`[Scheduler] Trigger: ${taskConfig.name}`);
          await executor(taskConfig.prompt, taskConfig);
        },
        {
          name: taskConfig.name,
          prompt: taskConfig.prompt,
          autoStart: enabled,
          enabled,
        }
      );
    }
  }

  /**
   * 注销任务
   * @param {string} id - 任务 ID
   */
  unregister(id) {
    const taskData = this.tasks.get(id);
    if (taskData) {
      taskData.task.stop();
      this.tasks.delete(id);
      console.log(`[Scheduler] Unregistered: ${id}`);
    }
  }

  /**
   * 启用指定任务（恢复调度）
   * @param {string} id - 任务 ID
   * @returns {boolean} 是否成功
   */
  enable(id) {
    const taskData = this.tasks.get(id);
    if (!taskData) {
      console.warn(`[Scheduler] Task ${id} not found, cannot enable`);
      return false;
    }
    taskData.task.start();
    taskData.running = true;
    taskData.enabled = true;
    console.log(`[Scheduler] Enabled: ${id}`);
    return true;
  }

  /**
   * 禁用指定任务（暂停调度，保留注册）
   * @param {string} id - 任务 ID
   * @returns {boolean} 是否成功
   */
  disable(id) {
    const taskData = this.tasks.get(id);
    if (!taskData) {
      console.warn(`[Scheduler] Task ${id} not found, cannot disable`);
      return false;
    }
    taskData.task.stop();
    taskData.running = false;
    taskData.enabled = false;
    console.log(`[Scheduler] Disabled: ${id}`);
    return true;
  }

  /**
   * 启动所有任务
   * 仅恢复期望为启用（enabled）状态的任务，禁用任务保持停止。
   */
  startAll() {
    let started = 0;
    for (const [id, taskData] of this.tasks) {
      if (taskData.enabled === false) continue;
      taskData.task.start();
      taskData.running = true;
      started++;
    }
    console.log(`[Scheduler] Started ${started} task(s), skipped ${this.tasks.size - started} disabled`);
  }

  /**
   * 停止所有任务
   */
  stopAll() {
    for (const [id, taskData] of this.tasks) {
      taskData.task.stop();
      taskData.running = false;
    }
    console.log('[Scheduler] Stopped all tasks');
  }

  /**
   * 获取所有已注册的任务
   * @returns {Array} 任务列表
   */
  listTasks() {
    return Array.from(this.tasks.entries()).map(([id, data]) => ({
      id,
      name: data.options.name || id,
      cron: data.cronExpression,
      // enabled = 期望状态（持久化依据），running = 实际调度状态
      enabled: data.enabled !== false,
      running: Boolean(data.running),
      prompt: data.options.prompt || '',
    }));
  }
}

export default Scheduler;