import { sanitizeToolName, dedupeToolName } from '../toolname.js';

/**
 * 工具 Schema 注册表
 * 从 CoreAgent 拆分而来，专职生成 OpenAI function-calling 格式的工具定义。
 *
 * @param {object} ctx - CoreAgent 实例（读取其注入的服务与 MCP 工具）
 * @param {Function|null} filter - 可选过滤器
 * @returns {Promise<Array>} 工具定义数组
 */
export async function getAllTools(ctx, filter = null) {
    let tools = [];

    if (ctx._memoryService) {
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

    if (ctx._scheduler) {
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

    if (ctx._heartbeat) {
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
    if (ctx._skillService) {
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
        const skillList = await ctx._skillService.list();
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
              // 使用统一的清洗器（与 mcporter / 最终防御同一实现）
              name: sanitizeToolName(skill.name),
              description: `[Skill] ${skill.description || skill.name}`,
              parameters: skillParameters,
            },
          });
        }
      } catch (e) {
        console.error(`[CoreAgent] 获取技能列表失败: ${e.message}`);
      }
    }

    // MCP 工具
    if (ctx._mcpTools.length > 0) {
      tools.push(...ctx._mcpTools);
    }

    // 应用过滤器
    if (typeof filter === 'function') {
      tools = tools.filter(filter);
    }

    // 最终防御：确保所有工具名都符合 API 要求 (^[a-zA-Z0-9_-]{1,64}$)，且互不重名
    // 正常情况下名称在注册阶段就已清洗过（mcporter / 技能），此处为幂等校验
    const takenNames = new Set();
    tools = tools.map(t => {
      if (!t?.function?.name) return t;
      const cleanedName = sanitizeToolName(t.function.name);
      if (cleanedName !== t.function.name) {
        console.warn(`[CoreAgent] 工具名含非法字符已自动清理: "${t.function.name}" → "${cleanedName}"`);
      }
      // 清洗后可能与其他工具重名，需去重，否则 API 会拒绝整个请求
      const finalName = dedupeToolName(takenNames, cleanedName);
      if (finalName !== cleanedName) {
        console.warn(`[CoreAgent] 检测到清洗后重名工具: "${cleanedName}" → "${finalName}"`);
      }
      return {
        ...t,
        function: { ...t.function, name: finalName },
      };
    });

    return tools;
}

export default getAllTools;
