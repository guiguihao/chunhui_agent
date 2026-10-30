/**
 * 5 字段 cron 表达式校验
 *
 * 规则与前端 `webui/src/lib/cron.js` 完全一致（那边是浏览器模块，后端无法直接复用）。
 *
 * 为什么后端也必须校验：
 *   node-cron v4 接受 6 字段（带秒）表达式，而前端的表单只认 5 段。
 *   会话里由模型生成的 `mgmt_cron_add` 若不校验，就会出现
 *   「AI 能建、用户在 WebUI 一保存就报『表达式不合法』」的口径分裂，
 *   更糟的是 6 字段任务会真的按秒跑起来，成本与预期完全不符。
 *
 * 校验点：3 处入口统一 —— 会话工具（mgmt_cron_add）、WebUI 保存、前端表单。
 */

// [min, max]：分 时 日 月 周（周 0 与 7 都表示周日）
const CRON_FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/**
 * 校验 5 字段 cron 表达式
 * 支持：星号、单值 a、区间 a-b、步长（star/n、a-b/n、a/n）、逗号列表
 * @param {string} expr
 * @returns {boolean}
 */
export function isValidCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  // 空表达式会 split 成 ['']，直接拦掉
  if (parts[0] === '') return false;

  return parts.every((field, i) => {
    const [min, max] = CRON_FIELDS[i];
    return field.split(',').every(seg => {
      const m = seg.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!m) return false;

      const nums = m[1] === '*' ? [min, max] : m[1].split('-').map(Number);
      if (nums.some(n => !Number.isFinite(n) || n < min || n > max)) return false;
      // 步长必须为正整数
      return !m[2] || Number(m[2]) > 0;
    });
  });
}

/**
 * 生成可直接返回给模型/用户看的错误说明
 * @param {string} expr
 * @returns {string}
 */
export function cronValidationError(expr) {
  const raw = String(expr ?? '').trim();
  if (!raw) return '定时表达式不能为空（格式：分 时 日 月 周，例如 "0 9 * * *"）';

  const parts = raw.split(/\s+/);
  if (parts.length !== 5) {
    return `定时表达式必须是 5 段（分 时 日 月 周），当前 ${parts.length} 段："${raw}"。`
      + '注意不支持秒级 6 段表达式，请改用 5 段写法。';
  }
  return `定时表达式不合法："${raw}"。取值范围：分 0-59、时 0-23、日 1-31、月 1-12、周 0-7。`;
}

export default isValidCron;
