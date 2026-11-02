/**
 * Meetly AI — Screen Recorder Dual-Provider Audio Adapter Utilities
 *
 * Provides provider-neutral audio track extraction, dynamic event subscription,
 * and safe Web Audio API mixer management for both LiveKit and Cloudflare RealtimeKit.
 */

export const LIVEKIT_MIC_SOURCE = 'microphone'
export const LIVEKIT_TRACK_SUBSCRIBED = 'trackSubscribed'
export const LIVEKIT_TRACK_UNSUBSCRIBED = 'trackUnsubscribed'

/**
 * Validates that an object is a live MediaStream audio track.
 *
 * @param {MediaStreamTrack|any} track
 * @returns {boolean}
 */
export function isLiveAudioTrack(track) {
  if (!track || typeof track !== 'object') return false
  if (track.kind !== 'audio') return false
  // readyState must be 'live' (not 'ended' or uninitialized)
  if (track.readyState !== 'live') return false
  return true
}

/**
 * Detects whether the current meeting session uses Cloudflare RealtimeKit or LiveKit.
 *
 * @param {Object} params
 * @param {any} [params.room]
 * @param {any} [params.localParticipant]
 * @param {Array|any} [params.participants]
 * @param {string} [params.activeProvider]
 * @returns {'cloudflare' | 'livekit'}
 */
export function detectProvider(params) {
  const { room, localParticipant, participants, activeProvider } = params || {}
  // 1. Authoritative caller hint
  if (activeProvider === 'cloudflare' || activeProvider === 'livekit') {
    return activeProvider
  }

  // 2. Cloudflare RealtimeKit client indicators on room
  if (
    room &&
    (room.self !== undefined ||
      room.participants?.joined !== undefined ||
      room.stores !== undefined ||
      room.__internals__ !== undefined)
  ) {
    return 'cloudflare'
  }

  // 3. LiveKit LocalParticipant indicators
  if (localParticipant && typeof localParticipant.getTrackPublication === 'function') {
    return 'livekit'
  }

  // 4. Cloudflare RealtimeKit normalized participant indicators
  if (
    localParticipant &&
    (localParticipant.rawParticipant !== undefined ||
      (localParticipant.audioTrack !== undefined && typeof localParticipant.getTrackPublication !== 'function'))
  ) {
    return 'cloudflare'
  }

  // 5. Participants collection inspection
  if (Array.isArray(participants) && participants.length > 0) {
    const first = participants[0]
    if (first && typeof first.getTrackPublication === 'function') {
      return 'livekit'
    }
    if (first && (first.rawParticipant !== undefined || first.audioTrack !== undefined)) {
      return 'cloudflare'
    }
  }

  // 6. LiveKit Room instance indicators
  if (
    room &&
    (room.remoteParticipants instanceof Map ||
      typeof room.getTrackPublication === 'function' ||
      typeof room.connect === 'function')
  ) {
    return 'livekit'
  }

  // Default fallback
  return 'cloudflare'
}

/**
 * Extracts the active local microphone MediaStreamTrack.
 *
 * - LiveKit: queries getTrackPublication(Track.Source.Microphone)
 * - Cloudflare: accesses localParticipant.audioTrack or room.self.audioTrack
 *
 * @param {Object} params
 * @param {'cloudflare'|'livekit'} [params.provider]
 * @param {any} [params.room]
 * @param {any} [params.localParticipant]
 * @returns {MediaStreamTrack|null}
 */
export function getLocalMicTrack(params) {
  const { provider, room, localParticipant } = params || {}
  const effectiveProvider = provider || detectProvider({ room, localParticipant })

  if (effectiveProvider === 'cloudflare') {
    const cfTrack = localParticipant?.audioTrack || room?.self?.audioTrack || null
    if (cfTrack && cfTrack.kind === 'audio') {
      return cfTrack
    }
    return null
  }

  // LiveKit provider path
  try {
    const pub =
      localParticipant?.getTrackPublication?.(LIVEKIT_MIC_SOURCE) ||
      localParticipant?.getTrackPublication?.('microphone')

    const track = pub?.track?.mediaStreamTrack || pub?.track || null
    if (track && track.kind === 'audio') {
      return track
    }
  } catch (err) {
    console.warn('[ScreenRecorderAudio] Error extracting LiveKit local mic track:', err)
  }

  return null
}

