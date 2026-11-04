import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml, { isCollection } from 'yaml';
import dotenv from 'dotenv';
import CoreAgent, { toSessionId } from './services/coreagent.js';
import Scheduler, { mergeConfiguredTasks } from './services/scheduler.js';
import Heartbeat from './services/heartbeat.js';
import HolidayService from './services/holiday.js';
import MemoryService from './services/memory.js';
import MessengerBridge from './services/messenger.js';
import SkillService from './services/skill.js';
import FeishuService from '../plugin/feishu.js';
import MCPorterService from '../plugin/mcporter.js';
import WebUIService from '../plugin/webui.js';
import WeixinService from '../plugin/weixin.js';


// 加载环境变量
dotenv.config();

/**
 * 保证 YAML 文档有可写的根 map
 *
 * 两个坑都踩过：
 *   1. 空文件 / 纯注释文件的 `document.contents` 是 null，直接 setIn 会抛
 *      "Expected a YAML collection as document contents"；
 *   2. 用普通 JS 对象（`doc.setIn(['a','b'], {})`）占位会生成 constructor 为 Object
 *      的非集合节点，后续 setIn 子路径抛 "Expected YAML collection at b"。
 * 正确做法是用 doc.createNode({}) 建真正的 YAMLMap。
 *
 * @param {import('yaml').Document} doc
 * @returns {import('yaml').Document}
 */
