import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';
import dotenv from 'dotenv';
import CoreAgent from './services/coreagent.js';
import Scheduler from './services/scheduler.js';
import Heartbeat from './services/heartbeat.js';
import MemoryService from './services/memory.js';
import MessengerBridge from './services/messenger.js';
import SkillService from './services/skill.js';
import FeishuService from '../plugin/feishu.js';
import MCPorterService from '../plugin/mcporter.js';
import WebUIService from '../plugin/webui.js';


// 加载环境变量
dotenv.config();

/**
 * ureal Agent 主入口
 * 智能家居 AI Agent
 */
class SmartHomeAgent {
  constructor() {
    this.config = null;
    this.agent = null;
    this.scheduler = null;
    this.heartbeat = null;
    this.memory = null;
    this.messenger = null; // 消息桥接器
    this.skill = null;     // 技能服务
    this.feishu = null;
    this.webui = null;
  }

  /**
   * 初始化 Agent
   */
  async init() {
    console.log('[Agent] Initializing ureal...');

    // 1. 加载配置
    await this.loadConfig();

    // 2. 初始化记忆服务
    this.memory = new MemoryService(this.config.memory);
    await this.memory.init();

    // 3. 初始化 CoreAgent
    const modelConfig = this._buildModelConfig();
    this.agent = new CoreAgent(modelConfig);
    this.agent.setMemory(this.memory);
    await this.agent.init();

    // 设置工作目录
    const workspaceDir = path.resolve(process.cwd(), this.config.agent?.workspace || './workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    this.agent.setWorkspace(workspaceDir);
    console.log(`[Agent] Workspace: ${workspaceDir}`);

    // 4. 初始化技能服务
    console.log('[Agent] Initializing SkillService...');
    this.skill = new SkillService(this.config.agent?.skills);
    await this.skill.init();
    const loadedSkills = await this.skill.list();
    console.log(`[Agent] SkillService initialized. ${loadedSkills.length} skill(s) loaded: ${loadedSkills.map(s => s.name).join(', ')}`);
    this.agent.setSkill(this.skill);

    // 4. 初始化调度器
    this.scheduler = new Scheduler();
    this.agent.setScheduler(this.scheduler);

    // 5. 初始化心跳
    this.heartbeat = new Heartbeat(this.agent, this.config.heartbeat);
    this.agent.setHeartbeat(this.heartbeat);

    // 设置 Cron 任务执行回调
    this.agent.setOnCronTaskExecute(async (prompt, taskConfig) => {
      console.log(`[Agent] Cron triggered: ${taskConfig.name}`);
      const res = await this.thinkAndAct(prompt);
      console.log(`Cron triggered: ${taskConfig.name}, result: ${JSON.stringify(res)}`);
      const reply = res?.reply || res?.response;
      if (reply && reply.trim() && this.messenger) {
        await this.messenger.broadcast(`⏰ **定时任务执行: ${taskConfig.name}**\n\n${reply}`);
      }
    });

    // 设置 Cron 任务变动持久化回调
    this.agent.setOnCronTasksChanged(async () => {
      await this.saveCronTasks();
    });

    // 6. 初始化消息桥接器
    this.messenger = new MessengerBridge();

    // 7. 初始化飞书服务
    if (this.config.plugins?.feishu?.enabled) {
      this.feishu = new FeishuService(this.config.plugins.feishu, this.agent);
      this.messenger.register('feishu', this.feishu);
    }

    // 关联心跳警报到消息广播
    if (this.heartbeat) {
      this.heartbeat.setOnWarning(async (message, result) => {
        console.log(`[Agent] Heartbeat warning: ${message}`);
        await this.messenger.broadcast(`⚠️ **系统巡检告警**\n\n${message}`);
      });
    }

    // 7. 初始化 MCPorter 服务
    if (this.config.plugins?.mcporter?.enabled) {
      this.mcporter = new MCPorterService(this.config.plugins.mcporter, this.agent);
    }

    // 8. 初始化 WebUI 服务
    if (this.config.plugins?.webui?.enabled) {
      this.webui = new WebUIService(this.config.plugins.webui, this);
    }

    console.log('[Agent] Initialized');
  }

  /**
   * 启动 Agent
   */
  async start() {
    console.log('[Agent] Starting ureal...');

    // 1. 注册 Cron 任务
    await this.registerCronTasks();

    // 2. 启动心跳
    this.heartbeat.start();

    // 3. 启动调度器
    this.scheduler.startAll();

    // 4. 启动飞书服务
    if (this.feishu) {
      await this.feishu.start();
    }

    // 5. 启动 MCPorter 服务
    if (this.mcporter) {
      await this.mcporter.start();
    }

    // 6. 启动 WebUI 服务
    if (this.webui) {
      await this.webui.start();
    }

    console.log('[Agent] ureal is running...');
    console.log('[Agent] Press Ctrl+C to stop');
  }

  /**
   * 停止 Agent
   */
  async stop() {
    console.log('[Agent] Stopping ureal...');

    this.heartbeat.stop();
    this.scheduler.stopAll();

    // 停止飞书服务
    if (this.feishu) {
      await this.feishu.stop();
    }

    // 停止 MCPorter 服务
    if (this.mcporter) {
      await this.mcporter.stop();
    }

    // 停止 WebUI 服务
    if (this.webui) {
      await this.webui.stop();
    }

    console.log('[Agent] Stopped');
  }

  /**
   * 加载配置文件
   */
  async loadConfig() {
    try {
      const configDir = path.join(process.cwd(), 'config');

      // 并行加载所有配置文件
      const [agentConfig, heartbeatConfig, cronConfig, pluginConfig] = await Promise.all([
        this.loadYaml(path.join(configDir, 'agent.yaml')),
        this.loadYaml(path.join(configDir, 'heartbeat.yaml')),
        this.loadYaml(path.join(configDir, 'cron.yaml')),
        this.loadYaml(path.join(configDir, 'plugin.yaml')),
      ]);

      // 以 agent.yaml 为基础，合并其他配置
      this.config = {
        ...(agentConfig || {}),
        heartbeat: heartbeatConfig?.heartbeat || {},
        cron: cronConfig?.cron || {},
        plugins: pluginConfig?.plugins || {},
      };

      console.log('[Agent] Config loaded (merged)');

      // 如果 Agent 已经初始化，热更新运行时模型配置
      if (this.agent && typeof this.agent.reloadModelConfig === 'function') {
        const modelConfig = this._buildModelConfig();
        this.agent.reloadModelConfig(modelConfig);
      }
    } catch (error) {
      console.error('[Agent] Config load error:', error.message);
      throw error;
    }
  }

  /**
   * 从配置中构建模型配置
   * 支持 default 为数组，实现主模型与多个备用模型。
   */
  _buildModelConfig() {
    const models = this.config.models || {};
    let defaultVals = models.default;
    let fallbackVals = models.fallback;

    // 归一化为数组
    if (!defaultVals) {
      defaultVals = ['gpt-4o'];
    } else if (!Array.isArray(defaultVals)) {
      defaultVals = [defaultVals];
    }

    if (fallbackVals && !Array.isArray(fallbackVals)) {
      fallbackVals = [fallbackVals];
    } else if (!fallbackVals) {
      fallbackVals = [];
    }

    const providers = models.providers || [];

    // 解析模型配置的内部助手
    const resolveModel = (modelStr) => {
      if (!modelStr) return null;
      let targetProvider = null;
      let targetModel = modelStr;
      if (modelStr.includes('/')) {
        targetProvider = modelStr.slice(0, modelStr.indexOf('/'));
        targetModel = modelStr.slice(modelStr.indexOf('/') + 1);
      }

      let matched = null;
      let matchedModelConfig = null;

      for (const provider of providers) {
        if (targetProvider) {
          if (provider.name === targetProvider) {
            matched = provider;
            break;
          }
        } else {
          if (provider.models && provider.models.some(m => (typeof m === 'string' ? m : m.id) === targetModel)) {
            matched = provider;
            break;
          }
        }
      }

      if (matched && matched.models) {
        for (const m of matched.models) {
          if (typeof m === 'string' && m === targetModel) {
            matchedModelConfig = { id: m, thinking: false, stream: false };
            break;
          } else if (typeof m === 'object' && m.id === targetModel) {
            matchedModelConfig = m;
            break;
          }
        }
      }

      if (!matchedModelConfig && matched?.models?.length > 0) {
        const first = matched.models[0];
        matchedModelConfig = typeof first === 'object' ? first : { id: first, thinking: false, stream: false };
        targetModel = matchedModelConfig.id;
      }

      if (!matched || !matchedModelConfig) return null;

      const apiKeyEnv = matched.api_key_env || 'OPENAI_API_KEY';
      const apiKey = process.env[apiKeyEnv] || '';

      return {
        model: matchedModelConfig.id,
        baseUrl: matched.base_url,
        apiKey: apiKey,
        thinking: matchedModelConfig.thinking || false,
        stream: matchedModelConfig.stream || false,
        providerName: matched.name
      };
    };

    const resolvedPrimaryConfigs = [];
    for (const val of defaultVals) {
      const cfg = resolveModel(val);
      if (cfg) resolvedPrimaryConfigs.push(cfg);
    }

    // 兜底配置
    if (resolvedPrimaryConfigs.length === 0) {
      resolvedPrimaryConfigs.push({
        model: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY || '',
        thinking: false,
        stream: false,
        providerName: 'openai'
      });
    }

    const resolvedFallbackConfigs = [];
    for (const val of fallbackVals) {
      const cfg = resolveModel(val);
      if (cfg) resolvedFallbackConfigs.push(cfg);
    }

    console.log(`[Agent] Primary models (round-robin): ${resolvedPrimaryConfigs.map(p => p.model).join(', ')}`);
    if (resolvedFallbackConfigs.length > 0) {
      console.log(`[Agent] Fallback models configured: ${resolvedFallbackConfigs.map(f => f.model).join(', ')}`);
    }

    const systemPrompt = this.config.agent?.system_prompt;

    return {
      name: this.config.agent?.name || 'ureal',
      primaryConfigs: resolvedPrimaryConfigs,
      fallbackConfigs: resolvedFallbackConfigs,
      systemPrompt: systemPrompt
    };
  }

  /**
   * 注册定时任务
   */
  async registerCronTasks() {
    const tasks = this.config.cron.tasks || [];

    this.scheduler.registerTasks(tasks, async (prompt, taskConfig) => {
      console.log(`[Agent] Static Cron triggered: ${taskConfig.name}`);
      const result = await this.thinkAndAct(prompt);
      const reply = result?.reply || result?.response;

      if (reply && reply.trim()) {
        console.log(`[Agent] Broadcasting static cron reply to Feishu (target: ${this.feishu?.notificationChatId || 'None'})`);
        await this.messenger.broadcast(`⏰ **定时任务执行: ${taskConfig.name}**\n\n${reply}`);
      } else {
        console.log(`[Agent] Static Cron for ${taskConfig.name} produced no reply.`);
      }
    });
  }

  /**
   * AI 思考并执行
   * @param {string} prompt - 问题/指令
   * @param {object} options - 可选参数
   * @returns {object} 决策结果
   */
  async thinkAndAct(prompt, options = {}) {
    try {
      console.log(`[Agent] Thinking: ${prompt}`);

      if (!this.agent) {
        throw new Error('Agent not initialized');
      }

      const decision = await this.agent.decide(prompt, options);
      console.log('[Agent] Decision:', decision);

      return decision;
    } catch (error) {
      console.error('[Agent] ThinkAndAct error:', error.message);
      throw error;
    }
  }

  /**
   * 将当前所有定时任务持久化保存到 config/cron.yaml
   */
  async saveCronTasks() {
    if (!this.scheduler) return;
    try {
      const tasks = this.scheduler.listTasks();
      const cronPath = path.join(process.cwd(), 'config', 'cron.yaml');
      const yamlContent = yaml.stringify({
        cron: {
          tasks: tasks.map(t => ({
            id: t.id,
            name: t.name,
            cron: t.cron,
            enabled: t.enabled !== false,
            prompt: t.prompt || '',
          })),
        },
      });
      await fs.writeFile(cronPath, yamlContent, 'utf8');
      console.log(`[Agent] 💾 Saved ${tasks.length} cron task(s) to config/cron.yaml`);
    } catch (e) {
      console.error('[Agent] Failed to save cron.yaml:', e.message);
    }
  }

  /**
   * 加载 YAML 文件
   * @param {string} filePath - 文件路径
   * @returns {object} 配置对象
   */
  async loadYaml(filePath) {
    try {
      let content = await fs.readFile(filePath, 'utf-8');

      // 替换环境变量 ${VAR} 或 $VAR
      content = content.replace(/\$\{(\w+)\}/g, (match, key) => {
        return process.env[key] || match;
      }).replace(/\$(\w+)/g, (match, key) => {
        return process.env[key] || match;
      });

      return yaml.parse(content) || {};
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.warn(`[Agent] Config file not found: ${filePath}`);
        return {};
      }
      throw error;
    }
  }
}

// 启动入口
const agent = new SmartHomeAgent();

// 优雅退出处理
process.on('SIGINT', async () => {
  await agent.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await agent.stop();
  process.exit(0);
});

// 启动
agent.init()
  .then(() => agent.start())
  .catch((error) => {
    console.error('[Agent] Failed to start:', error.message);
    process.exit(1);
  });

export default SmartHomeAgent;
