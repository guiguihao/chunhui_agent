/**
 * MCP Server 初始化脚本
 * 扫描 mcp/ 目录并自动注册 MCP Server 到 .qwen/settings.json
 */

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const MCP_DIR = './mcp';
const SETTINGS_FILE = './.qwen/settings.json';

/**
 * 扫描 MCP 目录并注册 Server
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

    console.log(`[SetupMCP] Found ${mcpServers.length} MCP server(s):`);
    
    // 读取现有配置
    let settings = {};
    try {
      const settingsContent = await fs.readFile(SETTINGS_FILE, 'utf-8');
      settings = JSON.parse(settingsContent);
    } catch {
      settings = { permissions: { allow: [] }, mcpServers: {} };
    }

    // 确保 mcpServers 字段存在
    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }

    // 注册每个 MCP Server
    for (const server of mcpServers) {
      const serverName = server.name;
      const serverPath = path.join(MCP_DIR, serverName);
      
      console.log(`[SetupMCP] Registering: ${serverName}`);
      
      // 检查是否有 server.js 或 index.js
      let serverFile = null;
      for (const file of ['server.js', 'index.js', 'main.js']) {
        try {
          await fs.access(path.join(serverPath, file));
          serverFile = file;
          break;
        } catch {
          continue;
        }
      }

      if (!serverFile) {
        console.warn(`[SetupMCP] No server.js/index.js/main.js found in ${serverName}, skipping...`);
        continue;
      }

      // 添加到配置
      settings.mcpServers[serverName] = {
        command: 'node',
        args: [path.join(serverPath, serverFile)],
        cwd: process.cwd(),
        trust: true,
        timeout: 60000,
      };

      console.log(`[SetupMCP] Registered: ${serverName} (${serverFile})`);
    }

    // 保存配置
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    console.log(`[SetupMCP] Settings updated: ${SETTINGS_FILE}`);
    
    // 使用 qwen mcp CLI 命令验证 (可选)
    console.log('[SetupMCP] You can verify with: qwen mcp list');

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
