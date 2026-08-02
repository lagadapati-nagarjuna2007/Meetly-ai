import React from 'react'
import { Bot, User } from 'lucide-react'

const parseMarkdown = (text) => {
  if (!text) return ''

  // Escapes HTML tags to prevent cross-site scripting
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Bold formatting: **text** -> <strong>text</strong>
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>')

  // Italic formatting: *text* -> <em>text</em>
  html = html.replace(/\*(.*?)\*/g, '<em class="text-gray-200">$1</em>')

  // Bullet Lists formatting: - item or * item -> <li>item</li>
  const lines = html.split('\n')
  let inList = false
  const processedLines = lines.map(line => {
    const trimmed = line.trim()
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const content = trimmed.substring(2)
      let listPrefix = ''
      if (!inList) {
        inList = true
        listPrefix = '<ul class="list-disc pl-4 my-2 flex flex-col gap-1 text-[11px] text-gray-300">'
      }
      return `${listPrefix}<li>${content}</li>`
    } else {
      let listSuffix = ''
      if (inList) {
        inList = false
        listSuffix = '</ul>'
      }
      return `${listSuffix}${line}`
    }
  })

  if (inList) {
    processedLines.push('</ul>')
  }

  html = processedLines.join('\n')

  // Paragraph divisions
  html = html
    .split('\n\n')
    .map(p => {
      const trimmed = p.trim()
      if (trimmed.startsWith('<ul') || trimmed.startsWith('<li') || trimmed.endsWith('</ul>')) {
        return p
      }
      if (trimmed === '') return ''
      return `<p class="mb-2 text-xs text-gray-300 leading-relaxed">${p.replace(/\n/g, '<br />')}</p>`
    })
    .join('')

  return html
}

const AIMessage = ({ sender, text, timestamp }) => {
  const isAI = sender === 'ai'

  return (
    <div className={`flex gap-3 max-w-[85%] ${isAI ? 'self-start' : 'self-end flex-row-reverse'}`}>
      {/* Sender Icon */}
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border ${
          isAI
            ? 'bg-purple-500/10 border-purple-500/20 text-purple-400'
            : 'bg-blue-500/10 border-blue-500/20 text-blue-400'
        }`}
      >
        {isAI ? <Bot size={14} /> : <User size={14} />}
      </div>

      {/* Message content */}
      <div className="flex flex-col gap-1">
        <div
          className={`px-3 py-2.5 rounded-2xl text-xs border ${
            isAI
              ? 'bg-white/3 border-white/5 text-gray-200 rounded-tl-none'
              : 'bg-purple-600 border-purple-500 text-white rounded-tr-none'
          }`}
        >
          {isAI ? (
            <div
              className="markdown-content"
              dangerouslySetInnerHTML={{ __html: parseMarkdown(text) }}
            />
          ) : (
            <p className="whitespace-pre-wrap leading-relaxed text-xs">{text}</p>
          )}
        </div>

        {/* Timestamp */}
        <span className={`text-[9px] text-gray-500 font-bold uppercase tracking-wider px-1 ${!isAI && 'self-end'}`}>
          {timestamp}
        </span>
      </div>
    </div>
  )
}

export default AIMessage