/**
 * Extracts all currently active remote participant audio tracks.
 *
 * - LiveKit: iterates participants[].audioTrackPublications
 * - Cloudflare: iterates participants[].audioTrack or room.participants.joined
 *
 * @param {Object} params
 * @param {'cloudflare'|'livekit'} [params.provider]
 * @param {any} [params.room]
 * @param {Array|any} [params.participants]
 * @returns {Array<{ id: string, participantId: string, track: MediaStreamTrack }>}
 */
export function getRemoteAudioTracks(params) {
  const { provider, room, participants } = params || {}
  const effectiveProvider = provider || detectProvider({ room, participants })
  const result = []
  const seenIds = new Set()

  if (effectiveProvider === 'cloudflare') {
    // 1. Iterate normalized participants array from MeetingRoomView
    if (Array.isArray(participants) && participants.length > 0) {
      participants.forEach((p) => {
        if (!p) return
        const pId = p.id || p.sid || p.customParticipantId || 'remote'
        const track = p.audioTrack || p.rawParticipant?.audioTrack || null
        if (track && track.kind === 'audio') {
          const trackKey = `cf-${pId}-audio`
          if (!seenIds.has(trackKey)) {
            seenIds.add(trackKey)
            result.push({
              id: trackKey,
              participantId: pId,
              track
            })
          }
        }
      })
    }

    // 2. Fallback to room.participants.joined if participants array was empty
    if (result.length === 0 && room?.participants?.joined) {
      const joinedMap = room.participants.joined
      const joinedList =
        typeof joinedMap.toArray === 'function'
          ? joinedMap.toArray()
          : Array.from(joinedMap.values ? joinedMap.values() : [])

      joinedList.forEach((p) => {
        if (!p) return
        const pId = p.id || p.customParticipantId || 'remote'
        const track = p.audioTrack
        if (track && track.kind === 'audio') {
          const trackKey = `cf-${pId}-audio`
          if (!seenIds.has(trackKey)) {
            seenIds.add(trackKey)
            result.push({
              id: trackKey,
              participantId: pId,
              track
            })
          }
        }
      })
    }

    return result
  }

  // LiveKit provider path
  if (Array.isArray(participants) && participants.length > 0) {
    participants.forEach((p) => {
      if (!p) return
      const pId = p.identity || p.sid || p.id || 'remote'

      // audioTrackPublications can be a Map or an array
      const pubs = p.audioTrackPublications
      if (pubs) {
        const pubList = pubs instanceof Map ? Array.from(pubs.values()) : Array.isArray(pubs) ? pubs : Object.values(pubs)
        pubList.forEach((pub) => {
          const track = pub?.track?.mediaStreamTrack || pub?.track
          if (track && track.kind === 'audio') {
            const trackSid = pub?.track?.sid || pub?.trackSid || track.id || `livekit-${pId}-audio`
            if (!seenIds.has(trackSid)) {
              seenIds.add(trackSid)
              result.push({
                id: trackSid,
                participantId: pId,
                track
              })
            }
          }
        })
      }
    })
  }

  return result
}

/**
 * Extracts all initial audio tracks (local microphone + remote participants).
 *
 * @param {Object} params
 * @returns {{ localTrack: MediaStreamTrack|null, remoteTracks: Array<{ id: string, participantId: string, track: MediaStreamTrack }> }}
 */
export function extractInitialAudioTracks(params) {
  const { provider, room, localParticipant, participants, activeProvider } = params || {}
  const effectiveProvider = provider || detectProvider({ room, localParticipant, participants, activeProvider })

  return {
    localTrack: getLocalMicTrack({ provider: effectiveProvider, room, localParticipant }),
    remoteTracks: getRemoteAudioTracks({ provider: effectiveProvider, room, participants })
  }
}

