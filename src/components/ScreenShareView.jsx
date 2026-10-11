import React, { useState, useRef, useEffect, useCallback } from 'react'
import { VideoTrack } from '@livekit/components-react'
import { ZoomIn, ZoomOut, Maximize2, Minimize2 } from 'lucide-react'

// Standard zoom presets matching desktop meeting software
const ZOOM_PRESETS = [50, 67, 75, 90, 100, 125, 150, 175, 200, 250]

export default function ScreenShareView({
  trackRef,
  participant,
  className = ''
}) {
  const containerRef = useRef(null)
  const [zoom, setZoom] = useState(100)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const dragStartRef = useRef({ startX: 0, startY: 0, initialPanX: 0, initialPanY: 0 })

  // Keep fullscreen state in sync with browser
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isCurrentFs = document.fullscreenElement === containerRef.current
      setIsFullscreen(isCurrentFs)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
  }, [])

  // Reset pan whenever zoom is returned to 100% or below
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
        if (containerRef.current?.requestFullscreen) {
          await containerRef.current.requestFullscreen()
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen()
        }
      }
    } catch (err) {
      console.warn('[ScreenShareView] Fullscreen toggle error:', err)
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

    // Calculate maximum pan bounds to prevent content from leaving the viewport
    const container = containerRef.current
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

  // Keyboard accessibility within screen container
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

  const presenterName = participant?.name || participant?.identity || 'User'

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={`relative w-full h-full bg-[#05060b] overflow-hidden select-none outline-none group ${className}`}
    >
      {/* Floating Zoom & Fullscreen Controls (Overlay Matching Screenshot 2) */}
      <div className="absolute top-3 right-3 z-30 flex items-center gap-2 select-none pointer-events-auto">
        {/* Zoom Pill */}
        <div
          className="bg-[#202227]/90 hover:bg-[#202227] backdrop-blur-md border border-white/10 rounded-full px-3 py-1.5 flex items-center gap-2.5 shadow-2xl text-white transition-colors"
          role="toolbar"
          aria-label="Screen share zoom controls"
        >
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={zoom <= 50}
            title="Zoom out"
            aria-label="Zoom out"
            className="text-gray-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer p-0.5 rounded focus:outline-none focus:ring-1 focus:ring-sky-400"
          >
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            onClick={handleResetZoom}
            title="Reset zoom (100%)"
            aria-label={`Current zoom ${zoom}%. Click to reset to 100%`}
            className="text-[#38bdf8] hover:text-sky-300 font-semibold text-xs px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors cursor-pointer font-mono tracking-tight focus:outline-none focus:ring-1 focus:ring-sky-400"
          >
            {zoom}%
          </button>
          <button
            type="button"
            onClick={handleZoomIn}
            disabled={zoom >= 250}
            title="Zoom in"
            aria-label="Zoom in"
            className="text-gray-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer p-0.5 rounded focus:outline-none focus:ring-1 focus:ring-sky-400"
          >
            <ZoomIn size={16} />
          </button>
        </div>

        {/* Circular Fullscreen Button */}
        <button
          type="button"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
          aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
          className="bg-[#2c3038]/90 hover:bg-[#393e48] backdrop-blur-md border border-white/10 rounded-full p-2.5 text-white shadow-2xl transition-all cursor-pointer flex items-center justify-center focus:outline-none focus:ring-1 focus:ring-sky-400"
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>

      {/* Screen Share Content Area with Zoom & Pan Transform */}
      <div
        className="w-full h-full flex items-center justify-center overflow-hidden touch-none"
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
          <VideoTrack
            trackRef={trackRef}
            className="w-full h-full object-contain bg-black pointer-events-none"
          />
        </div>
      </div>

      {/* Presenter Attribution Badge */}
      <div className="absolute bottom-3 left-3 px-3 py-1.5 rounded-xl bg-black/60 backdrop-blur-md border border-white/5 text-[10px] font-bold text-white z-10 pointer-events-none shadow-md">
        {presenterName}'s Presentation
      </div>
    </div>
  )
}
