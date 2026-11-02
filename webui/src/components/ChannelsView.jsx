import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RefreshCw, X, Link2, MessageSquare, Boxes, Smartphone,
  LogIn, LogOut, CheckCircle2, AlertCircle,
} from 'lucide-react'
import { useLanguage } from './LanguageContext'
import './PanelView.css'
import './MCPView.css'
import './ChannelsView.css'

// 渠道图标：新增渠道时在这里补一个即可，未命中用 Link2 兜底
const CHANNEL_ICONS = {
  webui: Boxes,
  feishu: MessageSquare,
  weixin: Smartphone,
}

const CHANNEL_NAME_KEYS = {
  webui: 'ch_name_webui',
  feishu: 'ch_name_feishu',
  weixin: 'ch_name_weixin',
}

/** 渠道状态的统一展示口径 */
function statusOf(channel) {
  if (!channel.enabled) return { kind: 'off', key: 'ch_status_disabled' }
  if (channel.connected) return { kind: 'ok', key: 'ch_status_connected' }
  if (channel.loggedIn) return { kind: 'warn', key: 'ch_status_standby' }
  return { kind: 'off', key: 'ch_status_disconnected' }
}

// ── 微信扫码弹窗 ──────────────────────────────────
function WeixinLoginModal({ onClose, onConnected }) {
  const { t } = useLanguage()
  // status: loading | wait | scaned | expired | connected | timeout | error
  const [state, setState] = useState({ status: 'loading', qr: null, qrUrl: null, message: '' })
  const doneRef = useRef(false)
  // 父组件每次重渲染都会给新的 onConnected，直接放进依赖会让 effect 重跑、
  // 把刚取到的二维码作废（还会重复请求登录接口），因此用 ref 持有最新回调
  const connectedRef = useRef(onConnected)
  connectedRef.current = onConnected

  useEffect(() => {
    let alive = true
    let timer = null

    const apply = (channel) => {
      if (!alive) return
      const login = channel?.login || {}
      setState({
        status: login.status || 'wait',
        qr: login.qr || null,
        qrUrl: login.qrUrl || null,
        message: login.message || '',
      })
      if (login.status === 'connected' && !doneRef.current) {
        doneRef.current = true
        clearInterval(timer)
        timer = null
        // 给用户看一眼「已连接」再关窗
        setTimeout(() => { if (alive) connectedRef.current?.() }, 1200)
      }
      if (['timeout', 'error', 'connected'].includes(login.status) && timer) {
        clearInterval(timer)
        timer = null
      }
    }

    const run = async () => {
      try {
        const res = await fetch('/api/weixin/login', { method: 'POST' })
        const data = await res.json()
        if (!alive) return
        if (!data.success) {
          setState({ status: 'error', qr: null, qrUrl: null, message: data.error || t('ch_login_error') })
          return
        }
        apply(data.channel)
        if (doneRef.current) return
        timer = setInterval(async () => {
          try {
            const r = await fetch('/api/weixin/status')
            const d = await r.json()
            if (d.success) apply(d.channel)
          } catch { /* 网络抖动，下一轮再试 */ }
        }, 1500)
      } catch (e) {
        if (alive) setState({ status: 'error', qr: null, qrUrl: null, message: e.message })
      }
    }

    run()

    return () => {
      alive = false
      if (timer) clearInterval(timer)
      // 关闭弹窗即取消后台扫码轮询，避免服务端白跑 8 分钟
      if (!doneRef.current) fetch('/api/weixin/cancel', { method: 'POST' }).catch(() => {})
    }
  }, [t])

  const hintKey = {
    loading: 'ch_login_loading',
    wait: 'ch_login_scan',
    scaned: 'ch_login_scanned',
    expired: 'ch_login_expired',
    connected: 'ch_login_success',
    timeout: 'ch_login_timeout',
    error: 'ch_login_error',
  }[state.status] || 'ch_login_scan'

  return (
    <div className="qr-overlay" onClick={onClose}>
      <div className="qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qr-header">
          <h3>{t('ch_weixin_login_title')}</h3>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="qr-body center">
          {!state.qr && !state.qrUrl && ['loading', 'wait'].includes(state.status) && (
            <>
              <RefreshCw size={32} className="spin" />
              <p>{t(hintKey)}</p>
            </>
          )}

          {state.qr && !['connected', 'error', 'timeout'].includes(state.status) && (
            <>
              <img src={state.qr} alt="WeChat login QR" className="qr-image" />
              <p className={state.status === 'scaned' ? 'wx-scan-ok' : ''}>{t(hintKey)}</p>
              <p className="qr-hint">{t('ch_weixin_login_hint')}</p>
              {state.status === 'scaned' && <p className="qr-hint">{t('ch_weixin_login_confirm')}</p>}
              {state.qrUrl && (
                <p className="qr-hint wx-fallback">
                  {t('ch_weixin_login_link')}
                  <a href={state.qrUrl} target="_blank" rel="noreferrer">{state.qrUrl}</a>
                </p>
              )}
            </>
          )}

          {/* 二维码渲染失败（未安装 qrcode 等）时退化：直接把链接给用户点开 */}
          {!state.qr && state.qrUrl && !['connected', 'error', 'timeout'].includes(state.status) && (
            <>
              <p>{t(hintKey)}</p>
              <p className="qr-hint wx-fallback">
                {t('ch_weixin_login_link')}
                <a href={state.qrUrl} target="_blank" rel="noreferrer">{state.qrUrl}</a>
              </p>
            </>
          )}

          {state.status === 'connected' && (
            <>
              <CheckCircle2 size={48} color="#10b981" />
              <p>{t('ch_login_success')}</p>
              <p className="qr-hint">{t('ch_weixin_connected_hint')}</p>
            </>
          )}

          {['error', 'timeout'].includes(state.status) && (
            <>
              <AlertCircle size={44} color="#ef4444" />
              <p style={{ color: '#ef4444', fontWeight: 600 }}>{t(hintKey)}</p>
              {state.message && <p className="qr-hint">{state.message}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 渠道管理主视图 ────────────────────────────────
export default function ChannelsView() {
  const { t } = useLanguage()
  const [channels, setChannels] = useState([])
  const [loading, setLoading] = useState(true)
  const [showQR, setShowQR] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/channels')
      const data = await res.json()
      setChannels(data.channels || [])
    } catch {
      // 后端重启中，保持上一次的快照
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    // 连接状态是异步变化的（扫码成功、长轮询掉线），轮询比 SSE 更省事
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  const logout = async (channel) => {
    if (!window.confirm(t('ch_disconnect_confirm', { name: t(CHANNEL_NAME_KEYS[channel.id] || 'ch_name_weixin') }))) return
    setBusy(true)
    try {
      await fetch('/api/weixin/logout', { method: 'POST' })
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <div className="panel-loading"><RefreshCw size={20} className="spin" /> {t('btn_saving')}</div>
  }

  return (
    <div className="panel-view fade-in">
      {showQR && (
        <WeixinLoginModal
          onClose={() => setShowQR(false)}
          onConnected={() => { setShowQR(false); load() }}
        />
      )}

      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">{t('ch_title')}</h1>
          <p className="view-subtitle">
            {t('ch_subtitle', { count: channels.filter((c) => c.connected).length })}
          </p>
        </div>
        <button className="btn btn-outline" onClick={load}><RefreshCw size={15} /> {t('ch_refresh')}</button>
      </header>

      <div className="panel-list">
        {channels.map((channel) => {
          const Icon = CHANNEL_ICONS[channel.id] || Link2
          const status = statusOf(channel)
          const isWeixin = channel.id === 'weixin'

          return (
            <div key={channel.id} className={`panel-card glass-panel channel-card ${channel.enabled ? '' : 'disabled'}`}>
              <div className="channel-row">
                <div className={`channel-icon ${status.kind}`}><Icon size={18} /></div>

                <div className="channel-info">
                  <div className="channel-name-row">
                    <span className="panel-card-title">
                      {t(CHANNEL_NAME_KEYS[channel.id] || channel.id)}
                    </span>
                    <span className={`status-pill ${status.kind}`}>{t(status.key)}</span>
                    {/* 只有微信受 context_token 限制，飞书没有通知群时会退回广播给活跃会话 */}
                    {isWeixin && channel.enabled && channel.connected && !channel.canPush && (
                      <span className="id-badge" title={t('ch_push_need_message_hint')}>
                        {t('ch_push_need_message')}
                      </span>
                    )}
                  </div>
                  <div className="channel-detail">{channel.detail}</div>
                  {channel.lastError && (
                    <div className="channel-error" title={channel.lastError}>{channel.lastError}</div>
                  )}
                </div>

                <div className="channel-actions">
                  {isWeixin && channel.enabled && !channel.loggedIn && (
                    <button className="btn btn-login-qr" onClick={() => setShowQR(true)}>
                      <LogIn size={14} /> {t('ch_connect_weixin')}
                    </button>
                  )}
                  {isWeixin && channel.enabled && channel.loggedIn && (
                    <button className="btn btn-outline" disabled={busy} onClick={() => logout(channel)}>
                      <LogOut size={14} /> {t('ch_disconnect')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
