import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';
import os from 'os';
import { log } from 'console';
import { isInside } from '../src/services/pathguard.js';

/** 把工具参数（可能是 JSON 字符串）格式化成便于阅读的文本 */
function formatToolArgs(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  try {
    return JSON.stringify(typeof raw === 'string' ? JSON.parse(raw) : raw, null, 2);
  } catch {
    return String(raw);
  }
}

/** 工具结果兜底转字符串（历史里通常是字符串，但防御性处理） */
function formatToolResult(content) {
  if (typeof content === 'string') return content;
  try { return JSON.stringify(content ?? '', null, 2); } catch { return String(content); }
}

/**
 * 把磁盘上的会话历史（OpenAI messages）整理成前端可直接渲染的列表
 *
 * 一次工具调用会在历史里留下两条消息：assistant(tool_calls) + role=tool。
 * 过去是把 role=tool 硬转成 system 气泡、内容退化成「[工具返回结果]」之类的
 * 占位文本，于是刷新后会话页满屏都是
 *   [执行工具: mgmt_heartbeat_get, tasktodolist]
 *   未知管理工具: [object Object]
 * 这类裸文本，而流式输出时它们本来是折叠的工具卡片 —— 同一段会话两种样子。
 *
 * 这里把同一轮的工具调用与对应结果重新组装成 { tools: [...] }，
 * 结构与 SSE 的 tool_start / tool_end 对齐，前端复用同一套卡片渲染。
 */
export function buildDisplayHistory(history = []) {
  const items = [];
  let openGroup = null; // 当前等待填充结果的工具组

  for (const msg of history) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      openGroup = {
        role: 'assistant',
        content: msg.content || '',
        tools: msg.tool_calls.map(tc => ({
          id: tc.id || `${tc.function?.name || 'tool'}-${items.length}`,
          name: tc.function?.name || 'unknown',
          args: formatToolArgs(tc.function?.arguments),
          status: 'done',
          result: '',
        })),
      };
      items.push(openGroup);
      continue;
    }

    if (msg.role === 'tool') {
      const target = openGroup?.tools.find(t => t.id === msg.tool_call_id);
      if (target) {
        target.result = formatToolResult(msg.content);
      } else {
        // 历史被裁剪后可能只剩孤立的结果，单独兜底展示
        items.push({ role: 'system', content: `[工具返回结果] ${formatToolResult(msg.content)}` });
      }
      continue;
    }

    // 非工具消息打断分组，避免后续孤立结果错挂到上一组
    openGroup = null;

    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content.trim()) continue;
    items.push({ role: msg.role === 'system' ? 'system' : msg.role, content });
  }

  const now = Date.now();
  return items.map((item, index) => ({ id: now + index, ...item }));
}

/**
 * 将 .env 变量的值格式化为安全字面量
 *
 * 读取侧（GET /api/env）会剥掉值的引号，因此保存时必须按需补回：
 * 若值包含空格、#、引号或反斜杠却不加引号，dotenv 会把 `#` 之后当成注释，
 * 造成值被静默截断（例如 `NOTE=abc #123` 最终只剩 `abc`）。
 *
 * @param {string} value - 原始值
 * @returns {string} 可直接写入 .env 的字面量
 */
