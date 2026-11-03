/**
 * 工具调用「文本标记」的识别与清洗（单一真相来源）
 *
 * 背景：部分模型（如 DeepSeek 系）在拿不到 tools 参数时会退化成把调用写成普通文本：
 *
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="mcp_ha-mcp_render_template">
 *   <｜｜DSML｜｜ parameter name="template" string="true">{% ... %}</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * 这类文本不会被 API 执行，却会作为 content 进入 finalResponse，
 * 最终被原样播报给用户（飞书/WebUI 都能看到一堆尖括号）。
 *
 * 处理策略：
 *   - parseToolCallMarkup()：能还原的标记还原成真正的 tool_calls，恢复功能；
 *   - stripToolCallMarkup()：还原不了（或本轮故意不给工具）时，至少把标记从可见文本里剔除。
 *
 * 注意全角竖线 U+FF5C「｜」与 ASCII「|」在日志里会混用，正则两种都要覆盖。
 */

const BAR = '[|｜]';

/** 单个 DSML 标签：<｜｜DSML｜｜ calls> / </｜｜DSML｜｜ parameter> */
const DSML_TAG = `<\\s*\\/?\\s*${BAR}{2}\\s*DSML\\s*${BAR}{2}[^<>]*>`;

/** DSML 调用的开始标签（用于截断未闭合的残块） */
const DSML_OPEN_CALLS = new RegExp(
  `<\\s*${BAR}{2}\\s*DSML\\s*${BAR}{2}\\s*calls\\s*>`,
  'i',
);

/** DSML 调用的结束标签 */
const DSML_CLOSE_CALLS = new RegExp(
  `<\\s*\\/\\s*${BAR}{2}\\s*DSML\\s*${BAR}{2}\\s*calls\\s*>`,
  'i',
);

/** DSML 的 invoke 标签（带或不带 DSML 前缀都认） */
const INVOKE_PREFIX = `(?:${BAR}{2}\\s*DSML\\s*${BAR}{2}\\s*)?`;

/**
 * 判断文本中是否存在工具调用标记
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasToolCallMarkup(text) {
  if (typeof text !== 'string' || !text) return false;
  return new RegExp(`${DSML_TAG}|<\\s*tool_calls?\\s*>|<\\s*invoke\\s|<${BAR}[^<>\\n]{1,40}${BAR}\\s*>`, 'i').test(text);
}

/**
 * 把纯文本形式的工具调用还原为 tool_calls 结构
 *
 * 只做「尽力还原」：解析不出来就返回空数组，调用方应退化为剥离文本。
 *
 * @param {string} text - 模型的 content
 * @returns {Array<{id:string,type:string,function:{name:string,arguments:string}}>}
 */
export function parseToolCallMarkup(text) {
  if (typeof text !== 'string' || !text) return [];

  const calls = [];
  const invokeRe = new RegExp(
    `<\\s*${INVOKE_PREFIX}invoke\\s+name\\s*=\\s*["']([^"']+)["'][^<>]*>([\\s\\S]*?)<\\s*\\/\\s*${INVOKE_PREFIX}invoke\\s*>`,
    'gi',
  );

  let m;
  while ((m = invokeRe.exec(text)) !== null) {
    const name = m[1].trim();
    if (!name) continue;
    calls.push(makeCall(name, parseParameters(m[2]), calls.length));
  }

  if (calls.length === 0) {
    // 另一种常见格式：<tool_call>{"name":"x","arguments":{...}}</tool_call>
    const jsonRe = /<\s*tool_calls?\s*>([\s\S]*?)<\s*\/\s*tool_calls?\s*>/gi;
    while ((m = jsonRe.exec(text)) !== null) {
      const parsed = safeJson(m[1].trim());
      if (!parsed) continue;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        const name = item?.name || item?.function?.name;
        if (!name) continue;
        const rawArgs = item?.arguments ?? item?.parameters ?? item?.function?.arguments ?? {};
        const args = typeof rawArgs === 'string' ? (safeJson(rawArgs) || {}) : rawArgs;
        calls.push(makeCall(String(name), args && typeof args === 'object' ? args : {}, calls.length));
      }
    }
  }

  return calls;
}

