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
   */
  register(id, cronExpression, handler, options = {}) {
    if (this.tasks.has(id)) {
      console.warn(`[Scheduler] Task ${id} already exists, replacing...`);
      this.unregister(id);
    }

    const scheduled = options.autoStart !== false;

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

    this.tasks.set(id, { task, handler, options, cronExpression, running: scheduled });
    console.log(`[Scheduler] Registered: ${id} - "${cronExpression}"`);
  }

  /**
   * 批量注册任务
   * @param {Array} tasksConfig - 任务配置数组
   * @param {Function} executor - 执行函数 (接收 prompt 参数)
   */
  registerTasks(tasksConfig, executor) {
    for (const taskConfig of tasksConfig) {
      if (!taskConfig.enabled) {
        console.log(`[Scheduler] Skipping disabled task: ${taskConfig.id}`);
        continue;
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
          autoStart: true,
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
    console.log(`[Scheduler] Disabled: ${id}`);
    return true;
  }

  /**
   * 启动所有任务
   */
  startAll() {
    for (const [id, taskData] of this.tasks) {
      taskData.task.start();
      taskData.running = true;
    }
    console.log(`[Scheduler] Started all tasks (${this.tasks.size})`);
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
      name: data.options.name,
      cron: data.cronExpression,
      running: data.running,
    }));
  }
}

export default Scheduler;