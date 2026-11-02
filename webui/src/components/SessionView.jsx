import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react'
import { createPortal } from 'react-dom'
import { Send, User, Bot, Plus, Cpu, ChevronDown, ChevronUp, CheckCircle2, Loader2, FileText, X, Download } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useLanguage } from './LanguageContext'
import './SessionView.css'

// 提取文本中的所有图片路径或 URL，包含本地绝对路径、file:/// 协议和普通 http/https 链接
// 使用最终代理 URL 去重，避免同一图片以不同格式出现多次（如 /path 和 file:///path）
const extractImages = (text) => {
  if (!text || typeof text !== 'string') return [];
  const imageRegex = /(https?:\/\/[^\s\n)]+\.(?:png|jpg|jpeg|gif|webp|svg))|(file:\/\/\/[^\s\n)]+\.(?:png|jpg|jpeg|gif|webp|svg))|((?:\/[^\s\n?#)]+)+\.(?:png|jpg|jpeg|gif|webp|svg))/gi;
  const matches = [...text.matchAll(imageRegex)];
  const urls = [];
  const seenWebUrls = new Set(); // 按最终代理 URL 去重，而非原始路径
  
  for (const match of matches) {
    const rawPath = match[0];
    
    let webUrl = rawPath;
    if (rawPath.toLowerCase().startsWith('file:///')) {
      // file:///Users/... → /Users/... (去掉 file:// 保留开头的 /)
      const absolutePath = rawPath.substring(7);
      webUrl = `/api/file?path=${encodeURIComponent(absolutePath)}`;
    } else if (rawPath.startsWith('/')) {
      webUrl = `/api/file?path=${encodeURIComponent(rawPath)}`;
    }

    // 按解析后的 webUrl 去重（这样 /path 和 file:///path 同一文件不会重复显示）
    if (seenWebUrls.has(webUrl)) continue;
    seenWebUrls.add(webUrl);
    
    urls.push({
      original: rawPath,
      webUrl: webUrl
    });
  }
  return urls;
};

// ───────── 文件路径识别 ─────────
// 会话里经常出现报告/数据文件路径（如 workspace/reports/daily_weather_20261030.md），
// 需要渲染成可点击的入口。图片扩展名不在此列：图片走 extractImages 的画廊/灯箱
const FILE_EXT_PATTERN = 'md|markdown|txt|log|json|csv|tsv|ya?ml|py|mjs?|sh|html?|pdf'
const FILE_EXT_RE = new RegExp(`\\.(?:${FILE_EXT_PATTERN})$`, 'i')
const IMAGE_EXT_RE = /\.(?:png|jpg|jpeg|gif|webp|svg)$/i

// 去掉包裹用的标点/引号与 file:// 前缀，得到可以丢给 /api/file 的路径
const normalizeFilePath = (raw) => {
  let p = String(raw ?? '').trim()
  p = p.replace(/^file:\/\//i, '')
  p = p.replace(/^[（(【\["'`]+/, '').replace(/[)"'`\]】），。、；;:,]+$/, '')
  if (p.startsWith('./')) p = p.slice(2)
  return p
}

const isFilePathToken = (raw) => {
  const p = normalizeFilePath(raw)
  if (!p || p.length > 260 || /\s/.test(p)) return false
  if (/^(?:https?|ftp|mailto|tel|data):/i.test(p)) return false
  if (p.startsWith('/api/')) return false
  // 至少带一层目录，避免把正文里的 "agent.yaml" 这类词误判成文件入口
  if (!p.includes('/')) return false
  return FILE_EXT_RE.test(p)
}

const isLocalFileHref = (href) => {
  if (!href || typeof href !== 'string') return false
  if (/^(?:https?|ftp|mailto|tel|data):/i.test(href) || href.startsWith('#')) return false
  if (href.startsWith('/api/')) return false
  return isFilePathToken(href.split(/[?#]/)[0])
}

// 扫描正文中未被 markdown 语法覆盖的裸路径（代码块/inline code/链接里的已由渲染器接管）
const extractFilePaths = (text) => {
  if (!text || typeof text !== 'string') return []
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/(?:https?|ftp):\/\/\S+/gi, ' ')

  const found = []
  for (const token of stripped.match(/[^\s"'`()（）\[\]【】<>{},，。；：、]+/g) || []) {
    const p = normalizeFilePath(token)
    if (isFilePathToken(p) && !found.includes(p)) found.push(p)
  }
  return found
}

// ───────── Lightbox 全局弹出组件 ─────────
function Lightbox({ src, alt, onClose }) {
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // 必须挂到 body：.chat-container 带 backdrop-filter + overflow:hidden，
  // 会成为 position:fixed 子元素的包含块并把弹层裁掉一部分
  return createPortal(
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} className="lightbox-image" />
        <button className="lightbox-close" onClick={onClose}>✕</button>
      </div>
    </div>,
    document.body
  );
}

// ───────── 文件预览弹窗 ─────────
const fileApiUrl = (p) => `/api/file?path=${encodeURIComponent(normalizeFilePath(p))}`

function FilePreview({ path: filePath, onClose }) {
  const { t } = useLanguage()
  const cleanPath = normalizeFilePath(filePath)
  const url = fileApiUrl(cleanPath)
  const isImage = IMAGE_EXT_RE.test(cleanPath)
  const isPdf = /\.pdf$/i.test(cleanPath)
  const isHtml = /\.html?$/i.test(cleanPath)
  const isMarkdown = /\.(?:md|markdown)$/i.test(cleanPath)
  const needsFetch = !isImage && !isPdf && !isHtml

  const [loading, setLoading] = useState(needsFetch)
  const [error, setError] = useState('')
  const [content, setContent] = useState('')
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  useEffect(() => {
    if (!needsFetch) return
    let cancelled = false
    setLoading(true); setError(''); setContent(''); setTruncated(false)

    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          // 403/404 时后端返回 JSON（含 reason），直接展示比光秃秃的状态码有用
          let reason = `${res.status} ${res.statusText}`
          try {
            const body = await res.json()
            reason = body.reason || body.error || reason
          } catch { /* 非 JSON 响应，保留状态码 */ }
          throw new Error(reason)
        }
        return res.text()
      })
      .then((text) => {
        if (cancelled) return
        const LIMIT = 200000
        setTruncated(text.length > LIMIT)
        setContent(text.slice(0, LIMIT))
      })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [url, needsFetch])

  // portal 到 body，避免被 .chat-container / .message-body 的 overflow 与
  // backdrop-filter 裁剪成「只露一半」
  return createPortal(
    <div className="file-preview-overlay" onClick={onClose}>
      <div className="file-preview-panel" onClick={(e) => e.stopPropagation()}>
        <header className="file-preview-header">
          <div className="file-preview-title">
            <FileText size={16} />
            <span className="file-preview-name">{cleanPath.split('/').pop()}</span>
            <span className="file-preview-path" title={cleanPath}>{cleanPath}</span>
          </div>
          <div className="file-preview-actions">
            <a className="file-preview-btn" href={url} download title={t('file_preview_download')}>
              <Download size={15} />
            </a>
            <button className="file-preview-btn" onClick={onClose} title={t('file_preview_close')}>
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="file-preview-body">
          {loading && <div className="file-preview-hint">{t('file_preview_loading')}</div>}
          {!loading && error && (
            <div className="file-preview-hint error">{t('file_preview_error')}{error}</div>
          )}
          {!loading && !error && isImage && (
            <img className="file-preview-image" src={url} alt={cleanPath} />
          )}
          {!loading && !error && isPdf && (
            <iframe className="file-preview-frame" src={url} title={cleanPath} />
          )}
          {!loading && !error && isHtml && (
            <iframe className="file-preview-frame" src={url} title={cleanPath} sandbox="" />
          )}
          {!loading && !error && needsFetch && (
            isMarkdown ? (
              <div className="markdown-body file-preview-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    table: ({node, ...props}) => (
                      <div className="table-container">
                        <table {...props} />
                      </div>
                    )
                  }}
                >
                  {content}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="file-preview-text"><code>{content}</code></pre>
            )
          )}
          {truncated && <div className="file-preview-hint">{t('file_preview_truncated')}</div>}
        </div>
      </div>
    </div>,
    document.body
  )
}

// 可点击的文件条目：正文里出现的报告/数据文件都会渲染成这个
function FileChips({ files, onOpen }) {
  if (!files || files.length === 0) return null
  return (
    <div className="message-files">
      {files.map((f) => (
        <button key={f} type="button" className="file-chip" onClick={() => onOpen(f)} title={f}>
          <FileText size={13} />
          <span className="file-chip-name">{f.split('/').pop()}</span>
        </button>
      ))}
    </div>
  )
}

// react-markdown 组件集合：链接与行内代码中的本地路径同样可点击预览
const buildMarkdownComponents = ({ onOpenFile, onImageClick, imageTitle }) => ({
  table: ({node, ...props}) => (
    <div className="table-container">
      <table {...props} />
    </div>
  ),
  a: ({node, href, children, ...props}) => {
    if (isLocalFileHref(href)) {
      return (
        <button type="button" className="inline-file-link" onClick={() => onOpenFile(normalizeFilePath(href))}>
          {children}
        </button>
      )
    }
    return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>
  },
  code: ({node, className, children, ...props}) => {
    const text = typeof children === 'string'
      ? children
      : Array.isArray(children) ? children.join('') : ''
    // 只接管行内代码；带 language-* 的是 fenced block
    if (!className && isFilePathToken(text)) {
      return (
        <button type="button" className="inline-file-link" onClick={() => onOpenFile(normalizeFilePath(text))}>
          <FileText size={12} />{text}
        </button>
      )
    }
    return <code className={className} {...props}>{children}</code>
  },
  img: ({node, src, ...props}) => {
    let webUrl = src
    if (src) {
      if (src.toLowerCase().startsWith('file:///')) {
        webUrl = fileApiUrl(src.substring(7))
      } else if (src.startsWith('/')) {
        webUrl = fileApiUrl(src)
      }
    }
    return (
      <img
        src={webUrl}
        className="chat-embedded-image chat-thumbnail"
        onClick={() => onImageClick(webUrl)}
        title={imageTitle}
        {...props}
      />
    )
  }
})

// ───────── 子组件：渲染单个消息泡，支持独立的折叠与状态 ─────────
function MessageItem({ msg }) {
  const [showThinking, setShowThinking] = useState(true);
  const [expandedTools, setExpandedTools] = useState({});
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [previewPath, setPreviewPath] = useState(null);
  const { t } = useLanguage();

  // 图片正则扫描成本不低，且流式过程中每条 chunk 都会触发渲染；
  // 只有该消息文本变化时才需要重新提取
  const detectedImages = useMemo(() => extractImages(msg.content), [msg.content]);
  const detectedFiles = useMemo(() => extractFilePaths(msg.content), [msg.content]);
  const markdownComponents = buildMarkdownComponents({
    onOpenFile: setPreviewPath,
    onImageClick: setLightboxSrc,
    imageTitle: t('lightbox_hover'),
  });

  const toggleTool = (toolId) => {
    setExpandedTools(prev => ({
      ...prev,
      [toolId]: !prev[toolId]
    }));
  };

  if (msg.role === 'system') {
    return (
      <div className="message-wrapper system">
        <div className="message-bubble markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {msg.content}
          </ReactMarkdown>
          <FileChips files={detectedFiles} onOpen={setPreviewPath} />
        </div>
        {previewPath && <FilePreview path={previewPath} onClose={() => setPreviewPath(null)} />}
      </div>
    );
  }

  return (
    <div className={`message-wrapper ${msg.role}`}>
      <div className="message-avatar">
        {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
      </div>
      <div className="message-body">
        {/* 1. 思考过程显示 (只限 assistant) */}
        {msg.role === 'assistant' && msg.reasoning && (
          <div className="thinking-box glass-panel">
            <div className="thinking-header" onClick={() => setShowThinking(!showThinking)}>
              <span className="thinking-title flex-items-center">
                <Cpu size={14} className={`thinking-icon ${!msg.isThinkingFinished ? 'spin-animation' : ''}`} />
                {t('thinking_title')} {!msg.isThinkingFinished ? t('thinking_status_active') : t('thinking_status_finished')}
              </span>
              {showThinking ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </div>
            {showThinking && (
              <div className="thinking-content">
                {msg.reasoning}
              </div>
            )}
          </div>
        )}

        {/* 2. 工具调用显示 (只限 assistant) */}
        {msg.role === 'assistant' && msg.tools && msg.tools.length > 0 && (
          <div className="tools-container">
            {msg.tools.map(tool => {
              const isExpanded = expandedTools[tool.id];
              return (
                <div key={tool.id} className={`tool-item-box ${tool.status} glass-panel`}>
                  <div className="tool-header" onClick={() => toggleTool(tool.id)}>
                    <span className="tool-title flex-items-center">
                      {tool.status === 'running' ? (
                        <Loader2 size={14} className="spin-animation tool-icon-status running" />
                      ) : (
                        <CheckCircle2 size={14} className="tool-icon-status done" />
                      )}
                      {t('tool_call_prefix')}<code className="tool-name-code">{tool.name}</code>
                    </span>
                    <div className="tool-header-right flex-items-center">
                      <span className={`tool-status-badge ${tool.status}`}>
                        {tool.status === 'running' ? t('tool_status_running') : t('tool_status_done')}
                      </span>
                      {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="tool-details-content">
                      <div className="tool-section">
                        <span className="tool-section-label">{t('tool_section_args')}</span>
                        <pre className="tool-code"><code>{tool.args}</code></pre>
                      </div>
                      {tool.result && (
                        <div className="tool-section">
                          <span className="tool-section-label">{t('tool_section_result')}</span>
                          <pre className="tool-code"><code>{tool.result}</code></pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 3. 最终回复文本 */}
        {msg.content && (
          <div className="message-bubble markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {msg.content}
            </ReactMarkdown>
            {/* 正文里裸写的文件路径（未被链接/行内代码包裹）也渲染成可点击条目 */}
            <FileChips files={detectedFiles} onOpen={setPreviewPath} />
          </div>
        )}

        {/* 4. 如果内容中包含图片地址，直接在下方显示图片 */}
        {detectedImages.length > 0 && (
          <div className="message-images-gallery">
            {detectedImages.map((img, idx) => (
              <div
                key={img.webUrl}
                className="message-image-card glass-panel"
                onClick={() => setLightboxSrc(img.webUrl)}
                title={t('lightbox_hover')}
              >
                <img
                  src={img.webUrl}
                  alt={`${t('lightbox_title')} ${idx + 1}`}
                  className="message-inline-image"
                  onError={(e) => {
                    e.target.parentElement.style.display = 'none';
                  }}
                />
                <div className="image-caption">{img.original.split('/').pop()}</div>
              </div>
            ))}
          </div>
        )}

        {/* Lightbox 弹出大图 */}
        {lightboxSrc && (
          <Lightbox 
            src={lightboxSrc} 
            alt={t('lightbox_title')} 
            onClose={() => setLightboxSrc(null)} 
          />
        )}

        {/* 文件预览弹窗（报告 / 数据 / 日志等） */}
        {previewPath && (
          <FilePreview path={previewPath} onClose={() => setPreviewPath(null)} />
        )}
      </div>
    </div>
  );
}

// 流式输出时父组件每个 chunk 都会重渲染；非目标消息对象引用不变，
// memo 化后可以跳过多余的 Markdown 解析与图片提取
const MemoMessageItem = memo(MessageItem);

// ───────── 主组件 ─────────
export default function SessionView() {
  const { t } = useLanguage();
  const [sessionId] = useState(() => {
    const savedId = localStorage.getItem('webui_session_id');
    if (savedId) return savedId;
    const newId = 'webui_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('webui_session_id', newId);
    return newId;
  });

  const [messages, setMessages] = useState([
    { id: 1, role: 'system', content: t('msg_init') }
  ])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/chat/history?sessionId=${sessionId}`)
      const data = await res.json()
      if (data.history && data.history.length > 0) {
        // 历史记录里的 tools 必须保留：后端已把 assistant.tool_calls 与
        // 对应的 role=tool 结果组装好，丢弃的话刷新后就只剩气泡、
        // 与流式时的工具卡片不一致
        setMessages(data.history.map(m => ({
          ...m,
          isThinkingFinished: true,
          tools: m.tools || []
        })))
      }
    } catch (err) {
      console.error('Failed to load chat history:', err)
    }
  }, [sessionId])

  // 流式进行中不要用历史覆盖本地状态，否则会冲掉正在生成的消息
  const typingRef = useRef(false)
  useEffect(() => { typingRef.current = isTyping }, [isTyping])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  useEffect(() => {
    // 服务端异步通知（如心跳巡检告警）：/api/chat 是一问一答的流，承载不了
    // 旁路消息，这里用一条 SSE 长连接实时把通知追加进当前会话
    if (typeof EventSource === 'undefined') return

    const source = new EventSource('/api/events')
    let connected = false

    source.onopen = () => {
      // 断线重连（服务端 --watch 重启、网络抖动）期间推送会丢：补拉一次历史
      if (connected && !typingRef.current) loadHistory()
      connected = true
    }

    source.onmessage = (e) => {
      let event
      try { event = JSON.parse(e.data) } catch { return }
      if (!event?.content) return
      // 后端按「最近交互的会话」投递，别的标签页/会话的通知不要串进来
      if (event.sessionId && event.sessionId !== sessionId) return
      setMessages(prev => [...prev, {
        id: `event_${event.id ?? Date.now()}`,
        role: 'system',
        content: event.content,
      }])
    }
    // onerror 无需处理：EventSource 会自动重连（服务重启后也能接回来）

    return () => source.close()
  }, [sessionId, loadHistory])

  const handleSend = async () => {
    if (!input.trim() || isTyping) return
    
    const userMessage = input.trim()
    const newMsg = { id: Date.now(), role: 'user', content: userMessage }
    setMessages(prev => [...prev, newMsg])
    setInput('')
    setIsTyping(true)
    
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage, sessionId, stream: true })
      });
      
      if (!response.ok) {
        throw new Error(`${t('request_error')}${response.statusText}`);
      }

      if (!response.body) {
        throw new Error(t('stream_error'));
      }

      // 后端异常时可能返回 JSON/HTML 而非 SSE；不校验的话循环里所有行都不以
      // "data: " 开头被静默跳过，用户只看到一个空白气泡，完全没有错误提示
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        const raw = await response.text();
        throw new Error(raw.slice(0, 300) || t('stream_error'));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let done = false;
      let buffer = '';

      const assistantMsgId = Date.now();
      let accumulatedReasoning = '';
      let accumulatedContent = '';
      let runningTools = [];

      // 先插入一条空的 AI 助理消息作为展板
      setMessages(prev => [...prev, {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        reasoning: '',
        isThinkingFinished: false,
        tools: []
      }]);

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 最后一个不完整行放回 Buffer

          for (const line of lines) {
            const cleanLine = line.trim();
            if (!cleanLine.startsWith('data: ')) continue;
            
            try {
              const event = JSON.parse(cleanLine.substring(6));
              
              if (event.type === 'reasoning') {
                accumulatedReasoning += event.content;
                setMessages(prev => prev.map(m => m.id === assistantMsgId ? {
                  ...m,
                  reasoning: accumulatedReasoning
                } : m));
              } else if (event.type === 'content') {
                accumulatedContent += event.content;
                setMessages(prev => prev.map(m => m.id === assistantMsgId ? {
                  ...m,
                  isThinkingFinished: true,
                  content: accumulatedContent
                } : m));
              } else if (event.type === 'tool_start') {
                const newTool = {
                  id: event.id,
                  name: event.name,
                  args: typeof event.arguments === 'object' ? JSON.stringify(event.arguments, null, 2) : String(event.arguments),
                  status: 'running',
                  result: ''
                };
                runningTools = [...runningTools, newTool];
                setMessages(prev => prev.map(m => m.id === assistantMsgId ? {
                  ...m,
                  isThinkingFinished: true,
                  tools: runningTools
                } : m));
              } else if (event.type === 'tool_end') {
                const formattedResult = typeof event.result === 'object' ? JSON.stringify(event.result, null, 2) : String(event.result);
                runningTools = runningTools.map(t => t.id === event.id ? { ...t, status: 'done', result: formattedResult } : t);
                setMessages(prev => prev.map(m => m.id === assistantMsgId ? {
                  ...m,
                  tools: runningTools
                } : m));
              } else if (event.type === 'done') {
                if (event.reply && !accumulatedContent) {
                  accumulatedContent = event.reply;
                }
                setMessages(prev => prev.map(m => m.id === assistantMsgId ? {
                  ...m,
                  isThinkingFinished: true,
                  content: accumulatedContent,
                  tools: runningTools
                } : m));
              } else if (event.type === 'error') {
                setMessages(prev => prev.map(m => m.id === assistantMsgId ? {
                  ...m,
                  isThinkingFinished: true,
                  content: m.content + `\n\n⚠️ **${t('system_error')}**: ${event.message}`
                } : m));
              }
            } catch (err) {
              console.warn('解析流式 Event 出错:', cleanLine, err);
            }
          }
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, { 
        id: Date.now(), 
        role: 'assistant', 
        content: `${t('request_error')}${err.message}` 
      }])
    } finally {
      setIsTyping(false)
    }
  }

  const handleNewSession = async () => {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '/new', sessionId })
      });
      // /api/chat now streams SSE — drain and discard the body to close cleanly
      if (res.body) await res.body.cancel();
      setMessages([{ id: Date.now(), role: 'system', content: t('msg_restarted') }])
    } catch(err) {
      console.error(err)
    }
  }

  return (
    <div className="session-view fade-in">
      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">{t('session_title')}</h1>
          <p className="view-subtitle">{t('session_subtitle', { id: sessionId })}</p>
        </div>
        <button className="btn btn-outline" onClick={handleNewSession}>
          <Plus size={16} /> {t('btn_new_session')}
        </button>
      </header>

      <div className="chat-container glass-panel">
        <div className="messages-list">
          {messages.map(msg => (
            <MemoMessageItem key={msg.id} msg={msg} />
          ))}
          {isTyping && (
            <div className="message-wrapper assistant">
              <div className="message-avatar"><Bot size={16} /></div>
              <div className="message-body">
                <div className="message-bubble typing-indicator">
                  <span>.</span><span>.</span><span>.</span>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        
        <div className="chat-input-area">
          <input 
            type="text" 
            className="chat-input"
            placeholder={t('chat_placeholder')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 中文输入法组词时按 Enter 是「确认候选词」，不应触发发送
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
              e.preventDefault()
              handleSend()
            }}
            disabled={isTyping}
          />
          <button className="btn-send" onClick={handleSend} disabled={isTyping}>
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
