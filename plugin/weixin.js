import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { toSessionId } from '../src/services/coreagent.js';

/**
 * 微信 (Weixin) 插件
 *
 * 基于第三方 SDK `weixin-agent-sdk`（非微信官方协议，长轮询 getupdates）把个人微信
 * 接成一个消息渠道：入站消息走 agent.thinkAndAct()，定时任务/心跳告警走
 * MessengerBridge.broadcast() → bot.sendMessage()。
 *
 * 三个必须知道的约束（来自 SDK 实现，无法绕过）：
 *
 *   1. 单账号：accounts.json 每次登录都被覆写成 `[accountId]`，不能多号并存。
 *   2. 主动推送依赖 context_token：它由入站消息下发，只存在 SDK 进程内内存里，
 *      不落盘。因此「本进程启动后必须先在微信里给机器人发过一条消息」才能主动推送，
 *      重启后该能力失效，直到下一条入站消息到来（token 有效期约 24h）。
 *   3. 扫码登录由 SDK 的 login() 完成，但它把二维码直接打到终端、没有回调。
 *      本文件按同一协议自己实现了获取二维码 + 轮询状态（见 _fetchQrCode /
 *      _pollQrStatus），以便把二维码渲染成图片推给 WebUI；登录成功后仍按 SDK 的
 *      存储格式落盘，并通过 sdk.isLoggedIn() 回验，避免格式漂移导致「看着登录成功
 *      其实没登录」。
 */

/** 扫码相关接口的固定域名（SDK 内部同样硬编码，不接受 baseUrl 覆盖） */
const WEIXIN_API_BASE = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
/** 取二维码的客户端超时（与 SDK 一致） */
const QR_TIMEOUT_MS = 5000;
/** 扫码状态长轮询超时（与 SDK 一致） */
const STATUS_TIMEOUT_MS = 35000;
/** 整体扫码等待上限：8 分钟，与 SDK login() 的硬编码值一致 */
const LOGIN_TTL_MS = 8 * 60 * 1000;
/** 二维码最多自动刷新次数 */
const MAX_QR_REFRESH = 3;

/** 微信回复会被转成纯文本，必须禁用 Markdown 语法 */
const WEIXIN_SYSTEM_PROMPT = `用户在微信里给你发消息，微信不渲染 Markdown。

### 输出格式要求
- 不要使用 Markdown：标题 #、加粗 **、代码块 \`\`\`、表格 | 、分割线 --- 都会原样显示成符号。
- 用短句和换行组织内容；需要罗列时用「1. 2. 3.」或「- 」开头。
- 表格改写成逐行「项目：值」的形式。
- 单条回复尽量精简，长内容分点说明，不要堆砌。`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 账号 ID 规范化（与 SDK 的 normalizeAccountId 完全一致）
 *
 * 服务端返回的是 `xxx@im.bot` 形式的原始 ID，落盘前要转成文件名安全的
 * `xxx-im-bot`，否则 SDK 读取时找不到文件。
 *
 * @param {string} raw - 原始 ilink_bot_id
 * @returns {string} 规范化后的 accountId
 */
export function normalizeWeixinAccountId(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/[@.]/g, '-');
}

/**
 * 解析 SDK 的状态目录（与 SDK 的 resolveStateDir 一致）
 *
 * 必须逐字对齐：一旦这里和 SDK 的判定不同，我们写进去的凭据 SDK 读不到。
 *
 * @param {NodeJS.ProcessEnv} env - 环境变量
 * @param {string} homedir - 用户主目录
 * @returns {string} 状态根目录
 */
export function resolveWeixinStateDir(env = process.env, homedir = os.homedir()) {
  return env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim() || path.join(homedir, '.openclaw');
}

/**
 * 把媒体消息拼成模型能看懂的文本提示
 *
 * SDK 已经把媒体下载解密到本地临时文件，模型看不到二进制，
 * 因此把类型和本地路径告诉它，需要时可用 file_* 工具去读。
 *
 * @param {string} text - 用户文本
 * @param {{type:string, filePath:string, fileName?:string}} media - 媒体信息
 * @returns {string} 拼装后的 prompt
 */
