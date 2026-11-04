import fs from 'fs/promises';
import path from 'path';

/**
 * config/mcporter.json 的读写 —— 与 WebUI /api/mcp 共用同一事实来源
 *
 * 一条关键约束：文件里保存的是**未做变量替换**的原文（如 `${HA_TOKEN}`），
 * 而 MCPorterService 内存里的 this.config 是替换后的真实值。
 * 管理工具必须以文件为准读写，否则会把真实 token 回写到磁盘。
 *
 * 另一条：MCP runtime 连不上的时候（HA 没起、Server 被禁用）恰恰最需要
 * 这类工具来排查，所以读写都不能依赖 runtime 状态。
 */

/**
 * mcporter.json 的绝对路径
 * @param {string} [base] - 基准目录，默认 process.cwd()（便于测试 chdir 到临时目录）
 */
export function mcpConfigPath(base = process.cwd()) {
  return path.join(base, 'config', 'mcporter.json');
}

/**
 * 读取 mcpServers 映射（原文，不做 ${VAR} 替换）
 * @param {string} [base]
 * @returns {Promise<{servers: object, parsed: object}>}
 */
export async function readMcpServers(base = process.cwd()) {
  const raw = await fs.readFile(mcpConfigPath(base), 'utf8');
  const parsed = JSON.parse(raw);
  const servers = parsed?.mcpServers && typeof parsed.mcpServers === 'object'
    ? parsed.mcpServers
    : {};
  return { servers, parsed };
}

/**
 * 写回 mcpServers（保持 ${VAR} 占位符原样）
 * @param {object} servers
 * @param {string} [base]
 */
export async function writeMcpServers(servers, base = process.cwd()) {
  await fs.writeFile(
    mcpConfigPath(base),
    JSON.stringify({ mcpServers: servers }, null, 2),
    'utf8',
  );
}

/**
 * 转成可进入模型上下文的安全摘要：剥掉 headers / env（含 token），
 * 只保留"是否配置了鉴权"这个布尔信息
 *
 * @param {string} name - Server 名称
 * @param {object} cfg - 原始配置
 * @returns {object}
 */
export function redactServerConfig(name, cfg = {}) {
  // eslint-disable-next-line no-unused-vars
  const { headers, env, ...rest } = cfg;
  const out = {
    name,
    enabled: rest.enabled !== false,
    authConfigured: Boolean(headers) || Boolean(env),
  };
  if (rest.serverUrl || rest.url) out.url = rest.serverUrl || rest.url;
  if (rest.command) out.command = rest.command;
  if (rest.args) out.args = rest.args;
  return out;
}
