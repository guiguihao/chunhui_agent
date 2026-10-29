import * as lark from '@larksuiteoapi/node-sdk';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 飞书 (Feishu/Lark) 插件
 * 基于官方 SDK 实现 WebSocket 长连接实时监听消息与 AI 自动回复
 * 支持流式回复：先发交互式卡片占位 → 逐 chunk patch 更新卡片 → 打字机效果
 */

/**
 * 飞书专用追加提示词
 * lark_md 语法有限，但飞书卡片支持原生 table 组件展示表格
 */
const FEISHU_SYSTEM_PROMPT = "用户在飞书发送消息，参考用户偏好和习惯记录。\n\n### 输出格式要求\n你的回复将通过飞书卡片渲染。文本部分使用 lark_md，表格部分使用卡片原生 table 组件。\n\nlark_md 仅支持以下语法：\n- 加粗 **text**、斜体 *text*、删除线 ~~text~~\n- 无序列表 - text 或 * text\n- 有序列表 1. text\n- 行内代码 \`code\`（不支持多行代码块）\n- 链接 [text](url)\n- 颜色 <font color='red'>text</font>（支持 red/green/grey/orange/blue/purple）\n\n❌ lark_md 不支持：标题 #、引用 >、分割线 ---、代码块 \\\`\\\`\\\`、任务列表 - [ ]\n\n表格请使用标准 Markdown 表格语法，我们会自动转为飞书卡片原生 table：\n| DID | 别名 | 型号 | 房间 | 楼层 | 备注 |\n|-----|------|------|------|------|------|\n| 1001 | 温控器 | RL-01 | 餐厅 | -1F | 自动模式 |\n\n### 可用工具\n\n#### 文件操作\n- \`file_read(path)\` - 读取文件内容\n- \`file_write(path, content)\` - 写入文件\n- \`file_append(path, content)\` - 追加到文件\n- \`file_exists(path)\` - 检查文件是否存在\n- \`file_delete(path)\` - 删除文件\n- \`file_list(path)\` - 列出目录内容\n- \`file_edit(path, ...)\` - 编辑文件内容\n  - \`insert_line\`: 在指定行号前插入内容\n  - \`replace_line\`: 替换指定行号的内容\n  - \`delete_line\`: 删除指定行号的行\n  - \`find\`/\`replace\`: 查找并替换字符串\n  - \`regex: true\`: 启用正则表达式模式\n  - \`all: true\`: 替换所有匹配项（默认只替换第一个）\n\n#### 命令执行\n- \`cmd_exec(command, cwd?, timeout?)\` - 执行系统命令\n  - \`cwd\`: 工作目录（可选）\n  - \`timeout\`: 超时毫秒（默认30000）\n";

/**
 * 解析 Markdown 表格的一行
 * @param {string} line - 如 "| DID | 别名 | 型号 |" 或 "| 1001 | 温控器 | RL-01 |"
 * @returns {Array<string>} 单元格内容数组
 */
function parseTableRow(line) {
  const trimmed = line.trim();
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const inner2 = inner.endsWith('|') ? inner.slice(0, -1) : inner;
  return inner2.split('|').map(c => c.trim());
}

/**
 * 判断一行是否是 Markdown 表格分隔行（|---|---|）
 */
function isTableSeparatorLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return false;
  const inner = trimmed.slice(1);
  const inner2 = inner.endsWith('|') ? inner.slice(0, -1) : inner;
  const cells = inner2.split('|').map(c => c.trim());
  return cells.length > 0 && cells.every(c => /^[\s\-:]+$/.test(c));
}

/**
 * 将 Markdown 表格转为飞书卡片 table 组件
 * 飞书 table 单元格只支持纯文本，需清理 <font> 等 HTML 标签
 * @param {string} headerLine - 表头行
 * @param {Array<string>} dataLines - 数据行数组
 * @returns {object} 飞书卡片 table 元素
 */
function markdownTableToFeishuTable(headerLine, dataLines) {
  const headers = parseTableRow(headerLine);
  const columns = headers.map((h, idx) => ({
    name: 'col_' + idx,
    display_name: cleanTableCell(h),
    data_type: 'text',
    width: 'auto',
  }));

  const rows = dataLines.map(line => {
    const cells = parseTableRow(line);
    const row = {};
    columns.forEach((col, idx) => {
      row[col.name] = cleanTableCell(cells[idx] || '–');
    });
    return row;
  });

  return {
    tag: 'table',
    page_size: rows.length > 5 ? 5 : rows.length,
    columns,
    rows,
  };
}

