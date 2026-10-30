/**
 * 会话历史清洗
 *
 * 从 CoreAgent 拆分而来。这三个函数是纯函数（无实例状态、无 IO），
 * 因此可脱离 Agent 独立单元测试 —— 它们正是全项目最容易出错的部分：
 * tool_call 与 tool_result 必须严格配对，否则 OpenAI API 会直接报错。
 */

  /**
   * 截断历史消息，保留完整的 tool_call ↔ tool_result 配对
   * @param {Array} history - 原始历史
   * @param {number} maxLen - 最大保留条数
   * @returns {Array} 截断后的历史
   */
export function trimHistory(history, maxLen) {
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
    // 必须按「全部 callId 都有响应」判断：只看 trimmed[1] 时，
    // 多工具调用被截断一半也会被误判为完整，随后被 cleanHistory/normalizeMessages 整段丢弃
    while (trimmed.length > 0) {
      const first = trimmed[0];
      if (first.role === 'assistant' && first.tool_calls && first.tool_calls.length > 0) {
        const callIds = first.tool_calls.map(tc => tc.id);
        const answered = new Set(
          trimmed.slice(1).filter(m => m.role === 'tool').map(m => m.tool_call_id)
        );
        if (callIds.every(id => answered.has(id))) {
          break; // 配对完整，保留
        }
        // 缺少 tool_result，移除这条 assistant 消息
        trimmed = trimmed.slice(1);
      } else {
        break;
      }
    }

    // 移除残缺 assistant 后可能又露出孤立的 tool 结果，再清一次，
    // 保证 trimHistory 的输出与 cleanHistory 的判定口径一致
    while (trimmed.length > 0 && trimmed[0].role === 'tool') {
      trimmed = trimmed.slice(1);
    }

    return trimmed;
  }

export function normalizeMessages(history) {
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
export function cleanHistory(history) {
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
