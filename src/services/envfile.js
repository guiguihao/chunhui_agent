/**
 * .env 文件的读写原语
 *
 * 为什么单独成模块：`env_*` 工具（给模型用）与 WebUI 的 /api/env（给人用）
 * 必须遵守完全一致的引号/转义规则，否则「界面保存的值」与「工具读到的值」会不一致。
 * 这里只做纯文本处理，不碰文件系统，便于单测。
 *
 * 关键约定（dotenv 语义）：
 *   - 只剥离最外层引号，不处理反斜杠转义，因此写入时绝不能自行加反斜杠；
 *   - 值里含空格、`#`、引号时必须加引号，否则 `#` 之后会被当成注释而静默截断；
 *   - 同名键以「最后一次出现」为准，因此读取取最后一条，写入则更新所有同名行。
 */

/** 合法的环境变量名（dotenv 与本工具都只接受这个形状） */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isValidEnvKey(key) {
  return ENV_KEY_RE.test(String(key ?? ''));
}

/**
 * 将值格式化为可直接写入 .env 的字面量
 *
 * @param {string} value - 原始值
 * @returns {string} 可写入 .env 的字面量
 */
export function formatEnvValue(value) {
  const v = value ?? '';
  if (v === '') return '';
  if (!/[\s#'"`]/.test(v)) return v;

  // dotenv 只剥离最外层引号、不处理反斜杠转义，所以挑一个值里不存在的引号来包裹
  if (!v.includes('"')) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;

  // 同时含单双引号：.env 格式无法无歧义表达，只能尽力而为
  console.warn('[EnvFile] .env 值同时包含单双引号，可能无法原样还原:', v);
  return `"${v}"`;
}

/**
 * 解析 `KEY=` 后面的原始字面量，还原为真实值
 *
 * 必须与 formatEnvValue 严格对称：只剥引号而不反转义。
 *
 * @param {string} raw - `=` 之后的部分
 * @returns {string} 还原后的值
 */
export function parseEnvValue(raw) {
  const v = String(raw ?? '').trim();
  if (v.length >= 2) {
    const quoted = (v.startsWith('"') && v.endsWith('"'))
      || (v.startsWith("'") && v.endsWith("'"));
    if (quoted) return v.slice(1, -1);
  }
  return v;
}

/**
 * 逐行拆解 .env，保留注释与空行（写回时原样输出）
 *
 * @param {string} text
 * @returns {Array<{ kind: 'raw'|'var', raw: string, key?: string, value?: string }>}
 */
export function parseEnvEntries(text) {
  return String(text ?? '').split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return { kind: 'raw', raw: line };
    const eq = line.indexOf('=');
    if (eq === -1) return { kind: 'raw', raw: line };
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) return { kind: 'raw', raw: line };
    return { kind: 'var', raw: line, key, value: parseEnvValue(line.slice(eq + 1)) };
  });
}

/**
 * 按出现顺序列出全部变量（同名键后者覆盖前者，与 dotenv 一致）
 *
 * @param {string} text
 * @returns {Array<{ key: string, value: string }>}
 */
export function listEnvEntries(text) {
  const order = [];
  const map = new Map();
  for (const e of parseEnvEntries(text)) {
    if (e.kind !== 'var') continue;
    if (!map.has(e.key)) order.push(e.key);
    map.set(e.key, e.value);
  }
  return order.map((key) => ({ key, value: map.get(key) }));
}

/**
 * 读取单个变量的值（以文件为准，不读 process.env）
 *
 * @param {string} text
 * @param {string} key
 * @returns {string|null} 不存在时返回 null
 */
export function getEnvValue(text, key) {
  const target = String(key);
  let found = null;
  for (const e of parseEnvEntries(text)) {
    if (e.kind === 'var' && e.key === target) found = e.value;
  }
  return found;
}

/**
 * 就地更新若干变量：命中行替换、未命中追加到末尾，注释与顺序保持不变
 *
 * @param {string} text - 原始内容
 * @param {Record<string, string>} updates - key → 新值（null/undefined 视为不改）
 * @returns {string} 新内容
 */
export function patchEnvVars(text, updates = {}) {
  const pending = new Map(
    Object.entries(updates).filter(([, v]) => v !== undefined && v !== null),
  );
  if (pending.size === 0) return String(text ?? '');

  const lines = String(text ?? '').split('\n');
  // 已在文件中出现过的键：即使改了也不能再追加到末尾。
  // 不能直接从 pending 里删——同名键可能有多行，删掉第一行后就改不到后面的了。
  const touched = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/);
    if (!m) continue;
    const key = m[2];
    if (!pending.has(key)) continue;
    // 同名键可能有多次定义：全部改写，避免 dotenv「后者生效」导致改了不生效
    lines[i] = `${m[1]}${key}=${formatEnvValue(pending.get(key))}`;
    touched.add(key);
  }

  let content = lines.join('\n');
  const toAppend = [...pending].filter(([key]) => !touched.has(key));
  if (toAppend.length > 0) {
    if (content && !content.endsWith('\n')) content += '\n';
    for (const [key, value] of toAppend) content += `${key}=${formatEnvValue(value)}\n`;
  }
  return content;
}

/**
 * 删除指定变量（删掉整行，含同名重复定义）
 *
 * @param {string} text - 原始内容
 * @param {string[]} keys - 待删除的变量名
 * @returns {{ text: string, removed: string[] }}
 */
export function deleteEnvVars(text, keys = []) {
  const targets = new Set(keys.map((k) => String(k)));
  const removed = new Set();
  const kept = [];

  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/);
    if (m && targets.has(m[1])) {
      removed.add(m[1]);
      continue;
    }
    kept.push(line);
  }

  return { text: kept.join('\n'), removed: [...removed] };
}

/**
 * 值掩码：列表场景不需要暴露明文，但要能看出「有没有配、大概多长」
 *
 * @param {string} value
 * @returns {string} 掩码后的展示串
 */
export function maskEnvValue(value) {
  const v = String(value ?? '');
  if (v === '') return '(空)';
  if (v.length <= 8) return '****';
  return `${v.slice(0, 3)}****${v.slice(-3)}`;
}
