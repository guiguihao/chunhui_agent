import { Component } from 'react'

// 第二道防线：任何渲染期异常（如翻译字典缺失、脏数据访问 undefined）都不应该
// 把整个页面变成白屏——连语言切换按钮都没了就没法自救。
// 这里刻意不使用 useLanguage/t()，因为 LanguageProvider 本身可能就在抛错链路里。
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack)
  }

  handleReset = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="panel-view fade-in" role="alert">
        <div className="panel-empty" style={{ textAlign: 'left', lineHeight: 1.8 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            页面渲染出错了 / Something went wrong
          </div>
          <div style={{ opacity: 0.7, marginBottom: 12, wordBreak: 'break-all' }}>
            {String(error?.message || error)}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" onClick={this.handleReset}>重试 / Retry</button>
            <button className="btn btn-outline" onClick={() => window.location.reload()}>重新加载 / Reload</button>
          </div>
        </div>
      </div>
    )
  }
}
