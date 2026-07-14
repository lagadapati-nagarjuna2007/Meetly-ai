import { useNavigate } from 'react-router-dom'
import { Calendar, User, BarChart2, MoreVertical, Video } from 'lucide-react'

export default function MeetingCard({ meeting, index = 0 }) {
  const navigate = useNavigate()

  // Cycle colors to match mockup image
  const bgColors = [
    'bg-[#581c87]/20 text-[#c084fc] border-[#581c87]/30',
    'bg-[#064e3b]/20 text-[#34d399] border-[#064e3b]/30',
    'bg-[#78350f]/20 text-[#fbbf24] border-[#78350f]/30',
    'bg-[#1e3a8a]/20 text-[#60a5fa] border-[#1e3a8a]/30'
  ]

  const selectedColor = bgColors[index % bgColors.length]

  const handleOpenReport = () => {
    navigate(`/report/${meeting.id}?tab=attendance`)
  }

  return (
    <div className="flex items-center justify-between p-4 bg-[#0d111d]/50 hover:bg-[#131a2e]/60 rounded-2xl border border-white/5 transition-all duration-200 group">
      {/* Left Column: Meeting Details */}
      <div className="flex items-center gap-4.5 min-w-0">
        {/* Video Icon Block */}
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${selectedColor} shrink-0`}>
          <Video size={16} />
        </div>

        {/* Text Block */}
        <div className="flex flex-col gap-1 text-left min-w-0">
          <h3 className="text-xs font-bold text-white group-hover:text-[#8b5cf6] transition-colors duration-200 truncate">
            {meeting.name}
          </h3>
          
          <div className="flex items-center gap-x-2 text-[10px] text-gray-500 font-semibold flex-wrap">
            <Calendar size={12} className="text-gray-600 shrink-0" />
            <span>{meeting.date}</span>
            <span className="text-gray-700">•</span>
            <span>{meeting.time}</span>
            <span className="text-gray-700">•</span>
            <span>{meeting.duration}</span>
            <span className="text-gray-700">•</span>
            <User size={12} className="text-gray-600 shrink-0 ml-0.5" />
            <span className="truncate">{meeting.host}</span>
          </div>
        </div>
      </div>

      {/* Right Column: Action Button */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          onClick={handleOpenReport}
          className="flex items-center gap-1.5 px-3.5 py-1.5 border border-[#8b5cf6]/30 rounded-xl text-[10px] font-bold text-[#c084fc] bg-[#8b5cf6]/5 hover:bg-[#8b5cf6]/15 transition-all duration-200 cursor-pointer"
        >
          <BarChart2 size={12} className="opacity-80" />
          <span>Open Report</span>
        </button>
        
        {/* Settings options dots */}
        <button className="text-gray-600 hover:text-white p-1 rounded-lg hover:bg-white/5 transition-all duration-200 cursor-pointer">
          <MoreVertical size={15} />
        </button>
      </div>
    </div>
  )
}
