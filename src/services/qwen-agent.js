import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Qwen Code 无头模式封装
 * 通过 CLI 调用 Qwen Code，实现 AI 自主决策
 */
class QwenAgent {
  constructor(config = {}) {
    this.outputFormat = config.outputFormat || 'json';
    this.yolo = config.yolo !== false;
    this.systemPrompt = config.systemPrompt || '';
  }

  /**
   * 核心决策方法
   * @param {string} prompt - 问题/指令
   * @param {object} options - 可选参数
   * @returns {object} AI 返回的 JSON 决策
   */
  async decide(prompt, options = {}) {
    const args = [
      'qwen',
      '--continue',
      `-p "${this.escapeShell(prompt)}"`,
      `--output-format ${this.outputFormat}`,
    ];

    if (this.yolo) {
      args.push('--yolo');
    }

    if (options.systemPrompt) {
      args.push(`--system-prompt "${this.escapeShell(options.systemPrompt)}"`);
    }

    // 只追加一次
    const appendParts = [];
    if (this.systemPrompt) {
      appendParts.push(this.systemPrompt);
    }
    if (options.appendSystemPrompt) {
      appendParts.push(options.appendSystemPrompt);
    }

    if (appendParts.length > 0) {
      const appendText = appendParts.join('\n');
      args.push(`--append-system-prompt "${this.escapeShell(appendText)}"`);
    }

    const command = args.join(' ');
    
    try {
      const { stdout, stderr } = await execAsync(command);
      
      if (stderr) {
        console.warn('[QwenAgent] Warning:', stderr);
      }

      // 解析 JSON 输出
      return this.parseOutput(stdout);
    } catch (error) {
      console.error('[QwenAgent] Error:', error.message);
      throw error;
    }
  }

  /**
   * 持续对话
   * @param {string} sessionId - Session ID (可选，不传则使用最近的)
   * @param {string} prompt - 后续问题
   * @returns {object} AI 返回的 JSON 决策
   */
  async continue(sessionId, prompt) {
    const args = [
      'qwen',
      sessionId ? `--resume ${sessionId}` : '--continue',
      `-p "${this.escapeShell(prompt)}"`,
      `--output-format ${this.outputFormat}`,
    ];

    if (this.yolo) {
      args.push('--yolo');
    }

    const command = args.join(' ');
    
    try {
      const { stdout } = await execAsync(command);
      return this.parseOutput(stdout);
    } catch (error) {
      console.error('[QwenAgent] Continue error:', error.message);
      throw error;
    }
  }

  /**
   * 解析 AI 输出
   * @param {string} output - 原始输出
   * @returns {object} 解析后的 JSON
   */
  parseOutput(output) {
    try {
      // 尝试直接解析
      return JSON.parse(output);
    } catch {
      // 尝试提取 JSON 部分
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      // 返回原始输出
      return { response: output };
    }
  }

  /**
   * 转义 Shell 特殊字符
   * @param {string} str - 原始字符串
   * @returns {string} 转义后的字符串
   */
  escapeShell(str) {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
  }
}

export default QwenAgent;
