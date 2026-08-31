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
        try { summaryObj = JSON.parse(summaryObj) }
        catch (e) { summaryObj = { overview: summaryData, topicsDiscussed: [], keyPoints: [], decisionsMade: [], actionItems: [] } }
      }

      const meetingType  = summaryObj.meetingType  || 'General Discussion'
      const overviewText = summaryObj.overview     || 'No overview available.'
      const concepts     = Array.isArray(summaryObj.concepts)       ? summaryObj.concepts       : []
      const topics       = Array.isArray(summaryObj.topicsDiscussed)? summaryObj.topicsDiscussed: []
      const keyPoints    = Array.isArray(summaryObj.keyPoints)      ? summaryObj.keyPoints      : []
      const decisions    = Array.isArray(summaryObj.decisionsMade)  ? summaryObj.decisionsMade  : []
      const actions      = Array.isArray(summaryObj.actionItems)    ? summaryObj.actionItems    : []
      const techDetails  = Array.isArray(summaryObj.technicalDetails)? summaryObj.technicalDetails: []
      const issues       = Array.isArray(summaryObj.issuesDiscussed) ? summaryObj.issuesDiscussed: []
      const nextSteps    = Array.isArray(summaryObj.nextSteps)       ? summaryObj.nextSteps      : []
      const openQuestions= Array.isArray(summaryObj.openQuestions)   ? summaryObj.openQuestions  : []

      // ── Text sanitizer: normalize Unicode typographic chars to ASCII ─────────
      // jsPDF standard fonts use WinAnsi encoding (Latin-1). Characters such as
      // en-dash U+2013, em-dash U+2014, soft-hyphen U+00AD, non-breaking hyphen
      // U+2011, curly quotes, etc. either disappear or render as garbage glyphs.
      // AI models frequently output these instead of plain ASCII equivalents.
      const sanitize = (text) => {
        if (text == null) return ''
        return String(text)
          // ── Soft-hyphen (U+00AD) → visible ASCII hyphen
          // This is the #1 cause of "object oriented" instead of "object-oriented"
          .replace(/\u00AD/g, '-')
          // ── Unicode hyphen variants → ASCII hyphen
          .replace(/[\u2010\u2011\u2012\u2212\uFE58\uFE63\uFF0D]/g, '-')
          // ── Dashes → ASCII hyphen
          .replace(/[\u2013\u2014\u2015]/g, '-')
          // ── Smart/curly quotes → straight quotes
          .replace(/[\u2018\u2019\u02BC]/g, "'")
          .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
          // ── Ellipsis → three dots
          .replace(/\u2026/g, '...')
          // ── Bullet → ASCII asterisk (jsPDF WinAnsi cannot render U+2022)
          .replace(/\u2022/g, '*')
          // ── Arrows → ASCII equivalents
          .replace(/\u2192/g, '->').replace(/\u2190/g, '<-').replace(/\u2194/g, '<->')
          // ── Triangles → ASCII
          .replace(/[\u25B6\u25BA\u25B8]/g, '>')
          // ── Non-breaking / exotic spaces → regular space
          .replace(/[\u00A0\u202F\u2009\u2007\u2006\u2005\u2004\u2003\u2002\u2001\u2000]/g, ' ')
          // ── Strip remaining non-Latin-1 chars that jsPDF WinAnsi encoding cannot render
          // But first: preserve all printable Latin-1 (U+0020–U+00FF) and common control chars
          .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '')
          // ── Collapse multiple spaces
          .replace(/ {2,}/g, ' ')
          .trim()
      }

            // ── PDF setup ──────────────────────────────────────────────────────────
      const doc = new jsPDF()
      const PW       = doc.internal.pageSize.width   // 210 mm
      const PH       = doc.internal.pageSize.height  // 297 mm
      const margin   = 18
      const contentW = PW - margin * 2               // ~174 mm
      let   Y        = margin
      let   pageNum  = 1

      // Add page number footer to current page
      const stampPageNumber = () => {
        const prev = { r: doc.getTextColor(), size: doc.getFontSize(), font: doc.getFont() }
        doc.setFont('helvetica', 'italic')
        doc.setFontSize(8)
        doc.setTextColor(148, 163, 184)
        doc.text(`Page ${pageNum}`, PW - margin, PH - 8, { align: 'right' })
        doc.setFont(prev.font.fontName, prev.font.fontStyle)
        doc.setFontSize(prev.size)
        doc.setTextColor(51, 65, 85)
      }

      // Check overflow and add page if needed
      const need = (h) => {
        if (Y + h > PH - margin - 12) {
          stampPageNumber()
          doc.addPage()
          pageNum++
          Y = margin
          return true
        }
        return false
      }

      // Wrapped text helper — returns the new Y after printing
      const printWrapped = (text, x, startY, maxW, lineH, color = [51, 65, 85]) => {
        doc.setTextColor(...color)
        const lines = doc.splitTextToSize(String(text || ''), maxW)
        lines.forEach((line) => {
          need(lineH + 2)
          doc.text(line, x, Y)
          Y += lineH
        })
        return Y
      }

      // Section heading helper
      const sectionHeading = (num, title, topGap = 6) => {
        need(14)
        Y += topGap
        doc.setFillColor(245, 243, 255) // light purple tint
        doc.roundedRect(margin - 2, Y - 5, contentW + 4, 9, 1, 1, 'F')
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(11)
        doc.setTextColor(88, 28, 135) // purple-900
        doc.text(num ? `${num}. ${title}` : title, margin + 1, Y)
        Y += 6
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9.5)
        doc.setTextColor(51, 65, 85)
      }

      // Sub-heading helper (concept name inside educational)
      const conceptHeading = (title) => {
        const cleanTitle = sanitize(title)
        need(16)
        Y += 7
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(10.5)
        doc.setTextColor(15, 23, 42)
        doc.text(cleanTitle, margin, Y)
        Y += 1
        doc.setDrawColor(124, 58, 237)
        doc.setLineWidth(0.4)
        doc.line(margin, Y + 1, margin + doc.getTextWidth(cleanTitle) + 4, Y + 1)
        Y += 4
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9.5)
        doc.setLineWidth(0.5)
        doc.setDrawColor(226, 232, 240)
        doc.setTextColor(51, 65, 85)
      }

      // Field label + body block
      const fieldBlock = (label, text) => {
        if (!text || text.trim() === '') return
        need(10)
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(9)
        doc.setTextColor(71, 85, 105)
        doc.text(label, margin + 4, Y)
        Y += 4.5
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9.5)
        printWrapped(sanitize(text), margin + 4, Y, contentW - 4, 5.2)
        Y += 2
      }

      // Bullet list helper
      const bulletList = (items, indent = 4) => {
        items.forEach((item) => {
          const cleanItem = sanitize(item)
          const lines = doc.splitTextToSize('*  ' + cleanItem, contentW - indent)
          lines.forEach((line, i) => {
            need(5.5)
            doc.text(line, margin + (i === 0 ? indent : indent + 4), Y)
            Y += 5
          })
          Y += 0.5
        })
      }

      // Code block helper
      const codeBlock = (code) => {
        if (!code || code.trim() === '') return
        const cleanCode = sanitize(code)
        const codeLines = cleanCode.split('\n')
        // Expand wrapped lines
        doc.setFont('courier', 'normal')
        doc.setFontSize(8.5)
        const allWrapped = []
        codeLines.forEach((line) => {
          const wrapped = doc.splitTextToSize(line || ' ', contentW - 12)
          wrapped.forEach((wl) => allWrapped.push(wl))
        })

        const lineH = 4.5
        const pad = 5
        const maxLinesPerBox = Math.floor((PH - margin * 2 - 20) / lineH) // max lines that fit one page
        let idx = 0

        while (idx < allWrapped.length) {
          // How many lines fit on this page?
          const spaceLeft = PH - margin - 12 - Y
          let fitLines = Math.max(3, Math.floor((spaceLeft - pad * 2) / lineH))
          if (fitLines > allWrapped.length - idx) fitLines = allWrapped.length - idx

          const batchLines = allWrapped.slice(idx, idx + fitLines)
          const boxH = batchLines.length * lineH + pad * 2

          // Draw background
          doc.setFillColor(30, 30, 30)
          doc.roundedRect(margin + 2, Y, contentW - 4, boxH, 2, 2, 'F')

          // Draw text
          doc.setFont('courier', 'normal')
          doc.setFontSize(8.5)
          doc.setTextColor(187, 255, 187) // light green
          let cy = Y + pad
          batchLines.forEach((wl) => {
            doc.text(wl, margin + 5, cy)
            cy += lineH
          })

          Y += boxH + 3
          idx += fitLines

          // If more code remains, add a new page
          if (idx < allWrapped.length) {
            stampPageNumber()
            doc.addPage()
            pageNum++
            Y = margin
          }
        }

        // Restore font
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9.5)
        doc.setTextColor(51, 65, 85)
      }

      // ── HEADER ─────────────────────────────────────────────────────────────
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(22)
      doc.setTextColor(124, 58, 237)
      doc.text('MEETLY AI', margin, Y)
      Y += 9

      doc.setFontSize(13)
      doc.setTextColor(100, 116, 139)
      const typeLabel = meetingType === 'Educational / Lecture' ? 'Study Notes & Summary'
                      : meetingType === 'Technical / Development' ? 'Technical Meeting Summary'
                      : meetingType === 'Business / Professional'  ? 'Meeting Summary Report'
                      : 'Meeting Summary Report'
      doc.text(`AI ${typeLabel}`, margin, Y)
      Y += 4

      // Type badge
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(8)
      doc.setTextColor(124, 58, 237)
      doc.text(`[ ${meetingType} ]`, margin, Y + 4)
      Y += 9

      doc.setDrawColor(226, 232, 240)
      doc.setLineWidth(0.5)
      doc.line(margin, Y, PW - margin, Y)
      Y += 8

      // ── METADATA ───────────────────────────────────────────────────────────
      const meta = [
        ['Meeting Name:', meeting.name || 'Untitled Meeting'],
        ['Date:', meeting.date || 'N/A'],
        ['Duration:', meeting.duration || 'N/A']
      ]
      doc.setFontSize(9.5)
      meta.forEach(([label, value]) => {
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(71, 85, 105)
        doc.text(label, margin, Y)
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(51, 65, 85)
        doc.text(sanitize(String(value)), margin + 30, Y)
        Y += 6.5
      })
      Y += 2
      doc.line(margin, Y, PW - margin, Y)
      Y += 8

      // ── OVERVIEW ───────────────────────────────────────────────────────────
      sectionHeading('1', 'Overview')
      Y += 2
      doc.setFontSize(9.5)
      printWrapped(sanitize(overviewText), margin, Y, contentW, 5.2)
      Y += 4

      // ═══════════════════════════════════════════════════════════════════════
      // EDUCATIONAL / LECTURE — concept-by-concept study notes
      // ═══════════════════════════════════════════════════════════════════════
      if (meetingType === 'Educational / Lecture' && concepts.length > 0) {

        // Table of Contents
        need(16)
        sectionHeading('2', 'Table of Contents')
        Y += 2
        doc.setFontSize(9.5)
        doc.setTextColor(51, 65, 85)
        concepts.forEach((c, i) => {
          need(6)
          doc.setFont('helvetica', 'normal')
          doc.text(`  ${i + 1}.  ${sanitize(c.name)}`, margin + 2, Y)
          Y += 5.5
        })
        Y += 4

        // Concept sections
        sectionHeading('3', 'Concept Details')
        Y += 2

        concepts.forEach((concept, idx) => {
          conceptHeading(`${idx + 1}. ${concept.name}`)

          fieldBlock('Definition:', sanitize(concept.definition))
          fieldBlock('Explanation:', sanitize(concept.explanation))
          fieldBlock('Purpose / Why it is used:', sanitize(concept.purpose))

          if (concept.characteristics && concept.characteristics.length > 0) {
            need(8)
            doc.setFont('helvetica', 'bold')
            doc.setFontSize(9)
            doc.setTextColor(71, 85, 105)
            doc.text('Characteristics:', margin + 4, Y)
            Y += 5
            doc.setFont('helvetica', 'normal')
            doc.setFontSize(9.5)
            doc.setTextColor(51, 65, 85)
            bulletList(concept.characteristics, 8)
          }

          fieldBlock('Example:', sanitize(concept.example))
          fieldBlock('Real-world Analogy:', sanitize(concept.analogy))

          if (concept.codeExample && concept.codeExample.trim()) {
            need(10)
            doc.setFont('helvetica', 'bold')
            doc.setFontSize(9)
            doc.setTextColor(71, 85, 105)
            doc.text('Code / Example:', margin + 4, Y)
            Y += 5
            doc.setFont('helvetica', 'normal')
            codeBlock(concept.codeExample)
          }

          if (concept.importantPoints && concept.importantPoints.length > 0) {
            need(8)
            doc.setFont('helvetica', 'bold')
            doc.setFontSize(9)
            doc.setTextColor(71, 85, 105)
            doc.text('Important Points:', margin + 4, Y)
            Y += 5
            doc.setFont('helvetica', 'normal')
            doc.setFontSize(9.5)
            doc.setTextColor(51, 65, 85)
            bulletList(concept.importantPoints, 8)
          }

          if (concept.questionsRaised && concept.questionsRaised.length > 0) {
            need(8)
            doc.setFont('helvetica', 'bold')
            doc.setFontSize(9)
            doc.setTextColor(71, 85, 105)
            doc.text('Questions / Doubts Raised:', margin + 4, Y)
            Y += 5
            doc.setFont('helvetica', 'normal')
            doc.setFontSize(9.5)
            doc.setTextColor(100, 116, 139)
            bulletList(concept.questionsRaised, 8)
          }

          // ── Subtypes (e.g. Compile-Time and Runtime Polymorphism) ──────────────
          const subtypes = Array.isArray(concept.subtypes) ? concept.subtypes : []
          if (subtypes.length > 0) {
            need(10)
            doc.setFont('helvetica', 'bold')
            doc.setFontSize(9)
            doc.setTextColor(71, 85, 105)
            doc.text('Sub-types / Categories:', margin + 4, Y)
            Y += 5

            subtypes.forEach((st, si) => {
              // Sub-type heading
              need(14)
              Y += 4
              doc.setFillColor(237, 233, 254) // light purple
              doc.roundedRect(margin + 6, Y - 4, contentW - 12, 8, 1, 1, 'F')
              doc.setFont('helvetica', 'bold')
              doc.setFontSize(9.5)
              doc.setTextColor(88, 28, 135)
              doc.text(sanitize(st.name || `Sub-type ${si + 1}`), margin + 9, Y)
              Y += 6
              doc.setFont('helvetica', 'normal')
              doc.setFontSize(9.5)
              doc.setTextColor(51, 65, 85)

              fieldBlock('Definition:', sanitize(st.definition))
              fieldBlock('Explanation:', sanitize(st.explanation))
              fieldBlock('How it is achieved:', sanitize(st.howAchieved))
              fieldBlock('Example:', sanitize(st.example))

              if (st.codeExample && st.codeExample.trim()) {
                need(10)
                doc.setFont('helvetica', 'bold')
                doc.setFontSize(9)
                doc.setTextColor(71, 85, 105)
                doc.text('Code / Example:', margin + 9, Y)
                Y += 5
                doc.setFont('helvetica', 'normal')
                codeBlock(st.codeExample)
              }

              if (Array.isArray(st.importantPoints) && st.importantPoints.length > 0) {
                need(8)
                doc.setFont('helvetica', 'bold')
                doc.setFontSize(9)
                doc.setTextColor(71, 85, 105)
                doc.text('Important Points:', margin + 9, Y)
                Y += 5
                doc.setFont('helvetica', 'normal')
                doc.setFontSize(9.5)
                doc.setTextColor(51, 65, 85)
                bulletList(st.importantPoints.map(p => sanitize(p)), 12)
              }

              Y += 2
              if (si < subtypes.length - 1) {
                need(4)
                doc.setDrawColor(221, 214, 254)
                doc.setLineWidth(0.3)
                doc.line(margin + 12, Y, PW - margin - 12, Y)
                Y += 3
              }
            })
            Y += 2
          }

          Y += 2
          // Light separator between concepts
          if (idx < concepts.length - 1) {
            need(4)
            doc.setDrawColor(226, 232, 240)
            doc.setLineWidth(0.3)
            doc.line(margin + 10, Y, PW - margin - 10, Y)
            Y += 4
          }
        })

        // Key Takeaways (educational)
        if (keyPoints.length > 0) {
          sectionHeading('4', 'Key Takeaways')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          doc.setTextColor(51, 65, 85)
          bulletList(keyPoints)
        }

      // ═══════════════════════════════════════════════════════════════════════
      // TECHNICAL / DEVELOPMENT
      // ═══════════════════════════════════════════════════════════════════════
      } else if (meetingType === 'Technical / Development') {
        let sn = 2

        if (topics.length > 0) {
          sectionHeading(sn++, 'Topics Discussed')
          Y += 2
          topics.forEach((t) => {
            need(10)
            doc.setFont('helvetica', 'bold')
            doc.setFontSize(9.5)
            doc.setTextColor(15, 23, 42)
            doc.text(`> ${sanitize(t.title)}`, margin, Y)
            Y += 5
            if (t.description) {
              doc.setFont('helvetica', 'normal')
              doc.setTextColor(51, 65, 85)
              printWrapped(sanitize(t.description), margin + 5, Y, contentW - 5, 5.2)
              Y += 2
            }
          })
          Y += 2
        }

        if (techDetails.length > 0) {
          sectionHeading(sn++, 'Technical Details')
          Y += 2
          techDetails.forEach((td) => {
            need(10)
            if (td.area) {
              doc.setFont('helvetica', 'bold')
              doc.setFontSize(9)
              doc.setTextColor(71, 85, 105)
              doc.text(`[${td.area}]`, margin + 2, Y)
              Y += 5
            }
            doc.setFont('helvetica', 'normal')
            doc.setFontSize(9.5)
            doc.setTextColor(51, 65, 85)
            printWrapped(sanitize(td.detail), margin + 4, Y, contentW - 4, 5.2)
            if (td.codeOrExample && td.codeOrExample.trim()) {
              codeBlock(td.codeOrExample)
            }
            Y += 2
          })
        }

        if (issues.length > 0) {
          sectionHeading(sn++, 'Issues Discussed')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          bulletList(issues)
        }

        if (keyPoints.length > 0) {
          sectionHeading(sn++, 'Key Points')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          bulletList(keyPoints)
        }

        if (decisions.length > 0) {
          sectionHeading(sn++, 'Decisions Made')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          bulletList(decisions)
        }

        if (actions.length > 0) {
          sectionHeading(sn++, 'Action Items')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          actions.forEach((a) => {
            const cleanTask = sanitize(a.task)
            const cleanAssignee = a.assignee ? sanitize(a.assignee) : ''
            const text = cleanAssignee ? cleanAssignee + '  ->  ' + cleanTask : cleanTask
            const lines = doc.splitTextToSize('*  ' + text, contentW)
            lines.forEach((line) => {
              need(5.5)
              doc.text(line, margin + 4, Y)
              Y += 5
            })
            Y += 0.5
          })
        }

        if (nextSteps.length > 0) {
          sectionHeading(sn++, 'Next Steps')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          bulletList(nextSteps)
        }

      // ═══════════════════════════════════════════════════════════════════════
      // BUSINESS / PROFESSIONAL
      // ═══════════════════════════════════════════════════════════════════════
      } else if (meetingType === 'Business / Professional') {
        let sn = 2

        if (topics.length > 0) {
          sectionHeading(sn++, 'Topics Discussed')
          Y += 2
          topics.forEach((t) => {
            need(10)
            doc.setFont('helvetica', 'bold')
            doc.setFontSize(9.5)
            doc.setTextColor(15, 23, 42)
            doc.text(`> ${sanitize(t.title)}`, margin, Y)
            Y += 5
            if (t.description) {
              doc.setFont('helvetica', 'normal')
              doc.setTextColor(51, 65, 85)
              printWrapped(sanitize(t.description), margin + 5, Y, contentW - 5, 5.2)
              Y += 2
            }
          })
          Y += 2
        }

        if (keyPoints.length > 0) {
          sectionHeading(sn++, 'Key Points')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          bulletList(keyPoints)
        }

        if (decisions.length > 0) {
          sectionHeading(sn++, 'Decisions Made')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          bulletList(decisions)
        }

        if (actions.length > 0) {
          sectionHeading(sn++, 'Action Items')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          actions.forEach((a) => {
            const parts = [a.assignee && 'Owner: ' + sanitize(a.assignee), sanitize(a.task), a.deadline && 'Due: ' + sanitize(a.deadline)].filter(Boolean)
            const lines = doc.splitTextToSize('*  ' + parts.join('  |  '), contentW)
            lines.forEach((line) => { need(5.5); doc.text(line, margin + 4, Y); Y += 5 })
            Y += 0.5
          })
        }

        if (openQuestions.length > 0) {
          sectionHeading(sn++, 'Open Questions')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          doc.setTextColor(100, 116, 139)
          bulletList(openQuestions)
          doc.setTextColor(51, 65, 85)
        }

      // ═══════════════════════════════════════════════════════════════════════
      // GENERAL DISCUSSION (and fallback for educational with no concepts)
      // ═══════════════════════════════════════════════════════════════════════
      } else {
        let sn = 2

        if (topics.length > 0) {
          sectionHeading(sn++, 'Topics Discussed')
          Y += 2
          topics.forEach((t) => {
            need(10)
            doc.setFont('helvetica', 'bold')
            doc.setFontSize(9.5)
            doc.setTextColor(15, 23, 42)
            doc.text(`* ${sanitize(t.title)}`, margin, Y)
            Y += 5
            if (t.description) {
              doc.setFont('helvetica', 'normal')
              doc.setTextColor(51, 65, 85)
              printWrapped(sanitize(t.description), margin + 5, Y, contentW - 5, 5.2)
              Y += 2
            }
          })
          Y += 2
        }

        if (keyPoints.length > 0) {
          sectionHeading(sn++, 'Key Points')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          bulletList(keyPoints)
        }

        if (decisions.length > 0) {
          sectionHeading(sn++, 'Decisions Made')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          bulletList(decisions)
        }

        if (actions.length > 0) {
          sectionHeading(sn++, 'Action Items')
          Y += 2
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9.5)
          actions.forEach((a) => {
            const cleanTask = sanitize(a.task)
            const cleanAssignee = a.assignee ? sanitize(a.assignee) : ''
            const text = cleanAssignee ? cleanAssignee + '  ->  ' + cleanTask : cleanTask
            const lines = doc.splitTextToSize('*  ' + text, contentW)
            lines.forEach((line) => { need(5.5); doc.text(line, margin + 4, Y); Y += 5 })
            Y += 0.5
          })
        }
      }

      // ── FOOTER on last page ────────────────────────────────────────────────
      need(16)
      Y += 6
      doc.setDrawColor(226, 232, 240)
      doc.setLineWidth(0.5)
      doc.line(margin, Y, PW - margin, Y)
      Y += 7
      doc.setFont('helvetica', 'italic')
      doc.setFontSize(9)
      doc.setTextColor(148, 163, 184)
      doc.text('Generated by Meetly AI Platform', margin, Y)
      stampPageNumber()

      // Download
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
