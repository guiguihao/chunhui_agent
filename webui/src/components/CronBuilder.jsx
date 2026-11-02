import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Clock } from 'lucide-react'
import { useLanguage } from './LanguageContext'
import {
  CRON_MODES,
  WEEKDAY_ORDER,
  createCronForm,
  cronToForm,
  formToCron,
  isPastDate,
  todayString,
  validateCronForm,
} from '../lib/cron-form'
import './CronBuilder.css'

const MAX_MONTH_DAY = 31
const MONTH_DAYS = Array.from({ length: MAX_MONTH_DAY }, (_, i) => i + 1)

const weekdayLabel = (day, t) => t(`cron_wd_${day}`)

/**
 * 生成人话描述，用于确认「选择器到底表达了什么」
 * 只描述组件自己能反解的模式，custom 直接返回空串
 */
export function describeCronText(form, t) {
  switch (form.mode) {
    case 'daily':
      return t('cron_desc_daily', { time: form.time })
    case 'weekly': {
      const days = [...new Set(form.weekdays || [])]
        .sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b))
        .map((d) => weekdayLabel(d, t))
        .join(t('cron_list_sep'))
      return t('cron_desc_weekly', { days, time: form.time })
    }
    case 'monthly':
      return t('cron_desc_monthly', { day: form.monthDay, time: form.time })
    case 'yearly':
      return t('cron_desc_yearly', { date: form.date, time: form.time })
    case 'interval':
      return form.everyUnit === 'hour'
        ? t('cron_desc_interval_hour', { n: form.everyValue })
        : t('cron_desc_interval_minute', { n: form.everyValue })
    default:
      return ''
  }
}

/** 供列表页复用：把 cron 字符串翻译成人话（无法反解时返回空串） */
export function describeCron(cron, t) {
  const form = cronToForm(cron)
  return validateCronForm(form).ok ? describeCronText(form, t) : ''
}

/**
 * 可视化调度配置
 *
 * 对外只暴露 value（cron 字符串）/ onChange(cron)，内部维护选择器表单；
 * 因此 Scheduler、Heartbeat、保存校验等既有逻辑完全不需要改动。
 *
 * @param {object} props
 * @param {string} props.value - 当前 cron 表达式
 * @param {(cron: string) => void} props.onChange
 * @param {'daily'|'interval'} [props.defaultMode] - 空值时的初始模式
 * @param {boolean} [props.compact] - 心跳页里的紧凑版
 */
