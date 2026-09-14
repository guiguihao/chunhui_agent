import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';
import os from 'os';
import { log } from 'console';

class WebUIService {
  constructor(config, agentInstance) {
    this.config = config || {};
    this.port = this.config.port || 8080;
    this.agentInstance = agentInstance;
    this.app = express();

    this.app.use(cors());
    this.app.use(express.json());

    this.setupRoutes();
  }

  setupRoutes() {
    // ──────────────────────────────────────────
    // 获取本地文件 (用于前端渲染图片)
    // ──────────────────────────────────────────
    this.app.get('/api/file', async (req, res) => {
      try {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).json({ error: 'Path is required' });

        const resolvedPath = path.resolve(filePath);
        const homeDir = os.homedir();
        const workspaceDir = path.resolve(process.cwd(), 'workspace');
        const miotMcpDir = path.resolve(homeDir, '.miot-mcp');

        const isAllowed = resolvedPath.startsWith(workspaceDir) || 
                          resolvedPath.startsWith(miotMcpDir) ||
                          resolvedPath.startsWith(path.resolve(process.cwd()));

        if (!isAllowed) {
          console.warn(`[WebUI] Blocked unauthorized file access attempt: ${resolvedPath}`);
          return res.status(403).json({ error: 'Forbidden' });
        }

        console.log(`[WebUI] Serving file: ${resolvedPath}`);
        console.log(`[WebUI] OS homedir: ${homeDir}, miotMcpDir: ${miotMcpDir}, isAllowed: ${isAllowed}`);
        
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

        // ── Default model (array first item) ──
        if (req.body.model) {
          const modelRe = /^([ \t]*default:\s*\n[ \t]*-\s*)(.+)$/m;
          if (modelRe.test(content)) {
            content = content.replace(modelRe, `$1${req.body.model}`);
          }
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
        await this.agentInstance.loadConfig();

        res.json({ success: true });
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
        res.json({ success: true });
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
        });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    this.app.post('/api/heartbeat', async (req, res) => {
      try {
        const p = path.join(process.cwd(), 'config', 'heartbeat.yaml');
        const parsed = yaml.parse(await fs.readFile(p, 'utf8')) || {};
        if (!parsed.heartbeat) parsed.heartbeat = {};
        parsed.heartbeat.enabled = req.body.enabled;
        parsed.heartbeat.interval = req.body.interval;
        parsed.heartbeat.checks = req.body.checks || [];
        await fs.writeFile(p, yaml.stringify(parsed), 'utf8');
        res.json({ success: true });
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
        res.json({ success: true });
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
          const value = line.slice(eqPos + 1).trim().replace(/^["']|["']$/g, '');
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
          return `${l.key}=${l.value}`;
        }).join('\n');
        await fs.writeFile(envPath, content, 'utf8');
        res.json({ success: true });
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
        // 安全检查：文件必须在 memory 目录内
        if (!filePath.startsWith(memDir)) return res.status(403).json({ error: 'Forbidden' });
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
        if (!filePath.startsWith(memDir)) return res.status(403).json({ error: 'Forbidden' });
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
        const displayHistory = history.map((msg, index) => {
          let content = msg.content;
          if (!content) {
            if (msg.tool_calls) content = `[执行工具: ${msg.tool_calls.map(t => t.function?.name).join(', ')}]`;
            else if (msg.role === 'tool') content = `[工具返回结果]`;
            else content = '';
          }
          return {
            id: Date.now() + index,
            role: msg.role === 'tool' ? 'system' : msg.role,
            content,
          };
        }).filter(msg => msg.content);

        res.json({ history: displayHistory });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ──────────────────────────────────────────
    // 聊天
    // ──────────────────────────────────────────
    this.app.post('/api/chat', async (req, res) => {
      try {
        const { message, sessionId, stream } = req.body;
        if (!message) return res.status(400).json({ error: 'Message is required' });

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

  async start() {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`[WebUI] Server running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  async stop() {
    if (this.server) {
      this.server.close();
      console.log(`[WebUI] Server stopped`);
    }
  }
}

export default WebUIService;