function ensureYamlRoot(doc) {
  if (!doc.contents || !isCollection(doc.contents)) {
    doc.contents = doc.createNode({});
  }
  return doc;
}

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
    this.weixin = null;     // 微信渠道（weixin-agent-sdk 长轮询）
    // cron.yaml 写入队列：多个回合同时增删任务时串行化，避免快照覆盖丢变更
    this._cronSaveQueue = null;
  }

  /**
   * 初始化 Agent
   */
  async init() {
    console.log('[Agent] Initializing ureal...');

    // 0. 记录启动时 .env 中的键集合，作为 reloadEnv 的删除基线
    //    否则 WebUI 中删掉的变量在热重载后仍会残留在 process.env 里
    try {
      const envPath = path.join(process.cwd(), '.env');
      this._envKeys = new Set(Object.keys(dotenv.parse(await fs.readFile(envPath, 'utf8'))));
    } catch {
      this._envKeys = new Set();
    }

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

    // 工具改动了「启动时才固化」的配置（目前是 MCP Server）后，会在本轮回复送达后
    // 请求软重启：restart() 会重建 MCP 连接，等价于在 WebUI 点"重启"——
    // 但绝不能在工具调用中途同步执行，否则当前这轮回复连同 SSE/飞书连接一起断。
    this.agent.setOnRestartRequested(async (reason) => {
      console.log(`[Agent] ♻️  Restart requested by tool: ${reason}`);
      const r = await this.restart();
      if (!r?.success && !r?.skipped) {
        console.error('[Agent] 工具触发的重启失败:', r?.error);
      }
    });

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

    // AI 通过 mgmt_skill_toggle 维护的禁用名单持久化到 agent.yaml 的 agent.skills.disabled。
    // 禁用状态由 dispatcher 直接改 SkillService（立即生效），这里只负责落盘。
    this.agent.setOnSkillsChanged(async (names) => {
      await this.saveSkillsDisabled(names);
    });

    // AI 通过 env_set / env_delete 改 .env 后立刻热加载，避免「文件已改、进程仍用旧值」
    this.agent.setOnEnvChanged(async () => this.reloadEnv());

    // 4. 初始化调度器
    this.scheduler = new Scheduler({
      timezone: this.config.agent?.timezone || 'Asia/Shanghai',
    });
    this.agent.setScheduler(this.scheduler);

    // 4.1 节假日日历：周末/法定假日规则靠它在触发时按日期判断
    this.holidayService = new HolidayService({
      timezone: this.config.agent?.timezone || 'Asia/Shanghai',
    });
    await this.holidayService.init();
    this.scheduler.holidayService = this.holidayService;

    // 5. 初始化心跳
    this.heartbeat = new Heartbeat(this.agent, this.config.heartbeat);
    this.heartbeat.setHolidayService(this.holidayService);
    // 后台任务（巡检）给紧预算：巡检要的是结论，不是无限次工具试探
    this.heartbeat.setMaxToolIterations(this._backgroundToolIterations());
    this.agent.setHeartbeat(this.heartbeat);

    // 动态巡检内容变动时持久化到 config/heartbeat.yaml
    this.heartbeat.setOnDynamicChanged(async () => {
      await this.saveHeartbeatConfig();
    });
    // 结构化更新（mgmt_heartbeat_update）改的是 enabled/interval/checks，
    // 同样需要落盘，否则重启后配置回滚
    this.heartbeat.setOnConfigChanged(async () => {
      await this.saveHeartbeatConfig();
    });

    // 设置 Cron 任务执行回调
    this.agent.setOnCronTaskExecute(async (prompt, taskConfig) => {
      console.log(`[Agent] Cron triggered: ${taskConfig.name}`);
      const res = await this.thinkAndAct(prompt, {
        // 每个定时任务独占会话，避免不同任务上下文互相污染
        sessionId: toSessionId('cron', taskConfig.id),
        // 后台任务给紧预算，避免卡在工具循环里反复试探
        maxToolIterations: this._backgroundToolIterations(),
      });
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

    // 7.1 初始化微信渠道
    // 常驻实例（即使尚未扫码登录）：WebUI 的渠道管理要能随时发起登录，
    // 登录成功后由插件自己拉起长轮询，无需重启进程。
    if (this.config.plugins?.weixin?.enabled !== false && this.config.plugins?.weixin) {
      this.weixin = new WeixinService(this.config.plugins.weixin, this);
      this.messenger.register('weixin', this.weixin);
    }

    // 关联心跳警报到消息广播
    if (this.heartbeat) {
      this.heartbeat.setOnWarning(async (message, result, meta = {}) => {
        console.log(`[Agent] Heartbeat warning: ${message}`);
        const title = meta.check ? `⚠️ **系统巡检告警 · ${meta.check}**` : '⚠️ **系统巡检告警**';
        // 只发结论会让前端丢掉核查过程；正文存在时合并，且避免与结论重复
        const summary = String(message || '').trim();
        const detail = String(meta.detail || '').trim();
        let body = summary;
        if (detail) {
          body = summary && !detail.includes(summary) ? `${summary}\n\n${detail}` : detail;
        }
        await this.messenger.broadcast(`${title}\n\n${body}`);
      });
    }

    // 7. 初始化 MCPorter 服务
    if (this.config.plugins?.mcporter?.enabled) {
      this.mcporter = new MCPorterService(this.config.plugins.mcporter, this.agent);
      // 注：mgmt_mcp_list/toggle/remove 由 dispatcher 直接读写 config/mcporter.json
      // （与 WebUI /api/mcp 同一事实来源），不需要经这里落盘。
    }

    // 8. 初始化 WebUI 服务
    if (this.config.plugins?.webui?.enabled) {
      this.webui = new WebUIService(this.config.plugins.webui, this);
      // 注册为消息渠道：心跳告警 / 定时任务结果的 messenger.broadcast()
      // 会同时推送到 WebUI 当前会话（SSE 实时 + 写入会话历史）
      this.messenger.register('webui', this.webui);
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

    // 4.1 启动微信渠道（仅在已扫码登录时真正拉起长轮询）
    if (this.weixin) {
      await this.weixin.start();
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

    // 停止微信渠道（abort 长轮询）
    if (this.weixin) {
      await this.weixin.stop();
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
   * 软重启：停止全部服务后重新走一遍 init() + start()
   *
   * 相比 `process.exit()` 依赖外部守护进程拉起，软重启有以下好处：
   *   1. 不改变 PID，在 `npm start` / 前台运行时也能生效
   *   2. 不会残留孤儿进程
   *   3. 飞书/MCP 等「启动时固化」的凭证会随实例重建而重新读取
   *
   * 注意：本进程内所有长连接（WebUI SSE、飞书 WS、MCP 子进程）都会被中断。
   *
   * @returns {Promise<{success: boolean, durationMs?: number, error?: string, skipped?: boolean}>}
   */
  async restart() {
    if (this._restarting) {
      return { success: false, skipped: true, error: '已在重启中' };
    }
    this._restarting = true;
    const startedAt = Date.now();

    try {
      console.log('[Agent] ♻️  Restart requested, stopping all services...');
      await this.stop();

      // 丢弃旧实例引用，确保 init() 全量重建
      this.agent = null;
      this.memory = null;
      this.skill = null;
      this.scheduler = null;
      this.heartbeat = null;
      this.messenger = null;
      this.feishu = null;
      this.mcporter = null;
      this.webui = null;
      this.weixin = null;

      await this.init();

      try {
        await this.start();
      } catch (startError) {
        // 端口可能尚未从旧进程释放，重试一次再判定失败
        console.warn(`[Agent] Restart start failed (${startError.message}), retrying in 1s...`);
        await new Promise(r => setTimeout(r, 1000));
        await this.start();
      }

      const durationMs = Date.now() - startedAt;
      console.log(`[Agent] ♻️  Restart completed in ${durationMs}ms`);
      return { success: true, durationMs };
    } catch (error) {
      console.error('[Agent] ♻️  Restart failed:', error.message);
      return { success: false, error: error.message };
    } finally {
      this._restarting = false;
    }
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
   * 后台任务（定时任务 / 心跳巡检）可用的工具轮数预算
   *
   * 比用户对话更紧：后台任务要的是「结论 + 告警」，卡在工具循环里毫无意义，
   * 而且每轮都是一次完整的 LLM 调用，长时间循环会持续烧 token。
   */
  _backgroundToolIterations() {
    const v = Number(this.config.agent?.background_tool_iterations);
    return Number.isFinite(v) && v > 0 ? v : 5;
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
        // 仅用于启动校验的报错文案（「缺哪个环境变量」比 SDK 的 Missing credentials 有用得多）
        apiKeyEnv,
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
        apiKeyEnv: 'OPENAI_API_KEY',
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
      systemPrompt: systemPrompt,
      // 上下文与工具轮数预算（此前只有代码里的硬编码默认值，配置写了也不生效）
      maxContextTurns: this.config.agent?.max_context_turns,
      maxToolIterations: this.config.agent?.max_tool_iterations,
      // 额外的文件只读根目录（除 workspace 外），用于让 Agent 读取指定数据目录
      fileReadRoots: this.config.agent?.file_read_roots || [],
      // 是否将完整 README 注入系统提示（默认 false，改用精简摘要以降低 token 消耗）
      includeFullReadme: this.config.agent?.prompt?.include_readme === true,
      // 记忆注入长度上限（按文件计），用于控制提示词体积
      memoryMaxContextChars: this.config.memory?.max_context_chars ?? null,
    };
  }

  /**
   * 注册定时任务
   */
  async registerCronTasks() {
    const tasks = this.config.cron.tasks || [];

    this.scheduler.registerTasks(tasks, async (prompt, taskConfig) => {
      console.log(`[Agent] Static Cron triggered: ${taskConfig.name}`);
      const result = await this.thinkAndAct(prompt, {
        sessionId: toSessionId('cron', taskConfig.id),
        // 后台任务给紧预算，避免卡在工具循环里反复试探
        maxToolIterations: this._backgroundToolIterations(),
      });
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
    // 串行化写入：两个回合同时增删任务时各自基于 listTasks() 快照全量重写，
    // 不加锁的话后写会丢掉先写的变更
    this._cronSaveQueue = (this._cronSaveQueue || Promise.resolve())
      .then(async () => {
        // 表达式非法而注册失败的任务不在 scheduler 快照里，直接重写会把它
        // 从 cron.yaml 中永久抹掉；按 id 补齐，保证保存只增不减
        const tasks = mergeConfiguredTasks(
          this.scheduler.listTasks(),
          this.config?.cron?.tasks
        );
        const cronPath = path.join(process.cwd(), 'config', 'cron.yaml');
        const yamlContent = yaml.stringify({
          cron: {
            tasks: tasks.map(t => ({
              id: t.id,
              name: t.name,
              cron: t.cron,
              enabled: t.enabled !== false,
              prompt: t.prompt || '',
              // yaml.stringify 会自动省略 undefined，默认（skip）不会写进文件
              overlap: t.overlap,
              // 日期规则：any 是默认值，不必写进 yaml，保持文件干净
              weekend: t.weekend && t.weekend !== 'any' ? t.weekend : undefined,
              holiday: t.holiday && t.holiday !== 'any' ? t.holiday : undefined,
            })),
          },
        });
        await fs.writeFile(cronPath, yamlContent, 'utf8');
        console.log(`[Agent] 💾 Saved ${tasks.length} cron task(s) to config/cron.yaml`);
      })
      .catch(e => console.error('[Agent] Failed to save cron.yaml:', e.message));
    await this._cronSaveQueue;
  }

  /**
   * 将心跳运行时配置持久化到 config/heartbeat.yaml
   *
   * 注意：heartbeat.yaml 内含大量注释掉的示例巡检项，因此不能用
   * yaml.parse + yaml.stringify 全量重写（会丢注释）。这里用 parseDocument
   * 保留原有注释与顺序，并且只回写真正变化的字段：
   * 未变化的部分连节点都不替换，注释自然也不会被冲掉。
   */
  async saveHeartbeatConfig() {
    if (!this.heartbeat) return;
    try {
      const hbPath = path.join(process.cwd(), 'config', 'heartbeat.yaml');
      const raw = await fs.readFile(hbPath, 'utf8');

      const doc = ensureYamlRoot(yaml.parseDocument(raw));
      // 不能先用 {} 占位：setIn 传入普通 JS 对象会生成非集合节点，
      // 后续 setIn(['heartbeat', ...]) 会抛 "Expected YAML collection"。
      // 缺键时直接 setIn 子路径，yaml 会按需创建中间 map。
      if (!doc.has('heartbeat') || !isCollection(doc.get('heartbeat', true))) {
        doc.delete('heartbeat');
      }

      const desired = {
        enabled: this.heartbeat.enabled !== false,
        interval: this.heartbeat.interval || '',
        dynamic_prompt: this.heartbeat.getTaskContent() || '',
        checks: this.heartbeat.checks || [],
      };

      let dirty = false;
      for (const [key, value] of Object.entries(desired)) {
        const current = doc.getIn(['heartbeat', key]);
        if (JSON.stringify(current === undefined ? null : current) === JSON.stringify(value)) continue;
        doc.setIn(['heartbeat', key], value);
        dirty = true;
      }

      if (!dirty) return;

      await fs.writeFile(hbPath, doc.toString(), 'utf8');
      console.log('[Agent] 💾 Saved heartbeat config to config/heartbeat.yaml');
    } catch (e) {
      console.error('[Agent] Failed to save heartbeat.yaml:', e.message);
    }
  }

  /**
   * 持久化技能禁用名单到 config/agent.yaml 的 agent.skills.disabled
   *
   * agent.yaml 含长文本 system_prompt，必须用 parseDocument 保留块样式与注释；
   * 实测 round-trip 后 system_prompt 逐字一致。
   *
   * 注意：WebUI 的 /api/config 用 patchScalar 按行文本替换改同一个文件，
   * 两者并发会互相覆盖；这里只在值真的变化时才写，把冲突面缩到最小。
   *
   * @param {string[]} names - 被禁用的技能名
   */
  async saveSkillsDisabled(names) {
    const p = path.join(process.cwd(), 'config', 'agent.yaml');
    const raw = await fs.readFile(p, 'utf8');
    const doc = ensureYamlRoot(yaml.parseDocument(raw));

    // 不能先用 {} 占位：setIn 传入普通 JS 对象会生成非集合节点（constructor 为 Object），
    // 后续 setIn(['agent','skills','disabled']) 会抛
    // "Expected YAML collection at skills"。缺键时直接写子路径即可，yaml 会按需建 map。
    const skillsNode = doc.getIn(['agent', 'skills'], true);
    if (skillsNode !== undefined && !isCollection(skillsNode)) {
      // 显式写了 `skills:`（null）或误写成标量时，先删掉再重建
      doc.deleteIn(['agent', 'skills']);
    }

    const current = doc.getIn(['agent', 'skills', 'disabled']);
    if (JSON.stringify(current === undefined ? [] : current) === JSON.stringify(names)) return;

    doc.setIn(['agent', 'skills', 'disabled'], names);
    await fs.writeFile(p, doc.toString(), 'utf8');
    console.log(`[Agent] 💾 Saved skills.disabled (${names.length} 项) to config/agent.yaml`);
  }

  /**
   * 重载 cron 定时任务（重新读取 cron.yaml 并重建调度器）
   */
  async reloadCron() {
    await this.loadConfig();

    // 取消已注册任务，避免重复注册
    for (const t of this.scheduler.listTasks()) {
      this.scheduler.unregister(t.id);
    }

    await this.registerCronTasks();
    this.scheduler.startAll();
    console.log(`[Agent] 🔄 Cron reloaded: ${this.scheduler.listTasks().length} task(s)`);
  }

  /**
   * 重载心跳配置
   */
  async reloadHeartbeat() {
    await this.loadConfig();
    this.heartbeat.updateConfig(this.config.heartbeat || {});
    console.log('[Agent] 🔄 Heartbeat reloaded');
  }

  /**
   * 重载 .env 环境变量
   *
   * 注意：飞书等插件的凭证在服务启动时已固化为 SDK 客户端实例，
   * 这部分改动需要重启进程才能生效。
   *
   * 语义为「以文件为准」：文件中被删除的变量会同步从 process.env 移除，
   * 否则界面上删掉的配置在进程内仍然生效，属于静默的不一致。
   *
   * @returns {Promise<{updated: string[], removed: string[]}>} 变更明细
   */
  async reloadEnv() {
    try {
      const envPath = path.join(process.cwd(), '.env');
      const parsed = dotenv.parse(await fs.readFile(envPath, 'utf8'));

      // 首次调用时若还没有基线（例如启动阶段未成功读取），
      // 以当前 process.env 为准不做删除，避免误删外部注入的变量
      const previousKeys = this._envKeys instanceof Set ? this._envKeys : null;

      const updated = [];
      const removed = [];

      if (previousKeys) {
        for (const key of previousKeys) {
          if (!(key in parsed)) {
            delete process.env[key];
            removed.push(key);
          }
        }
      }

      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] !== v) updated.push(k);
        process.env[k] = v;
      }

      // 记录本次文件中的键集合，作为下次比对的基线
      this._envKeys = new Set(Object.keys(parsed));

      // 模型配置中的 apiKey 来自环境变量，需一并刷新
      if (this.agent) {
        this.agent.reloadModelConfig(this._buildModelConfig());
      }

      console.log(`[Agent] 🔄 Reloaded ${Object.keys(parsed).length} env var(s)`
        + (removed.length ? `, removed ${removed.length}: ${removed.join(', ')}` : ''));

      return { updated, removed };
    } catch (e) {
      console.error('[Agent] Failed to reload .env:', e.message);
      throw e;
    }
  }

  /**
   * 统一的配置重载入口
   *
   * 各子系统能力不同，无法热重载的子系统会明确返回 requiresRestart，
   * 让调用方（WebUI）如实告知用户，而不是假装已生效。
   *
   * @param {string} name - model | cron | heartbeat | mcp | env
   * @returns {object} { reloadable: boolean, requiresRestart: string[], message?: string }
   */
  async reloadSubsystem(name) {
    switch (name) {
      case 'model':
        await this.loadConfig();
        return { reloadable: true, requiresRestart: [] };

      case 'cron':
        await this.reloadCron();
        return { reloadable: true, requiresRestart: [] };

      case 'heartbeat':
        await this.reloadHeartbeat();
        return { reloadable: true, requiresRestart: [] };

      case 'holiday':
        await this.holidayService?.reload();
        return { reloadable: true, requiresRestart: [] };

      case 'env': {
        const { updated, removed } = await this.reloadEnv();
        // 飞书凭证、微信状态目录（OPENCLAW_STATE_DIR）都在服务启动时固化
        return { reloadable: true, requiresRestart: ['feishu', 'weixin'], updated, removed };
      }

      case 'mcp':
        // MCP runtime 涉及子进程与远程连接，本期不做热重载
        return {
          reloadable: false,
          requiresRestart: ['mcporter'],
          message: 'MCP Server 配置需重启进程后生效',
        };

      default:
        return {
          reloadable: false,
          requiresRestart: [name],
          message: `未知的重载子系统: ${name}`,
        };
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

/**
 * 仅在作为入口文件直接运行时才启动
 *
 * 此前本文件「导入即自启动」，导致任何 `import './src/agent.js'`
 * （包括测试与被其他工具引用）都会真的拉起整个 Agent ——
 * 会连接 MCP/飞书，并可能触发配置回写。加上守卫后该副作用消失，
 * 同时让 SmartHomeAgent 可被单元测试。
 */
const isEntryPoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
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
}

export default SmartHomeAgent;