/**
 * Subscribes to dynamic room audio events across either LiveKit or Cloudflare RealtimeKit.
 *
 * - LiveKit:
 *   - room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
 *   - room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
 *   - localParticipant.on('trackPublished'/'trackUnpublished')
 * - Cloudflare:
 *   - room.participants.joined.on('participantJoined'/'participantLeft')
 *   - each participant.on('audioUpdate')
 *   - room.self.on('audioUpdate')
 *
 * @param {Object} params
 * @param {'cloudflare'|'livekit'} [params.provider]
 * @param {any} [params.room]
 * @param {any} [params.localParticipant]
 * @param {Array|any} [params.participants]
 * @param {string} [params.activeProvider]
 * @param {Function} params.onTrackAdded - ({ id, participantId, track, isLocal }) => void
 * @param {Function} params.onTrackRemoved - ({ id, participantId, track, isLocal }) => void
 * @returns {() => void} Idempotent unsubscribe function
 */
export function subscribeToRoomAudio(params) {
  const {
    provider,
    room,
    localParticipant,
    participants,
    activeProvider,
    onTrackAdded,
    onTrackRemoved
  } = params || {}
  const effectiveProvider = provider || detectProvider({ room, localParticipant, participants, activeProvider })

  let isUnsubscribed = false
  const cleanupTasks = []

  // Idempotent unsubscribe executor
  const unsubscribe = () => {
    if (isUnsubscribed) return
    isUnsubscribed = true
    while (cleanupTasks.length > 0) {
      try {
        const cleanup = cleanupTasks.pop()
        if (typeof cleanup === 'function') cleanup()
      } catch (err) {
        console.warn('[ScreenRecorderAudio] Error during audio listener cleanup:', err)
      }
    }
  }

  // ── 1. CLOUDFLARE REALTIMEKIT SUBSCRIPTION PATH ────────────────────────────
  if (effectiveProvider === 'cloudflare') {
    const boundParticipants = new Map() // participantId -> listener cleanup

    const bindParticipantAudioListener = (p) => {
      if (!p || typeof p.on !== 'function') return
      const pId = p.id || p.customParticipantId || 'remote'
      const trackKey = `cf-${pId}-audio`

      // If already bound, skip
      if (boundParticipants.has(pId)) return

      const handleAudioUpdate = (payload) => {
        if (isUnsubscribed) return
        const audioEnabled = payload?.audioEnabled !== undefined ? payload.audioEnabled : p.audioEnabled
        const audioTrack = payload?.audioTrack !== undefined ? payload.audioTrack : p.audioTrack

        if (audioEnabled && audioTrack && isLiveAudioTrack(audioTrack)) {
          onTrackAdded?.({
            id: trackKey,
            participantId: pId,
            track: audioTrack,
            isLocal: false
          })
        } else if (!audioEnabled || !audioTrack || audioTrack.readyState === 'ended') {
          onTrackRemoved?.({
            id: trackKey,
            participantId: pId,
            track: audioTrack || null,
            isLocal: false
          })
        }
      }

      p.on('audioUpdate', handleAudioUpdate)

      const unbindParticipant = () => {
        if (typeof p.off === 'function') {
          p.off('audioUpdate', handleAudioUpdate)
        } else if (typeof p.removeListener === 'function') {
          p.removeListener('audioUpdate', handleAudioUpdate)
        }
      }

      boundParticipants.set(pId, unbindParticipant)
      cleanupTasks.push(unbindParticipant)
    }

    // A. Bind existing participants (from room.participants.joined or participants array)
    const existingJoined = room?.participants?.joined
    if (existingJoined) {
      const list =
        typeof existingJoined.toArray === 'function'
          ? existingJoined.toArray()
          : Array.from(existingJoined.values ? existingJoined.values() : [])
      list.forEach(bindParticipantAudioListener)
    } else if (Array.isArray(participants)) {
      participants.forEach((p) => {
        const raw = p?.rawParticipant || p
        bindParticipantAudioListener(raw)
      })
    }

    // B. Listen for new participants joining and leaving
    if (existingJoined && typeof existingJoined.on === 'function') {
      const handleParticipantJoined = (p) => {
        if (isUnsubscribed || !p) return
        const pId = p.id || p.customParticipantId || 'remote'
        const trackKey = `cf-${pId}-audio`

        bindParticipantAudioListener(p)

        // If participant joins with mic already active
        if (p.audioEnabled && p.audioTrack && isLiveAudioTrack(p.audioTrack)) {
          onTrackAdded?.({
            id: trackKey,
            participantId: pId,
            track: p.audioTrack,
            isLocal: false
          })
        }
      }

      const handleParticipantLeft = (p) => {
        if (isUnsubscribed || !p) return
        const pId = p.id || p.customParticipantId || 'remote'
        const trackKey = `cf-${pId}-audio`

        // Unbind participant audio listener
        const unbind = boundParticipants.get(pId)
        if (unbind) {
          unbind()
          boundParticipants.delete(pId)
        }

        onTrackRemoved?.({
          id: trackKey,
          participantId: pId,
          track: p.audioTrack || null,
          isLocal: false
        })
      }

      const handleParticipantsCleared = () => {
        if (isUnsubscribed) return
        boundParticipants.forEach((unbind, pId) => {
          unbind()
          onTrackRemoved?.({
            id: `cf-${pId}-audio`,
            participantId: pId,
            isLocal: false
          })
        })
        boundParticipants.clear()
      }

      const handleParticipantsUpdate = () => {
        if (isUnsubscribed) return
        const list =
          typeof existingJoined.toArray === 'function'
            ? existingJoined.toArray()
            : Array.from(existingJoined.values ? existingJoined.values() : [])
        list.forEach(bindParticipantAudioListener)
      }

      existingJoined.on('participantJoined', handleParticipantJoined)
      existingJoined.on('participantLeft', handleParticipantLeft)
      try { existingJoined.on('participantsCleared', handleParticipantsCleared) } catch (_) {}
      try { existingJoined.on('participantsUpdate', handleParticipantsUpdate) } catch (_) {}

      cleanupTasks.push(() => {
        if (typeof existingJoined.off === 'function') {
          existingJoined.off('participantJoined', handleParticipantJoined)
          existingJoined.off('participantLeft', handleParticipantLeft)
          existingJoined.off('participantsCleared', handleParticipantsCleared)
          existingJoined.off('participantsUpdate', handleParticipantsUpdate)
        } else if (typeof existingJoined.removeListener === 'function') {
          existingJoined.removeListener('participantJoined', handleParticipantJoined)
          existingJoined.removeListener('participantLeft', handleParticipantLeft)
          existingJoined.removeListener('participantsCleared', handleParticipantsCleared)
          existingJoined.removeListener('participantsUpdate', handleParticipantsUpdate)
        }
      })
    }

    // C. Listen for local microphone toggle on room.self
    const selfObj = room?.self || localParticipant?.rawParticipant || null
    if (selfObj && typeof selfObj.on === 'function') {
      const handleSelfAudioUpdate = (payload) => {
        if (isUnsubscribed) return
        const audioEnabled = payload?.audioEnabled !== undefined ? payload.audioEnabled : selfObj.audioEnabled
        const audioTrack = payload?.audioTrack !== undefined ? payload.audioTrack : selfObj.audioTrack

        if (audioEnabled && audioTrack && isLiveAudioTrack(audioTrack)) {
          onTrackAdded?.({
            id: 'local-mic',
            participantId: selfObj.id || 'local',
            track: audioTrack,
            isLocal: true
          })
        } else if (!audioEnabled || !audioTrack || audioTrack.readyState === 'ended') {
          onTrackRemoved?.({
            id: 'local-mic',
            participantId: selfObj.id || 'local',
            track: audioTrack || null,
            isLocal: true
          })
        }
      }

      selfObj.on('audioUpdate', handleSelfAudioUpdate)
      cleanupTasks.push(() => {
        if (typeof selfObj.off === 'function') {
          selfObj.off('audioUpdate', handleSelfAudioUpdate)
        } else if (typeof selfObj.removeListener === 'function') {
          selfObj.removeListener('audioUpdate', handleSelfAudioUpdate)
        }
      })
    }

    return unsubscribe
  }

  // ── 2. LIVEKIT SUBSCRIPTION PATH ───────────────────────────────────────────
  if (room && typeof room.on === 'function') {
    const handleTrackSubscribed = (track, publication, participant) => {
      if (isUnsubscribed) return
      if (track?.kind === 'audio') {
        const msTrack = track.mediaStreamTrack || track
        if (isLiveAudioTrack(msTrack)) {
          const trackId = track.sid || publication?.trackSid || msTrack.id || `livekit-audio-${Date.now()}`
          const participantId = participant?.identity || participant?.sid || participant?.id || 'remote'
          onTrackAdded?.({
            id: trackId,
            participantId,
            track: msTrack,
            isLocal: false
          })
        }
      }
    }

    const handleTrackUnsubscribed = (track, publication, participant) => {
      if (isUnsubscribed) return
      if (track?.kind === 'audio') {
        const msTrack = track.mediaStreamTrack || track
        const trackId = track.sid || publication?.trackSid || msTrack?.id || 'livekit-audio'
        const participantId = participant?.identity || participant?.sid || participant?.id || 'remote'
        onTrackRemoved?.({
          id: trackId,
          participantId,
          track: msTrack || null,
          isLocal: false
        })
      }
    }

    room.on(LIVEKIT_TRACK_SUBSCRIBED, handleTrackSubscribed)
    room.on(LIVEKIT_TRACK_UNSUBSCRIBED, handleTrackUnsubscribed)

    cleanupTasks.push(() => {
      if (typeof room.off === 'function') {
        room.off(LIVEKIT_TRACK_SUBSCRIBED, handleTrackSubscribed)
        room.off(LIVEKIT_TRACK_UNSUBSCRIBED, handleTrackUnsubscribed)
      } else if (typeof room.removeListener === 'function') {
        room.removeListener(LIVEKIT_TRACK_SUBSCRIBED, handleTrackSubscribed)
        room.removeListener(LIVEKIT_TRACK_UNSUBSCRIBED, handleTrackUnsubscribed)
      }
    })
  }

  // Local microphone publication listener in LiveKit (if unmuting after recording start)
  if (localParticipant && typeof localParticipant.on === 'function') {
    const handleLocalTrackPublished = (publication) => {
      if (isUnsubscribed || !publication) return
      const isMic =
        publication.source === LIVEKIT_MIC_SOURCE ||
        publication.source === 'microphone' ||
        publication.kind === 'audio'

      if (isMic) {
        const track = publication.track?.mediaStreamTrack || publication.track
        if (isLiveAudioTrack(track)) {
          onTrackAdded?.({
            id: publication.trackSid || track.id || 'local-mic',
            participantId: localParticipant.identity || 'local',
            track,
            isLocal: true
          })
        }
      }
    }

    const handleLocalTrackUnpublished = (publication) => {
      if (isUnsubscribed || !publication) return
      const isMic =
        publication.source === LIVEKIT_MIC_SOURCE ||
        publication.source === 'microphone' ||
        publication.kind === 'audio'

      if (isMic) {
        onTrackRemoved?.({
          id: publication.trackSid || 'local-mic',
          participantId: localParticipant.identity || 'local',
          isLocal: true
        })
      }
    }

    localParticipant.on('trackPublished', handleLocalTrackPublished)
    localParticipant.on('trackUnpublished', handleLocalTrackUnpublished)

    cleanupTasks.push(() => {
      if (typeof localParticipant.off === 'function') {
        localParticipant.off('trackPublished', handleLocalTrackPublished)
        localParticipant.off('trackUnpublished', handleLocalTrackUnpublished)
      } else if (typeof localParticipant.removeListener === 'function') {
        localParticipant.removeListener('trackPublished', handleLocalTrackPublished)
        localParticipant.removeListener('trackUnpublished', handleLocalTrackUnpublished)
      }
    })
  }

  return unsubscribe
}

