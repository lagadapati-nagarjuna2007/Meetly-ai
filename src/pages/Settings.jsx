import { useState } from 'react'
import { useToast } from '../components/Toast'
import { Camera, Bell, Save, ToggleLeft, ToggleRight } from 'lucide-react'
import Button from '../components/Button'

export default function Settings() {
  const { showToast } = useToast()

  // Devices State (Placeholders)
  const [selectedCamera, setSelectedCamera] = useState('FaceTime HD Camera (Built-in)')
  const [selectedMic, setSelectedMic] = useState('MacBook Pro Microphone (Built-in)')

  // Toggles State
  const [autoMute, setAutoMute] = useState(false)
  const [autoCamOff, setAutoCamOff] = useState(false)
  const [pushNotif, setPushNotif] = useState(true)
  const [emailNotif, setEmailNotif] = useState(false)
  const [shareBlur, setShareBlur] = useState(true)
  const [autoTranscript, setAutoTranscript] = useState(true)

  const handleSaveSettings = (e) => {
    e.preventDefault()
    showToast('Settings saved successfully!', 'success')
  }

  return (
    <div className="flex flex-col gap-6 w-full text-left">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-wide mb-1">Settings</h1>
        <p className="text-xs text-gray-400">Configure devices, system notifications, privacy settings, and automated summaries.</p>
      </div>

      <form onSubmit={handleSaveSettings} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Device Settings Card */}
        <div className="bg-white/2 rounded-2xl p-6 border border-white/5 flex flex-col gap-5">
          <h2 className="text-sm font-bold text-white tracking-wide border-b border-white/5 pb-2 flex items-center gap-2">
            <Camera size={16} className="text-brand-purple" />
            <span>Devices & Hardware</span>
          </h2>

          {/* Camera Selector */}
          <div className="flex flex-col gap-1.5 text-left">
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">Camera Device</label>
            <select
              value={selectedCamera}
              onChange={(e) => setSelectedCamera(e.target.value)}
              className="w-full bg-slate-900/40 border border-white/10 rounded-xl px-3.5 py-3 text-xs text-white focus:outline-none focus:border-brand-purple focus:ring-1 focus:ring-brand-purple cursor-pointer transition-all duration-200"
            >
              <option value="FaceTime HD Camera (Built-in)">FaceTime HD Camera (Built-in)</option>
              <option value="Logitech Brio 4K Webcam (USB)">Logitech Brio 4K Webcam (USB)</option>
              <option value="OBS Virtual Camera">OBS Virtual Camera</option>
            </select>
          </div>

          {/* Mic Selector */}
          <div className="flex flex-col gap-1.5 text-left">
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">Microphone Input</label>
            <select
              value={selectedMic}
              onChange={(e) => setSelectedMic(e.target.value)}
              className="w-full bg-slate-900/40 border border-white/10 rounded-xl px-3.5 py-3 text-xs text-white focus:outline-none focus:border-brand-purple focus:ring-1 focus:ring-brand-purple cursor-pointer transition-all duration-200"
            >
              <option value="MacBook Pro Microphone (Built-in)">MacBook Pro Microphone (Built-in)</option>
              <option value="Yeti Stereo Microphone (USB)">Yeti Stereo Microphone (USB)</option>
              <option value="Scarlett 2i2 USB Soundcard">Scarlett 2i2 USB Soundcard</option>
            </select>
          </div>

          <div className="h-px bg-white/5 my-1" />

          {/* Quick Joining Preferences */}
          <div className="flex flex-col gap-3">
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">Meeting Start Settings</span>
            
            {/* Always Mute Mic */}
            <div className="flex items-center justify-between text-xs font-semibold px-1">
              <div className="flex flex-col text-left">
                <span className="text-gray-300">Always mute microphone on join</span>
                <span className="text-[10px] text-gray-500 font-medium">Join meetings muted by default</span>
              </div>
              <button
                type="button"
                onClick={() => setAutoMute(!autoMute)}
                className="text-brand-purple cursor-pointer shrink-0"
              >
                {autoMute ? <ToggleRight size={28} /> : <ToggleLeft size={28} className="text-gray-600" />}
              </button>
            </div>

            {/* Always Cam Off */}
            <div className="flex items-center justify-between text-xs font-semibold px-1">
              <div className="flex flex-col text-left">
                <span className="text-gray-300">Always turn off camera on join</span>
                <span className="text-[10px] text-gray-500 font-medium">Join meetings with video disabled</span>
              </div>
              <button
                type="button"
                onClick={() => setAutoCamOff(!autoCamOff)}
                className="text-brand-purple cursor-pointer shrink-0"
              >
                {autoCamOff ? <ToggleRight size={28} /> : <ToggleLeft size={28} className="text-gray-600" />}
              </button>
            </div>
          </div>
        </div>

        {/* Notifications & Privacy Settings */}
        <div className="bg-white/2 rounded-2xl p-6 border border-white/5 flex flex-col justify-between gap-6">
          <div className="flex flex-col gap-5">
            <h2 className="text-sm font-bold text-white tracking-wide border-b border-white/5 pb-2 flex items-center gap-2">
              <Bell size={16} className="text-brand-blue" />
              <span>System & Security Preferences</span>
            </h2>

            {/* Notification settings */}
            <div className="flex flex-col gap-3.5">
              {/* Push Notif */}
              <div className="flex items-center justify-between text-xs font-semibold px-1">
                <div className="flex flex-col text-left">
                  <span className="text-gray-300">Push Notifications</span>
                  <span className="text-[10px] text-gray-500 font-medium">Alerts for upcoming meetings and summaries</span>
                </div>
                <button
                  type="button"
                  onClick={() => setPushNotif(!pushNotif)}
                  className="text-brand-purple cursor-pointer shrink-0"
                >
                  {pushNotif ? <ToggleRight size={28} /> : <ToggleLeft size={28} className="text-gray-600" />}
                </button>
              </div>

              {/* Email Notif */}
              <div className="flex items-center justify-between text-xs font-semibold px-1">
                <div className="flex flex-col text-left">
                  <span className="text-gray-300">Email Reports</span>
                  <span className="text-[10px] text-gray-500 font-medium">Receive summaries and analytics via email</span>
                </div>
                <button
                  type="button"
                  onClick={() => setEmailNotif(!emailNotif)}
                  className="text-brand-purple cursor-pointer shrink-0"
                >
                  {emailNotif ? <ToggleRight size={28} /> : <ToggleLeft size={28} className="text-gray-600" />}
                </button>
              </div>

              {/* Screen Blur */}
              <div className="flex items-center justify-between text-xs font-semibold px-1">
                <div className="flex flex-col text-left">
                  <span className="text-gray-300">Blur Background on Share</span>
                  <span className="text-[10px] text-gray-500 font-medium">Reduces distraction when sharing webcam stream</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShareBlur(!shareBlur)}
                  className="text-brand-purple cursor-pointer shrink-0"
                >
                  {shareBlur ? <ToggleRight size={28} /> : <ToggleLeft size={28} className="text-gray-600" />}
                </button>
              </div>

              {/* Auto Generate Transcripts */}
              <div className="flex items-center justify-between text-xs font-semibold px-1">
                <div className="flex flex-col text-left">
                  <span className="text-gray-300">Auto Generate Transcripts</span>
                  <span className="text-[10px] text-gray-500 font-medium">Perform speech-to-text transcription automatically</span>
                </div>
                <button
                  type="button"
                  onClick={() => setAutoTranscript(!autoTranscript)}
                  className="text-brand-purple cursor-pointer shrink-0"
                >
                  {autoTranscript ? <ToggleRight size={28} /> : <ToggleLeft size={28} className="text-gray-600" />}
                </button>
              </div>
            </div>
          </div>

          {/* Form submit button */}
          <Button type="submit" variant="primary" className="self-end px-6 flex items-center gap-2">
            <Save size={16} />
            <span>Save Settings</span>
          </Button>
        </div>
      </form>
    </div>
  )
}
