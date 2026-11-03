import path from 'path';
import { FileAccessPolicy } from '../pathguard.js';
import { sanitizeToolName } from '../toolname.js';
import { isValidCron, cronValidationError } from '../cron-utils.js';

/**
 * 工具分发与执行
 *
 * 从 CoreAgent 拆分而来。核心约定：
 *   任何单个工具的失败都必须降级为「返回给模型的错误文本」，不得向上冒泡，
 *   否则本轮已成功执行的其他工具结果会一并丢失（见 CoreAgent.decide 的兜底处理）。
 */

  /**
   * 处理工具调用（异步）
   */
export async function handleToolCall(ctx, toolName, args = {}) {
    // 过滤掉可能由某些模型输出附加的特殊标记后缀 (如 <|channel|>commentary)
    // 另外模型偶尔会把 name 输出成对象，这里统一转成字符串，
    // 否则下面的 startsWith 会抛 TypeError，工具调用直接失败
    const rawName = typeof toolName === 'string' ? toolName : String(toolName ?? '');
    const cleanToolName = rawName.replace(/<\|.*$/, '').trim();

    // ⚠️ 各处理器签名均为 (ctx, toolName, args)，ctx 必须透传：
    // 漏掉会让 toolName 收到 ctx 对象（表现为「未知管理工具: [object Object]」），
    // 且处理器内部的 ctx._memoryService / _scheduler 全部取不到。
    if (cleanToolName.startsWith('memory_')) {
      return await handleMemoryTool(ctx, cleanToolName, args);
    } else if (cleanToolName.startsWith('mgmt_')) {
      return await handleManagementTool(ctx, cleanToolName, args);
    } else if (cleanToolName.startsWith('mcp_')) {
      return await handleMCPToolCall(ctx, cleanToolName, args);
    } else if (cleanToolName.startsWith('file_')) {
      return await handleFileTool(ctx, cleanToolName, args);
    } else if (cleanToolName.startsWith('cmd_')) {
      return await handleCommandTool(ctx, cleanToolName, args);
    }

    // 兜底：尝试作为动态映射的技能处理
    if (ctx._skillService) {
      const skills = await ctx._skillService.list();
      // 与 _getAllTools 中的技能注册使用同一清洗器，保证名称能对上
      const targetSkill = skills.find(s => sanitizeToolName(s.name) === cleanToolName);
      if (targetSkill) {
        console.log(`[CoreAgent] 动态路由技能工具: ${cleanToolName} -> ${targetSkill.name}`);
        // 第三个参数是 agent，之前传的 this 在模块函数里是 undefined，
        // 技能内部调用 agent.decide() 会直接抛「Cannot read properties of undefined」
        const result = await ctx._skillService.run(targetSkill.name, args, ctx);

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
// 记忆文件级写队列：多个回合（cron 任务/心跳/用户对话）同时更新同一记忆文件时
// 串行化「读-改-写」，避免后写覆盖先写（键：记忆文件类别）
const memoryWriteQueues = new Map();
const withMemoryLock = (key, fn) => {
  const prev = memoryWriteQueues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  memoryWriteQueues.set(key, next);
  return next;
};

export async function handleMemoryTool(ctx, toolName, args = {}) {
    if (!ctx._memoryService) return '记忆服务未配置';

    try {
      switch (toolName) {
        case 'memory_get_user_profile':
          return await ctx._memoryService.loadUserProfile();
        case 'memory_update_user_profile':
          await withMemoryLock('user_profile', () => ctx._memoryService.updateUserProfile(args.content));
          return '已更新用户偏好';
        case 'memory_get_knowledge':
          return await ctx._memoryService.loadKnowledge();
        case 'memory_update_knowledge':
          await withMemoryLock('knowledge', () => ctx._memoryService.updateKnowledge(args.content));
          return '已更新长期知识库';
        case 'memory_get_facts':
          return await ctx._memoryService.loadFacts();
        case 'memory_update_facts':
          await withMemoryLock('facts', () => ctx._memoryService.updateFacts(args.content));
          return '已更新事实记录';
        case 'memory_get_context':
          return await ctx._memoryService.loadContext();
        case 'memory_update_context':
          await withMemoryLock('context', () => ctx._memoryService.updateContext(args.content));
          return '已更新对话背景';
        default:
          return `未知记忆工具: ${toolName}`;
      }
    } catch (e) {
      return `错误: ${e.message}`;
    }
  }

  /**
   * 获取文件访问策略
   * 延迟构建：_workspace 由 setWorkspace() 注入，可能晚于构造函数执行。
   * @returns {FileAccessPolicy}
   */
export function getFilePolicy(ctx) {
    if (!ctx._filePolicy || ctx._filePolicy.workspaceDir !== ctx._policyWorkspace) {
      const workspaceDir = ctx._workspace || path.resolve(process.cwd(), './workspace');
      ctx._policyWorkspace = workspaceDir;
      ctx._filePolicy = new FileAccessPolicy({
        workspaceDir,
        readRoots: ctx._fileReadRoots || [],
      });
    }
    return ctx._filePolicy;
  }

  /**
   * 处理文件工具调用
   *
   * 安全模型（已统一至 src/services/pathguard.js）：
   *   - 写操作：仅限 workspace 目录
   *   - 读操作：workspace 内全部允许；~/.miot-mcp 等目录仅允许读取媒体文件；
   *     其余一律拒绝，并在错误中回传可读根目录，便于模型自助纠正。
   */
export async function handleFileTool(ctx, toolName, args = {}) {
    // 动态导入 fs 模块（ESM 环境）
    const { promises: fs } = await import('fs');
    const path = await import('path');

    try {
      const policy = getFilePolicy(ctx);
      const rawPath = args.path || '.';

      // 写操作集合（严禁写出 workspace 目录，保护核心源码和配置）
      const writeOps = ['file_write', 'file_append', 'file_delete', 'file_edit'];
      const verdict = writeOps.includes(toolName)
        ? policy.allowWrite(rawPath)
        : policy.allowRead(rawPath);

      if (!verdict.ok) return verdict.reason;

      const resolvedPath = verdict.resolvedPath;
      const workspaceDir = policy.workspaceDir;

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
          return await editFile(fs, resolvedPath, args);

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
export async function editFile(fs, filePath, args) {
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
export async function handleCommandTool(ctx, toolName, args = {}) {
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
   *
   * 改为 async：任务变更回调（_onCronTasksChanged → saveCronTasks）是异步落盘，
   * 不 await 会在进程退出或下一回合重写时丢掉这次变更。
   * 异常统一降级为返回文本，避免向上冒泡丢掉本轮其余工具结果。
   */
export async function handleManagementTool(ctx, toolName, args = {}) {
    try {
      switch (toolName) {
        case 'mgmt_cron_list': {
          if (!ctx._scheduler) return '调度器未配置';
          const tasks = ctx._scheduler.listTasks() || [];
          if (!tasks.length) return '无定时任务';
          return tasks.map(t => `[${t.id}] ${t.name} (${t.cron})`).join('\n');
        }

        case 'mgmt_cron_add': {
          if (!ctx._scheduler) return '调度器未配置';

          const taskId = String(args.task_id ?? '').trim();
          const cronExpr = String(args.cron ?? '').trim();
          if (!taskId) return '缺少 task_id，无法创建定时任务';
          // 与前端 webui/src/lib/cron.js 同口径：只接受 5 段，
          // 拒绝 node-cron v4 的 6 段（带秒）写法，否则前端保存会报错、任务还会按秒跑
          if (!isValidCron(cronExpr)) return cronValidationError(cronExpr);

          // 覆盖同名任务要显式告知，否则模型以为「新建成功」，
          // 而用户视角是原任务被静默替换
          const overwritten = typeof ctx._scheduler.has === 'function'
            && ctx._scheduler.has(taskId);

          const taskConfig = {
            id: taskId,
            name: args.name,
            cron: cronExpr,
            prompt: args.description,
            enabled: true,
          };
          ctx._scheduler.register(taskId, cronExpr, async () => {
            if (ctx._onCronTaskExecute) {
              await ctx._onCronTaskExecute(args.description, taskConfig);
            } else {
              console.warn(`[CoreAgent] Cron task ${taskId} fired but no executor set`);
            }
          }, { name: args.name, prompt: args.description });

          if (ctx._onCronTasksChanged) {
            await ctx._onCronTasksChanged();
          }
          return overwritten
            ? `已覆盖同名定时任务: ${taskId}（${cronExpr}，原配置已被替换）`
            : `已添加定时任务: ${taskId}（${cronExpr}）`;
        }

        case 'mgmt_cron_remove': {
          if (!ctx._scheduler) return '调度器未配置';
          ctx._scheduler.unregister(args.task_id);
          if (ctx._onCronTasksChanged) {
            await ctx._onCronTasksChanged();
          }
          return `已删除定时任务: ${args.task_id}`;
        }

        case 'mgmt_cron_toggle': {
          if (!ctx._scheduler) return '调度器未配置';
          let toggleResult = '';
          if (args.enabled) {
            const ok = ctx._scheduler.enable(args.task_id);
            toggleResult = ok ? `已启用任务: ${args.task_id}` : `任务 ${args.task_id} 不存在，无法启用`;
          } else {
            const ok = ctx._scheduler.disable(args.task_id);
            toggleResult = ok ? `已禁用任务: ${args.task_id}` : `任务 ${args.task_id} 不存在，无法禁用`;
          }
          if (ctx._onCronTasksChanged) {
            await ctx._onCronTasksChanged();
          }
          return toggleResult;
        }

        case 'mgmt_heartbeat_get': {
          if (!ctx._heartbeat) return '心跳未配置';
          // 只回动态内容时模型无法「先查后改」静态检查项，
          // 这里给出完整配置摘要，便于它判断要新增还是覆盖
          return JSON.stringify({
            enabled: ctx._heartbeat.enabled !== false,
            interval: ctx._heartbeat.interval || '',
            dynamic_prompt: ctx._heartbeat.getTaskContent() || '',
            checks: (ctx._heartbeat.checks || []).map((c) => ({
              name: c.name,
              enabled: c.enabled !== false,
              interval: c.interval || '',
              weekend: c.weekend || 'any',
              holiday: c.holiday || 'any',
              prompt: c.prompt,
            })),
          }, null, 2);
        }

        case 'mgmt_heartbeat_set':
          if (!ctx._heartbeat) return '心跳未配置';
          ctx._heartbeat.setTaskContent(args.content);
          return '已更新心跳任务';

        case 'mgmt_heartbeat_update': {
          if (!ctx._heartbeat) return '心跳未配置';
          if (typeof ctx._heartbeat.applyToolPatch !== 'function') {
            return '当前心跳实现不支持结构化更新（仅支持 mgmt_heartbeat_set）';
          }
          const changes = await ctx._heartbeat.applyToolPatch(args);
          return changes.length > 0
            ? `已更新心跳配置：${changes.join('；')}`
            : '未做任何修改（请提供 enabled / interval / dynamic_prompt / check / remove_check 之一）';
        }

        default:
          return `未知管理工具: ${toolName}`;
      }
    } catch (e) {
      return `管理工具执行错误: ${e.message}`;
    }
  }

  /**
   * 处理 MCP 工具调用 — 通过 MCPorterService 执行
   * @param {string} toolPrefix - 如 "mcp_context7_resolve-library-id"
   * @param {object} args - 工具参数
   * @returns {string} 工具结果
   */
export async function handleMCPToolCall(ctx, toolPrefix, args = {}) {
    const mapping = ctx._mcpToolMap[toolPrefix];
    if (!mapping) {
      return `MCP 工具未注册: ${toolPrefix}`;
    }

    if (!ctx._mcpService) {
      return 'MCP 服务未配置';
    }

    try {
      const result = await ctx._mcpService.callTool(toolPrefix, args);
      console.log(`[CoreAgent] MCP: ${toolPrefix} → ${String(result).substring(0, 80)}`);
      return result;
    } catch (e) {
      return `MCP 工具调用失败: ${e.message}`;
    }
  }
