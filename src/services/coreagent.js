/**
 * CoreAgent - ureal 核心 Agent 引擎
 * 基于 guiguihao/ureal/src/core/agent.py 设计
 * 支持工具调用循环、记忆管理、定时任务、心跳巡检
 */
import fs from 'fs/promises';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { getAllTools } from './tools/registry.js';
import {
  handleToolCall, handleMemoryTool, handleFileTool, editFile,
  handleCommandTool, handleManagementTool, handleMCPToolCall, getFilePolicy,
} from './tools/dispatcher.js';
import { trimHistory, normalizeMessages, cleanHistory } from './session/history.js';
import { hasToolCallMarkup, parseToolCallMarkup, stripToolCallMarkup } from './toolmarkup.js';

dotenv.config();

/**
 * 标记「当前是否已在某个 decide 调用内部」
 *
 * 技能执行时会再次调用 agent.decide()（见 skill.js），若入口无条件按 sessionId
 * 加锁，内层调用会等待自己 → 死锁。用 AsyncLocalStorage 识别重入，内层直接执行。
 */
const decideContext = new AsyncLocalStorage();

// ── 会话压缩预算 ──
// 全项目没有 token 估算，这里统一用字符数近似（中文约 1.5 字符/token）。
// 阈值集中在此，别再散落成调用处的魔法数字。
const MAX_HISTORY_CHARS = 30000;        // 历史超过该字符数即触发自动压缩
const MAX_COMPRESS_INPUT_CHARS = 20000; // 单次摘要请求的输入上限（历史可能已远超模型窗口）
// 最近 N 条「对话消息」不参与压缩，压缩只作用于它们之前的内容。
// 计数只算对话消息（user / 有正文的 assistant），工具消息与只带 tool_calls 的
// 空 assistant 属于工具管道，不占额度——它们体积大、复用价值低，若计入额度，
// 几个工具轮就能吃掉 max_context_turns，配置语义直接失真。
// 必须显著小于条数预算 max(max_context_turns*2, 20)，否则会退化成每轮都压缩。
const AUTO_COMPRESS_KEEP = 10;
// 纯条数裁剪的兜底上限系数。对话预算只数对话消息，工具消息会额外占条数，
// 所以裁剪要留余量（体积仍由 MAX_HISTORY_CHARS 与 trimHistory 的字符上限卡住）。
const TRIM_MESSAGE_FACTOR = 4;

/**
 * 是否「承载对话内容」的消息 —— 压缩预算与保留窗口都按它计数
 *
 * 排除：工具结果（role=tool）、只带 tool_calls 没有正文的 assistant、压缩摘要本身。
 * 这样配置里的 max_context_turns 才真的对应「N 轮对话」，而不是被工具消息稀释。
 *
 * @param {object} msg - 单条消息
 * @returns {boolean}
 */
