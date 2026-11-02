// 5 字段 cron 校验（与后端 node-cron 能力对齐）
//
// 为什么前端必须校验：后端保存流程是「先写配置文件、再重建调度器」，
// cron.schedule() 遇到非法表达式会抛错 —— 此时旧配置已被覆盖、所有任务停摆，
// 且下次启动会因解析失败直接退出，用户只能手工改文件才能恢复。
// 浏览器里打错一个字符不应该造成这种代价，所以把错误拦在提交之前。

// [min, max]：分 时 日 月 周（周 0 与 7 都表示周日）
const CRON_FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

/**
 * 校验 5 字段 cron 表达式。
 * 支持：星号、单值 a、区间 a-b、步长（star/n、a-b/n、a/n）以及逗号分隔的列表组合。
 * @param {string} expr
 * @returns {boolean}
 */
export const isValidCron = (expr) => {
  const parts = String(expr ?? '').trim().split(/\s+/)
  if (parts.length !== 5) return false

  return parts.every((field, i) => {
    const [min, max] = CRON_FIELDS[i]
    // 拒绝空片段，例如 "0 9 * * ,"
    return field.split(',').every(seg => {
      const m = seg.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
      if (!m) return false

      const nums = m[1] === '*' ? [min, max] : m[1].split('-').map(Number)
      if (nums.some(n => !Number.isFinite(n) || n < min || n > max)) return false
      // 步长必须为正整数
      return !m[2] || Number(m[2]) > 0
    })
  })
}

export default isValidCron
