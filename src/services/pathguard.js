import path from 'path';
import os from 'os';

/**
 * 文件访问安全策略（统一入口）
 *
 * 背景：此前 project 存在三份互相漂移的路径校验实现：
 *   - src/services/coreagent.js  _handleFileTool（只校验写操作，读操作裸奔）
 *   - plugin/webui.js            /api/file（workspace + ~/.miot-mcp）
 *   - plugin/webui.js            /api/memory（memory 目录）
 * 三者均使用 startsWith() 做前缀比较，存在 "workspace-evil" 类绕过风险。
 *
 * 本模块统一收敛为「先拒绝敏感文件 → 再按根目录白名单放行」的两段式判定，
 * 且所有包含性判断一律使用 path.relative()，杜绝前缀比较绕过。
 */

/** 媒体后缀：非工作目录中仅允许读取这类资源（二维码、设备图片等） */
const MEDIA_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

/** 敏感后缀：一律拒绝，无论位于哪个目录 */
const SENSITIVE_EXTS = new Set([
  '.key', '.pem', '.p12', '.pfx', '.crt', '.cer', '.jks',
  '.db', '.sqlite', '.sqlite3',
]);

/** 敏感目录片段：路径中包含即拒绝 */
const SENSITIVE_DIRS = ['/.git/', '/.ssh/', '/.aws/'];

/** 敏感文件名（basename）规则 */
const SENSITIVE_BASENAME_RES = [
  /^\.env/,                        // .env / .env.local / .env.production ...
  /^\.npmrc$/, /^\.netrc$/,        // 包管理器凭据
  /^id_(rsa|dsa|ecdsa|ed25519)$/,  // SSH 私钥
];

/** 敏感文件名包含规则 */
const SENSITIVE_NAME_RES = [
  /credential/i,
  /secret/i,
  /token/i,
  /auth_data/i,
];

/**
 * 判断目标路径是否为受保护的敏感文件/目录
 * @param {string} target - 绝对路径
 * @returns {boolean}
 */
export function isSensitive(target) {
  const resolved = path.resolve(target);
  const lower = resolved.toLowerCase();
  const base = path.basename(resolved).toLowerCase();

  if (SENSITIVE_DIRS.some(d => lower.includes(d))) return true;
  if (SENSITIVE_EXTS.has(path.extname(base))) return true;
  if (SENSITIVE_BASENAME_RES.some(re => re.test(base))) return true;
  if (SENSITIVE_NAME_RES.some(re => re.test(base))) return true;

  return false;
}

/**
 * 判断 target 是否位于 root 内部
 * 使用 path.relative() 而非 startsWith()，避免 "/workspace-evil" 绕过 "/workspace"
 *
 * @param {string} root - 根目录绝对路径
 * @param {string} target - 待判定路径
 * @param {boolean} [includeSelf=false] - target 恰好等于 root 时是否算通过。
 *        列举/存在性判断文件根目录时需要为 true（如 file_list 默认 path="."）。
 * @returns {boolean}
 */
export function isInside(root, target, includeSelf = false) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return includeSelf;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 是否为媒体文件
 * @param {string} target
 * @returns {boolean}
 */
export function isMediaFile(target) {
  return MEDIA_EXTS.has(path.extname(target).toLowerCase());
}

/**
 * 默认「仅允许读取媒体文件」的目录。
 * 数据来源：对 sessions/ 中实际出现的图片路径统计，米家二维码目录占比最高，
 * 若整目录放行会导致米家 auth_data.json 等凭据可被读取，故限定为媒体只读。
 */
export function defaultMediaOnlyRoots() {
  return [
    path.join(os.homedir(), '.miot-mcp'),
    path.join(os.homedir(), '.cache', 'samrthomeaegnt'),
  ];
}

const ALLOW = Symbol('allow');
const ok = (resolvedPath) => ({ ok: true, resolvedPath });
const deny = (resolvedPath, reason) => ({ ok: false, resolvedPath, reason });

/**
 * 文件访问策略
 *
 * 规则：
 *   1. 任何路径先过敏感黑名单（黑名单优先，位于白名单目录内也不放行）
 *   2. 写操作：仅限 workspaceDir
 *   3. 读操作：workspaceDir 内全部允许；mediaOnlyRoots 内仅允许媒体文件；
 *      readRoots 内全部允许
 */
export class FileAccessPolicy {
  /**
   * @param {object} opts
   * @param {string} opts.workspaceDir - 工作目录（唯一可写根目录）
   * @param {string[]} [opts.readRoots] - 额外只读根目录（全部类型文件）
   * @param {string[]} [opts.mediaOnlyRoots] - 额外只读根目录（仅媒体文件）
   */
  constructor({ workspaceDir, readRoots = [], mediaOnlyRoots } = {}) {
    this.workspaceDir = path.resolve(workspaceDir || path.join(process.cwd(), 'workspace'));

    this.readRoots = [...new Set([
      this.workspaceDir,
      ...readRoots.map(r => path.resolve(r)),
    ])];

    this.mediaOnlyRoots = [...new Set(
      (mediaOnlyRoots || defaultMediaOnlyRoots()).map(r => path.resolve(r))
    )];
  }

  /**
   * 解析原始路径：绝对路径直接用，相对路径基于 workspace 解析
   * @param {string} rawPath
   * @returns {string} 规范化后的绝对路径
   */
  resolve(rawPath) {
    const raw = rawPath || '.';
    return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(this.workspaceDir, raw);
  }

  /** 所有可读根目录（用于错误信息中提示模型自助纠正） */
  readableRoots() {
    return [...this.readRoots, ...this.mediaOnlyRoots];
  }

  /**
   * 校验读操作
   * @param {string} rawPath
   * @returns {{ok: boolean, resolvedPath: string, reason?: string}}
   */
  allowRead(rawPath) {
    const resolved = this.resolve(rawPath);

    if (isSensitive(resolved)) {
      return deny(resolved, '操作拒绝: 禁止访问系统核心配置文件或密钥凭据。');
    }

    // 根目录自身允许（file_list(".") / file_exists(".") 需要）
    if (isInside(this.workspaceDir, resolved, true)) return ok(resolved);

    for (const root of this.mediaOnlyRoots) {
      if (isInside(root, resolved)) {
        if (!isMediaFile(resolved)) {
          return deny(resolved,
            `操作拒绝: 目录 ${root} 仅限读取图片资源（png/jpg/jpeg/gif/webp/svg）。`);
        }
        return ok(resolved);
      }
    }

    for (const root of this.readRoots) {
      if (isInside(root, resolved)) return ok(resolved);
    }

    return deny(resolved,
      `操作拒绝: 仅允许读取以下目录内的文件 -> ${this.readableRoots().join(' | ')}`);
  }

  /**
   * 校验写操作（含新建/追加/删除/编辑）
   * @param {string} rawPath
   * @returns {{ok: boolean, resolvedPath: string, reason?: string}}
   */
  allowWrite(rawPath) {
    const resolved = this.resolve(rawPath);

    if (isSensitive(resolved)) {
      return deny(resolved, '操作拒绝: 禁止写入或删除系统核心配置文件与密钥凭据。');
    }

    if (!isInside(this.workspaceDir, resolved, true)) {
      return deny(resolved,
        `操作拒绝: 为保障安全，所有文件新建/修改/删除仅允许在工作目录 (${this.workspaceDir}) 内进行。`);
    }

    return ok(resolved);
  }
}

export default FileAccessPolicy;
