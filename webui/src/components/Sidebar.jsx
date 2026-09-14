import { MessageSquare, Settings, Clock, Heart, Boxes, Activity } from 'lucide-react'
import './Sidebar.css'

const NAV_ITEMS = [
  { id: 'sessions', label: 'Sessions', icon: MessageSquare },
  { id: 'config', label: 'Configuration', icon: Settings },
  { id: 'cron', label: 'Cron Tasks', icon: Clock },
  { id: 'heartbeat', label: 'Heartbeat', icon: Heart },
  { id: 'mcp', label: 'MCP Servers', icon: Boxes },
]

export default function Sidebar({ currentView, setCurrentView }) {
  return (
    <aside className="sidebar">
      <div className="logo-container">
        <div className="logo-icon">
          <Activity size={18} />
        </div>
        <div className="logo-text">Admin</div>
      </div>

      <nav className="nav-menu">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <div
            key={id}
            className={`nav-item ${currentView === id ? 'active' : ''}`}
            onClick={() => setCurrentView(id)}
          >
            <Icon className="nav-icon" />
            <span>{label}</span>
          </div>
        ))}
      </nav>
    </aside>
  )
}
