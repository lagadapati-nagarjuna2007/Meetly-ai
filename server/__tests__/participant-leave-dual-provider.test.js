import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  leaveRealtimeKitSession,
  createParticipantListenerManager
} from '../../src/components/meeting/realtimeKitAdapterUtils.js'
import {
  leaveMeeting,
  setCloudflareService,
  resetCloudflareService
} from '../controllers/meetingController.js'
import { cancelCleanup } from '../services/meetingCleanup.js'
import { supabase } from '../config/supabase.js'

describe('Meetly AI — Participant Leave Dual-Provider Regression Suite', () => {
  const TEST_USER_ID = '11111111-1111-4111-8111-111111111111'
  const TEST_MEETING_ID = '22222222-2222-4222-8222-222222222222'
  const CF_MEETING_ID = 'cf-mtg-leave-test-123'
  const CF_PARTICIPANT_ID = 'cf-part-leave-test-456'

  let mockRemovedParticipants = []
  let originalFrom = null

  beforeEach(() => {
    mockRemovedParticipants = []
    originalFrom = supabase.from

    setCloudflareService({
      isConfigured: () => true,
      removeParticipant: async (meetingId, participantId) => {
        mockRemovedParticipants.push({ meetingId, participantId })
        return { success: true, meetingId, participantId }
      }
    })
  })

  afterEach(() => {
    cancelCleanup(TEST_MEETING_ID)
    resetCloudflareService()
    supabase.from = originalFrom
  })

  // ── 1. RealtimeKit SDK Leave API & Local Media Cleanup ─────────────────────

  it('1. leaveRealtimeKitSession disables local media producers and calls meeting.leave("left")', async () => {
    let disableAudioCalled = false
    let disableVideoCalled = false
    let disableShareCalled = false
    let leaveArgument = null
    let cloneStopped = false
    let physicalCameraReleased = false

    const mockMeeting = {
      self: {
        roomJoined: true,
        roomState: 'joined',
        disableAudio: async () => { disableAudioCalled = true },
        disableVideo: async () => { disableVideoCalled = true },
        disableScreenShare: async () => { disableShareCalled = true }
      },
      leave: async (state) => {
        leaveArgument = state
      }
    }

    const clonedTrackRef = {
      current: {
        stop: () => { cloneStopped = true }
      }
    }
    const meetingCamActiveRef = { current: true }
    const releasePhysicalCamera = () => { physicalCameraReleased = true }

    const listenerManager = createParticipantListenerManager()
    let remoteListenerDetached = false
    const mockRemote = {
      id: 'remote-1',
      removeListener: () => { remoteListenerDetached = true },
      on: () => {}
    }
    listenerManager.attach(mockRemote)
    assert.equal(listenerManager.getSubscribedCount(), 1)

    const res = await leaveRealtimeKitSession({
      meeting: mockMeeting,
      clonedTrackRef,
      meetingCamActiveRef,
      releasePhysicalCameraIfUnneeded: releasePhysicalCamera,
      listenerManager
    })

    assert.equal(res.success, true)
    assert.equal(disableAudioCalled, true, 'Audio must be disabled on meeting.self')
    assert.equal(disableVideoCalled, true, 'Video must be disabled on meeting.self')
    assert.equal(disableShareCalled, true, 'Screen share must be disabled on meeting.self')
    assert.equal(leaveArgument, 'left', 'meeting.leave must be invoked with "left"')
    assert.equal(cloneStopped, true, 'Cloned video track must be stopped')
    assert.equal(clonedTrackRef.current, null, 'Cloned track ref must be cleared')
    assert.equal(meetingCamActiveRef.current, false, 'Meeting camera must be marked inactive')
    assert.equal(physicalCameraReleased, true, 'Physical camera release check must be triggered')
    assert.equal(listenerManager.getSubscribedCount(), 0, 'All participant listeners must be removed')
    assert.equal(remoteListenerDetached, true, 'Remote participant listener must be detached')
  })

  it('2. leaveRealtimeKitSession is idempotent and safe to call repeatedly', async () => {
    let leaveCalls = 0
    const mockMeeting = {
      self: {
        roomJoined: true,
        roomState: 'joined',
        disableAudio: async () => {},
        disableVideo: async () => {},
        disableScreenShare: async () => {}
      },
      leave: async () => { leaveCalls++ }
    }

    const clonedTrackRef = { current: null }
    const meetingCamActiveRef = { current: false }

    const res1 = await leaveRealtimeKitSession({ meeting: mockMeeting, clonedTrackRef, meetingCamActiveRef })
    const res2 = await leaveRealtimeKitSession({ meeting: mockMeeting, clonedTrackRef, meetingCamActiveRef })

    assert.equal(res1.success, true)
    assert.equal(res2.success, true)
    assert.equal(leaveCalls, 2)
  })

  it('3. leaveRealtimeKitSession handles SDK leave failure gracefully without throwing', async () => {
    let cloneStopped = false
    const mockMeeting = {
      self: {
        roomJoined: true,
        roomState: 'joined',
        disableAudio: async () => {},
        disableVideo: async () => {},
        disableScreenShare: async () => {}
      },
      leave: async () => {
        throw new Error('Signaling channel disconnected unexpectedly')
      }
    }

    const clonedTrackRef = {
      current: { stop: () => { cloneStopped = true } }
    }
    const meetingCamActiveRef = { current: true }

    const res = await leaveRealtimeKitSession({
      meeting: mockMeeting,
      clonedTrackRef,
      meetingCamActiveRef
    })

    assert.equal(res.success, false)
    assert.match(res.error, /Signaling channel disconnected unexpectedly/)
    assert.equal(cloneStopped, true, 'Cloned track must still be stopped on leave error')
    assert.equal(meetingCamActiveRef.current, false)
  })

  // ── 2. Backend leaveMeeting Controller Tests ──────────────────────────────

  it('4. leaveMeeting updates DB status to "left" and evicts participant from Cloudflare', async () => {
    let updatedStatus = null
    let updatedLeftAt = null
    let targetMeetingId = null
    let targetUserId = null

    supabase.from = (table) => {
      if (table === 'meetings') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  meeting_id: TEST_MEETING_ID,
                  meeting_code: 'TESTMEET',
                  room_name: 'test-room',
                  cloudflare_meeting_id: CF_MEETING_ID,
                  meeting_status: 'Active'
                },
                error: null
              })
            })
          })
        }
      }
      if (table === 'participants') {
        return {
          select: () => ({
            eq: (col1, val1) => ({
              eq: (col2, val2) => ({
                maybeSingle: async () => ({
                  data: {
                    participant_id: 'part-1',
                    cloudflare_participant_id: CF_PARTICIPANT_ID,
                    participant_status: 'joined'
                  },
                  error: null
                })
              })
            })
          }),
          update: (fields) => {
            updatedStatus = fields.participant_status
            updatedLeftAt = fields.left_at
            return {
              eq: (col1, val1) => ({
                eq: (col2, val2) => {
                  targetMeetingId = val1
                  targetUserId = val2
                  return Promise.resolve({ error: null })
                }
              })
            }
          }
        }
      }
      return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [] }) }) }) }
    }

    const req = {
      body: { meetingId: TEST_MEETING_ID },
      user: { id: TEST_USER_ID }
    }
    let statusCode = null
    let jsonBody = null
    const res = {
      status: (code) => {
        statusCode = code
        return { json: (data) => { jsonBody = data } }
      }
    }

    await leaveMeeting(req, res)

    assert.equal(statusCode, 200)
    assert.equal(jsonBody?.success, true)
    assert.equal(updatedStatus, 'left', 'Participant status in DB must be updated to "left"')
    assert.notEqual(updatedStatus, 'removed', 'Participant status must NOT be set to "removed"')
    assert.ok(updatedLeftAt, 'left_at must be populated with timestamp')
    assert.equal(targetMeetingId, TEST_MEETING_ID)
    assert.equal(targetUserId, TEST_USER_ID)

    assert.equal(mockRemovedParticipants.length, 1, 'Cloudflare removeParticipant must be invoked')
    assert.equal(mockRemovedParticipants[0].meetingId, CF_MEETING_ID)
    assert.equal(mockRemovedParticipants[0].participantId, CF_PARTICIPANT_ID)
  })

  it('5. leaveMeeting does not invoke Cloudflare removeParticipant if meeting has no cloudflare_meeting_id', async () => {
    supabase.from = (table) => {
      if (table === 'meetings') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  meeting_id: TEST_MEETING_ID,
                  meeting_code: 'TESTMEET',
                  room_name: 'test-room',
                  cloudflare_meeting_id: null, // LiveKit-only meeting
                  meeting_status: 'Active'
                },
                error: null
              })
            })
          })
        }
      }
      if (table === 'participants') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { participant_id: 'part-1', cloudflare_participant_id: null, participant_status: 'joined' },
                  error: null
                })
              })
            })
          }),
          update: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: null })
            })
          })
        }
      }
      return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [] }) }) }) }
    }

    const req = {
      body: { meetingId: TEST_MEETING_ID },
      user: { id: TEST_USER_ID }
    }
    let statusCode = null
    const res = {
      status: (code) => {
        statusCode = code
        return { json: () => {} }
      }
    }

    await leaveMeeting(req, res)

    assert.equal(statusCode, 200)
    assert.equal(mockRemovedParticipants.length, 0, 'Cloudflare removeParticipant should NOT be called for non-Cloudflare meetings')
  })

  it('6. leaveMeeting returns 400 when meetingId is missing', async () => {
    const req = { body: {}, user: { id: TEST_USER_ID } }
    let statusCode = null
    let jsonBody = null
    const res = {
      status: (code) => {
        statusCode = code
        return { json: (data) => { jsonBody = data } }
      }
    }

    await leaveMeeting(req, res)
    assert.equal(statusCode, 400)
    assert.match(jsonBody.message, /identifier is required/)
  })

  it('7. leaveMeeting returns 404 when meeting is not found', async () => {
    supabase.from = () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null })
        })
      })
    })

    const req = { body: { meetingId: 'non-existent-id' }, user: { id: TEST_USER_ID } }
    let statusCode = null
    const res = {
      status: (code) => {
        statusCode = code
        return { json: () => {} }
      }
    }

    await leaveMeeting(req, res)
    assert.equal(statusCode, 404)
  })

  // ── 3. Frontend Component & Adapter Wiring Verification ───────────────────

  it('8. RealtimeKitAdapter wraps handleLeave with leaveRealtimeKitSession and single-flight protection', () => {
    const adapterSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/meeting/RealtimeKitAdapter.jsx'),
      'utf8'
    )

    assert.match(
      adapterSource,
      /leaveRealtimeKitSession/,
      'RealtimeKitAdapter must import and utilize leaveRealtimeKitSession'
    )
    assert.match(
      adapterSource,
      /handleAdapterLeave/,
      'RealtimeKitAdapter must define handleAdapterLeave wrapper'
    )
    assert.match(
      adapterSource,
      /handleLeave=\{handleAdapterLeave\}/,
      'RealtimeKitAdapter must pass handleAdapterLeave to MeetingRoomView'
    )
    assert.match(
      adapterSource,
      /\.leave\(['"]left['"]\)/,
      'RealtimeKitAdapter must use the official SDK leave API with state "left"'
    )
  })

  it('9. LiveKitAdapter is removed and RealtimeKitAdapter is the sole adapter', () => {
    const livekitAdapterExists = fs.existsSync(
      path.resolve(process.cwd(), 'src/components/meeting/LiveKitAdapter.jsx')
    )
    assert.strictEqual(livekitAdapterExists, false, 'LiveKitAdapter.jsx must be removed')

    const rtkSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/meeting/RealtimeKitAdapter.jsx'),
      'utf8'
    )
    assert.match(
      rtkSource,
      /handleAdapterLeave/,
      'RealtimeKitAdapter must define handleAdapterLeave wrapper'
    )
  })

  it('10. MeetingRoomView handles repeated clicks, catches errors, and guarantees navigation', () => {
    const viewSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/meeting/MeetingRoomView.jsx'),
      'utf8'
    )

    assert.match(
      viewSource,
      /isLeavingWithAttendanceRef/,
      'MeetingRoomView must guard repeated leave clicks with an in-flight ref'
    )
    assert.match(
      viewSource,
      /navigate\(['"]\/['"]\)/,
      'MeetingRoomView must navigate to "/" even if an error is caught'
    )
    assert.match(
      viewSource,
      /<span>Leave Meeting<\/span>/,
      'MeetingRoomView Leave button label must be "Leave Meeting"'
    )
  })

  it('11. MeetingRoom.jsx guards against concurrent handleLeave executions and navigates', () => {
    const roomSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/pages/MeetingRoom.jsx'),
      'utf8'
    )

    assert.match(
      roomSource,
      /isLeavingMeetingRef/,
      'MeetingRoom must guard handleLeave with in-flight ref'
    )
    assert.match(
      roomSource,
      /clearCredentials\?\.?\(\)/,
      'MeetingRoom must clear credentials upon leave'
    )
    assert.match(
      roomSource,
      /navigate\(['"]\/['"]\)/,
      'MeetingRoom must navigate to "/" upon leave'
    )
  })
})
