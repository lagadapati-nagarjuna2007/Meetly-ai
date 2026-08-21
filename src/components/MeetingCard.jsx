import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Calendar, User, BarChart2, MoreVertical, Video, Trash2, Sparkles } from 'lucide-react'
import { useMeetings } from '../context/MeetingContext'
import { useToast } from './Toast'
import Modal from './Modal'
import Button from './Button'
import { jsPDF } from 'jspdf'

export default function MeetingCard({ meeting, index = 0, onDeleted }) {
  const navigate = useNavigate()
  const { deleteMeeting, generateMeetingSummary, getAttendanceReport, clearAttendanceRecords } = useMeetings()
  const { showToast } = useToast()

  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false)
  const [isGeneratingAttendance, setIsGeneratingAttendance] = useState(false)

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

  const handleGenerateSummary = async () => {
    setIsGeneratingPdf(true)
    showToast('Generating meeting summary, please wait...', 'info')
    try {
      const summaryData = await generateMeetingSummary(meeting.dbId)

      let summaryObj = summaryData
      if (typeof summaryObj === 'string') {
        try {
          summaryObj = JSON.parse(summaryObj)
        } catch (e) {
          summaryObj = { overview: summaryData, topicsDiscussed: [], keyPoints: [], decisionsMade: [], actionItems: [] }
        }
      }

      const overviewText = summaryObj.overview || 'No overview available.'
      const topics = Array.isArray(summaryObj.topicsDiscussed) ? summaryObj.topicsDiscussed : []
      const keyPoints = Array.isArray(summaryObj.keyPoints) ? summaryObj.keyPoints : []
      const decisions = Array.isArray(summaryObj.decisionsMade) ? summaryObj.decisionsMade : []
      const actions = Array.isArray(summaryObj.actionItems) ? summaryObj.actionItems : []

      // Generate PDF
      const doc = new jsPDF()
      const pageHeight = doc.internal.pageSize.height
      const margin = 20
      let cursorY = 20

      const checkOverflow = (needed = 7) => {
        if (cursorY + needed > pageHeight - margin) {
          doc.addPage()
          cursorY = margin
        }
      }

      // MEETLY AI Header
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(22)
      doc.setTextColor(124, 58, 237) // purple color #7c3aed
      doc.text('MEETLY AI', margin, cursorY)
      cursorY += 9

      doc.setFontSize(13)
      doc.setTextColor(100, 116, 139) // Slate gray #64748b
      doc.text('AI Meeting Summary Report', margin, cursorY)
      cursorY += 8

      // Divider Line
      doc.setDrawColor(226, 232, 240)
      doc.setLineWidth(0.5)
      doc.line(margin, cursorY, 210 - margin, cursorY)
      cursorY += 10

      // Metadata Block
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10)
      doc.setTextColor(71, 85, 105)
      doc.text('Meeting Name:', margin, cursorY)
      doc.setFont('helvetica', 'normal')
      doc.text(meeting.name || 'Untitled Meeting', margin + 30, cursorY)
      cursorY += 7

      doc.setFont('helvetica', 'bold')
      doc.text('Meeting Date:', margin, cursorY)
      doc.setFont('helvetica', 'normal')
      doc.text(meeting.date || 'N/A', margin + 30, cursorY)
      cursorY += 7

      doc.setFont('helvetica', 'bold')
      doc.text('Duration:', margin, cursorY)
      doc.setFont('helvetica', 'normal')
      doc.text(meeting.duration || 'N/A', margin + 30, cursorY)
      cursorY += 10

      // Divider Line
      doc.line(margin, cursorY, 210 - margin, cursorY)
      cursorY += 10

      // 1. Overview
      checkOverflow(15)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(11)
      doc.setTextColor(15, 23, 42)
      doc.text('1. Overview', margin, cursorY)
      cursorY += 6

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9.5)
      doc.setTextColor(51, 65, 85)
      const overviewLines = doc.splitTextToSize(overviewText, 210 - margin * 2)
      overviewLines.forEach((line) => {
        checkOverflow(6)
        doc.text(line, margin, cursorY)
        cursorY += 5.5
      })
      cursorY += 6

      // 2. Topics Discussed
      checkOverflow(15)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(11)
      doc.setTextColor(15, 23, 42)
      doc.text('2. Topics Discussed', margin, cursorY)
      cursorY += 6

      if (topics.length === 0) {
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9.5)
        doc.setTextColor(100, 116, 139)
        doc.text('None identified.', margin, cursorY)
        cursorY += 6
      } else {
        topics.forEach((t) => {
          checkOverflow(12)
          doc.setFont('helvetica', 'bold')
          doc.setFontSize(9.5)
          doc.setTextColor(15, 23, 42)
          doc.text(`• ${t.title}`, margin, cursorY)
          cursorY += 5
          if (t.description) {
            doc.setFont('helvetica', 'normal')
            doc.setTextColor(51, 65, 85)
            const descLines = doc.splitTextToSize(t.description, 210 - margin * 2 - 6)
            descLines.forEach((l) => {
              checkOverflow(5.5)
              doc.text(l, margin + 5, cursorY)
              cursorY += 5
            })
          }
          cursorY += 2
        })
      }
      cursorY += 4

      // 3. Key Points
      checkOverflow(15)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(11)
      doc.setTextColor(15, 23, 42)
      doc.text('3. Key Points', margin, cursorY)
      cursorY += 6

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9.5)
      doc.setTextColor(51, 65, 85)
      if (keyPoints.length === 0) {
        doc.setTextColor(100, 116, 139)
        doc.text('None identified.', margin, cursorY)
        cursorY += 6
      } else {
        keyPoints.forEach((kp) => {
          const kpLines = doc.splitTextToSize(`• ${kp}`, 210 - margin * 2)
          kpLines.forEach((l) => {
            checkOverflow(5.5)
            doc.text(l, margin, cursorY)
            cursorY += 5
          })
          cursorY += 1.5
        })
      }
      cursorY += 4

      // 4. Decisions Made
      checkOverflow(15)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(11)
      doc.setTextColor(15, 23, 42)
      doc.text('4. Decisions Made', margin, cursorY)
      cursorY += 6

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9.5)
      if (decisions.length === 0) {
        doc.setTextColor(100, 116, 139)
        doc.text('None identified.', margin, cursorY)
        cursorY += 6
      } else {
        doc.setTextColor(51, 65, 85)
        decisions.forEach((d) => {
          const dLines = doc.splitTextToSize(`• ${d}`, 210 - margin * 2)
          dLines.forEach((l) => {
            checkOverflow(5.5)
            doc.text(l, margin, cursorY)
            cursorY += 5
          })
          cursorY += 1.5
        })
      }
      cursorY += 4

      // 5. Action Items
      checkOverflow(15)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(11)
      doc.setTextColor(15, 23, 42)
      doc.text('5. Action Items', margin, cursorY)
      cursorY += 6

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9.5)
      if (actions.length === 0) {
        doc.setTextColor(100, 116, 139)
        doc.text('None identified.', margin, cursorY)
        cursorY += 6
      } else {
        doc.setTextColor(51, 65, 85)
        actions.forEach((a) => {
          const itemText = a.assignee ? `• ${a.assignee} → ${a.task}` : `• ${a.task}`
          const aLines = doc.splitTextToSize(itemText, 210 - margin * 2)
          aLines.forEach((l) => {
            checkOverflow(5.5)
            doc.text(l, margin, cursorY)
            cursorY += 5
          })
          cursorY += 1.5
        })
      }
      cursorY += 8

      // Footer divider
      checkOverflow(12)
      doc.setDrawColor(226, 232, 240)
      doc.line(margin, cursorY, 210 - margin, cursorY)
      cursorY += 8

      // Footer Note
      doc.setFont('helvetica', 'italic')
      doc.setFontSize(9)
      doc.setTextColor(148, 163, 184)
      doc.text('Generated by Meetly AI Platform', margin, cursorY)

      // Download file automatically
      const safeTitle = (meeting.name || 'meeting').toLowerCase().replace(/[^a-z0-9]+/g, '_')
      doc.save(`meetly_summary_${safeTitle}.pdf`)
      showToast('Meeting summary downloaded successfully.', 'success')
    } catch (err) {
      console.error('[Summary Generate Error]:', err)
      const isNoTranscript = err.message && err.message.includes('No transcript available')
      const msg = isNoTranscript
        ? 'No transcript available. AI Analyzer was disabled or transcript capture failed.'
        : 'Unable to generate meeting summary. Please try again.'
      showToast(msg, 'error')
    } finally {
      setIsGeneratingPdf(false)
    }
  }

  const handleGenerateAttendanceReport = async () => {
    setDropdownOpen(false)
    setIsGeneratingAttendance(true)
    showToast('Generating AI Attendance Report...', 'info')
    try {
      // 1. Retrieve records
      const records = await getAttendanceReport(meeting.dbId)
      if (!records || records.length === 0) {
        showToast('No attendance records found for this meeting.', 'warning')
        setIsGeneratingAttendance(false)
        return
      }

      // 2. Generate PDF using jsPDF
      const doc = new jsPDF()
      const pageHeight = doc.internal.pageSize.height
      const margin = 20
      const lineSpacing = 7
      let cursorY = 20

      // MEETLY AI Header
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(22)
      doc.setTextColor(124, 58, 237) // purple #7c3aed
      doc.text('MEETLY AI', margin, cursorY)
      cursorY += 10

      doc.setFontSize(14)
      doc.setTextColor(100, 116, 139) // Slate gray #64748b
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
      doc.text(meeting.name || 'Untitled Meeting', margin + 30, cursorY)
      cursorY += 8

      doc.setFont('helvetica', 'bold')
      doc.text('Meeting Date:', margin, cursorY)
      doc.setFont('helvetica', 'normal')
      doc.text(meeting.date || 'N/A', margin + 30, cursorY)
      cursorY += 8

      doc.setFont('helvetica', 'bold')
      doc.text('Duration:', margin, cursorY)
      doc.setFont('helvetica', 'normal')
      doc.text(meeting.duration || 'N/A', margin + 30, cursorY)
      cursorY += 12

      // Divider Line
      doc.line(margin, cursorY, 210 - margin, cursorY)
      cursorY += 12

      // Table Header
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10)
      doc.setTextColor(15, 23, 42)
      doc.text('Participant Name', margin, cursorY)
      doc.text('Meeting Duration', margin + 60, cursorY)
      doc.text('Attendance %', margin + 110, cursorY)
      doc.text('Status', margin + 145, cursorY)
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
          doc.text('Meeting Duration', margin + 60, cursorY)
          doc.text('Attendance %', margin + 110, cursorY)
          doc.text('Status', margin + 145, cursorY)
          cursorY += 6
          doc.line(margin, cursorY, 210 - margin, cursorY)
          cursorY += 10
          doc.setFont('helvetica', 'normal')
        }

        const durationFormatted = rec.meeting_duration_seconds >= 60 
          ? `${Math.floor(rec.meeting_duration_seconds / 60)}m ${rec.meeting_duration_seconds % 60}s`
          : `${rec.meeting_duration_seconds}s`

        console.log('[Attendance PDF Data]')
        console.log(`  participant=${rec.participant_name}`)
        console.log(`  presence_seconds=${rec.presence_seconds}`)
        console.log(`  meeting_duration_seconds=${rec.meeting_duration_seconds}`)
        console.log(`  attendance_percentage=${rec.attendance_percentage}`)
        console.log(`  status=${rec.status}`)

        // Color status green if Present, red if Absent
        const isPresent = rec.status === 'Present'
        doc.setTextColor(51, 65, 85) // Reset color to slate-700
        doc.text(rec.participant_name || 'Anonymous', margin, cursorY)
        doc.text(durationFormatted, margin + 60, cursorY)
        const formattedPct = typeof rec.attendance_percentage === 'number'
          ? (rec.attendance_percentage % 1 === 0 ? `${rec.attendance_percentage}%` : `${Number(rec.attendance_percentage).toFixed(2)}%`)
          : `${rec.attendance_percentage}%`
        doc.text(formattedPct, margin + 110, cursorY)
        
        if (isPresent) {
          doc.setTextColor(16, 185, 129) // emerald-500 #10b981
        } else {
          doc.setTextColor(239, 68, 68) // red-500 #ef4444
        }
        doc.text(rec.status, margin + 145, cursorY)
        
        cursorY += 8
      })

      // Reset text color
      doc.setTextColor(51, 65, 85)

      // Footer divider
      cursorY += 5
      if (cursorY + 15 > pageHeight - margin) {
        doc.addPage()
        cursorY = margin
      }
      doc.setDrawColor(226, 232, 240)
      doc.line(margin, cursorY, 210 - margin, cursorY)
      cursorY += 10

      // Footer Note
      doc.setFont('helvetica', 'italic')
      doc.setFontSize(9)
      doc.setTextColor(148, 163, 184)
      doc.text('Generated by Meetly AI', margin, cursorY)

      // 3. Trigger Download
      const safeTitle = (meeting.name || 'attendance').toLowerCase().replace(/[^a-z0-9]+/g, '_')
      doc.save(`meetly_attendance_${safeTitle}.pdf`)
      showToast('AI Attendance Report downloaded successfully.', 'success')

      // 4. Safe Generation Sequence: Delete records ONLY after successful PDF download
      try {
        await clearAttendanceRecords(meeting.dbId)
        console.log('[Attendance] Temp DB records cleared post-generation successfully')
      } catch (delErr) {
        console.error('[Attendance Error] Failed to delete records post-generation:', delErr)
      }
    } catch (err) {
      console.error('[Attendance Report Error]:', err)
      showToast('Failed to retrieve or generate AI Attendance Report. Please try again.', 'error')
    } finally {
      setIsGeneratingAttendance(false)
    }
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteMeeting(meeting.dbId)
      showToast('Meeting deleted successfully.', 'success')
      setIsDeleteConfirmOpen(false)
      if (onDeleted) {
        onDeleted(meeting.dbId)
      }
    } catch (err) {
      console.error('[Delete Error]:', err)
      showToast(err.message || 'Failed to delete meeting.', 'error')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
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
          <div className="relative">
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="text-gray-600 hover:text-white p-1 rounded-lg hover:bg-white/5 transition-all duration-200 cursor-pointer"
            >
              <MoreVertical size={15} />
            </button>

            {dropdownOpen && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setDropdownOpen(false)}
                />
                <div className="absolute right-0 mt-1 w-40 rounded-xl bg-slate-900 border border-white/10 shadow-lg py-1 z-40 text-left">
                  {meeting.enableAiAnalyzer && (
                    <button
                      onClick={handleGenerateSummary}
                      disabled={isGeneratingPdf}
                      className="w-full text-left px-4 py-2.5 text-xs font-semibold text-[#c084fc] hover:text-[#d8b4fe] hover:bg-white/5 flex items-center gap-2 cursor-pointer transition-all duration-200 disabled:opacity-50 border-b border-white/5"
                    >
                      <Sparkles size={13} className="opacity-80" />
                      <span>{isGeneratingPdf ? 'Generating Summary...' : 'Generate Summary'}</span>
                    </button>
                  )}
                  {meeting.enableAiAttendance && (
                    <button
                      onClick={handleGenerateAttendanceReport}
                      disabled={isGeneratingAttendance}
                      className="w-full text-left px-4 py-2.5 text-xs font-semibold text-[#34d399] hover:text-[#6ee7b7] hover:bg-white/5 flex items-center gap-2 cursor-pointer transition-all duration-200 disabled:opacity-50 border-b border-white/5"
                    >
                      <BarChart2 size={13} className="opacity-80" />
                      <span>{isGeneratingAttendance ? 'Generating Report...' : 'Generate Report'}</span>
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setDropdownOpen(false)
                      setIsDeleteConfirmOpen(true)
                    }}
                    className="w-full text-left px-4 py-2.5 text-xs font-semibold text-red-400 hover:text-red-300 hover:bg-white/5 flex items-center gap-2 cursor-pointer transition-all duration-200"
                  >
                    <Trash2 size={13} className="opacity-80" />
                    <span>Delete Meeting</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <Modal
        isOpen={isDeleteConfirmOpen}
        onClose={() => setIsDeleteConfirmOpen(false)}
        title="Delete Meeting?"
      >
        <div className="flex flex-col gap-4 text-left">
          <p className="text-xs text-gray-400 leading-relaxed font-medium">
            Are you sure you want to permanently delete this meeting?
            <br />
            This action cannot be undone.
          </p>
          <div className="flex justify-end gap-3 mt-2">
            <button
              onClick={() => setIsDeleteConfirmOpen(false)}
              className="px-4 py-2.5 border border-white/5 hover:border-white/10 bg-white/2 hover:bg-white/5 text-gray-300 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer"
            >
              Cancel
            </button>
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={isDeleting}
              className="px-5 py-2.5 rounded-xl text-xs font-semibold"
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
