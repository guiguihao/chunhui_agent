import { useState, useEffect } from 'react'
import { Save, RefreshCw, Plus, Trash2, ToggleLeft, ToggleRight, Clock } from 'lucide-react'
import { useLanguage } from './LanguageContext'
import { isValidCron } from '../lib/cron'
import CronBuilder, { describeCron } from './CronBuilder'
import './PanelView.css'

// 列表渲染与展开状态用本地稳定的 _key 标识（业务 id 可被用户编辑、可能重复或为空）
// _key 只存在于前端，提交前会被剥离，不会写进 cron.yaml
let uid = 0
const nextKey = () => `k${++uid}`

export default function CronView() {
  const { t } = useLanguage()
  const [tasks, setTasks]     = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    fetch('/api/cron').then(r => r.json()).then(d => {
      setTasks((d.tasks || []).map(task => ({ ...task, _key: nextKey() })))
      setLoading(false)
    })
  }, [])

  const save = async () => {
    // 提交前拦截：非法表达式一旦落盘，会让后端调度器重建失败并导致下次启动失败
    const bad = tasks.filter(task => !isValidCron(task.cron))
    if (bad.length > 0) {
      const names = bad.map(b => b.name || b.id || t('cron_unnamed')).join('、')
      setSaveMsg(`${t('save_err')}${names} — ${t('cron_invalid')}`)
      return
    }
    setSaving(true); setSaveMsg('')
    try {
      // 剥离前端专用的 _key，避免污染 cron.yaml
      const payload = tasks.map(({ _key, ...task }) => task)
      const r = await fetch('/api/cron', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tasks: payload }) })
      const d = await r.json()
      setSaveMsg(d.success ? t('save_ok') : `${t('save_err')}${d.error}`)
    } catch(e) { setSaveMsg(`${t('save_err')}${e.message}`) }
    finally { setSaving(false); setTimeout(() => setSaveMsg(''), 3000) }
  }

  const update = (key, field, val) =>
    setTasks(prev => prev.map(t => t._key === key ? { ...t, [field]: val } : t))

  const addTask = () => {
    const created = { _key: nextKey(), id: `task_${Date.now()}`, name: '', cron: '0 9 * * *', enabled: true, prompt: '' }
    setTasks(prev => [...prev, created])
    setExpanded(created._key)
  }

  const removeTask = (key) => {
    setTasks(prev => prev.filter(t => t._key !== key))
    setExpanded(prev => prev === key ? null : prev)
  }

  if (loading) return <div className="panel-loading"><RefreshCw size={20} className="spin" /> {t('btn_saving')}</div>

  return (
    <div className="panel-view fade-in">
      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">{t('cron_title')}</h1>
          <p className="view-subtitle">{t('cron_subtitle', { active: tasks.filter(t => t.enabled).length, total: tasks.length })}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {saveMsg && <span className={`save-msg ${saveMsg.startsWith('✓') || saveMsg.includes('成功') ? 'ok' : 'err'}`}>{saveMsg}</span>}
          <button className="btn btn-outline" onClick={addTask}><Plus size={15} /> {t('btn_add_task')}</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <RefreshCw className="spin" size={15}/> : <Save size={15}/>}
            {saving ? t('btn_saving') : t('btn_save')}
          </button>
        </div>
      </header>

      <div className="panel-list">
        {tasks.length === 0 && <div className="panel-empty">{t('cron_empty')}</div>}
        {tasks.map(task => {
          const scheduleText = describeCron(task.cron, t)
          return (
          <div key={task._key} className={`panel-card glass-panel ${task.enabled ? '' : 'disabled'}`}>
            <div className="panel-card-header" onClick={() => setExpanded(expanded === task._key ? null : task._key)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="toggle-btn" onClick={e => { e.stopPropagation(); update(task._key, 'enabled', !task.enabled) }}>
                  {task.enabled ? <ToggleRight size={24} color="var(--accent-primary)" /> : <ToggleLeft size={24} color="var(--text-muted)" />}
                </button>
                <div>
                  <div className="panel-card-title">{task.name || <em style={{opacity:0.4}}>{t('cron_unnamed')}</em>}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                    <span className="cron-badge"><Clock size={11} /> {task.cron}</span>
                    {scheduleText && <span className="cron-desc-badge">{scheduleText}</span>}
                    <span className="id-badge">{task.id}</span>
                  </div>
                </div>
              </div>
              <button className="icon-btn danger" onClick={e => { e.stopPropagation(); removeTask(task._key) }}><Trash2 size={15}/></button>
            </div>

            {expanded === task._key && (
              <div className="panel-card-body">
                <div className="form-row">
                  <div className="form-group flex-1">
                    <label className="form-label">{t('cron_id')}</label>
                    <input className="form-input" value={task.id} onChange={e => update(task._key,'id',e.target.value)} placeholder={t('cron_id_placeholder')} />
                  </div>
                  <div className="form-group flex-1">
                    <label className="form-label">{t('cron_name')}</label>
                    <input className="form-input" value={task.name} onChange={e => update(task._key,'name',e.target.value)} placeholder={t('cron_name_placeholder')} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('cron_schedule')}</label>
                  <CronBuilder
                    value={task.cron}
                    onChange={cron => update(task._key, 'cron', cron)}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('cron_prompt')}</label>
                  <textarea className="form-input form-textarea" rows={4} value={task.prompt} onChange={e => update(task._key,'prompt',e.target.value)} placeholder={t('cron_prompt_placeholder')} />
                </div>
              </div>
            )}
          </div>
          )
        })}
      </div>
    </div>
  )
}
