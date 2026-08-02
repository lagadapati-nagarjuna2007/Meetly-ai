import React, { useState, useEffect, useRef } from 'react'
import { Sparkles, Bot } from 'lucide-react'
import AIMessage from './AIMessage'
import ChatInput from './ChatInput'
import useAIChat from '../hooks/useAIChat'

const AIChatPanel = ({ meetingId }) => {
  const {
    messages,
    isLoading,
    remainingQuestions,
    fetchRemainingQuestions,
    askQuestion
  } = useAIChat()

  const [inputVal, setInputVal] = useState('')
  const messagesEndRef = useRef(null)

  // Fetch remaining questions count on mount or refresh
  useEffect(() => {
    if (meetingId) {
      fetchRemainingQuestions(meetingId)
    }
  }, [meetingId, fetchRemainingQuestions])

  // Auto-scroll logic
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, isLoading])

  const handleSend = () => {
    if (inputVal.trim() === '' || isLoading || remainingQuestions <= 0) return
    const text = inputVal.trim()
    setInputVal('')
    askQuestion(meetingId, text)
  }

  const isLimitReached = remainingQuestions <= 0

  return (
    <div className="flex-1 flex flex-col justify-between min-h-0 select-none bg-[#080913]">
      {/* Header/Info Area */}
      <div className="pb-3 border-b border-white/5 flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
            <Sparkles size={11} className="animate-pulse" />
          </div>
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
            Questions Remaining: {remainingQuestions} / 10
          </span>
        </div>
      </div>

      {/* Conversation Area */}
      <div className="flex-1 overflow-y-auto pr-1 flex flex-col gap-4 min-h-0 custom-scrollbar">
        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-2">
            <div className="w-10 h-10 rounded-full bg-purple-500/5 border border-purple-500/10 flex items-center justify-center text-purple-400/50 mb-1">
              <Bot size={20} />
            </div>
            <p className="text-[11px] font-bold text-gray-300">Ask anything about the meeting</p>
            <p className="text-[9px] text-gray-500 max-w-[180px]">
              The AI Assistant answers strictly using the meeting transcript context.
            </p>
          </div>
        ) : (
          messages.map((msg, index) => (
            <AIMessage
              key={index}
              sender={msg.sender}
              text={msg.text}
              timestamp={msg.timestamp}
            />
          ))
        )}

        {/* Loading / Thinking State */}
        {isLoading && (
          <div className="flex gap-3 max-w-[85%] self-start">
            <div className="w-7 h-7 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 shrink-0">
              <Bot size={14} className="animate-spin" />
            </div>
            <div className="flex flex-col gap-1">
              <div className="px-3 py-2.5 rounded-2xl text-xs border bg-white/3 border-white/5 text-purple-400 flex items-center gap-2 rounded-tl-none">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-bounce" style={{ animationDelay: '300ms' }} />
                <span className="text-[10px] font-medium text-gray-400 ml-1">AI is thinking...</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="border-t border-white/5 pt-2 mt-2 bg-[#080913]">
        {isLimitReached ? (
          <div className="text-center p-3 rounded-xl bg-red-600/10 border border-red-500/20 text-[10px] font-bold text-red-400 uppercase tracking-wider leading-relaxed">
            AI Assistant limit reached.
            <br />
            You have already used your 10 questions for this meeting.
          </div>
        ) : (
          <ChatInput
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onSend={handleSend}
            disabled={isLoading || isLimitReached}
            placeholder={isLoading ? 'AI is thinking...' : 'Ask anything...'}
          />
        )}
      </div>
    </div>
  )
}

export default AIChatPanel