export function buildWeixinPrompt(text, media) {
  const body = String(text ?? '').trim();
  if (!media?.filePath) return body;

  const label = { image: '图片', audio: '语音', video: '视频', file: '文件' }[media.type] || '文件';
  const name = media.fileName ? `（文件名：${media.fileName}）` : '';
  const hint = `[用户发送了${label}${name}，已保存到本地：${media.filePath}]`;
  return body ? `${body}\n\n${hint}` : hint;
}

class WeixinService {
  /**
   * @param {object} config - plugin.yaml 中的 plugins.weixin
   * @param {object} agent - SmartHomeAgent 实例（提供 thinkAndAct 与内部的 CoreAgent）
   * @param {object} options - 测试注入用
   */
  constructor(config = {}, agent, options = {}) {
    this.enabled = config?.enabled !== false;
    // 微信里只有一个对话对象，auto_reply 保留是与其他渠道保持一致的语义
    this.autoReply = config?.auto_reply !== false;
    this.agent = agent;

    // 主动推送目标：默认就是扫码登录的微信用户，可由配置覆盖
    this.notificationUserId = config?.notification_user_id || '';

    this.stateDir = options.stateDir || resolveWeixinStateDir();
    this.weixinStateDir = path.join(this.stateDir, 'openclaw-weixin');

    this.apiBaseUrl = WEIXIN_API_BASE;
    this._sdk = null;

    this.bot = null;
    this._abort = null;
    this._running = false;
    this._accountId = null;

    this._lastInboundAt = 0;
    this._lastError = null;
    this._lastOutboundAt = 0;

    /** 进行中的扫码会话：{ qrcode, qr, qrUrl, status, message, startedAt, deadline, apiBase } */
    this._login = null;
    this._loginLoop = null;
    /** 登录会话编号：改号即让旧的轮询循环作废 */
    this._loginSeq = 0;
  }

  /**
   * 动态加载 SDK
   *
   * 用动态 import 而不是顶层静态 import：SDK 要求 Node >= 22，
   * 静态导入会让未启用微信的部署也一起受这个约束牵连（直接启动失败）。
   */
  async _loadSdk() {
    if (!this._sdk) this._sdk = await import('weixin-agent-sdk');
    return this._sdk;
  }

  /** 读取账号索引与凭据文件（只读，不依赖 SDK，用于状态展示） */
  async _readAccount() {
    try {
      const raw = await fs.readFile(path.join(this.weixinStateDir, 'accounts.json'), 'utf8');
      const ids = JSON.parse(raw);
      const accountId = Array.isArray(ids) ? ids.find((id) => typeof id === 'string' && id.trim()) : null;
      if (!accountId) return null;

      const file = path.join(this.weixinStateDir, 'accounts', `${accountId}.json`);
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      return { accountId, userId: data?.userId || '', token: data?.token || '', baseUrl: data?.baseUrl || '' };
    } catch {
      return null;
    }
  }

  /**
   * 当前状态快照（WebUI 渠道管理页轮询这个结构）
   */
  async snapshot() {
    const account = await this._readAccount();
    const login = this._login;
    return {
      enabled: this.enabled,
      loggedIn: Boolean(account?.token),
      running: this._running,
      accountId: account?.accountId || this._accountId || null,
      // context_token 只在收到过入站消息后才存在，否则主动推送会失败
      canPush: Boolean(this._lastInboundAt),
      lastInboundAt: this._lastInboundAt || null,
      lastOutboundAt: this._lastOutboundAt || null,
      lastError: this._lastError,
      login: login
        ? {
          status: login.status,
          message: login.message,
          qr: login.qr,
          qrUrl: login.qrUrl,
          startedAt: login.startedAt,
        }
        : null,
    };
  }

