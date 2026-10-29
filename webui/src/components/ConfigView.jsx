import { useState, useEffect } from 'react'
import { Save, RefreshCw, Plus, Trash2, ChevronDown, ChevronUp, Database, Cpu, Server, FileText, ArrowLeft, Eye, EyeOff, Key } from 'lucide-react'
import { useLanguage } from './LanguageContext'
import './ConfigView.css'

const DEFAULT_PROVIDER = {
  name: '',
  base_url: '',
  api_key_env: '',
  models: [{ id: '', thinking: false, stream: true }],
}

// ── Model selector built from providers list ──
function ModelSelect({ name, value, providers = [], onChange, allowEmpty = false }) {
  const { t } = useLanguage()
  // Build options: group by provider
  const options = []
  for (const p of providers) {
    for (const m of (p.models || [])) {
      const modelId = typeof m === 'string' ? m : m.id
      if (modelId) options.push({ label: `${p.name} / ${modelId}`, value: `${p.name}/${modelId}` })
    }
  }

  // If current value isn't in options, still show it as a custom option
  const isCustom = value && !options.find(o => o.value === value)

  return (
    <div className="model-select-wrap">
      <select
        name={name}
        value={value || ''}
        onChange={onChange}
        className="form-input form-select"
      >
        {allowEmpty && <option value="">— {t('cfg_fallback_model')} —</option>}
        {isCustom && <option value={value}>{value}</option>}
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
        {options.length === 0 && !isCustom && (
          <option disabled value="">{t('cfg_providers_empty')}</option>
        )}
      </select>
    </div>
  )
}


// .env 行的本地稳定标识：既做 React key，也做「显示/隐藏」状态的键。
// 不能用数组下标（删行后整体前移 → 密钥在别的行上意外明文显示），
// 也不能用变量名（输入时每个字符都会变 → 输入框失焦且状态被重置）。
let envUid = 0
const nextEnvKey = () => `e${++envUid}`

const MEMORY_FILES = [
  { key: 'user_profile', label: 'User Profile', desc: '用户偏好与画像' },
  { key: 'knowledge', label: 'Knowledge', desc: '长期知识库与经验' },
  { key: 'facts', label: 'Facts', desc: '事实记录与重要数据' },
  { key: 'context', label: 'Context', desc: '当前上下文与即时背景信息' },
]

