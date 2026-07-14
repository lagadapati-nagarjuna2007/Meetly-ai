import { useState } from 'react'
import { Send, Bot, User, HelpCircle } from 'lucide-react'
import Button from '../components/Button'

const SUGGESTIONS = [
  'Summarize the AI Lecture – Week 4 meeting',
  'Who discussed tree rotations in the Data Structures class?',
  'What were the action items for the Project Review Meeting?',
  'What is the average engagement score of my meetings?'
]

const MOCK_ANSWERS = {
  'summarize the ai lecture – week 4 meeting': 'In the **AI Lecture – Week 4** meeting hosted by **Dr. Ravi Kumar**, the team discussed Deep Learning, Transformers, and custom self-attention mechanisms. Hyperparameters and model convergence rates were reviewed. Action items: read the attention paper and complete Assignment 3.',
  'who discussed tree rotations in the data structures class?': 'In the **Data Structures Class**, **Prof. Meena** explained tree rotations in AVL trees to keep tree heights balanced at O(log n). A student asked about time complexities and Prof. Meena confirmed balance guarantees efficiency.',
  'what were the action items for the project review meeting?': 'The action items for the **Project Review Meeting** were:\n1. Finalize the Tailwind CSS configuration.\n2. Complete the structural React page routes for Phase 1.\n3. Conduct the next layout sync check-in tomorrow.',
  'what is the average engagement score of my meetings?': 'Based on your recent history, your average meeting focus score is **87%**, with peak focus (**92%**) occurring during the **Project Review Meeting** and the lowest (**82%**) during the **Data Structures Class**.'
}

export default function AIAssistant() {
  const [messages, setMessages] = useState([
    {
      sender: 'bot',
      text: 'Hello Nagarjuna! I am your Meetly AI Assistant. How can I help you extract insights from your past meetings?'
    }
  ])
  const [input, setInput] = useState('')

  const handleSend = (textToSend) => {
    const query = textToSend || input
    if (!query.trim()) return

    const newMessages = [...messages, { sender: 'user', text: query }]
    setMessages(newMessages)
    setInput('')

    // Generate response
    setTimeout(() => {
      const lowerQuery = query.toLowerCase().trim()
      let responseText = 'I could not find detailed information for that query. Try asking one of the suggested questions.'
      
      // Look for match
      for (const [key, value] of Object.entries(MOCK_ANSWERS)) {
        if (lowerQuery.includes(key) || key.includes(lowerQuery)) {
          responseText = value
          break
        }
      }

      setMessages((prev) => [...prev, { sender: 'bot', text: responseText }])
    }, 700)
  }

  return (
    <div className="flex flex-col gap-6 w-full text-left h-full">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-wide mb-1">AI Meeting Assistant</h1>
        <p className="text-xs text-gray-400">Ask questions, search transcripts, and generate insights using Groq Llama models.</p>
      </div>

      {/* Main chat layout */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1 h-[520px] items-stretch">
        
        {/* Left Suggestions Sidepane */}
        <div className="lg:col-span-1 bg-white/2 border border-white/5 rounded-2xl p-5 flex flex-col gap-4.5">
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1 flex items-center gap-1.5">
            <HelpCircle size={13} className="text-brand-purple" />
            <span>Suggested Prompts</span>
          </span>

          <div className="flex flex-col gap-2.5">
            {SUGGESTIONS.map((sug, idx) => (
              <button
                key={idx}
                onClick={() => handleSend(sug)}
                className="text-left p-3 bg-white/2 hover:bg-brand-purple/10 border border-white/5 hover:border-brand-purple/30 rounded-xl text-xs text-gray-300 hover:text-white transition-all duration-200 cursor-pointer font-medium leading-normal"
              >
                {sug}
              </button>
            ))}
          </div>
        </div>

        {/* Right Chat Panel */}
        <div className="lg:col-span-3 bg-white/2 border border-white/5 rounded-2xl p-5 flex flex-col justify-between items-stretch gap-4">
          
          {/* Messages list */}
          <div className="flex-1 overflow-y-auto pr-2 flex flex-col gap-4">
            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex gap-3 max-w-[85%] ${
                  msg.sender === 'user' ? 'self-end flex-row-reverse' : 'self-start'
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 border ${
                    msg.sender === 'user'
                      ? 'bg-brand-blue/15 border-brand-blue/30 text-brand-blue'
                      : 'bg-brand-purple/15 border-brand-purple/30 text-brand-purple'
                  }`}
                >
                  {msg.sender === 'user' ? <User size={14} /> : <Bot size={14} />}
                </div>
                
                <div
                  className={`p-3.5 rounded-2xl text-xs leading-relaxed ${
                    msg.sender === 'user'
                      ? 'bg-brand-blue text-white rounded-tr-none'
                      : 'bg-white/3 text-gray-200 border border-white/5 rounded-tl-none'
                  }`}
                >
                  <p className="whitespace-pre-line">{msg.text}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Form input */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleSend()
            }}
            className="flex items-center gap-3 border-t border-white/5 pt-3"
          >
            <input
              type="text"
              placeholder="Ask me anything about your meetings..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="flex-1 bg-slate-900/40 border border-white/10 rounded-xl px-4 py-3 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand-purple focus:ring-1 focus:ring-brand-purple transition-all duration-200"
            />
            
            <Button type="submit" className="px-4 py-3 shrink-0">
              <Send size={14} />
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
