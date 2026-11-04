import { useEffect, useRef, useState } from 'react'
import { MessageSquare, Settings, Clock, Heart, Boxes, Link2, Activity, Languages, RotateCw, Puzzle } from 'lucide-react'
import { useLanguage } from './LanguageContext'
import './Sidebar.css'

const NAV_ITEMS = [
  { id: 'sessions', labelKey: 'nav_sessions', icon: MessageSquare },
  { id: 'config', labelKey: 'nav_config', icon: Settings },
  { id: 'cron', labelKey: 'nav_cron', icon: Clock },
  { id: 'heartbeat', labelKey: 'nav_heartbeat', icon: Heart },
  { id: 'mcp', labelKey: 'nav_mcp', icon: Boxes },
  { id: 'skills', labelKey: 'nav_skills', icon: Puzzle },
  { id: 'channels', labelKey: 'nav_channels', icon: Link2 },
]

// 重启后轮询健康检查的参数
const POLL_INTERVAL_MS = 800
const POLL_TIMEOUT_MS = 90000

export default function Sidebar({ currentView, setCurrentView }) {
  const { t, toggleLanguage } = useLanguage()
  const [restarting, setRestarting] = useState(false)
  const [restartMsg, setRestartMsg] = useState('')
  const pollRef = useRef(null)
  const msgTimerRef = useRef(null)

  useEffect(() => () => {
    clearInterval(pollRef.current)
    clearTimeout(msgTimerRef.current)
  }, [])

  const flash = (text) => {
    setRestartMsg(text)
    clearTimeout(msgTimerRef.current)
    msgTimerRef.current = setTimeout(() => setRestartMsg(''), 4000)
  }

  /**
   * 重启会让当前 HTTP 服务关闭再重开，因此无法依赖该请求的返回值，
   * 只能轮询 /api/health 判断服务是否真正恢复。
   */
  const pollUntilHealthy = () => {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        const data = await res.json()
        if (data.ok && !data.restarting) {
          clearInterval(pollRef.current)
          setRestarting(false)
          flash(t('restart_ok'))
          // 重启后所有长连接（SSE 会话流等）都已失效，
          // 刷新页面才能干净地重建前端状态
          msgTimerRef.current = setTimeout(() => window.location.reload(), 1200)
          return
        }
      } catch {
        // 服务尚未恢复，继续轮询
      }
      if (Date.now() > deadline) {
        clearInterval(pollRef.current)
        setRestarting(false)
        flash(t('restart_fail'))
      }
    }, POLL_INTERVAL_MS)
  }

  const handleRestart = async () => {
    if (restarting) return
    if (!window.confirm(t('restart_confirm'))) return

    setRestarting(true)
    setRestartMsg(t('restart_running'))
    try {
      const res = await fetch('/api/restart', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
    } catch (e) {
      // 服务可能在响应送达前就断开连接，此时交由轮询判定真实结果
      console.warn('[WebUI] restart request:', e.message)
    }
    pollUntilHealthy()
  }

  return (
    <aside className="sidebar">
      <div className="logo-container">
        <div className="logo-icon">
          <Activity size={18} />
        </div>
        <div className="logo-text">{t('logo_admin')}</div>
      </div>

      <nav className="nav-menu">
        {NAV_ITEMS.map(({ id, labelKey, icon: Icon }) => (
          <div
            key={id}
            className={`nav-item ${currentView === id ? 'active' : ''}`}
            onClick={() => setCurrentView(id)}
          >
            <Icon className="nav-icon" />
            <span>{t(labelKey)}</span>
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        {restartMsg && (
          <div className={`restart-msg ${restartMsg.startsWith('✓') ? 'ok' : ''}`}>{restartMsg}</div>
        )}
        <button
          className="lang-toggle-btn restart-btn"
          onClick={handleRestart}
          disabled={restarting}
        >
          <RotateCw size={15} className={restarting ? 'spin' : ''} />
          <span>{restarting ? t('restart_running') : t('restart_btn')}</span>
        </button>
        <button className="lang-toggle-btn" onClick={toggleLanguage}>
          <Languages size={15} />
          <span>{t('lang_label')}</span>
        </button>
      </div>
    </aside>
  )
}