export default function CronBuilder({ value = '', onChange, defaultMode = 'daily', compact = false }) {
  const { t } = useLanguage()
  const [form, setForm] = useState(() => cronToForm(value, { preferMode: defaultMode }))
  // 记录最近一次由本组件发出的值，用于区分「外部更新」与「自身回流」
  const emittedRef = useRef(value)

  useEffect(() => {
    if (value === emittedRef.current) return
    emittedRef.current = value
    setForm(cronToForm(value, { preferMode: defaultMode }))
  }, [value, defaultMode])

  const emit = (next) => {
    setForm(next)
    const cron = formToCron(next)
    emittedRef.current = cron
    onChange?.(cron)
  }

  const patch = (fields) => emit({ ...createCronForm(), ...form, ...fields })

  const switchMode = (mode) => {
    if (mode === form.mode) return
    if (mode === 'custom') {
      // 保留当前表达式，避免切到自定义后内容凭空消失
      emit({ ...form, mode, custom: formToCron(form) || value || '' })
      return
    }
    const next = { ...form, mode }
    if (mode !== 'interval' && !/^\d{1,2}:\d{2}$/.test(String(next.time || ''))) {
      next.time = '09:00'
    }
    if (mode === 'weekly' && !(next.weekdays || []).length) next.weekdays = [1]
    if (mode === 'yearly' && !next.date) next.date = todayString()
    emit(next)
  }

  const toggleWeekday = (day) => {
    const current = new Set(form.weekdays || [])
    if (current.has(day)) current.delete(day)
    else current.add(day)
    patch({ weekdays: [...current].sort((a, b) => a - b) })
  }

  const validation = validateCronForm(form)
  const cron = formToCron(form)
  const description = validation.ok ? describeCronText(form, t) : ''
  const showPastDateHint = form.mode === 'yearly' && isPastDate(form.date)

  return (
    <div className={`cron-builder ${compact ? 'compact' : ''}`}>
      <div className="cron-modes" role="tablist" aria-label={t('cron_schedule')}>
        {CRON_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={form.mode === mode}
            className={`cron-mode-btn ${form.mode === mode ? 'active' : ''}`}
            onClick={() => switchMode(mode)}
          >
            {t(`cron_mode_${mode}`)}
          </button>
        ))}
      </div>

      <div className="cron-builder-row">
        {form.mode === 'interval' && (
          <>
            <label className="cron-field">
              <span className="cron-field-label">{t('cron_every')}</span>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max={form.everyUnit === 'hour' ? 23 : 59}
                className="form-input"
                value={form.everyValue}
                onChange={(e) => patch({ everyValue: e.target.value })}
              />
            </label>
            <label className="cron-field">
              <span className="cron-field-label">{t('cron_unit')}</span>
              <select
                className="form-input"
                value={form.everyUnit}
                onChange={(e) => patch({ everyUnit: e.target.value })}
              >
                <option value="minute">{t('cron_unit_minute')}</option>
                <option value="hour">{t('cron_unit_hour')}</option>
              </select>
            </label>
          </>
        )}

        {form.mode === 'custom' && (
          <label className="cron-field grow">
            <span className="cron-field-label">{t('cron_expr')}</span>
            <input
              className="form-input mono"
              value={form.custom}
              placeholder="0 9 * * *"
              onChange={(e) => patch({ custom: e.target.value })}
            />
            <span className="cron-inline-hint">{t('cron_custom_hint')}</span>
          </label>
        )}

        {form.mode === 'weekly' && (
          <div className="cron-field grow">
            <span className="cron-field-label">{t('cron_weekdays')}</span>
            <div className="cron-weekdays">
              {WEEKDAY_ORDER.map((day) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={(form.weekdays || []).includes(day)}
                  className={`cron-weekday ${(form.weekdays || []).includes(day) ? 'active' : ''}`}
                  onClick={() => toggleWeekday(day)}
                >
                  {weekdayLabel(day, t)}
                </button>
              ))}
            </div>
          </div>
        )}

        {form.mode === 'monthly' && (
          <label className="cron-field">
            <span className="cron-field-label">{t('cron_month_day')}</span>
            <select
              className="form-input"
              value={form.monthDay}
              onChange={(e) => patch({ monthDay: e.target.value })}
            >
              {MONTH_DAYS.map((day) => (
                <option key={day} value={day}>{day}</option>
              ))}
            </select>
          </label>
        )}

        {form.mode === 'yearly' && (
          <label className="cron-field">
            <span className="cron-field-label">{t('cron_date')}</span>
            <input
              type="date"
              className="form-input"
              value={form.date}
              onChange={(e) => patch({ date: e.target.value })}
            />
          </label>
        )}

        {form.mode !== 'interval' && form.mode !== 'custom' && (
          <label className="cron-field">
            <span className="cron-field-label">{t('cron_time')}</span>
            <input
              type="time"
              step="60"
              className="form-input"
              value={form.time}
              onChange={(e) => patch({ time: e.target.value })}
            />
          </label>
        )}
      </div>

      {form.mode === 'yearly' && (
        <p className="cron-note">
          <Clock size={12} />
          {t('cron_date_hint')}
          {showPastDateHint && ` ${t('cron_past_date_hint')}`}
        </p>
      )}

      <div className={`cron-output ${validation.ok ? '' : 'invalid'}`}>
        {validation.ok
          ? <CheckCircle2 size={13} className="cron-output-icon ok" />
          : <AlertCircle size={13} className="cron-output-icon err" />}
        <code>{cron || '—'}</code>
        <span className="cron-output-desc">
          {validation.ok ? description : t(`cron_err_${validation.code}`)}
        </span>
      </div>
    </div>
  )
}
