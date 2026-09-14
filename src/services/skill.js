import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';

/**
 * SkillService - 技能管理服务
 * 支持 .js 逻辑技能 和 标准 .md 知识技能
 */
class SkillService {
  constructor(config = {}) {
    this.directory = path.resolve(process.cwd(), config.directory || './skills');
  }

  async init() {
    try {
      await fs.mkdir(this.directory, { recursive: true });
      console.log(`[Skill] Service initialized, directory: ${this.directory}`);
    } catch (error) {
      console.error('[Skill] Init error:', error.message);
    }
  }

  /**
   * 解析 SKILL.md 的前置参数 (Frontmatter)
   */
  _parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return { content };

    try {
      const metadata = yaml.parse(match[1]);
      const body = content.slice(match[0].length).trim();
      return { metadata, content: body };
    } catch (e) {
      return { content };
    }
  }

  /**
   * 列出所有可用技能
   */
  async list() {
    try {
      const entries = await fs.readdir(this.directory, { withFileTypes: true });
      const skills = [];

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.js')) {
          skills.push({ name: entry.name.replace('.js', ''), type: 'js' });
        } else if (entry.isDirectory()) {
          const subDirPath = path.join(this.directory, entry.name);
          const subFiles = await fs.readdir(subDirPath);

          if (subFiles.includes('SKILL.md')) {
            const content = await fs.readFile(path.join(subDirPath, 'SKILL.md'), 'utf8');
            const { metadata } = this._parseFrontmatter(content);
            skills.push({
              name: metadata?.name || entry.name,
              description: metadata?.description || '',
              type: 'md',
              parameters: metadata?.parameters || null
            });
          } else if (subFiles.includes('index.js')) {
            skills.push({ name: entry.name, type: 'js' });
          }
        }
      }
      return skills;
    } catch (error) {
      console.error('[Skill] List skills error:', error.message);
      return [];
    }
  }

  /**
   * 解析技能路径（支持目录名匹配和 SKILL.md 中的 friendly name 匹配）
   */
  async _resolveSkillPath(name) {
    // 1. 尝试直接路径匹配（文件名或目录名与技能名一致）
    const possiblePaths = [
      path.join(this.directory, `${name}.js`),
      path.join(this.directory, name, 'index.js'),
      path.join(this.directory, name, 'SKILL.md'),
    ];

    for (const p of possiblePaths) {
      try {
        const stats = await fs.stat(p);
        if (stats.isFile()) return p;
      } catch (e) {
        // 忽略
      }
    }

    // 2. 尝试遍历所有目录，匹配 SKILL.md 中的 name 字段
    try {
      const entries = await fs.readdir(this.directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillMdPath = path.join(this.directory, entry.name, 'SKILL.md');
          try {
            const content = await fs.readFile(skillMdPath, 'utf8');
            const { metadata } = this._parseFrontmatter(content);
            if (metadata?.name === name) {
              return skillMdPath;
            }
          } catch (e) {
            // 该目录下没有 SKILL.md 或读取失败
          }
        }
      }
    } catch (e) {
      console.error('[Skill] Resolve path error:', e.message);
    }

    return null;
  }

  /**
   * 获取技能的提示词内容
   */
  async getSkillPrompt(name) {
    const foundPath = await this._resolveSkillPath(name);
    if (foundPath && foundPath.endsWith('.md')) {
      const rawContent = await fs.readFile(foundPath, 'utf8');
      const { content } = this._parseFrontmatter(rawContent);
      return content;
    }
    return null;
  }

  /**
   * 执行指定技能
   */
  async run(name, params = {}, agent) {
    const foundPath = await this._resolveSkillPath(name);

    if (!foundPath) throw new Error(`Skill "${name}" not found`);

    try {
      if (foundPath.endsWith('.js')) {
        const module = await import(`file://${foundPath}?t=${Date.now()}`);
        const executeFn = module.default || module.execute;
        return await executeFn(agent, params);
      } else if (foundPath.endsWith('.md')) {
        const rawContent = await fs.readFile(foundPath, 'utf8');
        const { metadata, content } = this._parseFrontmatter(rawContent);

        console.log(`[Skill] Executing Standard Markdown skill: ${name}`);

        const prompt = `你现在正在执行 "${name}" 技能的内部逻辑。
技能描述: ${metadata?.description || '无'}
参考手册/运行指令:
${content}

### 重要指令：
1. **禁止递归**：你已经在 "${name}" 技能内部了。严禁再次调用 "skill_run"、"baidu_search" 或任何技能相关的工具。
2. **直接执行**：请根据参考手册，直接使用 "cmd_exec" 工具运行相应的终端命令（如 Python 脚本）来获取结果。
3. **参数应用**：结合用户提供的参数 ${JSON.stringify(params)} 构造命令。

请立即执行命令并汇报结果。`;

        return await agent.decide(prompt, {
          appendSystemPrompt: `你现在是 "${name}" 技能的执行专家。请严格按照手册通过 cmd_exec 完成任务，严禁二次调用技能工具。`,
          toolFilter: (tool) => {
            // 严禁在技能内部再次调用其他技能（通过 [Skill] 描述前缀识别）
            return !tool.function.description?.includes('[Skill]');
          }
        });
      }
    } catch (error) {
      console.error(`[Skill] Error running skill "${name}":`, error.message);
      throw error;
    }
  }
}

export default SkillService;