/**
 * 清理表格单元格中的 HTML 标签（飞书 table 只支持纯文本）
 * 移除 <font> 等标签，保留文本内容
 * @param {string} text - 单元格文本
 * @returns {string} 清理后的纯文本
 */
function cleanTableCell(text) {
  if (!text) return '–';
  // 移除 <font> 标签，保留内容
  return text.replace(/<font[^>]*>(.*?)<\/font>/gi, '$1');
}

/**
 * 将 AI 输出的 Markdown 文本拆分为飞书卡片元素数组
 * 表格 → table 组件；其他文本 → lark_md div
 * @param {string} text - Markdown 文本
 * @returns {Array} 飞书卡片 elements 数组
 */
function parseMarkdownToCardElements(text) {
  if (!text || typeof text !== 'string') {
    return [{ tag: 'div', text: { tag: 'lark_md', content: text || '无内容' } }];
  }

  const lines = text.split('\n');
  const elements = [];
  let i = 0;

  // 表格收集状态
  let tableHeaderLine = null;
  let tableDataLines = [];
  let inTable = false;

  // 段落收集状态
  let paragraphLines = [];

  function flushParagraph() {
    if (paragraphLines.length === 0) return;
    const content = paragraphLines.join('\n');
    // 去除 lark_md 不支持的语法
    const cleaned = cleanLarkMd(content);
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: cleaned } });
    paragraphLines = [];
  }

  function flushTable() {
    if (!tableHeaderLine || tableDataLines.length === 0) {
      inTable = false;
      tableHeaderLine = null;
      tableDataLines = [];
      return;
    }
    elements.push(markdownTableToFeishuTable(tableHeaderLine, tableDataLines));
    inTable = false;
    tableHeaderLine = null;
    tableDataLines = [];
  }

  while (i < lines.length) {
    const line = lines[i];

    // ── 表格行 ──
    if (line.trim().startsWith('|')) {
      flushParagraph();

      if (isTableSeparatorLine(line)) {
        // 分隔行，跳过（已处于表格模式中）
        i++;
        continue;
      }

      if (!inTable) {
        // 表头行开始
        inTable = true;
        tableHeaderLine = line;
      } else {
        // 数据行
        tableDataLines.push(line);
      }
      i++;
      continue;
    } else if (inTable) {
      // 表格结束（当前行不是表格行）
      flushTable();
      // 不跳过当前行，继续处理
    }

    // ── 普通段落 ──
    paragraphLines.push(line);
    i++;
  }

  // 最后 flush 所有未输出内容
  flushParagraph();
  flushTable();

  // 安全兜底
  if (elements.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: cleanLarkMd(text) } });
  }

  return elements;
}

/**
 * 清理 lark_md 不支持的 Markdown 语法
 * 移除标题符号 #、引用 >、分割线 ---、代码块 ``` 包裹等
 * 保留 <font color> 标签（飞书支持）
 * @param {string} text - 原始 Markdown
 * @returns {string} 清理后的文本
 */
function cleanLarkMd(text) {
  if (!text) return '';

  // 1. 临时保存 <font> 标签，避免被后续规则破坏
  const fontTags = [];
  const textWithPlaceholders = text.replace(/<font[^>]*>.*?<\/font>/gi, (match) => {
    fontTags.push(match);
    return `@@FONT_${fontTags.length - 1}@@`; // 使用更独特的占位符
  });

  // 2. 清理不支持的语法
  const cleaned = textWithPlaceholders
    // 移除标题符号（# 开头的行 -> 直接显示文本）
    .replace(/^#{1,6}\s+/gm, '')
    // 移除引用符号
    .replace(/^>\s+/gm, '')
    // 移除独占一行的分割线
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // 处理代码块包裹（保留内容，去掉 ```）
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '$1');

  // 3. 还原 <font> 标签
  return cleaned.replace(/@@FONT_(\d+)@@/g, (match, i) => {
    return fontTags[parseInt(i)] || match;
  });
}

/**
 * 构建飞书交互式卡片 JSON（智能解析 Markdown，表格用原生 table 组件）
 * @param {string} text - Markdown 文本
 * @param {string} agentName - Agent 名称
 * @returns {string} JSON 字符串
 */
