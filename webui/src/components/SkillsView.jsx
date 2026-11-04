import { useEffect, useRef, useState } from 'react'
import { RefreshCw, ToggleLeft, ToggleRight, FileCode, FileText } from 'lucide-react'
import { useLanguage } from './LanguageContext'
import './PanelView.css'
import './SkillsView.css'

/**
 * 与后端 SkillService 的 PROTECTED_SKILLS 保持一致。
 * 后端 /api/skills 会返回 protected 字段；这里保留一份兜底，
 * 避免后端进程还没重启（返回里没有该字段）时开关把基础能力真的关掉。
 */
const PROTECTED_SKILL_NAMES = ['tasktodolist', 'weather']
const isProtected = (skill) => skill.protected === true || PROTECTED_SKILL_NAMES.includes(skill.name)

/**
 * 技能管理
 *
 * 开关只影响「是否注册为工具 / 是否允许派发」，不动 skills/ 目录下的文件；
 * 保存后下一轮对话立即生效，不需要重启 Agent（与 MCP Server 要重启不同）。
 */
export default function SkillsView() {
  const { t } = useLanguage()
  const [skills, setSkills] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [pending, setPending] = useState(null)
  const [msg, setMsg] = useState('')
  // 受保护技能的点击提示：放在固定 toast 里，避免用户看不到页头右侧的消息
  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)

  const showToast = (text) => {
    setToast(text)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2600)
  }

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const load = async () => {
    setLoading(true)
    setLoadErr('')
    try {
      const r = await fetch('/api/skills', { cache: 'no-store' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setSkills(d.skills || [])
    } catch (e) {
      setLoadErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const toggle = async (skill) => {
    if (pending) return
    // 受保护技能（基础能力）：按钮保持可点击，只为给出明确提示，
    // 后端同样会拒绝，这里不做乐观更新，避免界面闪一下再回滚
    if (isProtected(skill)) {
      showToast(t('skills_protected_tip', { name: skill.name }))
      return
    }
    const next = !skill.enabled

    setPending(skill.name)
    setMsg('')
    // 乐观更新：点击立刻有反馈，失败再回滚，避免等待期间按钮无响应
    setSkills(prev => prev.map(s => (s.name === skill.name ? { ...s, enabled: next } : s)))

    try {
      const r = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skill.name, enabled: next }),
      })
      const d = await r.json()
      if (!r.ok || d.success === false) throw new Error(d.error || `HTTP ${r.status}`)
      setMsg(t(next ? 'skills_enabled_ok' : 'skills_disabled_ok', { name: skill.name }))
    } catch (e) {
      setSkills(prev => prev.map(s => (s.name === skill.name ? { ...s, enabled: skill.enabled } : s)))
      setMsg(`${t('save_err')}${e.message}`)
    } finally {
      setPending(null)
      setTimeout(() => setMsg(''), 3000)
    }
  }

  if (loading) {
    return (
      <div className="panel-loading">
        <RefreshCw size={20} className="spin" /> {t('skills_loading')}
      </div>
    )
  }

  const active = skills.filter(s => s.enabled).length

  return (
    <div className="panel-view fade-in">
      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">{t('skills_title')}</h1>
          <p className="view-subtitle">{t('skills_subtitle', { active, total: skills.length })}</p>
        </div>
        <div className="skills-actions">
          {msg && (
            <span className={`save-msg ${msg.startsWith('✓') || msg.includes('已') ? 'ok' : 'err'}`}>{msg}</span>
          )}
          <button className="btn btn-outline" onClick={load}>
            <RefreshCw size={15} /> {t('ch_refresh')}
          </button>
        </div>
      </header>

      <p className="skills-hint">{t('skills_hint')}</p>

      {loadErr && <div className="panel-empty skills-error">{t('skills_load_err')}{loadErr}</div>}

      <div className="panel-list">
        {!loadErr && skills.length === 0 && <div className="panel-empty">{t('skills_empty')}</div>}
        {skills.map(skill => (
          <div key={skill.name} className={`panel-card glass-panel ${skill.enabled ? '' : 'disabled'}`}>
            <div className="panel-card-header skills-row">
              <div className="skills-main">
                <button
                  className={`toggle-btn ${isProtected(skill) ? 'is-locked' : ''}`}
                  onClick={() => toggle(skill)}
                  disabled={pending === skill.name}
                  title={isProtected(skill)
                    ? t('skills_action_protected')
                    : (skill.enabled ? t('skills_action_disable') : t('skills_action_enable'))}
                >
                  {skill.enabled
                    ? <ToggleRight size={24} color="var(--accent-primary)" />
                    : <ToggleLeft size={24} color="var(--text-muted)" />}
                </button>

                <div>
                  <div className="panel-card-title">{skill.name}</div>
                  <div className="skills-meta">
                    <span className="id-badge">
                      {skill.type === 'md' ? <FileText size={11} /> : <FileCode size={11} />}
                      {skill.type === 'md' ? t('skills_type_md') : t('skills_type_js')}
                    </span>
                    {isProtected(skill) && <span className="id-badge">{t('skills_protected')}</span>}
                    {skill.description && <span className="skills-desc">{skill.description}</span>}
                  </div>
                </div>
              </div>

              <span className={`id-badge ${skill.enabled ? 'skills-badge-on' : 'skills-badge-off'}`}>
                {skill.enabled ? t('skills_enabled') : t('skills_disabled')}
              </span>
            </div>
          </div>
        ))}
      </div>

      {toast && <div className="skills-toast" role="status">{toast}</div>}
    </div>
  )
}
