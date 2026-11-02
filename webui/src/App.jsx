import { useState } from 'react'
import Sidebar from './components/Sidebar'
import SessionView from './components/SessionView'
import ConfigView from './components/ConfigView'
import CronView from './components/CronView'
import HeartbeatView from './components/HeartbeatView'
import MCPView from './components/MCPView'
import ChannelsView from './components/ChannelsView'
import { LanguageProvider } from './components/LanguageContext'
import ErrorBoundary from './components/ErrorBoundary'

function App() {
  const [currentView, setCurrentView] = useState('sessions')

  const renderView = () => {
    switch (currentView) {
      case 'sessions':  return <SessionView />
      case 'config':    return <ConfigView />
      case 'cron':      return <CronView />
      case 'heartbeat': return <HeartbeatView />
      case 'mcp':       return <MCPView />
      case 'channels':  return <ChannelsView />
      default:          return <SessionView />
    }
  }

  return (
    <ErrorBoundary>
      <LanguageProvider>
        <div className="app-container">
          <Sidebar currentView={currentView} setCurrentView={setCurrentView} />
          <main className="main-content">
            {/* 单视图崩溃时只替换内容区，侧边栏仍可用来切换/自救；key 变化时自动复位错误态 */}
            <ErrorBoundary key={currentView}>{renderView()}</ErrorBoundary>
          </main>
        </div>
      </LanguageProvider>
    </ErrorBoundary>
  )
}

export default App

