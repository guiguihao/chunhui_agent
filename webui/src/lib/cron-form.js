// 可视化调度配置 ↔ 5 段 Cron 的互转
//
// 只用纯函数实现，不依赖 React，便于用 node --test 直接回归：
// 页面上所有选择器最终都收敛成一个字符串写回 task.cron / heartbeat.interval，
// 后端调度逻辑（Scheduler / Heartbeat）完全不变。
//
// 5 段 cron 没有「年」字段，因此「指定日期」只能表达为「每年该月该日」，
// 这一点必须在 UI 上明确提示，不能让用户以为是一次性任务。

import { isValidCron } from './cron.js'

/** 支持的配置模式 */
export const CRON_MODES = ['daily', 'weekly', 'monthly', 'yearly', 'interval', 'custom']

/** 星期展示顺序：周一 → 周日（cron 里 0 表示周日） */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

const pad = (n) => String(n).padStart(2, '0')

/** 解析 HH:mm，返回 { h, min } 或 null */
export function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return null
  return { h, min }
}

/** 解析 YYYY-MM-DD，非法日期（如 2027-02-29）返回 null */
export function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const dt = new Date(Date.UTC(year, month - 1, day))
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null
  }
  return { year, month, day }
}

/** 所选日期是否已过去（仅用于提示，不阻止保存） */
export function isPastDate(value, now = new Date()) {
  const d = parseDate(value)
  if (!d) return false
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return new Date(d.year, d.month - 1, d.day) < today
}

/** 今天（本地时区）的 YYYY-MM-DD */
export function todayString(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 新建一份表单默认值
 * @param {object} [overrides]
 */
export function createCronForm(overrides = {}) {
  return {
    mode: 'daily',
    time: '09:00',
    weekdays: [1],
    monthDay: 1,
    date: todayString(),
    everyValue: 5,
    everyUnit: 'minute',
    custom: '',
    ...overrides,
  }
}

/**
 * 表单 → cron 表达式
 * 输入不完整/非法时返回 ''（调用方据此提示并拦截保存）
 * @param {object} form
 * @returns {string}
 */
export function formToCron(form = {}) {
  const mode = form.mode || 'daily'

  if (mode === 'custom') return String(form.custom ?? '').trim()

  if (mode === 'interval') {
    const n = Number(form.everyValue)
    if (!Number.isInteger(n) || n < 1) return ''
    if (form.everyUnit === 'hour') return n <= 23 ? `0 */${n} * * *` : ''
    return n <= 59 ? `*/${n} * * * *` : ''
  }

  const time = parseTime(form.time)
  if (!time) return ''

  if (mode === 'daily') return `${time.min} ${time.h} * * *`

  if (mode === 'weekly') {
    const days = [...new Set((form.weekdays || []).map(Number))]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b)
    if (days.length === 0) return ''
    return `${time.min} ${time.h} * * ${days.join(',')}`
  }

  if (mode === 'monthly') {
    const day = Number(form.monthDay)
    if (!Number.isInteger(day) || day < 1 || day > 31) return ''
    return `${time.min} ${time.h} ${day} * *`
  }

  if (mode === 'yearly') {
    const date = parseDate(form.date)
    if (!date) return ''
    return `${time.min} ${time.h} ${date.day} ${date.month} *`
  }

  return ''
}

/**
 * cron 表达式 → 表单
 *
 * 只反解组件自己能生成的模式；其他合法写法（例如工作日区间、带步长的组合）
 * 一律落到 custom 模式并原样保留，避免「打开页面再保存就把用户的表达式改坏」。
 *
 * @param {string} cron
 * @param {{ preferMode?: string }} [options] - 空值时的默认模式（心跳默认 interval）
 */
export function cronToForm(cron, options = {}) {
  const base = createCronForm()
  const raw = String(cron ?? '').trim()
  const preferMode = CRON_MODES.includes(options.preferMode) ? options.preferMode : 'daily'

  if (!raw) return { ...base, mode: preferMode }

  const parts = raw.split(/\s+/)
  if (parts.length !== 5) return { ...base, mode: 'custom', custom: raw }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

  // 每 N 分钟
  const minuteStep = /^\*\/(\d+)$/.exec(minute)
  if (minuteStep && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const n = Number(minuteStep[1])
    if (n >= 1 && n <= 59) return { ...base, mode: 'interval', everyValue: n, everyUnit: 'minute' }
  }

  // 每 N 小时（整点触发）
  const hourStep = /^\*\/(\d+)$/.exec(hour)
  if (minute === '0' && hourStep && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const n = Number(hourStep[1])
    if (n >= 1 && n <= 23) return { ...base, mode: 'interval', everyValue: n, everyUnit: 'hour' }
  }

  const m = Number(minute)
  const h = Number(hour)
  if (!Number.isInteger(m) || !Number.isInteger(h) || m < 0 || m > 59 || h < 0 || h > 23) {
    return { ...base, mode: 'custom', custom: raw }
  }
  const time = `${pad(h)}:${pad(m)}`

  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return { ...base, mode: 'daily', time }
  }

  if (dayOfMonth === '*' && month === '*' && /^\d(,\d)*$/.test(dayOfWeek)) {
    const days = [...new Set(dayOfWeek.split(',').map(Number))]
    if (days.every((d) => d >= 0 && d <= 6)) {
      return { ...base, mode: 'weekly', time, weekdays: days.sort((a, b) => a - b) }
    }
  }

  if (/^\d{1,2}$/.test(dayOfMonth) && month === '*' && dayOfWeek === '*') {
    const day = Number(dayOfMonth)
    if (day >= 1 && day <= 31) return { ...base, mode: 'monthly', time, monthDay: day }
  }

  if (/^\d{1,2}$/.test(dayOfMonth) && /^\d{1,2}$/.test(month) && dayOfWeek === '*') {
    const day = Number(dayOfMonth)
    const mon = Number(month)
    if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
      return {
        ...base,
        mode: 'yearly',
        time,
        date: `${new Date().getFullYear()}-${pad(mon)}-${pad(day)}`,
      }
    }
  }

  return { ...base, mode: 'custom', custom: raw }
}

/**
 * 校验表单，返回 { ok, code }
 * code 用于 i18n 文案，避免在纯函数里拼中文
 */
export function validateCronForm(form = {}) {
  const mode = form.mode || 'daily'

  if (mode === 'custom') {
    return isValidCron(form.custom) ? { ok: true } : { ok: false, code: 'custom' }
  }

  if (mode === 'interval') {
    const n = Number(form.everyValue)
    const max = form.everyUnit === 'hour' ? 23 : 59
    if (!Number.isInteger(n) || n < 1 || n > max) return { ok: false, code: 'interval' }
    return { ok: true }
  }

  if (!parseTime(form.time)) return { ok: false, code: 'time' }

  if (mode === 'weekly' && (form.weekdays || []).length === 0) {
    return { ok: false, code: 'weekdays' }
  }

  if (mode === 'monthly') {
    const day = Number(form.monthDay)
    if (!Number.isInteger(day) || day < 1 || day > 31) return { ok: false, code: 'monthDay' }
  }

  if (mode === 'yearly' && !parseDate(form.date)) {
    return { ok: false, code: 'date' }
  }

  return { ok: true }
}

export default {
  CRON_MODES,
  WEEKDAY_ORDER,
  createCronForm,
  formToCron,
  cronToForm,
  validateCronForm,
  parseTime,
  parseDate,
  isPastDate,
  todayString,
}
