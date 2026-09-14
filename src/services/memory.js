import fs from 'fs/promises';
import path from 'path';

/**
 * 记忆系统管理
 * 负责读取和写入 memory/ 目录下的文件
 */
class MemoryService {
  constructor(config = {}) {
    this.directory = config.directory || './memory';
    this.userProfileFile = config.user_profile || 'USER_PROFILE.md';
    this.knowledgeFile = config.knowledge || 'KNOWLEDGE.md';
    this.factsFile = config.facts || 'FACTS.md';
    this.contextFile = config.context || 'CONTEXT.md';
  }

  /**
   * 初始化记忆目录
   */
  async init() {
    try {
      await fs.mkdir(this.directory, { recursive: true });
      
      // 确保文件存在
      const files = [this.userProfileFile, this.knowledgeFile, this.factsFile, this.contextFile];
      for (const file of files) {
        const filePath = path.join(this.directory, file);
        try {
          await fs.access(filePath);
        } catch {
          if (file === this.contextFile) {
            await fs.writeFile(filePath, `# 上下文与背景 (最近更新: ${new Date().toLocaleString()})\n\n## 当前状态\n- 暂无数据\n\n## 附加背景\n- 暂无数据\n`);
          } else {
            await fs.writeFile(filePath, `# ${file.replace('.md', '')}\n\n`);
          }
        }
      }
      
      console.log('[Memory] Initialized');
    } catch (error) {
      console.error('[Memory] Init error:', error.message);
      throw error;
    }
  }

  /**
   * 读取用户偏好
   * @returns {string} 用户偏好内容
   */
  async loadUserProfile() {
    return this.readFile(this.userProfileFile);
  }

  /**
   * 读取知识库
   * @returns {string} 知识库内容
   */
  async loadKnowledge() {
    return this.readFile(this.knowledgeFile);
  }

  /**
   * 读取事实信息
   * @returns {string} 事实信息内容
   */
  async loadFacts() {
    return this.readFile(this.factsFile);
  }

  /**
   * 更新（追加）用户偏好
   * @param {string} content - 新内容
   * @param {object} options - 选项，如 { overwrite: true }
   */
  async updateUserProfile(content, options = {}) {
    if (options.overwrite) {
      return this.writeFile(this.userProfileFile, content);
    }
    return this.appendFile(this.userProfileFile, content);
  }

  /**
   * 更新（追加）知识库
   * @param {string} content - 新内容
   * @param {object} options - 选项，如 { overwrite: true }
   */
  async updateKnowledge(content, options = {}) {
    if (options.overwrite) {
      return this.writeFile(this.knowledgeFile, content);
    }
    return this.appendFile(this.knowledgeFile, content);
  }

  /**
   * 更新（追加）事实信息
   * @param {string} content - 新内容
   * @param {object} options - 选项，如 { overwrite: true }
   */
  async updateFacts(content, options = {}) {
    if (options.overwrite) {
      return this.writeFile(this.factsFile, content);
    }
    return this.appendFile(this.factsFile, content);
  }

  /**
   * 读取上下文背景
   */
  async loadContext() {
    return this.readFile(this.contextFile);
  }

  /**
   * 更新上下文背景
   */
  async updateContext(content) {
    return this.writeFile(this.contextFile, content);
  }

  /**
   * 读取文件
   * @param {string} filename - 文件名
   * @returns {string} 文件内容
   */
  async readFile(filename) {
    try {
      const filePath = path.join(this.directory, filename);
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  /**
   * 写入文件 (覆盖)
   * @param {string} filename - 文件名
   * @param {string} content - 内容
   */
  async writeFile(filename, content) {
    try {
      const filePath = path.join(this.directory, filename);
      await fs.writeFile(filePath, content, 'utf-8');
      console.log(`[Memory] Updated: ${filename}`);
      return true;
    } catch (error) {
      console.error(`[Memory] Write error (${filename}):`, error.message);
      throw error;
    }
  }

  /**
   * 追加写入文件
   * @param {string} filename - 文件名
   * @param {string} content - 内容
   */
  async appendFile(filename, content) {
    try {
      if (!content || !content.trim()) {
        return true;
      }
      const filePath = path.join(this.directory, filename);
      let existingContent = '';
      try {
        existingContent = await fs.readFile(filePath, 'utf-8');
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }

      // 去除首尾空白，并使用正则按行/段落边界进行匹配，避免短文本因部分包含（如子串）导致被误判为已存在
      const trimmedContent = content.trim();
      if (trimmedContent) {
        const escapedContent = trimmedContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(^|\\n)${escapedContent}(\\n|$)`);
        if (regex.test(existingContent)) {
          console.log(`[Memory] Content already exists in ${filename}, skipping append.`);
          return true;
        }
      }

      let newContent = existingContent;
      if (existingContent.length > 0) {
        if (!existingContent.endsWith('\n')) {
          newContent += '\n';
        }
        if (!existingContent.endsWith('\n\n')) {
          newContent += '\n';
        }
      }
      newContent += content;

      await fs.writeFile(filePath, newContent, 'utf-8');
      console.log(`[Memory] Appended: ${filename}`);
      return true;
    } catch (error) {
      console.error(`[Memory] Append error (${filename}):`, error.message);
      throw error;
    }
  }

  /**
   * 获取所有记忆内容 (用于构建 AI 上下文)
   * @returns {object} 所有记忆
   */
  async getAll() {
    return {
      userProfile: await this.loadUserProfile(),
      knowledge: await this.loadKnowledge(),
      facts: await this.loadFacts(),
      context: await this.loadContext(),
    };
  }
}

export default MemoryService;
