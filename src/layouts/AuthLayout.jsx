import { motion } from 'framer-motion'
import { Sparkles, Users, BarChart3 } from 'lucide-react'
import { useLocation } from 'react-router-dom'

export default function AuthLayout({ children }) {
  const location = useLocation()
  const isRegister = location.pathname.includes('register')

  return (
    <div className="w-full h-full min-h-screen bg-[#05060f] flex items-center justify-center p-6 relative overflow-hidden select-none">
      {/* Backdrop Glow Spheres */}
      <div className="absolute top-[-15%] left-[-10%] w-[550px] h-[550px] rounded-full bg-[#7c3aed]/10 blur-[130px] pointer-events-none" />
      <div className="absolute bottom-[-15%] right-[-10%] w-[550px] h-[550px] rounded-full bg-[#2563eb]/10 blur-[130px] pointer-events-none" />

      {/* Main Container */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="w-full max-w-[1000px] h-[620px] bg-[#0d111e]/60 border border-white/5 rounded-3xl overflow-hidden shadow-2xl flex flex-col md:flex-row relative z-10 backdrop-blur-md"
      >
        {/* Left Section: Branding & Feature Illustration */}
        <div className="hidden md:flex md:w-[48%] bg-[#080911]/85 p-12 flex-col justify-between border-r border-white/5 relative">
          
          {/* Brand Header */}
          <div className="flex flex-col text-left">
            <div className="flex items-center gap-2.5 mb-1.5">
              <div className="w-8.5 h-8.5 rounded-xl bg-gradient-to-tr from-[#7c3aed] to-[#2563eb] flex items-center justify-center shadow-lg">
                {/* SVG Video camera sparkle logo */}
                <svg className="w-4.5 h-4.5 text-white fill-current" viewBox="0 0 24 24">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4zM12 14c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z" />
                </svg>
              </div>
              <span className="font-bold text-lg text-white tracking-wide">
                Meetly <span className="text-[#8b5cf6]">AI</span>
              </span>
            </div>
            <p className="text-[10px] text-gray-500 font-semibold tracking-wider uppercase">
              AI-Powered Meetings. Smarter Insights.
            </p>
          </div>

          {/* Smarter Meetings Title for Register Screen */}
          {isRegister && (
            <div className="text-left mt-4 mb-2">
              <h2 className="text-xl font-bold text-white tracking-wide mb-1.5 leading-snug">
                Smarter Meetings <br />With <span className="text-[#8b5cf6]">AI</span>
              </h2>
              <p className="text-[11px] text-gray-400 leading-relaxed font-medium">
                Meetly AI helps you conduct productive meetings with AI summaries, smart insights, attendance tracking and more.
              </p>
            </div>
          )}

          {/* Interactive CSS Illustration of meeting UI */}
          <div className="flex justify-center py-2.5">
            <div className="relative w-full max-w-[270px] aspect-[1.55] bg-[#070912] border border-white/5 rounded-2xl p-2.5 shadow-2xl flex flex-col justify-between">
              {/* Browser Dots */}
              <div className="flex items-center justify-between border-b border-white/5 pb-1.5 mb-1.5">
                <div className="flex gap-1">
                  <div className="w-1.2 h-1.2 rounded-full bg-white/20" />
                  <div className="w-1.2 h-1.2 rounded-full bg-white/20" />
                  <div className="w-1.2 h-1.2 rounded-full bg-white/20" />
                </div>
                <div className="flex gap-1">
                  <div className="w-1.2 h-1.2 rounded-full bg-white/20" />
                  <div className="w-1.2 h-1.2 rounded-full bg-white/20" />
                  <div className="w-1.2 h-1.2 rounded-full bg-white/20" />
                </div>
              </div>

              {/* Feed Grid */}
              <div className="flex-1 flex gap-2 items-stretch overflow-hidden">
                {/* Left Feed Column */}
                <div className="w-[25%] flex flex-col gap-1.5 justify-center">
                  <div className="flex-1 bg-white/5 border border-white/5 rounded-lg flex items-center justify-center">
                    <div className="w-3.5 h-3.5 rounded-full bg-white/10" />
                  </div>
                  <div className="flex-1 bg-white/5 border border-white/5 rounded-lg flex items-center justify-center">
                    <div className="w-3.5 h-3.5 rounded-full bg-white/10" />
                  </div>
                </div>

                {/* Center Video Frame */}
                <div className="flex-1 bg-gradient-to-tr from-[#7c3aed]/15 to-[#2563eb]/5 border border-[#7c3aed]/20 rounded-xl flex items-center justify-center relative">
                  <div className="w-7 h-7 rounded-lg bg-[#7c3aed]/20 border border-[#7c3aed]/30 flex items-center justify-center text-[#8b5cf6]">
                    <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                      <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                    </svg>
                  </div>
                </div>

                {/* Right Side Info */}
                <div className="w-[30%] flex flex-col gap-1.5 justify-center">
                  {isRegister ? (
                    <div className="flex-1 bg-white/3 border border-white/5 rounded-lg p-1.5 flex flex-col gap-1 text-left relative overflow-hidden">
                      <span className="text-[6.5px] font-bold text-white leading-none">AI Summary</span>
                      <div className="h-0.5 w-[85%] bg-[#7c3aed]/40 rounded" />
                      <div className="h-0.5 w-[70%] bg-white/10 rounded" />
                      <div className="h-0.5 w-[80%] bg-white/10 rounded" />
                      <div className="h-0.5 w-[50%] bg-white/10 rounded" />
                    </div>
                  ) : (
                    <div className="flex-1 bg-white/3 border border-white/5 rounded-lg p-1.5 flex flex-col gap-1 text-left justify-center">
                      <div className="h-1 w-full bg-white/10 rounded" />
                      <div className="h-1 w-[80%] bg-white/10 rounded" />
                      <div className="h-1 w-[60%] bg-white/10 rounded" />
                    </div>
                  )}
                </div>
              </div>

              {/* Bottom Row Controls for Register / Dots for Login */}
              {isRegister ? (
                <div className="flex justify-center gap-1.5 mt-2 border-t border-white/5 pt-1.5 select-none opacity-40">
                  <div className="w-2.5 h-2.5 rounded bg-white/15" />
                  <div className="w-2.5 h-2.5 rounded bg-white/15" />
                  <div className="w-2.5 h-2.5 rounded bg-white/15" />
                  <div className="w-2.5 h-2.5 rounded bg-white/15" />
                  <div className="w-2.5 h-2.5 rounded bg-white/15" />
                  <div className="w-2.5 h-2.5 rounded bg-red-600/30" />
                </div>
              ) : (
                <div className="flex gap-1 justify-center mt-2.5">
                  <div className="w-1.2 h-1.2 rounded-full bg-white" />
                  <div className="w-1.2 h-1.2 rounded-full bg-white/25" />
                  <div className="w-1.2 h-1.2 rounded-full bg-white/25" />
                  <div className="w-1.2 h-1.2 rounded-full bg-white/25" />
                </div>
              )}

              {/* Overlapping AI Tag */}
              <div className="absolute left-[-8px] top-[40%] px-1.5 py-0.5 rounded-md bg-[#7c3aed] flex items-center justify-center shadow-lg text-[7px] font-bold text-white border border-[#7c3aed]/25 z-20">
                AI
              </div>
            </div>
          </div>

          {/* Features Checklist Panel */}
          <div className="flex flex-col gap-3 py-2">
            {/* Feature 1 */}
            <div className="flex items-center gap-3 text-left">
              <div className="w-8 h-8 rounded-lg bg-[#7c3aed]/10 flex items-center justify-center text-[#8b5cf6] border border-[#7c3aed]/10 shrink-0">
                <Sparkles size={14} />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-bold text-white">AI Summaries</span>
                <span className="text-[9px] text-gray-500 font-medium">Get instant, accurate summaries of your meetings.</span>
              </div>
            </div>

            {/* Feature 2 */}
            <div className="flex items-center gap-3 text-left">
              <div className="w-8 h-8 rounded-lg bg-[#7c3aed]/10 flex items-center justify-center text-[#8b5cf6] border border-[#7c3aed]/10 shrink-0">
                <Users size={14} />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-bold text-white">Smart Attendance</span>
                <span className="text-[9px] text-gray-500 font-medium">Automatic tracking and detailed reports.</span>
              </div>
            </div>

            {/* Feature 3 */}
            <div className="flex items-center gap-3 text-left">
              <div className="w-8 h-8 rounded-lg bg-[#7c3aed]/10 flex items-center justify-center text-[#8b5cf6] border border-[#7c3aed]/10 shrink-0">
                <BarChart3 size={14} />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-bold text-white">Focus Analytics</span>
                <span className="text-[9px] text-gray-500 font-medium">Understand engagement and improve productivity.</span>
              </div>
            </div>

            {/* Slide Navigation Dots for Login Screen Only */}
            {!isRegister && (
              <div className="flex gap-1.5 pl-1.5 mt-2">
                <div className="w-3.5 h-1.5 rounded-full bg-[#8b5cf6]" />
                <div className="w-1.5 h-1.5 rounded-full bg-gray-700" />
                <div className="w-1.5 h-1.5 rounded-full bg-gray-700" />
              </div>
            )}
          </div>
        </div>

        {/* Right Section: Form Wrapper */}
        <div className="w-full md:w-[52%] h-full overflow-y-auto bg-slate-950/20 p-8 md:p-12 flex flex-col justify-center select-none">
          {children}
        </div>
      </motion.div>
    </div>
  )
}
