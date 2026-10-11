import React, { useState, useRef, useEffect, useCallback } from 'react'
import { VideoTrack } from '@livekit/components-react'
import { Track } from 'livekit-client'
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  VideoOff,
  RotateCcw
} from 'lucide-react'

const ZOOM_PRESETS = [50, 75, 100, 125, 150, 175, 200]

export default function ParticipantVideoTile({
  participant,
  localParticipant,
  user,
  camInitializing = false,
  camError = null,
  onRetryCam,
  raisedHand = false,
  status = null,
  activeReaction = null,
  onExpand,
  className = ''
}) {
  const containerRef = useRef(null)
  const [zoom, setZoom] = useState(100)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const dragStartRef = useRef({ startX: 0, startY: 0, initialPanX: 0, initialPanY: 0 })

  // Fullscreen state synchronization
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
  }, [])

  // Reset pan when zoom returns to 100% or below
  useEffect(() => {
    if (zoom <= 100) {
      setPan({ x: 0, y: 0 })
    }
  }, [zoom])

  const handleZoomIn = useCallback(() => {
    setZoom((prev) => {
      const next = ZOOM_PRESETS.find((z) => z > prev)
      return next !== undefined ? next : Math.min(200, prev + 25)
    })
  }, [])

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => {
      const prevPresets = ZOOM_PRESETS.filter((z) => z < prev)
      const next = prevPresets.length > 0 ? prevPresets[prevPresets.length - 1] : 50
      return Math.max(50, next)
    })
  }, [])

  const handleResetZoom = useCallback(() => {
    setZoom(100)
    setPan({ x: 0, y: 0 })
  }, [])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        if (containerRef.current?.requestFullscreen) {
          await containerRef.current.requestFullscreen()
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen()
        }
      }
    } catch (err) {
      console.warn('[ParticipantVideoTile] Fullscreen error:', err)
    }
  }, [])

  // Pointer panning handlers (active only when zoom > 100%)
  const handlePointerDown = (e) => {
    if (zoom <= 100 || e.button !== 0) return
    setIsDragging(true)
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialPanX: pan.x,
      initialPanY: pan.y
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch (_) {}
  }

  const handlePointerMove = (e) => {
    if (!isDragging || zoom <= 100) return
    const dx = e.clientX - dragStartRef.current.startX
    const dy = e.clientY - dragStartRef.current.startY

    const container = containerRef.current
    const boundX = container ? (container.clientWidth * (zoom / 100 - 1)) / 2 + 50 : 200
    const boundY = container ? (container.clientHeight * (zoom / 100 - 1)) / 2 + 50 : 200

    const nextX = Math.max(-boundX, Math.min(boundX, dragStartRef.current.initialPanX + dx))
    const nextY = Math.max(-boundY, Math.min(boundY, dragStartRef.current.initialPanY + dy))

    setPan({ x: nextX, y: nextY })
  }

  const handlePointerUp = (e) => {
    if (isDragging) {
      setIsDragging(false)
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId)
        }
      } catch (_) {}
    }
  }

  // Keyboard zoom controls
  const handleKeyDown = (e) => {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      handleZoomIn()
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      handleZoomOut()
    } else if (e.key === '0') {
      e.preventDefault()
      handleResetZoom()
    }
  }

  // Determine metadata role
  let role = 'participant'
  try {
    const meta = JSON.parse(participant?.metadata || '{}')
    role = meta.role || 'participant'
  } catch (_) {}

  const isCurrentUser = participant?.identity === localParticipant?.identity
  const displayName = isCurrentUser
    ? (user?.name || user?.full_name || participant?.name || 'You')
    : (participant?.name || 'Participant')

  const isCameraEnabled = Boolean(participant?.isCameraEnabled)

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={`bg-slate-900/60 rounded-2xl border border-white/5 relative overflow-hidden flex flex-col justify-end items-center group shadow-xl min-h-[220px] select-none outline-none ${className}`}
    >
      {/* Video / Avatar Container with CSS transform */}
      <div
        className="absolute inset-0 w-full h-full flex items-center justify-center overflow-hidden touch-none"
        style={{
          cursor: zoom > 100 ? (isDragging ? 'grabbing' : 'grab') : 'default'
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div
          className="w-full h-full flex items-center justify-center"
          style={{
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0px) scale(${zoom / 100})`,
            transformOrigin: 'center center',
            transition: isDragging ? 'none' : 'transform 0.15s cubic-bezier(0.2, 0, 0, 1)'
          }}
        >
          {isCameraEnabled ? (
            <VideoTrack
              trackRef={{ participant, source: Track.Source.Camera }}
              className="w-full h-full object-cover pointer-events-none"
            />
          ) : isCurrentUser && camInitializing ? (
            <div className="w-full h-full bg-slate-950 flex flex-col items-center justify-center gap-3">
              <div className="w-8 h-8 rounded-full border-2 border-white/10 border-t-purple-500 animate-spin" />
              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">
                Starting camera...
              </span>
            </div>
          ) : isCurrentUser && camError ? (
            <div className="w-full h-full bg-slate-950 flex flex-col items-center justify-center gap-3 px-4">
              <VideoOff size={28} className="text-red-400/60" />
              <span className="text-[10px] font-semibold text-red-400/80 text-center max-w-[200px]">
                {camError}
              </span>
              {onRetryCam && (
                <button
                  type="button"
                  onClick={onRetryCam}
                  className="mt-1 px-3 py-1 rounded-lg bg-purple-600/20 border border-purple-500/30 text-[10px] font-bold text-purple-300 hover:bg-purple-600/30 transition-colors cursor-pointer"
                >
                  Retry Camera
                </button>
              )}
            </div>
          ) : (
            <div className="w-full h-full bg-slate-950 flex flex-col items-center justify-center">
              <div className="w-16 h-16 rounded-full bg-[#7c3aed]/10 border border-[#7c3aed]/20 flex items-center justify-center text-[#8b5cf6] font-bold text-lg">
                {displayName?.charAt(0).toUpperCase() || 'P'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Floating Viewing Controls Pill (Available to EVERY participant on EVERY tile) */}
      <div className="absolute top-2.5 right-2.5 z-25 flex items-center gap-1.5 select-none pointer-events-auto">
        <div
          className="bg-[#181a20]/90 hover:bg-[#181a20] backdrop-blur-md border border-white/10 rounded-full px-2 py-1 flex items-center gap-1 shadow-2xl text-white transition-all"
          role="toolbar"
          aria-label={`${displayName}'s video controls`}
        >
          {/* Zoom Out Button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              handleZoomOut()
            }}
            disabled={zoom <= 50}
            title="Zoom out"
            aria-label="Zoom out"
            className="text-gray-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors p-1 rounded-full hover:bg-white/10 cursor-pointer focus:outline-none"
          >
            <ZoomOut size={13} />
          </button>

          {/* Zoom Level Indicator & Reset */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              handleResetZoom()
            }}
            title="Click to reset zoom (100%)"
            aria-label={`Current zoom ${zoom}%. Click to reset`}
            className="text-[#38bdf8] hover:text-sky-300 font-semibold text-[11px] px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors font-mono tracking-tight cursor-pointer focus:outline-none"
          >
            {zoom}%
          </button>

          {/* Zoom In Button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              handleZoomIn()
            }}
            disabled={zoom >= 200}
            title="Zoom in"
            aria-label="Zoom in"
            className="text-gray-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors p-1 rounded-full hover:bg-white/10 cursor-pointer focus:outline-none"
          >
            <ZoomIn size={13} />
          </button>

          <div className="w-[1px] h-3 bg-white/15 mx-0.5" />

          {/* View / Expand Button */}
          {onExpand && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onExpand(participant?.identity)
              }}
              title="View & Expand video"
              aria-label={`View and expand ${displayName}'s video`}
              className="text-gray-300 hover:text-white transition-colors p-1 rounded-full hover:bg-white/10 cursor-pointer flex items-center gap-0.5 focus:outline-none"
            >
              <Maximize2 size={13} />
            </button>
          )}

          {/* Fullscreen Button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              toggleFullscreen()
            }}
            title={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
            aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
            className="text-gray-300 hover:text-white transition-colors p-1 rounded-full hover:bg-white/10 cursor-pointer focus:outline-none"
          >
            {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </div>
      </div>

      {/* Signal Quality Status (Top Left) */}
      <div className="absolute top-2.5 left-2.5 flex flex-col gap-1 z-15 text-[9px] font-bold uppercase tracking-wider pointer-events-none">
        <span className="px-2 py-1 rounded bg-black/70 backdrop-blur-sm border border-white/10 flex items-center gap-1.5 text-gray-300 shadow-md">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              participant?.connectionQuality === 'excellent'
                ? 'bg-emerald-500'
                : participant?.connectionQuality === 'good'
                ? 'bg-yellow-500'
                : participant?.connectionQuality === 'poor'
                ? 'bg-red-500'
                : 'bg-gray-500'
            }`}
          />
          <span>Signal: {participant?.connectionQuality || 'good'}</span>
        </span>
      </div>

      {/* Raised Hand Badge */}
      {raisedHand && (
        <div className="absolute top-11 right-2.5 z-20 px-2.5 py-1 rounded-full bg-amber-500/90 border border-amber-300 text-slate-950 font-extrabold text-[10px] shadow-lg animate-bounce flex items-center gap-1 pointer-events-none">
          <span>✋</span>
          <span>Hand Raised</span>
        </div>
      )}

      {/* Be Right Back Overlay */}
      {status === 'be_right_back' && (
        <div className="absolute inset-0 z-20 bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center gap-2 p-4 text-center select-none pointer-events-none">
          <span className="text-3xl animate-pulse">⌛</span>
          <span className="text-xs font-bold text-amber-300 tracking-wider uppercase">
            Be Right Back
          </span>
          <span className="text-[10px] text-gray-400 font-medium">
            {displayName} is temporarily away
          </span>
        </div>
      )}

      {/* Floating Reaction Animation Overlay */}
      {activeReaction && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-20 px-3.5 py-1.5 rounded-2xl bg-black/80 border border-purple-500/50 text-white font-bold text-3xl shadow-2xl animate-bounce pointer-events-none">
          {activeReaction}
        </div>
      )}

      {/* Name Tag Bottom Bar */}
      <div className="absolute bottom-2.5 left-2.5 px-3 py-1.5 rounded-xl bg-black/60 backdrop-blur-md border border-white/5 text-[10px] font-bold text-white z-15 flex items-center gap-1.5 pointer-events-none shadow-md">
        <span>
          {displayName} {isCurrentUser && ' (You)'} {role === 'host' && ' (Host)'}
        </span>
        {raisedHand && <span className="text-amber-400">✋</span>}
        {status === 'be_right_back' && <span className="text-amber-400">⌛</span>}
      </div>
    </div>
  )
}