export default function ConfigView() {
  const { t } = useLanguage()
  const [activeTab, setActiveTab] = useState('agent')
  const [config, setConfig] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [expandedProvider, setExpandedProvider] = useState(null)

  // Memory editor state
  const [memEditor, setMemEditor] = useState(null)  // { key, filename, label }
  const [memContent, setMemContent] = useState('')
  const [memSaving, setMemSaving] = useState(false)
  const [memLoading, setMemLoading] = useState(false)
  const [memSaveMsg, setMemSaveMsg] = useState('')

  useEffect(() => {
    fetch('/api/config')
      .then(res => res.json())
      .then(data => setConfig(data))
      .catch(err => console.error('Failed to fetch config', err))
  }, [])

  const openMemFile = async (fileKey) => {
    if (!config) return
    const filename = config.memory[fileKey]
    setMemEditor({ key: fileKey, filename, label: t(`mem_${fileKey}`) })
    setMemContent('')
    setMemLoading(true)
    setMemSaveMsg('')
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(filename)}`)
      const data = await res.json()
      setMemContent(data.content || '')
    } catch (e) {
      setMemContent('')
    } finally {
      setMemLoading(false)
    }
  }

  const saveMemFile = async () => {
    if (!memEditor) return
    setMemSaving(true)
    setMemSaveMsg('')
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(memEditor.filename)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: memContent })
      })
      const data = await res.json()
      setMemSaveMsg(data.success ? t('save_ok') : `${t('save_err')}${data.error}`)
    } catch (err) {
      setMemSaveMsg(`${t('save_err')}${err.message}`)
    } finally {
      setMemSaving(false)
      setTimeout(() => setMemSaveMsg(''), 3000)
    }
  }

  const handleAgentChange = (e) => {
    setConfig({ ...config, [e.target.name]: e.target.value })
  }

  // ── Env vars state ──
  const [envLines, setEnvLines] = useState([])
  const [envLoading, setEnvLoading] = useState(false)
  const [envSaving, setEnvSaving] = useState(false)
  const [envSaveMsg, setEnvSaveMsg] = useState('')
  const [hiddenKeys, setHiddenKeys] = useState({})

  const loadEnv = async () => {
    setEnvLoading(true)
    try {
      const res = await fetch('/api/env')
      const data = await res.json()
      setEnvLines((data.lines || []).map(line => ({ ...line, _key: nextEnvKey() })))
    } catch (e) { console.error(e) }
    finally { setEnvLoading(false) }
  }

  const saveEnv = async () => {
    setEnvSaving(true)
    setEnvSaveMsg('')
    try {
      const res = await fetch('/api/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: envLines })
      })
      const data = await res.json()
      if (!data.success) {
        setEnvSaveMsg(`${t('save_err')}${data.error}`)
      } else if (Array.isArray(data.requiresRestart) && data.requiresRestart.length > 0) {
        // 后端会如实返回无法热重载的模块（如飞书、mcporter），
        // 只提示「保存成功」会让用户误以为立即生效
        setEnvSaveMsg(t('save_ok_restart', { modules: data.requiresRestart.join('、') }))
      } else {
        setEnvSaveMsg(t('save_ok'))
      }
    } catch (err) {
      setEnvSaveMsg(`${t('save_err')}${err.message}`)
    } finally {
      setEnvSaving(false)
      setTimeout(() => setEnvSaveMsg(''), 5000)
    }
  }

  const updateEnvLine = (idx, field, val) => {
    setEnvLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: val } : l))
  }

  const addEnvVar = () => {
    setEnvLines(prev => [...prev, { _key: nextEnvKey(), type: 'var', key: '', value: '' }])
  }

  const removeEnvLine = (idx) => {
    setEnvLines(prev => prev.filter((_, i) => i !== idx))
  }

  const toggleHide = (key) => {
    // 默认是隐藏（hiddenKeys 里没有记录 → 视为 true），首次点击必须切到「显示」
    setHiddenKeys(prev => ({ ...prev, [key]: !(prev[key] ?? true) }))
  }

  const isSensitive = (key = '') => /key|secret|token|password|pass|api/i.test(key)

  // ── Provider operations ──
  const updateProvider = (idx, field, value) => {
    const providers = [...config.providers]
    providers[idx] = { ...providers[idx], [field]: value }
    setConfig({ ...config, providers })
  }

  const updateProviderModel = (pIdx, mIdx, field, value) => {
    const providers = [...config.providers]
    const models = [...(providers[pIdx].models || [])]
    models[mIdx] = { ...models[mIdx], [field]: field === 'id' ? value : (value === 'true' || value === true) }
    providers[pIdx] = { ...providers[pIdx], models }
    setConfig({ ...config, providers })
  }

  const addModel = (pIdx) => {
    const providers = [...config.providers]
    providers[pIdx] = {
      ...providers[pIdx],
      models: [...(providers[pIdx].models || []), { id: '', thinking: false, stream: true }]
    }
    setConfig({ ...config, providers })
  }

  const removeModel = (pIdx, mIdx) => {
    const providers = [...config.providers]
    const models = providers[pIdx].models.filter((_, i) => i !== mIdx)
    providers[pIdx] = { ...providers[pIdx], models }
    setConfig({ ...config, providers })
  }

  const addProvider = () => {
    const providers = [...(config.providers || []), { ...DEFAULT_PROVIDER, models: [{ id: '', thinking: false, stream: true }] }]
    setConfig({ ...config, providers })
    setExpandedProvider(providers.length - 1)
  }

  const removeProvider = (idx) => {
    const providers = config.providers.filter((_, i) => i !== idx)
    setConfig({ ...config, providers })
    if (expandedProvider === idx) setExpandedProvider(null)
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveMsg('')
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      })
      const data = await res.json()
      setSaveMsg(data.success ? t('save_ok') : `${t('save_err')}${data.error}`)
    } catch (err) {
      setSaveMsg(`${t('save_err')}${err.message}`)
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 3000)
    }
  }

  if (!config) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--text-muted)' }}>
      <RefreshCw size={20} className="spin" style={{ marginRight: 10 }} /> {t('cfg_loading_config')}
    </div>
  )

  return (
    <div className="config-view fade-in">
      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">{t('cfg_title')}</h1>
          <p className="view-subtitle">{t('cfg_subtitle')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {saveMsg && <span className={`save-msg ${saveMsg.startsWith('✓') || saveMsg.includes('成功') ? 'ok' : 'err'}`}>{saveMsg}</span>}
          {activeTab !== 'memory' && activeTab !== 'env' && (
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? <RefreshCw className="spin" size={16} /> : <Save size={16} />}
              {saving ? t('btn_saving') : t('btn_save_changes')}
            </button>
          )}
        </div>
      </header>

      {/* Tabs */}
      <div className="config-tabs">
        <button className={`config-tab ${activeTab === 'agent' ? 'active' : ''}`} onClick={() => { setActiveTab('agent'); setMemEditor(null) }}>
          <Cpu size={16} /> {t('cfg_tab_agent')}
        </button>
        <button className={`config-tab ${activeTab === 'memory' ? 'active' : ''}`} onClick={() => { setActiveTab('memory'); setMemEditor(null) }}>
          <Database size={16} /> {t('cfg_tab_memory')}
        </button>
        <button className={`config-tab ${activeTab === 'providers' ? 'active' : ''}`} onClick={() => { setActiveTab('providers'); setMemEditor(null) }}>
          <Server size={16} /> {t('cfg_tab_providers')}
        </button>
        <button className={`config-tab ${activeTab === 'env' ? 'active' : ''}`} onClick={() => { setActiveTab('env'); setMemEditor(null); loadEnv() }}>
          <Key size={16} /> {t('cfg_tab_env')}
        </button>
      </div>

      {/* ── Agent Tab ── */}
      {activeTab === 'agent' && (
        <div className="config-grid single-col fade-in">
          <div className="config-card glass-panel">
            <h2 className="card-title">{t('cfg_agent_title')}</h2>
            <div className="form-row">
              <div className="form-group flex-1">
                <label className="form-label">{t('cfg_agent_name')}</label>
                <input type="text" name="name" value={config.name} onChange={handleAgentChange} className="form-input" />
              </div>
              <div className="form-group flex-1">
                <label className="form-label">{t('cfg_agent_workspace')}</label>
                <input type="text" name="workspace" value={config.workspace} onChange={handleAgentChange} className="form-input" disabled />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group flex-1">
                <label className="form-label">{t('cfg_default_model')}</label>
                <ModelSelect name="model" value={config.model} providers={config.providers} onChange={handleAgentChange} />
                <span className="form-hint">{t('cfg_model_hint')}</span>
              </div>
              <div className="form-group flex-1">
                <label className="form-label">{t('cfg_fallback_model')}</label>
                <ModelSelect name="fallback" value={config.fallback} providers={config.providers} onChange={handleAgentChange} allowEmpty />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">{t('cfg_system_prompt')}</label>
              <textarea name="systemPrompt" value={config.systemPrompt} onChange={handleAgentChange} className="form-input form-textarea" rows={12} />
            </div>
          </div>
        </div>
      )}

      {/* ── Memory Tab ── */}
      {activeTab === 'memory' && !memEditor && (
        <div className="config-grid single-col fade-in">
          <div className="config-card glass-panel">
            <h2 className="card-title">{t('cfg_mem_title')}</h2>
            <div className="mem-dir-row">
              <span className="form-hint">{t('cfg_mem_dir')}</span>
              <code className="mem-dir-path">{config.memory.directory}</code>
            </div>
            <div className="mem-file-list">
              {MEMORY_FILES.map(f => (
                <div key={f.key} className="mem-file-item" onClick={() => openMemFile(f.key)}>
                  <div className="mem-file-icon"><FileText size={18} /></div>
                  <div className="mem-file-info">
                    <span className="mem-file-label">{t(`mem_${f.key}`)}</span>
                    <span className="mem-file-path">{config.memory[f.key]}</span>
                    <span className="mem-file-desc">{t(`mem_${f.key}_desc`)}</span>
                  </div>
                  <ChevronDown size={16} style={{ color: 'var(--text-muted)', transform: 'rotate(-90deg)' }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Memory File Editor ── */}
      {activeTab === 'memory' && memEditor && (
        <div className="config-grid single-col fade-in">
          <div className="config-card glass-panel">
            <div className="flex-between" style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="icon-btn" onClick={() => setMemEditor(null)} title={t('btn_back')}>
                  <ArrowLeft size={18} />
                </button>
                <div>
                  <h2 className="card-title" style={{ marginBottom: 2, borderBottom: 'none', paddingBottom: 0 }}>
                    {memEditor.label}
                  </h2>
                  <span className="form-hint">{memEditor.filename}</span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {memSaveMsg && <span className={`save-msg ${memSaveMsg.startsWith('✓') || memSaveMsg.includes('成功') ? 'ok' : 'err'}`}>{memSaveMsg}</span>}
                <button className="btn btn-primary" onClick={saveMemFile} disabled={memSaving || memLoading}>
                  {memSaving ? <RefreshCw className="spin" size={16} /> : <Save size={16} />}
                  {memSaving ? t('btn_saving') : t('btn_save')}
                </button>
              </div>
            </div>

            {memLoading ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
                <RefreshCw size={20} className="spin" />
              </div>
            ) : (
              <textarea
                className="form-input form-textarea mem-editor"
                value={memContent}
                onChange={e => setMemContent(e.target.value)}
                rows={20}
                placeholder={t('cfg_mem_empty', { filename: memEditor.filename })}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Providers Tab ── */}
      {activeTab === 'providers' && (
        <div className="config-grid single-col fade-in">
          <div className="config-card glass-panel">
            <div className="flex-between" style={{ marginBottom: 24 }}>
              <h2 className="card-title" style={{ marginBottom: 0, borderBottom: 'none', paddingBottom: 0 }}>{t('cfg_providers_title')}</h2>
              <button className="btn btn-primary" style={{ padding: '8px 16px', fontSize: 13 }} onClick={addProvider}>
                <Plus size={14} /> {t('btn_add_provider')}
              </button>
            </div>

            {(config.providers || []).length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '32px 0' }}>
                {t('cfg_providers_empty')}
              </div>
            )}

            {(config.providers || []).map((provider, pIdx) => (
              <div key={pIdx} className="provider-card">
                <div className="provider-header" onClick={() => setExpandedProvider(expandedProvider === pIdx ? null : pIdx)}>
                  <div>
                    <span className="provider-name">{provider.name || <em style={{ opacity: 0.4 }}>{t('cfg_provider_unnamed')}</em>}</span>
                    <span className="provider-meta">{provider.base_url || ''}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="icon-btn danger" onClick={(e) => { e.stopPropagation(); removeProvider(pIdx) }}>
                      <Trash2 size={15} />
                    </button>
                    {expandedProvider === pIdx ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                  </div>
                </div>

                {expandedProvider === pIdx && (
                  <div className="provider-body">
                    <div className="form-row">
                      <div className="form-group flex-1">
                        <label className="form-label">{t('cfg_provider_name')}</label>
                        <input type="text" value={provider.name} onChange={e => updateProvider(pIdx, 'name', e.target.value)} className="form-input" placeholder="e.g. openai" />
                      </div>
                      <div className="form-group flex-1">
                        <label className="form-label">{t('cfg_provider_api_key_env')}</label>
                        <input type="text" value={provider.api_key_env} onChange={e => updateProvider(pIdx, 'api_key_env', e.target.value)} className="form-input" placeholder="e.g. OPENAI_API_KEY" />
                      </div>
                    </div>
                    <div className="form-group">
                      <label className="form-label">{t('cfg_provider_base_url')}</label>
                      <input type="text" value={provider.base_url} onChange={e => updateProvider(pIdx, 'base_url', e.target.value)} className="form-input" placeholder="https://api.openai.com/v1" />
                    </div>

                    <div className="models-section">
                      <div className="flex-between" style={{ marginBottom: 12 }}>
                        <label className="form-label" style={{ margin: 0 }}>{t('cfg_provider_models')}</label>
                        <button className="btn-text" onClick={() => addModel(pIdx)}>{t('btn_add_model')}</button>
                      </div>
                      {(provider.models || []).map((model, mIdx) => (
                        <div key={mIdx} className="model-row">
                          <input
                            type="text"
                            value={model.id || ''}
                            onChange={e => updateProviderModel(pIdx, mIdx, 'id', e.target.value)}
                            className="form-input"
                            placeholder={t('cfg_model_id')}
                            style={{ flex: 1 }}
                          />
                          <label className="model-toggle">
                            <input type="checkbox" checked={!!model.thinking} onChange={e => updateProviderModel(pIdx, mIdx, 'thinking', e.target.checked)} />
                            {t('cfg_model_thinking')}
                          </label>
                          <label className="model-toggle">
                            <input type="checkbox" checked={!!model.stream} onChange={e => updateProviderModel(pIdx, mIdx, 'stream', e.target.checked)} />
                            {t('cfg_model_stream')}
                          </label>
                          <button className="icon-btn danger" onClick={() => removeModel(pIdx, mIdx)}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Env Tab ── */}
      {activeTab === 'env' && (
        <div className="config-grid single-col fade-in">
          <div className="config-card glass-panel">
            <div className="flex-between" style={{ marginBottom: 24 }}>
              <h2 className="card-title" style={{ marginBottom: 0, borderBottom: 'none', paddingBottom: 0 }}>{t('cfg_env_title')}</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {envSaveMsg && <span className={`save-msg ${envSaveMsg.startsWith('✓') || envSaveMsg.includes('成功') ? 'ok' : 'err'}`}>{envSaveMsg}</span>}
                <button className="btn-text" onClick={addEnvVar}><Plus size={14} /> {t('btn_add_var')}</button>
                <button className="btn btn-primary" style={{ padding: '8px 16px', fontSize: 13 }} onClick={saveEnv} disabled={envSaving}>
                  {envSaving ? <RefreshCw className="spin" size={16} /> : <Save size={16} />}
                  {envSaving ? t('btn_saving') : t('btn_save_env')}
                </button>
              </div>
            </div>

            {envLoading ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}><RefreshCw size={20} className="spin" /> {t('cfg_env_loading')}</div>
            ) : (
              <div className="env-list">
                {envLines.map((line, idx) => {
                  if (line.type === 'comment') {
                    return (
                      <div key={line._key} className="env-comment-row">
                        <span className="env-comment-text">{line.raw || '\u00a0'}</span>
                        <button className="icon-btn danger" onClick={() => removeEnvLine(idx)}><Trash2 size={13} /></button>
                      </div>
                    )
                  }
                  const sensitive = isSensitive(line.key)
                  // 用行自身的稳定标识判断显隐，避免删行后下标前移导致密钥明文显示
                  const hidden = hiddenKeys[line._key] !== false && sensitive
                  return (
                    <div key={line._key} className="env-var-row">
                      <Key size={14} className="env-key-icon" />
                      <input
                        className="form-input env-key-input"
                        value={line.key}
                        placeholder={t('cfg_env_key')}
                        onChange={e => updateEnvLine(idx, 'key', e.target.value)}
                      />
                      <span className="env-eq">=</span>
                      <div className="env-value-wrap">
                        <input
                          className="form-input env-value-input"
                          type={hidden ? 'password' : 'text'}
                          value={line.value}
                          placeholder={t('cfg_env_val')}
                          onChange={e => updateEnvLine(idx, 'value', e.target.value)}
                        />
                        {sensitive && (
                          <button className="icon-btn env-eye-btn" onClick={() => toggleHide(line._key)} title={hidden ? 'Show' : 'Hide'}>
                            {hidden ? <Eye size={14} /> : <EyeOff size={14} />}
                          </button>
                        )}
                      </div>
                      <button className="icon-btn danger" onClick={() => removeEnvLine(idx)}><Trash2 size={14} /></button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
