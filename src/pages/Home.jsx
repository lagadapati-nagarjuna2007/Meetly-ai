import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useMeetings } from '../context/MeetingContext'
import { useToast } from '../components/Toast'
import MeetingCard from '../components/MeetingCard'
import Modal from '../components/Modal'
import Input from '../components/Input'
import Button from '../components/Button'
import {
  Video,
  UserPlus,
  Calendar,
  Sparkles,
  ArrowRight,
  Plus,
  Copy,
  CheckCircle,
  ToggleLeft,
  ToggleRight
} from 'lucide-react'

export default function Home() {
  const { user } = useAuth()
  const { meetings, createMeeting, joinMeeting } = useMeetings()
  const { showToast } = useToast()
  const navigate = useNavigate()

  // Modal States
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isJoinOpen, setIsJoinOpen] = useState(false)
  
  // Create Meeting Fields
  const [meetingName, setMeetingName] = useState('')
  const [meetingDesc, setMeetingDesc] = useState('')
  const [reqAttendance, setReqAttendance] = useState(true)
  const [reqFocus, setReqFocus] = useState(true)
  const [reqSummary, setReqSummary] = useState(true)
  
  // Create Success State
  const [createdMtg, setCreatedMtg] = useState(null)

  // Join Meeting Fields
  const [joinId, setJoinId] = useState('')
  const [joinPassword, setJoinPassword] = useState('')

  // Handle Create Submit
  const handleCreateSubmit = (e) => {
    e.preventDefault()
    if (!meetingName.trim()) {
      showToast('Please enter a meeting name', 'error')
      return
    }

    const mtg = createMeeting(
      meetingName,
      meetingDesc,
      reqAttendance,
      reqFocus,
      reqSummary
    )
    setCreatedMtg(mtg)
    showToast('Meeting created successfully!', 'success')
  }

  // Handle Join Submit
  const handleJoinSubmit = (e) => {
    e.preventDefault()
    if (!joinId.trim()) {
      showToast('Please enter a meeting ID', 'error')
      return
    }

    const mtg = joinMeeting(joinId)
    showToast(`Joining meeting: ${mtg.name}`, 'success')
    setIsJoinOpen(false)
    navigate(`/meeting/${mtg.id}`)
  }

  const handleCopyLink = () => {
    const link = `https://meetly.ai/room/${createdMtg.id}`
    navigator.clipboard.writeText(link)
    showToast('Link copied to clipboard!', 'success')
  }

  const handleStartMeeting = () => {
    setIsCreateOpen(false)
    setCreatedMtg(null)
    setMeetingName('')
    setMeetingDesc('')
    navigate(`/meeting/${createdMtg.id}`)
  }

  return (
    <div className="flex flex-col gap-6 w-full relative">
      
      {/* Top Header Row with Window Controls */}
      <div className="flex items-center justify-between">
        <div className="text-left">
          <h1 className="text-xl font-bold text-white tracking-wide mb-1 leading-normal">
            Hi, {user?.name.split(' ')[0] || 'Nagarjuna'}! 👋
          </h1>
          <p className="text-[11px] text-gray-500 font-semibold">Ready to meet and collaborate?</p>
        </div>
        
        {/* Schedule meeting button */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => showToast('Scheduling feature coming in Phase 2!', 'info')}
            className="flex items-center gap-2 px-3.5 py-1.8 border border-[#8b5cf6]/30 hover:border-[#8b5cf6]/60 rounded-xl text-[10px] font-bold text-[#c084fc] bg-[#8b5cf6]/5 hover:bg-[#8b5cf6]/10 transition-all duration-200 cursor-pointer"
          >
            <Calendar size={13} />
            <span>Schedule Meeting</span>
          </button>
        </div>
      </div>

      {/* Two Large Action Boxes (Centered contents to match mockup) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* New Meeting Card */}
        <div
          onClick={() => {
            setCreatedMtg(null)
            setIsCreateOpen(true)
          }}
          className="bg-gradient-to-br from-[#4c1d95]/40 via-[#2e1065]/25 to-[#0c051a] hover:from-[#4c1d95]/50 hover:via-[#2e1065]/35 border border-purple-500/10 hover:border-purple-500/20 p-8 rounded-3xl flex flex-col items-center justify-between h-56 cursor-pointer transition-all duration-300 relative group overflow-hidden"
        >
          {/* Top Video Icon */}
          <div className="w-12 h-12 rounded-2xl bg-purple-500/10 border border-purple-500/15 flex items-center justify-center text-purple-400 shadow-md mt-1">
            <Video size={20} />
          </div>

          {/* Centered Texts */}
          <div className="flex flex-col items-center text-center gap-0.5 mb-8">
            <h2 className="text-sm font-bold text-white tracking-wide">New Meeting</h2>
            <p className="text-[10px] text-purple-200/50 font-semibold">Start an instant meeting</p>
          </div>

          {/* Centered Bottom Arrow Button */}
          <div className="absolute bottom-5 w-8 h-8 rounded-full bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 flex items-center justify-center text-white transition-all duration-200">
            <ArrowRight size={14} />
          </div>
        </div>

        {/* Join Meeting Card */}
        <div
          onClick={() => setIsJoinOpen(true)}
          className="bg-gradient-to-br from-[#1e3a8a]/40 via-[#172554]/25 to-[#080718] hover:from-[#1e3a8a]/50 hover:via-[#172554]/35 border border-blue-500/10 hover:border-blue-500/20 p-8 rounded-3xl flex flex-col items-center justify-between h-56 cursor-pointer transition-all duration-300 relative group overflow-hidden"
        >
          {/* Top User Add Icon */}
          <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/15 flex items-center justify-center text-blue-400 shadow-md mt-1">
            <UserPlus size={20} />
          </div>

          {/* Centered Texts */}
          <div className="flex flex-col items-center text-center gap-0.5 mb-8">
            <h2 className="text-sm font-bold text-white tracking-wide">Join Meeting</h2>
            <p className="text-[10px] text-blue-200/50 font-semibold">Enter meeting code to join</p>
          </div>

          {/* Centered Bottom Arrow Button */}
          <div className="absolute bottom-5 w-8 h-8 rounded-full bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 flex items-center justify-center text-white transition-all duration-200">
            <ArrowRight size={14} />
          </div>
        </div>
      </div>

      {/* Recent Meetings Header & List */}
      <div className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between px-0.5">
          <h2 className="text-xs font-bold text-white tracking-wide">Recent Meetings</h2>
          <button
            onClick={() => navigate('/history')}
            className="text-[10px] font-bold text-[#8b5cf6] hover:text-[#a78bfa] flex items-center gap-1 transition-colors cursor-pointer"
          >
            <span>View all</span>
            <ArrowRight size={12} />
          </button>
        </div>

        {/* Meeting Cards Stack */}
        <div className="flex flex-col gap-2.5">
          {meetings.slice(0, 4).map((mtg, index) => (
            <MeetingCard key={mtg.id} meeting={mtg} index={index} />
          ))}
        </div>
      </div>

      {/* Floating Add Action Button (Overlaps page at bottom-right) */}
      <button
        onClick={() => {
          setCreatedMtg(null)
          setIsCreateOpen(true)
        }}
        className="fixed bottom-22 right-8 w-11 h-11 bg-[#7c3aed] hover:bg-[#8b5cf6] text-white rounded-full flex items-center justify-center shadow-lg shadow-purple-900/40 transition-all duration-200 cursor-pointer hover:rotate-90 z-20"
      >
        <Plus size={18} />
      </button>

      {/* AI Assistant Banner */}
      <div className="mt-2 p-4 rounded-2xl border border-white/5 bg-[#0a0c16]/50 flex flex-col sm:flex-row items-center justify-between gap-4 select-none">
        <div className="flex items-center gap-3.5 text-left">
          {/* Bot circle icon */}
          <div className="w-9 h-9 rounded-full bg-[#7c3aed]/10 border border-[#7c3aed]/20 flex items-center justify-center text-[#8b5cf6] shrink-0">
            {/* Robot SVG icon */}
            <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
              <path d="M19 8h-1.18c-.46-2.28-2.48-4-4.82-4s-4.36 1.72-4.82 4H7c-1.1 0-2 .9-2 2v3c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3c0-1.1-.9-2-2-2zM7.5 13c-.83 0-1.5-.67-1.5-1.5S6.67 10 7.5 10s1.5.67 1.5 1.5S8.33 13 7.5 13zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
            </svg>
          </div>
          <div className="flex flex-col">
            <h3 className="text-xs font-bold text-white leading-normal">Need help with your meetings?</h3>
            <p className="text-[10px] text-gray-500 font-semibold">Ask AI Assistant for summaries, insights and more.</p>
          </div>
        </div>
        <button
          onClick={() => navigate('/ai-assistant')}
          className="flex items-center gap-1.5 px-3 py-1.8 border border-[#8b5cf6]/20 hover:border-[#8b5cf6]/40 rounded-xl text-[10px] font-bold text-[#c084fc] bg-[#8b5cf6]/5 hover:bg-[#8b5cf6]/10 transition-all duration-200 cursor-pointer"
        >
          <Sparkles size={11} className="opacity-80" />
          <span>Ask AI</span>
        </button>
      </div>

      {/* CREATE MODAL */}
      <Modal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} title="Create New Meeting">
        {!createdMtg ? (
          <form onSubmit={handleCreateSubmit} className="flex flex-col gap-4">
            <Input
              label="Meeting Name"
              type="text"
              placeholder="e.g. AI Architecture Sync"
              value={meetingName}
              onChange={(e) => setMeetingName(e.target.value)}
            />
            
            <div className="flex flex-col gap-1 text-left">
              <label className="text-xs font-semibold text-gray-300 pl-0.5">Description</label>
              <textarea
                rows={3}
                placeholder="Optional meeting details and topics"
                value={meetingDesc}
                onChange={(e) => setMeetingDesc(e.target.value)}
                className="w-full bg-[#0a0b12]/50 border border-white/5 rounded-xl px-4 py-3 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-[#7c3aed] transition-all duration-200"
              />
            </div>

            <div className="flex flex-col gap-2.5 bg-white/2 rounded-xl p-3 border border-white/5">
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest pl-0.5">Features</span>
              
              <div className="flex items-center justify-between text-xs font-semibold px-1">
                <span className="text-gray-300">Attendance Requirement</span>
                <button
                  type="button"
                  onClick={() => setReqAttendance(!reqAttendance)}
                  className="text-[#8b5cf6] cursor-pointer"
                >
                  {reqAttendance ? <ToggleRight size={26} /> : <ToggleLeft size={26} className="text-gray-600" />}
                </button>
              </div>

              <div className="flex items-center justify-between text-xs font-semibold px-1">
                <span className="text-gray-300">Enable Focus Analysis</span>
                <button
                  type="button"
                  onClick={() => setReqFocus(!reqFocus)}
                  className="text-[#8b5cf6] cursor-pointer"
                >
                  {reqFocus ? <ToggleRight size={26} /> : <ToggleLeft size={26} className="text-gray-600" />}
                </button>
              </div>

              <div className="flex items-center justify-between text-xs font-semibold px-1">
                <span className="text-gray-300">Enable AI Summary</span>
                <button
                  type="button"
                  onClick={() => setReqSummary(!reqSummary)}
                  className="text-[#8b5cf6] cursor-pointer"
                >
                  {reqSummary ? <ToggleRight size={26} /> : <ToggleLeft size={26} className="text-gray-600" />}
                </button>
              </div>
            </div>

            <Button type="submit" className="w-full py-3 mt-2 text-xs font-bold">
              Generate Meeting Code
            </Button>
          </form>
        ) : (
          <div className="flex flex-col gap-4.5 text-center py-1">
            <div className="flex flex-col items-center gap-1.5">
              <div className="w-9 h-9 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mb-1 border border-emerald-500/10">
                <CheckCircle size={18} />
              </div>
              <h3 className="text-sm font-bold text-white">Meeting Code Generated!</h3>
              <p className="text-[10px] text-gray-500 font-semibold">Share this code or link with other participants.</p>
            </div>

            <div className="flex flex-col gap-3 bg-white/2 rounded-xl p-3.5 border border-white/5">
              <div className="flex flex-col gap-1 text-left">
                <span className="text-[9px] font-bold text-gray-500 uppercase">Meeting ID</span>
                <span className="text-xs font-bold text-white tracking-wide">{createdMtg.id}</span>
              </div>
              
              <div className="h-px bg-white/5" />

              <div className="flex flex-col gap-1 text-left">
                <span className="text-[9px] font-bold text-gray-500 uppercase">Room Link</span>
                <span className="text-[11px] font-medium text-gray-300 truncate">https://meetly.ai/room/{createdMtg.id}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-1">
              <button
                type="button"
                onClick={handleCopyLink}
                className="flex items-center justify-center gap-2 py-2.5 px-4 bg-white/2 hover:bg-white/5 border border-white/5 rounded-xl text-[11px] font-bold text-gray-300 transition-all duration-200 cursor-pointer"
              >
                <Copy size={13} />
                <span>Copy Link</span>
              </button>

              <Button onClick={handleStartMeeting} className="text-xs font-bold">
                Start Meeting
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* JOIN MODAL */}
      <Modal isOpen={isJoinOpen} onClose={() => setIsJoinOpen(false)} title="Join Existing Meeting">
        <form onSubmit={handleJoinSubmit} className="flex flex-col gap-4">
          <Input
            label="Meeting ID / Code"
            type="text"
            placeholder="e.g. mtg-xyz-123"
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
          />

          <Input
            label="Password (Optional)"
            type="password"
            placeholder="Enter password if required"
            value={joinPassword}
            onChange={(e) => setJoinPassword(e.target.value)}
          />

          <Button type="submit" variant="secondary" className="w-full py-3 mt-2 text-xs font-bold">
            Join Meeting
          </Button>
        </form>
      </Modal>
    </div>
  )
}