function formatEnvValue(value) {
  const v = value ?? '';
  if (v === '') return '';
  if (!/[\s#'"`]/.test(v)) return v;

  // dotenv 只剥离最外层引号，并不处理反斜杠转义，
  // 因此绝不能自行加反斜杠（否则 C:\path 会变成 C:\\path）。
  // 正确做法是挑一个值里不存在的引号来包裹。
  if (!v.includes('"')) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;

  // 同时含单双引号：.env 格式无法无歧义表达，只能尽力而为并告警
  console.warn('[WebUI] .env 值同时包含单双引号，可能无法原样还原:', v);
  return `"${v}"`;
}

/**
 * 解析 .env 中 `KEY=` 后面的原始字面量，还原为真实值
 *
 * 必须与 formatEnvValue 严格对称：只剥引号而不反转义，
 * 会让含转义引号/反斜杠的值在界面上显示成一堆多余反斜杠，
 * 保存后进一步叠加转义。
 *
 * @param {string} raw - `=` 之后的部分
 * @returns {string} 还原后的值
 */
function parseEnvValue(raw) {
  const v = (raw ?? '').trim();
  if (v.length >= 2) {
    const quoted = (v.startsWith('"') && v.endsWith('"'))
      || (v.startsWith("'") && v.endsWith("'"));
    if (quoted) return v.slice(1, -1);
  }
  return v;
}

/**
 * 修改 agent.yaml 中 models.default 的取值
 *
 * 需要兼容两种等价写法（此前只支持列表写法，导致标量写法下保存被静默忽略）：
 *   models:
 *     default: "deepseek/deepseek-v4-flash"   # 标量
 *     default:                                 # 列表（多模型轮询）
 *       - "deepseek/deepseek-v4-flash"
 *
 * @param {string} text - 原始 YAML 文本
 * @param {string} model - 新的模型标识
 * @returns {string|null} 修改后的文本；未定位到 models.default 时返回 null
 */
function patchDefaultModel(text, model) {
  // 列表写法：default: 换行后跟 "- xxx"，只替换首项（UI 为单选）
  const listRe = /^([ \t]*default:[ \t]*\n[ \t]*-[ \t]*)([^\n]*)$/m;
  if (listRe.test(text)) return text.replace(listRe, `$1"${model}"`);

  // 标量写法：要求同一行确实有值，避免误吃空值行（如 default: 后面直接换行）
  const scalarRe = /^([ \t]*default:[ \t]+)([^\n#]*\S)([ \t]*(?:#.*)?)$/m;
  if (scalarRe.test(text)) return text.replace(scalarRe, `$1"${model}"$3`);

  return null;
}

class WebUIService {
  constructor(config, agentInstance) {
    this.config = config || {};
    this.port = this.config.port || 8080;
    this.agentInstance = agentInstance;
    this.app = express();

    // GET /api/events 的长连接（心跳告警等异步通知的实时推送通道）
    this._sseClients = new Set();
    // 最近一次交互的 WebUI 会话：异步通知要落到「当前会话」而不是某个固定 id
    this._activeSessionId = null;
    this._eventSeq = 0;

    this.app.use(cors());
    this.app.use(express.json());

    this.setupRoutes();
  }

  /**
   * 记录当前活跃的 WebUI 会话（异步通知的投递目标）
   */
  touchSession(sessionId) {
    if (sessionId) this._activeSessionId = sessionId;
  }

  /**
   * 解析异步通知要投递的会话
   *
   * `_activeSessionId` 只存在于内存中，`node --watch` 每次改后端代码都会重启进程、
   * 清空它；而浏览器页面不会因为服务端重启就重新拉一次历史。
   * 这时若直接放弃，告警既推不进会话也不会落盘。兜底扫描 sessions/ 目录，
   * 取最近修改的 webui_*.json（备份文件除外）作为当前会话。
   */
  async resolveSessionId() {
    if (this._activeSessionId) return this._activeSessionId;

    const coreAgent = this.agentInstance?.agent;
    const dir = coreAgent?.sessionDir;
    if (!dir) return null;

    try {
      const files = await fs.readdir(dir);
      let newest = null;
      let newestAt = 0;
      for (const file of files) {
        if (!file.startsWith('webui_') || !file.endsWith('.json') || file.includes('_backup_')) continue;
        const stat = await fs.stat(path.join(dir, file));
        if (stat.mtimeMs > newestAt) {
          newestAt = stat.mtimeMs;
          newest = file;
        }
      }
      if (newest) {
        this._activeSessionId = newest.replace(/\.json$/, '');
        console.log(`[WebUI] Resolved active session from disk: ${this._activeSessionId}`);
      }
      return this._activeSessionId;
    } catch (e) {
      console.warn('[WebUI] Failed to resolve active session:', e.message);
      return null;
    }
  }

  /**
   * 把一条系统消息写入会话历史
   *
   * 只走 SSE 是不够的：用户刷新页面后事件流已经过去，告警就消失了。
   * 所以同时落进 coreAgent 的会话历史，刷新后仍能在会话里看到。
   */
  async appendSystemMessage(text, sessionId) {
    const coreAgent = this.agentInstance?.agent;
    if (!coreAgent) return null;

    const targetSession = sessionId || await this.resolveSessionId();
    if (!targetSession) return null;

    const write = async () => {
      if (!coreAgent._sessions) coreAgent._sessions = {};
      if (!coreAgent._sessions[targetSession]) {
        coreAgent._sessions[targetSession] = await coreAgent._loadSession(targetSession);
      }

      const history = coreAgent._sessions[targetSession] || [];
      history.push({ role: 'system', content: text });
      coreAgent._sessions[targetSession] = history;

      if (typeof coreAgent._saveSession === 'function') {
        await coreAgent._saveSession(targetSession, history);
      }
      return targetSession;
    };

    // 与该会话的 decide 串行：否则正在进行的回合结束时会把整套 workingHistory
    // 写回 _sessions[sessionId]，刚追加的告警被静默覆盖
    return typeof coreAgent.runExclusive === 'function'
      ? coreAgent.runExclusive(targetSession, write)
      : write();
  }

  /**
   * 向所有已连接的浏览器推送事件（SSE）
   */
  pushEvent(payload) {
    const data = `data: ${JSON.stringify({ id: ++this._eventSeq, ts: Date.now(), ...payload })}\n\n`;
    for (const client of this._sseClients) {
      try {
        client.write(data);
      } catch (e) {
        this._sseClients.delete(client);
      }
    }
  }

  /**
   * MessengerBridge 渠道接口
   *
   * 注册到 messenger 后，心跳告警等 messenger.broadcast() 的广播
   * 会同时进入 WebUI 当前会话（实时推送 + 写入历史）。
   */
  async broadcast(text) {
    try {
      const sessionId = await this.resolveSessionId();
      // 先推实时：会话正忙时写历史需要排队等当前回合结束，
      // 先等写入完成再推送会把告警延迟到回复结束之后才出现
      this.pushEvent({ type: 'notice', content: text, sessionId });
      await this.appendSystemMessage(text, sessionId);
      // 排障关键信息：有没有浏览器在线、落到了哪个会话
      console.log(`[WebUI] Broadcast → session=${sessionId || '(none)'}, clients=${this._sseClients.size}`);
      return true;
    } catch (e) {
      console.error('[WebUI] broadcast failed:', e.message);
      return false;
    }
  }

  setupRoutes() {
    // ──────────────────────────────────────────
    // 获取本地文件 (用于前端渲染图片)
    // ──────────────────────────────────────────
    this.app.get('/api/file', async (req, res) => {
      try {
        const rawPath = req.query.path;
        if (!rawPath) return res.status(400).json({ error: 'Path is required' });

        // 统一使用 CoreAgent 的安全策略，避免多处路径校验规则漂移
        const policy = this.agentInstance.agent?.getFilePolicy?.();
        if (!policy) {
          return res.status(503).json({ error: 'File policy not available' });
        }
        const verdict = policy.allowRead(rawPath);

        if (!verdict.ok) {
          console.warn(`[WebUI] Blocked unauthorized file access attempt: ${verdict.resolvedPath} — ${verdict.reason}`);
          return res.status(403).json({ error: 'Forbidden', reason: verdict.reason });
        }

        const resolvedPath = verdict.resolvedPath;
        const ext = path.extname(resolvedPath).toLowerCase();
        let contentType = 'application/octet-stream';
        if (ext === '.png') contentType = 'image/png';
        else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
        else if (ext === '.gif') contentType = 'image/gif';
        else if (ext === '.webp') contentType = 'image/webp';
        else if (ext === '.svg') contentType = 'image/svg+xml';
        else if (ext === '.html') contentType = 'text/html';
        else if (ext === '.json') contentType = 'application/json';
        else if (ext === '.txt') contentType = 'text/plain';
        else if (ext === '.md') contentType = 'text/markdown';

        try {
          const data = await fs.readFile(resolvedPath);
          res.setHeader('Content-Type', contentType);
          res.send(data);
          console.log(`[WebUI] Successfully sent file via fs.readFile: ${resolvedPath}`);
        } catch (fileErr) {
          console.error(`[WebUI] fs.readFile error for ${resolvedPath}:`, fileErr);
          res.status(fileErr.code === 'ENOENT' ? 404 : 500).json({ 
            error: fileErr.message,
            code: fileErr.code 
          });
        }
      } catch (err) {
        console.error('[WebUI] /api/file error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // ──────────────────────────────────────────
    // 获取配置
    // ──────────────────────────────────────────
    this.app.get('/api/config', async (req, res) => {
      try {
        const configPath = path.join(process.cwd(), 'config', 'agent.yaml');
        const content = await fs.readFile(configPath, 'utf8');
        const parsed = yaml.parse(content);

        const defaultModel = Array.isArray(parsed.models?.default)
          ? parsed.models.default[0]
          : (parsed.models?.default || 'gpt-4o');

        res.json({
          model: defaultModel,
          fallback: parsed.models?.fallback || '',
          systemPrompt: parsed.agent?.system_prompt || '',
          workspace: parsed.agent?.workspace || './workspace',
          name: parsed.agent?.name || 'ureal',
          memory: {
            directory: parsed.memory?.directory || './memory',
            user_profile: parsed.memory?.user_profile || 'USER_PROFILE.md',
            knowledge: parsed.memory?.knowledge || 'KNOWLEDGE.md',
            facts: parsed.memory?.facts || 'FACTS.md',
            context: parsed.memory?.context || 'CONTEXT.md',
          },
          providers: parsed.models?.providers || [],
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ──────────────────────────────────────────
    // 保存配置 — 文本行替换，保留注释与格式
    // ──────────────────────────────────────────
    this.app.post('/api/config', async (req, res) => {
      try {
        const configPath = path.join(process.cwd(), 'config', 'agent.yaml');
        let content = await fs.readFile(configPath, 'utf8');

        // ── 工具函数：安全替换单行标量 ──
        const patchScalar = (text, key, newValue) => {
          const re = new RegExp(`^([ \\t]*${key}:\\s*).*$`, 'm');
          return re.test(text) ? text.replace(re, `$1"${newValue}"`) : text;
        };

        // ── 工具函数：逐行找 key 块，返回 [startLine, endLine, indentStr] ──
        const findBlock = (lines, keyRegex) => {
          for (let i = 0; i < lines.length; i++) {
            if (keyRegex.test(lines[i].trimStart())) {
              const keyIndent = lines[i].match(/^([ \t]*)/)[1].length;
              let blockIndent = -1;
              for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim() !== '') {
                  blockIndent = lines[j].match(/^([ \t]*)/)[1].length;
                  break;
                }
              }
              if (blockIndent === -1) return null;
              let end = lines.length;
              for (let j = i + 1; j < lines.length; j++) {
                const li = lines[j].match(/^([ \t]*)/)[1].length;
                if (lines[j].trim() !== '' && li <= keyIndent) { end = j; break; }
              }
              return [i, end, ' '.repeat(blockIndent)];
            }
          }
          return null;
        };

        // ── Agent scalar fields ──
        if (req.body.name) content = patchScalar(content, 'name', req.body.name);
        if (req.body.workspace) content = patchScalar(content, 'workspace', req.body.workspace);

        // ── Default model（兼容标量与列表写法）──
        if (req.body.model) {
          const model = String(req.body.model);
          if (/["'\n\r]/.test(model)) {
            return res.status(400).json({ error: '模型名不能包含引号或换行符' });
          }
          const patched = patchDefaultModel(content, model);
          if (patched === null) {
            // 关键：定位不到就报错。此前是静默跳过，界面显示"保存成功"但文件没变
            return res.status(400).json({
              error: '未能在 agent.yaml 中定位 models.default，请检查该配置项格式',
            });
          }
          content = patched;
        }

        // ── Fallback model ──
        if (req.body.fallback !== undefined) {
          content = patchScalar(content, 'fallback', req.body.fallback);
        }

        // ── System prompt (YAML literal block) ──
        if (req.body.systemPrompt !== undefined) {
          const lines = content.split('\n');
          let startLine = -1, endLine = -1, blockIndent = -1;

          for (let i = 0; i < lines.length; i++) {
            if (/^system_prompt\s*:/.test(lines[i].trimStart())) {
              startLine = i + 1;
              for (let j = startLine; j < lines.length; j++) {
                if (lines[j].trim() !== '') {
                  blockIndent = lines[j].match(/^([ \t]*)/)[1].length;
                  break;
                }
              }
              break;
            }
          }

          if (startLine !== -1 && blockIndent !== -1) {
            for (let j = startLine; j < lines.length; j++) {
              const li = lines[j].match(/^([ \t]*)/)[1].length;
              if (lines[j].trim() !== '' && li < blockIndent) { endLine = j; break; }
            }
            if (endLine === -1) endLine = lines.length;

            const ind = ' '.repeat(blockIndent);
            const newPromptLines = req.body.systemPrompt.split('\n').map(l => `${ind}${l}`);
            lines.splice(startLine, endLine - startLine, ...newPromptLines);
            content = lines.join('\n');
          }
        }

        // ── Memory fields ──
        if (req.body.memory) {
          const m = req.body.memory;
          if (m.directory) content = patchScalar(content, 'directory', m.directory);
          if (m.user_profile) content = patchScalar(content, 'user_profile', m.user_profile);
          if (m.knowledge) content = patchScalar(content, 'knowledge', m.knowledge);
          if (m.facts) content = patchScalar(content, 'facts', m.facts);
          if (m.context) content = patchScalar(content, 'context', m.context);
        }

        // ── Providers (replace entire providers block) ──
        if (req.body.providers !== undefined) {
          const lines = content.split('\n');
          const info = findBlock(lines, /^providers\s*:/);
          if (info) {
            const [startIdx, endIdx, ind] = info;
            // 生成新的 providers YAML 文本（保持缩进对齐）
            const newProviderLines = ['providers:'];
            for (const p of req.body.providers) {
              newProviderLines.push(`${ind}- name: ${p.name}`);
              newProviderLines.push(`${ind}  base_url: "${p.base_url}"`);
              newProviderLines.push(`${ind}  api_key_env: "${p.api_key_env}"`);
              newProviderLines.push(`${ind}  models:`);
              for (const m of (p.models || [])) {
                if (typeof m === 'string') {
                  newProviderLines.push(`${ind}    - ${m}`);
                } else {
                  newProviderLines.push(`${ind}    - id: "${m.id}"`);
                  newProviderLines.push(`${ind}      thinking: ${m.thinking || false}`);
                  newProviderLines.push(`${ind}      stream: ${m.stream || false}`);
                }
              }
            }
            // 计算 providers: 行本身的缩进
            const providerKeyIndent = lines[startIdx].match(/^([ \t]*)/)[1];
            const fullNewLines = newProviderLines.map((l, i) =>
              i === 0 ? `${providerKeyIndent}${l}` : l
            );
            lines.splice(startIdx, endIdx - startIdx, ...fullNewLines);
            content = lines.join('\n');
          }
        }

        await fs.writeFile(configPath, content, 'utf8');

        // 模型相关配置可热重载；workspace / system_prompt / memory 目录
        // 在启动时已固化为实例状态，必须重启才生效，此处如实回报。
        const reload = this.agentInstance.reloadSubsystem
          ? await this.agentInstance.reloadSubsystem('model')
          : { reloadable: false, requiresRestart: ['agent'] };

        const needsAgentRestart = Boolean(
          req.body.name
          || req.body.workspace
          || req.body.systemPrompt !== undefined
          || req.body.memory
        );
        res.json({ success: true, ...reload, requiresRestart: needsAgentRestart ? ['agent'] : [] });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ──────────────────────────────────────────
    // Cron 定时任务
    // ──────────────────────────────────────────
    this.app.get('/api/cron', async (req, res) => {
      try {
        const p = path.join(process.cwd(), 'config', 'cron.yaml');
        const parsed = yaml.parse(await fs.readFile(p, 'utf8'));
        res.json({ tasks: parsed?.cron?.tasks || [] });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    this.app.post('/api/cron', async (req, res) => {
      try {
        const p = path.join(process.cwd(), 'config', 'cron.yaml');
        let content = await fs.readFile(p, 'utf8');
        const parsed = yaml.parse(content) || {};
        if (!parsed.cron) parsed.cron = {};
        parsed.cron.tasks = req.body.tasks || [];
        // 只更新 tasks 块，重新序列化（cron.yaml 没有特殊模板变量）
        await fs.writeFile(p, yaml.stringify(parsed), 'utf8');

        // 写后立即重建调度器，避免「保存成功但需重启才生效」的一致性陷阱
        if (this.agentInstance.reloadSubsystem) {
          const reload = await this.agentInstance.reloadSubsystem('cron');
          return res.json({ success: true, ...reload });
        }
        res.json({ success: true, reloadable: false, requiresRestart: ['cron'] });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ──────────────────────────────────────────
    // Heartbeat 心跳
    // ──────────────────────────────────────────
    this.app.get('/api/heartbeat', async (req, res) => {
      try {
        const p = path.join(process.cwd(), 'config', 'heartbeat.yaml');
        const parsed = yaml.parse(await fs.readFile(p, 'utf8'));
        res.json({
          enabled: parsed?.heartbeat?.enabled ?? true,
          interval: parsed?.heartbeat?.interval || '*/10 * * * *',
          checks: parsed?.heartbeat?.checks || [],
          // AI 维护的动态巡检指令，必须回传给前端，否则保存时会被抹除
          dynamic_prompt: parsed?.heartbeat?.dynamic_prompt || '',
        });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // 手动触发一次巡检（调试用）：不必等 interval 到点就能验证
    // 「识别 → 广播 → web/飞书」整条链路
    this.app.post('/api/heartbeat/trigger', (req, res) => {
      const heartbeat = this.agentInstance?.heartbeat;
      if (!heartbeat || typeof heartbeat.trigger !== 'function') {
        return res.status(501).json({ success: false, error: '心跳未配置' });
      }
      // 立即返回：巡检要跑 LLM，可能耗时数十秒
      res.json({ success: true, triggering: true, clients: this._sseClients.size });
      heartbeat.trigger().catch(err => console.error('[WebUI] Manual heartbeat failed:', err.message));
    });

    this.app.post('/api/heartbeat', async (req, res) => {
      try {
        const p = path.join(process.cwd(), 'config', 'heartbeat.yaml');
        const parsed = yaml.parse(await fs.readFile(p, 'utf8')) || {};
        if (!parsed.heartbeat) parsed.heartbeat = {};
        parsed.heartbeat.enabled = req.body.enabled;
        parsed.heartbeat.interval = req.body.interval;
        parsed.heartbeat.checks = req.body.checks || [];
        // 保留 AI 维护的动态巡检指令（前端可能未提交该字段）
        if (req.body.dynamic_prompt !== undefined) {
          parsed.heartbeat.dynamic_prompt = req.body.dynamic_prompt;
        }

        await fs.writeFile(p, yaml.stringify(parsed), 'utf8');

        // 写后立即重载心跳配置（此前保存后必须重启才生效）
        if (this.agentInstance.reloadSubsystem) {
          const reload = await this.agentInstance.reloadSubsystem('heartbeat');
          return res.json({ success: true, ...reload });
        }
        res.json({ success: true, reloadable: false, requiresRestart: ['heartbeat'] });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ──────────────────────────────────────────
    // MCP Servers (mcporter.json)
    // ──────────────────────────────────────────
    this.app.get('/api/mcp', async (req, res) => {
      try {
        const p = path.join(process.cwd(), 'config', 'mcporter.json');
        const parsed = JSON.parse(await fs.readFile(p, 'utf8'));
        const servers = Object.entries(parsed.mcpServers || {}).map(([name, cfg]) => ({ name, ...cfg }));
        res.json({ servers });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    this.app.post('/api/mcp', async (req, res) => {
      try {
        const p = path.join(process.cwd(), 'config', 'mcporter.json');
        const servers = req.body.servers || [];
        const mcpServers = {};
        for (const s of servers) {
          const { name, ...rest } = s;
          mcpServers[name] = rest;
        }
        await fs.writeFile(p, JSON.stringify({ mcpServers }, null, 2), 'utf8');

        // MCP runtime 涉及子进程与外部连接，不支持热重载，如实告知前端
        const reload = this.agentInstance.reloadSubsystem
          ? await this.agentInstance.reloadSubsystem('mcp')
          : { reloadable: false, requiresRestart: ['mcporter'] };
        res.json({ success: true, ...reload });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // miot-mcp 登录 — 直接调用 mcporter.callTool，无需走 LLM
    this.app.post('/api/mcp/miot-login', async (req, res) => {
      try {

        const mcporter = this.agentInstance.mcporter;
        if (!mcporter) {
          return res.status(503).json({ error: 'MCPorter service not running. Make sure miot-mcp is enabled.' });
        }

        const qrPath = path.join(os.homedir(), '.miot-mcp', 'qr.png');
        const qrHtmlPath = path.join(os.homedir(), '.miot-mcp', 'qr.html');

        // 先清理旧的二维码文件
        try { await fs.unlink(qrPath); } catch (e) { /* ignore */ }
        try { await fs.unlink(qrHtmlPath); } catch (e) { /* ignore */ }

        const servers = mcporter.runtime ? mcporter.runtime.listServers() : [];
        let result = 'Tool call running in background';

        // 异步执行调用，防止底层进程卡死阻塞响应
        const toolPromise = (async () => {
          if (servers.includes('miot-mcp')) {
            console.log('[WebUI] Calling prepare_login on persistent miot-mcp server...');
            await mcporter.runtime.callTool('miot-mcp', 'prepare_login', {
              args: { force_reauth: true, reopen_qr: true }
            });
            console.log('[WebUI] Finished calling prepare_login on persistent server.');
          } else {
            console.log('[WebUI] Calling prepare_login via fallback callOnce...');
            await mcporter.callToolDirect('miot-mcp', 'prepare_login', {
              force_reauth: true,
              reopen_qr: true,
            });
            console.log('[WebUI] Finished calling prepare_login via fallback.');
          }
        })().catch(err => console.error('[WebUI] prepare_login error:', err));

        console.log('[WebUI] Started toolPromise in background, now polling for QR code...');

        // 轮询等待文件写入（最多 60 秒，因为远程服务器拉取二维码网络可能较慢）
        let imgBase64 = null;
        let generatedAt = null;
        console.log(`[WebUI] Polling for QR code at: ${qrPath}`);
        for (let i = 0; i < 120; i++) {
          try {
            const buf = await fs.readFile(qrPath);
            if (buf.length > 50) { // 确保文件已被完整写入
              imgBase64 = `data:image/png;base64,${buf.toString('base64')}`;
              const stats = await fs.stat(qrPath);
              generatedAt = stats.mtime.toLocaleString();
              console.log(`[WebUI] Success reading QR code on attempt ${i + 1}`);
              break;
            }
          } catch {
            await new Promise(r => setTimeout(r, 500));
          }
        }

        if (!imgBase64) {
          return res.status(504).json({ error: 'QR image not generated. Check miot-mcp logs.', detail: result });
        }

        res.json({ qr: imgBase64, detail: result, generatedAt });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ──────────────────────────────────────────
    // 健康检查（供前端在重启后轮询恢复状态）
    // ──────────────────────────────────────────
    this.app.get('/api/health', (req, res) => {
      res.json({
        ok: true,
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        restarting: Boolean(this.agentInstance?._restarting),
      });
    });

    // ──────────────────────────────────────────
    // 重启 Agent
    // ──────────────────────────────────────────
    this.app.post('/api/restart', (req, res) => {
      if (this.agentInstance?._restarting) {
        return res.status(409).json({ success: false, error: '正在重启中，请稍候' });
      }
      if (typeof this.agentInstance?.restart !== 'function') {
        return res.status(501).json({ success: false, error: '当前运行环境不支持重启' });
      }

      // 必须先返回响应再重启：stop() 会关闭本 HTTP 服务（含当前连接），
      // 若同步等待重启完成，浏览器只会收到连接被中断的错误。
      res.json({ success: true, restarting: true });
      setTimeout(() => {
        this.agentInstance.restart().then((r) => {
          if (!r?.success) console.error('[WebUI] Restart failed:', r?.error);
        }).catch((e) => console.error('[WebUI] Restart error:', e.message));
      }, 400);
    });

    // ──────────────────────────────────────────
    // 读取 .env 变量
    // ──────────────────────────────────────────
    this.app.get('/api/env', async (req, res) => {
      try {
        const envPath = path.join(process.cwd(), '.env');
        const content = await fs.readFile(envPath, 'utf8').catch(() => '');
        // 逐行解析，保留注释行和空行结构
        const lines = content.split('\n').map((line, idx) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            return { idx, type: 'comment', raw: line };
          }
          const eqPos = line.indexOf('=');
          if (eqPos === -1) return { idx, type: 'comment', raw: line };
          const key = line.slice(0, eqPos).trim();
          const value = parseEnvValue(line.slice(eqPos + 1));
          return { idx, type: 'var', key, value };
        });
        res.json({ lines });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // 保存 .env 变量
    this.app.post('/api/env', async (req, res) => {
      try {
        const envPath = path.join(process.cwd(), '.env');
        const { lines } = req.body;
        const content = lines.map(l => {
          if (l.type === 'comment') return l.raw;
          return `${l.key}=${formatEnvValue(l.value)}`;
        }).join('\n');
        await fs.writeFile(envPath, content, 'utf8');

        // 同步到 process.env 并刷新模型配置里的 apiKey，避免「界面已改但仍在用旧值」
        const reload = this.agentInstance.reloadSubsystem
          ? await this.agentInstance.reloadSubsystem('env')
          : { reloadable: false, requiresRestart: ['feishu'] };
        res.json({ success: true, ...reload });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ──────────────────────────────────────────
    // 读取记忆文件内容
    // ──────────────────────────────────────────
    this.app.get('/api/memory/:filename', async (req, res) => {
      try {
        const configPath = path.join(process.cwd(), 'config', 'agent.yaml');
        const content = await fs.readFile(configPath, 'utf8');
        const parsed = yaml.parse(content);
        const memDir = path.resolve(process.cwd(), parsed.memory?.directory || './memory');
        const filePath = path.join(memDir, req.params.filename);
        // 安全检查：文件必须严格位于 memory 目录内（path.relative 判定，杜绝前缀绕过）
        if (!isInside(memDir, filePath)) return res.status(403).json({ error: 'Forbidden' });
        const fileContent = await fs.readFile(filePath, 'utf8').catch(() => '');
        res.json({ content: fileContent });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // 保存记忆文件内容
    this.app.post('/api/memory/:filename', async (req, res) => {
      try {
        const configPath = path.join(process.cwd(), 'config', 'agent.yaml');
        const content = await fs.readFile(configPath, 'utf8');
        const parsed = yaml.parse(content);
        const memDir = path.resolve(process.cwd(), parsed.memory?.directory || './memory');
        const filePath = path.join(memDir, req.params.filename);
        if (!isInside(memDir, filePath)) return res.status(403).json({ error: 'Forbidden' });
        await fs.mkdir(memDir, { recursive: true });
        await fs.writeFile(filePath, req.body.content || '', 'utf8');
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ──────────────────────────────────────────
    // 聊天历史
    // ──────────────────────────────────────────
    this.app.get('/api/chat/history', async (req, res) => {
      try {
        const sessionId = req.query.sessionId || 'webui_default';
        const coreAgent = this.agentInstance.agent;

        if (!coreAgent._sessions[sessionId]) {
          coreAgent._sessions[sessionId] = await coreAgent._loadSession(sessionId);
        }

        const history = coreAgent._sessions[sessionId] || [];
        this.touchSession(sessionId);
        res.json({ history: buildDisplayHistory(history) });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ──────────────────────────────────────────
    // 实时事件流（SSE）
    //
    // /api/chat 是「一问一答」的流式响应，无法承载心跳告警这类旁路通知。
    // 这里维护一条浏览器长连接，服务端有异步消息时主动下发。
    // ──────────────────────────────────────────
    this.app.get('/api/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      res.write(': connected\n\n');

      this._sseClients.add(res);
      console.log(`[WebUI] Event stream connected (${this._sseClients.size} client(s))`);

      // 心跳保活，避免代理/浏览器把空闲连接掐掉
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (e) { /* 连接已断，close 回调会清理 */ }
      }, 25000);

      const cleanup = () => {
        clearInterval(ping);
        if (this._sseClients.delete(res)) {
          console.log(`[WebUI] Event stream closed (${this._sseClients.size} client(s))`);
        }
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
    });

    // ──────────────────────────────────────────
    // 聊天
    // ──────────────────────────────────────────
    this.app.post('/api/chat', async (req, res) => {
      try {
        const { message, sessionId, stream } = req.body;
        if (!message) return res.status(400).json({ error: 'Message is required' });

        // 记住当前会话，异步通知（心跳告警等）投递到这里
        this.touchSession(sessionId || 'webui_default');

        // 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const sendEvent = (data) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const result = await this.agentInstance.thinkAndAct(message, {
          sessionId: sessionId || 'webui_default',
          stream: stream !== undefined ? stream : true,
          onStream: (event) => {
            sendEvent(event);
          }
        });

        const reply = result?.reply || result?.response
          || (typeof result === 'string' ? result : '执行完毕，未返回特定内容。');
        sendEvent({ type: 'done', reply });
        res.end();
      } catch (err) {
        console.error('[WebUI] Chat stream error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: err.message });
        } else {
          res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
          res.end();
        }
      }
    });
  }

  /**
   * 启动 HTTP 服务
   *
   * 端口可能因为上一次进程的 socket 仍在 TIME_WAIT 而短暂不可用
   * （软重启、`node --watch` 热重载时很常见），因此做有界重试，
   * 避免一次性失败导致整个 Agent 退出。
   *
   * @param {number} attempts - 最大尝试次数
   * @param {number} delayMs - 每次重试间隔
   */
  async start(attempts = 3, delayMs = 600) {
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
      try {
        await new Promise((resolve, reject) => {
          const server = this.app.listen(this.port, () => {
            console.log(`[WebUI] Server running at http://localhost:${this.port}`);
            resolve();
          });
          server.on('error', (err) => {
            server.close(() => {});
            reject(err);
          });
          this.server = server;
        });
        return;
      } catch (err) {
        lastError = err;
        this.server = null;
        if (err.code !== 'EADDRINUSE' || i === attempts - 1) break;
        console.warn(`[WebUI] Port ${this.port} busy (${err.code}), retry ${i + 1}/${attempts - 1} in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    console.error(`[WebUI] Listen error on port ${this.port}: ${lastError?.message}`);
    throw lastError;
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;

    // 主动丢弃事件流客户端，避免重启后继续往已断开的连接写数据
    this._sseClients.clear();

    // 必须等到 close 回调：软重启会立刻在原端口重新 listen，
    // 只调用 close() 而不等待会导致新服务拿到 EADDRINUSE。
    await new Promise((resolve) => {
      server.close(() => resolve());
      // keep-alive 与 SSE 长连接会阻止 close 回调，需要主动断开
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      setTimeout(resolve, 3000); // 兜底，避免极端情况永久挂起
    });
    console.log('[WebUI] Server stopped');
  }
}

export default WebUIService;
export { formatEnvValue, parseEnvValue, patchDefaultModel };
