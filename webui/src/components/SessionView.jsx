import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react'
import { Send, User, Bot, Plus, Cpu, ChevronDown, ChevronUp, CheckCircle2, Loader2 } from 'lucide-react'
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

// ───────── Lightbox 全局弹出组件 ─────────
function Lightbox({ src, alt, onClose }) {
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} className="lightbox-image" />
        <button className="lightbox-close" onClick={onClose}>✕</button>
      </div>
    </div>
  );
}

// ───────── 子组件：渲染单个消息泡，支持独立的折叠与状态 ─────────
function MessageItem({ msg }) {
  const [showThinking, setShowThinking] = useState(true);
  const [expandedTools, setExpandedTools] = useState({});
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const { t } = useLanguage();

  // 图片正则扫描成本不低，且流式过程中每条 chunk 都会触发渲染；
  // 只有该消息文本变化时才需要重新提取
  const detectedImages = useMemo(() => extractImages(msg.content), [msg.content]);

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
            components={{
              table: ({node, ...props}) => (
                <div className="table-container">
                  <table {...props} />
                </div>
              )
            }}
          >
            {msg.content}
          </ReactMarkdown>
        </div>
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
              components={{
                table: ({node, ...props}) => (
                  <div className="table-container">
                    <table {...props} />
                  </div>
                ),
                img: ({node, src, ...props}) => {
                  let webUrl = src;
                  if (src) {
                    if (src.toLowerCase().startsWith('file:///')) {
                      webUrl = `/api/file?path=${encodeURIComponent(src.substring(7))}`;
                    } else if (src.startsWith('/')) {
                      webUrl = `/api/file?path=${encodeURIComponent(src)}`;
                    }
                  }
                  return (
                    <img 
                      src={webUrl} 
                      className="chat-embedded-image chat-thumbnail"
                      onClick={() => setLightboxSrc(webUrl)}
                      title={t('lightbox_hover')}
                      {...props} 
                    />
                  );
                }
              }}
            >
              {msg.content}
            </ReactMarkdown>
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
