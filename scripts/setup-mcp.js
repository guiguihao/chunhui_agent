/**
 * MCP Server 初始化脚本
 * 扫描 mcp/ 目录并自动注册 MCP Server
 */

import fs from 'fs/promises';
import path from 'path';

const MCP_DIR = './mcp';
const MCP_CONFIG_FILE = './config/mcporter.json';

/**
 * 扫描 MCP 目录并验证 Server 配置
 */
async function setupMcp() {
  console.log('[SetupMCP] Scanning mcp/ directory...');

  try {
    // 检查 mcp/ 目录是否存在
    try {
      await fs.access(MCP_DIR);
    } catch {
      console.log('[SetupMCP] mcp/ directory not found, skipping...');
      return;
    }

    // 读取目录
    const entries = await fs.readdir(MCP_DIR, { withFileTypes: true });
    const mcpServers = entries.filter(entry => entry.isDirectory());

    if (mcpServers.length === 0) {
      console.log('[SetupMCP] No MCP servers found in mcp/ directory');
      return;
    }

    console.log(`[SetupMCP] Found ${mcpServers.length} MCP server(s) in mcp/:`);
    for (const server of mcpServers) {
      console.log(`  - ${server.name}`);
    }

    // 检查并打印 config/mcporter.json 配置状态
    try {
      const configContent = await fs.readFile(MCP_CONFIG_FILE, 'utf-8');
      const config = JSON.parse(configContent);
      const configuredServers = Object.keys(config.mcpServers || {});
      console.log(`[SetupMCP] Configured servers in ${MCP_CONFIG_FILE}: ${configuredServers.join(', ')}`);
    } catch (e) {
      console.warn(`[SetupMCP] Could not read ${MCP_CONFIG_FILE}: ${e.message}`);
    }

  } catch (error) {
    console.error('[SetupMCP] Error:', error.message);
    throw error;
  }
}

// 执行
setupMcp()
  .then(() => {
    console.log('[SetupMCP] Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('[SetupMCP] Failed:', error.message);
    process.exit(1);
  });

export default setupMcp;