  /**
   * 启动渠道：已登录才拉起长轮询，未登录时静默跳过（等用户在 WebUI 扫码）
   */
  async start() {
    if (!this.enabled) {
      console.log('[Weixin] Disabled, skipping...');
      return;
    }

    const account = await this._readAccount();
    if (!account?.token || !account?.userId) {
      console.log('[Weixin] 未登录（或缺少 userId），等待在 WebUI 渠道管理中扫码连接');
      return;
    }
    await this._startBot();
  }

  /**
   * 拉起 SDK 的 monitor（长轮询）
   */
  async _startBot() {
    if (this.bot) return;

    let sdk;
    try {
      sdk = await this._loadSdk();
    } catch (e) {
      this._lastError = `加载 weixin-agent-sdk 失败: ${e.message}`;
      console.error('[Weixin]', this._lastError);
      return;
    }

    this._abort = new AbortController();
    try {
      const bot = sdk.start(this._buildAgent(), {
        abortSignal: this._abort.signal,
        log: (msg) => console.log(`[Weixin] ${msg}`),
      });

      this.bot = bot;
      this._running = true;
      this._lastError = null;
      console.log('[Weixin] ✅ 长轮询已启动');

      // wait() 在 abort 时正常返回；非 abort 错误要显式记录下来
      bot.wait()
        .catch((err) => {
          if (this._abort?.signal.aborted) return;
          this._lastError = err?.message || String(err);
          console.error('[Weixin] 监听循环异常退出:', this._lastError);
        })
        .finally(() => {
          if (this.bot === bot) {
            this.bot = null;
            this._running = false;
          }
        });
    } catch (e) {
      this.bot = null;
      this._running = false;
      this._lastError = e.message || String(e);
      console.error('[Weixin] 启动失败:', this._lastError);
    }
  }

  /**
   * SDK 需要的 Agent 实现：入站消息 → agent.thinkAndAct()
   */
  _buildAgent() {
    return {
      chat: (request) => this._chat(request),
      // SDK 收到 /clear 这类指令时会回调，这里重置该会话历史
      clearSession: (conversationId) => this._clearSession(conversationId),
    };
  }

  _sessionIdFor(conversationId) {
    // 会话 ID 带 weixin_ 前缀，避免和 webui_/feishu_/cron_ 混在同一份历史里
    return toSessionId('weixin', conversationId || 'default');
  }

  async _clearSession(conversationId) {
    try {
      const coreAgent = this.agent?.agent;
      const sessionId = this._sessionIdFor(conversationId);
      if (typeof coreAgent?.clearHistory === 'function') {
        await coreAgent.clearHistory(sessionId);
        console.log(`[Weixin] 会话已清空: ${sessionId}`);
      }
    } catch (e) {
      console.warn('[Weixin] 清空会话失败:', e.message);
    }
  }

  /**
   * 处理一条入站消息
   *
   * 返回值交给 SDK 发送；SDK 会把 Markdown 转成纯文本，这里无需预处理。
   */
  async _chat(request) {
    const conversationId = request?.conversationId || 'default';
    const prompt = buildWeixinPrompt(request?.text, request?.media);

    // 有入站消息意味着 SDK 已缓存 context_token，主动推送从此可用
    this._lastInboundAt = Date.now();

    if (!prompt) return { text: '收到，但这条消息里没有可识别的内容~' };

    console.log(`[Weixin] 📨 ${conversationId}: ${prompt.substring(0, 80)}`);

    try {
      const result = await this.agent.thinkAndAct(prompt, {
        sessionId: this._sessionIdFor(conversationId),
        appendSystemPrompt: WEIXIN_SYSTEM_PROMPT,
      });
      const reply = result?.reply || result?.response;
      return { text: (reply && String(reply).trim()) || '收到！' };
    } catch (e) {
      this._lastError = e.message;
      console.error('[Weixin] AI 处理失败:', e.message);
      return { text: '抱歉，我这边处理出错了，稍后再试一次吧。' };
    }
  }

