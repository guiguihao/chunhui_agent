import { useState, useEffect } from 'react'
import { Save, RefreshCw, Plus, Trash2, Heart } from 'lucide-react'
import './PanelView.css'

export default function HeartbeatView() {
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
      setSaveMsg(d.success ? '✓ Saved' : `Error: ${d.error}`)
    } catch(e) { setSaveMsg(`Error: ${e.message}`) }
    finally { setSaving(false); setTimeout(() => setSaveMsg(''), 3000) }
  }

  const updateCheck = (idx, field, val) =>
    setHb(prev => ({ ...prev, checks: prev.checks.map((c, i) => i === idx ? { ...c, [field]: val } : c) }))

  const addCheck = () => setHb(prev => ({ ...prev, checks: [...(prev.checks || []), { name: '', prompt: '' }] }))
  const removeCheck = (idx) => setHb(prev => ({ ...prev, checks: prev.checks.filter((_, i) => i !== idx) }))

  if (loading) return <div className="panel-loading"><RefreshCw size={20} className="spin" /> Loading...</div>

  return (
    <div className="panel-view fade-in">
      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">Heartbeat</h1>
          <p className="view-subtitle">Periodic health checks — {hb.checks?.length || 0} checks configured</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {saveMsg && <span className={`save-msg ${saveMsg.startsWith('✓') ? 'ok' : 'err'}`}>{saveMsg}</span>}
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <RefreshCw className="spin" size={15}/> : <Save size={15}/>}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </header>

      <div className="panel-list">
        {/* Global settings */}
        <div className="panel-card glass-panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
            <Heart size={20} color={hb.enabled ? 'var(--accent-primary)' : 'var(--text-muted)'} />
            <h2 className="card-title" style={{ margin: 0, border: 'none', padding: 0 }}>Global Settings</h2>
          </div>
          <div className="form-row">
            <div className="form-group" style={{ minWidth: 120 }}>
              <label className="form-label">Enabled</label>
              <div className="toggle-row">
                <label className="toggle-switch">
                  <input type="checkbox" checked={hb.enabled} onChange={e => setHb({...hb, enabled: e.target.checked})} />
                  <span className="slider"></span>
                </label>
                <span className="form-hint">{hb.enabled ? 'Active' : 'Disabled'}</span>
              </div>
            </div>
            <div className="form-group flex-1">
              <label className="form-label">Check Interval (Cron)</label>
              <input className="form-input" value={hb.interval} onChange={e => setHb({...hb, interval: e.target.value})} placeholder="*/10 * * * *" />
              <span className="form-hint">e.g. */10 * * * * = every 10 minutes</span>
            </div>
          </div>
        </div>

        {/* Check items */}
        <div className="panel-card glass-panel" style={{ padding: '24px' }}>
          <div className="flex-between" style={{ marginBottom: 20 }}>
            <h2 className="card-title" style={{ margin: 0, border: 'none', padding: 0 }}>Check Items</h2>
            <button className="btn-text" onClick={addCheck}><Plus size={14} /> Add Check</button>
          </div>
          {(hb.checks || []).length === 0 && <div className="panel-empty">No checks. Click "Add Check" to add one.</div>}
          {(hb.checks || []).map((chk, idx) => (
            <div key={idx} className="check-item">
              <div className="form-row" style={{ marginBottom: 0 }}>
                <div className="form-group flex-1">
                  <label className="form-label">Name</label>
                  <input className="form-input" value={chk.name} onChange={e => updateCheck(idx,'name',e.target.value)} placeholder="e.g. System Health" />
                </div>
                <button className="icon-btn danger" style={{ marginTop: 24 }} onClick={() => removeCheck(idx)}><Trash2 size={15}/></button>
              </div>
              <div className="form-group">
                <label className="form-label">Prompt</label>
                <textarea className="form-input form-textarea" rows={3} value={chk.prompt} onChange={e => updateCheck(idx,'prompt',e.target.value)} placeholder="Check instruction for agent..." />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
