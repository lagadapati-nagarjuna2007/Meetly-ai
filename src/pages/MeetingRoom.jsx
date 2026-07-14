import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useMeetings } from '../context/MeetingContext'
import { useToast } from '../components/Toast'
import Button from '../components/Button'
import {
  Mic,
  MicOff,
  Video as Cam,
  VideoOff,
  Monitor,
  MessageSquare,
  Users,
  Sparkles,
  PhoneOff,
  Circle,
  Radio,
  Send,
  Bot
} from 'lucide-react'

export default function MeetingRoom() {
  const { id } = useParams()
  const { currentMeeting, leaveMeeting } = useMeetings()
  const { showToast } = useToast()
  const navigate = useNavigate()

  // Hardware Status
  const [micActive, setMicActive] = useState(true)
  const [camActive, setCamActive] = useState(true)
  const [sharingActive, setSharingActive] = useState(false)
  const [recordingActive, setRecordingActive] = useState(true)

  // Drawer Panel Toggles
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [activeTab, setActiveTab] = useState('chat') // chat | participants | ai

  // Local Chat / AI States
  const [chatMessages, setChatMessages] = useState([
    { name: 'Dr. Ravi Kumar', text: 'Welcome everyone. Make sure your video is enabled for the focus check.' },
    { name: 'Prof. Meena', text: 'Ready to review the architecture specs.' }
  ])
  const [chatInput, setChatInput] = useState('')
  const [aiInput, setAiInput] = useState('')
  const [aiResponses, setAiResponses] = useState([
    { sender: 'bot', text: 'I am tracking the meeting. You can ask me to summarize the current discussion.' }
  ])

  // Call timer simulation
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds(prev => prev + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  const formatTimer = (sec) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0')
    const s = (sec % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  // Handle Toolbar actions
  const handleToggleMic = () => {
    setMicActive(!micActive)
    showToast(micActive ? 'Microphone muted' : 'Microphone unmuted', 'info')
  }

  const handleToggleCam = () => {
    setCamActive(!camActive)
    showToast(camActive ? 'Camera disabled' : 'Camera enabled', 'info')
  }

  const handleToggleShare = () => {
    setSharingActive(!sharingActive)
    showToast(sharingActive ? 'Screen sharing stopped' : 'Screen sharing started', 'info')
  }

  const handleToggleRecord = () => {
    setRecordingActive(!recordingActive)
    showToast(recordingActive ? 'Recording paused' : 'Recording started', 'success')
  }

  const handleLeave = () => {
    leaveMeeting()
    showToast('You left the meeting room.', 'info')
    navigate('/')
  }

  const handleSendChat = (e) => {
    e.preventDefault()
    if (!chatInput.trim()) return
    setChatMessages([...chatMessages, { name: 'Nagarjuna Sai', text: chatInput }])
    setChatInput('')
  }

  const handleAskAI = (e) => {
    e.preventDefault()
    if (!aiInput.trim()) return
    const query = aiInput
    setAiResponses(prev => [...prev, { sender: 'user', text: query }])
    setAiInput('')

    setTimeout(() => {
      let botAnswer = 'Generating summary... This is a simulated Groq Whisper summary of the active meeting speech stream.'
      if (query.toLowerCase().includes('summary') || query.toLowerCase().includes('summarize')) {
        botAnswer = 'So far, the participants have discussed specs for Phase 1. Dr. Ravi is leading the discussion on system scalability.'
      }
      setAiResponses(prev => [...prev, { sender: 'bot', text: botAnswer }])
    }, 600)
  }

  // Mock participants data
  const participants = [
    { name: 'Nagarjuna Sai (You)', focus: '94%', eng: 'High', active: true, avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=120&h=120&q=80' },
    { name: 'Dr. Ravi Kumar', focus: '88%', eng: 'Medium', active: false, avatar: 'https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=120&h=120&q=80' },
    { name: 'Prof. Meena', focus: '91%', eng: 'High', active: false, avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=120&h=120&q=80' },
    { name: 'Student B', focus: '42% (Distracted)', eng: 'Low', active: false, avatar: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=120&h=120&q=80' }
  ]

  return (
    <div className="fixed inset-0 z-40 bg-[#04050b] flex flex-col items-stretch overflow-hidden text-left">
      {/* Top Header Panel */}
      <header className="h-14 border-b border-white/5 bg-[#080913] px-6 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm text-white tracking-wide">
            {currentMeeting?.name || 'Live Meeting Room'}
          </span>
          <div className="w-1.5 h-1.5 rounded-full bg-white/10" />
          <span className="text-xs font-semibold text-gray-500">
            ID: <span className="text-gray-300 font-mono select-all">{id}</span>
          </span>
        </div>

        {/* Live Status Indicators */}
        <div className="flex items-center gap-4 text-xs font-bold">
          {recordingActive && (
            <span className="flex items-center gap-1.5 text-red-500">
              <Circle size={10} className="fill-red-500 animate-pulse" />
              <span>REC</span>
            </span>
          )}
          <span className="flex items-center gap-1.5 text-emerald-400">
            <Radio size={14} className="animate-pulse" />
            <span>LIVE</span>
          </span>
          <span className="text-gray-400 font-mono">{formatTimer(seconds)}</span>
        </div>
      </header>

      {/* Main Grid + Drawer Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Video Grid Section */}
        <div className="flex-1 p-6 overflow-y-auto flex items-center justify-center bg-[#05060b]">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-5xl h-full max-h-[560px]">
            {participants.map((p, idx) => (
              <div key={idx} className="bg-slate-900/60 rounded-2xl border border-white/5 relative overflow-hidden flex flex-col justify-end items-center group shadow-xl">
                {/* Simulated Webcam Video Feed */}
                {idx === 0 && camActive ? (
                  <div className="absolute inset-0 bg-[#090b14] flex flex-col items-center justify-center">
                    {/* Simulated pulse wave indicating active webcam frame */}
                    <div className="w-20 h-20 rounded-full border border-brand-purple/20 flex items-center justify-center pulse-glow">
                      <img src={p.avatar} alt="" className="w-16 h-16 rounded-full object-cover" />
                    </div>
                  </div>
                ) : (
                  <div className="absolute inset-0 bg-slate-950 flex flex-col items-center justify-center">
                    <img src={p.avatar} alt={p.name} className="w-16 h-16 rounded-full border border-white/5 shadow-lg object-cover" />
                  </div>
                )}

                {/* Focus Overlay Badge (MediaPipe WASM indicators) */}
                <div className="absolute top-3 left-3 flex flex-col gap-1 z-10 text-[9px] font-bold uppercase tracking-wider">
                  <span className="px-2 py-1 rounded bg-black/70 border border-white/10 text-emerald-400">
                    Focus: {p.focus}
                  </span>
                  <span className="px-2 py-1 rounded bg-black/70 border border-white/10 text-gray-300">
                    Engagement: {p.eng}
                  </span>
                </div>

                {/* Name Tag (Bottom bar) */}
                <div className="absolute bottom-3 left-3 px-3 py-1.5 rounded-xl bg-black/60 border border-white/5 text-[10px] font-bold text-white z-10">
                  {p.name}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right Side Drawer Panel */}
        {rightPanelOpen && (
          <div className="w-80 h-full border-l border-white/5 bg-[#080913] flex flex-col justify-between shrink-0">
            {/* Drawer Tabs Header */}
            <div className="flex border-b border-white/5 select-none">
              <button
                onClick={() => setActiveTab('chat')}
                className={`flex-1 py-3 text-xs font-semibold border-b-2 transition-all duration-200 cursor-pointer ${
                  activeTab === 'chat'
                    ? 'border-brand-purple text-white'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                Chat
              </button>
              <button
                onClick={() => setActiveTab('participants')}
                className={`flex-1 py-3 text-xs font-semibold border-b-2 transition-all duration-200 cursor-pointer ${
                  activeTab === 'participants'
                    ? 'border-brand-purple text-white'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                Participants
              </button>
              <button
                onClick={() => setActiveTab('ai')}
                className={`flex-1 py-3 text-xs font-semibold border-b-2 transition-all duration-200 cursor-pointer ${
                  activeTab === 'ai'
                    ? 'border-brand-purple text-white'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                AI Assistant
              </button>
            </div>

            {/* Drawer Contents */}
            <div className="flex-1 overflow-y-auto p-4">
              {/* TAB: CHAT */}
              {activeTab === 'chat' && (
                <div className="flex flex-col gap-3 h-full">
                  <div className="flex-1 overflow-y-auto flex flex-col gap-3">
                    {chatMessages.map((msg, idx) => (
                      <div key={idx} className="flex flex-col gap-0.5 text-xs">
                        <span className="font-bold text-gray-400">{msg.name}</span>
                        <p className="bg-white/3 rounded-xl p-2.5 text-gray-200 border border-white/5">{msg.text}</p>
                      </div>
                    ))}
                  </div>

                  <form onSubmit={handleSendChat} className="flex items-center gap-2 border-t border-white/5 pt-3">
                    <input
                      type="text"
                      placeholder="Type a message..."
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      className="flex-1 bg-slate-900/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand-purple transition-all duration-200"
                    />
                    <Button type="submit" className="px-3 py-2 shrink-0">
                      <Send size={12} />
                    </Button>
                  </form>
                </div>
              )}

              {/* TAB: PARTICIPANTS */}
              {activeTab === 'participants' && (
                <div className="flex flex-col gap-3">
                  {participants.map((p, idx) => (
                    <div key={idx} className="flex items-center gap-3 p-2 bg-white/2 border border-white/5 rounded-xl">
                      <img src={p.avatar} alt="" className="w-8 h-8 rounded-full object-cover" />
                      <div className="flex flex-col text-left flex-1">
                        <span className="text-xs font-semibold text-white">{p.name}</span>
                        <span className="text-[10px] text-emerald-400 font-semibold uppercase">Focus: {p.focus}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* TAB: AI ASSISTANT */}
              {activeTab === 'ai' && (
                <div className="flex flex-col gap-3 h-full">
                  <div className="flex-1 overflow-y-auto flex flex-col gap-3">
                    {aiResponses.map((msg, idx) => (
                      <div key={idx} className={`flex gap-2 max-w-[90%] ${msg.sender === 'user' ? 'self-end flex-row-reverse' : 'self-start'}`}>
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 border ${msg.sender === 'user' ? 'bg-brand-blue/10 border-brand-blue/20 text-brand-blue' : 'bg-brand-purple/10 border-brand-purple/20 text-brand-purple'}`}>
                          {msg.sender === 'user' ? <Users size={12} /> : <Bot size={12} />}
                        </div>
                        <p className={`p-2.5 rounded-xl text-xs leading-normal ${msg.sender === 'user' ? 'bg-brand-blue text-white' : 'bg-white/3 text-gray-200 border border-white/5'}`}>{msg.text}</p>
                      </div>
                    ))}
                  </div>

                  <form onSubmit={handleAskAI} className="flex items-center gap-2 border-t border-white/5 pt-3">
                    <input
                      type="text"
                      placeholder="Ask meeting bot..."
                      value={aiInput}
                      onChange={(e) => setAiInput(e.target.value)}
                      className="flex-1 bg-slate-900/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand-purple transition-all duration-200"
                    />
                    <Button type="submit" className="px-3 py-2 shrink-0">
                      <Sparkles size={12} />
                    </Button>
                  </form>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Controls Toolbar */}
      <footer className="h-16 border-t border-white/5 bg-[#080913] px-6 flex items-center justify-between shrink-0 select-none">
        {/* Toggle Right Drawer panel */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setRightPanelOpen(!rightPanelOpen)
            }}
            className={`p-2.5 rounded-xl border border-white/5 text-gray-400 hover:text-white transition-all duration-200 cursor-pointer ${rightPanelOpen ? 'bg-white/5 text-white' : 'hover:bg-white/5'}`}
          >
            <MessageSquare size={16} />
          </button>
        </div>

        {/* Core Media Controls */}
        <div className="flex items-center gap-3">
          {/* Microphone */}
          <button
            onClick={handleToggleMic}
            className={`w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-200 cursor-pointer ${
              micActive ? 'bg-[#0f1122]/60 hover:bg-[#141629] border-white/10 text-white' : 'bg-red-600 hover:bg-red-500 border-transparent text-white'
            }`}
          >
            {micActive ? <Mic size={18} /> : <MicOff size={18} />}
          </button>

          {/* Camera */}
          <button
            onClick={handleToggleCam}
            className={`w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-200 cursor-pointer ${
              camActive ? 'bg-[#0f1122]/60 hover:bg-[#141629] border-white/10 text-white' : 'bg-red-600 hover:bg-red-500 border-transparent text-white'
            }`}
          >
            {camActive ? <Cam size={18} /> : <VideoOff size={18} />}
          </button>

          {/* Screen Share */}
          <button
            onClick={handleToggleShare}
            className={`w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-200 cursor-pointer ${
              sharingActive ? 'bg-brand-blue hover:bg-brand-blue-hover border-transparent text-white shadow-lg shadow-brand-blue/20' : 'bg-[#0f1122]/60 hover:bg-[#141629] border-white/10 text-white'
            }`}
          >
            <Monitor size={18} />
          </button>

          {/* Recording */}
          <button
            onClick={handleToggleRecord}
            className={`w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-200 cursor-pointer ${
              recordingActive ? 'bg-red-600/10 hover:bg-red-600/20 border-red-500/25 text-red-500' : 'bg-[#0f1122]/60 hover:bg-[#141629] border-white/10 text-white'
            }`}
          >
            <Circle size={18} className={recordingActive ? 'fill-red-500' : ''} />
          </button>
        </div>

        {/* End Call / Leave room */}
        <Button variant="danger" onClick={handleLeave} className="px-5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-red-600/25">
          <PhoneOff size={14} />
          <span>Leave Room</span>
        </Button>
      </footer>
    </div>
  )
}
