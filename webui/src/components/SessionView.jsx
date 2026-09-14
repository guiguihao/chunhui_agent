import { useState, useEffect, useRef } from 'react'
import { Send, User, Bot, Plus, Cpu, ChevronDown, ChevronUp, CheckCircle2, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
                AI 思考过程 {!msg.isThinkingFinished ? '(正在思考...)' : '(已完成)'}
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
                      调用工具: <code className="tool-name-code">{tool.name}</code>
                    </span>
                    <div className="tool-header-right flex-items-center">
                      <span className={`tool-status-badge ${tool.status}`}>
                        {tool.status === 'running' ? '正在执行' : '执行完成'}
                      </span>
                      {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="tool-details-content">
                      <div className="tool-section">
                        <span className="tool-section-label">参数:</span>
                        <pre className="tool-code"><code>{tool.args}</code></pre>
                      </div>
                      {tool.result && (
                        <div className="tool-section">
                          <span className="tool-section-label">输出:</span>
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
                      title="点击查看大图"
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
        {msg.content && (() => {
          const detectedImages = extractImages(msg.content);
          if (detectedImages.length === 0) return null;
          return (
            <div className="message-images-gallery">
              {detectedImages.map((img, idx) => (
                <div 
                  key={idx} 
                  className="message-image-card glass-panel"
                  onClick={() => setLightboxSrc(img.webUrl)}
                  title="点击查看大图"
                >
                  <img 
                    src={img.webUrl} 
                    alt={`图片 ${idx + 1}`} 
                    className="message-inline-image"
                    onError={(e) => {
                      e.target.parentElement.style.display = 'none';
                    }}
                  />
                  <div className="image-caption">{img.original.split('/').pop()}</div>
                </div>
              ))}
            </div>
          );
        })()}

        {/* Lightbox 弹出大图 */}
        {lightboxSrc && (
          <Lightbox 
            src={lightboxSrc} 
            alt="大图预览" 
            onClose={() => setLightboxSrc(null)} 
          />
        )}
      </div>
    </div>
  );
}

// ───────── 主组件 ─────────
export default function SessionView() {
  const [sessionId] = useState(() => {
    const savedId = localStorage.getItem('webui_session_id');
    if (savedId) return savedId;
    const newId = 'webui_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('webui_session_id', newId);
    return newId;
  });

  const [messages, setMessages] = useState([
    { id: 1, role: 'system', content: 'Agent initialized and ready. Please type a message to interact.' }
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

  useEffect(() => {
    // 加载历史会话
    fetch(`/api/chat/history?sessionId=${sessionId}`)
      .then(res => res.json())
      .then(data => {
        if (data.history && data.history.length > 0) {
          // 历史记录映射为带 thinking/tools 属性的对象，保持兼容性
          const mapped = data.history.map(m => ({
            ...m,
            isThinkingFinished: true,
            tools: []
          }));
          setMessages(mapped)
        }
      })
      .catch(err => console.error('Failed to load chat history:', err))
  }, [sessionId])

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
        throw new Error(`请求出错: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('浏览器不支持 Stream 流式读取。');
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
                  content: m.content + `\n\n⚠️ **系统执行出错**: ${event.message}`
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
        content: `Error: ${err.message}` 
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
      setMessages([{ id: Date.now(), role: 'system', content: 'Session restarted.' }])
    } catch(err) {
      console.error(err)
    }
  }

  return (
    <div className="session-view fade-in">
      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">Active Session</h1>
          <p className="view-subtitle">Monitor and interact with the agent in real-time (Session: {sessionId})</p>
        </div>
        <button className="btn btn-outline" onClick={handleNewSession}>
          <Plus size={16} /> New Session
        </button>
      </header>

      <div className="chat-container glass-panel">
        <div className="messages-list">
          {messages.map(msg => (
            <MessageItem key={msg.id} msg={msg} />
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
            placeholder="Type a command or message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
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
