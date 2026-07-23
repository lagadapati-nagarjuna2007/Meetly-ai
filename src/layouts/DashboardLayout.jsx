import { useAuth } from '../context/AuthContext'
import { Navigate, Outlet } from 'react-router-dom'
import Sidebar from '../components/Sidebar'
import { motion, AnimatePresence } from 'framer-motion'

export default function DashboardLayout() {
  const { user, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="w-full h-screen bg-[#05060c] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-7 h-7 rounded-full border border-white/10 border-t-purple-500 animate-spin" />
          <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Restoring Session...</span>
        </div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return (
    <div className="w-full h-screen bg-[#05060c] flex overflow-hidden relative">
      {/* Sidebar Navigation */}
      <Sidebar />

      {/* Main Content Area */}
      <main className="flex-1 h-full overflow-y-auto relative p-6 md:p-8 pb-24 md:pb-28 flex flex-col text-left">
        {/* Title Bar Desktop Window Controls (Matches mockup top-right layout) */}
        <div className="absolute top-5 right-7 flex items-center gap-4.5 text-gray-500 z-30 select-none">
          <button className="hover:text-white transition-colors duration-200 cursor-pointer">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button className="hover:text-white transition-colors duration-200 cursor-pointer">
            <rect x="5" y="5" width="14" height="14" rx="1.5" stroke="currentColor" strokeWidth="2.5" fill="none" />
          </button>
          <button className="hover:text-red-500 transition-colors duration-200 cursor-pointer">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Decorative Backdrop Glows */}
        <div className="absolute top-[-30%] right-[-10%] w-[700px] h-[700px] rounded-full bg-[#7c3aed]/2 blur-[150px] pointer-events-none" />
        <div className="absolute bottom-[-30%] left-[-10%] w-[550px] h-[550px] rounded-full bg-[#2563eb]/2 blur-[130px] pointer-events-none" />
        
        {/* Content Box */}
        <div className="w-full max-w-[1300px] mx-auto flex-1 flex flex-col relative z-10 pt-4">
          <AnimatePresence mode="wait">
            <motion.div
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: 0.2 }}
              className="w-full h-full flex flex-col"
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  )
}
