import React, { useEffect, useRef } from 'react'
import { Pause, Play, Square } from 'lucide-react'

export default function RecordingControlPopover({
  isOpen,
  onClose,
  isPaused,
  isRecording,
  recordingDuration = 0,
  onPause,
  onResume,
  onStop,
  position = 'bottom', // 'top' (under header badge) or 'bottom' (above bottom bar button)
  className = ''
}) {
  const popoverRef = useRef(null)

  // Close on outside click or Escape key
  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        onClose?.()
      }
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose?.()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  const formatDuration = (sec) => {
    const m = Math.floor(sec / 60)
    const s = (sec % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  // Position classes:
  // 'top': placed below the header REC indicator, aligned left/center
  // 'bottom': placed above the bottom bar record button
  const positionClasses =
    position === 'top'
      ? 'absolute top-full mt-2 left-0 sm:left-auto sm:right-0 z-50'
      : 'absolute bottom-16 right-0 sm:left-1/2 sm:-translate-x-1/2 z-50'

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="true"
      aria-label="Recording controls"
      className={`${positionClasses} w-64 bg-[#1e2024]/95 backdrop-blur-xl border border-white/10 rounded-2xl p-3 shadow-2xl flex flex-col gap-2 select-none text-left animate-in fade-in duration-150 ${className}`}
    >
      {/* Popover Header Title (matching Screenshot 3) */}
      <div className="flex items-center justify-between px-2 pt-1 pb-1.5 border-b border-white/5">
        <div className="flex items-center gap-2">
          {isPaused ? (
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
          ) : (
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
          )}
          <span className="text-white text-xs font-semibold tracking-wide">
            {isPaused ? 'Screen recording is paused' : 'Computer recording is on'}
          </span>
        </div>
        <span className="text-gray-400 font-mono text-[11px]">
          {formatDuration(recordingDuration)}
        </span>
      </div>

      {/* Action 1: Pause / Resume recording */}
      {isPaused ? (
        <button
          type="button"
          onClick={() => {
            onResume?.()
            onClose?.()
          }}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 active:bg-white/15 text-white text-xs font-medium transition-colors cursor-pointer group focus:outline-none focus:ring-1 focus:ring-sky-400"
        >
          <div className="w-6 h-6 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 group-hover:scale-105 transition-transform">
            <Play size={14} className="fill-emerald-400" />
          </div>
          <span className="group-hover:text-emerald-300 transition-colors">
            Resume recording
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            onPause?.()
            onClose?.()
          }}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 active:bg-white/15 text-white text-xs font-medium transition-colors cursor-pointer group focus:outline-none focus:ring-1 focus:ring-sky-400"
        >
          <div className="w-6 h-6 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400 group-hover:scale-105 transition-transform">
            <Pause size={14} />
          </div>
          <span className="group-hover:text-amber-300 transition-colors">
            Pause recording
          </span>
        </button>
      )}

      {/* Action 2: Stop recording (matching Screenshot 3 with red square) */}
      <button
        type="button"
        onClick={() => {
          onStop?.()
          onClose?.()
        }}
        className="w-full flex items-center gap-3 px-3 py-2 rounded-xl bg-white/5 hover:bg-red-500/15 active:bg-red-500/20 text-white text-xs font-medium transition-colors cursor-pointer group focus:outline-none focus:ring-1 focus:ring-red-400"
      >
        <div className="w-6 h-6 rounded-lg bg-red-500/10 flex items-center justify-center text-red-500 group-hover:scale-105 transition-transform">
          <Square size={13} className="fill-red-500 text-red-500" />
        </div>
        <span className="text-gray-200 group-hover:text-red-300 transition-colors">
          Stop recording
        </span>
      </button>
    </div>
  )
}
