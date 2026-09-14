import { useState, useEffect, useRef } from 'react'
import { Save, RefreshCw, Plus, Trash2, Terminal, Globe, ToggleLeft, ToggleRight, LogIn, X } from 'lucide-react'
import './PanelView.css'
import './MCPView.css'

// ── QR Modal ──────────────────────────────────────
function QRModal({ onClose }) {
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
          <h3>小米账号扫码登录</h3>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>

        {state === 'loading' && (
          <div className="qr-body center">
            <RefreshCw size={32} className="spin" />
            <p>正在生成二维码，请稍候…</p>
            <p className="qr-hint">（调用 prepare_login 中，约需 5–15 秒）</p>
          </div>
        )}

        {state === 'error' && (
          <div className="qr-body center">
            <p style={{ color: '#ef4444', fontWeight: 600 }}>生成失败</p>
            <p className="qr-hint">{errMsg}</p>
            <p className="qr-hint">请确认 miot-mcp 服务已启用并正常运行。</p>
          </div>
        )}

        {state === 'ok' && (
          <div className="qr-body center">
            <img src={qrSrc} alt="Login QR Code" className="qr-image" />
            <p className="qr-hint">请使用小米账号 App 扫码登录</p>
            <p className="qr-hint">扫码后 miot-mcp 将自动保存登录信息</p>
            <p className="qr-gen-time">⏱ 图片生成时间: {genTime}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main View ──────────────────────────────────────
export default function MCPView() {
  const [servers, setServers] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [showQR, setShowQR] = useState(false)

  useEffect(() => {
    fetch('/api/mcp').then(r => r.json()).then(d => { setServers(d.servers || []); setLoading(false) })
  }, [])

  const save = async () => {
    setSaving(true); setSaveMsg('')
    try {
      const r = await fetch('/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ servers }) })
      const d = await r.json()
      setSaveMsg(d.success ? '✓ Saved' : `Error: ${d.error}`)
    } catch(e) { setSaveMsg(`Error: ${e.message}`) }
    finally { setSaving(false); setTimeout(() => setSaveMsg(''), 3000) }
  }

  const update = (idx, field, val) => setServers(prev => prev.map((s, i) => i === idx ? { ...s, [field]: val } : s))
  const updateArgs = (idx, val) => update(idx, 'args', val.split('\n').filter(Boolean))
  const updateEnvEntry = (idx, key, val) => {
    const env = { ...(servers[idx].env || {}), [key]: val }
    update(idx, 'env', env)
  }
  const addServer = () => {
    const s = [...servers, { name: `server_${Date.now()}`, enabled: false, command: 'python3', args: [], env: {} }]
    setServers(s); setExpanded(s.length - 1)
  }
  const removeServer = (idx) => { setServers(prev => prev.filter((_, i) => i !== idx)); if (expanded === idx) setExpanded(null) }

  const isMiot = (s) => s.name === 'miot-mcp'
  const isHttp = (s) => !!s.url

  if (loading) return <div className="panel-loading"><RefreshCw size={20} className="spin" /> Loading...</div>

  return (
    <div className="panel-view fade-in">
      {showQR && <QRModal onClose={() => setShowQR(false)} />}

      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">MCP Servers</h1>
          <p className="view-subtitle">Model Context Protocol servers — {servers.filter(s => s.enabled).length} enabled</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {saveMsg && <span className={`save-msg ${saveMsg.startsWith('✓') ? 'ok' : 'err'}`}>{saveMsg}</span>}
          <button className="btn btn-outline" onClick={addServer}><Plus size={15} /> Add Server</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <RefreshCw className="spin" size={15}/> : <Save size={15}/>}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </header>

      <div className="panel-list">
        {servers.length === 0 && <div className="panel-empty">No MCP servers configured.</div>}
        {servers.map((srv, idx) => (
          <div key={idx} className={`panel-card glass-panel ${srv.enabled ? '' : 'disabled'}`}>
            <div className="panel-card-header" onClick={() => setExpanded(expanded === idx ? null : idx)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="toggle-btn" onClick={e => { e.stopPropagation(); update(idx, 'enabled', !srv.enabled) }}>
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
                    title="小米账号扫码登录"
                  >
                    <LogIn size={14} /> 登录
                  </button>
                )}
                <button className="icon-btn danger" onClick={e => { e.stopPropagation(); removeServer(idx) }}><Trash2 size={15}/></button>
              </div>
            </div>

            {expanded === idx && (
              <div className="panel-card-body">
                <div className="form-row">
                  <div className="form-group flex-1">
                    <label className="form-label">Server Name (key)</label>
                    <input className="form-input" value={srv.name} onChange={e => update(idx,'name',e.target.value)} />
                  </div>
                </div>

                {isHttp(srv) ? (
                  <div className="form-group">
                    <label className="form-label">URL</label>
                    <input className="form-input" value={srv.url || ''} onChange={e => update(idx,'url',e.target.value)} placeholder="https://..." />
                  </div>
                ) : (
                  <>
                    <div className="form-row">
                      <div className="form-group flex-1">
                        <label className="form-label">Command</label>
                        <input className="form-input" value={srv.command || ''} onChange={e => update(idx,'command',e.target.value)} placeholder="python3" />
                      </div>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Args (one per line)</label>
                      <textarea className="form-input form-textarea" rows={3} value={(srv.args || []).join('\n')} onChange={e => updateArgs(idx, e.target.value)} placeholder="../mcp/server.py" />
                    </div>
                  </>
                )}

                {srv.env && Object.keys(srv.env).length > 0 && (
                  <div className="form-group">
                    <label className="form-label">Environment Variables</label>
                    {Object.entries(srv.env).map(([k, v]) => (
                      <div key={k} className="env-var-row" style={{ marginBottom: 8 }}>
                        <input className="form-input env-key-input" value={k} readOnly style={{ opacity: 0.7 }} />
                        <span className="env-eq">=</span>
                        <input className="form-input" value={v} onChange={e => updateEnvEntry(idx, k, e.target.value)} style={{ flex: 1 }} />
                      </div>
                    ))}
                  </div>
                )}

                {srv.headers && (
                  <div className="form-group">
                    <label className="form-label">Headers</label>
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
