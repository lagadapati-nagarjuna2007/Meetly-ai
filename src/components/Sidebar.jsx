import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  Home,
  Calendar,
  Clock,
  Sparkles,
  User,
  Settings,
  Moon,
  ChevronRight
} from 'lucide-react'
import { useState, useEffect } from 'react'

export default function Sidebar() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('darkMode')
    return saved !== 'false'
  })

  useEffect(() => {
    localStorage.setItem('darkMode', darkMode)
    if (darkMode) {
      document.documentElement.classList.add('dark')
      document.documentElement.classList.remove('light')
    } else {
      document.documentElement.classList.add('light')
      document.documentElement.classList.remove('dark')
    }
  }, [darkMode])

  const navItems = [
    { name: 'Home', path: '/', icon: Home },
    { name: 'Meetings', path: '/meetings', icon: Calendar },
    { name: 'History', path: '/history', icon: Clock },
    { name: 'AI Assistant', path: '/ai-assistant', icon: Sparkles },
    { name: 'Profile', path: '/profile', icon: User },
    { name: 'Settings', path: '/settings', icon: Settings },
  ]

  return (
    <aside className="w-[260px] h-full bg-[#07080f] border-r border-white/5 flex flex-col justify-between select-none shrink-0">
      {/* Upper Section */}
      <div className="flex flex-col">
        {/* Brand Logo and Title */}
        <div className="p-5 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-[#7c3aed] to-[#2563eb] flex items-center justify-center shadow-lg">
            <svg className="w-4 h-4 text-white fill-current" viewBox="0 0 24 24">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
            </svg>
          </div>
          <span className="font-bold text-base text-white tracking-wide">
            Meetly <span className="text-[#8b5cf6]">AI</span>
          </span>
        </div>

        {/* Navigation items */}
        <nav className="px-3.5 py-4 flex flex-col gap-1.5">
          {navItems.map((item) => (
            <NavLink
              key={item.name}
              to={item.path}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs font-semibold transition-all duration-250 cursor-pointer ${
                  isActive
                    ? 'bg-gradient-to-r from-[#7c3aed] to-[#4f46e5] text-white shadow-md shadow-purple-950/20 font-bold'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`
              }
            >
              <item.icon size={15} className="shrink-0" />
              <span>{item.name}</span>
            </NavLink>
          ))}
        </nav>
      </div>

      {/* Lower Section */}
      <div className="px-3.5 pb-5 flex flex-col gap-4 border-t border-white/5 pt-4">
        {/* Dark Mode Toggle */}
        <div className="flex items-center justify-between px-3 py-2 bg-white/2 rounded-xl border border-white/5">
          <div className="flex items-center gap-2 text-gray-300">
            <Moon size={14} className="text-gray-400" />
            <span className="text-[11px] font-semibold">Dark Mode</span>
          </div>
          <button
            onClick={() => setDarkMode(!darkMode)}
            className={`w-9 h-5 rounded-full p-0.5 transition-all duration-200 relative cursor-pointer ${
              darkMode ? 'bg-[#7c3aed]' : 'bg-gray-600'
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white transition-transform duration-200 shadow-md ${
                darkMode ? 'translate-x-3.5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* User Card */}
        {user && (
          <div
            onClick={() => navigate('/profile')}
            className="flex items-center justify-between p-2 bg-white/2 hover:bg-white/5 rounded-xl border border-white/5 transition-all duration-200 cursor-pointer"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <img
                src={user.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80'}
                alt={user.name}
                className="w-8.5 h-8.5 rounded-full border border-white/10 object-cover shrink-0"
              />
              <div className="flex flex-col text-left min-w-0">
                <span className="text-[11px] font-bold text-white tracking-wide truncate max-w-[120px]">
                  {user.name}
                </span>
                <span className="text-[9px] text-gray-500 font-semibold uppercase mt-0.5">
                  {user.role}
                </span>
              </div>
            </div>
            <ChevronRight size={13} className="text-gray-500 shrink-0" />
          </div>
        )}
      </div>
    </aside>
  )
}
