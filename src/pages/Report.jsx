import { useState, useEffect } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
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
  PlayCircle,
  Download,
  Copy,
  Check
} from 'lucide-react'
import { jsPDF } from 'jspdf'
import { formatDuration } from '../utils/durationHelper'

export default function Report() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { meetings, fetchMeetingSummary, generateMeetingSummary, getAttendanceReport } = useMeetings()
  const { showToast } = useToast()

  // Find meeting report data (do NOT fall back to meetings[0])
  const meeting = meetings.find(m => m.id === id || m.dbId === id)
  const isOwner = meeting && (!meeting.hostId || !user?.id || String(meeting.hostId).toLowerCase() === String(user.id).toLowerCase())

  // Pre-selected tab from query search parameter or default to 'attendance'
  const initialTab = searchParams.get('tab') || 'attendance'
  const [activeTab, setActiveTab] = useState(initialTab)
  
  // Transcript search
  const [searchTranscript, setSearchTranscript] = useState('')

  // AI Summary State
  const [summaryData, setSummaryData] = useState(null)
  const [isLoadingSummary, setIsLoadingSummary] = useState(false)
  const [summaryError, setSummaryError] = useState(null)
  const [copiedProgramIdx, setCopiedProgramIdx] = useState(null)

  // AI Attendance State
  const [attendanceRecords, setAttendanceRecords] = useState(null)
  const [isLoadingAttendance, setIsLoadingAttendance] = useState(false)
  const [attendanceError, setAttendanceError] = useState(null)

  // Screen Recording State
  const [recordingInfo, setRecordingInfo] = useState(null)
  const [isLoadingRecording, setIsLoadingRecording] = useState(false)
  const [recordingStreamUrl, setRecordingStreamUrl] = useState(null)
  const [isPlayingRecording, setIsPlayingRecording] = useState(false)
  const [isDownloadingRecording, setIsDownloadingRecording] = useState(false)
  const [recordingError, setRecordingError] = useState(null)

  // Fetch real attendance records when attendance tab is active
  useEffect(() => {
    const targetMeetingId = meeting?.dbId || id
    if (activeTab === 'attendance' && targetMeetingId && !attendanceRecords && !isLoadingAttendance) {
      setIsLoadingAttendance(true)
      getAttendanceReport(targetMeetingId)
        .then((data) => {
          setAttendanceRecords(Array.isArray(data) ? data : [])
          setAttendanceError(null)
        })
        .catch((err) => {
          console.warn('[Report] Failed to fetch attendance report:', err.message)
          setAttendanceError(err.message || 'No attendance records found.')
        })
        .finally(() => {
          setIsLoadingAttendance(false)
        })
    }
  }, [activeTab, meeting?.dbId, id, attendanceRecords, isLoadingAttendance, getAttendanceReport])

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

  // Fetch real recording metadata when recording tab is active
  useEffect(() => {
    const targetMeetingId = meeting?.dbId || id
    if (activeTab === 'recording' && targetMeetingId && !recordingInfo && !isLoadingRecording) {
      setIsLoadingRecording(true)
      const token = sessionStorage.getItem('meetly_auth_token')
      fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/${targetMeetingId}/recording`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      })
        .then(async res => {
          if (!res.ok) {
            if (res.status === 404) return null
            throw new Error('Recording not found or unavailable.')
          }
          return res.json()
        })
        .then(data => {
          setRecordingInfo(data)
          setRecordingError(null)
        })
        .catch(err => {
          setRecordingError(err.message)
        })
        .finally(() => {
          setIsLoadingRecording(false)
        })
    }
  }, [activeTab, meeting?.dbId, id, recordingInfo, isLoadingRecording])

  const handlePlayRecording = async () => {
    const targetMeetingId = meeting?.dbId || id
    const token = sessionStorage.getItem('meetly_auth_token')
    try {
      showToast('Loading secure playback stream...', 'info')
      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/${targetMeetingId}/recording/stream`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      })
      if (!res.ok) {
        throw new Error('Could not load recording stream.')
      }
      const data = await res.json()
      setRecordingStreamUrl(data.streamUrl)
      setIsPlayingRecording(true)
      showToast('Playback stream ready.', 'success')
    } catch (e) {
      showToast(e.message || 'Failed to start playback.', 'error')
    }
  }

  const handleDownloadRecording = async () => {
    const targetMeetingId = meeting?.dbId || id
    const token = sessionStorage.getItem('meetly_auth_token')
    try {
      setIsDownloadingRecording(true)
      showToast('Generating secure download URL...', 'info')
      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/${targetMeetingId}/recording/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      })
      if (!res.ok) {
        throw new Error('Could not generate download URL.')
      }
      const data = await res.json()
      const a = document.createElement('a')
      a.href = data.downloadUrl
      a.download = data.filename || 'recording.webm'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      showToast('Download started.', 'success')
    } catch (e) {
      showToast(e.message || 'Download failed.', 'error')
    } finally {
      setIsDownloadingRecording(false)
    }
  }

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

  const handleCopyProgram = (code, idx) => {
    if (!code) return
    navigator.clipboard.writeText(code)
    setCopiedProgramIdx(idx)
    showToast('Source code copied to clipboard!', 'success')
    setTimeout(() => {
      setCopiedProgramIdx(null)
    }, 2500)
  }

  const handleDownloadAttendancePDF = () => {
    const records = attendanceRecords || []
    if (records.length === 0) {
      showToast('No attendance records available to export.', 'warning')
      return
    }
    const doc = new jsPDF()
    const pageHeight = doc.internal.pageSize.height
    const margin = 20
    const lineSpacing = 7
    let cursorY = 20

    // Header
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(22)
    doc.setTextColor(124, 58, 237)
    doc.text('MEETLY AI', margin, cursorY)
    cursorY += 10

    doc.setFontSize(14)
    doc.setTextColor(100, 116, 139)
    doc.text('AI Attendance Report', margin, cursorY)
    cursorY += 10

    // Divider Line
    doc.setDrawColor(226, 232, 240)
    doc.setLineWidth(0.5)
    doc.line(margin, cursorY, 210 - margin, cursorY)
    cursorY += 12

    // Metadata Block
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(71, 85, 105)
    doc.text('Meeting Name:', margin, cursorY)
    doc.setFont('helvetica', 'normal')
    doc.text(meeting.name || 'Untitled Meeting', margin + 35, cursorY)
    cursorY += 8

    doc.setFont('helvetica', 'bold')
    doc.text('Meeting Date:', margin, cursorY)
    doc.setFont('helvetica', 'normal')
    doc.text(meeting.date || 'N/A', margin + 35, cursorY)
    cursorY += 8

    doc.setFont('helvetica', 'bold')
    doc.text('Meeting Duration:', margin, cursorY)
    doc.setFont('helvetica', 'normal')
    doc.text(meeting.duration || 'N/A', margin + 35, cursorY)
    cursorY += 12

    // Divider Line
    doc.line(margin, cursorY, 210 - margin, cursorY)
    cursorY += 12

    // Table Header
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(15, 23, 42)
    doc.text('Participant Name', margin, cursorY)
    doc.text('Participant Duration', margin + 65, cursorY)
    doc.text('Attendance %', margin + 115, cursorY)
    doc.text('Status', margin + 155, cursorY)
    cursorY += 6

    doc.setDrawColor(200, 200, 200)
    doc.line(margin, cursorY, 210 - margin, cursorY)
    cursorY += 10

    // Table Rows
    doc.setFont('helvetica', 'normal')
    records.forEach((rec) => {
      if (cursorY + lineSpacing > pageHeight - margin - 20) {
        doc.addPage()
        cursorY = margin
        // Repeat header
        doc.setFont('helvetica', 'bold')
        doc.text('Participant Name', margin, cursorY)
        doc.text('Participant Duration', margin + 65, cursorY)
        doc.text('Attendance %', margin + 115, cursorY)
        doc.text('Status', margin + 155, cursorY)
        cursorY += 6
        doc.line(margin, cursorY, 210 - margin, cursorY)
        cursorY += 10
        doc.setFont('helvetica', 'normal')
      }

      const participantSec = rec.participant_duration_seconds != null
        ? rec.participant_duration_seconds
        : (rec.presence_seconds != null ? rec.presence_seconds : 0)
      const durationFormatted = rec.participant_duration_formatted || formatDuration(participantSec)

      const isPresent = rec.status === 'Present'
      doc.setTextColor(51, 65, 85)
      doc.text(rec.participant_name || 'Anonymous', margin, cursorY)
      doc.text(durationFormatted, margin + 65, cursorY)
      const formattedPct = typeof rec.attendance_percentage === 'number'
        ? (rec.attendance_percentage % 1 === 0 ? `${rec.attendance_percentage}%` : `${Number(rec.attendance_percentage).toFixed(2)}%`)
        : `${rec.attendance_percentage}%`
      doc.text(formattedPct, margin + 115, cursorY)

      if (isPresent) {
        doc.setTextColor(16, 185, 129)
      } else {
        doc.setTextColor(239, 68, 68)
      }
      doc.text(rec.status, margin + 155, cursorY)

      cursorY += 8
    })

    doc.setTextColor(51, 65, 85)
    cursorY += 5
    if (cursorY + 15 > pageHeight - margin) {
      doc.addPage()
      cursorY = margin
    }
    doc.setDrawColor(226, 232, 240)
    doc.line(margin, cursorY, 210 - margin, cursorY)
    cursorY += 10

    doc.setFont('helvetica', 'italic')
    doc.setFontSize(9)
    doc.setTextColor(148, 163, 184)
    doc.text('Generated by Meetly AI', margin, cursorY)

    const safeTitle = (meeting.name || 'attendance').toLowerCase().replace(/[^a-z0-9]+/g, '_')
    doc.save(`meetly_attendance_${safeTitle}.pdf`)
    showToast('AI Attendance Report downloaded successfully.', 'success')
  }

  if (!meeting || !isOwner) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
        <span className="text-sm font-semibold text-gray-400">Meeting report not found or access denied</span>
        <button onClick={() => navigate('/')} className="text-brand-purple hover:underline text-xs font-semibold">
          Return to dashboard
        </button>
      </div>
    )
  }

  // Filter transcript
  const filteredTranscript = (meeting.transcript || []).filter(t =>
    (t.speaker || '').toLowerCase().includes(searchTranscript.toLowerCase()) ||
    (t.text || '').toLowerCase().includes(searchTranscript.toLowerCase())
  )

  const tabs = [
    { id: 'attendance', label: 'Attendance', icon: Users },
    { id: 'focus', label: 'Focus & Engagement', icon: Brain },
    { id: 'summary', label: 'AI Summary', icon: FileText },
    { id: 'transcript', label: 'Transcript', icon: MessageSquare },
    { id: 'recording', label: 'Recording', icon: Play }
  ]

  // Calculated attendance metrics from real attendance records
  const attendeeCount = attendanceRecords ? attendanceRecords.length : (meeting.participants?.length || 0)
  const avgAttendanceRatio = attendanceRecords && attendanceRecords.length > 0
    ? `${(attendanceRecords.reduce((sum, r) => sum + (Number(r.attendance_percentage) || 0), 0) / attendanceRecords.length).toFixed(1)}%`
    : (meeting.attendance || 'N/A')

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
            {/* Header & Export Action */}
            <div className="flex items-center justify-between pb-3 border-b border-white/5">
              <div className="flex flex-col">
                <span className="text-sm font-bold text-white tracking-wide flex items-center gap-2">
                  <Users size={16} className="text-brand-purple" />
                  AI Attendance Report
                </span>
                <span className="text-[11px] text-gray-500">
                  Individual participant presence verified against total meeting duration.
                </span>
              </div>
              {attendanceRecords && attendanceRecords.length > 0 && (
                <button
                  onClick={handleDownloadAttendancePDF}
                  className="px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30 rounded-xl text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5"
                >
                  <Download size={14} />
                  <span>Download Attendance PDF</span>
                </button>
              )}
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-white/2 border border-white/3 p-4.5 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-brand-purple-light flex items-center justify-center text-brand-purple shrink-0">
                  <Users size={18} />
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Total Participants</span>
                  <span className="text-base font-bold text-white">{attendeeCount} {attendeeCount === 1 ? 'Attendee' : 'Attendees'}</span>
                </div>
              </div>

              <div className="bg-white/2 border border-white/3 p-4.5 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 shrink-0">
                  <CheckCircle size={18} />
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Attendance Ratio</span>
                  <span className="text-base font-bold text-white">{avgAttendanceRatio}</span>
                </div>
              </div>

              <div className="bg-white/2 border border-white/3 p-4.5 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0">
                  <Clock size={18} />
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Meeting Duration</span>
                  <span className="text-base font-bold text-white">{meeting.duration || 'N/A'}</span>
                </div>
              </div>
            </div>

            {/* Attendance Table */}
            <div className="overflow-x-auto w-full">
              {isLoadingAttendance ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3 text-gray-400">
                  <div className="w-8 h-8 rounded-full border-2 border-brand-purple border-t-transparent animate-spin" />
                  <span className="text-xs font-semibold">Loading attendance logs...</span>
                </div>
              ) : attendanceRecords && attendanceRecords.length > 0 ? (
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/5 text-gray-500 font-bold uppercase tracking-wider">
                      <th className="pb-3 pl-2">Participant Name</th>
                      <th className="pb-3">Participant Duration</th>
                      <th className="pb-3">Attendance %</th>
                      <th className="pb-3 pr-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/2">
                    {attendanceRecords.map((rec, idx) => {
                      const participantSec = rec.participant_duration_seconds != null
                        ? rec.participant_duration_seconds
                        : (rec.presence_seconds != null ? rec.presence_seconds : 0)
                      const durFormatted = rec.participant_duration_formatted || formatDuration(participantSec)
                      const pctFormatted = typeof rec.attendance_percentage === 'number'
                        ? (rec.attendance_percentage % 1 === 0 ? `${rec.attendance_percentage}%` : `${Number(rec.attendance_percentage).toFixed(2)}%`)
                        : `${rec.attendance_percentage}%`
                      const isPresent = rec.status === 'Present'

                      return (
                        <tr key={rec.id || idx} className="text-gray-300">
                          <td className="py-3 pl-2 font-semibold text-white">{rec.participant_name || 'Anonymous User'}</td>
                          <td className="py-3 font-medium text-purple-300">{durFormatted}</td>
                          <td className="py-3 font-medium text-gray-300">{pctFormatted}</td>
                          <td className={`py-3 pr-2 font-semibold ${isPresent ? 'text-emerald-400' : 'text-red-400'}`}>
                            {rec.status}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center gap-3 border border-dashed border-white/10 rounded-xl p-6 bg-white/2">
                  <Users size={28} className="text-gray-500" />
                  <span className="text-xs font-semibold text-gray-300">No attendance logs available</span>
                  <p className="text-[11px] text-gray-500 max-w-sm">
                    {attendanceError || 'No participants submitted AI Attendance verification for this meeting.'}
                  </p>
                </div>
              )}
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
                const meetingType = summaryData?.meetingType || ''
                const overview = typeof summaryData === 'string' ? summaryData : (summaryData.overview || 'No overview available.')
                const topics = Array.isArray(summaryData?.topicsDiscussed) ? summaryData.topicsDiscussed : []
                const keyPoints = Array.isArray(summaryData?.keyPoints) ? summaryData.keyPoints : []
                const decisions = Array.isArray(summaryData?.decisionsMade) ? summaryData.decisionsMade : []
                const actions = Array.isArray(summaryData?.actionItems) ? summaryData.actionItems : []

                // Educational hierarchy: normalize nodes[] or legacy concepts[]
                const nodes = Array.isArray(summaryData?.nodes)
                  ? summaryData.nodes
                  : Array.isArray(summaryData?.concepts)
                    ? summaryData.concepts.map(c => ({
                        ...c,
                        children: Array.isArray(c.children) ? c.children
                          : Array.isArray(c.subtypes) ? c.subtypes.map(s => ({ ...s, purpose: s.howAchieved || s.purpose || '', children: [] }))
                          : []
                      }))
                    : []

                // Programs (Complete Source Code & Code Explanation)
                const programs = Array.isArray(summaryData?.programs)
                  ? summaryData.programs.filter(p => p && p.sourceCode && String(p.sourceCode).trim().length > 0)
                  : (summaryData?.completeSourceCode && typeof summaryData.completeSourceCode === 'string' && summaryData.completeSourceCode.trim().length > 0)
                    ? [{
                        title: summaryData.programTitle || 'Complete Program',
                        language: summaryData.programLanguage || '',
                        sourceCode: summaryData.completeSourceCode,
                        explanation: summaryData.codeExplanation || ''
                      }]
                    : []

                // Recursive node renderer for the UI
                const renderSummaryNode = (node, depth, prefix) => {
                  const children = Array.isArray(node.children) ? node.children : []
                  const indentClass = depth === 0 ? 'pl-0' : depth === 1 ? 'pl-4' : depth === 2 ? 'pl-8' : 'pl-12'
                  const borderColors = [
                    'border-blue-500/50',
                    'border-purple-500/50',
                    'border-teal-500/50',
                    'border-amber-500/50',
                  ]
                  const headingColors = [
                    'text-blue-300',
                    'text-purple-300',
                    'text-teal-300',
                    'text-amber-300',
                  ]
                  const borderColor = borderColors[Math.min(depth, borderColors.length - 1)]
                  const headingColor = headingColors[Math.min(depth, headingColors.length - 1)]
                  const fontSize = depth === 0 ? 'text-[13px]' : depth === 1 ? 'text-[12px]' : 'text-[11px]'
                  const hasContent = (s) => s && typeof s === 'string' && s.trim().length > 0

                  return (
                    <div key={`${prefix}-${depth}`} className={`flex flex-col gap-1.5 ${indentClass} border-l-2 ${borderColor} pl-3`}>
                      {/* Node name heading */}
                      <span className={`font-bold ${headingColor} ${fontSize}`}>{prefix}. {node.name}</span>

                      {/* Fields — only shown when non-empty */}
                      {hasContent(node.definition) && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Definition</span>
                          <p className="text-gray-200 text-[11px] leading-relaxed">{node.definition}</p>
                        </div>
                      )}
                      {hasContent(node.explanation) && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Explanation</span>
                          <p className="text-gray-300 text-[11px] leading-relaxed">{node.explanation}</p>
                        </div>
                      )}
                      {hasContent(node.purpose) && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Purpose / How it is achieved</span>
                          <p className="text-gray-300 text-[11px] leading-relaxed">{node.purpose}</p>
                        </div>
                      )}
                      {Array.isArray(node.characteristics) && node.characteristics.length > 0 && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Characteristics</span>
                          <ul className="flex flex-col gap-0.5">
                            {node.characteristics.map((ch, i) => (
                              <li key={i} className="text-gray-300 text-[11px] flex items-start gap-1.5">
                                <span className="text-purple-400 font-bold shrink-0">•</span>{ch}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {hasContent(node.example) && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Example</span>
                          <p className="text-gray-300 text-[11px] leading-relaxed italic">{node.example}</p>
                        </div>
                      )}
                      {hasContent(node.analogy) && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Analogy</span>
                          <p className="text-gray-300 text-[11px] leading-relaxed italic">{node.analogy}</p>
                        </div>
                      )}
                      {hasContent(node.codeExample) && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Code Example</span>
                          <pre className="text-[10px] bg-slate-900/60 border border-white/5 rounded-lg p-2 overflow-x-auto text-green-300 font-mono leading-relaxed whitespace-pre-wrap">{node.codeExample}</pre>
                        </div>
                      )}
                      {Array.isArray(node.importantPoints) && node.importantPoints.length > 0 && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Important Points</span>
                          <ul className="flex flex-col gap-0.5">
                            {node.importantPoints.map((pt, i) => (
                              <li key={i} className="text-gray-300 text-[11px] flex items-start gap-1.5">
                                <span className="text-amber-400 font-bold shrink-0">!</span>{pt}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Recursively render children */}
                      {children.length > 0 && (
                        <div className="flex flex-col gap-3 mt-1">
                          {children.map((child, ci) => renderSummaryNode(child, depth + 1, `${prefix}.${ci + 1}`))}
                        </div>
                      )}
                    </div>
                  )
                }

                return (
                  <div className="flex flex-col gap-6">
                    {/* Header Action Bar */}
                    <div className="flex items-center justify-between pb-3 border-b border-white/5">
                      <h2 className="text-sm font-bold text-white tracking-wide flex items-center gap-2">
                        <FileText size={16} className="text-brand-purple" />
                        AI Meeting Summary
                        {meetingType && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-purple-900/40 border border-purple-500/30 text-purple-300">
                            {meetingType}
                          </span>
                        )}
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

                    {/* Educational concept tree — only shown for Educational/Lecture type */}
                    {meetingType === 'Educational / Lecture' && nodes.length > 0 && (
                      <div className="flex flex-col gap-4 p-4 bg-white/2 border border-white/5 rounded-2xl">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-brand-purple">2. Concepts &amp; Hierarchy</h3>
                        <div className="flex flex-col gap-5">
                          {nodes.map((node, idx) => (
                            <div key={idx} className="flex flex-col gap-2 p-3 bg-blue-950/20 border border-blue-500/10 rounded-xl">
                              {renderSummaryNode(node, 0, String(idx + 1))}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 2/3. Topics Discussed */}
                    <div className="flex flex-col gap-3 p-4 bg-white/2 border border-white/5 rounded-2xl">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-brand-purple">
                        {meetingType === 'Educational / Lecture' ? '3. Topics Discussed' : '2. Topics Discussed'}
                      </h3>
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

                    {/* Key Points */}
                    <div className="flex flex-col gap-3 p-4 bg-white/2 border border-white/5 rounded-2xl">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-brand-purple">
                        {meetingType === 'Educational / Lecture' ? '4. Key Takeaways' : '3. Key Points'}
                      </h3>
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

                    {/* Complete Source Code (only when programming code is present) */}
                    {programs.length > 0 && (
                      <div className="flex flex-col gap-4 p-4 bg-white/2 border border-white/5 rounded-2xl">
                        <div className="flex items-center justify-between">
                          <h3 className="text-xs font-bold uppercase tracking-wider text-brand-purple">
                            {meetingType === 'Educational / Lecture' ? '5. Complete Source Code' : 'Complete Source Code'}
                          </h3>
                          <span className="text-[10px] text-gray-400 font-medium">
                            {programs.length} {programs.length === 1 ? 'Program' : 'Programs'}
                          </span>
                        </div>
                        <div className="flex flex-col gap-5">
                          {programs.map((prog, pIdx) => (
                            <div key={pIdx} className="flex flex-col gap-2 p-3.5 bg-slate-950/80 border border-white/10 rounded-xl">
                              <div className="flex items-center justify-between pb-2 border-b border-white/5">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-bold text-white">
                                    {programs.length > 1 ? `${pIdx + 1}. ` : ''}{prog.title || 'Complete Program'}
                                  </span>
                                  {prog.language && (
                                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-900/40 border border-blue-500/30 text-blue-300 uppercase tracking-wider font-mono">
                                      {prog.language}
                                    </span>
                                  )}
                                </div>
                                <button
                                  onClick={() => handleCopyProgram(prog.sourceCode, pIdx)}
                                  className="px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-[11px] font-semibold text-gray-300 hover:text-white transition-all flex items-center gap-1.5 cursor-pointer"
                                  title="Copy complete source code"
                                >
                                  {copiedProgramIdx === pIdx ? (
                                    <>
                                      <Check size={12} className="text-emerald-400" />
                                      <span className="text-emerald-400">Copied!</span>
                                    </>
                                  ) : (
                                    <>
                                      <Copy size={12} />
                                      <span>Copy Code</span>
                                    </>
                                  )}
                                </button>
                              </div>
                              <pre className="text-[11px] p-3 overflow-x-auto text-green-300 font-mono leading-relaxed whitespace-pre selection:bg-purple-900/50">
                                <code>{prog.sourceCode}</code>
                              </pre>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Code Explanation (immediately follows Complete Source Code) */}
                    {programs.length > 0 && programs.some(p => p.explanation && p.explanation.trim()) && (
                      <div className="flex flex-col gap-4 p-4 bg-white/2 border border-white/5 rounded-2xl">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-brand-purple">
                          {meetingType === 'Educational / Lecture' ? '6. Code Explanation' : 'Code Explanation'}
                        </h3>
                        <div className="flex flex-col gap-4">
                          {programs.map((prog, pIdx) => {
                            if (!prog.explanation || !prog.explanation.trim()) return null
                            return (
                              <div key={pIdx} className="flex flex-col gap-2 pl-3 border-l-2 border-brand-purple/50">
                                {programs.length > 1 && (
                                  <span className="text-xs font-bold text-purple-300">
                                    Explanation for: {prog.title || `Program ${pIdx + 1}`}
                                  </span>
                                )}
                                <p className="text-gray-200 text-xs leading-relaxed whitespace-pre-line font-medium">
                                  {prog.explanation}
                                </p>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {/* Decisions Made */}
                    <div className="flex flex-col gap-3 p-4 bg-white/2 border border-white/5 rounded-2xl">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-brand-purple">
                        {meetingType === 'Educational / Lecture' ? (programs.length > 0 ? '7. Decisions Made' : '5. Decisions Made') : '4. Decisions Made'}
                      </h3>
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

                    {/* Action Items */}
                    <div className="flex flex-col gap-3 p-4 bg-white/2 border border-white/5 rounded-2xl">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-brand-purple">
                        {meetingType === 'Educational / Lecture' ? (programs.length > 0 ? '8. Action Items' : '6. Action Items') : '5. Action Items'}
                      </h3>
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
                              <span className="text-gray-200 font-medium">{typeof a === 'string' ? a : a.task}</span>
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

        {/* PANEL: REAL RECORDING */}
        {activeTab === 'recording' && (
          <div className="flex flex-col gap-4 max-w-3xl">
            {isLoadingRecording ? (
              <div className="aspect-video bg-slate-950 border border-white/5 rounded-2xl flex flex-col items-center justify-center gap-3">
                <div className="w-8 h-8 rounded-full border-2 border-brand-purple border-t-transparent animate-spin" />
                <span className="text-xs text-gray-400 font-medium">Checking recording status...</span>
              </div>
            ) : recordingInfo && recordingInfo.status === 'ready' ? (
              <>
                <div className="aspect-video bg-black border border-white/5 rounded-2xl relative overflow-hidden flex flex-col items-center justify-center shadow-2xl group">
                  {isPlayingRecording && recordingStreamUrl ? (
                    <video
                      src={recordingStreamUrl}
                      controls
                      autoPlay
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-[#090b14]/70 backdrop-blur-xs flex flex-col items-center justify-center gap-3 select-none">
                      <button
                        onClick={handlePlayRecording}
                        className="w-16 h-16 rounded-full bg-brand-purple hover:bg-brand-purple-hover text-white flex items-center justify-center transition-all duration-200 shadow-xl shadow-brand-purple/20 cursor-pointer transform hover:scale-105"
                      >
                        <Play size={24} className="fill-white ml-1" />
                      </button>
                      <span className="text-xs font-bold text-gray-200">Play Meeting Recording</span>
                      <span className="text-[11px] text-gray-400">
                        {Math.floor(recordingInfo.durationSeconds / 60)} min {recordingInfo.durationSeconds % 60} sec • {(recordingInfo.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB
                      </span>
                    </div>
                  )}
                </div>

                {/* Video metadata and download controls */}
                <div className="flex items-center justify-between p-3.5 bg-white/2 border border-white/5 rounded-xl text-xs font-semibold">
                  <div className="flex items-center gap-3 text-gray-400">
                    <PlayCircle size={18} className="text-brand-purple" />
                    <span>Meetly-{recordingInfo.meetingCode}-Recording.{recordingInfo.mimeType?.includes('mp4') ? 'mp4' : 'webm'}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {recordingInfo.canDownload && (
                      <button
                        onClick={handleDownloadRecording}
                        disabled={isDownloadingRecording}
                        className="px-3.5 py-1.5 bg-brand-purple/20 hover:bg-brand-purple/30 text-[#c084fc] hover:text-[#d8b4fe] border border-brand-purple/30 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        <Download size={13} />
                        <span>{isDownloadingRecording ? 'Downloading...' : 'Download'}</span>
                      </button>
                    )}
                  </div>
                </div>
              </>
            ) : recordingInfo && ['starting', 'recording', 'finalizing'].includes(recordingInfo.status) ? (
              <div className="aspect-video bg-slate-950 border border-white/5 rounded-2xl flex flex-col items-center justify-center gap-3 p-6 text-center">
                <Clock size={28} className="text-yellow-400 animate-pulse" />
                <span className="text-xs font-bold text-gray-200">Recording In Progress or Finalizing</span>
                <p className="text-xs text-gray-400 max-w-sm">
                  This recording session is currently being processed and assembled on secure storage. Please check back in a few moments.
                </p>
              </div>
            ) : (
              <div className="aspect-video bg-slate-950 border border-white/5 rounded-2xl flex flex-col items-center justify-center gap-3 p-6 text-center">
                <AlertTriangle size={28} className="text-gray-500" />
                <span className="text-xs font-bold text-gray-300">No Recording Available</span>
                <p className="text-xs text-gray-500 max-w-sm">
                  {recordingError || 'A screen recording was not captured for this meeting or has passed the 30-day retention window.'}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
