import { useState, useEffect } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { useMeetings } from '../context/MeetingContext'
import { useToast } from '../components/Toast'
import {
  Users,
  Brain,
  FileText,
  MessageSquare,
  Play,
  ArrowLeft,
  Search,
  CheckCircle,
  Clock,
  AlertTriangle,
  PlayCircle
} from 'lucide-react'

export default function Report() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { meetings, fetchMeetingSummary, generateMeetingSummary } = useMeetings()
  const { showToast } = useToast()

  // Find meeting report data
  const meeting = meetings.find(m => m.id === id) || meetings[0]

  // Pre-selected tab from query search parameter or default to 'attendance'
  const initialTab = searchParams.get('tab') || 'attendance'
  const [activeTab, setActiveTab] = useState(initialTab)
  
  // Transcript search
  const [searchTranscript, setSearchTranscript] = useState('')

  // AI Summary State
  const [summaryData, setSummaryData] = useState(null)
  const [isLoadingSummary, setIsLoadingSummary] = useState(false)
  const [summaryError, setSummaryError] = useState(null)

  useEffect(() => {
    if (activeTab === 'summary' && meeting?.dbId && !summaryData && !isLoadingSummary) {
      setIsLoadingSummary(true)
      fetchMeetingSummary(meeting.dbId)
        .then((data) => {
          let parsed = data
          if (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed) } catch (e) {}
          }
          setSummaryData(parsed)
          setSummaryError(null)
        })
        .catch((err) => {
          console.warn('[Report] Failed to fetch stored summary:', err.message)
          setSummaryError(err.message || 'Summary not generated yet.')
        })
        .finally(() => {
          setIsLoadingSummary(false)
        })
    }
  }, [activeTab, meeting?.dbId, fetchMeetingSummary])

  const handleGenerateSummaryInReport = async () => {
    if (!meeting?.dbId) return
    setIsLoadingSummary(true)
    setSummaryError(null)
    try {
      const data = await generateMeetingSummary(meeting.dbId)
      let parsed = data
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed) } catch (e) {}
      }
      setSummaryData(parsed)
      showToast('AI Summary generated successfully!', 'success')
    } catch (err) {
      console.error('[Report Summary Error]:', err)
      setSummaryError(err.message || 'Unable to generate summary.')
      showToast(err.message || 'Unable to generate summary.', 'error')
    } finally {
      setIsLoadingSummary(false)
    }
  }

  if (!meeting) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
        <span className="text-sm font-semibold text-gray-400">Meeting report not found</span>
        <button onClick={() => navigate('/')} className="text-brand-purple hover:underline text-xs font-semibold">
          Return to dashboard
        </button>
      </div>
    )
  }

  // Filter transcript
  const filteredTranscript = meeting.transcript.filter(t =>
    t.speaker.toLowerCase().includes(searchTranscript.toLowerCase()) ||
    t.text.toLowerCase().includes(searchTranscript.toLowerCase())
  )

  const tabs = [
    { id: 'attendance', label: 'Attendance', icon: Users },
    { id: 'focus', label: 'Focus & Engagement', icon: Brain },
    { id: 'summary', label: 'AI Summary', icon: FileText },
    { id: 'transcript', label: 'Transcript', icon: MessageSquare },
    { id: 'recording', label: 'Recording', icon: Play }
  ]

  return (
    <div className="flex flex-col gap-6 w-full text-left">
      {/* Header and Back Button */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('/history')}
          className="p-2 border border-white/5 bg-white/2 hover:bg-white/5 hover:border-white/10 rounded-xl text-gray-400 hover:text-white transition-all duration-200 cursor-pointer"
        >
          <ArrowLeft size={16} />
        </button>
        <div>
          <h1 className="text-xl font-bold text-white tracking-wide">{meeting.name}</h1>
          <p className="text-xs text-gray-500">Report details for call hosted on {meeting.date} at {meeting.time}</p>
        </div>
      </div>

      {/* Tabs list */}
      <div className="flex flex-wrap gap-2 border-b border-white/5 pb-1 select-none">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4.5 py-3 text-xs font-semibold border-b-2 transition-all duration-200 cursor-pointer ${
              activeTab === tab.id
                ? 'border-brand-purple text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <tab.icon size={14} />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Report Content Panels */}
      <div className="flex-1 min-h-[420px] bg-white/2 border border-white/5 rounded-2xl p-6">
        
        {/* PANEL: ATTENDANCE */}
        {activeTab === 'attendance' && (
          <div className="flex flex-col gap-6">
            {/* Stats row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-white/2 border border-white/3 p-4.5 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-brand-purple-light flex items-center justify-center text-brand-purple shrink-0">
                  <Users size={18} />
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Total Participants</span>
                  <span className="text-base font-bold text-white">4 Attendees</span>
                </div>
              </div>

              <div className="bg-white/2 border border-white/3 p-4.5 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 shrink-0">
                  <CheckCircle size={18} />
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Attendance Ratio</span>
                  <span className="text-base font-bold text-white">{meeting.attendance || '90%'}</span>
                </div>
              </div>

              <div className="bg-white/2 border border-white/3 p-4.5 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0">
                  <Clock size={18} />
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Average Duration</span>
                  <span className="text-base font-bold text-white">{meeting.duration}</span>
                </div>
              </div>
            </div>

            {/* Attendance Table */}
            <div className="overflow-x-auto w-full">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/5 text-gray-500 font-bold uppercase tracking-wider">
                    <th className="pb-3 pl-2">Attendee</th>
                    <th className="pb-3">Join Time</th>
                    <th className="pb-3">Leave Time</th>
                    <th className="pb-3">Duration</th>
                    <th className="pb-3 pr-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/2">
                  <tr className="text-gray-300">
                    <td className="py-3 pl-2 font-semibold text-white">Nagarjuna Sai</td>
                    <td className="py-3">10:00 AM</td>
                    <td className="py-3">11:00 AM</td>
                    <td className="py-3">60 min</td>
                    <td className="py-3 text-emerald-400 font-semibold">Present</td>
                  </tr>
                  <tr className="text-gray-300">
                    <td className="py-3 pl-2 font-semibold text-white">Dr. Ravi Kumar</td>
                    <td className="py-3">10:01 AM</td>
                    <td className="py-3">11:00 AM</td>
                    <td className="py-3">59 min</td>
                    <td className="py-3 text-emerald-400 font-semibold">Present</td>
                  </tr>
                  <tr className="text-gray-300">
                    <td className="py-3 pl-2 font-semibold text-white">Prof. Meena</td>
                    <td className="py-3">10:03 AM</td>
                    <td className="py-3">10:58 AM</td>
                    <td className="py-3">55 min</td>
                    <td className="py-3 text-emerald-400 font-semibold">Present</td>
                  </tr>
                  <tr className="text-gray-300">
                    <td className="py-3 pl-2 font-semibold text-white">Student B</td>
                    <td className="py-3">10:14 AM</td>
                    <td className="py-3">11:00 AM</td>
                    <td className="py-3">46 min</td>
                    <td className="py-3 text-amber-400 font-semibold">Late</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* PANEL: FOCUS */}
        {activeTab === 'focus' && (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-white/2 border border-white/3 p-4.5 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-brand-purple-light flex items-center justify-center text-brand-purple shrink-0">
                  <Brain size={18} />
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Average Group Focus</span>
                  <span className="text-base font-bold text-white">{meeting.focusScore || '87%'}</span>
                </div>
              </div>

              <div className="bg-white/2 border border-white/3 p-4.5 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 shrink-0">
                  <CheckCircle size={18} />
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Engagement Status</span>
                  <span className="text-base font-bold text-white text-emerald-400">High</span>
                </div>
              </div>

              <div className="bg-white/2 border border-white/3 p-4.5 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400 shrink-0">
                  <AlertTriangle size={18} />
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Drowsiness Triggers</span>
                  <span className="text-base font-bold text-white">0 Alerts</span>
                </div>
              </div>
            </div>

            {/* Custom Visual HTML Focus Graph */}
            <div className="flex flex-col gap-3 text-left">
              <span className="text-xs font-semibold text-gray-400 pl-1">Aggregate Focus Timeline (%)</span>
              <div className="bg-slate-950/40 border border-white/5 rounded-xl p-6 h-56 flex items-end justify-between relative">
                {/* Y-axis levels */}
                <div className="absolute left-3 top-3 bottom-3 flex flex-col justify-between text-[9px] text-gray-600 font-bold select-none">
                  <span>100%</span>
                  <span>75%</span>
                  <span>50%</span>
                  <span>25%</span>
                </div>
                
                {/* Horizontal guide grids */}
                <div className="absolute left-10 right-4 top-[25%] border-b border-white/3 pointer-events-none" />
                <div className="absolute left-10 right-4 top-[50%] border-b border-white/3 pointer-events-none" />
                <div className="absolute left-10 right-4 top-[75%] border-b border-white/3 pointer-events-none" />

                {/* Graph bars representing simulated focus metrics */}
                <div className="flex-1 ml-8 mr-2 h-full flex items-end gap-3.5 z-10">
                  {[82, 85, 91, 89, 78, 86, 92, 84, 88, 94, 85, 90].map((val, idx) => (
                    <div key={idx} className="flex-1 flex flex-col items-center gap-2 group h-full justify-end cursor-pointer">
                      <div className="text-[9px] text-brand-purple font-bold opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        {val}%
                      </div>
                      <div
                        className="w-full bg-gradient-to-t from-brand-purple/40 to-brand-purple rounded-t-md transition-all duration-300 group-hover:from-brand-purple/60 group-hover:to-brand-purple-hover"
                        style={{ height: `${val}%` }}
                      />
                      <span className="text-[8px] text-gray-600 font-bold uppercase tracking-wider mt-1 select-none">
                        {idx * 5}m
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PANEL: SUMMARY */}
        {activeTab === 'summary' && (
          <div className="flex flex-col gap-6 text-left text-xs leading-relaxed max-w-4xl">
            {isLoadingSummary ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3 text-gray-400">
                <div className="w-8 h-8 rounded-full border-2 border-brand-purple border-t-transparent animate-spin" />
                <span className="text-xs font-semibold">Generating AI Summary...</span>
              </div>
            ) : summaryData ? (
              (() => {
                const overview = typeof summaryData === 'string' ? summaryData : (summaryData.overview || 'No overview available.')
                const topics = Array.isArray(summaryData?.topicsDiscussed) ? summaryData.topicsDiscussed : []
                const keyPoints = Array.isArray(summaryData?.keyPoints) ? summaryData.keyPoints : []
                const decisions = Array.isArray(summaryData?.decisionsMade) ? summaryData.decisionsMade : []
                const actions = Array.isArray(summaryData?.actionItems) ? summaryData.actionItems : []

                return (
                  <div className="flex flex-col gap-6">
                    {/* Header Action Bar */}
                    <div className="flex items-center justify-between pb-3 border-b border-white/5">
                      <h2 className="text-sm font-bold text-white tracking-wide flex items-center gap-2">
                        <FileText size={16} className="text-brand-purple" />
                        AI Meeting Summary
                      </h2>
                      <button
                        onClick={handleGenerateSummaryInReport}
                        className="px-3 py-1.5 bg-brand-purple/20 hover:bg-brand-purple/30 border border-brand-purple/30 text-purple-300 rounded-xl text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5"
                      >
                        <Brain size={14} />
                        <span>Regenerate Summary</span>
                      </button>
                    </div>

                    {/* 1. Overview */}
                    <div className="flex flex-col gap-2 p-4 bg-white/2 border border-white/5 rounded-2xl">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-brand-purple">1. Overview</h3>
                      <p className="text-gray-200 leading-relaxed font-medium">
                        {overview}
                      </p>
                    </div>

                    {/* 2. Topics Discussed */}
                    <div className="flex flex-col gap-3 p-4 bg-white/2 border border-white/5 rounded-2xl">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-brand-purple">2. Topics Discussed</h3>
                      {topics.length === 0 ? (
                        <p className="text-gray-400 italic">None identified.</p>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {topics.map((t, idx) => (
                            <div key={idx} className="flex flex-col gap-1 text-left pl-2 border-l-2 border-purple-500/40">
                              <span className="text-xs font-bold text-white">• {t.title}</span>
                              {t.description && <p className="text-gray-300 text-[11px] leading-relaxed">{t.description}</p>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 3. Key Points */}
                    <div className="flex flex-col gap-3 p-4 bg-white/2 border border-white/5 rounded-2xl">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-brand-purple">3. Key Points</h3>
                      {keyPoints.length === 0 ? (
                        <p className="text-gray-400 italic">None identified.</p>
                      ) : (
                        <ul className="flex flex-col gap-2 pl-2 text-gray-200 font-medium">
                          {keyPoints.map((kp, idx) => (
                            <li key={idx} className="flex items-start gap-2">
                              <span className="text-brand-purple font-bold">•</span>
                              <span>{kp}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {/* 4. Decisions Made */}
                    <div className="flex flex-col gap-3 p-4 bg-white/2 border border-white/5 rounded-2xl">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-brand-purple">4. Decisions Made</h3>
                      {decisions.length === 0 ? (
                        <p className="text-gray-400 italic">None identified.</p>
                      ) : (
                        <ul className="flex flex-col gap-2 pl-2 text-gray-200 font-medium">
                          {decisions.map((d, idx) => (
                            <li key={idx} className="flex items-start gap-2">
                              <CheckCircle size={14} className="text-emerald-400 shrink-0 mt-0.5" />
                              <span>{d}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {/* 5. Action Items */}
                    <div className="flex flex-col gap-3 p-4 bg-white/2 border border-white/5 rounded-2xl">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-brand-purple">5. Action Items</h3>
                      {actions.length === 0 ? (
                        <p className="text-gray-400 italic">None identified.</p>
                      ) : (
                        <div className="flex flex-col gap-2.5 pl-1">
                          {actions.map((a, idx) => (
                            <div key={idx} className="flex items-center gap-2 text-xs bg-slate-900/40 p-2.5 rounded-xl border border-white/5">
                              {a.assignee ? (
                                <>
                                  <span className="px-2 py-0.5 rounded bg-brand-purple/20 border border-brand-purple/30 text-purple-300 font-bold text-[10px] shrink-0">
                                    {a.assignee}
                                  </span>
                                  <span className="text-gray-400">→</span>
                                </>
                              ) : null}
                              <span className="text-gray-200 font-medium">{a.task}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center gap-4 border border-dashed border-white/10 rounded-2xl p-6 bg-white/2">
                <FileText size={32} className="text-gray-500" />
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-semibold text-white">No AI Summary Generated</span>
                  <p className="text-xs text-gray-400 max-w-md">
                    {summaryError || 'Click below to analyze the meeting transcript and generate a structured AI summary.'}
                  </p>
                </div>
                <button
                  onClick={handleGenerateSummaryInReport}
                  className="mt-2 px-5 py-2 bg-brand-purple hover:bg-brand-purple-hover text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-purple-900/30 cursor-pointer flex items-center gap-2"
                >
                  <Brain size={14} />
                  <span>Generate AI Summary</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* PANEL: TRANSCRIPT */}
        {activeTab === 'transcript' && (
          <div className="flex flex-col gap-4">
            {/* Search filter input */}
            <div className="relative flex items-center w-full">
              <div className="absolute left-3.5 text-gray-500 pointer-events-none flex items-center justify-center">
                <Search size={14} />
              </div>
              <input
                type="text"
                placeholder="Search text or speaker tags..."
                value={searchTranscript}
                onChange={(e) => setSearchTranscript(e.target.value)}
                className="w-full bg-slate-900/40 border border-white/10 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand-purple transition-all duration-200"
              />
            </div>

            {/* Transcript Logs */}
            <div className="flex flex-col gap-4 max-h-[340px] overflow-y-auto pr-2 mt-1">
              {filteredTranscript.length > 0 ? (
                filteredTranscript.map((log, idx) => (
                  <div key={idx} className="flex gap-4 p-3 bg-white/2 border border-white/3 rounded-xl">
                    {/* Timestamp & Speaker Tag */}
                    <div className="flex flex-col text-left shrink-0 min-w-[120px] select-none">
                      <span className="text-[10px] font-bold text-brand-purple-hover">{log.speaker}</span>
                      <span className="text-[9px] text-gray-500 font-semibold mt-0.5">{log.time}</span>
                    </div>

                    {/* Text sentence */}
                    <p className="text-xs text-gray-300 font-medium leading-relaxed flex-1">
                      {log.text}
                    </p>
                  </div>
                ))
              ) : (
                <div className="text-center py-10 text-gray-500 text-xs font-semibold">
                  No transcript matched your search filter.
                </div>
              )}
            </div>
          </div>
        )}

        {/* PANEL: RECORDING */}
        {activeTab === 'recording' && (
          <div className="flex flex-col gap-4 max-w-3xl">
            <div className="aspect-video bg-slate-950 border border-white/5 rounded-2xl relative overflow-hidden flex flex-col items-center justify-center shadow-2xl group">
              {/* Fake Video stream preview */}
              <div className="absolute inset-0 bg-[#090b14]/50 backdrop-blur-xs flex flex-col items-center justify-center gap-3 select-none">
                <button
                  onClick={() => showToast('Playback starting... (Mock Stream)', 'success')}
                  className="w-16 h-16 rounded-full bg-brand-purple hover:bg-brand-purple-hover text-white flex items-center justify-center transition-all duration-200 shadow-xl shadow-brand-purple/20 cursor-pointer transform hover:scale-105"
                >
                  <Play size={24} className="fill-white ml-1" />
                </button>
                <span className="text-xs font-bold text-gray-300">Play Meeting Stream</span>
              </div>
            </div>

            {/* Video player controls dashboard */}
            <div className="flex items-center justify-between p-3.5 bg-white/2 border border-white/3 rounded-xl text-xs font-semibold">
              <div className="flex items-center gap-3 text-gray-400">
                <PlayCircle size={18} className="text-brand-purple" />
                <span>Recording-05-24-2024.mp4</span>
              </div>

              {/* Speed selector */}
              <div className="flex items-center gap-1">
                {['1.0x', '1.5x', '2.0x'].map((spd) => (
                  <button
                    key={spd}
                    onClick={() => showToast(`Speed set to ${spd}`, 'info')}
                    className="px-2.5 py-1 bg-white/3 hover:bg-white/5 hover:text-white rounded text-[10px] text-gray-400 transition-colors cursor-pointer"
                  >
                    {spd}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
