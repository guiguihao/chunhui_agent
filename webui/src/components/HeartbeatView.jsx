import { useState, useEffect } from 'react'
import { Save, RefreshCw, Plus, Trash2, Heart } from 'lucide-react'
import { useLanguage } from './LanguageContext'
import './PanelView.css'

export default function HeartbeatView() {
  const { t } = useLanguage()
  const [hb, setHb]           = useState({ enabled: true, interval: '*/10 * * * *', checks: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  useEffect(() => {
    fetch('/api/heartbeat').then(r => r.json()).then(d => { setHb(d); setLoading(false) })
  }, [])

  const save = async () => {
    setSaving(true); setSaveMsg('')
    try {
      const r = await fetch('/api/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(hb) })
      const d = await r.json()
      setSaveMsg(d.success ? t('save_ok') : `${t('save_err')}${d.error}`)
    } catch(e) { setSaveMsg(`${t('save_err')}${e.message}`) }
    finally { setSaving(false); setTimeout(() => setSaveMsg(''), 3000) }
  }

  const updateCheck = (idx, field, val) =>
    setHb(prev => ({ ...prev, checks: prev.checks.map((c, i) => i === idx ? { ...c, [field]: val } : c) }))

  const addCheck = () => setHb(prev => ({ ...prev, checks: [...(prev.checks || []), { name: '', prompt: '' }] }))
  const removeCheck = (idx) => setHb(prev => ({ ...prev, checks: prev.checks.filter((_, i) => i !== idx) }))

  if (loading) return <div className="panel-loading"><RefreshCw size={20} className="spin" /> {t('btn_saving')}</div>

  return (
    <div className="panel-view fade-in">
      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">{t('hb_title')}</h1>
          <p className="view-subtitle">{t('hb_subtitle', { count: hb.checks?.length || 0 })}</p>
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
              <input className="form-input" value={hb.interval} onChange={e => setHb({...hb, interval: e.target.value})} placeholder="*/10 * * * *" />
              <span className="form-hint">{t('hb_interval_hint')}</span>
            </div>
          </div>
        </div>

        {/* Check items */}
        <div className="panel-card glass-panel" style={{ padding: '24px' }}>
          <div className="flex-between" style={{ marginBottom: 20 }}>
            <h2 className="card-title" style={{ margin: 0, border: 'none', padding: 0 }}>{t('hb_check_items')}</h2>
            <button className="btn-text" onClick={addCheck}><Plus size={14} /> {t('btn_add_check')}</button>
          </div>
          {(hb.checks || []).length === 0 && <div className="panel-empty">{t('hb_empty')}</div>}
          {(hb.checks || []).map((chk, idx) => (
            <div key={idx} className="check-item">
              <div className="form-row" style={{ marginBottom: 0 }}>
                <div className="form-group flex-1">
                  <label className="form-label">{t('hb_name')}</label>
                  <input className="form-input" value={chk.name} onChange={e => updateCheck(idx,'name',e.target.value)} placeholder={t('hb_name_placeholder')} />
                </div>
                <button className="icon-btn danger" style={{ marginTop: 24 }} onClick={() => removeCheck(idx)}><Trash2 size={15}/></button>
              </div>
              <div className="form-group">
                <label className="form-label">{t('hb_prompt')}</label>
                <textarea className="form-input form-textarea" rows={3} value={chk.prompt} onChange={e => updateCheck(idx,'prompt',e.target.value)} placeholder={t('hb_prompt_placeholder')} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
