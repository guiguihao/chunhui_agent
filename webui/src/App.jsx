import { useState } from 'react'
import Sidebar from './components/Sidebar'
import SessionView from './components/SessionView'
import ConfigView from './components/ConfigView'
import CronView from './components/CronView'
import HeartbeatView from './components/HeartbeatView'
import MCPView from './components/MCPView'

function App() {
  const [currentView, setCurrentView] = useState('sessions')

  const renderView = () => {
    switch (currentView) {
      case 'sessions':  return <SessionView />
      case 'config':    return <ConfigView />
      case 'cron':      return <CronView />
      case 'heartbeat': return <HeartbeatView />
      case 'mcp':       return <MCPView />
      default:          return <SessionView />
    }
  }

  return (
    <div className="app-container">
      <Sidebar currentView={currentView} setCurrentView={setCurrentView} />
      <main className="main-content">
        {renderView()}
      </main>
    </div>
  )
}

export default App