  /**
   * MessengerBridge 渠道接口：主动发送（定时任务 / 心跳告警）
   *
   * 绝不能让异常冒泡：MessengerBridge.broadcast 用 Promise.all 汇总各渠道，
   * 一个渠道 reject 会让整轮广播被视为失败。
   */
  async broadcast(text) {
    if (!this.bot) {
      console.warn('[Weixin] 未连接，跳过广播');
      return false;
    }
    try {
      await this.bot.sendMessage(text);
      this._lastOutboundAt = Date.now();
      console.log('[Weixin] 📤 广播已发送');
      return true;
    } catch (e) {
      const msg = e?.message || String(e);
      // 这条提示是使用约束，不是 bug：SDK 要求先有入站消息才有 context_token
      if (msg.includes('context_token')) {
        console.warn('[Weixin] 主动推送失败：需先在微信里给机器人发一条消息（context_token 未缓存）');
      } else {
        console.error('[Weixin] 广播失败:', msg);
      }
      this._lastError = msg;
      return false;
    }
  }

  /**
   * 发消息给指定用户（MessengerBridge.send 的接口，微信只有一个对话对象）
   */
  async send(_chatId, text) {
    if (!this.bot) throw new Error('[Weixin] 未连接');
    await this.bot.sendMessage(text);
    this._lastOutboundAt = Date.now();
  }

  async stop() {
    if (this._abort) {
      try { this._abort.abort(); } catch { /* ignore */ }
      this._abort = null;
    }
    this.bot = null;
    this._running = false;
    console.log('[Weixin] Stopped');
  }

  // ────────────────────────────────────────────
  // 扫码登录
  // ────────────────────────────────────────────

  /**
   * 发起扫码登录：取二维码 → 渲染成图片 → 后台轮询扫码状态
   *
   * @returns {Promise<object>} 登录快照（含 qr / status）
   */
  async startLogin() {
    if (!this.enabled) {
      return { ...(await this.snapshot()), login: null, error: '微信渠道未启用（config/plugin.yaml → plugins.weixin.enabled）' };
    }

    // 已在扫码中：直接回放当前二维码，避免反复刷新把用户刚扫的码作废
    if (this._loginLoop && this._login && ['wait', 'scaned', 'expired'].includes(this._login.status)) {
      return this.snapshot();
    }

    // 每次登录分配一个编号：旧循环在 await 之后发现编号变了会自行退出，
    // 避免 React StrictMode 双挂载 / 重复点击时两个循环同时轮询同一个二维码
    const seq = ++this._loginSeq;
    this._login = null;
    try {
      const qr = await this._fetchQrCode();
      if (seq !== this._loginSeq) return this.snapshot();
      this._login = {
        qrcode: qr.qrcode,
        qrUrl: qr.url,
        qr: await this._renderQr(qr.url),
        status: 'wait',
        message: '请使用微信扫描二维码',
        startedAt: Date.now(),
        deadline: Date.now() + LOGIN_TTL_MS,
        apiBase: WEIXIN_API_BASE,
        refreshCount: 0,
      };
      if (seq !== this._loginSeq) return this.snapshot();
    } catch (e) {
      this._lastError = e.message;
      console.error('[Weixin] 获取二维码失败:', e.message);
      return {
        ...(await this.snapshot()),
        login: { status: 'error', message: `获取二维码失败: ${e.message}`, qr: null, qrUrl: null },
      };
    }

    this._loginLoop = this._runLoginLoop(seq)
      .catch((e) => {
        console.error('[Weixin] 登录流程异常:', e.message);
        if (seq === this._loginSeq && this._login) {
          this._login.status = 'error';
          this._login.message = e.message;
        }
      })
      .finally(() => { if (seq === this._loginSeq) this._loginLoop = null; });

    return this.snapshot();
  }

