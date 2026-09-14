/**
 * CoreAgent - ureal 核心 Agent 引擎
 * 基于 guiguihao/ureal/src/core/agent.py 设计
 * 支持工具调用循环、记忆管理、定时任务、心跳巡检
 */
import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant named "{name}".`;

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
    this._memoryService = null;
    this._skillService = null;   // 技能服务
    this._workflowService = null; // 工作流服务
    this._workspace = '';          // 工作目录
    this._scheduler = null;
    this._heartbeat = null;
    this._onCronTaskExecute = null;
    this._mcpTools = [];         // MCP 工具列表（OpenAI function-calling 格式）
    this._mcpToolMap = {};       // toolPrefix → { server, toolName, schema }
    this._mcpService = null;     // MCPorterService 实例
    this._readmeCache = null;    // README.md 内容缓存
    this._onCronTasksChanged = null; // Cron 任务变更回调
  }

  setSkill(skillService) {
    this._skillService = skillService;
  }

  setWorkflow(workflowService) {
    this._workflowService = workflowService;
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
      const all = await this._memoryService.getAll();
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

    return this.systemPrompt
      .replace('{name}', this.name)
      .replace(/{workspace}/g, this._workspace || process.cwd())
      .replace('{readme.md}', this._readmeCache)
      .replace('{time}', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
  }

  async _getAllTools(filter = null) {
    let tools = [];

    if (this._memoryService) {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'memory_get_user_profile',
            description: '获取用户偏好设置',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_update_user_profile',
            description: '更新（追加）用户偏好设置',
            parameters: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '需要追加的偏好内容' },
              },
              required: ['content'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_get_knowledge',
            description: '获取长期知识库与经验记录',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_get_context',
            description: '获取当前对话背景与即时上下文信息',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_update_context',
            description: '更新当前对话背景与即时上下文信息（用于保存最新的关键背景或阶段性状态）',
            parameters: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '完整的上下文背景内容' },
              },
              required: ['content'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_update_knowledge',
            description: '更新（追加）长期知识库与经验记录（用于保存有价值的长期信息）',
            parameters: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '需要追加的长期信息（支持 Markdown 格式）' },
              },
              required: ['content'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_get_facts',
            description: '获取重要事实记录与关键数据',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_update_facts',
            description: '更新（追加）重要事实记录与关键数据',
            parameters: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '需要追加的事实或关键数据' },
              },
              required: ['content'],
            },
          },
        }
      );
    }

    if (this._scheduler) {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'mgmt_cron_list',
            description: '列出当前所有定时任务',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'mgmt_cron_add',
            description: '添加一个新的定时任务',
            parameters: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: '唯一英文 ID' },
                name: { type: 'string', description: '任务名称' },
                cron: { type: 'string', description: '5段 cron 表达式' },
                description: { type: 'string', description: '任务指令' },
              },
              required: ['task_id', 'name', 'cron', 'description'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'mgmt_cron_remove',
            description: '删除一个定时任务',
            parameters: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: '任务 ID' },
              },
              required: ['task_id'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'mgmt_cron_toggle',
            description: '启用或禁用一个定时任务',
            parameters: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: '任务 ID' },
                enabled: { type: 'boolean', description: 'true=启用，false=禁用' },
              },
              required: ['task_id', 'enabled'],
            },
          },
        }
      );
    }

    if (this._heartbeat) {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'mgmt_heartbeat_get',
            description: '读取当前心跳巡检的任务指令内容',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'mgmt_heartbeat_set',
            description: '修改心跳巡检任务的指令内容',
            parameters: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '新的心跳任务指令' },
              },
              required: ['content'],
            },
          },
        }
      );
    }

    // 文件操作工具（沙箱化：限制在工作目录）
    tools.push(
      {
        type: 'function',
        function: {
          name: 'file_read',
          description: '读取文件内容（仅限工作目录，禁止读取敏感配置文件）',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件相对路径或工作区内绝对路径' },
            },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'file_write',
          description: '向工作区写入文件内容（覆盖写入，仅限工作目录）',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '目标文件相对路径' },
              content: { type: 'string', description: '要写入的文件内容' },
            },
            required: ['path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'file_append',
          description: '向工作区文件追加内容（仅限工作目录）',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '目标文件相对路径' },
              content: { type: 'string', description: '要追加的文件内容' },
            },
            required: ['path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'file_exists',
          description: '检查指定文件或目录是否存在',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径' },
            },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'file_list',
          description: '列出工作区指定目录下的文件列表',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '目录路径，默认工作目录根路径' },
            },
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'file_delete',
          description: '删除工作区内的文件（仅限工作目录）',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '要删除的文件相对路径' },
            },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'file_edit',
          description: '编辑工作区文件内容（支持插入行、删除行、替换行、文本替换等，仅限工作目录）',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '目标文件路径' },
              find: { type: 'string', description: '要查找的文本或正则' },
              replace: { type: 'string', description: '替换后的新文本' },
              insert_line: { type: 'number', description: '在此行号前插入内容' },
              content: { type: 'string', description: '插入或替换的文本内容' },
              replace_line: { type: 'number', description: '替换指定行号内容' },
              delete_line: { type: 'number', description: '删除指定行号' },
              all: { type: 'boolean', description: '是否替换所有匹配项' },
              regex: { type: 'boolean', description: '是否将 find 作为正则表达式' },
            },
            required: ['path'],
          },
        },
      }
    );

    // 技能工具
    if (this._skillService) {
      // 1. 保留底层系统交互指令 (cmd_exec)
      tools.push(
        {
          type: 'function',
          function: {
            name: 'cmd_exec',
            description: '在服务器上执行终端命令（如运行 Python 脚本）。对于生图、浏览器自动化等耗时任务，请通过 timeout_ms 设置足够的超时时间（生图建议 600000 即 10 分钟）。',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string', description: '要执行的完整命令字符串' },
                timeout_ms: { type: 'number', description: '超时时间（毫秒）。默认 30000，普通 Python 脚本自动使用 120000，生图等耐时脚本建议传入 600000。' },
                cwd: { type: 'string', description: '命令执行目录（可选）' },
              },
              required: ['command'],
            },
          },
        }
      );

      // 2. 动态映射具体技能为顶级工具
      try {
        const skillList = await this._skillService.list();
        for (const skill of skillList) {
          // 避免与内置工具冲突
          if (['cmd_exec'].includes(skill.name)) continue;

          // 优先使用技能定义的 parameters，如果未定义则使用兜底 schema
          const skillParameters = skill.parameters || {
            type: 'object',
            properties: {
              query: { type: 'string', description: '传递给技能的参数说明，如搜索词或指令内容' },
            },
            additionalProperties: true,
          };

          tools.push({
            type: 'function',
            function: {
              // 统一使用下划线，并移除任何不符合 API 要求的非法字符 (^[a-zA-Z0-9_-]+$)
              name: skill.name.replace(/-/g, '_').replace(/[^a-zA-Z0-9_-]/g, '_'),
              description: `[Skill] ${skill.description || skill.name}`,
              parameters: skillParameters,
            },
          });
        }
      } catch (e) {
        console.error(`[CoreAgent] 获取技能列表失败: ${e.message}`);
      }
    }

    // 工作流工具
    if (this._workflowService) {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'workflow_list',
            description: '获取当前可用工作流列表',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'workflow_run',
            description: '执行指定的工作流（如早晨例行任务、设备巡检等）',
            parameters: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '工作流 ID' },
                context: { type: 'object', description: '初始变量（可选）' },
              },
              required: ['id'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'workflow_get',
            description: '读取指定工作流的完整定义（用于编辑前先查看）',
            parameters: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '工作流 ID' },
              },
              required: ['id'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'workflow_save',
            description: '创建或更新工作流，持久化到 config/workflows/ 目录下的 YAML 文件。新工作流会创建同名 YAML 文件。',
            parameters: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '工作流唯一 ID（英文加下划线）' },
                name: { type: 'string', description: '工作流显示名称' },
                steps: {
                  type: 'array',
                  description: '步骤列表，每个元素包含 id/type 等字段',
                  items: { type: 'object' },
                },
              },
              required: ['id', 'steps'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'workflow_delete',
            description: '删除指定工作流，从 YAML 文件中移除对应条目',
            parameters: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '要删除的工作流 ID' },
              },
              required: ['id'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'workflow_reload',
            description: '重新从磁盘加载工作流配置（手动编辑 YAML 文件后使用）',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      );
    }

    // MCP 工具
    if (this._mcpTools.length > 0) {
      tools.push(...this._mcpTools);
    }

    // 应用过滤器
    if (typeof filter === 'function') {
      tools = tools.filter(filter);
    }

    // 最终防御：确保所有工具名都符合 API 要求 (^[a-zA-Z0-9_-]+$)
    // 将不合法字符替换为下划线，并移除首尾多余下划线
    tools = tools.map(t => {
      if (!t?.function?.name) return t;
      const cleanedName = t.function.name
        .replace(/[^a-zA-Z0-9_-]/g, '_') // 替换非法字符
        .replace(/^_+|_+$/g, '')         // 移除首尾下划线
        .replace(/__+/g, '_')            // 合并连续下划线
        || 'tool';                       // 防止空名
      if (cleanedName !== t.function.name) {
        console.warn(`[CoreAgent] 工具名含非法字符已自动清理: "${t.function.name}" → "${cleanedName}"`);
      }
      return {
        ...t,
        function: { ...t.function, name: cleanedName },
      };
    });

    return tools;
  }

  /**
   * 处理工具调用（异步）
   */
  async _handleToolCall(toolName, args = {}) {
    // 过滤掉可能由某些模型输出附加的特殊标记后缀 (如 <|channel|>commentary)
    const cleanToolName = typeof toolName === 'string' ? toolName.replace(/<\|.*$/, '').trim() : toolName;

    if (cleanToolName.startsWith('memory_')) {
      return await this._handleMemoryTool(cleanToolName, args);
    } else if (cleanToolName.startsWith('mgmt_')) {
      return this._handleManagementTool(cleanToolName, args);
    } else if (cleanToolName.startsWith('mcp_')) {
      return await this._handleMCPToolCall(cleanToolName, args);
    } else if (cleanToolName.startsWith('workflow_')) {
      return await this._handleWorkflowTool(cleanToolName, args);
    } else if (cleanToolName.startsWith('file_')) {
      return await this._handleFileTool(cleanToolName, args);
    } else if (cleanToolName.startsWith('cmd_')) {
      return await this._handleCommandTool(cleanToolName, args);
    }

    // 兜底：尝试作为动态映射的技能处理
    if (this._skillService) {
      const skills = await this._skillService.list();
      const targetSkill = skills.find(s => s.name.replace(/-/g, '_') === cleanToolName);
      if (targetSkill) {
        console.log(`[CoreAgent] 动态路由技能工具: ${cleanToolName} -> ${targetSkill.name}`);
        const result = await this._skillService.run(targetSkill.name, args, this);

        // 自动脱壳：如果返回的是 {response: '...'} 或 {reply: '...'}，只取内容
        if (result && typeof result === 'object') {
          return result.response || result.reply || JSON.stringify(result);
        }
        return String(result);
      }
    }

    return `未知工具: ${cleanToolName}`;
  }

  /**
   * 处理记忆工具调用（异步，通过 MemoryService 的正式方法读写）
   */
  async _handleMemoryTool(toolName, args = {}) {
    if (!this._memoryService) return '记忆服务未配置';

    try {
      switch (toolName) {
        case 'memory_get_user_profile':
          return await this._memoryService.loadUserProfile();
        case 'memory_update_user_profile':
          await this._memoryService.updateUserProfile(args.content);
          return '已更新用户偏好';
        case 'memory_get_knowledge':
          return await this._memoryService.loadKnowledge();
        case 'memory_update_knowledge':
          await this._memoryService.updateKnowledge(args.content);
          return '已更新长期知识库';
        case 'memory_get_facts':
          return await this._memoryService.loadFacts();
        case 'memory_update_facts':
          await this._memoryService.updateFacts(args.content);
          return '已更新事实记录';
        case 'memory_get_context':
          return await this._memoryService.loadContext();
        case 'memory_update_context':
          await this._memoryService.updateContext(args.content);
          return '已更新对话背景';
        default:
          return `未知记忆工具: ${toolName}`;
      }
    } catch (e) {
      return `错误: ${e.message}`;
    }
  }

  /**
   * 处理工作流工具调用
   */
  async _handleWorkflowTool(toolName, args = {}) {
    if (!this._workflowService) return '工作流服务未配置';
    try {
      switch (toolName) {
        case 'workflow_list':
          const list = this._workflowService.list();
          return JSON.stringify(list, null, 2);
        case 'workflow_run':
          const runResult = await this._workflowService.run(args.id, args.context || {});
          return runResult.success
            ? `工作流 "${args.id}" 执行完成。`
            : `工作流 "${args.id}" 执行失败：${runResult.error}`;
        case 'workflow_get':
          return JSON.stringify(this._workflowService.get(args.id), null, 2);
        case 'workflow_save':
          const saveResult = await this._workflowService.save({
            id: args.id,
            name: args.name || args.id,
            steps: args.steps || [],
          });
          return `工作流 "${args.id}" 已保存到 ${saveResult.file}。`;
        case 'workflow_delete':
          await this._workflowService.delete(args.id);
          return `工作流 "${args.id}" 已从文件中删除。`;
        case 'workflow_reload':
          const reloadResult = await this._workflowService.reload();
          return `已重新加载，共 ${reloadResult.count} 个工作流。`;
        default:
          return `未知工作流工具: ${toolName}`;
      }
    } catch (e) {
      return `工作流工具错误: ${e.message}`;
    }
  }

  /**
   * 处理文件工具调用（沙箱化：强制限定在 workspace 目录内）
   */
  async _handleFileTool(toolName, args = {}) {
    // 动态导入 fs 模块（ESM 环境）
    const { promises: fs } = await import('fs');
    const path = await import('path');

    try {
      const workspaceDir = path.resolve(process.cwd(), this._workspace || './workspace');
      const rawPath = args.path || '.';
      // 如果传入相对路径，优先基于 workspace 目录解析
      const resolvedPath = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(workspaceDir, rawPath);

      const baseName = path.basename(resolvedPath).toLowerCase();

      // 1. 拦截敏感文件读取
      const isSensitive = baseName.startsWith('.env') ||
        baseName.endsWith('.key') ||
        baseName.endsWith('.pem') ||
        baseName.endsWith('.db') ||
        resolvedPath.includes('/.git/');

      if (isSensitive) {
        return '操作拒绝: 禁止访问系统核心配置文件或密钥凭据。';
      }

      // 2. 写操作安全沙箱（严禁写出 workspace 目录，保护核心源码和配置）
      const writeOps = ['file_write', 'file_append', 'file_delete', 'file_edit'];
      if (writeOps.includes(toolName)) {
        if (!resolvedPath.startsWith(workspaceDir)) {
          return `操作拒绝: 为保障安全，所有文件新建/修改/删除仅允许在工作目录 (${this._workspace || './workspace'}) 内进行。`;
        }
      }

      switch (toolName) {
        case 'file_read':
          const content = await fs.readFile(resolvedPath, 'utf8');
          return content;

        case 'file_write':
          await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
          await fs.writeFile(resolvedPath, args.content || '', 'utf8');
          return `已写入文件: ${path.relative(workspaceDir, resolvedPath)}`;

        case 'file_append':
          await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
          await fs.appendFile(resolvedPath, args.content || '', 'utf8');
          return `已追加到文件: ${path.relative(workspaceDir, resolvedPath)}`;

        case 'file_exists':
          try {
            await fs.access(resolvedPath);
            return 'true';
          } catch {
            return 'false';
          }

        case 'file_delete':
          await fs.unlink(resolvedPath);
          return `已删除文件: ${path.relative(workspaceDir, resolvedPath)}`;

        case 'file_list':
          const files = await fs.readdir(resolvedPath);
          return files.join('\n');

        case 'file_edit':
          return await this._editFile(fs, resolvedPath, args);

        default:
          return `未知文件工具: ${toolName}`;
      }
    } catch (e) {
      return `文件操作错误: ${e.message}`;
    }
  }

  /**
   * 编辑文件 - 支持行号插入/删除/替换、正则查找替换
   * @param {object} fs - fs.promises 对象
   * @param {string} filePath - 文件路径
   * @param {object} args - 编辑参数
   * @returns {string} 操作结果
   */
  async _editFile(fs, filePath, args) {
    try {
      // 读取原文件内容
      let content = '';
      try {
        content = await fs.readFile(filePath, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e; // 文件不存在则创建空内容
      }

      const lines = content.split('\n');

      // 1. 行号操作 (insert_line/replace_line/delete_line)
      if (args.insert_line !== undefined) {
        const lineNum = parseInt(args.insert_line);
        if (lineNum < 0 || lineNum > lines.length) {
          return `❌ 行号超出范围 (0-${lines.length})`;
        }
        lines.splice(lineNum, 0, args.content || '');
      }

      if (args.replace_line !== undefined) {
        const lineNum = parseInt(args.replace_line);
        if (lineNum < 0 || lineNum >= lines.length) {
          return `❌ 行号超出范围 (0-${lines.length - 1})`;
        }
        lines[lineNum] = args.content || '';
      }

      if (args.delete_line !== undefined) {
        const lineNum = parseInt(args.delete_line);
        if (lineNum < 0 || lineNum >= lines.length) {
          return `❌ 行号超出范围 (0-${lines.length - 1})`;
        }
        lines.splice(lineNum, 1);
      }

      // 2. 查找替换操作 (find/replace/all)
      if (args.find) {
        const findStr = args.find;
        const replaceStr = args.replace || '';
        const findAll = args.all === true;

        let replaced = false;
        if (args.regex) {
          // 正则表达式查找替换
          try {
            const regex = new RegExp(findStr, 'g'); // 默认全局匹配
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                lines[i] = lines[i].replace(regex, replaceStr);
                replaced = true;
                if (!findAll) break;
              }
            }
          } catch (e) {
            return `❌ 正则表达式错误: ${e.message}`;
          }
        } else {
          // 普通字符串查找替换
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(findStr)) {
              lines[i] = lines[i].replace(findStr, replaceStr);
              replaced = true;
              if (!findAll) break;
            }
          }
        }

        if (!replaced) {
          return `❌ 未找到匹配内容: "${findStr}"`;
        }
      }

      // 写入文件
      const newContent = lines.join('\n');
      await fs.writeFile(filePath, newContent, 'utf8');
      return `✅ 已编辑文件: ${filePath}`;

    } catch (e) {
      return `❌ 编辑文件失败: ${e.message}`;
    }
  }

  /**
   * 处理命令工具调用
   */
  async _handleCommandTool(toolName, args = {}) {
    // 动态导入 child_process 模块（ESM 环境）
    const { exec } = await import('child_process');
    const util = await import('util');
    const execAsync = util.promisify(exec);

    try {
      switch (toolName) {
        case 'cmd_exec':
          let finalCommand = args.command;

          // 只对 browser-use open 子命令注入 --headed（有头模式）
          // 其他子命令（state/eval/click/cookies 等）不注入，避免脱离已有 daemon
          if (finalCommand.startsWith('browser-use ')) {
            const isOpenCmd = /^browser-use\s+(--\S+\s+)*open(\s|$)/.test(finalCommand);
            if (isOpenCmd && !finalCommand.includes('--headed') &&
              process.env.BROWSER_USE_HEADLESS === 'false') {
              // 先关闭可能残留的 headless daemon，确保新 daemon 以 headed 模式启动
              finalCommand = `browser-use close >/dev/null 2>&1; ` +
                finalCommand.replace('browser-use ', 'browser-use --headed ');
            }
          }

          console.log(`[CoreAgent] cmd_exec 实际执行: ${finalCommand.substring(0, 120)}`);

          // 超时策略：自动识别耐时命令类型
          let defaultTimeout = 30000;
          if (args.timeout_ms) {
            // AI 显式指定，优先级最高
            defaultTimeout = args.timeout_ms;
          } else if (/python3?\s/i.test(finalCommand)) {
            // Python 脚本默认 2 分钟（简单脚本），生图/浏览器类超 10 分钟自动详记
            const isLongRunning = /gemini_image|gemini_canvas|browser|playwright|selenium/i.test(finalCommand);
            defaultTimeout = isLongRunning ? 600000 : 120000;
            console.log(`[CoreAgent] 跑测 ${isLongRunning ? '耐时' : '普通'} Python 脚本，超时设为 ${defaultTimeout / 1000}s`);
          }

          const { stdout, stderr } = await execAsync(finalCommand, {
            cwd: args.cwd || process.cwd(),
            env: { ...process.env, ...args.env },
            timeout: defaultTimeout,
            maxBuffer: 10 * 1024 * 1024 // 10MB
          });
          return stdout || stderr || '(无输出)';

        default:
          return `未知命令工具: ${toolName}`;
      }
    } catch (e) {
      return `命令执行错误: ${e.message}`;
    }
  }
  /**
   * 处理管理工具调用
   */
  _handleManagementTool(toolName, args = {}) {
    switch (toolName) {
      case 'mgmt_cron_list':
        if (!this._scheduler) return '调度器未配置';
        const tasks = this._scheduler.listTasks() || [];
        if (!tasks.length) return '无定时任务';
        return tasks.map(t => `[${t.id}] ${t.name} (${t.cron})`).join('\n');

      case 'mgmt_cron_add':
        if (!this._scheduler) return '调度器未配置';
        const taskConfig = {
          id: args.task_id,
          name: args.name,
          cron: args.cron,
          prompt: args.description,
          enabled: true,
        };
        this._scheduler.register(args.task_id, args.cron, async () => {
          if (this._onCronTaskExecute) {
            await this._onCronTaskExecute(args.description, taskConfig);
          } else {
            console.warn(`[CoreAgent] Cron task ${args.task_id} fired but no executor set`);
          }
        }, { name: args.name, prompt: args.description });
        if (this._onCronTasksChanged) {
          this._onCronTasksChanged();
        }
        return `已添加定时任务: ${args.task_id}`;

      case 'mgmt_cron_remove':
        if (!this._scheduler) return '调度器未配置';
        this._scheduler.unregister(args.task_id);
        if (this._onCronTasksChanged) {
          this._onCronTasksChanged();
        }
        return `已删除定时任务: ${args.task_id}`;

      case 'mgmt_cron_toggle':
        if (!this._scheduler) return '调度器未配置';
        let toggleResult = '';
        if (args.enabled) {
          const ok = this._scheduler.enable(args.task_id);
          toggleResult = ok ? `已启用任务: ${args.task_id}` : `任务 ${args.task_id} 不存在，无法启用`;
        } else {
          const ok = this._scheduler.disable(args.task_id);
          toggleResult = ok ? `已禁用任务: ${args.task_id}` : `任务 ${args.task_id} 不存在，无法禁用`;
        }
        if (this._onCronTasksChanged) {
          this._onCronTasksChanged();
        }
        return toggleResult;

      case 'mgmt_heartbeat_get':
        if (!this._heartbeat) return '心跳未配置';
        return this._heartbeat.getTaskContent() || '';

      case 'mgmt_heartbeat_set':
        if (!this._heartbeat) return '心跳未配置';
        this._heartbeat.setTaskContent(args.content);
        return '已更新心跳任务';

      default:
        return `未知管理工具: ${toolName}`;
    }
  }

  /**
   * 处理 MCP 工具调用 — 通过 MCPorterService 执行
   * @param {string} toolPrefix - 如 "mcp_context7_resolve-library-id"
   * @param {object} args - 工具参数
   * @returns {string} 工具结果
   */
  async _handleMCPToolCall(toolPrefix, args = {}) {
    const mapping = this._mcpToolMap[toolPrefix];
    if (!mapping) {
      return `MCP 工具未注册: ${toolPrefix}`;
    }

    if (!this._mcpService) {
      return 'MCP 服务未配置';
    }

    try {
      const result = await this._mcpService.callTool(toolPrefix, args);
      console.log(`[CoreAgent] MCP: ${toolPrefix} → ${String(result).substring(0, 80)}`);
      return result;
    } catch (e) {
      return `MCP 工具调用失败: ${e.message}`;
    }
  }

  /**
   * 截断历史消息，保留完整的 tool_call ↔ tool_result 配对
   * @param {Array} history - 原始历史
   * @param {number} maxLen - 最大保留条数
   * @returns {Array} 截断后的历史
   */
  _trimHistory(history, maxLen) {
    if (history.length <= maxLen) return history;

    let trimmed = history.slice(history.length - maxLen);

    // ── 新增：总字符数限制，防止上下文过长 ──
    const MAX_TOTAL_CHARS = 60000;
    let currentTotal = trimmed.reduce((sum, msg) => sum + (msg.content?.length || 0), 0);

    while (currentTotal > MAX_TOTAL_CHARS && trimmed.length > 2) {
      const removed = trimmed.shift(); // 移除最旧的消息
      currentTotal -= (removed.content?.length || 0);
    }

    // 检查开头是否有孤立的 tool_result（对应的 tool_call 被截掉了）
    const orphanStart = trimmed.findIndex(
      (msg, idx) => msg.role === 'tool' && idx === 0
    );
    if (orphanStart !== -1 && orphanStart === 0) {
      // 跳过所有连续的 orphan tool_result
      let skip = 0;
      while (skip < trimmed.length && trimmed[skip].role === 'tool') {
        skip++;
      }
      trimmed = trimmed.slice(skip);
    }

    // 同样检查开头是否有 tool_calls 但缺少后续 tool_result 的 assistant 消息
    while (trimmed.length > 0) {
      const first = trimmed[0];
      if (first.role === 'assistant' && first.tool_calls && first.tool_calls.length > 0) {
        // 检查紧跟的消息是否是对应第一个 tool_call 的 tool_result
        if (trimmed.length > 1 && trimmed[1].role === 'tool') {
          break; // 配对完整，保留
        }
        // 缺少 tool_result，移除这条 assistant 消息
        trimmed = trimmed.slice(1);
      } else {
        break;
      }
    }

    return trimmed;
  }

  _normalizeMessages(history) {
    const result = [];
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];

      // 检查助手消息是否包含工具调用
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const callIds = msg.tool_calls.map(tc => tc.id);
        const toolMsgs = [];
        let j = i + 1;

        // 查找紧随其后的所有工具响应消息
        while (j < history.length && (history[j].role === 'tool' || history[j].tool_call_id)) {
          if (callIds.includes(history[j].tool_call_id)) {
            toolMsgs.push(history[j]);
          }
          j++;
        }

        // 只有当所有工具调用都有对应的响应时，才保留这一段
        if (toolMsgs.length === callIds.length) {
          result.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.tool_calls,
          });
          for (const tm of toolMsgs) {
            result.push({
              role: 'tool',
              tool_call_id: tm.tool_call_id,
              content: tm.content,
            });
          }
          i = j - 1; // 跳过已处理的消息
        } else {
          console.warn(`[CoreAgent] 检测到不完整的工具调用序列（索引 ${i}），已跳过以防止 API 错误。`);
          // 跳过该助手消息及后续不完整的工具消息
          i = j - 1;
        }
      } else if (msg.role === 'tool' || msg.tool_call_id) {
        // 孤立的工具消息，跳过
        console.warn(`[CoreAgent] 检测到孤立的工具响应消息（索引 ${i}），已跳过。`);
      } else {
        // 普通用户/助手消息
        result.push({
          role: msg.role,
          content: msg.content || '',
        });
      }
    }
    return result;
  }

  /**
   * 清理原始历史记录中的不完整工具调用序列（用于持久化存储前的净化）
   * 与 _normalizeMessages 不同，保留所有字段（如 reasoning_content）
   */
  _cleanHistory(history) {
    const result = [];
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const callIds = msg.tool_calls.map(tc => tc.id);
        let j = i + 1;
        const toolMsgs = [];
        while (j < history.length && (history[j].role === 'tool' || history[j].tool_call_id)) {
          if (callIds.includes(history[j].tool_call_id)) toolMsgs.push(history[j]);
          j++;
        }
        if (toolMsgs.length === callIds.length) {
          result.push(msg);
          for (const tm of toolMsgs) result.push(tm);
        } else {
          console.warn(`[CoreAgent] _cleanHistory: 跳过不完整工具调用（索引 ${i}，期望 ${callIds.length} 个响应，实际 ${toolMsgs.length} 个）`);
        }
        i = j - 1;
      } else if (msg.role === 'tool' || msg.tool_call_id) {
        // 孤立的 tool 消息，跳过
        console.warn(`[CoreAgent] _cleanHistory: 跳过孤立工具响应（索引 ${i}）`);
      } else {
        result.push(msg);
      }
    }
    return result;
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
   * 核心对话方法
   * @param {string} prompt - 用户消息
   * @param {object} options - 可选参数
   * @returns {object} AI 响应
   */
  async decide(prompt, options = {}) {
    const sessionId = options.sessionId || 'default';

    // ── 指令拦截 ──
    const trimmed = prompt.trim();
    if (trimmed === '/new' || trimmed === '/新会话') {
      const result = await this.newSession(sessionId);
      return { ...result, command: 'new' };
    }
    if (trimmed === '/compress' || trimmed === '/压缩') {
      const result = await this.compressSession(sessionId);
      return { ...result, command: 'compress' };
    }
    if (trimmed === '/context' || trimmed === '/上下文') {
      const result = await this.getSessionContext(sessionId, options);
      return { ...result, command: 'context' };
    }

    // 轮询选择当前主模型（提前初始化，保证在此轮的任何步骤包括自动压缩都能使用到最新的 client/model）
    if (this.primaryConfigs && this.primaryConfigs.length > 0) {
      const pConfig = this.primaryConfigs[this.currentPrimaryIndex];
      this.currentPrimaryIndex = (this.currentPrimaryIndex + 1) % this.primaryConfigs.length;

      this.model = pConfig.model;
      this.thinking = pConfig.thinking || false;
      this.stream = pConfig.stream || false;

      this.client = new OpenAI({
        baseURL: pConfig.baseUrl,
        apiKey: pConfig.apiKey,
        timeout: 60000,
        defaultHeaders: { 'User-Agent': 'curl/8.7.1' },
      });
      console.log(`[CoreAgent] Round-robin selected primary model: ${this.model}`);
    }

    if (!this._sessions[sessionId]) {
      this._sessions[sessionId] = await this._loadSession(sessionId);
    }

    // 使用副本进行操作，防止执行中途出错导致内存中的会话历史被破坏
    const historyCopy = [...this._sessions[sessionId]];
    historyCopy.push({ role: 'user', content: prompt });

    const maxLen = this.maxContextTurns * 2;
    // _cleanHistory 先净化历史（去除磁盘上遗留的不完整 tool_call 序列），再裁剪长度
    const cleanedHistory = this._cleanHistory(this._trimHistory(historyCopy, maxLen));
    let workingHistory = cleanedHistory;

    // 自动会话压缩：如果历史会话条数超过 5 条，仅压缩3条之前的旧消息，最新3条原样保留
    if (workingHistory.length > 20) {
      const olderMessages = workingHistory.slice(0, workingHistory.length - 3);
      const latestFive = workingHistory.slice(-3);

      console.log(`[CoreAgent] workingHistory.length 为 ${workingHistory.length} (> 3)，自动压缩前 ${olderMessages.length} 条旧消息，保留最新 3 条...`);

      // 将旧消息格式化为文本供 LLM 总结
      const historyText = olderMessages.map(msg => {
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

      try {
        const summaryResp = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: '你是一个对话摘要助手，擅长提炼关键信息。' },
            { role: 'user', content: `请将以下对话历史压缩为一段简洁的摘要，保留关键信息、决策和结果，去除冗余细节。用中文输出，不超过200字。\n\n${historyText}` },
          ],
          temperature: 0.3,
          max_tokens: 300,
        });

        const summary = summaryResp.choices[0].message.content || '（历史摘要生成失败）';
        const summaryMsg = { role: 'system', content: `以下是之前对话的摘要：\n${summary}` };

        // 重新拼接：[摘要] + [最新5条]
        workingHistory = [summaryMsg, ...latestFive];
        console.log(`[CoreAgent] 自动压缩完成：${olderMessages.length} 条旧消息 → 摘要，保留最新 5 条，workingHistory.length = ${workingHistory.length}`);
      } catch (compressErr) {
        console.error(`[CoreAgent] 自动压缩失败: ${compressErr.message}，跳过压缩继续执行`);
        // 压缩失败时保持原 workingHistory 不变，不影响本轮正常运行
      }
    }

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

    for (let i = 0; i < this.maxToolIterations; i++) {
      const requestOptions = {
        model: this.model,
        messages: messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: 0.7,
        max_tokens: 4096, // 显式设置最大输出，防止某些 API 在输入过长时自动计算产生负值
      };

      // 思考模式：构建 reasoning 参数
      if (this.thinking) {
        requestOptions.temperature = 1; // 思考模式要求 temperature=1
        // OpenAI extended thinking: 通过 reasoning_effort 参数
        if (options.reasoningEffort) {
          requestOptions.reasoning_effort = options.reasoningEffort;
        }
      }

      // 根据是否流式选择不同的调用方式
      const onChunk = options.onChunk || null;
      const onStream = options.onStream || null;
      const isStream = options.stream !== undefined ? options.stream : this.stream;

      if (isStream) {
        requestOptions.stream = true;
      }

      let choice;
      try {
        choice = isStream
          ? await this._handleStreamRequest(requestOptions, onChunk, onStream)
          : await this._handleNormalRequest(requestOptions);

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
          console.warn(`[CoreAgent] Primary model (${this.model}) failed: ${error.message}. Trying fallbacks.`);

          let success = false;
          let lastError = error;

          for (const fbConfig of this.fallbackConfigs) {
            try {
              console.log(`[CoreAgent] Switching to fallback model: ${fbConfig.model}`);
              this.model = fbConfig.model;
              this.thinking = fbConfig.thinking || false;
              this.stream = fbConfig.stream || false;

              this.client = new OpenAI({
                baseURL: fbConfig.baseUrl,
                apiKey: fbConfig.apiKey,
                timeout: 60000,
                defaultHeaders: {
                  'User-Agent': 'curl/8.7.1',
                },
              });

              requestOptions.model = this.model;
              requestOptions.temperature = this.thinking ? 1 : 0.7;

              const isFallbackStream = options.stream !== undefined ? options.stream : this.stream;
              requestOptions.stream = isFallbackStream;

              console.log(`[CoreAgent] Retrying with fallback model: ${this.model}`);
              choice = isFallbackStream
                ? await this._handleStreamRequest(requestOptions, onChunk, onStream)
                : await this._handleNormalRequest(requestOptions);

              if (!isFallbackStream && onStream) {
                if (choice.reasoning_content) {
                  onStream({ type: 'reasoning', content: choice.reasoning_content });
                }
                if (choice.content) {
                  onStream({ type: 'content', content: choice.content });
                }
              }

              console.log(`[CoreAgent] Fallback to ${this.model} successful. Keeping fallback model for remaining steps.`);
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

      const msgToStore = {
        role: choice.role,
        content: choice.content,
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

      workingHistory.push(msgToStore);
      messages.push(msgToStore);

      // 思考模式：输出 reasoning 日志
      if (choice.reasoning_content) {
        console.log(`[CoreAgent] Thinking: ${choice.reasoning_content.substring(0, 200)}...`);
      }

      if (msgToStore.tool_calls && msgToStore.tool_calls.length > 0) {
        for (const tc of msgToStore.tool_calls) {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch (e) {
            console.warn(`[CoreAgent] 工具参数解析失败: ${tc.function.name}, raw: ${tc.function.arguments}`);
          }

          if (onStream) {
            let parsedArgs = args;
            try { parsedArgs = JSON.parse(tc.function.arguments); } catch { parsedArgs = args; }
            onStream({
              type: 'tool_start',
              id: tc.id,
              name: tc.function.name,
              arguments: parsedArgs
            });
          }

          // 规范化参数的空白符，确保比对键稳定性
          const callKey = `${tc.function.name}:${tc.function.arguments.replace(/\s+/g, '')}`;
          let displayResult;

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
      } else {
        finalResponse = msgToStore.content || '';
        break;
      }
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
  async _handleNormalRequest(requestOptions) {
    const response = await this.client.chat.completions.create(requestOptions);
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
  async _handleStreamRequest(requestOptions, onChunk, onStream) {
    const stream = await this.client.chat.completions.create(requestOptions);

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
      return JSON.parse(output);
    } catch {
      return { response: output };
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
   * 压缩会话 — 用 LLM 将历史对话总结为摘要，替换原历史
   * @param {string} sessionId - 会话 ID
   * @returns {object} { response }
   */
  async compressSession(sessionId = 'default') {
    if (!this._sessions[sessionId]) {
      this._sessions[sessionId] = await this._loadSession(sessionId);
    }

    const history = this._sessions[sessionId];
    if (history.length <= 2) {
      return { response: '📝 会话很短，无需压缩。' };
    }

    // 将历史消息格式化为文本供 LLM 总结
    const historyText = history
      .map(msg => {
        const roleLabel = msg.role === 'user' ? '用户' :
          msg.role === 'assistant' ? 'AI' :
            msg.role === 'tool' ? '工具结果' :
              msg.role === 'system' ? '系统' : msg.role;
        let text = `[${roleLabel}]: ${msg.content || ''}`;
        if (msg.tool_calls) {
          text += ` (调用了工具: ${msg.tool_calls.map(tc => tc.function?.name).join(', ')})`;
        }
        return text;
      })
      .join('\n');

    // 调用 LLM 生成摘要
    const compressPrompt = `请将以下对话历史压缩为一段简洁的摘要，保留关键信息、决策和结果，去除冗余细节。用中文输出，不超过200字。\n\n${historyText}`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: '你是一个对话摘要助手，擅长提炼关键信息。' },
          { role: 'user', content: compressPrompt },
        ],
        temperature: 0.3,
        max_tokens: 300,
      });

      const summary = response.choices[0].message.content || '压缩失败';

      // 用摘要替换原历史
      this._sessions[sessionId] = [
        { role: 'system', content: `以下是之前对话的摘要：\n${summary}` },
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