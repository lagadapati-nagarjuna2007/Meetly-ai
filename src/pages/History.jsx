import { useState, useEffect } from 'react'
import { useMeetings } from '../context/MeetingContext'
import { useAuth } from '../context/AuthContext'
import MeetingCard from '../components/MeetingCard'
import { Search, Calendar, Video, Clock } from 'lucide-react'

export default function History() {
  const { meetings, fetchHistory } = useMeetings()
  const { user } = useAuth()

  const [endedMeetings, setEndedMeetings] = useState([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [ownershipFilter, setOwnershipFilter] = useState('all')
  const [sortOrder, setSortOrder] = useState('newest')

  // Load meeting history on mount
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const data = await fetchHistory()
        setEndedMeetings(data)
      } catch (err) {
        console.error('Failed to load history:', err)
      }
    }
    loadHistory()
  }, [fetchHistory])

  const handleMeetingDeleted = (deletedDbId) => {
    setEndedMeetings((prev) => prev.filter((m) => m.dbId !== deletedDbId))
  }

  // Combine live/active meetings and historical ended meetings
  const allMeetings = [...meetings, ...endedMeetings]

  // Filter list based on search and selected categories
  const filteredMeetings = allMeetings.filter((m) => {
    // 1. Search filter
    const searchLower = search.toLowerCase()
    const matchesSearch =
      m.name.toLowerCase().includes(searchLower) ||
      m.host.toLowerCase().includes(searchLower)

    // 2. Status filter (Live vs Completed)
    const isMtgActive = m.status === 'Live' || m.status === 'active'
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'active' && isMtgActive) ||
      (statusFilter === 'ended' && !isMtgActive)

    // 3. Ownership filter (Created vs Joined)
    const isCreatedByMe = m.hostId === user?.id
    const matchesOwnership =
      ownershipFilter === 'all' ||
      (ownershipFilter === 'created' && isCreatedByMe) ||
      (ownershipFilter === 'joined' && !isCreatedByMe)

    return matchesSearch && matchesStatus && matchesOwnership
  })

  // Sort list
  filteredMeetings.sort((a, b) => {
    const dateA = new Date(a.started_at || a.date)
    const dateB = new Date(b.started_at || b.date)
    return sortOrder === 'newest' ? dateB - dateA : dateA - dateB
  })

  return (
    <div className="flex flex-col gap-6 w-full text-left">
      {/* Title block */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-wide mb-1">Meeting History</h1>
        <p className="text-xs text-gray-400">View and inspect reports, AI summaries, and recordings of past calls.</p>
      </div>

      {/* Control bar */}
      <div className="flex flex-col items-stretch gap-4 bg-white/2 rounded-2xl p-4 border border-white/5">
        <div className="flex flex-col sm:flex-row items-center gap-4 w-full">
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
              <span>{filteredMeetings.length} Total</span>
            </span>
            
            <div className="w-1.5 h-1.5 rounded-full bg-white/10 hidden sm:block" />

            <span className="flex items-center gap-1.5">
              <Clock size={14} className="text-gray-500" />
              <span>Avg Focus: 87%</span>
            </span>
          </div>
        </div>

        {/* Filters Row */}
        <div className="flex flex-wrap items-center gap-3.5 border-t border-white/5 pt-3.5 mt-1">
          {/* Status filter */}
          <div className="flex items-center gap-1 bg-[#0a0c16]/50 p-1 border border-white/5 rounded-xl">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all duration-200 cursor-pointer ${statusFilter === 'all' ? 'bg-[#7c3aed] text-white shadow-md' : 'text-gray-400 hover:text-white'}`}
            >
              All Status
            </button>
            <button
              onClick={() => setStatusFilter('active')}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all duration-200 cursor-pointer ${statusFilter === 'active' ? 'bg-[#7c3aed] text-white shadow-md' : 'text-gray-400 hover:text-white'}`}
            >
              Active
            </button>
            <button
              onClick={() => setStatusFilter('ended')}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all duration-200 cursor-pointer ${statusFilter === 'ended' ? 'bg-[#7c3aed] text-white shadow-md' : 'text-gray-400 hover:text-white'}`}
            >
              Ended
            </button>
          </div>

          {/* Ownership filter */}
          <div className="flex items-center gap-1 bg-[#0a0c16]/50 p-1 border border-white/5 rounded-xl">
            <button
              onClick={() => setOwnershipFilter('all')}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all duration-200 cursor-pointer ${ownershipFilter === 'all' ? 'bg-[#7c3aed] text-white shadow-md' : 'text-gray-400 hover:text-white'}`}
            >
              All Owners
            </button>
            <button
              onClick={() => setOwnershipFilter('created')}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all duration-200 cursor-pointer ${ownershipFilter === 'created' ? 'bg-[#7c3aed] text-white shadow-md' : 'text-gray-400 hover:text-white'}`}
            >
              Created By Me
            </button>
            <button
              onClick={() => setOwnershipFilter('joined')}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all duration-200 cursor-pointer ${ownershipFilter === 'joined' ? 'bg-[#7c3aed] text-white shadow-md' : 'text-gray-400 hover:text-white'}`}
            >
              Joined
            </button>
          </div>

          {/* Sort filter */}
          <div className="flex items-center gap-1 bg-[#0a0c16]/50 p-1 border border-white/5 rounded-xl">
            <button
              onClick={() => setSortOrder('newest')}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all duration-200 cursor-pointer ${sortOrder === 'newest' ? 'bg-[#7c3aed] text-white shadow-md' : 'text-gray-400 hover:text-white'}`}
            >
              Newest
            </button>
            <button
              onClick={() => setSortOrder('oldest')}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all duration-200 cursor-pointer ${sortOrder === 'oldest' ? 'bg-[#7c3aed] text-white shadow-md' : 'text-gray-400 hover:text-white'}`}
            >
              Oldest
            </button>
          </div>
        </div>
      </div>

      {/* Meetings List */}
      <div className="flex flex-col gap-3">
        {filteredMeetings.length > 0 ? (
          filteredMeetings.map((mtg, idx) => (
            <MeetingCard 
              key={mtg.dbId || mtg.id} 
              meeting={mtg} 
              index={idx} 
              onDeleted={handleMeetingDeleted}
            />
          ))
        ) : (
          <div className="flex flex-col items-center justify-center py-16 px-4 bg-white/2 border border-white/5 rounded-2xl gap-3">
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-gray-400">
              <Calendar size={18} />
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <h3 className="text-sm font-semibold text-white">No history reports found</h3>
              <p className="text-xs text-gray-500 max-w-[280px]">Try adjusting your search or filters, or host a new meeting call.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
