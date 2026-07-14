import { useState } from 'react'
import { useMeetings } from '../context/MeetingContext'
import MeetingCard from '../components/MeetingCard'
import { Search, Calendar, Video, Clock } from 'lucide-react'

export default function History() {
  const { meetings } = useMeetings()
  const [search, setSearch] = useState('')

  // Filter completed meetings
  const completedMeetings = meetings.filter(m => m.status === 'Completed')

  const filteredMeetings = completedMeetings.filter(m =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.host.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex flex-col gap-6 w-full text-left">
      {/* Title block */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-wide mb-1">Meeting History</h1>
        <p className="text-xs text-gray-400">View and inspect reports, AI summaries, and recordings of past calls.</p>
      </div>

      {/* Control bar */}
      <div className="flex flex-col sm:flex-row items-center gap-4 bg-white/2 rounded-2xl p-4 border border-white/5">
        {/* Search */}
        <div className="relative flex items-center flex-1 w-full">
          <div className="absolute left-3.5 text-gray-500 pointer-events-none flex items-center justify-center">
            <Search size={16} />
          </div>
          <input
            type="text"
            placeholder="Search by meeting name or organizer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-900/40 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand-purple focus:ring-1 focus:ring-brand-purple transition-all duration-200"
          />
        </div>

        {/* Stats Row */}
        <div className="flex items-center gap-4 text-xs font-semibold text-gray-400 shrink-0 w-full sm:w-auto justify-between sm:justify-start">
          <span className="flex items-center gap-1.5">
            <Video size={14} className="text-gray-500" />
            <span>{completedMeetings.length} Total</span>
          </span>
          
          <div className="w-1.5 h-1.5 rounded-full bg-white/10 hidden sm:block" />

          <span className="flex items-center gap-1.5">
            <Clock size={14} className="text-gray-500" />
            <span>Avg Focus: 87%</span>
          </span>
        </div>
      </div>

      {/* Meetings List */}
      <div className="flex flex-col gap-3">
        {filteredMeetings.length > 0 ? (
          filteredMeetings.map((mtg, idx) => (
            <MeetingCard key={mtg.id} meeting={mtg} index={idx} />
          ))
        ) : (
          <div className="flex flex-col items-center justify-center py-16 px-4 bg-white/2 border border-white/5 rounded-2xl gap-3">
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-gray-400">
              <Calendar size={18} />
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <h3 className="text-sm font-semibold text-white">No history reports found</h3>
              <p className="text-xs text-gray-500 max-w-[280px]">Try adjusting your search criteria or host another meeting call.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
