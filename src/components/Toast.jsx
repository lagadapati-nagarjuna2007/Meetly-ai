import { createContext, useContext, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const showToast = useCallback((message, type = 'success') => {
    const id = Math.random().toString(36).substring(2, 9)
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 3000)
  }, [])

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2.5 pointer-events-none">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 25, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.15 } }}
              className="pointer-events-auto flex items-center gap-3 px-4.5 py-3.5 rounded-xl border glassmorphism shadow-2xl min-w-[280px] max-w-sm"
              style={{
                borderColor:
                  toast.type === 'success'
                    ? 'rgba(16, 185, 129, 0.25)'
                    : toast.type === 'error'
                    ? 'rgba(239, 68, 68, 0.25)'
                    : 'rgba(37, 99, 235, 0.25)',
              }}
            >
              {toast.type === 'success' && <CheckCircle2 className="text-emerald-400 shrink-0" size={18} />}
              {toast.type === 'error' && <AlertCircle className="text-red-400 shrink-0" size={18} />}
              {toast.type === 'info' && <Info className="text-blue-400 shrink-0" size={18} />}
              
              <p className="text-xs font-semibold text-gray-200 flex-1 pl-1 leading-snug">
                {toast.message}
              </p>
              
              <button
                onClick={() => removeToast(toast.id)}
                className="text-gray-400 hover:text-white p-1 rounded-md hover:bg-white/5 transition-all duration-200 cursor-pointer shrink-0"
              >
                <X size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}
