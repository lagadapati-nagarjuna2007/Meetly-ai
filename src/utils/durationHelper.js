/**
 * Shared duration formatting and attendance calculation utilities for Meetly AI
 */

/**
 * Format seconds into human-readable duration matching Zoom & Meetly specifications:
 * - < 60s: '45s'
 * - < 3600s: '5m 56s' (or '5m 0s')
 * - >= 3600s: '1h 12m 30s'
 */
export function formatDuration(seconds) {
  const sec = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60

  if (h > 0) {
    return `${h}h ${m}m ${s}s`
  }
  if (m > 0) {
    return `${m}m ${s}s`
  }
  return `${s}s`
}

/**
 * Merge overlapping or contiguous time intervals to avoid double-counting attendance
 * across reconnects, tab switching, or clock jitter.
 *
 * @param {Array<{ start: number, end: number, seconds?: number }>} intervals
 * @returns {Array<{ start: number, end: number, seconds: number }>}
 */
export function mergeIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return []

  // Filter valid intervals
  const valid = intervals
    .filter(iv => iv && typeof iv.start === 'number' && typeof iv.end === 'number' && iv.end >= iv.start)
    .map(iv => ({
      start: iv.start,
      end: iv.end,
      seconds: Math.max(0, Math.floor((iv.end - iv.start) / 1000))
    }))

  if (valid.length === 0) return []

  // Sort by start time ascending
  const sorted = [...valid].sort((a, b) => a.start - b.start)
  const merged = [{ ...sorted[0] }]

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = sorted[i]

    if (curr.start <= prev.end) {
      // Overlapping or contiguous interval
      prev.end = Math.max(prev.end, curr.end)
      prev.seconds = Math.max(0, Math.floor((prev.end - prev.start) / 1000))
    } else {
      merged.push({ ...curr })
    }
  }

  return merged
}

/**
 * Calculate attendance percentage and status based on official formula:
 * Attendance Percentage = (Participant Attendance Duration / Total Meeting Duration) * 100
 * Status: 'Present' if >= 75%, otherwise 'Absent'
 */
export function calculateAttendancePercentage(participantDurationSeconds, totalMeetingDurationSeconds) {
  const pSec = Math.max(0, Number(participantDurationSeconds) || 0)
  const totalSec = Math.max(1, Number(totalMeetingDurationSeconds) || 0)

  // Participant attendance duration cannot exceed total meeting duration
  const clampedPresence = Math.min(pSec, totalSec)
  const percentage = Math.max(0, Math.min(100, Number(((clampedPresence / totalSec) * 100).toFixed(2))))
  const status = percentage >= 75 ? 'Present' : 'Absent'

  return {
    participantDurationSeconds: clampedPresence,
    totalMeetingDurationSeconds: totalSec,
    percentage,
    status,
    participantDurationFormatted: formatDuration(clampedPresence),
    meetingDurationFormatted: formatDuration(totalSec)
  }
}
