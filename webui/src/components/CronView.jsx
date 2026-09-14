import { useState, useEffect } from 'react'
import { Save, RefreshCw, Plus, Trash2, ToggleLeft, ToggleRight, Clock } from 'lucide-react'
import './PanelView.css'

export default function CronView() {
  const [tasks, setTasks]     = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    fetch('/api/cron').then(r => r.json()).then(d => {
      setTasks(d.tasks || [])
      setLoading(false)
    })
  }, [])

  const save = async () => {
    setSaving(true); setSaveMsg('')
    try {
      const r = await fetch('/api/cron', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tasks }) })
      const d = await r.json()
      setSaveMsg(d.success ? '✓ Saved' : `Error: ${d.error}`)
    } catch(e) { setSaveMsg(`Error: ${e.message}`) }
    finally { setSaving(false); setTimeout(() => setSaveMsg(''), 3000) }
  }

  const update = (idx, field, val) =>
    setTasks(prev => prev.map((t, i) => i === idx ? { ...t, [field]: val } : t))

  const addTask = () => {
    const newTasks = [...tasks, { id: `task_${Date.now()}`, name: '', cron: '0 9 * * *', enabled: true, prompt: '' }]
    setTasks(newTasks)
    setExpanded(newTasks.length - 1)
  }

  const removeTask = (idx) => { setTasks(prev => prev.filter((_, i) => i !== idx)); if (expanded === idx) setExpanded(null) }

  if (loading) return <div className="panel-loading"><RefreshCw size={20} className="spin" /> Loading...</div>

  return (
    <div className="panel-view fade-in">
      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">Cron Tasks</h1>
          <p className="view-subtitle">Scheduled tasks — {tasks.filter(t => t.enabled).length} active / {tasks.length} total</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {saveMsg && <span className={`save-msg ${saveMsg.startsWith('✓') ? 'ok' : 'err'}`}>{saveMsg}</span>}
          <button className="btn btn-outline" onClick={addTask}><Plus size={15} /> Add Task</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <RefreshCw className="spin" size={15}/> : <Save size={15}/>}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </header>

      <div className="panel-list">
        {tasks.length === 0 && <div className="panel-empty">No tasks. Click "Add Task" to create one.</div>}
        {tasks.map((task, idx) => (
          <div key={idx} className={`panel-card glass-panel ${task.enabled ? '' : 'disabled'}`}>
            <div className="panel-card-header" onClick={() => setExpanded(expanded === idx ? null : idx)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="toggle-btn" onClick={e => { e.stopPropagation(); update(idx, 'enabled', !task.enabled) }}>
                  {task.enabled ? <ToggleRight size={24} color="var(--accent-primary)" /> : <ToggleLeft size={24} color="var(--text-muted)" />}
                </button>
                <div>
                  <div className="panel-card-title">{task.name || <em style={{opacity:0.4}}>Unnamed Task</em>}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <span className="cron-badge"><Clock size={11} /> {task.cron}</span>
                    <span className="id-badge">{task.id}</span>
                  </div>
                </div>
              </div>
              <button className="icon-btn danger" onClick={e => { e.stopPropagation(); removeTask(idx) }}><Trash2 size={15}/></button>
            </div>

            {expanded === idx && (
              <div className="panel-card-body">
                <div className="form-row">
                  <div className="form-group flex-1">
                    <label className="form-label">Task ID</label>
                    <input className="form-input" value={task.id} onChange={e => update(idx,'id',e.target.value)} placeholder="unique_id" />
                  </div>
                  <div className="form-group flex-1">
                    <label className="form-label">Task Name</label>
                    <input className="form-input" value={task.name} onChange={e => update(idx,'name',e.target.value)} placeholder="e.g. Morning Report" />
                  </div>
                  <div className="form-group" style={{ minWidth: 180 }}>
                    <label className="form-label">Cron Expression</label>
                    <input className="form-input" value={task.cron} onChange={e => update(idx,'cron',e.target.value)} placeholder="0 9 * * *" />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Prompt</label>
                  <textarea className="form-input form-textarea" rows={4} value={task.prompt} onChange={e => update(idx,'prompt',e.target.value)} placeholder="Agent instruction..." />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
