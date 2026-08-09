import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from './AuthContext'

const MeetingContext = createContext(null)
const API_URL = `${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meeting`

export function MeetingProvider({ children }) {
  const { user } = useAuth()
  const [meetings, setMeetings] = useState([])
  const [currentMeeting, setCurrentMeeting] = useState(null)
  const [livekitToken, setLivekitToken] = useState(null)
  const [livekitUrl, setLivekitUrl] = useState(null)
  const [roomName, setRoomName] = useState(null)
  const [isLoading, setIsLoading] = useState(false)

  // Single-flight state flags to prevent duplicate simultaneous requests
  const [isCreatingMeeting, setIsCreatingMeeting] = useState(false)
  const [isJoiningMeeting, setIsJoiningMeeting] = useState(false)
  const [isLeavingMeeting, setIsLeavingMeeting] = useState(false)

  // In-flight refs for synchronous guarding
  const creatingRef = useRef(false)
  const joiningRef = useRef(false)
  const leavingRef = useRef(false)

  // 1. Fetch recent active meetings
  const refreshMeetings = useCallback(async () => {
    if (!user) {
      setMeetings([])
      return
    }
    setIsLoading(true)
    try {
      const res = await fetch(API_URL, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      })
      if (res.ok) {
        const data = await res.json()
        setMeetings(data)
      }
    } catch (err) {
      console.error('[MeetingContext] Failed to load meetings:', err)
    } finally {
      setIsLoading(false)
    }
  }, [user])

  // Reload meetings list when user changes
  useEffect(() => {
    refreshMeetings()
  }, [refreshMeetings])

  // 2. CREATE MEETING
  // Atomic creation: stores meeting details AND LiveKit token immediately in state
  const createMeeting = async (title, type = 'public', password = '', enableAiAnalyzer = false, enableAiAttendance = false) => {
    if (creatingRef.current) {
      console.log('[MeetingContext] Create meeting already in-flight, ignoring duplicate call.')
      return currentMeeting
    }

    creatingRef.current = true
    setIsCreatingMeeting(true)
    setIsLoading(true)

    try {
      console.log('[MeetingContext] Requesting createMeeting backend API...')
      const res = await fetch(`${API_URL}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingTitle: title,
          meetingType: type,
          meetingPassword: password,
          enableAiAnalyzer,
          enableAiAttendance
        }),
        credentials: 'include'
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message || 'Failed to create meeting')
      }

      console.log('[MeetingContext] createMeeting backend success. Setting currentMeeting and LiveKit token...')

      const activeMtg = {
        id: data.meetingCode || data.meeting.meeting_code,
        dbId: data.meetingId || data.meeting.meeting_id,
        name: data.meeting.meeting_title,
        hostId: data.meeting.host_id,
        status: data.meeting.meeting_status,
        type: data.meeting.meeting_type,
        roomName: data.roomName || data.meeting.room_name,
        token: data.livekitToken,
        livekitUrl: data.livekitUrl,
        enableAiAnalyzer: data.meeting.enable_ai_analyzer,
        enableAiAttendance: data.meeting.enable_ai_attendance
      }

      setCurrentMeeting(activeMtg)
      setLivekitToken(data.livekitToken)
      setLivekitUrl(data.livekitUrl)
      setRoomName(data.roomName || data.meeting.room_name)

      await refreshMeetings()
      return activeMtg
    } catch (err) {
      console.error('[MeetingContext] createMeeting error:', err)
      throw err
    } finally {
      creatingRef.current = false
      setIsCreatingMeeting(false)
      setIsLoading(false)
    }
  }

  // 3. JOIN MEETING
  // Idempotent join: returns LiveKit token and meeting state
  const joinMeeting = async (code, password = '', deviceFingerprint = '') => {
    if (joiningRef.current) {
      console.log('[MeetingContext] Join meeting already in-flight for code:', code)
      return currentMeeting
    }

    joiningRef.current = true
    setIsJoiningMeeting(true)
    setIsLoading(true)

    try {
      console.log('[MeetingContext] Requesting joinMeeting backend API for code:', code)
      const res = await fetch(`${API_URL}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingCode: code,
          password,
          deviceFingerprint
        }),
        credentials: 'include'
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message || 'Failed to join meeting')
      }

      if (data.status === 'waiting') {
        console.log('[MeetingContext] Join pending. User placed in waiting room.')
        return { status: 'waiting', message: data.message }
      }

      console.log('[MeetingContext] joinMeeting backend success. Setting currentMeeting and LiveKit token...')

      const activeMtg = {
        id: data.meeting.meeting_code,
        dbId: data.meeting.meeting_id,
        name: data.meeting.meeting_title,
        hostId: data.meeting.host_id,
        status: data.meeting.meeting_status,
        type: data.meeting.meeting_type,
        roomName: data.roomName || data.meeting.room_name,
        token: data.token,
        livekitUrl: data.livekitUrl
      }

      setCurrentMeeting(activeMtg)
      setLivekitToken(data.token)
      setRoomName(data.roomName)
      setLivekitUrl(data.livekitUrl)

      await refreshMeetings()

      return activeMtg
    } catch (err) {
      console.error('[MeetingContext] joinMeeting error:', err)
      throw err
    } finally {
      joiningRef.current = false
      setIsJoiningMeeting(false)
      setIsLoading(false)
    }
  }

  // 4. ACTIVATE MEETING
  // Called when LiveKit room connects successfully to transition status from Waiting -> Active
  const activateMeeting = async (meetingId) => {
    if (!meetingId) return
    try {
      console.log('[MeetingContext] Notifying backend activateMeeting for:', meetingId)
      await fetch(`${API_URL}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId }),
        credentials: 'include'
      })
      if (currentMeeting) {
        setCurrentMeeting((prev) => (prev ? { ...prev, status: 'Active' } : null))
      }
    } catch (err) {
      console.error('[MeetingContext] activateMeeting error:', err)
    }
  }

  // 5. LEAVE MEETING
  const leaveMeeting = async (meetingId) => {
    if (leavingRef.current) return
    leavingRef.current = true
    setIsLeavingMeeting(true)

    try {
      console.log('[MeetingContext] Leaving meeting:', meetingId)
      await fetch(`${API_URL}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId }),
        credentials: 'include'
      })
    } catch (err) {
      console.error('[MeetingContext] Failed to notify backend on leave:', err)
    } finally {
      setCurrentMeeting(null)
      setLivekitToken(null)
      setLivekitUrl(null)
      setRoomName(null)
      leavingRef.current = false
      setIsLeavingMeeting(false)
      refreshMeetings()
    }
  }

  // 6. END MEETING (Host only)
  const endMeeting = async (meetingId) => {
    try {
      console.log('[MeetingContext] Ending meeting:', meetingId)
      const res = await fetch(`${API_URL}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId }),
        credentials: 'include'
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message || 'Failed to end meeting')
      }

      if (currentMeeting?.id === meetingId || currentMeeting?.dbId === meetingId) {
        setCurrentMeeting(null)
        setLivekitToken(null)
        setLivekitUrl(null)
        setRoomName(null)
      }
      await refreshMeetings()
      return true
    } catch (err) {
      console.error('[MeetingContext] endMeeting error:', err)
      throw err
    }
  }

  // 7. LOCK MEETING (Host only)
  const lockMeeting = async (meetingId, isLocked) => {
    const res = await fetch(`${API_URL}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId, isLocked }),
      credentials: 'include'
    })

    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.message || 'Failed to update meeting lock status')
    }

    if (currentMeeting?.id === meetingId || currentMeeting?.dbId === meetingId) {
      setCurrentMeeting((prev) => (prev ? { ...prev, status: data.status } : null))
    }
    await refreshMeetings()
    return data.status
  }

  // 8. DELETE MEETING (Soft Delete - Host only)
  const deleteMeeting = async (idOrCode) => {
    const res = await fetch(`${API_URL}/${idOrCode}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    })

    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.message || 'Failed to delete meeting')
    }

    if (currentMeeting?.id === idOrCode || currentMeeting?.dbId === idOrCode) {
      setCurrentMeeting(null)
      setLivekitToken(null)
      setLivekitUrl(null)
      setRoomName(null)
    }
    await refreshMeetings()
    return true
  }

  // 9. RENAME MEETING (Host only)
  const renameMeeting = async (idOrCode, newTitle) => {
    const res = await fetch(`${API_URL}/${idOrCode}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingTitle: newTitle }),
      credentials: 'include'
    })

    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.message || 'Failed to rename meeting')
    }

    if (currentMeeting?.id === idOrCode || currentMeeting?.dbId === idOrCode) {
      setCurrentMeeting((prev) => (prev ? { ...prev, name: newTitle } : null))
    }
    await refreshMeetings()
    return true
  }

  // 10. GET HISTORY LIST
  const fetchHistory = async () => {
    const res = await fetch(`${API_URL}/history`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.message || 'Failed to fetch history')
    }
    return await res.json()
  }

  // 11. GET SINGLE MEETING DETAILS
  const fetchMeetingDetails = async (idOrCode) => {
    const res = await fetch(`${API_URL}/details/${idOrCode}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.message || 'Failed to fetch meeting details')
    }
    return await res.json()
  }

  // 12. GET LIST OF ACTIVE PARTICIPANTS
  const fetchMeetingParticipants = async (idOrCode) => {
    const res = await fetch(`${API_URL}/participants/${idOrCode}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.message || 'Failed to fetch meeting participants')
    }
    return await res.json()
  }

  // 13. GENERATE MEETING SUMMARY
  const generateMeetingSummary = async (meetingId) => {
    const res = await fetch(`${API_URL}/summary/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId }),
      credentials: 'include'
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.message || 'Unable to generate meeting summary. Please try again.')
    }
    return data.summary
  }

  // 14. SUBMIT ATTENDANCE RECORD
  const submitAttendanceRecord = async (record) => {
    const res = await fetch(`${API_URL}/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
      credentials: 'include'
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.message || 'Failed to submit attendance.')
    }
    return data
  }

  // 15. GET ATTENDANCE REPORT
  const getAttendanceReport = async (meetingId) => {
    const res = await fetch(`${API_URL}/attendance/report/${meetingId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.message || 'Failed to retrieve attendance logs.')
    }
    return data
  }

  // 16. CLEAR ATTENDANCE RECORDS (After successful download)
  const clearAttendanceRecords = async (meetingId) => {
    const res = await fetch(`${API_URL}/attendance/report/${meetingId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.message || 'Failed to clear attendance logs.')
    }
    return data
  }

  return (
    <MeetingContext.Provider
      value={{
        meetings,
        currentMeeting,
        livekitToken,
        livekitUrl,
        setLivekitToken,
        setLivekitUrl,
        roomName,
        isLoading,
        isCreatingMeeting,
        isJoiningMeeting,
        isLeavingMeeting,
        createMeeting,
        joinMeeting,
        activateMeeting,
        leaveMeeting,
        endMeeting,
        lockMeeting,
        deleteMeeting,
        renameMeeting,
        fetchHistory,
        fetchMeetingDetails,
        fetchMeetingParticipants,
        generateMeetingSummary,
        submitAttendanceRecord,
        getAttendanceReport,
        clearAttendanceRecords,
        refreshMeetings
      }}
    >
      {children}
    </MeetingContext.Provider>
  )
}

export function useMeetings() {
  const context = useContext(MeetingContext)
  if (!context) {
    throw new Error('useMeetings must be used within a MeetingProvider')
  }
  return context
}
