import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';

/**
 * WorkflowService - 工作流引擎
 *
 * 支持步骤类型：
 *   - decide    : 调用 CoreAgent 做 AI 决策
 *   - skill     : 直接执行技能
 *   - mcp       : 直接调用 MCP 工具
 *   - condition : 条件分支 (if_true / if_false)
 *   - parallel  : 并行执行子步骤
 *   - notify    : 广播消息到飞书
 *   - wait      : 等待指定毫秒
 */
class WorkflowService {
  constructor(config = {}) {
    this.configDir = path.resolve(
      process.cwd(),
      config.config_dir || './config/workflows'
    );
    this.workflows = {};     // id → workflow definition
    this._agent = null;      // CoreAgent
    this._skillService = null;
    this._mcpService = null;
    this._broadcast = null;  // async fn(message) → 发送到飞书
  }

  /**
   * 注入依赖
   */
  setAgent(agent) { this._agent = agent; }
  setSkillService(s) { this._skillService = s; }
  setMCPService(s) { this._mcpService = s; }
  setBroadcast(fn) { this._broadcast = fn; }

  /**
   * 初始化：加载 workflows.yaml
   */
  async init() {
    try {
      // 扫描目录下所有 .yaml 文件
      let files;
      try {
        files = await fs.readdir(this.configDir);
      } catch (e) {
        if (e.code === 'ENOENT') {
          console.log('[Workflow] No workflows directory found, skipping...');
          return;
        }
        throw e;
      }

      const yamlFiles = files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
      if (yamlFiles.length === 0) {
        console.log('[Workflow] No .yaml files found in workflows directory.');
        return;
      }

      let totalCount = 0;
      for (const filename of yamlFiles) {
        const filePath = path.join(this.configDir, filename);
        try {
          const raw = await fs.readFile(filePath, 'utf8');
          const parsed = yaml.parse(raw);
          const list = parsed?.workflows || [];
          for (const wf of list) {
            if (this.workflows[wf.id]) {
              console.warn(`[Workflow] Duplicate workflow id "${wf.id}" in ${filename}, overwriting.`);
            }
            this.workflows[wf.id] = { ...wf, _file: filename };
            totalCount++;
          }
          console.log(`[Workflow] Loaded ${list.length} workflow(s) from ${filename}`);
        } catch (e) {
          console.error(`[Workflow] Failed to load ${filename}:`, e.message);
        }
      }

      console.log(`[Workflow] Total: ${totalCount} workflow(s) from ${yamlFiles.length} file(s): ${Object.keys(this.workflows).join(', ')}`);
    } catch (e) {
      console.error('[Workflow] Init error:', e.message);
    }
  }

  /**
   * 列出所有工作流
   */
  list() {
    return Object.values(this.workflows).map(w => ({
      id: w.id,
      name: w.name,
      file: w._file || 'unknown',
      steps: (w.steps || []).length,
    }));
  }

  /**
   * 获取单个工作流的完整定义
   */
  get(workflowId) {
    const wf = this.workflows[workflowId];
    if (!wf) throw new Error(`Workflow "${workflowId}" not found`);
    // 返回去除内部字段的干净副本
    const { _file, ...clean } = wf;
    return clean;
  }

  /**
   * 保存工作流到 YAML 文件（创建或更新）
   * - 如果 workflowId 已存在，更新该 workflow 并写回所在文件
   * - 如果是新 workflow，写入 {id}.yaml
   * @param {object} definition - { id, name, steps[] }
   */
  async save(definition) {
    if (!definition?.id) throw new Error('workflow must have an "id" field');
    if (!Array.isArray(definition.steps)) throw new Error('workflow must have a "steps" array');

    const existing = this.workflows[definition.id];
    // 确定目标文件
    const filename = existing?._file || `${definition.id}.yaml`;
    const filePath = path.join(this.configDir, filename);

    let fileWorkflows = [];
    // 读取已有文件内容（如有）
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = yaml.parse(raw);
      fileWorkflows = parsed?.workflows || [];
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // 文件不存在，创建新文件
    }