/**
 * Safely creates a MediaStreamAudioSourceNode and connects it to the Web Audio destination node.
 *
 * Requirements:
 * - Only connects tracks with readyState === 'live'.
 * - Prevents duplicate connections using stable track/participant identifiers.
 * - Replaces stale tracks if an existing entry under the same trackKey changed.
 * - Captures connection errors cleanly.
 *
 * @param {Object} params
 * @param {AudioContext} params.audioCtx
 * @param {AudioNode} params.mixDest
 * @param {MediaStreamTrack} params.track
 * @param {string} params.trackKey - Stable identifier (e.g. 'local-mic', 'cf-peer1-audio', 'lk-track-sid')
 * @param {Map<string, { source: AudioNode, track: MediaStreamTrack, trackKey: string }>} params.connectedNodesMap
 * @returns {boolean} true if newly connected or replaced, false if rejected/skipped
 */
export function connectTrackToMixer(params) {
  const {
    audioCtx,
    mixDest,
    track,
    trackKey,
    connectedNodesMap
  } = params || {}
  if (!audioCtx || !mixDest || !track || !trackKey || !connectedNodesMap) {
    return false
  }

  // 1. Enforce live audio track constraint
  if (!isLiveAudioTrack(track)) {
    return false
  }

  // 2. Prevent duplicate connections if the identical track is already connected
  if (connectedNodesMap.has(trackKey)) {
    const existing = connectedNodesMap.get(trackKey)
    if (existing?.track === track) {
      return false // Already connected, duplicate ignored
    }
    // Track reference changed for this key: disconnect old source before connecting new
    try {
      existing?.source?.disconnect()
    } catch (_) {}
    connectedNodesMap.delete(trackKey)
  }

  // 3. Connect new MediaStream source to mix destination
  try {
    const stream = typeof MediaStream !== 'undefined' ? new MediaStream([track]) : { getAudioTracks: () => [track] }
    const sourceNode = audioCtx.createMediaStreamSource(stream)
    sourceNode.connect(mixDest)

    connectedNodesMap.set(trackKey, {
      source: sourceNode,
      track,
      trackKey
    })

    return true
  } catch (err) {
    console.warn(`[ScreenRecorderAudio] Error connecting track ${trackKey} to mixer:`, err)
    return false
  }
}