  /**
   * 轮询扫码状态直到确认/超时
   *
   * 状态机与 SDK 的 waitForWeixinLogin 一致：
   * wait → scaned → confirmed / expired（刷新，最多 3 次）/ scaned_but_redirect（切 host）
   */
  async _runLoginLoop(seq) {
    while (seq === this._loginSeq && this._login && Date.now() < this._login.deadline) {
      const login = this._login;
      const resp = await this._pollQrStatus(login.apiBase, login.qrcode);
      // 期间用户关了弹窗或重新发起登录：本循环作废，别再改状态
      if (seq !== this._loginSeq) return;

      const status = resp?.status;

      if (status === 'scaned') {
        login.status = 'scaned';
        login.message = '已扫码，请在手机微信中确认';
      } else if (status === 'scaned_but_redirect') {
        // IDC 重定向：后续轮询要换到服务端指定的主机
        if (resp.redirect_host) login.apiBase = `https://${resp.redirect_host}`;
      } else if (status === 'expired') {
        login.refreshCount += 1;
        if (login.refreshCount > MAX_QR_REFRESH) {
          login.status = 'timeout';
          login.message = '二维码多次过期，请重新点击连接';
          return;
        }
        try {
          const qr = await this._fetchQrCode();
          login.qrcode = qr.qrcode;
          login.qrUrl = qr.url;
          login.qr = await this._renderQr(qr.url);
          login.status = 'expired';
          login.message = `二维码已过期，已自动刷新（${login.refreshCount}/${MAX_QR_REFRESH}）`;
          console.log('[Weixin] 🔄 二维码已刷新');
        } catch (e) {
          login.status = 'error';
          login.message = `刷新二维码失败: ${e.message}`;
          return;
        }
      } else if (status === 'confirmed') {
        await this._finishLogin(resp, seq);
        return;
      }

      await sleep(1000);
    }

    // cancelled 是用户主动关闭弹窗，不能被改写成「超时」
    if (seq === this._loginSeq && this._login && !['connected', 'cancelled'].includes(this._login.status)) {
      this._login.status = 'timeout';
      this._login.message = '登录超时，请重新点击连接';
    }
  }

  /**
   * 扫码确认后：落盘凭据 → 用 SDK 回验 → 拉起长轮询
   */
  async _finishLogin(resp, seq) {
    const fail = (message) => {
      if (seq === this._loginSeq && this._login) {
        this._login.status = 'error';
        this._login.message = message;
      }
      console.error('[Weixin]', message);
    };

    const token = resp?.bot_token;
    const rawId = resp?.ilink_bot_id;
    if (!token || !rawId) {
      fail('登录失败：服务端未返回 bot_token / ilink_bot_id');
      return;
    }

    const accountId = normalizeWeixinAccountId(rawId);
    try {
      await this._saveAccount(accountId, {
        token,
        baseUrl: resp.baseurl,
        userId: resp.ilink_user_id,
      });
    } catch (e) {
      fail(`保存凭据失败: ${e.message}`);
      return;
    }

    // 回验：文件格式一旦与 SDK 预期不符，这里能立刻发现而不是等到发消息才失败
    let verified = false;
    try {
      const sdk = await this._loadSdk();
      verified = sdk.isLoggedIn();
    } catch (e) {
      fail(`加载 weixin-agent-sdk 失败: ${e.message}`);
      return;
    }

    if (!verified) {
      fail(`凭据已写入（${accountId}），但 SDK 未能识别，请检查状态目录：${this.stateDir}`);
      return;
    }

    this._accountId = accountId;
    if (seq === this._loginSeq && this._login) {
      this._login.status = 'connected';
      this._login.message = '✅ 已连接微信';
    }
    console.log(`[Weixin] ✅ 登录成功，account=${accountId}`);

    await this._startBot();
  }