function buildCardContent(text, agentName = 'ureal') {
  const elements = parseMarkdownToCardElements(text);
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🏠 ${agentName}` },
      template: 'blue',
    },
    elements,
  });
}

/**
 * 构建纯文本消息 JSON
 */
function buildTextContent(text) {
  return JSON.stringify({ text });
}

/**
 * 从文本内容中提取本地图片路径
 * 支持的图片格式：png, jpg, jpeg, gif, webp, bmp
 * @param {string} text - 文本内容
 * @returns {Array<string>} 本地图片路径数组
 */
function extractLocalImagePaths(text) {
  if (!text) return [];

  const imagePaths = [];

  console.log('[Feishu] extractLocalImagePaths called with text length:', text.length);

  // 匹配更灵活的路径格式：
  // - 支持绝对路径 /path/...
  // - 支持相对路径 ./... 或 ../...
  // - 支持中文路径
  // - 支持被反引号 ` 或其他符号包裹的路径
  // - 不区分大小写的文件扩展名
  const patterns = [
    // 模式1: 反引号包裹的路径，支持空格，如 `/path with spaces/image.png`
    /`([^`\n\r]+\.(?:png|jpg|jpeg|gif|webp|bmp))`/gi,

    // 模式2: 绝对路径 /... 或 ~/... (优化边界处理)
    /(?:^|\s|[:：])(\/(?:[^\s`'"]|\\ )+\.(?:png|jpg|jpeg|gif|webp|bmp))(?=$|\s|[,，.。！!?？])/gi,
    /(?:^|\s|[:：])(~\/(?:[^\s`'"]|\\ )+\.(?:png|jpg|jpeg|gif|webp|bmp))(?=$|\s|[,，.。！!?？])/gi,

    // 模式3: 相对路径 ./... 或 ../...
    /(?:^|\s|[:：])(\.\.?\/(?:[^\s`'"]|\\ )+\.(?:png|jpg|jpeg|gif|webp|bmp))(?=$|\s|[,，.。！!?？])/gi,

    // 模式4: 简单路径（包含路径分隔符且有扩展名）
    /(?:^|\s|[:：])([^\s`'"]+[\/\\][^\s`'"]+\.(?:png|jpg|jpeg|gif|webp|bmp))(?=$|\s|[,，.。！!?？])/gi,
  ];

  for (const pattern of patterns) {
    let match;
    // 重置正则表达式的 lastIndex
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      let imagePath = match[1];
      // 展开 ~ 为用户目录
      if (imagePath.startsWith('~/')) {
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        if (homeDir) {
          imagePath = path.join(homeDir, imagePath.slice(2));
        }
      }

      // 归一化路径：转换为绝对路径，解决 ./abc.png 和 abc.png 的重复问题
      try {
        imagePath = path.resolve(imagePath);
      } catch (e) {
        console.warn('[Feishu] Path resolve failed:', imagePath);
      }

      // 验证路径是否存在
      if (fs.existsSync(imagePath)) {
        // 去重
        if (!imagePaths.includes(imagePath)) {
          imagePaths.push(imagePath);
          console.log('[Feishu] Found valid image path:', imagePath);
        }
      }
    }
  }

  console.log('[Feishu] Extracted image paths:', imagePaths);
  return imagePaths;
}

/**
 * 构建图片消息 JSON
 * @param {string} imageKey - 飞书图片 key
 * @returns {string} JSON 字符串
 */
function buildImageContent(imageKey) {
  return JSON.stringify({ image_key: imageKey });
}

class FeishuService {
  constructor(config, agent) {
    this.appId = config.app_id || process.env.FEISHU_APP_ID;
    this.appSecret = config.app_secret || process.env.FEISHU_APP_SECRET;
    this.enableListener = config.enable_listener !== false;
    this.autoReply = config.auto_reply !== false;
    this.streamReply = config.stream_reply !== false;
    this.agent = agent;

    // 通知渠道
    this.notificationChatId = config.notification_chat_id || process.env.FEISHU_NOTIFICATION_CHAT_ID;

    // 流式回复参数
    this.streamPatchInterval = config.stream_patch_interval || 500; // patch 间隔(ms)

    // chatId → sessionId 映射（支持 /new 切换新会话）
    this._chatSessionMap = {};
    this.sessionFilePath = path.join(process.cwd(), 'sessions', 'feishu_sessions.json');

    // 消息去重：避免飞书重复投递相同消息
    this._processedMessageMap = new Map(); // key: `${chatId}_${messageId}` → 处理时间戳
    this._dedupTTL = 10 * 60 * 1000; // 去重窗口：10分钟
    this._maxDedupSize = 2000;       // 最大缓存条数
    this.dedupFilePath = path.join(process.cwd(), 'sessions', 'feishu_dedup.json');
    this._dedupCleanInterval = null;
    this._saveTimer = null;

    this.client = null;      // HTTP API 客户端
    this.wsClient = null;    // WebSocket 长连接客户端
    this.eventDispatcher = null;

    // 图片上传缓存：path -> { imageKey, timestamp }
    this._imageKeyCache = new Map();
    this._imageCacheTTL = 30 * 60 * 1000; // 缓存 30 分钟
  }

  async start() {
    if (!this.appId || !this.appSecret) {
      console.warn('[Feishu] App ID or Secret not configured, skipping...');
      return;
    }

    if (!this.enableListener) {
      console.log('[Feishu] Listener disabled, skipping...');
      return;
    }

    console.log('[Feishu] Starting...');

    try {
      // 0. 加载本地会话和去重缓存
      await this._loadSessions();
      await this._loadDedupCache();

      // 确保之前没有启动
      if (this.client || this.wsClient) {
        console.warn('[Feishu] Already initialized, stopping first...');
        await this.stop();
      }

      // 1. 初始化 HTTP 客户端 (用于主动调用 API)
      this.client = new lark.Client({
        appId: this.appId,
        appSecret: this.appSecret,
      });

      // 2. 初始化 WebSocket 长连接客户端
      this.wsClient = new lark.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        loggerLevel: lark.LoggerLevel.info,
      });

      // 3. 配置事件监听器
      this.setupEventDispatcher();

      // 4. 启动长连接
      this.wsClient.start({ eventDispatcher: this.eventDispatcher });

      // 5. 启动去重缓存清理定时器（每5分钟清理1分钟前的记录）
      this._startDedupCleaner();

      console.log('[Feishu] ✅ Started successfully, listening for messages...');
    } catch (error) {
      console.error('[Feishu] Failed to start:', error.message);
      setTimeout(() => this.start(), 5000);
    }
  }

  async stop() {
    console.log('[Feishu] Stopping...');

    if (this._dedupCleanInterval) {
      clearInterval(this._dedupCleanInterval);
      this._dedupCleanInterval = null;
    }
    this._processedMessageMap.clear();

    if (this.wsClient) {
      if (typeof this.wsClient.stop === 'function') {
        this.wsClient.stop();
      } else if (typeof this.wsClient.disconnect === 'function') {
        this.wsClient.disconnect();
      }
      this.wsClient = null;
    }

    this.client = null;
    this.eventDispatcher = null;
    console.log('[Feishu] Stopped');
  }

  /**
   * 去重辅助方法
   */
  _startDedupCleaner() {
    if (this._dedupCleanInterval) clearInterval(this._dedupCleanInterval);
    // 每 2 分钟清理过期记录
    this._dedupCleanInterval = setInterval(() => {
      this._cleanExpiredDedupEntries();
    }, 2 * 60 * 1000);
  }

  /**
   * 清理过期的去重记录
   */
  _cleanExpiredDedupEntries() {
    const now = Date.now();
    let expiredCount = 0;
    for (const [key, ts] of this._processedMessageMap) {
      if (now - ts > this._dedupTTL) {
        this._processedMessageMap.delete(key);
        expiredCount++;
      }
    }
    if (expiredCount > 0) {
      console.log(`[Feishu] Dedup: cleaned ${expiredCount} expired entries, ${this._processedMessageMap.size} remaining`);
      this._saveDedupCache();
    }
  }

  /**
   * 从本地加载去重缓存
   */
  async _loadDedupCache() {
    try {
      if (fs.existsSync(this.dedupFilePath)) {
        const data = fs.readFileSync(this.dedupFilePath, 'utf8');
        const obj = JSON.parse(data);
        const now = Date.now();
        let loadedCount = 0;

        for (const [key, ts] of Object.entries(obj)) {
          // 只加载未过期的记录
          if (now - ts < this._dedupTTL) {
            this._processedMessageMap.set(key, ts);
            loadedCount++;
          }
        }
        console.log(`[Feishu] Dedup: loaded ${loadedCount} entries from local cache`);
      }
    } catch (error) {
      console.warn('[Feishu] Dedup: failed to load cache:', error.message);
    }
  }

  /**
   * 保存去重缓存到本地 (防抖处理)
   */
  _saveDedupCache() {
    if (this._saveTimer) clearTimeout(this._saveTimer);

    this._saveTimer = setTimeout(() => {
      try {
        const obj = Object.fromEntries(this._processedMessageMap);
        fs.writeFileSync(this.dedupFilePath, JSON.stringify(obj, null, 2), 'utf8');
        this._saveTimer = null;
      } catch (error) {
        console.warn('[Feishu] Dedup: failed to save cache:', error.message);
      }
    }, 2000); // 2秒防抖
  }

  /**
   * 从本地加载会话映射
   */
  async _loadSessions() {
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        const data = fs.readFileSync(this.sessionFilePath, 'utf8');
        const obj = JSON.parse(data);
        this._chatSessionMap = obj;
        console.log(`[Feishu] Loaded ${Object.keys(obj).length} sessions from local cache`);

        // 如果没有配置通知群，且缓存中有会话，则尝试恢复最后一个会话作为通知渠道
        if (!this.notificationChatId && Object.keys(obj).length > 0) {
          const lastChatId = Object.keys(obj)[Object.keys(obj).length - 1];
          this.notificationChatId = lastChatId;
          console.log(`[Feishu] Restored notification_chat_id from cache: ${this.notificationChatId}`);
        }
      }
    } catch (error) {
      console.warn('[Feishu] Failed to load session cache:', error.message);
    }
  }

  /**
   * 保存会话映射到本地
   */
  _saveSessions() {
    try {
      const dir = path.dirname(this.sessionFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.sessionFilePath, JSON.stringify(this._chatSessionMap, null, 2), 'utf8');
    } catch (error) {
      console.warn('[Feishu] Failed to save session cache:', error.message);
    }
  }

  /**
   * 检查消息是否已处理过
   * @param {string} chatId - 聊天 ID
   * @param {object} msgData - 消息数据
   * @param {string} content - 消息内容
   * @returns {boolean} true 表示已处理过，应该跳过
   */
  _isDuplicateMessage(chatId, msgData, content) {
    const messageId = msgData.message_id || msgData.msg_id;
    let key = chatId + '_' + messageId;

    if (!messageId) {
      const hash = this._simpleHash(content);
      key = chatId + '_' + hash;
    }

    const lastProcessed = this._processedMessageMap.get(key);
    if (lastProcessed && (Date.now() - lastProcessed < this._dedupTTL)) {
      console.log('[Feishu] Duplicate message detected: ' + key);
      return true;
    }

    // 容量控制：如果超过最大限制，先清理过期记录
    if (this._processedMessageMap.size >= this._maxDedupSize) {
      this._cleanExpiredDedupEntries();

      // 如果清理后仍然过大，强制删除最旧的 20%
      if (this._processedMessageMap.size >= this._maxDedupSize * 0.9) {
        const toDelete = Math.floor(this._maxDedupSize * 0.2);
        const keys = Array.from(this._processedMessageMap.keys());
        for (let i = 0; i < toDelete; i++) {
          this._processedMessageMap.delete(keys[i]);
        }
        console.log(`[Feishu] Dedup: cache full, force removed ${toDelete} oldest entries`);
      }
    }

    this._processedMessageMap.set(key, Date.now());
    this._saveDedupCache();
    return false;
  }

  /**
   * 简易字符串哈希（用于去重）
   */
  _simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0; // 转为32位整数
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * 配置事件分发器
   */
  setupEventDispatcher() {
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.handleMessage(data);
      },
    });
  }

  /**
   * 处理收到的消息
   */
  async handleMessage(data) {
    try {
      const msgData = data.message;
      const chatId = msgData.chat_id || msgData.chatId;

      const sender = msgData.sender || {};
      const senderId = sender.sender_id?.open_id ||
        sender.open_id ||
        sender.user_id ||
        'unknown';

      const content = this.parseMessageContent(msgData);

      console.log('[Feishu] 📨 Message from ' + senderId + ': ' + content);
      console.log('[Feishu] Chat ID: ' + chatId);

      // 忽略机器人自己发的消息
      if (senderId && senderId === this.appId) {
        return;
      }

      // 去重检查：避免重复处理相同消息
      if (this._isDuplicateMessage(chatId, msgData, content)) {
        console.log('[Feishu] Skip duplicate message from ' + senderId + ': ' + content);
        return;
      }

      if (this.autoReply) {
        await this.replyWithAI(chatId, content, senderId);
      }
    } catch (error) {
      console.error('[Feishu] Handle message error:', error.message);
    }
  }

  /**
   * 解析消息内容
   */
  parseMessageContent(msgData) {
    try {
      const content = JSON.parse(msgData.content || '{}');
      return content.text || msgData.content || '';
    } catch {
      return msgData.content || '';
    }
  }

  /**
   * 获取 chatId 对应的 sessionId
   */
  _getSessionId(chatId) {
    if (!this._chatSessionMap[chatId]) {
      this._chatSessionMap[chatId] = 'feishu_' + chatId;
      this._saveSessions(); // 发现新会话，持久化

      // 如果之前没有通知渠道，自动将第一个发现的会话设为通知渠道
      if (!this.notificationChatId) {
        this.notificationChatId = chatId;
        console.log(`[Feishu] Automatically set notification_chat_id to: ${chatId}`);
      }
    }
    return this._chatSessionMap[chatId];
  }

  /**
   * AI 自动回复 — 根据 stream 配置选择流式或一次性回复
   */
  async replyWithAI(chatId, userMessage, senderId) {
    const useStream = this.streamReply && this.agent?.stream;
    const sessionId = this._getSessionId(chatId);

    try {
      console.log('[Feishu] 🤖 AI processing (stream=' + useStream + '): ' + userMessage);

      if (!this.agent || typeof this.agent.decide !== 'function') {
        await this.sendTextMessage(chatId, 'AI 服务未初始化');
        return;
      }

      if (useStream) {
        await this.replyWithStream(chatId, userMessage, sessionId);
      } else {
        await this.replyWithNormal(chatId, userMessage, sessionId);
      }
    } catch (error) {
      console.error('[Feishu] AI reply failed:', error.message);
      await this.sendTextMessage(chatId, '抱歉，我遇到了一些问题，请稍后再试。');
    }
  }

  /**
   * 一次性回复（非流式） — 使用交互式卡片
   */
  async replyWithNormal(chatId, userMessage, sessionId) {
    const result = await this.agent.decide(userMessage, {
      sessionId,
      appendSystemPrompt: FEISHU_SYSTEM_PROMPT,
    });

    // /new 指令：sessionId 现在保持不变（仅备份并重置历史）
    if (result.command === 'new' && result.sessionId) {
      this._chatSessionMap[chatId] = result.sessionId;
    }

    const reply = result.reply || result.response || '收到！';
    await this.sendCardMessage(chatId, reply);
    // 发送完文本后，检测并发送本地图片
    await this.sendLocalImagesFromContent(chatId, reply);
    console.log('[Feishu] ✅ AI reply sent');
  }

  /**
   * 流式回复 — 发交互式卡片占位 → 逐 chunk patch 更新卡片 → 打字机效果
   */
  async replyWithStream(chatId, userMessage, sessionId) {
    // 1. 发占位卡片消息，拿到 message_id
    const msgRes = await this.sendCardMessage(chatId, '🤔 思考中...');
    const messageId = msgRes?.data?.message_id;

    if (!messageId) {
      console.warn('[Feishu] Failed to get message_id for stream reply, fallback to normal');
      const result = await this.agent.decide(userMessage, {
        sessionId,
        appendSystemPrompt: FEISHU_SYSTEM_PROMPT,
      });
      if (result.command === 'new' && result.sessionId) {
        // sessionId 现在保持不变，此处更新映射以保持逻辑一致性
        this._chatSessionMap[chatId] = result.sessionId;
      }
      await this.sendCardMessage(chatId, result.reply || result.response || '收到！');
      return;
    }

    // 2. 累积 buffer + 定时 patch 更新飞书卡片
    //    statusLine 用于展示思考/工具进度；它必须与正文分离，
    //    否则中间轮的过渡文本会被混进最终回复（此前只用 onChunk 时的老问题）
    let buffer = '';
    let statusLine = '';
    let clearStatusOnNextContent = false;
    let patchTimer = null;
    let lastPatchContent = '🤔 思考中...';

    const composeContent = () => {
      if (!buffer && !statusLine) return null; // 保持"思考中..."
      return statusLine ? `${statusLine}\n\n${buffer}`.trim() : buffer;
    };

    const flushToFeishu = async () => {
      const content = composeContent();
      if (!content || content === lastPatchContent) return;
      try {
        await this.patchCardMessage(messageId, content);
        lastPatchContent = content;
      } catch (e) {
        console.warn('[Feishu] Stream patch error: ' + e.message);
      }
    };

    // 状态行变化很有信息量且发生频率低，立即推送而不等待采样定时器，
    // 否则执行较快的工具进度会被完全跳过。
    const flushStatus = () => {
      flushToFeishu().catch(e => console.warn('[Feishu] Status flush error: ' + e.message));
    };

    patchTimer = setInterval(() => {
      flushToFeishu().catch(e => console.warn('[Feishu] Patch timer error: ' + e.message));
    }, this.streamPatchInterval);

    // 3. 调用 CoreAgent.decide
    //    必须使用 onStream：tool_start / tool_end / reasoning 只会通过该通道下发，
    //    onChunk 仅能收到 content，导致工具进度与思考过程完全不可见。
    try {
      const result = await this.agent.decide(userMessage, {
        sessionId,
        appendSystemPrompt: FEISHU_SYSTEM_PROMPT,
        onStream: (event) => {
          switch (event.type) {
            case 'content':
              // 工具调用是多轮循环：每一轮模型都可能先输出一句过渡文本
              // （例如"好的，我先查询设备状态。"），它只属于当前这一轮。
              // 新一轮正文开始时必须丢弃上一轮的累积文本，否则这些过渡句
              // 会被拼接进最终回复（旧实现仅用 onChunk 累积，存在该缺陷）。
              if (clearStatusOnNextContent) {
                statusLine = '';
                buffer = '';
                clearStatusOnNextContent = false;
              }
              buffer += event.content || '';
              break;

            case 'reasoning':
              statusLine = '💭 正在思考...';
              flushStatus();
              break;

            case 'tool_start':
              statusLine = `🔧 正在执行 \`${event.name || '工具'}\` ...`;
              flushStatus();
              break;

            case 'tool_end': {
              const res = String(event.result || '');
              const failed = /^(工具执行错误|操作拒绝|未知工具|MCP 工具|错误)/.test(res.trim());
              statusLine = `${failed ? '⚠️' : '✅'} 已完成 \`${event.name || '工具'}\``;
              // 下一轮正文到达时清理状态行与本轮文本
              clearStatusOnNextContent = true;
              flushStatus();
              break;
            }
          }
        },
      });

      // 4. 流结束后停止定时 patch，做最后一次完整更新
      clearInterval(patchTimer);

      const finalContent = result.reply || result.response || buffer || '收到！';
      if (finalContent !== lastPatchContent) {
        await this.patchCardMessage(messageId, finalContent);
      }

      // 发送完文本后，检测并发送本地图片
      await this.sendLocalImagesFromContent(chatId, finalContent);

      console.log('[Feishu] ✅ Stream reply completed');
    } catch (error) {
      clearInterval(patchTimer);
      try {
        await this.patchCardMessage(
          messageId,
          composeContent() || '抱歉，处理过程中遇到了问题。'
        );
      } catch { }
      throw error;
    }
  }

  /**
   * 发送纯文本消息
   */
  async sendTextMessage(chatId, text) {
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: buildTextContent(text),
        },
      });

      if (res.code !== 0) {
        throw new Error('Failed to send text message: ' + res.msg);
      }

      return res;
    } catch (error) {
      console.error('[Feishu] Send text message error:', error.message);
      throw error;
    }
  }

  /**
   * 发送交互式卡片消息（可被 patch 更新）
   */
  async sendCardMessage(chatId, text) {
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: buildCardContent(text, this.agent?.name),
        },
      });

      if (res.code !== 0) {
        throw new Error('Failed to send card message: ' + res.msg);
      }

      return res;
    } catch (error) {
      console.error('[Feishu] Send card message error:', error.message);
      throw error;
    }
  }

  /**
   * 更新交互式卡片消息的内容（用于流式回复打字机效果）
   * im.message.patch 只能更新卡片消息，不能更新纯文本消息
   */
  async patchCardMessage(messageId, text) {
    try {
      const res = await this.client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: buildCardContent(text, this.agent?.name),
        },
      });

      if (res.code !== 0) {
        throw new Error('Failed to patch card message: ' + res.msg);
      }

      return res;
    } catch (error) {
      console.warn('[Feishu] Patch card message error: ' + error.message);
      throw error;
    }
  }

  /**
   * 上传本地图片到飞书，获取 image_key
   * @param {string} imagePath - 本地图片路径
   * @returns {Promise<string>} 飞书 image_key
   */
  async uploadImage(imagePath) {
    // 1. 检查缓存
    const cached = this._imageKeyCache.get(imagePath);
    if (cached && (Date.now() - cached.timestamp < this._imageCacheTTL)) {
      console.log('[Feishu] Using cached imageKey for:', imagePath);
      return cached.imageKey;
    }

    try {
      console.log('[Feishu] Uploading image:', imagePath);
      const imageFile = fs.readFileSync(imagePath);
      console.log('[Feishu] Image file read, size:', imageFile.length, 'bytes');

      // 尝试不同的 API 调用方式
      let res;

      // 方式1: 尝试 im.v1.image.create
      try {
        console.log('[Feishu] Trying upload method 1: im.v1.image.create');
        res = await this.client.im.v1.image.create({
          data: {
            image_type: 'message',
            image: imageFile,
          },
        });
        console.log('[Feishu] Method 1 success');
      } catch (e1) {
        console.log('[Feishu] Method 1 failed:', e1.message);

        // 方式2: 尝试 im.image.create (不带 v1)
        try {
          console.log('[Feishu] Trying upload method 2: im.image.create');
          res = await this.client.im.image.create({
            data: {
              image_type: 'message',
              image: imageFile,
            },
          });
          console.log('[Feishu] Method 2 success');
        } catch (e2) {
          console.log('[Feishu] Method 2 failed:', e2.message);
          throw e1; // 抛出第一个错误
        }
      }

      console.log('[Feishu] Upload API response:', JSON.stringify(res, null, 2));

      // 检查响应格式 - 可能直接返回 image_key，也可能是标准格式
      let imageKey;
      if (res.image_key) {
        // 直接返回 image_key 的格式
        imageKey = res.image_key;
      } else if (res.code === 0 && res.data) {
        // 标准格式
        imageKey = res.data?.image_key || res.data?.image?.image_key;
      } else if (res.code !== undefined && res.code !== 0) {
        // 有错误码
        throw new Error('Failed to upload image: ' + (res.msg || JSON.stringify(res)));
      } else {
        // 其他格式，尝试提取
        imageKey = res.data?.image_key || res.data?.image?.image_key || res.image_key;
      }

      if (!imageKey) {
        throw new Error('No image_key found in response: ' + JSON.stringify(res));
      }

      console.log('[Feishu] Image uploaded, image_key:', imageKey);

      // 存入缓存
      this._imageKeyCache.set(imagePath, {
        imageKey,
        timestamp: Date.now()
      });

      return imageKey;
    } catch (error) {
      console.error('[Feishu] Upload image error:', error.message);
      if (error.response) {
        console.error('[Feishu] Error response:', JSON.stringify(error.response, null, 2));
      }
      console.error('[Feishu] Upload error stack:', error.stack);
      throw error;
    }
  }

  /**
   * 发送图片消息
   * @param {string} chatId - 聊天 ID
   * @param {string} imageKey - 飞书 image_key
   */
  async sendImageMessage(chatId, imageKey) {
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: buildImageContent(imageKey),
        },
      });

      if (res.code !== 0) {
        throw new Error('Failed to send image message: ' + res.msg);
      }

      console.log('[Feishu] Image message sent');
      return res;
    } catch (error) {
      console.error('[Feishu] Send image message error:', error.message);
      throw error;
    }
  }

  /**
   * 检测内容中的本地图片并发送
   * @param {string} chatId - 聊天 ID
   * @param {string} text - 文本内容
   */
  async sendLocalImagesFromContent(chatId, text) {
    try {
      console.log('[Feishu] sendLocalImagesFromContent called, chatId:', chatId);
      console.log('[Feishu] Content to check for images:', text);

      const imagePaths = extractLocalImagePaths(text);

      if (imagePaths.length === 0) {
        console.log('[Feishu] No local images found in content');
        return;
      }

      console.log('[Feishu] Found ' + imagePaths.length + ' local image(s) to send:', imagePaths);

      for (const imagePath of imagePaths) {
        try {
          console.log('[Feishu] Processing image:', imagePath);
          const imageKey = await this.uploadImage(imagePath);
          console.log('[Feishu] Uploaded image, key:', imageKey);
          await this.sendImageMessage(chatId, imageKey);
          console.log('[Feishu] Image sent successfully');
        } catch (e) {
          console.error('[Feishu] Failed to send image ' + imagePath + ':', e.message);
          // 继续发送下一张图片，不因单张失败而中断
        }
      }
    } catch (error) {
      console.error('[Feishu] Send local images error:', error.message);
      // 不抛出错误，避免影响主消息发送
    }
  }

  /**
   * 主动发送消息 (供外部调用)
   */
  async send(chatId, text) {
    if (!this.client) {
      throw new Error('[Feishu] Not initialized');
    }
    const res = await this.sendCardMessage(chatId, text);
    // 发送文本后，检测并发送本地图片
    await this.sendLocalImagesFromContent(chatId, text);
    return res;
  }

  /**
   * 广播消息到通知渠道
   */
  async broadcast(text) {
    if (this.notificationChatId) {
      return this.send(this.notificationChatId, text);
    }

    // 如果没有配置通知群，则发送给所有活跃会话
    const chatIds = Object.keys(this._chatSessionMap);
    if (chatIds.length === 0) {
      console.warn('[Feishu] No active chats or notification_chat_id configured for broadcast');
      return;
    }

    console.log(`[Feishu] Broadcasting to ${chatIds.length} active chats`);
    return Promise.all(chatIds.map(id => this.send(id, text)));
  }
}

export default FeishuService;