import { useState, useEffect, useRef } from 'react'
import { Save, RefreshCw, Plus, Trash2, Terminal, Globe, ToggleLeft, ToggleRight, LogIn, X } from 'lucide-react'
import { useLanguage } from './LanguageContext'
import './PanelView.css'
import './MCPView.css'

// ── QR Modal ──────────────────────────────────────
function QRModal({ onClose }) {
  const { t } = useLanguage()
  const [state, setState] = useState('loading') // loading | ok | error
  const [qrSrc, setQrSrc] = useState(null)
  const [errMsg, setErrMsg] = useState('')
  const [genTime, setGenTime] = useState('')

  useEffect(() => {
    fetch('/api/mcp/miot-login', { method: 'POST' })
      .then(r => r.json())
      .then(d => {
        if (d.qr) { setQrSrc(d.qr); setGenTime(d.generatedAt); setState('ok') }
        else { setErrMsg(d.error || 'Unknown error'); setState('error') }
      })
      .catch(e => { setErrMsg(e.message); setState('error') })
  }, [])

  return (
    <div className="qr-overlay" onClick={onClose}>
      <div className="qr-modal" onClick={e => e.stopPropagation()}>
        <div className="qr-header">
          <h3>{t('qr_modal_title')}</h3>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>

        {state === 'loading' && (
          <div className="qr-body center">
            <RefreshCw size={32} className="spin" />
            <p>{t('qr_state_loading')}</p>
            <p className="qr-hint">{t('qr_state_loading_hint')}</p>
          </div>
        )}

        {state === 'error' && (
          <div className="qr-body center">
            <p style={{ color: '#ef4444', fontWeight: 600 }}>{t('qr_state_error')}</p>
            <p className="qr-hint">{errMsg}</p>
            <p className="qr-hint">{t('qr_state_error_hint')}</p>
          </div>
        )}

        {state === 'ok' && (
          <div className="qr-body center">
            <img src={qrSrc} alt="Login QR Code" className="qr-image" />
            <p className="qr-hint">{t('qr_state_ok_hint')}</p>
            <p className="qr-hint">{t('qr_state_ok_hint_2')}</p>
            <p className="qr-gen-time">{t('qr_gen_time')} {genTime}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// 列表渲染与展开状态用本地稳定 _key（server.name 用户可编辑且可能重复），
// 提交前会被剥离，不写入配置文件
let uid = 0
const nextKey = () => `k${++uid}`

// ── Main View ──────────────────────────────────────
export default function MCPView() {
  const { t } = useLanguage()
  const [servers, setServers] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [showQR, setShowQR] = useState(false)

  useEffect(() => {
    fetch('/api/mcp').then(r => r.json()).then(d => {
      setServers((d.servers || []).map(srv => ({ ...srv, _key: nextKey() })))
      setLoading(false)
    })
  }, [])

  const save = async () => {
    setSaving(true); setSaveMsg('')
    try {
      const payload = servers.map(({ _key, ...srv }) => srv)
      const r = await fetch('/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ servers: payload }) })
      const d = await r.json()
      setSaveMsg(d.success ? t('save_ok') : `${t('save_err')}${d.error}`)
    } catch(e) { setSaveMsg(`${t('save_err')}${e.message}`) }
    finally { setSaving(false); setTimeout(() => setSaveMsg(''), 3000) }
  }

  const update = (key, field, val) => setServers(prev => prev.map(s => s._key === key ? { ...s, [field]: val } : s))
  const updateArgs = (key, val) => update(key, 'args', val.split('\n').filter(Boolean))
  const updateEnvEntry = (key, envKey, val) => {
    const target = servers.find(s => s._key === key)
    update(key, 'env', { ...(target?.env || {}), [envKey]: val })
  }
  const addServer = () => {
    const created = { _key: nextKey(), name: `server_${Date.now()}`, enabled: false, command: 'python3', args: [], env: {} }
    setServers(prev => [...prev, created])
    setExpanded(created._key)
  }
  const removeServer = (key) => {
    setServers(prev => prev.filter(s => s._key !== key))
    setExpanded(prev => prev === key ? null : prev)
  }

  const isMiot = (s) => s.name === 'miot-mcp'
  const isHttp = (s) => !!s.url

  if (loading) return <div className="panel-loading"><RefreshCw size={20} className="spin" /> {t('btn_saving')}</div>

  return (
    <div className="panel-view fade-in">
      {showQR && <QRModal onClose={() => setShowQR(false)} />}

      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">{t('mcp_title')}</h1>
          <p className="view-subtitle">{t('mcp_subtitle', { count: servers.filter(s => s.enabled).length })}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {saveMsg && <span className={`save-msg ${saveMsg.startsWith('✓') || saveMsg.includes('成功') ? 'ok' : 'err'}`}>{saveMsg}</span>}
          <button className="btn btn-outline" onClick={addServer}><Plus size={15} /> {t('btn_add_server')}</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <RefreshCw className="spin" size={15}/> : <Save size={15}/>}
            {saving ? t('btn_saving') : t('btn_save')}
          </button>
        </div>
      </header>

      <div className="panel-list">
        {servers.length === 0 && <div className="panel-empty">{t('mcp_empty')}</div>}
        {servers.map(srv => (
          <div key={srv._key} className={`panel-card glass-panel ${srv.enabled ? '' : 'disabled'}`}>
            <div className="panel-card-header" onClick={() => setExpanded(expanded === srv._key ? null : srv._key)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="toggle-btn" onClick={e => { e.stopPropagation(); update(srv._key, 'enabled', !srv.enabled) }}>
                  {srv.enabled ? <ToggleRight size={24} color="var(--accent-primary)" /> : <ToggleLeft size={24} color="var(--text-muted)" />}
                </button>
                <div>
                  <div className="panel-card-title">{srv.name}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    {isHttp(srv)
                      ? <span className="id-badge"><Globe size={11} /> HTTP</span>
                      : <span className="id-badge"><Terminal size={11} /> {srv.command} {(srv.args || []).join(' ')}</span>
                    }
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {/* 小米 miot-mcp 专属登录按钮 */}
                {isMiot(srv) && (
                  <button
                    className="btn btn-login-qr"
                    onClick={e => { e.stopPropagation(); setShowQR(true) }}
                    title={t('btn_login_qr_title')}
                  >
                    <LogIn size={14} /> {t('btn_login')}
                  </button>
                )}
                <button className="icon-btn danger" onClick={e => { e.stopPropagation(); removeServer(srv._key) }}><Trash2 size={15}/></button>
              </div>
            </div>

            {expanded === srv._key && (
              <div className="panel-card-body">
                <div className="form-row">
                  <div className="form-group flex-1">
                    <label className="form-label">{t('mcp_server_name')}</label>
                    <input className="form-input" value={srv.name} onChange={e => update(srv._key,'name',e.target.value)} />
                  </div>
                </div>

                {isHttp(srv) ? (
                  <div className="form-group">
                    <label className="form-label">{t('mcp_url')}</label>
                    <input className="form-input" value={srv.url || ''} onChange={e => update(srv._key,'url',e.target.value)} placeholder="https://..." />
                  </div>
                ) : (
                  <>
                    <div className="form-row">
                      <div className="form-group flex-1">
                        <label className="form-label">{t('mcp_command')}</label>
                        <input className="form-input" value={srv.command || ''} onChange={e => update(srv._key,'command',e.target.value)} placeholder="python3" />
                      </div>
                    </div>
                    <div className="form-group">
                      <label className="form-label">{t('mcp_args')}</label>
                      <textarea className="form-input form-textarea" rows={3} value={(srv.args || []).join('\n')} onChange={e => updateArgs(srv._key, e.target.value)} placeholder="../mcp/server.py" />
                    </div>
                  </>
                )}

                {srv.env && Object.keys(srv.env).length > 0 && (
                  <div className="form-group">
                    <label className="form-label">{t('mcp_env')}</label>
                    {Object.entries(srv.env).map(([k, v]) => (
                      <div key={k} className="env-var-row" style={{ marginBottom: 8 }}>
                        <input className="form-input env-key-input" value={k} readOnly style={{ opacity: 0.7 }} />
                        <span className="env-eq">=</span>
                        <input className="form-input" value={v} onChange={e => updateEnvEntry(srv._key, k, e.target.value)} style={{ flex: 1 }} />
                      </div>
                    ))}
                  </div>
                )}

                {srv.headers && (
                  <div className="form-group">
                    <label className="form-label">{t('mcp_headers')}</label>
                    {Object.entries(srv.headers).map(([k, v]) => (
                      <div key={k} className="env-var-row" style={{ marginBottom: 8 }}>
                        <input className="form-input env-key-input" value={k} readOnly style={{ opacity: 0.7 }} />
                        <span className="env-eq">:</span>
                        <input className="form-input" defaultValue={v} style={{ flex: 1 }} readOnly />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
