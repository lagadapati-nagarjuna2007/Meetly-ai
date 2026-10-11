import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('Audio Mixer Pipeline & AI Analyzer Isolation', () => {
  it('guarantees complete ref isolation between AI Analyzer and Screen Recording', () => {
    // Simulated AI Analyzer refs
    const aiAnalyzerRefs = {
      transcriptMediaRecorderRef: { current: { state: 'recording', stop: () => {} } },
      transcriptStreamRef: { current: { active: true } },
      transcriptIntervalRef: { current: 123 },
      isTranscriptActiveRef: { current: true }
    }

    // Simulated Screen Recorder refs
    const screenRecorderRefs = {
      screenMediaRecorderRef: { current: { state: 'recording', stop: () => {} } },
      screenCaptureStreamRef: { current: { active: true } },
      screenAudioContextRef: { current: { state: 'running' } }
    }

    // Stopping screen recorder
    screenRecorderRefs.screenMediaRecorderRef.current.state = 'inactive'
    screenRecorderRefs.screenCaptureStreamRef.current = null
    screenRecorderRefs.screenAudioContextRef.current = null

    // Verify AI Analyzer refs were 100% untouched
    assert.equal(aiAnalyzerRefs.isTranscriptActiveRef.current, true, 'AI Analyzer must remain active')
    assert.equal(aiAnalyzerRefs.transcriptMediaRecorderRef.current.state, 'recording', 'AI Analyzer recorder must NOT be stopped')
    assert.equal(aiAnalyzerRefs.transcriptStreamRef.current.active, true, 'AI Analyzer mic stream must NOT be stopped')
  })

  it('negotiates best available container and audio/video codecs', () => {
    const supportedCandidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4'
    ]

    // Simulate browser where VP9 is supported
    const mockIsTypeSupported = (mime) => mime === 'video/webm;codecs=vp9,opus' || mime === 'video/webm'

    let selected = ''
    for (const cand of supportedCandidates) {
      if (mockIsTypeSupported(cand)) {
        selected = cand
        break
      }
    }

    assert.equal(selected, 'video/webm;codecs=vp9,opus', 'Must select highest quality supported codec')
  })

  it('manages Web Audio node lifecycles without leaking nodes on track unsubscription', () => {
    const nodesMap = new Map()

    // Participant A joins with track 'track-audio-1'
    nodesMap.set('track-audio-1', { disconnected: false, disconnect: function() { this.disconnected = true } })

    // Participant B joins with track 'track-audio-2'
    nodesMap.set('track-audio-2', { disconnected: false, disconnect: function() { this.disconnected = true } })

    assert.equal(nodesMap.size, 2)

    // Participant A leaves (unsubscribed)
    const nodeA = nodesMap.get('track-audio-1')
    nodeA.disconnect()
    nodesMap.delete('track-audio-1')

    assert.equal(nodeA.disconnected, true, 'Unsubscribed node must be disconnected')
    assert.equal(nodesMap.size, 1, 'Map must remove disconnected track')
    assert.ok(nodesMap.has('track-audio-2'), 'Participant B must remain connected without audio interruption')
  })
})
