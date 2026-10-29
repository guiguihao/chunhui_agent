/**
 * 工具名规范化（单一真相来源）
 *
 * 背景：工具名在不同环节被各自转换，导致「LLM 看到的名字」与「toolMap 的键」不一致：
 *   - plugin/mcporter.js         mcp_${serverName}_${tool.name}（未清洗）
 *   - src/services/coreagent.js  skill.name.replace(/-/g,'_')...（另写一份）
 *   - src/services/coreagent.js  发给 API 前才统一清洗第三份
 * 结果：若 MCP 工具名含 . : / @ 等字符，LLM 拿到清洗后的名字，
 *       toolMap 里存的却是未清洗的名字 → 永远返回「MCP 工具未注册」。
 *
 * 约定：清洗必须在「注册阶段」完成，保证 toolMap 的键 === LLM 看到的名字 === 查表用的名字。
 */

/** OpenAI function name 约束：^[a-zA-Z0-9_-]{1,64}$ */
const MAX_NAME_LENGTH = 64;

/**
 * 将任意工具名清洗为符合 API 约束的合法名称
 *
 * @param {string} name - 原始工具名
 * @returns {string} 清洗后的名称（必为非空合法名）
 */
export function sanitizeToolName(name) {
  if (!name || typeof name !== 'string') return 'tool';

  let cleaned = name
    .replace(/[^a-zA-Z0-9_-]/g, '_') // 替换非法字符为下划线
    .replace(/__+/g, '_')            // 合并连续下划线
    .replace(/^_+|_+$/g, '');        // 移除首尾下划线

  // 超长截断后需要再次清理尾部可能出现的下划线
  if (cleaned.length > MAX_NAME_LENGTH) {
    cleaned = cleaned.slice(0, MAX_NAME_LENGTH).replace(/_+$/, '');
  }

  return cleaned || 'tool';
}

/**
 * 在已占用的名称集合中为 name 分配一个唯一名称
 * 用于避免多个工具清洗后重名被 API 拒绝（duplicate工具名）
 *
 * @param {Set<string>} taken - 已占用的名称集合（函数会就地写入新分配的名称）
 * @param {string} name - 已清洗的名称
 * @returns {string} 唯一名称
 */
export function dedupeToolName(taken, name) {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  let n = 2;
  let candidate = `${name}_${n}`;
  while (taken.has(candidate)) {
    n++;
    candidate = `${name}_${n}`;
  }
  taken.add(candidate);
  return candidate;
}

export default sanitizeToolName;
