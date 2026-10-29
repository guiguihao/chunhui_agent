import fs from 'fs/promises';
import path from 'path';

/**
 * 记忆系统管理
 * 负责读取和写入 memory/ 目录下的文件
 */
/** 单个记忆文件的归档阈值（超出后最旧的章节会被移入 _archive/） */
const DEFAULT_ARCHIVE_AFTER_CHARS = 30000;
/** 默认注入到系统提示的记忆长度上限（按文件计） */
const DEFAULT_MAX_CONTEXT_CHARS = 4000;

class MemoryService {
  constructor(config = {}) {
    this.directory = config.directory || './memory';
    this.userProfileFile = config.user_profile || 'USER_PROFILE.md';
    this.knowledgeFile = config.knowledge || 'KNOWLEDGE.md';
    this.factsFile = config.facts || 'FACTS.md';
    this.contextFile = config.context || 'CONTEXT.md';
    // 记忆生命周期治理参数
    this.archiveAfterChars = config.archive_after_chars ?? DEFAULT_ARCHIVE_AFTER_CHARS;
    this.maxContextChars = config.max_context_chars ?? DEFAULT_MAX_CONTEXT_CHARS;
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
      
      // 治理：多个记忆文件此前只增不减、且每轮全量注入提示词，
      // 导致 token 成本随时间线性上升。启动时对超标文件做一次冷归档。
      for (const file of files) {
        const moved = await this.archiveOverflow(file);
        if (moved > 0) {
          console.log(`[Memory] Archived ${moved} section(s) from ${file}`);
        }
      }

      console.log('[Memory] Initialized');
    } catch (error) {
      console.error('[Memory] Init error:', error.message);
      throw error;
    }
  }

  /**
   * 当单个记忆文件超出体积阈值时，把「最旧」的章节移入 _archive/
   *
   * 以 "## " 为章节边界拆分，从最新章节开始反向累积直至达到预算，
   * 其余较旧章节整体归档（保留文件头，避免丢失文档标题）。
   *
   * @param {string} filename - 目标文件名
   * @returns {Promise<number>} 归档的章节数（0 表示无需归档）
   */
  async archiveOverflow(filename) {
    const maxChars = this.archiveAfterChars;
    if (!(maxChars > 0)) return 0; // 0 或负数表示关闭归档

    try {
      const filePath = path.join(this.directory, filename);
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.length <= maxChars) return 0;

      const parts = content.split(/^(?=## )/m);
      if (parts.length <= 1) return 0; // 无章节边界，无法拆分

      const header = parts[0];
      const sections = parts.slice(1);

      // 从最新章节反向累积，保留不超过预算的最新内容
      const kept = [];
      let size = header.length;
      for (let i = sections.length - 1; i >= 0; i--) {
        if (size + sections[i].length > maxChars) break;
        kept.unshift(sections[i]);
        size += sections[i].length;
      }

      // 若连「最新的一章」都放不进预算，说明阈值过小或单条目过大，
      // 此时若继续归档会清空整个文件 —— 必须放弃归档，绝不牺牲数据。
      if (kept.length === 0) {
        console.warn(`[Memory] ${filename} 单章节已超出归档阈值(${maxChars})，跳过归档以避免数据丢失`);
        return 0;
      }

      const toArchive = sections.slice(0, sections.length - kept.length);
      if (toArchive.length === 0) return 0;

      const archiveDir = path.join(this.directory, '_archive');
      await fs.mkdir(archiveDir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10);
      const dest = path.join(archiveDir, `${path.basename(filename, '.md')}-${stamp}.md`);
      await fs.appendFile(dest, toArchive.join('') + '\n\n', 'utf-8');
      await fs.writeFile(filePath, header + kept.join(''), 'utf-8');

      return toArchive.length;
    } catch (error) {
      console.warn(`[Memory] Archive error (${filename}): ${error.message}`);
      return 0;
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
   *
   * 默认对每个文件做长度上限裁剪，保留「最新」部分。
   * 此前是全文注入，KNOWLEDGE.md 等文件体量增长后会显著推高 token 成本与延迟。
   *
   * @param {object} [options]
   * @param {number} [options.maxChars] - 每个文件的字符上限；0 表示不限制（全文）
   * @returns {Promise<object>} 所有记忆
   */
  async getAll({ maxChars } = {}) {
    const limit = maxChars ?? this.maxContextChars;
    const trim = (s) => {
      const str = s || '';
      if (!(limit > 0) || str.length <= limit) return str;
      return `…（较早内容已省略，详见 memory/ 原始文件）\n${str.slice(-limit)}`;
    };
    return {
      userProfile: trim(await this.loadUserProfile()),
      knowledge: trim(await this.loadKnowledge()),
      facts: trim(await this.loadFacts()),
      context: trim(await this.loadContext()),
    };
  }
}

export default MemoryService;
