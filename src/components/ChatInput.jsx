import React from 'react'
import { Send } from 'lucide-react'

const ChatInput = ({ value, onChange, onSend, disabled, placeholder }) => {
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!disabled && value.trim() !== '') {
        onSend()
      }
    }
  }

  return (
    <div className="flex items-center gap-2 border-t border-white/5 pt-3 mt-2 bg-[#080913]">
      <textarea
        rows={1}
        value={value}
        onChange={onChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || 'Ask anything...'}
        disabled={disabled}
        className="flex-1 bg-slate-900/40 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition-all duration-200 resize-none max-h-24 min-h-[38px] leading-relaxed disabled:opacity-50"
      />
      <button
        onClick={onSend}
        disabled={disabled || value.trim() === ''}
        className="w-10 h-10 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:bg-slate-800/80 text-white disabled:text-gray-500 flex items-center justify-center shrink-0 transition-all cursor-pointer disabled:cursor-not-allowed shadow-lg shadow-purple-600/10"
      >
        <Send size={14} />
      </button>
    </div>
  )
}

export default ChatInput
