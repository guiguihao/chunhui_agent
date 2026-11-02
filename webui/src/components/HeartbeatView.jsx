import { useState, useEffect } from 'react'
import { Save, RefreshCw, Plus, Trash2, Heart } from 'lucide-react'
import { useLanguage } from './LanguageContext'
import { isValidCron } from '../lib/cron'
import CronBuilder, { DayRuleControl } from './CronBuilder'
import './PanelView.css'

// 检查项用本地稳定 _key 做 React key（name 可编辑且允许重复），提交前剥离
let uid = 0
const nextKey = () => `k${++uid}`
const withKeys = (checks = []) => (checks || []).map(c => ({ ...c, _key: nextKey() }))

export default function HeartbeatView() {
  const { t } = useLanguage()
  const [hb, setHb]           = useState({ enabled: true, interval: '*/10 * * * *', checks: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  // 哪些检查项开了「独立间隔」：不能直接看 interval 是否为空来判断，
  // 否则用户在可视化选择器里清空数值的瞬间，整个选择器会被卸载
  const [overrides, setOverrides] = useState(() => new Set())

  useEffect(() => {
    fetch('/api/heartbeat').then(r => r.json()).then(d => {
      const checks = withKeys(d.checks)
      setHb({ ...d, checks })
      setOverrides(new Set(checks.filter(c => c.interval).map(c => c._key)))
      setLoading(false)
    })
  }, [])

  const save = async () => {
    // interval 同样是 cron 表达式，且与 cron.yaml 一样是「先落盘再重建调度器」，
    // 非法值会让任务停摆并影响下次启动，必须在提交前拦掉
    if (!isValidCron(hb.interval)) {
      setSaveMsg(`${t('save_err')}${t('hb_interval')} — ${t('cron_invalid')}`)
      return
    }
    // 单项 interval 可留空（继承全局），填了就必须合法
    for (const chk of hb.checks || []) {
      const iv = (chk.interval || '').trim()
      // 开了「独立间隔」却没算出表达式（选择器输入不完整）时，不能静默降级成继承
      if (overrides.has(chk._key) && !iv) {
        setSaveMsg(`${t('save_err')}${t('hb_check_interval')} (${chk.name || t('hb_name')}) — ${t('cron_err_interval')}`)
        return
      }
      if (iv && !isValidCron(iv)) {
        setSaveMsg(`${t('save_err')}${t('hb_check_interval')} (${chk.name || t('hb_name')}) — ${t('cron_invalid')}`)
        return
      }
    }
    setSaving(true); setSaveMsg('')
    try {
      const payload = { ...hb, checks: (hb.checks || []).map(({ _key, ...chk }) => chk) }
      const r = await fetch('/api/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const d = await r.json()
      setSaveMsg(d.success ? t('save_ok') : `${t('save_err')}${d.error}`)
    } catch(e) { setSaveMsg(`${t('save_err')}${e.message}`) }
    finally { setSaving(false); setTimeout(() => setSaveMsg(''), 3000) }
  }

  const updateCheck = (key, field, val) =>
    setHb(prev => ({ ...prev, checks: (prev.checks || []).map(c => c._key === key ? { ...c, [field]: val } : c) }))

  const addCheck = () => setHb(prev => ({
    ...prev,
    checks: [
      ...(prev.checks || []),
      { _key: nextKey(), name: '', prompt: '', enabled: true, interval: '', weekend: 'any', holiday: 'any' },
    ],
  }))
  const removeCheck = (key) => {
    setHb(prev => ({ ...prev, checks: (prev.checks || []).filter(c => c._key !== key) }))
    setOverrides(prev => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  const toggleOverride = (key) => {
    const enabled = !overrides.has(key)
    setOverrides(prev => {
      const next = new Set(prev)
      if (enabled) next.add(key)
      else next.delete(key)
      return next
    })
    updateCheck(key, 'interval', enabled ? (hb.interval || '*/5 * * * *') : '')
  }

  const checkList = hb.checks || []
  const enabledCount = checkList.filter(c => c.enabled !== false).length

  if (loading) return <div className="panel-loading"><RefreshCw size={20} className="spin" /> {t('btn_saving')}</div>

  return (
    <div className="panel-view fade-in">
      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">{t('hb_title')}</h1>
          <p className="view-subtitle">{t('hb_subtitle', { active: enabledCount, total: checkList.length })}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {saveMsg && <span className={`save-msg ${saveMsg.startsWith('✓') || saveMsg.includes('成功') ? 'ok' : 'err'}`}>{saveMsg}</span>}
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <RefreshCw className="spin" size={15}/> : <Save size={15}/>}
            {saving ? t('btn_saving') : t('btn_save')}
          </button>
        </div>
      </header>

      <div className="panel-list">
        {/* Global settings */}
        <div className="panel-card glass-panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
            <Heart size={20} color={hb.enabled ? 'var(--accent-primary)' : 'var(--text-muted)'} />
            <h2 className="card-title" style={{ margin: 0, border: 'none', padding: 0 }}>{t('hb_global_settings')}</h2>
          </div>
          <div className="form-row">
            <div className="form-group" style={{ minWidth: 120 }}>
              <label className="form-label">{t('hb_enabled')}</label>
              <div className="toggle-row">
                <label className="toggle-switch">
                  <input type="checkbox" checked={hb.enabled} onChange={e => setHb({...hb, enabled: e.target.checked})} />
                  <span className="slider"></span>
                </label>
                <span className="form-hint">{hb.enabled ? t('hb_active') : t('hb_disabled')}</span>
              </div>
            </div>
            <div className="form-group flex-1">
              <label className="form-label">{t('hb_interval')}</label>
              <CronBuilder
                value={hb.interval}
                onChange={interval => setHb(prev => ({ ...prev, interval }))}
                defaultMode="interval"
                compact
              />
            </div>
          </div>
        </div>

        {/* Check items */}
        <div className="panel-card glass-panel" style={{ padding: '24px' }}>
          <div className="flex-between" style={{ marginBottom: 20 }}>
            <h2 className="card-title" style={{ margin: 0, border: 'none', padding: 0 }}>{t('hb_check_items')}</h2>
            <button className="btn-text" onClick={addCheck}><Plus size={14} /> {t('btn_add_check')}</button>
          </div>
          {checkList.length === 0 && <div className="panel-empty">{t('hb_empty')}</div>}
          {checkList.map(chk => (
            <div key={chk._key} className={`check-item ${chk.enabled === false ? 'disabled' : ''}`}>
              <div className="form-row" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
                <div className="form-group flex-1">
                  <label className="form-label">{t('hb_name')}</label>
                  <input className="form-input" value={chk.name} onChange={e => updateCheck(chk._key,'name',e.target.value)} placeholder={t('hb_name_placeholder')} />
                </div>
                <div className="form-group" style={{ minWidth: 150 }}>
                  <label className="form-label">{t('hb_check_interval')}</label>
                  <div className="toggle-row">
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={overrides.has(chk._key)}
                        onChange={() => toggleOverride(chk._key)}
                      />
                      <span className="slider"></span>
                    </label>
                    <span className="form-hint">
                      {overrides.has(chk._key) ? t('hb_check_interval_custom') : t('hb_check_interval_hint')}
                    </span>
                  </div>
                </div>
                <div className="form-group" style={{ minWidth: 90 }}>
                  <label className="form-label">{t('hb_enabled')}</label>
                  <div className="toggle-row">
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={chk.enabled !== false}
                        onChange={e => updateCheck(chk._key,'enabled',e.target.checked)}
                      />
                      <span className="slider"></span>
                    </label>
                    <span className="form-hint">{chk.enabled === false ? t('hb_disabled') : t('hb_active')}</span>
                  </div>
                </div>
                <button className="icon-btn danger" style={{ marginBottom: 4 }} onClick={() => removeCheck(chk._key)}><Trash2 size={15}/></button>
              </div>
              <div className="form-group">
                <label className="form-label">{t('hb_prompt')}</label>
                <textarea className="form-input form-textarea" rows={3} value={chk.prompt} onChange={e => updateCheck(chk._key,'prompt',e.target.value)} placeholder={t('hb_prompt_placeholder')} />
              </div>
              {overrides.has(chk._key) && (
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <CronBuilder
                    value={chk.interval || ''}
                    onChange={interval => updateCheck(chk._key, 'interval', interval)}
                    defaultMode="interval"
                    compact
                  />
                </div>
              )}
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">{t('cron_day_rules')}</label>
                <DayRuleControl
                  compact
                  weekend={chk.weekend || 'any'}
                  holiday={chk.holiday || 'any'}
                  onChange={({ weekend, holiday }) => setHb(prev => ({
                    ...prev,
                    checks: (prev.checks || []).map(c => (
                      c._key === chk._key ? { ...c, weekend, holiday } : c
                    )),
                  }))}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
