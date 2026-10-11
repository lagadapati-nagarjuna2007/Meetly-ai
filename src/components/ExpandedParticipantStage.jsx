import React, { useState, useRef, useEffect, useCallback } from 'react'
import { VideoTrack } from '@livekit/components-react'
import { Track } from 'livekit-client'
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  ArrowLeft,
  LayoutGrid,
  RotateCcw,
  VideoOff
} from 'lucide-react'

const ZOOM_PRESETS = [50, 67, 75, 90, 100, 125, 150, 175, 200, 250]

export default function ExpandedParticipantStage({
  participant,
  allParticipants = [],
  localParticipant,
  user,
  onClose,
  onSelectParticipant,
  camInitializing = false,
  camError = null,
  onRetryCam,
  raisedHandsMap = {},
  participantStatusMap = {},
  activeReactionsMap = {}
}) {
  const stageRef = useRef(null)
  const [zoom, setZoom] = useState(100)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const dragStartRef = useRef({ startX: 0, startY: 0, initialPanX: 0, initialPanY: 0 })

  // Reset zoom & pan when switching participants
  useEffect(() => {
    setZoom(100)
    setPan({ x: 0, y: 0 })
  }, [participant?.identity])

  // Fullscreen event listener
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === stageRef.current)
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
      return next !== undefined ? next : Math.min(250, prev + 25)
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
        if (stageRef.current?.requestFullscreen) {
          await stageRef.current.requestFullscreen()
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen()
        }
      }
    } catch (err) {
      console.warn('[ExpandedParticipantStage] Fullscreen error:', err)
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

    const container = stageRef.current
    const boundX = container ? (container.clientWidth * (zoom / 100 - 1)) / 2 + 100 : 300
    const boundY = container ? (container.clientHeight * (zoom / 100 - 1)) / 2 + 100 : 300

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

  // Keyboard navigation
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (document.fullscreenElement) {
        document.exitFullscreen()
      } else {
        onClose?.()
      }
    } else if (e.key === '+' || e.key === '=') {
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
  const isHandRaised = Boolean(raisedHandsMap[participant?.identity])
  const isAway = participantStatusMap[participant?.identity] === 'be_right_back'
  const activeReaction = activeReactionsMap[participant?.identity]

  return (
    <div
      ref={stageRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="relative w-full h-full flex flex-col bg-[#05060b] select-none outline-none overflow-hidden rounded-2xl border border-white/5 shadow-2xl"
    >
      {/* Top Header Bar */}
      <div className="h-14 px-4 bg-slate-950/80 backdrop-blur-md border-b border-white/5 flex items-center justify-between z-30 shrink-0">
        {/* Left: Back to Grid Button & Participant Info */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 active:bg-white/15 text-white text-xs font-semibold border border-white/10 transition-colors cursor-pointer group"
            title="Return to multi-participant grid (Esc)"
          >
            <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
            <LayoutGrid size={14} />
            <span>Back to Grid</span>
          </button>

          <div className="h-4 w-[1px] bg-white/10 hidden sm:block" />

          {/* Participant Label */}
          <div className="flex items-center gap-2">
            <span className="text-white text-xs font-bold truncate max-w-[180px] sm:max-w-xs">
              Viewing {displayName} {isCurrentUser && ' (You)'} {role === 'host' && ' (Host)'}
            </span>
            {isHandRaised && <span className="text-amber-400 text-sm">✋</span>}
            {isAway && <span className="text-amber-400 text-xs font-semibold">[Away]</span>}
          </div>
        </div>

        {/* Right: Floating Zoom & Fullscreen Toolbar (Screenshot 2 Styling) */}
        <div className="flex items-center gap-2">
          {/* Zoom Pill */}
          <div
            className="bg-[#202227]/90 hover:bg-[#202227] backdrop-blur-md border border-white/10 rounded-full px-3 py-1.5 flex items-center gap-2.5 shadow-xl text-white transition-colors"
            role="toolbar"
            aria-label="Expanded video zoom controls"
          >
            <button
              type="button"
              onClick={handleZoomOut}
              disabled={zoom <= 50}
              title="Zoom out (−)"
              aria-label="Zoom out"
              className="text-gray-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors p-0.5 rounded cursor-pointer"
            >
              <ZoomOut size={15} />
            </button>

            <button
              type="button"
              onClick={handleResetZoom}
              title="Reset zoom to 100% (0)"
              aria-label={`Current zoom ${zoom}%. Click to reset`}
              className="text-[#38bdf8] hover:text-sky-300 font-semibold text-xs px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors font-mono tracking-tight cursor-pointer"
            >
              {zoom}%
            </button>

            <button
              type="button"
              onClick={handleZoomIn}
              disabled={zoom >= 250}
              title="Zoom in (+)"
              aria-label="Zoom in"
              className="text-gray-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors p-0.5 rounded cursor-pointer"
            >
              <ZoomIn size={15} />
            </button>

            <div className="w-[1px] h-3.5 bg-white/15 mx-0.5" />

            <button
              type="button"
              onClick={handleResetZoom}
              title="Reset Zoom & Pan"
              aria-label="Reset zoom and pan"
              className="text-gray-400 hover:text-white transition-colors p-0.5 rounded cursor-pointer"
            >
              <RotateCcw size={13} />
            </button>
          </div>

          {/* Fullscreen Button */}
          <button
            type="button"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
            aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
            className="bg-[#2c3038]/90 hover:bg-[#393e48] backdrop-blur-md border border-white/10 rounded-full p-2.5 text-white shadow-xl transition-colors cursor-pointer flex items-center justify-center"
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </div>

      {/* Main Central Viewing Area with Zoom & Pan */}
      <div
        className="flex-1 w-full h-full relative overflow-hidden flex items-center justify-center bg-black touch-none"
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
              className="w-full h-full object-contain bg-black pointer-events-none"
            />
          ) : isCurrentUser && camInitializing ? (
            <div className="w-full h-full bg-slate-950 flex flex-col items-center justify-center gap-3">
              <div className="w-10 h-10 rounded-full border-2 border-white/10 border-t-purple-500 animate-spin" />
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
                Starting camera...
              </span>
            </div>
          ) : isCurrentUser && camError ? (
            <div className="w-full h-full bg-slate-950 flex flex-col items-center justify-center gap-3 px-4">
              <VideoOff size={36} className="text-red-400/60" />
              <span className="text-xs font-semibold text-red-400/80 text-center max-w-[260px]">
                {camError}
              </span>
              {onRetryCam && (
                <button
                  type="button"
                  onClick={onRetryCam}
                  className="mt-1 px-4 py-1.5 rounded-xl bg-purple-600/20 border border-purple-500/30 text-xs font-bold text-purple-300 hover:bg-purple-600/30 transition-colors cursor-pointer"
                >
                  Retry Camera
                </button>
              )}
            </div>
          ) : (
            <div className="w-full h-full bg-slate-950 flex flex-col items-center justify-center gap-3">
              <div className="w-24 h-24 rounded-full bg-[#7c3aed]/10 border border-[#7c3aed]/20 flex items-center justify-center text-[#8b5cf6] font-bold text-3xl shadow-2xl">
                {displayName?.charAt(0).toUpperCase() || 'P'}
              </div>
              <span className="text-gray-400 text-xs font-medium">Camera is turned off</span>
            </div>
          )}
        </div>

        {/* Signal Quality Overlay (Top Left) */}
        <div className="absolute top-4 left-4 z-20 pointer-events-none">
          <span className="px-2.5 py-1 rounded-lg bg-black/75 backdrop-blur-md border border-white/10 text-[10px] font-bold uppercase tracking-wider text-gray-300 flex items-center gap-1.5 shadow-lg">
            <span
              className={`w-2 h-2 rounded-full ${
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

        {/* Hand Raised Banner Overlay */}
        {isHandRaised && (
          <div className="absolute top-4 right-4 z-20 px-3 py-1.5 rounded-full bg-amber-500/95 border border-amber-300 text-slate-950 font-extrabold text-xs shadow-xl animate-bounce flex items-center gap-1.5 pointer-events-none">
            <span>✋</span>
            <span>Hand Raised</span>
          </div>
        )}

        {/* Be Right Back Overlay */}
        {isAway && (
          <div className="absolute inset-0 z-20 bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center gap-3 p-6 text-center select-none pointer-events-none">
            <span className="text-5xl animate-pulse">⌛</span>
            <span className="text-sm font-bold text-amber-300 tracking-wider uppercase">
              Be Right Back
            </span>
            <span className="text-xs text-gray-400 font-medium">{displayName} is temporarily away</span>
          </div>
        )}

        {/* Floating Reaction Overlay */}
        {activeReaction && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 px-4 py-2 rounded-3xl bg-black/85 border border-purple-500/50 text-white font-bold text-5xl shadow-2xl animate-bounce pointer-events-none">
            {activeReaction}
          </div>
        )}
      </div>

      {/* Bottom Filmstrip: Quick Participant Switcher */}
      <div className="h-20 bg-[#0a0c16]/95 backdrop-blur-md border-t border-white/5 px-4 flex items-center gap-3 overflow-x-auto shrink-0 z-30 select-none">
        <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest shrink-0 hidden sm:inline">
          Participants ({allParticipants.length}):
        </span>

        {allParticipants.map((p) => {
          const isSelected = p.identity === participant?.identity
          const isCurrent = p.identity === localParticipant?.identity
          const pName = isCurrent
            ? (user?.name || user?.full_name || p.name || 'You')
            : (p.name || 'Participant')

          return (
            <button
              key={p.sid || p.identity}
              type="button"
              onClick={() => onSelectParticipant?.(p.identity)}
              className={`h-14 px-3 rounded-xl border flex items-center gap-2.5 transition-all cursor-pointer shrink-0 ${
                isSelected
                  ? 'bg-purple-600/20 border-purple-500 text-white shadow-lg shadow-purple-600/20'
                  : 'bg-white/5 hover:bg-white/10 border-white/5 text-gray-300 hover:text-white'
              }`}
              title={`Switch view to ${pName}`}
            >
              <div className="w-8 h-8 rounded-full bg-slate-800 border border-white/10 flex items-center justify-center text-xs font-bold text-purple-400 shrink-0">
                {pName.charAt(0).toUpperCase()}
              </div>
              <div className="flex flex-col text-left">
                <span className="text-xs font-semibold truncate max-w-[110px]">
                  {pName} {isCurrent && '(You)'}
                </span>
                <span className="text-[9px] text-gray-400 flex items-center gap-1">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      p.isCameraEnabled ? 'bg-emerald-400' : 'bg-gray-500'
                    }`}
                  />
                  {p.isCameraEnabled ? 'Cam On' : 'Cam Off'}
                  {raisedHandsMap[p.identity] && <span>✋</span>}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