/**
 * Safely disconnects and removes an audio node from the Web Audio mixer.
 * Idempotent.
 *
 * @param {string} trackKey
 * @param {Map<string, { source: AudioNode, track: MediaStreamTrack, trackKey: string }>} connectedNodesMap
 * @returns {boolean} true if disconnected and removed, false if not found
 */
export function disconnectTrackFromMixer(trackKey, connectedNodesMap) {
  if (!trackKey || !connectedNodesMap || !connectedNodesMap.has(trackKey)) {
    return false
  }

  const entry = connectedNodesMap.get(trackKey)
  connectedNodesMap.delete(trackKey)

  if (entry?.source && typeof entry.source.disconnect === 'function') {
    try {
      entry.source.disconnect()
      return true
    } catch (err) {
      console.warn(`[ScreenRecorderAudio] Error disconnecting node for ${trackKey}:`, err)
      return true
    }
  }

  return true
}

/**
 * Disconnects and removes ALL audio nodes from the Web Audio mixer.
 * Idempotent.
 *
 * @param {Map<string, { source: AudioNode, track: MediaStreamTrack, trackKey: string }>} connectedNodesMap
 */
export function disconnectAllTracksFromMixer(connectedNodesMap) {
  if (!connectedNodesMap) return

  for (const entry of connectedNodesMap.values()) {
    if (entry?.source && typeof entry.source.disconnect === 'function') {
      try {
        entry.source.disconnect()
      } catch (_) {}
    }
  }

  connectedNodesMap.clear()
}
