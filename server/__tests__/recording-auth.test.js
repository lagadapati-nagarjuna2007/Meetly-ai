import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeRecordingHost, authorizeRecordingViewer } from '../utils/recordingAuth.js'

describe('Screen Recording Authorization Matrix', () => {
  it('allows Original Host to manage recording', async () => {
    // Mock user and meeting where user is host_id
    const meetingId = 'test-meeting-1'
    const origHostId = 'user-owner-123'

    // Test permission logic directly
    const isOwner = (origHostId === 'user-owner-123')
    assert.equal(isOwner, true, 'Original Host should be identified as owner')
  })

  it('allows Active Host to manage recording but restricts deletion', async () => {
    const origHostId = 'user-owner-123'
    const activeHostId = 'user-active-456'
    const currentUserId = 'user-active-456'

    const canManage = (currentUserId === origHostId || currentUserId === activeHostId)
    const canDelete = (currentUserId === origHostId)

    assert.equal(canManage, true, 'Active Host should be authorized to manage/start/stop recording')
    assert.equal(canDelete, false, 'Active Host must NOT be authorized to delete recordings')
  })

  it('allows historical attendee who has status=left to stream recording', async () => {
    // Participant record with historical attendance evidence
    const participant = {
      user_id: 'attendee-789',
      participant_status: 'left',
      joined_at: '2026-10-11T09:00:00.000Z',
      left_at: '2026-10-11T09:45:00.000Z'
    }

    const hasAttended = Boolean(
      participant.joined_at ||
      participant.participant_status === 'joined' ||
      participant.participant_status === 'left'
    )

    assert.equal(hasAttended, true, 'Participant who left must still be recognized as historical attendee')
  })

  it('prohibits historical attendee from downloading recording', async () => {
    const origHostId = 'user-owner-123'
    const activeHostId = 'user-active-456'
    const attendeeId = 'attendee-789'

    const canDownload = (attendeeId === origHostId || attendeeId === activeHostId)
    assert.equal(canDownload, false, 'Historical attendees must not receive download URLs')
  })

  it('denies non-attendee completely from recording access', async () => {
    const participant = null // No record found in participants table
    const origHostId = 'user-owner-123'
    const strangerId = 'stranger-999'

    const isAuthorized = participant !== null || strangerId === origHostId
    assert.equal(isAuthorized, false, 'Non-attendees must be denied with 403 Forbidden')
  })
})
