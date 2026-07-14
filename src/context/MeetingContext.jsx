import { createContext, useContext, useState, useEffect } from 'react'

const MeetingContext = createContext(null)

const INITIAL_MEETINGS = [
  {
    id: 'mtg-ai-lec-4',
    name: 'AI Lecture – Week 4',
    host: 'Dr. Ravi Kumar',
    date: 'May 24, 2024',
    time: '10:00 AM',
    duration: '60 min',
    status: 'Completed',
    attendance: '94%',
    focusScore: '89%',
    summary: 'Discussion on Deep Learning, Transformers, and custom attention mechanisms. Reviewed model hyperparameters and training efficiency. Action items: Read the attention paper; complete Assignment 3.',
    transcript: [
      { speaker: 'Dr. Ravi Kumar', time: '10:01 AM', text: 'Welcome everyone. Today we are continuing our discussion on Transformers.' },
      { speaker: 'Nagarjuna Sai', time: '10:15 AM', text: 'Dr. Ravi, could you explain the scaling factor in self-attention again?' },
      { speaker: 'Dr. Ravi Kumar', time: '10:16 AM', text: 'Sure, Nagarjuna. It is used to prevent the dot products from growing too large, which would push the softmax function into regions with small gradients.' }
    ]
  },
  {
    id: 'mtg-ds-class',
    name: 'Data Structures Class',
    host: 'Prof. Meena',
    date: 'May 23, 2024',
    time: '2:30 PM',
    duration: '45 min',
    status: 'Completed',
    attendance: '88%',
    focusScore: '82%',
    summary: 'Covered Binary Search Trees (BST), balancing operations, and AVL Trees. Discussed time complexity for search, insertion, and deletion.',
    transcript: [
      { speaker: 'Prof. Meena', time: '2:31 PM', text: 'Hello everyone. Today let\'s look at tree rotations in AVL trees.' },
      { speaker: 'Student B', time: '2:45 PM', text: 'Is it always O(log n) for balanced trees?' },
      { speaker: 'Prof. Meena', time: '2:46 PM', text: 'Yes, that is the main reason we balance them.' }
    ]
  },
  {
    id: 'mtg-proj-rev',
    name: 'Project Review Meeting',
    host: 'Team Meeting',
    date: 'May 22, 2024',
    time: '11:00 AM',
    duration: '50 min',
    status: 'Completed',
    attendance: '100%',
    focusScore: '92%',
    summary: 'Reviewed design assets and component hierarchy for Phase 1. Finalized Tailwind configuration and state routing model. Next check-in is set for tomorrow.',
    transcript: [
      { speaker: 'Nagarjuna Sai', time: '11:01 AM', text: 'Let\'s run through the UI mockups for Login and Home page.' },
      { speaker: 'Designer', time: '11:15 AM', text: 'I have updated the colors to follow a dark theme with blue and purple accents.' }
    ]
  },
  {
    id: 'mtg-team-std',
    name: 'Team Standup',
    host: 'Daily Standup',
    date: 'May 21, 2024',
    time: '09:30 AM',
    duration: '30 min',
    status: 'Completed',
    attendance: '90%',
    focusScore: '85%',
    summary: 'Daily standup to sync progress. Blockers resolved regarding local sandbox dependencies. Frontend layout confirmed.',
    transcript: [
      { speaker: 'Daily Standup', time: '9:30 AM', text: 'Good morning. Let\'s begin with the updates.' }
    ]
  }
]

export function MeetingProvider({ children }) {
  const [meetings, setMeetings] = useState(() => {
    const saved = localStorage.getItem('meetly_meetings')
    return saved ? JSON.parse(saved) : INITIAL_MEETINGS
  })
  const [currentMeeting, setCurrentMeeting] = useState(null)

  useEffect(() => {
    localStorage.setItem('meetly_meetings', JSON.stringify(meetings))
  }, [meetings])

  const createMeeting = (name, description, attendance, focus, aiSummary) => {
    const randomId = 'mtg-' + Math.random().toString(36).substring(2, 9)
    const newMtg = {
      id: randomId,
      name: name || 'Quick Meeting',
      description: description || 'No description provided.',
      host: 'Nagarjuna Sai',
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      duration: 'Ongoing',
      status: 'Live',
      attendanceRequirement: attendance,
      enableFocusAnalysis: focus,
      enableAiSummary: aiSummary,
      attendance: '100%',
      focusScore: 'Pending',
      summary: 'Meeting has just started. Summaries will be generated once the meeting concludes.',
      transcript: []
    }
    setMeetings([newMtg, ...meetings])
    setCurrentMeeting(newMtg)
    return newMtg
  }

  const joinMeeting = (id) => {
    const mtg = meetings.find(m => m.id === id)
    if (mtg) {
      const activeMtg = { ...mtg, status: 'Live', duration: 'Ongoing' }
      setCurrentMeeting(activeMtg)
      return activeMtg
    } else {
      // Create a temporary live meeting
      const tempMtg = {
        id: id,
        name: `Meeting (${id})`,
        host: 'External Host',
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        duration: 'Ongoing',
        status: 'Live',
        attendance: '100%',
        focusScore: 'Pending',
        summary: 'Joined meeting via ID.',
        transcript: []
      }
      setCurrentMeeting(tempMtg)
      return tempMtg
    }
  }

  const leaveMeeting = () => {
    if (currentMeeting) {
      // Update its status in meetings list if it was Live
      setMeetings(prev => prev.map(m => {
        if (m.id === currentMeeting.id) {
          return { ...m, status: 'Completed', duration: '15 min' }
        }
        return m
      }))
    }
    setCurrentMeeting(null)
  }

  return (
    <MeetingContext.Provider value={{ meetings, currentMeeting, createMeeting, joinMeeting, leaveMeeting }}>
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