export function isDialogMessage(msg) {
  if (!msg) return false;
  if (msg.compressed) return false;
  if (msg.role === 'tool' || msg.tool_call_id) return false;
  if (msg.role === 'assistant' && !msg.content && (msg.tool_calls?.length || 0) > 0) return false;
  return true;
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant named "{name}". If a tool keeps failing or returns nothing new after two attempts, stop retrying and report the situation to the user instead.`;

/**
 * README 的精简摘要，替代全文注入系统提示。
 *
 * 系统提示中真正需要的是「我能用哪些能力」与「边界在哪」，
 * 而不是 README 的安装教程、目录树与架构图。
 */
const README_SUMMARY = `## 项目
本地运行的智能家居 AI Agent（Node.js ESM），工作目录为 $WORKSPACE$，
所有产出文件请写入该目录。

## 可用能力
- 记忆：用户画像 / 长期知识 / 事实记录 / 当前上下文
- 定时任务：添加、删除、查询、启停（持久化于 config/cron.yaml）
- 心跳巡检：静态巡检项 + 可由你维护的动态巡检指令
- 文件读写：仅限工作目录，禁止触碰凭据与配置
- 命令执行：通过 cmd_exec 调用技能（如 generate_image / weather / browser-use）
- MCP 工具：mcp_ 前缀，按需调用

## 边界
- 不得读取或修改凭据、配置、源码文件
- 严禁虚假汇报：工具返回失败必须如实相告，不得编造结果`;

/**
 * 构造安全的 sessionId
 *
 * sessionId 会直接作为文件名写入 sessions/<id>.json，而 AI 动态创建的
 * 定时任务 ID 可能包含空格、斜杠等字符，必须清洗后再使用，否则会抛 ENOENT。
 *
 * @param {string} prefix - 前缀，用于区分会话来源（cron / hb 等）
 * @param {string} raw - 原始标识（任务 ID、巡检项名称等）
 * @returns {string} 安全的 sessionId
 */
export function toSessionId(prefix, raw) {
  // 注意：这里刻意保留中文等 Unicode 字符。
  // 若照搬工具名的 ASCII 白名单策略，"系统健康"/"安全巡检" 等纯中文巡检项
  // 会被全部清洗成同一个 id，反而让它们重新共用一份会话，失去隔离意义。
  const slug = String(raw ?? '')
    .replace(/[/?<>\\:*|"]/g, '_')   // 文件名非法字符
    .replace(/[\x00-\x1f\x7f]/g, '') // 控制字符
    .replace(/\s+/g, '_')            // 空白 → 下划线
    .replace(/^[._]+/, '')           // 避免产生隐藏文件或 "." / ".."
    .slice(0, 48);
  return slug ? `${prefix}_${slug}` : prefix;
}

class CoreAgent {
  constructor(modelConfig = {}) {
    this.name = modelConfig.name || 'ureal';
    this.systemPrompt = modelConfig.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.maxContextTurns = modelConfig.maxContextTurns || 20;
    this.maxToolIterations = modelConfig.maxToolIterations || 10;
    this.sessionDir = modelConfig.sessionDir || './sessions';
    this.primaryConfigs = modelConfig.primaryConfigs || [];
    if (this.primaryConfigs.length === 0 && modelConfig.model) {
      // backward compatibility
      this.primaryConfigs.push({
        model: modelConfig.model,
        baseUrl: modelConfig.baseUrl,
        apiKey: modelConfig.apiKey,
        thinking: modelConfig.thinking,
        stream: modelConfig.stream
      });
    }
    this.currentPrimaryIndex = 0;

    const initPrimary = this.primaryConfigs[0] || {};
    console.log(`[CoreAgent] Initialized with primary model=${initPrimary.model}, baseUrl=${initPrimary.baseUrl}`);

    this.client = new OpenAI({
      baseURL: initPrimary.baseUrl || modelConfig.baseUrl,
      apiKey: initPrimary.apiKey || modelConfig.apiKey,
      timeout: modelConfig.timeout || 60000,
      defaultHeaders: {
        'User-Agent': 'curl/8.7.1',
      },
    });
    this.model = initPrimary.model || modelConfig.model;
    this.thinking = initPrimary.thinking || modelConfig.thinking || false;
    this.stream = initPrimary.stream || modelConfig.stream || false;
    this.fallbackConfigs = modelConfig.fallbackConfigs || [];
    if (modelConfig.fallback) {
      this.fallbackConfigs.push(modelConfig.fallback);
    }

    if (this.fallbackConfigs.length > 0) {
      console.log(`[CoreAgent] ${this.fallbackConfigs.length} fallback model(s) available.`);
    }

    this._sessions = {};
    // sessionId → Promise 链：同一会话的 decide 串行执行，避免并发写回互相覆盖
    this._sessionQueues = new Map();
    this._memoryService = null;
    this._skillService = null;   // 技能服务
    this._workspace = '';          // 工作目录
    this._scheduler = null;
    this._heartbeat = null;
    this._onCronTaskExecute = null;
    this._mcpTools = [];         // MCP 工具列表（OpenAI function-calling 格式）
    this._mcpToolMap = {};       // toolPrefix → { server, toolName, schema }
    this._mcpService = null;     // MCPorterService 实例
    this._readmeCache = null;    // README.md 内容缓存
    this._onCronTasksChanged = null; // Cron 任务变更回调
    this._fileReadRoots = modelConfig.fileReadRoots || []; // 额外只读根目录（agent.yaml: agent.file_read_roots）
    this._filePolicy = null;     // 延迟构建的文件访问策略
    this.includeFullReadme = modelConfig.includeFullReadme === true; // 是否注入完整 README
    this.maxMemoryContextChars = modelConfig.memoryMaxContextChars ?? null; // 记忆注入上限
  }

  setSkill(skillService) {
    this._skillService = skillService;
  }

  setWorkspace(workspacePath) {
    this._workspace = workspacePath;
  }

  setMemory(memoryService) {
    this._memoryService = memoryService;
  }

  setScheduler(scheduler) {
    this._scheduler = scheduler;
  }

  setHeartbeat(heartbeat) {
    this._heartbeat = heartbeat;
  }

  /**
   * 注入 MCP 工具到 CoreAgent
   * @param {Array} mcpTools - OpenAI function-calling 格式的工具列表
   * @param {object} mcpToolMap - toolPrefix → { server, toolName, schema }
   * @param {object} mcpService - MCPorterService 实例（用于实际调用）
   */
  setMCPTools(mcpTools, mcpToolMap, mcpService) {
    this._mcpTools = mcpTools || [];
    this._mcpToolMap = mcpToolMap || {};
    this._mcpService = mcpService;
  }

  /**
   * 设置 Cron 任务触发时的执行回调
   * @param {Function} handler - 接收 (description, taskConfig) 的异步函数
   */
  setOnCronTaskExecute(handler) {
    this._onCronTaskExecute = handler;
  }

  /**
   * 设置 Cron 任务变动时的回调（用于持久化）
   * @param {Function} handler
   */
  setOnCronTasksChanged(handler) {
    this._onCronTasksChanged = handler;
  }

  /**
   * 热更新模型配置
   */
  reloadModelConfig(newModelConfig = {}) {
    if (newModelConfig.name) this.name = newModelConfig.name;
    if (newModelConfig.systemPrompt) this.systemPrompt = newModelConfig.systemPrompt;
    // 轮数/上下文预算也支持热更新，改配置后不必重启进程
    if (Number(newModelConfig.maxToolIterations) > 0) {
      this.maxToolIterations = Number(newModelConfig.maxToolIterations);
    }
    if (Number(newModelConfig.maxContextTurns) > 0) {
      this.maxContextTurns = Number(newModelConfig.maxContextTurns);
    }
    if (newModelConfig.primaryConfigs && newModelConfig.primaryConfigs.length > 0) {
      this.primaryConfigs = newModelConfig.primaryConfigs;
      this.currentPrimaryIndex = 0;
      const initPrimary = this.primaryConfigs[0] || {};
      this.model = initPrimary.model;
      this.thinking = initPrimary.thinking || false;
      this.stream = initPrimary.stream || false;
      this.client = new OpenAI({
        baseURL: initPrimary.baseUrl,
        apiKey: initPrimary.apiKey,
        timeout: 60000,
        defaultHeaders: {
          'User-Agent': 'curl/8.7.1',
        },
      });
      console.log(`[CoreAgent] Model config reloaded: primary=${this.model}`);
    }
    if (newModelConfig.fallbackConfigs) {
      this.fallbackConfigs = newModelConfig.fallbackConfigs;
    }
    this._readmeCache = null; // 刷新 README 缓存
  }

  async init() {
    await fs.mkdir(this.sessionDir, { recursive: true });
  }

  /**
   * 获取记忆上下文（异步）
   */
  async _loadMemoryContext() {
    if (!this._memoryService) return '';
    try {
      const all = await this._memoryService.getAll({
        maxChars: this.maxMemoryContextChars ?? undefined,
      });
      const profile = all.userProfile || '';
      const knowledge = all.knowledge || '';
      const facts = all.facts || '';
      const context = all.context || '';
      return `用户偏好与画像：${profile || '无'}\n长期知识与经验：${knowledge || '无'}\n事实记录：${facts || '无'}\n当前对话背景与上下文：${context || '无'}`;
    } catch {
      return '';
    }
  }

  async _buildSystemPrompt() {
    if (this._readmeCache === null) {
      try {
        const readmePath = path.resolve(process.cwd(), 'README.md');
        this._readmeCache = await fs.readFile(readmePath, 'utf8');
      } catch (e) {
        console.warn('[CoreAgent] Failed to load README.md for system prompt');
        this._readmeCache = '';
      }
    }

    // README 全文约 4KB，含安装步骤与 ASCII 架构图，对任务执行毫无帮助，
    // 却每轮都被注入提示词（乘以心跳/cron 调用，成本可观），也易与运行时
    // 实际状态冲突造成指令干扰。默认改为注入精简摘要，可通过配置改回全文。
    const readmeContent = this.includeFullReadme ? this._readmeCache : README_SUMMARY;
    const workspace = this._workspace || process.cwd();

    return this.systemPrompt
      .replace(/\{name\}/g, this.name)
      .replace(/{workspace}/g, workspace)
      // 摘要中的工作目录占位符必须在此替换：{workspace} 的替换先于本占位符，
      // 否则会残留字面量
      .replace('{readme.md}', readmeContent.replace(/\$WORKSPACE\$/g, workspace))
      .replace('{time}', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
  }

  /**
   * 获取文件访问策略（延迟构建，详见 tools/dispatcher.js）
   * @returns {object} FileAccessPolicy
   */
  getFilePolicy() {
    return getFilePolicy(this);
  }

  async _getAllTools(filter = null) {
    return getAllTools(this, filter);
  }

  async _handleToolCall(toolName, args = {}) {
    return handleToolCall(this, toolName, args);
  }

  async _handleMemoryTool(toolName, args = {}) {
    return handleMemoryTool(this, toolName, args);
  }

  async _handleFileTool(toolName, args = {}) {
    return handleFileTool(this, toolName, args);
  }

  async _editFile(fs, filePath, args) {
    return editFile(fs, filePath, args);
  }

  async _handleCommandTool(toolName, args = {}) {
    return handleCommandTool(this, toolName, args);
  }

  async _handleManagementTool(toolName, args = {}) {
    return handleManagementTool(this, toolName, args);
  }

  async _handleMCPToolCall(toolPrefix, args = {}) {
    return handleMCPToolCall(this, toolPrefix, args);
  }

  _trimHistory(history, maxLen) {
    return trimHistory(history, maxLen);
  }

  _normalizeMessages(history) {
    return normalizeMessages(history);
  }

  _cleanHistory(history) {
    return cleanHistory(history);
  }

  async _saveSession(sessionId, history) {
    const sessionPath = path.join(this.sessionDir, `${sessionId}.json`);
    try {
      await fs.writeFile(sessionPath, JSON.stringify(history, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[CoreAgent] 保存会话失败: ${e.message}`);
    }
  }

  async _loadSession(sessionId) {
    const sessionPath = path.join(this.sessionDir, `${sessionId}.json`);
    try {
      const data = await fs.readFile(sessionPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  /**
   * 在同一 sessionId 上串行执行一段逻辑
   *
   * 为什么需要：decide() 结束时会把本轮 workingHistory 整体写回
   * `_sessions[sessionId]`。若同一会话有两个并发回合（同一巡检项的重叠 tick、
   * 用户消息与告警写入撞在一起），后写的会覆盖先写的 —— 表现为消息凭空消失。
   *
   * 不同会话之间互不阻塞（cron 任务 / 心跳各占独立会话），所以并发任务本身不受影响。
   */
  async runExclusive(sessionId, fn) {
    // 仅当重入的是「同一个会话」时直通（同会话递归会自锁）；
    // 不同会话的嵌套调用照常排队：否则外层非 default 会话忙时，
    // 技能内层的 default 回合会与真正并发的 default 回合互相覆盖历史
    if (decideContext.getStore()?.sessionId === sessionId) return fn();

    const prev = this._sessionQueues.get(sessionId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const chained = prev.then(() => current);
    this._sessionQueues.set(sessionId, chained);

    await prev.catch(() => { });
    try {
      return await decideContext.run({ sessionId }, fn);
    } finally {
      release();
      if (this._sessionQueues.get(sessionId) === chained) {
        this._sessionQueues.delete(sessionId);
      }
    }
  }

  /**
   * 核心对话方法
   * @param {string} prompt - 用户消息
   * @param {object} options - 可选参数
   * @returns {object} AI 响应
   */
  async decide(prompt, options = {}) {
    const sessionId = options.sessionId || 'default';
    return this.runExclusive(sessionId, () => this._decideInner(prompt, options));
  }

  /**
   * decide 的实际实现（调用方应通过 decide() 进入，以获得会话级串行保护）
   */
  async _decideInner(prompt, options = {}) {
    const sessionId = options.sessionId || 'default';

    // 本轮使用的模型与客户端一律用局部变量（声明在指令拦截之前，
    // /compress 等旁路也要用本轮的 client/model，而不是可能被并发回合改写的实例字段）
    let turnClient = this.client;
    let turnModel = this.model;
    let turnThinking = this.thinking;
    let turnStream = this.stream;

    // 每轮可覆盖工具轮数上限：用户对话给宽预算，定时任务/心跳这类后台执行给紧预算
    const maxIterations = Number(options.maxToolIterations) > 0
      ? Number(options.maxToolIterations)
      : this.maxToolIterations;

    // ── 指令拦截 ──
    const trimmed = prompt.trim();
    if (trimmed === '/new' || trimmed === '/新会话') {
      const result = await this.newSession(sessionId);
      return { ...result, command: 'new' };
    }
    if (trimmed === '/compress' || trimmed === '/压缩') {
      const result = await this.compressSession(sessionId, turnClient, turnModel);
      return { ...result, command: 'compress' };
    }
    if (trimmed === '/context' || trimmed === '/上下文') {
      const result = await this.getSessionContext(sessionId, options);
      return { ...result, command: 'context' };
    }

    // 以前直接写 this.model / this.client，多个回合并发时（cron 任务 + 心跳 + 用户对话）
    // 后开始的回合会覆盖掉先开始回合的 client，导致「A 回合用 B 回合的 baseURL/apiKey/model」
    // 发出请求。实例字段仍然同步更新，供日志与会话摘要等只读场景使用。

    // 轮询选择当前主模型（提前初始化，保证在此轮的任何步骤包括自动压缩都能使用到最新的 client/model）
    if (this.primaryConfigs && this.primaryConfigs.length > 0) {
      const pConfig = this.primaryConfigs[this.currentPrimaryIndex];
      this.currentPrimaryIndex = (this.currentPrimaryIndex + 1) % this.primaryConfigs.length;

      turnModel = pConfig.model;
      turnThinking = pConfig.thinking || false;
      turnStream = pConfig.stream || false;

      turnClient = new OpenAI({
        baseURL: pConfig.baseUrl,
        apiKey: pConfig.apiKey,
        timeout: 60000,
        defaultHeaders: { 'User-Agent': 'curl/8.7.1' },
      });

      this.model = turnModel;
      this.thinking = turnThinking;
      this.stream = turnStream;
      this.client = turnClient;
      console.log(`[CoreAgent] Round-robin selected primary model: ${turnModel}`);
    }

    if (!this._sessions[sessionId]) {
      this._sessions[sessionId] = await this._loadSession(sessionId);
    }

    // 使用副本进行操作，防止执行中途出错导致内存中的会话历史被破坏
    const historyCopy = [...this._sessions[sessionId]];
    historyCopy.push({ role: 'user', content: prompt });

    const maxLen = this.maxContextTurns * 2;

    // 先压缩、后裁剪：压缩是「有损但保留记忆」，裁剪是「纯丢弃」。
    // 顺序反过来时压缩永远看不到超预算的历史（裁剪已先削到 maxLen），
    // 只能退而用一个拍脑袋的 20 条阈值，结果就是工具轮稍多一点的会话每轮都压一次。
    let workingHistory = this._cleanHistory(historyCopy);
    workingHistory = await this._autoCompressHistory(workingHistory, maxLen, turnClient, turnModel);
    // 裁剪是兜底：压缩预算只数对话消息，工具消息会让总条数远超 maxLen，
    // 若仍按 maxLen 裁剪，会把刚刚保住的对话消息连带砍掉（体积另有字符上限约束）
    workingHistory = this._cleanHistory(
      this._trimHistory(workingHistory, maxLen * TRIM_MESSAGE_FACTOR),
    );

    let systemPrompt = await this._buildSystemPrompt();
    let ctx = await this._loadMemoryContext();

    // 动态注入技能提示词 (按需注入)
    if (this._skillService) {
      try {
        const skills = await this._skillService.list();
        for (const skill of skills) {
          // 如果用户输入包含技能名称，或者 options 中指定了目标技能
          if (prompt.includes(skill.name) || (options.targetSkill === skill.name)) {
            const skillPrompt = await this._skillService.getSkillPrompt(skill.name);
            if (skillPrompt) {
              systemPrompt += `\n\n## 技能 [${skill.name}] 规范\n${skillPrompt}`;
              console.log(`[CoreAgent] 动态注入技能提示词: ${skill.name}`);
            }
          }
        }
      } catch (e) {
        console.error(`[CoreAgent] 动态注入技能提示词失败: ${e.message}`);
      }
    }

    if (options.appendSystemPrompt) {
      ctx = ctx ? `${ctx}\n${options.appendSystemPrompt}` : options.appendSystemPrompt;
    }
    if (ctx) {
      systemPrompt += `\n\n## 上下文\n${ctx}`;
    }

    const messages = [{ role: 'system', content: systemPrompt }];

    // 打印会话上下文日志
    console.log(`\n[CoreAgent] === Session Context [${sessionId}] ===`);
    console.log(`[CoreAgent] System Prompt: ${systemPrompt.substring(0, 200)}...`);
    console.log(`[CoreAgent] History Length: ${workingHistory.length} messages`);

    messages.push(...this._normalizeMessages(workingHistory));

    const tools = await this._getAllTools(options.toolFilter);
    let finalResponse = '';

    // 缓存单次决策（决定）循环内的工具调用记录，用于检测和拦截无限重试/死循环
    const executedToolCalls = new Map();

    // 纠偏只做一次：模型反复把调用写成文本时，不应把整个轮数预算耗尽
    let leakRetryUsed = false;

    try {
    for (let i = 0; i < maxIterations; i++) {
      // 最后一轮不再提供工具：否则模型会一直调工具直到轮数耗尽，
      // finalResponse 始终为空 → 用户只看到「无响应」，且不知道是轮数用完了
      const isLastIteration = i === maxIterations - 1;
      if (isLastIteration && tools.length > 0) {
        console.log(`[CoreAgent] 已达最大工具轮数 ${maxIterations}，本轮不再提供工具，强制收敛出结论`);
        // 明确告知工具已不可用：否则模型会退化成把调用写成纯文本标记。
        // 只注入本次请求的 messages（不落盘），避免下一轮会话里残留一条假「用户」指令。
        messages.push({
          role: 'user',
          content: '【系统】本轮工具调用次数已用尽，工具不再可用。请仅基于上文已获得的信息，用自然语言直接给出结论；不要输出任何工具调用格式（如 <｜｜DSML｜｜...>、<tool_call>、invoke/parameter 等）。',
        });
      }

      const requestOptions = {
        model: turnModel,
        messages: messages,
        tools: tools.length > 0 && !isLastIteration ? tools : undefined,
        temperature: 0.7,
        max_tokens: 4096, // 显式设置最大输出，防止某些 API 在输入过长时自动计算产生负值
      };

      // 思考模式：构建 reasoning 参数
      if (turnThinking) {
        requestOptions.temperature = 1; // 思考模式要求 temperature=1
        // OpenAI extended thinking: 通过 reasoning_effort 参数
        if (options.reasoningEffort) {
          requestOptions.reasoning_effort = options.reasoningEffort;
        }
      }

      // 根据是否流式选择不同的调用方式
      const onChunk = options.onChunk || null;
      const onStream = options.onStream || null;
      const isStream = options.stream !== undefined ? options.stream : turnStream;

      if (isStream) {
        requestOptions.stream = true;
      }

      let choice;
      try {
        choice = isStream
          ? await this._handleStreamRequest(requestOptions, onChunk, onStream, turnClient)
          : await this._handleNormalRequest(requestOptions, turnClient);

        // 如果不是流式，手动把完整结果触发一次 onStream
        if (!isStream && onStream) {
          if (choice.reasoning_content) {
            onStream({ type: 'reasoning', content: choice.reasoning_content });
          }
          if (choice.content) {
            onStream({ type: 'content', content: choice.content });
          }
        }
      } catch (error) {
        if (this.fallbackConfigs && this.fallbackConfigs.length > 0) {
          console.warn(`[CoreAgent] Primary model (${turnModel}) failed: ${error.message}. Trying fallbacks.`);

          let success = false;
          let lastError = error;

          for (const fbConfig of this.fallbackConfigs) {
            try {
              console.log(`[CoreAgent] Switching to fallback model: ${fbConfig.model}`);
              // 只切换本轮使用的模型，不污染其他并发回合
              turnModel = fbConfig.model;
              turnThinking = fbConfig.thinking || false;
              turnStream = fbConfig.stream || false;

              turnClient = new OpenAI({
                baseURL: fbConfig.baseUrl,
                apiKey: fbConfig.apiKey,
                timeout: 60000,
                defaultHeaders: {
                  'User-Agent': 'curl/8.7.1',
                },
              });

              this.model = turnModel;
              this.thinking = turnThinking;
              this.stream = turnStream;
              this.client = turnClient;

              requestOptions.model = turnModel;
              requestOptions.temperature = turnThinking ? 1 : 0.7;

              const isFallbackStream = options.stream !== undefined ? options.stream : turnStream;
              requestOptions.stream = isFallbackStream;

              console.log(`[CoreAgent] Retrying with fallback model: ${turnModel}`);
              choice = isFallbackStream
                ? await this._handleStreamRequest(requestOptions, onChunk, onStream, turnClient)
                : await this._handleNormalRequest(requestOptions, turnClient);

              if (!isFallbackStream && onStream) {
                if (choice.reasoning_content) {
                  onStream({ type: 'reasoning', content: choice.reasoning_content });
                }
                if (choice.content) {
                  onStream({ type: 'content', content: choice.content });
                }
              }

              console.log(`[CoreAgent] Fallback to ${turnModel} successful. Keeping fallback model for remaining steps.`);
              success = true;
              break; // Stop trying fallbacks
            } catch (fbError) {
              console.error(`[CoreAgent] Fallback model ${fbConfig.model} failed: ${fbError.message}`);
              lastError = fbError;
            }
          }

          if (!success) {
            throw lastError;
          }
        } else {
          throw error;
        }
      }

      // 部分模型会把工具调用写成纯文本标记（<｜｜DSML｜｜ calls> / <tool_call> / invoke…）。
      // 这类文本不会被执行，却会作为 content 被当成结论播报给用户。
      // 先尝试还原成真正的 tool_calls（恢复功能），还原不了就从可见文本里剔除。
      const rawContent = typeof choice.content === 'string' ? choice.content : '';
      const markupDetected = hasToolCallMarkup(rawContent);
      let leakedOnly = false;

      if (markupDetected && !(choice.tool_calls && choice.tool_calls.length > 0)) {
        // 收敛轮不再补执行工具，否则等于变相绕过工具轮数上限
        const allowedNames = new Set(tools.map(t => t?.function?.name).filter(Boolean));
        const parsedCalls = (!isLastIteration && tools.length > 0)
          ? parseToolCallMarkup(rawContent).filter(c => allowedNames.has(c.function.name))
          : [];

        if (parsedCalls.length > 0) {
          choice.tool_calls = parsedCalls.map((c, idx) => ({ ...c, id: `call_leak_${i}_${idx}` }));
          console.warn(`[CoreAgent] 模型把工具调用写成了文本标记，已还原为真实调用: ${parsedCalls.map(c => c.function.name).join(', ')}`);
        } else {
          leakedOnly = true;
          console.warn(`[CoreAgent] 回复中检测到无法执行的工具调用标记（${rawContent.length} 字符），已从可见文本中剔除`);
        }
      }

      const msgToStore = {
        role: choice.role,
        content: markupDetected ? stripToolCallMarkup(rawContent) : rawContent,
      };

      // 思考模式：保存 reasoning_content
      if (choice.reasoning_content) {
        msgToStore.reasoning_content = choice.reasoning_content;
      }

      if (choice.tool_calls) {
        msgToStore.tool_calls = choice.tool_calls.map(tc => {
          // 过滤掉可能由某些模型输出附加的特殊标记后缀 (如 <|channel|>commentary)
          const cleanName = typeof tc.function.name === 'string' ? tc.function.name.replace(/<\|.*$/, '').trim() : tc.function.name;
          return {
            id: tc.id,
            type: tc.type,
            function: {
              name: cleanName,
              arguments: tc.function.arguments,
            },
          };
        });
      }

      // 空内容且无工具调用的 assistant 消息不写历史：部分兼容实现会直接拒收
      if (msgToStore.content || (msgToStore.tool_calls && msgToStore.tool_calls.length > 0)) {
        workingHistory.push(msgToStore);
        messages.push(msgToStore);
      } else {
        console.warn('[CoreAgent] 模型返回空内容且无工具调用，本条消息未写入历史');
      }

      // 思考模式：输出 reasoning 日志
      if (choice.reasoning_content) {
        console.log(`[CoreAgent] Thinking: ${choice.reasoning_content.substring(0, 200)}...`);
      }

      if (msgToStore.tool_calls && msgToStore.tool_calls.length > 0) {
        for (const tc of msgToStore.tool_calls) {
          // 部分 OpenAI 兼容实现对无参工具会省略 arguments（undefined/null），
          // 此处统一兜底为空串，避免后续字符串操作抛 TypeError 击穿整个 decide()
          const rawArgs = typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : '';

          let args = {};
          try {
            args = rawArgs ? JSON.parse(rawArgs) : {};
          } catch (e) {
            console.warn(`[CoreAgent] 工具参数解析失败: ${tc.function.name}, raw: ${rawArgs}`);
          }

          let displayResult;

          try {
            if (onStream) {
              onStream({
                type: 'tool_start',
                id: tc.id,
                name: tc.function.name,
                arguments: args
              });
            }

            // 规范化参数的空白符，确保比对键稳定性
            const callKey = `${tc.function.name}:${rawArgs.replace(/\s+/g, '')}`;

            if (executedToolCalls.has(callKey)) {
              const prev = executedToolCalls.get(callKey);
              console.warn(`[CoreAgent] ⚠ 检测到在同一次决策循环中重复调用工具: ${tc.function.name}，进行拦截并直接返回先前结果`);
              displayResult = prev.result;
              // 如果上一次调用执行失败了，追加系统指令提示强力引导 LLM 停止无限重试并跳出循环
              if (prev.isError && !displayResult.includes('【系统提示】')) {
                displayResult += `\n\n【系统提示】该工具在此轮对话中已调用过且执行失败。严禁重复调用相同参数的相同工具！请仔细分析先前的错误原因，尝试其他合适的方法/工具，或直接向用户汇报该错误。`;
              }
            } else {
              const result = await this._handleToolCall(tc.function.name, args);
              displayResult = typeof result === 'object' ? JSON.stringify(result) : String(result);

              // 限制工具输出长度，防止撑爆上下文 (约 20,000 字符)
              if (displayResult.length > 20000) {
                console.log(`[CoreAgent] 工具 ${tc.function.name} 输出过长 (${displayResult.length})，已截断`);
                displayResult = displayResult.substring(0, 20000) + "\n\n(内容过长，已截断...)";
              }

              // 判断是否为错误或失败结果（匹配常见错误和 success: false 字样）
              const isError = /error|failed|失败|错误|未登录|not connected|RuntimeError|success":\s*false/i.test(displayResult);
              executedToolCalls.set(callKey, { isError, result: displayResult });
            }
          } catch (toolError) {
            // 单个工具无论如何失败都必须降级为「返回给模型的错误文本」，
            // 绝不能向上冒泡，否则本轮所有已成功执行的工具结果都会丢失。
            console.error(`[CoreAgent] 工具执行异常: ${tc.function.name} - ${toolError.message}`);
            displayResult = `工具执行错误: ${toolError.message}`;
          }

          if (onStream) {
            onStream({
              type: 'tool_end',
              id: tc.id,
              name: tc.function.name,
              result: displayResult
            });
          }

          console.log(`[CoreAgent] 工具: ${tc.function.name} → ${displayResult.substring(0, 80)}`);

          const toolResult = { role: 'tool', tool_call_id: tc.id, content: displayResult };
          workingHistory.push(toolResult);
          messages.push(toolResult);
        }
        continue;
      }

      // 只写标记、没有可执行调用：这不是结论。补一条纠偏提示重试，
      // 逼模型改用标准 tool_calls，而不是把尖括号当成回答。
      if (leakedOnly && !isLastIteration && !leakRetryUsed) {
        leakRetryUsed = true;
        messages.push({
          role: 'user',
          content: '【系统】上一轮你把工具调用写成了普通文本（<｜｜DSML｜｜...>、<tool_call>、invoke/parameter 等），这类文本不会被系统执行。请改用标准的 function calling 返回 tool_calls；如果确实不需要调用工具，就直接用自然语言作答。',
        });
        console.warn('[CoreAgent] 未获得可执行的工具调用，已注入纠偏提示并重试');
        continue;
      }

      finalResponse = msgToStore.content || '';
      break;
    }
    } catch (loopError) {
      // 决策循环异常时仍需落盘：本轮可能已执行过若干工具，
      // 直接丢弃会导致工具副作用与对话状态不一致。
      console.error(`[CoreAgent] 决策循环异常: ${loopError.message}`);
      try {
        this._sessions[sessionId] = workingHistory;
        await this._saveSession(sessionId, workingHistory);
        console.log(`[CoreAgent] 异常已保存会话快照: ${sessionId}`);
      } catch (saveError) {
        console.error(`[CoreAgent] 异常状态下保存会话失败: ${saveError.message}`);
      }
      throw loopError;
    }

    // 循环耗尽（工具轮数用尽）或模型返回空内容时 finalResponse 会是空串，
    // 以前直接 parseOutput('') 返回「无响应」，用户完全看不出发生了什么。
    // 这里合成一条可读结论，并把最近工具输出带上，便于判断卡在哪一步。
    if (!finalResponse) {
      const recentTools = workingHistory.filter(m => m.role === 'tool').slice(-3);
      finalResponse = recentTools.length > 0
        ? `⚠️ 已达最大工具调用轮数（${maxIterations}），未能生成最终结论。\n\n最近几次工具输出：\n\n${recentTools.map(m => `- ${String(m.content || '').slice(0, 300)}`).join('\n')}`
        : '⚠️ 模型没有返回任何内容，请重试，或检查模型/API 配置。';
      console.warn(`[CoreAgent] 决策循环未收敛，已生成兜底回复（工具轮数上限 ${maxIterations}）`);
    }

    // 执行成功，更新内存会话状态并保存
    this._sessions[sessionId] = workingHistory;
    await this._saveSession(sessionId, workingHistory);

    return this.parseOutput(finalResponse);
  }

  /**
   * 普通请求（非流式）
   * @param {object} requestOptions - API 请求参数
   * @returns {object} 解析后的 choice 数据 { role, content, tool_calls, reasoning_content }
   */
  async _handleNormalRequest(requestOptions, client = this.client) {
    const response = await client.chat.completions.create(requestOptions);
    const message = response.choices[0].message;
    return {
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls || null,
      reasoning_content: message.reasoning_content || null,
    };
  }

  /**
   * 流式请求 — 逐 chunk 拼接 content / tool_calls / reasoning_content
   * @param {object} requestOptions - API 请求参数
   * @param {Function} [onChunk] - 可选回调，每收到一个 content chunk 就调用 onChunk(text)
   * @param {Function} [onStream] - 可选流式事件回调
   * @returns {object} 解析后的 choice 数据 { role, content, tool_calls, reasoning_content }
   */
  async _handleStreamRequest(requestOptions, onChunk, onStream, client = this.client) {
    const stream = await client.chat.completions.create(requestOptions);

    let content = '';
    let reasoningContent = '';
    let role = 'assistant';
    const toolCallAccumulators = {}; // { index: { id, name, arguments } }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.role) role = delta.role;
      if (delta.content) {
        content += delta.content;
        if (onStream) {
          onStream({ type: 'content', content: delta.content });
        }
      }
      if (delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        if (onStream) {
          onStream({ type: 'reasoning', content: delta.reasoning_content });
        }
      }

      // 流式 tool_calls 拼接
      if (delta.tool_calls) {
        for (const tcDelta of delta.tool_calls) {
          const idx = tcDelta.index;
          if (!toolCallAccumulators[idx]) {
            toolCallAccumulators[idx] = {
              id: tcDelta.id || '',
              type: tcDelta.type || 'function',
              function: { name: '', arguments: '' },
            };
          }
          if (tcDelta.id) toolCallAccumulators[idx].id = tcDelta.id;
          if (tcDelta.function?.name) toolCallAccumulators[idx].function.name += tcDelta.function.name;
          if (tcDelta.function?.arguments) toolCallAccumulators[idx].function.arguments += tcDelta.function.arguments;
        }
      }

      // 回调通知 + 终端输出
      if (delta.content) {
        if (onChunk) onChunk(delta.content);
        process.stdout.write(delta.content);
      }
    }

    // 流式输出完成后换行
    if (content) process.stdout.write('\n');

    const tool_calls = Object.keys(toolCallAccumulators).length > 0
      ? Object.values(toolCallAccumulators)
      : null;

    return {
      role,
      content,
      tool_calls,
      reasoning_content: reasoningContent || null,
    };
  }

  /**
   * 持续对话
   * @param {string} sessionId - 会话 ID
   * @param {string} prompt - 后续消息
   * @returns {object} AI 响应
   */
  async continue(sessionId, prompt) {
    return this.decide(prompt, { sessionId });
  }

  /**
   * 解析输出 — 能 JSON.parse 就解析，否则直接当文本返回
   * @param {string} output - 原始输出
   * @returns {object} 解析后对象
   */
  parseOutput(output) {
    if (!output) return { response: '无响应' };

    try {
      const parsed = JSON.parse(output);
      // JSON 形态也过滤一遍：标记可能藏在 response 字符串里
      if (parsed && typeof parsed.response === 'string') {
        parsed.response = stripToolCallMarkup(parsed.response);
      }
      return parsed;
    } catch {
      return { response: stripToolCallMarkup(output) };
    }
  }

  /**
   * 清除会话历史
   * @param {string} sessionId - 会话 ID
   */
  async clearHistory(sessionId = 'default') {
    if (this._sessions[sessionId]) {
      this._sessions[sessionId] = [];
    }
    const sessionPath = path.join(this.sessionDir, `${sessionId}.json`);
    await fs.unlink(sessionPath).catch(() => { });
  }

  /**
   * 开启新会话 — 备份当前会话，清空历史，保持当前 sessionId
   * @param {string} sessionId - 当前会话 ID
   * @returns {object} { sessionId, response }
   */
  async newSession(sessionId = 'default') {
    // 1. 加载并备份
    if (!this._sessions[sessionId]) {
      this._sessions[sessionId] = await this._loadSession(sessionId);
    }
    const history = this._sessions[sessionId];

    if (history && history.length > 0) {
      const timestamp = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
      }).replace(/[\/ :]/g, '-');

      const backupPath = path.join(this.sessionDir, `${sessionId}_backup_${timestamp}.json`);
      try {
        await fs.writeFile(backupPath, JSON.stringify(history, null, 2), 'utf-8');
        console.log(`[CoreAgent] Session backed up to: ${backupPath}`);
      } catch (e) {
        console.error(`[CoreAgent] 备份会话失败: ${e.message}`);
      }
    }

    // 2. 清空
    this._sessions[sessionId] = [];
    await this._saveSession(sessionId, []);

    console.log(`[CoreAgent] Session cleared: ${sessionId}`);
    return {
      sessionId: sessionId,
      response: '🆕 会话已重置，原历史已备份。',
    };
  }

  /**
   * 自动会话压缩（有损保留）
   *
   * 三条铁律：
   * 1. 触发预算只统计「上次摘要之后」的新增消息。摘要本身已承载更早的内容，
   *    若把摘要也算进总量，摘要一旦存在就永久超阈值 → 每轮都重新摘要一次
   *    （白花一次 LLM 调用，且上下文被反复重写，模型表现反而更差）。
   * 2. 条数预算只数对话消息（见 isDialogMessage），工具消息不占额度；
   *    否则几个工具轮就吃掉 max_context_turns，「保留最近 N 轮」名不副实。
   * 3. 压缩后只留 [摘要 + 最近 AUTO_COMPRESS_KEEP 条对话]，总量立刻回落到预算以下，
   *    不会连轮触发；最近这 N 条不参与摘要，逐字保留（含其工具消息）以保证连贯。
   *
   * 条数预算取 max_context_turns * 2（配置语义就是「保留最近 N 轮」），
   * 字符预算用 MAX_HISTORY_CHARS 兜住「少而长」的会话——工具输出体积由它负责。
   *
   * @param {Array} history - 已清洗的历史（含本轮 user 输入）
   * @param {number} maxLen - 条数预算
   * @param {object} [client] - 本轮 OpenAI 客户端
   * @param {string} [model] - 本轮模型名
   * @returns {Promise<Array>} 压缩后的历史；未触发或失败时返回可用的历史
   */
  async _autoCompressHistory(history, maxLen, client = this.client, model = this.model) {
    const summaryIdx = history.findIndex(m => m.compressed);
    const freshStart = summaryIdx >= 0 ? summaryIdx + 1 : 0;
    const fresh = history.slice(freshStart);
    // 条数预算只数对话消息，工具管道消息不占额度；体积由字符预算兜住
    const freshDialog = fresh.filter(isDialogMessage);
    const freshChars = fresh.reduce((sum, m) => sum + (m.content?.length || 0), 0);

    const countBudget = Math.max(20, maxLen);

    if (freshDialog.length <= countBudget && freshChars <= MAX_HISTORY_CHARS) {
      return history;
    }

    // 保留窗口同样按对话条数计：工具消息随其所属回合一起保留，
    // 否则工具密集的会话压缩后只剩两三个真实回合
    let keepFrom = history.length;
    let keptDialog = 0;
    while (keepFrom > freshStart && keptDialog < AUTO_COMPRESS_KEEP) {
      keepFrom--;
      if (isDialogMessage(history[keepFrom])) keptDialog++;
    }
    // 历史很短但单条极大时（如 2 条各 3 万字），至少留出可压缩的部分；
    // 最后一条是本轮用户输入，必须原样保留
    if (keepFrom === 0 && history.length > 1) {
      keepFrom = history.length - 1;
    }
    // 按回合边界切：切点落在 tool 结果上时回退到其 assistant(tool_calls)，
    // 否则残缺序列会被 _normalizeMessages 整段丢弃，"保留的最新消息"直接消失
    while (keepFrom > freshStart && history[keepFrom].role === 'tool') {
      keepFrom--;
    }

    const olderMessages = history.slice(0, keepFrom);
    const latestMessages = history.slice(keepFrom);
    // 旧内容只剩上次的摘要时，再摘要一遍没有增益，还会退化成每轮都压
    if (olderMessages.length === 0 || olderMessages.every(m => m.compressed)) {
      return history;
    }

    console.log(`[CoreAgent] 自动压缩触发：新增 ${freshDialog.length} 条对话（共 ${fresh.length} 条消息）/ ${freshChars} 字符（预算 ${countBudget} 条对话 / ${MAX_HISTORY_CHARS} 字符），压缩 ${olderMessages.length} 条旧消息，保留最新 ${latestMessages.length} 条...`);

    try {
      const summary = await this._summarizeMessages(olderMessages, client, model);

      // 用 user 角色承载摘要（多条 system 在部分兼容实现里只取第一条），
      // 并打上 compressed 标记：下一轮据此把「旧摘要 + 新内容」合并更新，
      // 而不是把摘要再摘要一遍（细节逐轮衰减）
      const prevSummary = olderMessages.find(m => m.compressed)?.content;
      const summaryMsg = {
        role: 'user',
        content: prevSummary
          ? `[对话摘要·更新] ${summary}\n（已合并此前摘要）`
          : `[对话摘要] ${summary}`,
        compressed: true,
      };

      console.log(`[CoreAgent] 自动压缩完成：${olderMessages.length} 条旧消息 → 摘要，保留最新 ${latestMessages.length} 条，workingHistory.length = ${latestMessages.length + 1}`);
      return [summaryMsg, ...latestMessages];
    } catch (compressErr) {
      console.error(`[CoreAgent] 自动压缩失败: ${compressErr.message}，退化为硬截断`);
      // 压缩失败的主因就是历史过长，原样继续会让主请求同样超窗失败；
      // 这里退化保留最近一半（至少 6 条），并用一条占位说明补齐语义
      const keepRecent = Math.max(6, Math.floor(history.length / 2));
      const cut = Math.max(0, history.length - keepRecent);
      return [
        {
          role: 'user',
          content: `[系统] 早期 ${cut} 条消息因上下文超限已省略，压缩摘要生成失败。`,
        },
        ...history.slice(cut),
      ];
    }
  }

  /**
   * 把历史消息格式化成摘要用的纯文本
   * @param {Array} messages - 历史消息
   * @returns {string}
   */
  _formatHistoryForSummary(messages) {
    return messages.map(msg => {
      const roleLabel = msg.role === 'user' ? '用户' :
        msg.role === 'assistant' ? 'AI' :
          msg.role === 'tool' ? '工具结果' :
            msg.role === 'system' ? '系统' : msg.role;
      let text = `[${roleLabel}]: ${msg.content || ''}`;
      if (msg.tool_calls) {
        text += ` (调用了工具: ${msg.tool_calls.map(tc => tc.function?.name).join(', ')})`;
      }
      return text;
    }).join('\n');
  }

  /**
   * 调 LLM 把一段历史压成摘要（自动压缩与手动 /compress 共用）
   *
   * 输入先按 MAX_COMPRESS_INPUT_CHARS 截断：历史本身可能已远超模型窗口，
   * 全量塞进摘要请求会让压缩在最需要它的时候先失败（400 context_length_exceeded）。
   *
   * @param {Array} messages - 待摘要的消息
   * @param {object} [client] - 本轮 OpenAI 客户端（不传则用实例字段）
   * @param {string} [model] - 本轮模型名
   * @returns {Promise<string>} 摘要文本
   */
  async _summarizeMessages(messages, client = this.client, model = this.model) {
    const historyText = this._formatHistoryForSummary(messages);
    const compressInput = historyText.length > MAX_COMPRESS_INPUT_CHARS
      ? `…（更早内容已省略）…\n${historyText.slice(-MAX_COMPRESS_INPUT_CHARS)}`
      : historyText;

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: '你是一个对话摘要助手，擅长提炼关键信息。' },
        { role: 'user', content: `请将以下对话历史压缩为一段简洁的摘要，保留关键信息、决策和结果，去除冗余细节。用中文输出，不超过200字。\n\n${compressInput}` },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });

    return response.choices[0].message.content || '（历史摘要生成失败）';
  }

  /**
   * 压缩会话 — 用 LLM 将历史对话总结为摘要，替换原历史
   * @param {string} sessionId - 会话 ID
   * @param {object} [client] - 本轮使用的 OpenAI 客户端（不传则用实例字段）
   * @param {string} [model] - 本轮使用的模型名
   * @returns {object} { response }
   */
  async compressSession(sessionId = 'default', client = this.client, model = this.model) {
    if (!this._sessions[sessionId]) {
      this._sessions[sessionId] = await this._loadSession(sessionId);
    }

    const history = this._sessions[sessionId];
    if (history.length <= 2) {
      return { response: '📝 会话很短，无需压缩。' };
    }

    try {
      const summary = await this._summarizeMessages(history, client, model);

      // 用摘要替换原历史；user 角色 + compressed 标记，与自动压缩保持一致，
      // 便于下一轮自动压缩识别「已有摘要」并合并而不是重复摘要
      this._sessions[sessionId] = [
        { role: 'user', content: `[对话摘要] ${summary}`, compressed: true },
      ];
      await this._saveSession(sessionId, this._sessions[sessionId]);

      console.log(`[CoreAgent] Session compressed: ${sessionId}, ${history.length} msgs → summary`);
      return {
        response: `📝 会话已压缩：${history.length} 条消息 → 摘要\n\n${summary}`,
      };
    } catch (error) {
      console.error(`[CoreAgent] Compress failed: ${error.message}`);
      return { response: `❌ 压缩失败: ${error.message}` };
    }
  }

  /**
   * 获取会话上下文摘要
   * @param {string} sessionId - 会话 ID
   * @param {object} options - 参数
   * @returns {object} { response }
   */
  async getSessionContext(sessionId = 'default', options = {}) {
    if (!this._sessions[sessionId]) {
      this._sessions[sessionId] = await this._loadSession(sessionId);
    }
    const history = this._sessions[sessionId];

    const systemPrompt = await this._buildSystemPrompt();
    const memoryCtx = await this._loadMemoryContext();

    let fullSystem = systemPrompt;
    if (options.appendSystemPrompt) {
      fullSystem += `\n\n## 插件上下文\n${options.appendSystemPrompt}`;
    }
    if (memoryCtx) {
      fullSystem += `\n\n## 记忆上下文\n${memoryCtx}`;
    }

    const historySummary = history.length > 0
      ? history.map((msg, i) => `${i + 1}. [${msg.role}]: ${msg.content ? msg.content.substring(0, 50) + (msg.content.length > 50 ? '...' : '') : '(工具调用)'}`).join('\n')
      : '无历史记录';

    const response = `🔍 **会话上下文 [${sessionId}]**\n\n` +
      `**系统提示词摘要:**\n${systemPrompt.substring(0, 100)}...\n\n` +
      `**记忆上下文:**\n${memoryCtx || '无'}\n\n` +
      `**历史消息 (${history.length} 条):**\n${historySummary}`;

    return { response };
  }
}

export default CoreAgent;