/**
 * 从可见文本中剔除工具调用标记（DSML / <tool_call> / invoke+parameter 等）
 *
 * @param {string} text - 模型输出
 * @returns {string} 清洗后的文本（可能为空串）
 */
export function stripToolCallMarkup(text) {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';

  let out = text;

  // 1. 成对的 DSML calls 块（可能跨多行，正文内容不能逐行删）
  out = out.replace(
    new RegExp(`<\\s*${BAR}{2}\\s*DSML\\s*${BAR}{2}\\s*calls\\s*>[\\s\\S]*?<\\s*\\/\\s*${BAR}{2}\\s*DSML\\s*${BAR}{2}\\s*calls\\s*>`, 'gi'),
    '',
  );

  // 2. 未闭合的 DSML 块（输出被截断）：从开标签起整段丢弃
  if (DSML_OPEN_CALLS.test(out) && !DSML_CLOSE_CALLS.test(out)) {
    out = out.slice(0, out.search(DSML_OPEN_CALLS));
  }

  // 3. <tool_call> / <tool_calls> / <function_calls> 块
  out = out.replace(/<\s*((?:tool_calls?)|(?:function_calls?))\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');

  // 4. invoke … /invoke 块（DSML 残留或无前缀的 XML 形式）
  out = out.replace(
    new RegExp(`<\\s*${INVOKE_PREFIX}invoke[^<>]*>[\\s\\S]*?<\\s*\\/\\s*${INVOKE_PREFIX}invoke\\s*>`, 'gi'),
    '',
  );

  // 5. 孤立的 parameter 块
  out = out.replace(
    new RegExp(`<\\s*${INVOKE_PREFIX}parameter[^<>]*>[\\s\\S]*?<\\s*\\/\\s*${INVOKE_PREFIX}parameter\\s*>`, 'gi'),
    '',
  );

  // 6. 逐行兜底：以标记开头的行整行丢弃（避免留下半截尖括号）
  out = out
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (new RegExp(`^<\\s*\\/?\\s*${BAR}{2}\\s*DSML`, 'i').test(t)) return false;
      if (/^<\/?\s*(tool_calls?|function_calls?|invoke|parameter)\b/i.test(t)) return false;
      if (new RegExp(`<${BAR}[^<>\\n]{1,40}${BAR}\\s*>`, 'i').test(t)) return false;
      return true;
    })
    .join('\n');

  // 7. 行内残留的特殊 token（<|channel|> / <｜tool_calls｜> 之类）
  out = out.replace(new RegExp(`<${BAR}[^<>\\n]{0,40}${BAR}\\s*>`, 'g'), '');

  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** 构造一条 tool_call 记录 */
function makeCall(name, args, idx) {
  return {
    id: `call_markup_${idx}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args && typeof args === 'object' ? args : {}),
    },
  };
}

/** 解析 invoke 体内的 parameter 标签 */
function parseParameters(body) {
  const args = {};
  if (!body) return args;

  const paramRe = new RegExp(
    `<\\s*${INVOKE_PREFIX}parameter\\s+name\\s*=\\s*["']([^"']+)["']([^<>]*)>([\\s\\S]*?)<\\s*\\/\\s*${INVOKE_PREFIX}parameter\\s*>`,
    'gi',
  );

  let m;
  while ((m = paramRe.exec(body)) !== null) {
    const key = m[1].trim();
    if (!key) continue;
    const attrs = m[2] || '';
    const rawValue = m[3].trim();
    // string="true" 表示值就是字面字符串（如 Jinja 模板），否则尝试按 JSON 解析出数字/布尔
    args[key] = /string\s*=\s*["']?true/i.test(attrs) ? rawValue : coerce(rawValue);
  }

  return args;
}

/** 非字符串标注的参数：能 JSON.parse 就用解析结果，否则保留原串 */
function coerce(raw) {
  if (raw === '') return '';
  const parsed = safeJson(raw);
  return parsed === undefined ? raw : parsed;
}

/** JSON.parse 的安全包装，失败返回 undefined */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export default stripToolCallMarkup;