  /**
   * 退出登录：停止监听并清空本地凭据
   */
  async logout() {
    await this.stop();
    this._login = null;
    this._loginLoop = null;

    try {
      const sdk = await this._loadSdk();
      sdk.logout({ log: (msg) => console.log(`[Weixin] ${msg}`) });
    } catch (e) {
      // SDK 不可用（例如 Node 版本过低）时退化为直接删文件
      console.warn('[Weixin] SDK logout 失败，改为直接清理凭据:', e.message);
      await fs.rm(path.join(this.weixinStateDir, 'accounts'), { recursive: true, force: true });
      await fs.writeFile(path.join(this.weixinStateDir, 'accounts.json'), '[]', 'utf8').catch(() => {});
    }

    this._lastInboundAt = 0;
    this._accountId = null;
    return this.snapshot();
  }

  /**
   * 取消进行中的扫码（关闭弹窗时调用，避免后台白跑 8 分钟）
   */
  cancelLogin() {
    if (this._login && this._login.status !== 'connected') {
      this._login.status = 'cancelled';
      this._login.message = '已取消';
    }
    // 改编号让后台循环立刻失效：否则它还会继续长轮询这个已经没人看的二维码
    this._loginSeq += 1;
    this._loginLoop = null;
    return this._login;
  }

  // ────────────────────────────────────────────
  // 底层协议（与 weixin-agent-sdk 内部实现一致）
  // ────────────────────────────────────────────

  /** GET ilink/bot/get_bot_qrcode → { qrcode, qrcode_img_content } */
  async _fetchQrCode() {
    const url = `${WEIXIN_API_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(QR_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`get_bot_qrcode ${res.status}`);
    const data = await res.json();
    if (!data?.qrcode || !data?.qrcode_img_content) {
      throw new Error('get_bot_qrcode 返回缺少 qrcode / qrcode_img_content');
    }
    return { qrcode: data.qrcode, url: data.qrcode_img_content };
  }

  /** GET ilink/bot/get_qrcode_status → { status, bot_token, ilink_bot_id, ilink_user_id, baseurl } */
  async _pollQrStatus(baseUrl, qrcode) {
    try {
      const res = await fetch(
        `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) },
      );
      if (!res.ok) return { status: 'wait' };
      return await res.json();
    } catch {
      // 网关超时/网络抖动都当作「还没结果」继续等，与 SDK 行为一致
      return { status: 'wait' };
    }
  }

  /**
   * 把二维码内容渲染成 dataURL 图片
   *
   * 渲染失败不影响登录本身：返回 null，前端退化显示原始链接。
   */
  async _renderQr(text) {
    try {
      const mod = await import('qrcode');
      const QRCode = mod.default || mod;
      return await QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
    } catch (e) {
      console.warn('[Weixin] 二维码渲染失败，改用链接展示:', e.message);
      return null;
    }
  }

  /**
   * 按 SDK 的存储格式写入凭据
   *
   * 结构（见 weixin-agent-sdk src/auth/accounts.ts）：
   *   <stateDir>/openclaw-weixin/accounts.json      → ["<accountId>"]
   *   <stateDir>/openclaw-weixin/accounts/<id>.json → { token, baseUrl?, userId?, savedAt }
   * 文件权限 600，避免 token 被同机其他用户读到。
   */
  async _saveAccount(accountId, { token, baseUrl, userId } = {}) {
    const dir = path.join(this.weixinStateDir, 'accounts');
    await fs.mkdir(dir, { recursive: true });

    const file = path.join(dir, `${accountId}.json`);
    let prev = {};
    try { prev = JSON.parse(await fs.readFile(file, 'utf8')) || {}; } catch { /* 首次登录 */ }

    const data = { ...prev };
    if (token && String(token).trim()) data.token = String(token).trim();
    if (baseUrl && String(baseUrl).trim()) data.baseUrl = String(baseUrl).trim();
    if (userId) data.userId = String(userId);
    if (data.token) data.savedAt = new Date().toISOString();

    await fs.writeFile(file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => { });

    // 索引是单账号语义（SDK 每次登录都覆写整个数组）
    await fs.mkdir(this.weixinStateDir, { recursive: true });
    await fs.writeFile(
      path.join(this.weixinStateDir, 'accounts.json'),
      JSON.stringify([accountId], null, 2),
      'utf8',
    );
  }
}

export default WeixinService;
