import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/Toast'
import Input from '../components/Input'
import Button from '../components/Button'
import { User, Mail, Video, Clock, Award, Shield } from 'lucide-react'

export default function Profile() {
  const { user, updateProfile, logout } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()

  const [name, setName] = useState(user?.name || '')
  const [email, setEmail] = useState(user?.email || '')
  const [isEditing, setIsEditing] = useState(false)

  const handleLogout = () => {
    logout()
    showToast('Signed out successfully!', 'info')
    navigate('/login')
  }

  const handleUpdate = (e) => {
    e.preventDefault()
    if (!name.trim() || !email.trim()) {
      showToast('Name and Email cannot be empty', 'error')
      return
    }
    updateProfile(name, email)
    showToast('Profile updated successfully!', 'success')
    setIsEditing(false)
  }

  const stats = [
    { label: 'Hosted Meetings', value: '12', icon: Video, color: 'text-purple-400 bg-purple-500/10' },
    { label: 'Joined Meetings', value: '28', icon: User, color: 'text-blue-400 bg-blue-500/10' },
    { label: 'Total Minutes', value: '1,420 min', icon: Clock, color: 'text-emerald-400 bg-emerald-500/10' },
  ]

  return (
    <div className="flex flex-col gap-6 w-full text-left">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-wide mb-1">User Profile</h1>
        <p className="text-xs text-gray-400">Manage account information, check platform achievements, and view usage metrics.</p>
      </div>

      {/* Profile Info Card & Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Side: Avatar & Details */}
        <div className="lg:col-span-1 bg-white/2 rounded-2xl p-6 border border-white/5 flex flex-col items-center justify-between text-center gap-6">
          <div className="flex flex-col items-center gap-4.5">
            {/* Avatar */}
            <div className="relative group">
              <img
                src={user?.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'}
                alt={user?.name}
                className="w-24 h-24 rounded-full border-2 border-brand-purple object-cover shadow-lg"
              />
              <div className="absolute inset-0 bg-black/60 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 cursor-pointer">
                <span className="text-[10px] font-bold text-white">Upload</span>
              </div>
            </div>

            {/* Info */}
            <div className="flex flex-col gap-0.5">
              <h2 className="text-base font-bold text-white tracking-wide">{user?.name}</h2>
              <span className="text-xs text-gray-400 font-semibold">{user?.email}</span>
              
              {/* Role badge */}
              <div className="flex items-center gap-1.5 px-3 py-1 bg-brand-purple/10 border border-brand-purple/20 rounded-full mt-2.5 text-[10px] font-bold text-brand-purple-hover self-center">
                <Award size={12} />
                <span>{user?.role || 'Student'}</span>
              </div>
            </div>
          </div>

          <div className="w-full h-px bg-white/5" />

          {/* Settings tag */}
          <div className="flex items-center gap-2.5 text-xs font-semibold text-gray-500">
            <Shield size={14} />
            <span>Enterprise Verified Account</span>
          </div>
        </div>

        {/* Right Side: Update Profile Details */}
        <div className="lg:col-span-2 bg-white/2 rounded-2xl p-6 border border-white/5 flex flex-col justify-between gap-6">
          <div className="flex flex-col gap-4 text-left">
            <h2 className="text-sm font-bold text-white tracking-wide border-b border-white/5 pb-2">Account Settings</h2>
            
            {isEditing ? (
              <form onSubmit={handleUpdate} className="flex flex-col gap-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Input
                    label="Full Name"
                    type="text"
                    icon={User}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <Input
                    label="Email Address"
                    type="email"
                    icon={Mail}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="flex gap-3 justify-end mt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setName(user?.name || '')
                      setEmail(user?.email || '')
                      setIsEditing(false)
                    }}
                    className="px-4 py-2 hover:bg-white/5 rounded-xl text-xs font-semibold text-gray-400 hover:text-white transition-all duration-200 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <Button type="submit" className="px-5 text-xs py-2">
                    Save Changes
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4.5">
                  <div className="flex flex-col gap-1 p-3.5 bg-white/2 border border-white/3 rounded-xl text-left">
                    <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Full Name</span>
                    <span className="text-xs font-semibold text-white tracking-wide">{user?.name}</span>
                  </div>
                  <div className="flex flex-col gap-1 p-3.5 bg-white/2 border border-white/3 rounded-xl text-left">
                    <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Email Address</span>
                    <span className="text-xs font-semibold text-white tracking-wide">{user?.email}</span>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setIsEditing(true)}
                    className="px-4 py-2.5 bg-white/3 hover:bg-white/5 rounded-xl border border-white/10 text-xs font-semibold text-gray-200 hover:text-white transition-all duration-200 cursor-pointer self-start"
                  >
                    Edit Profile
                  </button>
                  <button
                    onClick={handleLogout}
                    className="px-4 py-2.5 bg-red-600/10 hover:bg-red-600/20 border border-red-500/25 rounded-xl text-xs font-semibold text-red-400 hover:text-red-300 transition-all duration-200 cursor-pointer self-start"
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Stats Boxes */}
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider pl-1">Platform Stats</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {stats.map((stat, idx) => (
                <div key={idx} className="flex items-center gap-4 bg-white/2 border border-white/3 p-4 rounded-xl">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${stat.color}`}>
                    <stat.icon size={20} />
                  </div>
                  <div className="flex flex-col text-left">
                    <span className="text-xs font-semibold text-gray-400">{stat.label}</span>
                    <span className="text-base font-bold text-white tracking-wide">{stat.value}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