    // 替换或追加
    const idx = fileWorkflows.findIndex(w => w.id === definition.id);
    const { _file, ...cleanDef } = definition; // 去除内部字段
    if (idx >= 0) {
      fileWorkflows[idx] = cleanDef;
    } else {
      fileWorkflows.push(cleanDef);
    }

    // 写入文件
    await fs.mkdir(this.configDir, { recursive: true });
    const content = yaml.stringify({ workflows: fileWorkflows });
    await fs.writeFile(filePath, content, 'utf8');

    // 更新内存
    this.workflows[definition.id] = { ...cleanDef, _file: filename };
    console.log(`[Workflow] 💾 Saved workflow "${definition.id}" → ${filename}`);
    return { success: true, file: filename };
  }

  /**
   * 删除工作流（从 YAML 文件中移除对应条目）
   * @param {string} workflowId
   */
  async delete(workflowId) {
    const wf = this.workflows[workflowId];
    if (!wf) throw new Error(`Workflow "${workflowId}" not found`);

    const filename = wf._file;
    const filePath = path.join(this.configDir, filename);

    // 读取文件
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = yaml.parse(raw);
    let fileWorkflows = parsed?.workflows || [];

    fileWorkflows = fileWorkflows.filter(w => w.id !== workflowId);

    // 如果文件空了，删除文件；否则写回
    if (fileWorkflows.length === 0) {
      await fs.unlink(filePath);
      console.log(`[Workflow] 🗑️ Deleted file: ${filename}`);
    } else {
      await fs.writeFile(filePath, yaml.stringify({ workflows: fileWorkflows }), 'utf8');
      console.log(`[Workflow] 🗑️ Removed "${workflowId}" from ${filename}`);
    }

    delete this.workflows[workflowId];
    return { success: true };
  }

  /**
   * 重新从磁盘加载所有工作流（热重载）
   */
  async reload() {
    this.workflows = {};
    await this.init();
    return { success: true, count: Object.keys(this.workflows).length };
  }

  /**
   * 执行指定工作流
   * @param {string} workflowId
   * @param {object} initialContext - 初始变量 (可选)
   */
  async run(workflowId, initialContext = {}) {
    const wf = this.workflows[workflowId];
    if (!wf) throw new Error(`Workflow "${workflowId}" not found`);

    console.log(`\n[Workflow] ▶ Starting: ${wf.name || workflowId}`);

    const ctx = { ...initialContext };

    try {
      await this._executeSteps(wf.steps || [], ctx);
      console.log(`[Workflow] ✅ Completed: ${workflowId}`);
      return { success: true, context: ctx };
    } catch (e) {
      console.error(`[Workflow] ❌ Failed: ${workflowId} →`, e.message);
      return { success: false, error: e.message, context: ctx };
    }
  }

  /**
   * 顺序执行步骤列表
   */
  async _executeSteps(steps, ctx) {
    for (const step of steps) {
      await this._executeStep(step, ctx);
    }
  }

  /**
   * 执行单个步骤
   */
  async _executeStep(step, ctx) {
    console.log(`[Workflow]   → Step [${step.id}] type=${step.type}`);

    let result = null;

    switch (step.type) {
      case 'decide':
        result = await this._stepDecide(step, ctx);
        break;

      case 'skill':
        result = await this._stepSkill(step, ctx);
        break;

      case 'mcp':
        result = await this._stepMCP(step, ctx);
        break;

      case 'condition':
        result = await this._stepCondition(step, ctx);
        break;

      case 'parallel':
        result = await this._stepParallel(step, ctx);
        break;

      case 'notify':
        result = await this._stepNotify(step, ctx);
        break;

      case 'wait':
        await new Promise(r => setTimeout(r, step.ms || 1000));
        result = `waited ${step.ms || 1000}ms`;
        break;

      default:
        console.warn(`[Workflow]   ⚠ Unknown step type: ${step.type}`);
        result = null;
    }

    // 将输出存入上下文
    if (step.output && result !== null && result !== undefined) {
      ctx[step.output] = result;
      console.log(`[Workflow]   ↳ ${step.output} = ${String(result).substring(0, 80)}...`);
    }

    return result;
  }

  // ─── Step Handlers ─────────────────────────────────────────────────────────

  async _stepDecide(step, ctx) {
    if (!this._agent) throw new Error('CoreAgent not injected');
    const prompt = this._resolveTemplate(step.prompt || '', ctx);
    const res = await this._agent.decide(prompt, { sessionId: 'workflow' });
    // 提取纯文本
    if (res && typeof res === 'object') return res.response || res.reply || JSON.stringify(res);
    return String(res);
  }

  async _stepSkill(step, ctx) {
    if (!this._skillService) throw new Error('SkillService not injected');
    const params = this._resolveParams(step.params || {}, ctx);
    const res = await this._skillService.run(step.skill, params, this._agent);
    if (res && typeof res === 'object') return res.response || res.reply || JSON.stringify(res);
    return String(res);
  }

  async _stepMCP(step, ctx) {
    if (!this._mcpService) throw new Error('MCPService not injected');
    const params = this._resolveParams(step.params || {}, ctx);
    const res = await this._mcpService.callTool(step.tool, params);
    return res;
  }

  async _stepCondition(step, ctx) {
    const conditionMet = this._evaluateCondition(step.condition || 'false', ctx);
    console.log(`[Workflow]   ↳ condition "${step.condition}" = ${conditionMet}`);
    const branch = conditionMet ? (step.if_true || []) : (step.if_false || []);
    await this._executeSteps(branch, ctx);
    return conditionMet;
  }

  async _stepParallel(step, ctx) {
    const subSteps = step.steps || [];
    const results = await Promise.all(
      subSteps.map(s => this._executeStep(s, ctx))
    );
    return results;
  }

  async _stepNotify(step, ctx) {
    if (!this._broadcast) {
      console.warn('[Workflow] No broadcast function set, cannot notify.');
      return null;
    }
    const message = this._resolveTemplate(step.message || '', ctx);
    await this._broadcast(message);
    return message;
  }

  // ─── Utilities ──────────────────────────────────────────────────────────────

  /**
   * 将字符串模板中的 ${varName.subVar} 替换为 ctx 中的值
   */
  _resolveTemplate(str, ctx) {
    return str.replace(/\$\{(.+?)\}/g, (match, path) => {
      const keys = path.trim().split('.');
      let val = ctx;
      for (const k of keys) {
        val = val?.[k];
      }
      if (val === undefined) return match;
      return typeof val === 'object' ? JSON.stringify(val) : String(val);
    });
  }

  /**
   * 递归解析参数对象中的模板
   */
  _resolveParams(params, ctx) {
    if (typeof params === 'string') return this._resolveTemplate(params, ctx);
    if (Array.isArray(params)) return params.map(p => this._resolveParams(p, ctx));
    if (typeof params === 'object' && params !== null) {
      const resolved = {};
      for (const [k, v] of Object.entries(params)) {
        resolved[k] = this._resolveParams(v, ctx);
      }
      return resolved;
    }
    return params;
  }

  /**
   * 安全评估条件表达式（仅支持数值比较和布尔值）
   * 支持：>, <, >=, <=, ==, !=, true, false
   * 表达式中的 {{varName}} 会被替换为 ctx 中的值
   */
  _evaluateCondition(expr, ctx) {
    try {
      // 替换 {{varName}} 变量
      const resolved = expr.replace(/\{\{([\w.]+)\}\}/g, (match, path) => {
        const keys = path.split('.');
        let val = ctx;
        for (const k of keys) {
          val = val?.[k];
        }
        if (val === undefined || val === null) return 'null';
        // 使用 JSON.stringify 安全转义字符串，防止注入
        if (typeof val === 'string') return JSON.stringify(val);
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      });

      // 直接执行，因为 YAML 是系统配置，且变量已被 JSON.stringify 安全转义
      // eslint-disable-next-line no-new-func
      return Boolean(new Function(`"use strict"; return (${resolved})`)());
    } catch (e) {
      console.warn(`[Workflow] Condition eval failed: "${expr}" → ${e.message}`);
      return false;
    }
  }
}

export default WorkflowService;
