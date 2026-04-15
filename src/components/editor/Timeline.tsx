import { useState, useRef, useCallback, useEffect, useMemo, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import { useRouter } from '@tanstack/react-router'
import type { EditorData, Keyframe, Transition, Beat, Section } from '@/routes/project/$name/editor'
import type { UserEffect, BeatSuppression, AudioEvent, EffectType } from '@/lib/beatlab-client'
import { updateKeyframeTimestamp, secondsToTimestamp, addKeyframe, duplicateKeyframe, deleteKeyframe, batchDeleteKeyframes, deleteTransition, saveEffects, updateTransitionRemap, generateTransitionAction, generateTransitionCandidates, getAudioIntelligenceData, getTimelineData, restoreKeyframe } from '@/routes/project/$name/editor'
import { useBeatlabSocket } from '@/hooks/useBeatlabSocket'
import { fetchMarkers, postAddMarker, postUpdateMarker, postRemoveMarker, postUpdateTrack, postAddTrack, type Track } from '@/lib/beatlab-client'
import { applyRulesClient, type OnsetData } from '@/lib/apply-rules-client'
import { AudioTrack } from './AudioTrack'
import { beatlabFileUrl } from '@/lib/beatlab-client'
import { VideoTrack } from './VideoTrack'
import { TransitionTrack } from './TransitionTrack'
import { Playhead } from './Playhead'
import { KeyframePanel, preloadStills } from './KeyframePanel'
import { BinPanel, type PoolSelection } from './BinPanel'
import { TransitionPanel } from './TransitionPanel'
import { BeatEffectPreview, type BeatEffectPreviewHandle } from './BeatEffectPreview'
import { matchesHotkey, handlePreventDefault } from '@/lib/hotkeys'
import { useEditorState } from './EditorStateContext'
import { TransformHandles } from './TransformHandles'
import { recordPreview } from '@/lib/preview-recorder'
import { preloadTransition, preloadKeyframeImage, getFrameAtProgress, getFrames, isLoaded, isInMemory, getLoadProgress, setPreviewResolution, setKeyTimestamp, setPlayheadPosition, setEvictionProtectWindow, setMaxConcurrentPreloads, invalidateEntry } from '@/lib/frame-cache'
import { evaluateCurve } from '@/lib/remap-curve'
import { ImportDialog } from './ImportDialog'
import { EffectsTrack } from './EffectsTrack'
import { SuppressionTrack } from './SuppressionTrack'
import { RulesTrack, type RuleSection } from './RulesTrack'
import { EffectEditor } from './EffectEditor'
import { VersionHistoryPanel } from './VersionHistoryPanel'
import { CheckpointsPanel } from './CheckpointsPanel'
import { TimelineSwitcher } from './TimelineSwitcher'
import { NarrativeSectionPanel } from './NarrativeSectionPanel'
import { SettingsPanel } from './SettingsPanel'
import { LogPanel } from './LogPanel'
import { AudioDescriptionTrack } from './AudioDescriptionTrack'
import { KeyframeSuggestPanel } from './KeyframeSuggestPanel'



const TrackHeader = memo(function TrackHeader({ track, isActive, scrollLeft, onSelect, onUpdate, onOpenSettings, onMoveUp, onMoveDown }: {
  track: Track
  isActive: boolean
  scrollLeft: number
  onSelect: () => void
  onUpdate: (updates: Partial<Pick<Track, 'name' | 'blendMode' | 'baseOpacity' | 'enabled'>>) => void
  onOpenSettings?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
}) {
  return (
    <div
      className={`relative h-6 border-b shrink-0 cursor-pointer ${isActive ? 'bg-blue-900/15 border-blue-500/40' : 'bg-gray-950/50 border-gray-800'}`}
      onClick={onSelect}
    >
      <div className="absolute top-0 h-full flex items-center gap-1.5 px-2 z-[5] bg-inherit" style={{ left: scrollLeft }}>
      <button
        onClick={(e) => { e.stopPropagation(); onUpdate({ enabled: !track.enabled }) }}
        className={`text-[10px] w-4 h-4 flex items-center justify-center rounded ${track.enabled ? 'text-green-400' : 'text-gray-600'}`}
        title={track.enabled ? 'Disable track' : 'Enable track'}
      >{track.enabled ? '●' : '○'}</button>

      <span className="text-[10px] text-gray-400 font-medium truncate">{track.name}</span>

      <button
        onClick={(e) => { e.stopPropagation(); onOpenSettings?.() }}
        className="text-[10px] text-gray-500 hover:text-gray-300"
        title="Track settings"
      >⚙</button>

      {onMoveUp && <button onClick={(e) => { e.stopPropagation(); onMoveUp() }} className="text-[10px] text-gray-500 hover:text-gray-300" title="Move track up">▲</button>}
      {onMoveDown && <button onClick={(e) => { e.stopPropagation(); onMoveDown() }} className="text-[10px] text-gray-500 hover:text-gray-300" title="Move track down">▼</button>}

      <button
        onClick={(e) => { e.stopPropagation(); onUpdate({ hidden: true } as never) }}
        className="text-[10px] text-gray-500 hover:text-gray-300"
        title="Hide track"
      >⊘</button>
      </div>
    </div>
  )
})

const MarkerTrack = memo(function MarkerTrack({ markers, pxPerSec, scrollLeft, viewportWidth, onAdd, onRemove, onUpdate, sectionMarkers, onSectionMarkerClick }: {
  markers: { id: string; time: number; label: string; type?: string }[]
  pxPerSec: number
  scrollLeft: number
  viewportWidth: number
  onAdd: (time: number) => void
  onRemove: (id: string) => void
  onUpdate: (id: string, updates: { label?: string; type?: string }) => void
  sectionMarkers?: { id: string; time: number; label: string; notes?: string }[]
  onSectionMarkerClick?: (sectionId: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editType, setEditType] = useState<string>('note')
  const BUFFER_PX = 300

  return (
    <div
      className="relative h-5 shrink-0 border-b border-gray-800 cursor-crosshair"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - rect.left
        const time = x / pxPerSec
        onAdd(time)
      }}
    >
      <div className="sticky left-0 top-0 px-2 py-0.5 text-[10px] text-gray-600 uppercase tracking-wider z-10 bg-gray-950/80 w-fit pointer-events-none">
        Markers
      </div>
      {markers.map((m) => {
        const x = m.time * pxPerSec
        if (x < scrollLeft - BUFFER_PX || x > scrollLeft + viewportWidth + BUFFER_PX) return null
        const isEditing = editingId === m.id
        return (
          <div key={m.id} className="absolute top-0 h-full group" style={{ left: x - 5 }}>
            <div
              className="w-[10px] h-full cursor-pointer pointer-events-auto relative flex flex-col items-center"
              onClick={(e) => {
                e.stopPropagation()
                setEditingId(m.id)
                setEditText(m.label)
                setEditType(m.type || 'note')
              }}
              onDoubleClick={(e) => {
                e.stopPropagation()
                onRemove(m.id)
              }}
            >
              {/* Wedge/triangle marker — color by type */}
              <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
                <polygon points="5,10 0,0 10,0" fill="currentColor" className={m.type === 'todo' ? 'text-green-500/80 group-hover:text-green-400' : m.type === 'section' ? 'text-blue-500/80 group-hover:text-blue-400' : 'text-amber-500/80 group-hover:text-amber-400'} />
              </svg>
              {/* Vertical line from tip */}
              <div className={`w-px flex-1 ${m.type === 'todo' ? 'bg-green-500/40 group-hover:bg-green-400/60' : m.type === 'section' ? 'bg-blue-500/40 group-hover:bg-blue-400/60' : 'bg-amber-500/40 group-hover:bg-amber-400/60'}`} />
              {/* Hover tooltip */}
              {!isEditing && m.label && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-gray-800 text-[10px] text-gray-300 px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none max-w-[200px] truncate">
                  {m.label}
                </div>
              )}
            </div>
            {/* Edit popover */}
            {isEditing && (
              <div className="absolute top-full left-0 mt-0.5 z-[100] pointer-events-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-2 w-48 space-y-1.5" onClick={(e) => e.stopPropagation()}>
                {/* Type selector */}
                <div className="flex gap-1">
                  {(['note', 'todo', 'section'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => { setEditType(t); onUpdate(m.id, { type: t }) }}
                      className={`flex-1 text-[10px] py-0.5 rounded capitalize ${editType === t ? 'bg-amber-500/30 text-amber-300 border border-amber-500/50' : 'bg-gray-700/50 text-gray-400 hover:text-gray-300 border border-transparent'}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                {/* Notes input */}
                <div className="text-[9px] text-gray-500 uppercase tracking-wider">Notes</div>
                <input
                  type="text"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { onUpdate(m.id, { label: editText, type: editType }); setEditingId(null) }
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={(e) => {
                    // Don't close if clicking within the popover (e.g., type buttons)
                    if (e.relatedTarget && (e.currentTarget.parentElement?.contains(e.relatedTarget as Node))) return
                    onUpdate(m.id, { label: editText }); setEditingId(null)
                  }}
                  autoFocus
                  className="bg-gray-900 text-xs text-gray-300 border border-gray-600 rounded px-1.5 py-0.5 w-full focus:outline-none focus:border-amber-500"
                  placeholder="Add notes..."
                />
              </div>
            )}
          </div>
        )
      })}
      {/* Blue section markers */}
      {sectionMarkers?.map((sm) => {
        const x = sm.time * pxPerSec
        if (x < scrollLeft - BUFFER_PX || x > scrollLeft + viewportWidth + BUFFER_PX) return null
        return (
          <div key={`sec-${sm.id}`} className="absolute top-0 h-full group/sec" style={{ left: x - 5 }}>
            <div
              className="w-[10px] h-full cursor-pointer pointer-events-auto relative flex flex-col items-center"
              onClick={(e) => { e.stopPropagation(); onSectionMarkerClick?.(sm.id) }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
                <polygon points="5,10 0,0 10,0" fill="currentColor" className="text-blue-500/80 group-hover/sec:text-blue-400" />
              </svg>
              <div className="w-px flex-1 bg-blue-500/40 group-hover/sec:bg-blue-400/60" />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover/sec:block bg-gray-800 text-[10px] px-2 py-1 rounded shadow-lg z-50 pointer-events-none max-w-[250px]">
                <div className="text-blue-300 font-medium truncate">{sm.label}</div>
                {sm.notes && <div className="text-gray-400 whitespace-pre-wrap mt-0.5">{sm.notes}</div>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
})

function fmtTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`
}

function DownloadPreviewPanel({ currentTime, duration, recording, onRecord, onClose }: {
  currentTime: number
  duration: number
  recording: { progress: number } | null
  onRecord: (startTime: number, endTime: number) => void
  onClose: () => void
}) {
  const [startInput, setStartInput] = useState(fmtTimestamp(currentTime))
  const [endInput, setEndInput] = useState(fmtTimestamp(Math.min(currentTime + 30, duration)))

  const parseMmSs = (val: string): number | null => {
    const parts = val.split(':')
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10)
      const s = parseFloat(parts[1])
      if (!isNaN(m) && !isNaN(s)) return m * 60 + s
    }
    const n = parseFloat(val)
    return isNaN(n) ? null : n
  }

  const startSec = parseMmSs(startInput)
  const endSec = parseMmSs(endInput)
  const valid = startSec !== null && endSec !== null && endSec > startSec && startSec >= 0 && endSec <= duration
  const rangeDuration = valid ? (endSec! - startSec!) : 0

  return (
    <div className="w-72 shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <span className="text-xs text-gray-400 uppercase tracking-wider font-medium">Download Preview</span>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">&times;</button>
      </div>
      <div className="p-3 space-y-3">
        <div className="text-[10px] text-gray-500">
          Records the preview canvas + audio as a WebM file. Enter times in M:SS.f format.
        </div>

        <div className="space-y-2">
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Start Time</label>
            <input
              type="text"
              value={startInput}
              onChange={(e) => setStartInput(e.target.value)}
              placeholder="0:00.0"
              className="w-full bg-gray-800 text-sm text-gray-300 rounded px-2 py-1.5 border border-gray-700 focus:border-green-500 focus:outline-none font-mono"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">End Time</label>
            <input
              type="text"
              value={endInput}
              onChange={(e) => setEndInput(e.target.value)}
              placeholder="0:30.0"
              className="w-full bg-gray-800 text-sm text-gray-300 rounded px-2 py-1.5 border border-gray-700 focus:border-green-500 focus:outline-none font-mono"
            />
          </div>
        </div>

        {valid && (
          <div className="text-[10px] text-gray-500">
            Duration: {rangeDuration.toFixed(1)}s
          </div>
        )}

        {!valid && startInput && endInput && (
          <div className="text-[10px] text-red-400">
            Invalid range. End must be after start, both within 0 - {fmtTimestamp(duration)}.
          </div>
        )}

        <button
          onClick={() => { if (valid) onRecord(startSec!, endSec!) }}
          disabled={!valid || recording !== null}
          className="w-full text-xs bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-2 rounded transition-colors"
        >
          {recording ? `Recording... ${Math.round(recording.progress * 100)}%` : 'Record & Download'}
        </button>

        {recording && (
          <div className="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden">
            <div className="h-full bg-green-500 transition-[width] duration-200" style={{ width: `${recording.progress * 100}%` }} />
          </div>
        )}

        <div className="text-[10px] text-gray-600 space-y-1">
          <div>Playback will start at the start time and record until the end time.</div>
          <div>Output: WebM (VP9 + Opus) at preview resolution.</div>
        </div>
      </div>
    </div>
  )
}

function parseTimestamp(ts: string | number): number {
  if (typeof ts === 'number') return ts
  const s = String(ts)
  const parts = s.split(':')
  if (parts.length === 2) {
    const minutes = parseInt(parts[0], 10)
    const seconds = parseFloat(parts[1])
    return minutes * 60 + seconds
  }
  return parseFloat(s) || 0
}

export type KeyframeWithTime = Keyframe & { timeSeconds: number }

const VIDEO_HEIGHT_KEY = 'beatlab-video-track-height'
const DEFAULT_VIDEO_HEIGHT = 96
const MIN_VIDEO_HEIGHT = 48
const MAX_VIDEO_HEIGHT = 400

const PREVIEW_HEIGHT_KEY = 'beatlab-preview-height'
const DEFAULT_PREVIEW_HEIGHT = 180
const MIN_PREVIEW_HEIGHT = 80
const MAX_PREVIEW_HEIGHT = 500

const AUDIO_HEIGHT_KEY = 'beatlab-audio-track-height'
const DEFAULT_AUDIO_HEIGHT = 0 // 0 means flex-1 (fill remaining space)
const MIN_AUDIO_HEIGHT = 60
const MAX_AUDIO_HEIGHT = 400

export function Timeline({ data, v2 }: { data: EditorData; v2?: boolean }) {
  const router = useRouter()
  const editorState = useEditorState()
  const [currentTime, setCurrentTime] = useState(() => {
    if (typeof window === 'undefined') return 0
    const stored = localStorage.getItem(`beatlab-playhead-${data.projectName}`)
    return stored ? parseFloat(stored) : 0
  })
  // Persist playhead position to localStorage (debounced)
  useEffect(() => {
    const handle = setTimeout(() => {
      localStorage.setItem(`beatlab-playhead-${data.projectName}`, String(currentTime))
    }, 500)
    return () => clearTimeout(handle)
  }, [currentTime, data.projectName])

  const [duration, setDuration] = useState(0)
  const [pxPerSec, setPxPerSec] = useState(() => {
    if (typeof window === 'undefined') return 20
    const stored = localStorage.getItem('beatlab-zoom')
    return stored ? parseFloat(stored) : 20
  })
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(() => {
    if (typeof window === 'undefined') return 1
    const stored = localStorage.getItem('beatlab-playback-speed')
    return stored ? parseFloat(stored) : 1
  })
  const [selectedKeyframe, setSelectedKeyframe] = useState<KeyframeWithTime | null>(null)
  const [selectedKeyframeIds, setSelectedKeyframeIds] = useState<Set<string>>(new Set())
  const [selectedTransition, setSelectedTransition] = useState<Transition | null>(null)
  const [selectedTransitionIds, setSelectedTransitionIds] = useState<Set<string>>(new Set())
  const [transformMode, setTransformMode] = useState(false)
  const previewContainerRef = useRef<HTMLDivElement>(null)
  const [showBin, setShowBin] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showSections, setShowSections] = useState(false)
  const [scrollToSectionId, setScrollToSectionId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [showCheckpoints, setShowCheckpoints] = useState(false)
  const [showDownloadPreview, setShowDownloadPreview] = useState(false)
  const [selectedAudioDescription, setSelectedAudioDescription] = useState<import('@/lib/beatlab-client').AudioDescription | null>(null)
  const [previewQuality, setPreviewQuality] = useState(data.previewQuality)
  const [userEffects, setUserEffects] = useState<UserEffect[]>(data.userEffects)
  const [suppressions, setSuppressions] = useState<BeatSuppression[]>(data.beatSuppressions)
  const [selectedSuppressionId, setSelectedSuppressionId] = useState<string | null>(null)
  const nextSupId = useRef(Math.max(0, ...data.beatSuppressions.map((s) => parseInt(s.id.replace(/\D/g, '') || '0', 10))) + 1)
  const [selectedEffect, setSelectedEffect] = useState<UserEffect | null>(null)
  const [selectedEffectIds, setSelectedEffectIds] = useState<Set<string>>(new Set())
  const [poolSelection, setPoolSelection] = useState<PoolSelection | null>(null)
  const nextFxId = useRef(Math.max(0, ...data.userEffects.map((fx) => parseInt(fx.id.replace(/\D/g, '') || '0', 10))) + 1)
  const [selectedTrackId, setSelectedTrackId] = useState<string>(data.tracks[0]?.id || 'track_1')
  const [selectedRuleSection, setSelectedRuleSection] = useState<RuleSection | null>(null)
  const [trackSettingsId, setTrackSettingsId] = useState<string | null>(null)
  // Drag overrides: keyframeId -> overridden timeSeconds (during drag only)
  const [dragOverrides, setDragOverrides] = useState<Record<string, number>>({})
  const [videoTrackHeight, setVideoTrackHeight] = useState(DEFAULT_VIDEO_HEIGHT)
  const [previewHeight, setPreviewHeight] = useState(DEFAULT_PREVIEW_HEIGHT)
  const [hoverPreviewUrl, setHoverPreviewUrlRaw] = useState<string | null>(null)
  const hoverClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setHoverPreviewUrl = useCallback((url: string | null) => {
    if (hoverClearTimer.current) { clearTimeout(hoverClearTimer.current); hoverClearTimer.current = null }
    if (url) {
      setHoverPreviewUrlRaw(url)
    } else {
      // Debounce clear to prevent flicker when moving between adjacent cards
      hoverClearTimer.current = setTimeout(() => setHoverPreviewUrlRaw(null), 100)
    }
  }, [])
  const [hoveredBinTransition, setHoveredBinTransition] = useState<import('@/lib/beatlab-client').TransitionBinEntry | null>(null)
  const [audioTrackHeight, setAudioTrackHeight] = useState(DEFAULT_AUDIO_HEIGHT)
  // Viewport state for virtualized rendering
  const [scrollLeft, setScrollLeft] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(2000)

  // v2: Sync selection state to EditorStateContext so dockview property panels can read it
  useEffect(() => {
    if (!v2) return
    editorState.setSelectedKeyframe(selectedKeyframe)
  }, [v2, selectedKeyframe]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!v2) return
    editorState.setSelectedTransition(selectedTransition)
  }, [v2, selectedTransition]) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore persisted heights from localStorage after mount (SSR-safe)
  useEffect(() => {
    const storedVideo = localStorage.getItem(VIDEO_HEIGHT_KEY)
    if (storedVideo) setVideoTrackHeight(Math.max(MIN_VIDEO_HEIGHT, Math.min(MAX_VIDEO_HEIGHT, parseInt(storedVideo, 10))))
    const storedPreview = localStorage.getItem(PREVIEW_HEIGHT_KEY)
    if (storedPreview) setPreviewHeight(Math.max(MIN_PREVIEW_HEIGHT, Math.min(MAX_PREVIEW_HEIGHT, parseInt(storedPreview, 10))))
    const storedAudio = localStorage.getItem(AUDIO_HEIGHT_KEY)
    if (storedAudio) setAudioTrackHeight(Math.max(MIN_AUDIO_HEIGHT, Math.min(MAX_AUDIO_HEIGHT, parseInt(storedAudio, 10))))
  }, [])

  // Prevent browser zoom on Ctrl+scroll (React onWheel is passive, can't preventDefault)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  // Sync playback speed from Settings panel
  useEffect(() => {
    const handler = (e: Event) => {
      const rate = (e as CustomEvent).detail as number
      setPlaybackRate(rate)
      if (audioElRef.current) audioElRef.current.playbackRate = rate
    }
    window.addEventListener('beatlab-playback-speed', handler)
    return () => window.removeEventListener('beatlab-playback-speed', handler)
  }, [])

  // Preload stills for base image picker
  useEffect(() => { preloadStills(data.projectName) }, [data.projectName])

  // Listen for timeline validation warnings via WebSocket
  const { subscribeAll } = useBeatlabSocket()
  useEffect(() => {
    return subscribeAll((msg) => {
      if (msg.type === 'timeline_warning') {
        const w = msg as { warnings: string[]; route: string }
        console.warn(`[Timeline] ⚠ ${w.warnings.length} validation issues after ${w.route}:`, w.warnings)
      }
    })
  }, [subscribeAll])

  // Measure viewport width for virtualization
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setViewportWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Compute canvas resolution from quality percentage and project resolution
  const canvasWidth = Math.round(data.meta.resolution[0] * previewQuality / 100)
  const canvasHeight = Math.round(data.meta.resolution[1] * previewQuality / 100)

  // Keep frame cache resolution in sync — called during render (not in effect)
  // so globals are set before any preload effects read dbKey()
  setPreviewResolution(canvasWidth, canvasHeight)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Drag-select state
  const dragSelectRef = useRef<{ startX: number; startY: number; shiftKey: boolean; active: boolean } | null>(null)
  const [dragSelectRect, setDragSelectRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const seekFnRef = useRef<((time: number) => void) | null>(null)
  const currentTimeRef = useRef(currentTime)
  const playPauseFnRef = useRef<(() => void) | null>(null)
  const trackDragRef = useRef<{ dragging: boolean; startY: number; startHeight: number }>({ dragging: false, startY: 0, startHeight: 0 })
  const previewDragRef = useRef<{ dragging: boolean; startY: number; startHeight: number }>({ dragging: false, startY: 0, startHeight: 0 })
  const audioDragRef = useRef<{ dragging: boolean; startY: number; startHeight: number }>({ dragging: false, startY: 0, startHeight: 0 })
  const previewRef = useRef<BeatEffectPreviewHandle>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const [recording, setRecording] = useState<{ progress: number } | null>(null)
  const [markers, setMarkers] = useState<{ id: string; time: number; label: string }[]>([])

  // Load markers from backend
  useEffect(() => {
    fetchMarkers(data.projectName).then(setMarkers).catch(() => {})
  }, [data.projectName])

  // Load AI data once (heavy — 5MB with onsets, not refetched on router.invalidate)
  const [aiAudioEvents, setAiAudioEvents] = useState(data.audioEvents)
  const [aiAudioRules, setAiAudioRules] = useState(data.audioRules)
  const [aiAudioOnsets, setAiAudioOnsets] = useState(data.audioOnsets)
  const [aiAudioDescriptions] = useState(data.audioDescriptions)
  const aiLoadedRef = useRef(false)
  useEffect(() => {
    if (aiLoadedRef.current) return
    aiLoadedRef.current = true
    getAudioIntelligenceData({ data: { name: data.projectName } }).then((ai) => {
      if (ai.audioEvents.length > 0) setAiAudioEvents(ai.audioEvents)
      if (ai.audioRules.length > 0) setAiAudioRules(ai.audioRules)
      if (Object.keys(ai.audioOnsets).length > 0) setAiAudioOnsets(ai.audioOnsets)
      // Note: audioDescriptions come from descriptions.md (route loader), NOT from audio intelligence
    }).catch(() => {})
  }, [data.projectName])

  // Local keyframe/transition state for fast partial refetches
  const [localKeyframes, setLocalKeyframes] = useState(data.keyframes)
  const [localTransitions, setLocalTransitions] = useState(data.transitions)
  useEffect(() => { setLocalKeyframes(data.keyframes) }, [data.keyframes])
  useEffect(() => { setLocalTransitions(data.transitions) }, [data.transitions])

  // Partial refetch — only keyframes + transitions (fast, ~500KB)
  const refreshTimeline = useCallback(() => {
    getTimelineData({ data: { name: data.projectName } }).then((tl) => {
      // Invalidate frame cache for keyframes whose selected variant changed
      const oldKfMap = new Map(localKeyframes.map((kf) => [kf.id, kf.selected]))
      for (const kf of tl.keyframes) {
        const oldSel = oldKfMap.get(kf.id)
        if (oldSel !== kf.selected) {
          invalidateEntry(`kf:${kf.id}`)
        }
      }
      setLocalKeyframes(tl.keyframes)
      setLocalTransitions(tl.transitions)
    }).catch((e) => { console.error('refreshTimeline failed:', e); router.invalidate() })
  }, [data.projectName, router, localKeyframes])

  const reloadAudioIntelligence = useCallback(() => {
    getAudioIntelligenceData({ data: { name: data.projectName } }).then((ai) => {
      if (ai.audioEvents.length > 0) setAiAudioEvents(ai.audioEvents)
      if (ai.audioRules.length > 0) { setAiAudioRules(ai.audioRules); setLocalRules(ai.audioRules) }
      if (Object.keys(ai.audioOnsets).length > 0) setAiAudioOnsets(ai.audioOnsets)
    }).catch(() => {})
  }, [data.projectName])

  const keyframes: KeyframeWithTime[] = localKeyframes.map((kf) => ({
    ...kf,
    timeSeconds: dragOverrides[kf.id] ?? parseTimestamp(kf.timestamp),
  })).sort((a, b) => a.timeSeconds - b.timeSeconds)

  // Group by track
  // Client-side rule application for instant preview
  // When rules are edited locally, recompute events from onsets without backend round-trip
  const [localRules, setLocalRules] = useState(aiAudioRules)
  useEffect(() => { setLocalRules(aiAudioRules) }, [aiAudioRules])

  const filteredAudioEvents = useMemo(() => {
    const hasOnsets = aiAudioOnsets && Object.keys(aiAudioOnsets).length > 0
    console.log(`[Timeline] audioOnsets: ${hasOnsets ? Object.keys(aiAudioOnsets).length + ' stems' : 'EMPTY'}, localRules: ${localRules.length}`)
    if (hasOnsets) {
      const events = applyRulesClient(aiAudioOnsets as OnsetData, localRules)
      console.log(`[Timeline] Client-side apply: ${localRules.length} rules → ${events.length} events`)
      return events
    }
    // Fallback: filter disabled rules from server events
    const disabledRules = localRules.filter((r) => (r as Record<string, unknown>)._disabled)
    if (disabledRules.length === 0) return aiAudioEvents
    const disabled = disabledRules.map((r) => ({
      key: `${r.stem}/${r.band}:${r.effect}`,
      start: r._group_start ?? r._start ?? 0,
      end: r._group_end ?? r._end ?? Infinity,
    }))
    return aiAudioEvents.filter((ev) => {
      const evKey = `${ev.stem_source}:${ev.effect}`
      return !disabled.some((d) => d.key === evKey && ev.time >= d.start && ev.time <= d.end)
    })
  }, [aiAudioEvents, aiAudioOnsets, localRules])

  // Sort tracks by zOrder descending — highest z (top of compositor) at top of track list
  const allTracks = [...data.tracks].sort((a, b) => b.zOrder - a.zOrder)
  const sortedTracks = allTracks.filter((t) => !(t as Record<string, unknown>).hidden)
  const hiddenTracks = allTracks.filter((t) => (t as Record<string, unknown>).hidden)
  const trackKeyframes = new Map<string, KeyframeWithTime[]>()
  const trackTransitions = new Map<string, Transition[]>()
  for (const track of sortedTracks) {
    trackKeyframes.set(track.id, keyframes.filter((kf) => kf.trackId === track.id))
    trackTransitions.set(track.id, localTransitions.filter((tr) => tr.trackId === track.id))
  }

  // Use audio duration if available, otherwise estimate from keyframes
  const effectiveDuration = duration > 0 ? duration : (
    keyframes.length > 0 ? Math.max(...keyframes.map((kf) => kf.timeSeconds)) + 10 : 60
  )
  const totalWidth = effectiveDuration * pxPerSec

  // Find the current keyframe — prefer one with a selected image (for the preview src)
  const currentKeyframe = useMemo(() => {
    return [...keyframes]
      .filter((kf) => kf.timeSeconds <= currentTime)
      .sort((a, b) => b.timeSeconds - a.timeSeconds)
      .find((kf) => kf.hasSelectedImage)
      || [...keyframes].reverse().find((kf) => kf.timeSeconds <= currentTime)
  }, [keyframes, currentTime])

  // Find active transition at current time (if any with selected video)
  const kfMap = useMemo(() => new Map(keyframes.map((kf) => [kf.id, kf])), [keyframes])
  const { activeTransition, activeTransitionFrom, activeTransitionTo } = useMemo(() => {
    const tr = localTransitions.filter((tr) => {
      if (tr.hidden) return false
      if (tr.trackId !== selectedTrackId) return false
      const fromKf = kfMap.get(tr.from)
      const toKf = kfMap.get(tr.to)
      if (!fromKf || !toKf) return false
      if (!tr.hasSelectedVideo) return false
      return currentTime >= fromKf.timeSeconds && currentTime < toKf.timeSeconds
    }).at(-1) ?? null
    return {
      activeTransition: tr,
      activeTransitionFrom: tr ? kfMap.get(tr.from) ?? null : null,
      activeTransitionTo: tr ? kfMap.get(tr.to) ?? null : null,
    }
  }, [localTransitions, kfMap, selectedTrackId, currentTime])

  // Preload keyframe images and transition videos near the playhead.
  // Runs on time changes and data changes — avoids enqueuing hundreds of decodes at once.
  const [preloadWindow, setPreloadWindow] = useState(() => {
    const metaVal = (data.meta as Record<string, unknown>).preload_window as number
    if (metaVal) return metaVal
    if (typeof window === 'undefined') return 30
    const stored = localStorage.getItem('beatlab-preload-window')
    return stored ? parseInt(stored, 10) : 30
  })
  // Listen for settings changes (from SettingsPanel)
  useEffect(() => {
    const handler = (e: Event) => {
      const val = (e as CustomEvent).detail as number
      setPreloadWindow(val)
    }
    window.addEventListener('beatlab-preload-window', handler)
    return () => window.removeEventListener('beatlab-preload-window', handler)
  }, [])
  const PRELOAD_WINDOW = preloadWindow
  // Sync eviction protection to match the configured preload window
  useEffect(() => { setEvictionProtectWindow(preloadWindow) }, [preloadWindow])

  // Apply max concurrent preloads from project meta
  useEffect(() => {
    const v = (data.meta as Record<string, unknown>).max_concurrent_preloads as number
    if (v) setMaxConcurrentPreloads(v)
  }, [data.meta])
  // Always keep timestamps fresh so eviction knows what's near the playhead
  useEffect(() => {
    for (const kf of keyframes) {
      if (!kf.hasSelectedImage) continue
      const key = `kf:${kf.id}`
      setKeyTimestamp(key, kf.timeSeconds)
    }
    for (const tr of localTransitions) {
      if (!tr.hasSelectedVideo) continue
      const fromKf = kfMap.get(tr.from)
      if (!fromKf) continue
      const selectedVariant = tr.selected ?? 'none'
      const key = `tr:${tr.id}:v${selectedVariant}`
      setKeyTimestamp(key, fromKf.timeSeconds)
    }
  }, [keyframes, localTransitions, kfMap])

  // Throttle preload enqueues — expensive decode work, not needed every frame
  // Sort by proximity so nearest clips load first and aren't evicted by far ones
  const lastPreloadTime = useRef(0)
  const preloadReady = useRef(false)
  useEffect(() => { const t = setTimeout(() => { preloadReady.current = true }, 2000); return () => clearTimeout(t) }, [])
  useEffect(() => {
    if (!preloadReady.current) return
    if (Math.abs(currentTime - lastPreloadTime.current) < 1.0) return
    lastPreloadTime.current = currentTime

    const kfWork: { dist: number; run: () => void }[] = []
    for (const kf of keyframes) {
      if (!kf.hasSelectedImage) continue
      const dist = Math.abs(kf.timeSeconds - currentTime)
      if (dist > PRELOAD_WINDOW) continue
      const key = `kf:${kf.id}`
      if (!isInMemory(key)) {
        kfWork.push({ dist, run: () => preloadKeyframeImage(key, beatlabFileUrl(data.projectName, `selected_keyframes/${kf.id}.png`) + `?v=${kf.selected ?? 0}`) })
      }
    }

    const trWork: { dist: number; run: () => void }[] = []
    for (const tr of localTransitions) {
      if (!tr.hasSelectedVideo) continue
      const fromKf = kfMap.get(tr.from)
      if (!fromKf) continue
      const dist = Math.abs(fromKf.timeSeconds - currentTime)
      if (dist > PRELOAD_WINDOW) continue
      const selectedVariant = tr.selected ?? 'none'
      const key = `tr:${tr.id}:v${selectedVariant}`
      if (!isInMemory(key)) {
        trWork.push({ dist, run: () => preloadTransition(key, beatlabFileUrl(data.projectName, `selected_transitions/${tr.id}_slot_0.mp4`)) })
      }
    }

    // Process nearest first — ensures close clips load before far ones trigger eviction
    for (const w of [...kfWork, ...trWork].sort((a, b) => a.dist - b.dist)) w.run()
  }, [currentTime, localTransitions, localKeyframes, data.projectName, canvasWidth, canvasHeight])

  // Update playhead position for proximity-based cache eviction
  useEffect(() => {
    setPlayheadPosition(currentTime)
  }, [currentTime])

  // Poll frame decode progress for render bars — show for all transitions in viewport
  // Keys: tr_001, tr_002 (transition IDs) and kf_001, kf_002 (keyframe IDs) — no collisions
  const [renderProgress, setRenderProgress] = useState<Record<string, number>>({})
  const prevProgressRef = useRef<string>('')
  useEffect(() => {
    const BUFFER_SEC = 5 // small buffer beyond viewport edges
    const viewStartSec = Math.max(0, scrollLeft / pxPerSec - BUFFER_SEC)
    const viewEndSec = (scrollLeft + viewportWidth) / pxPerSec + BUFFER_SEC

    const update = () => {
      const progress: Record<string, number> = {}

      for (const tr of localTransitions) {
        if (!tr.hasSelectedVideo) continue
        const fromKf = kfMap.get(tr.from)
        const toKf = kfMap.get(tr.to)
        if (!fromKf || !toKf) continue
        // Skip if transition is entirely outside viewport
        if (toKf.timeSeconds < viewStartSec || fromKf.timeSeconds > viewEndSec) continue
        const selectedVariant = tr.selected ?? 'none'
        const key = `tr:${tr.id}:v${selectedVariant}`
        const p = getLoadProgress(key)
        progress[tr.id] = p !== null ? p : isLoaded(key) ? 1 : 0
      }

      const serialized = JSON.stringify(progress)
      if (serialized !== prevProgressRef.current) {
        prevProgressRef.current = serialized
        setRenderProgress(progress)
      }
    }
    update()
    const interval = setInterval(update, 250)
    return () => clearInterval(interval)
  }, [localTransitions, keyframes, scrollLeft, viewportWidth, pxPerSec])

  // Build adjacency lookup: which transition comes before/after each transition?
  const { trEndingAt, trStartingAt } = useMemo(() => {
    const sorted = [...localTransitions]
      .filter((tr) => tr.hasSelectedVideo && kfMap.has(tr.from) && kfMap.has(tr.to))
      .sort((a, b) => kfMap.get(a.from)!.timeSeconds - kfMap.get(b.from)!.timeSeconds)
    const ending = new Map<string, Transition>()
    const starting = new Map<string, Transition>()
    for (const tr of sorted) {
      ending.set(tr.to, tr)
      starting.set(tr.from, tr)
    }
    return { trEndingAt: ending, trStartingAt: starting }
  }, [localTransitions, kfMap])

  // Get crossfade frame pair for smooth transitions at all boundaries
  const CROSSFADE_FRAMES = 4 // 4 frames each side = 8 frame overlap at 24fps (~333ms)
  const crossfadeData = useMemo(() => {return (() => {
    if (!activeTransition || !activeTransitionFrom || !activeTransitionTo) {
      // No transition — check if we're in a gap or at a keyframe hold
      if (currentKeyframe) {
        const hasOutgoing = localTransitions.some((tr) => tr.from === currentKeyframe.id)
        const kfIdx = keyframes.findIndex((k) => k.id === currentKeyframe.id)
        const nextKf = kfIdx >= 0 && kfIdx < keyframes.length - 1 ? keyframes[kfIdx + 1] : null
        // Gap: no outgoing transition and we're past the keyframe
        if (!hasOutgoing && nextKf && currentTime > currentKeyframe.timeSeconds + 0.1) {
          return { frameA: null, frameB: null, blendFactor: 0 }
        }
        const kfKey = `kf:${currentKeyframe.id}`
        const kfFrame = getFrameAtProgress(kfKey, 0)
        if (kfFrame) return { frameA: kfFrame, frameB: null, blendFactor: 0 }
      }
      return { frameA: null, frameB: null, blendFactor: 0 }
    }

    const tStart = activeTransitionFrom.timeSeconds
    const tEnd = activeTransitionTo.timeSeconds
    const linearProgress = Math.max(0, Math.min(0.999, (currentTime - tStart) / (tEnd - tStart)))
    const progress = activeTransition.remap.method === 'curve'
      ? evaluateCurve(activeTransition.remap.curve_points, linearProgress)
      : linearProgress

    const selectedVariant = activeTransition.selected ?? 'none'
    const key = `tr:${activeTransition.id}:v${selectedVariant}`
    const entry = getFrames(key)
    const totalFrames = entry?.frames.length ?? 0
    const currentFrameIdx = totalFrames > 0
      ? Math.min(Math.floor(progress * totalFrames), totalFrames - 1)
      : 0
    const frameA = getFrameAtProgress(key, progress)

    // Crossfade at transition boundaries
    const xfade = Math.min(CROSSFADE_FRAMES, Math.floor(totalFrames / 2))
    if (xfade <= 0 || totalFrames === 0) {
      return { frameA, frameB: null, blendFactor: 0 }
    }

    // Transition start: crossfade from previous keyframe image (skip if previous is a transition — its end zone handles it)
    const prevTr = trEndingAt.get(activeTransition.from)
    if (!prevTr && currentFrameIdx < xfade) {
      const blend = currentFrameIdx / xfade
      const kfKey = `kf:${activeTransition.from}`
      return { frameA: getFrameAtProgress(kfKey, 0), frameB: frameA, blendFactor: blend }
    }

    // Transition end: crossfade to next transition's first frame or keyframe image
    if (currentFrameIdx >= totalFrames - xfade) {
      const blend = (currentFrameIdx - (totalFrames - xfade)) / xfade
      const nextTr = trStartingAt.get(activeTransition.to)
      if (nextTr) {
        const nextVariant = nextTr.selected ?? 'none'
        const nextKey = `tr:${nextTr.id}:v${nextVariant}`
        return { frameA, frameB: getFrameAtProgress(nextKey, 0), blendFactor: blend }
      }
      const kfKey = `kf:${activeTransition.to}`
      return { frameA, frameB: getFrameAtProgress(kfKey, 0), blendFactor: blend }
    }

    return { frameA, frameB: null, blendFactor: 0 }
  })()}, [activeTransition, activeTransitionFrom, activeTransitionTo, currentKeyframe, currentTime, keyframes, localTransitions, trEndingAt, trStartingAt])

  // Compute per-track layers for multi-track compositing
  const trackLayers: import('./BeatEffectPreview').TrackLayer[] = useMemo(() => {return (() => {
    // Always build layers — compositor handles 1 or N tracks uniformly
    // Compositor: first layer with content becomes base, subsequent layers paint ON TOP.
    // Track 1 (zOrder 0) = base, Track 2 (zOrder 1) = overlaid on top. Ascending order.
    const layers = [...data.tracks]
      .filter((t) => t.enabled && !(t as Record<string, unknown>).hidden)
      .sort((a, b) => a.zOrder - b.zOrder)
      .map((track) => {
      const tKfs = trackKeyframes.get(track.id) || []
      const tTrs = trackTransitions.get(track.id) || []
      // Find current keyframe for this track
      const curKf = [...tKfs].reverse().find((kf) => kf.timeSeconds <= currentTime)
      // Find active transition for this track
      const tKfMap = new Map(tKfs.map((kf) => [kf.id, kf]))
      // Find transition spanning current time — highest z-index (last/highest ID) wins when overlapping
      // Check if current time falls within any hidden transition — if so, skip this layer entirely
      const inHiddenTr = tTrs.some((tr) => {
        if (!tr.hidden) return false
        const from = tKfMap.get(tr.from)
        const to = tKfMap.get(tr.to)
        if (!from || !to) return false
        return currentTime >= from.timeSeconds && currentTime < to.timeSeconds
      })
      if (inHiddenTr) {
        return { frameA: null, frameB: null, blendFactor: 0, opacity: 0, red: 1, green: 1, blue: 1, black: 0, saturation: 1, hueShift: 0, invert: 0, brightness: 0, contrast: 1, exposure: 0, blendMode: track.blendMode, chromaKey: track.chromaKey } as import('./BeatEffectPreview').TrackLayer
      }
      const activeTr = tTrs.filter((tr) => {
        const from = tKfMap.get(tr.from)
        const to = tKfMap.get(tr.to)
        if (!from || !to) return false
        return currentTime >= from.timeSeconds && currentTime < to.timeSeconds
      }).at(-1) ?? null
      if (activeTr) {
        const from = tKfMap.get(activeTr.from)!
        const to = tKfMap.get(activeTr.to)!
        const linearProgress = Math.max(0, Math.min(0.999, (currentTime - from.timeSeconds) / (to.timeSeconds - from.timeSeconds)))

        // Evaluate curves shared by both normal and adjustment transitions
        let trOpacity = activeTr.opacityCurve
          ? evaluateCurve(activeTr.opacityCurve, linearProgress)
          : activeTr.opacity != null ? activeTr.opacity : track.baseOpacity
        const trElapsed = currentTime - from.timeSeconds
        let trInvert = 0
        let effectChromaKey: { color: [number, number, number]; threshold: number; feather: number } | undefined
        for (const fx of activeTr.effects || []) {
          if (!fx.enabled) continue
          if (fx.type === 'strobe') {
            const period = fx.params.period || (1 / (fx.params.frequency || 8))
            const duty = fx.params.duty || 0.5
            if ((trElapsed / period) % 1 > duty) trOpacity = 0
          } else if (fx.type === 'chroma-key') {
            effectChromaKey = { color: [fx.params.r ?? 0, fx.params.g ?? 1, fx.params.b ?? 0], threshold: fx.params.threshold ?? 0.3, feather: fx.params.feather ?? 0.1 }
          } else if (fx.type === 'invert') {
            trInvert = fx.params.amount ?? 1
          }
        }
        const trRed = activeTr.redCurve ? evaluateCurve(activeTr.redCurve, linearProgress) : 1
        const trGreen = activeTr.greenCurve ? evaluateCurve(activeTr.greenCurve, linearProgress) : 1
        const trBlue = activeTr.blueCurve ? evaluateCurve(activeTr.blueCurve, linearProgress) : 1
        const trBlack = activeTr.blackCurve ? evaluateCurve(activeTr.blackCurve, linearProgress) : 0
        const trSaturation = activeTr.saturationCurve ? evaluateCurve(activeTr.saturationCurve, linearProgress) : 1
        const trHueShift = activeTr.hueShiftCurve ? evaluateCurve(activeTr.hueShiftCurve, linearProgress) : 0
        const trInvertCurve = activeTr.invertCurve ? evaluateCurve(activeTr.invertCurve, linearProgress) : 0
        trInvert = Math.min(1, trInvert + trInvertCurve)
        const trBrightness = activeTr.brightnessCurve ? evaluateCurve(activeTr.brightnessCurve, linearProgress) : 0
        const trContrast = activeTr.contrastCurve ? evaluateCurve(activeTr.contrastCurve, linearProgress) : 1
        const trExposure = activeTr.exposureCurve ? evaluateCurve(activeTr.exposureCurve, linearProgress) : 0

        const mask = activeTr.maskRadius != null ? {
          centerX: activeTr.maskCenterX ?? 0.5,
          centerY: activeTr.maskCenterY ?? 0.5,
          radius: activeTr.maskRadius,
          feather: activeTr.maskFeather ?? 0,
        } : undefined
        const trTransformX = activeTr.transformXCurve ? evaluateCurve(activeTr.transformXCurve, linearProgress) : (activeTr.transformX ?? 0)
        const trTransformY = activeTr.transformYCurve ? evaluateCurve(activeTr.transformYCurve, linearProgress) : (activeTr.transformY ?? 0)
        const trScale = activeTr.transformZCurve ? evaluateCurve(activeTr.transformZCurve, linearProgress) : 1.0
        const hasAnchor = activeTr.anchorX != null || activeTr.anchorY != null
        const hasTransform = trTransformX !== 0 || trTransformY !== 0 || trScale !== 1.0 || hasAnchor || activeTr.transformXCurve || activeTr.transformYCurve || activeTr.transformZCurve
        const transform = hasTransform ? {
          x: trTransformX,
          y: trTransformY,
          scale: trScale,
          anchorX: activeTr.anchorX ?? 0.5,
          anchorY: activeTr.anchorY ?? 0.5,
        } : undefined

        if (activeTr.isAdjustment) {
          return { frameA: null, frameB: null, blendFactor: 0, opacity: trOpacity, red: trRed, green: trGreen, blue: trBlue, black: trBlack, saturation: trSaturation, hueShift: trHueShift, invert: trInvert, brightness: trBrightness, contrast: trContrast, exposure: trExposure, blendMode: 'normal' as import('@/lib/beatlab-client').BlendMode, isAdjustment: true, mask, transform } as import('./BeatEffectPreview').TrackLayer
        }

        const progress = activeTr.remap?.method === 'curve'
          ? evaluateCurve(activeTr.remap.curve_points, linearProgress)
          : linearProgress
        let frameA: ImageBitmap | null = null
        if (activeTr.hasSelectedVideo) {
          const variant = activeTr.selected ?? 'none'
          const key = `tr:${activeTr.id}:v${variant}`
          frameA = getFrameAtProgress(key, progress)
        }
        // Fallback: show the from-keyframe image
        if (!frameA) {
          const kfKey = `kf:${from.id}`
          frameA = getFrameAtProgress(kfKey, 0)
        }
        const trBlend = (activeTr.blendMode || curKf?.blendMode || track.blendMode) as import('@/lib/beatlab-client').BlendMode
        return { frameA, frameB: null, blendFactor: 0, opacity: trOpacity, red: trRed, green: trGreen, blue: trBlue, black: trBlack, saturation: trSaturation, hueShift: trHueShift, invert: trInvert, brightness: trBrightness, contrast: trContrast, exposure: trExposure, blendMode: trBlend, chromaKey: effectChromaKey || activeTr.chromaKey || track.chromaKey, mask, transform } as import('./BeatEffectPreview').TrackLayer
      }
      if (curKf) {
        const kfKey = `kf:${curKf.id}`
        const frameA = getFrameAtProgress(kfKey, 0)
        if (!frameA && curKf.hasSelectedImage) {
          console.warn(`[layer] ${track.id} curKf=${curKf.id} hasImage=true but frame=null (not loaded yet?)`)
        }
        const kfOpacity = curKf.opacity != null ? curKf.opacity : track.baseOpacity
        const kfBlend = (curKf.blendMode || track.blendMode) as import('@/lib/beatlab-client').BlendMode
        return { frameA: curKf.hasSelectedImage ? frameA : null, frameB: null, blendFactor: 0, opacity: kfOpacity, red: 1, green: 1, blue: 1, black: 0, saturation: 1, hueShift: 0, invert: 0, brightness: 0, contrast: 1, exposure: 0, blendMode: kfBlend, chromaKey: track.chromaKey } as import('./BeatEffectPreview').TrackLayer
      }
      return { frameA: null, frameB: null, blendFactor: 0, opacity: track.baseOpacity, red: 1, green: 1, blue: 1, black: 0, saturation: 1, hueShift: 0, invert: 0, brightness: 0, contrast: 1, exposure: 0, blendMode: track.blendMode, chromaKey: track.chromaKey } as import('./BeatEffectPreview').TrackLayer
    })
    return layers
  })()}, [data.tracks, trackKeyframes, trackTransitions, currentTime, kfMap])

  // Check if the active transition's frames are still loading
  const isTransitionLoading = (() => {
    if (!activeTransition || !activeTransitionFrom || !activeTransitionTo) return false
    const selectedVariant = activeTransition.selected ?? 'none'
    const key = `tr:${activeTransition.id}:v${selectedVariant}`
    return !isLoaded(key)
  })()

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const factor = e.deltaY > 0 ? 0.85 : 1.18
      const el = scrollRef.current
      if (el) {
        // Zoom around the playhead: keep playhead at the same viewport position
        const playheadX = currentTimeRef.current * pxPerSec
        const viewportOffset = playheadX - el.scrollLeft
        const newPxPerSec = Math.max(0.1, pxPerSec * factor)
        const newPlayheadX = currentTimeRef.current * newPxPerSec
        el.scrollLeft = newPlayheadX - viewportOffset
        setPxPerSec(newPxPerSec)
        localStorage.setItem('beatlab-zoom', String(newPxPerSec))
      } else {
        setPxPerSec((prev) => {
          const next = Math.max(0.1, prev * factor)
          localStorage.setItem('beatlab-zoom', String(next))
          return next
        })
      }
    }
  }, [pxPerSec])

  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (!scrollRef.current) return
      const rect = scrollRef.current.getBoundingClientRect()
      const scrollLeft = scrollRef.current.scrollLeft
      const clickX = e.clientX - rect.left + scrollLeft
      const time = clickX / pxPerSec
      if (time >= 0 && time <= effectiveDuration) {
        if (seekFnRef.current) {
          seekFnRef.current(time)
        } else {
          setCurrentTime(time)
        }
      }
    },
    [pxPerSec, effectiveDuration]
  )

  // Fallback time driver when audio isn't loaded yet
  const fallbackTimerRef = useRef<number>(0)
  const fallbackLastRef = useRef<number>(0)
  const usingFallbackTimer = useRef(false)

  // Stop fallback timer if audio takes over
  useEffect(() => {
    if (!isPlaying && usingFallbackTimer.current) {
      cancelAnimationFrame(fallbackTimerRef.current)
      usingFallbackTimer.current = false
    }
  }, [isPlaying])

  const handlePlayPause = useCallback(() => {
    // Ensure playback rate is applied before starting
    if (audioElRef.current) audioElRef.current.playbackRate = playbackRate
    if (playPauseFnRef.current) {
      // Cancel any running fallback timer since audio is in control
      if (usingFallbackTimer.current) {
        cancelAnimationFrame(fallbackTimerRef.current)
        usingFallbackTimer.current = false
      }
      playPauseFnRef.current()
    } else {
      // No audio loaded — toggle fallback timer
      if (isPlaying) {
        cancelAnimationFrame(fallbackTimerRef.current)
        usingFallbackTimer.current = false
        setIsPlaying(false)
      } else {
        fallbackLastRef.current = performance.now()
        usingFallbackTimer.current = true
        setIsPlaying(true)
        const tick = () => {
          const now = performance.now()
          const delta = (now - fallbackLastRef.current) / 1000
          fallbackLastRef.current = now
          setCurrentTime((prev) => {
            const next = prev + delta
            return next <= effectiveDuration ? next : prev
          })
          fallbackTimerRef.current = requestAnimationFrame(tick)
        }
        fallbackTimerRef.current = requestAnimationFrame(tick)
      }
    }
  }, [isPlaying, effectiveDuration])

  const closeAllPanels = useCallback((opts?: { keepPool?: boolean }) => {
    setSelectedKeyframe(null)
    setSelectedTransition(null)
    setSelectedEffect(null)
    setSelectedEffectIds(new Set())
    setSelectedSuppressionId(null)
    if (!opts?.keepPool) setPoolSelection(null)
    setShowBin(false)
    setShowVersions(false)
    // showSections is independent — not closed by closeAllPanels
    setShowSettings(false)
    setShowLogs(false)
    setShowCheckpoints(false)
    setSelectedAudioDescription(null)
    setShowDownloadPreview(false)
    setSelectedRuleSection(null)
    setTrackSettingsId(null)
  }, [])

  const handleKeyframeClick = useCallback((kf: KeyframeWithTime, shiftKey?: boolean) => {
    setSelectedTrackId(kf.trackId)
    if (shiftKey) {
      // Shift-click: toggle in multi-select set
      setSelectedKeyframeIds((prev) => {
        const next = new Set(prev)
        if (next.has(kf.id)) {
          next.delete(kf.id)
        } else {
          next.add(kf.id)
        }
        return next
      })
      return
    }
    // Normal click: clear multi-select, toggle single
    setSelectedKeyframeIds(new Set())
    closeAllPanels()
    setSelectedKeyframe((prev) => prev?.id === kf.id ? null : kf)
  }, [closeAllPanels])

  const handleTransitionClick = useCallback((tr: Transition, shiftKey?: boolean) => {
    setSelectedTrackId(tr.trackId)
    if (shiftKey) {
      // Shift+click: toggle in multi-select
      setSelectedTransitionIds((prev) => {
        const next = new Set(prev)
        if (next.has(tr.id)) next.delete(tr.id)
        else next.add(tr.id)
        return next
      })
      // Keep single selection for panel display
      setSelectedTransition(tr)
      return
    }
    // Normal click: clear multi-select
    setSelectedTransitionIds(new Set())
    closeAllPanels()
    setSelectedTransition((prev) => prev?.id === tr.id ? null : tr)
  }, [closeAllPanels])

  // Effects handlers
  const persistEffects = useCallback((effects: UserEffect[], supps: BeatSuppression[]) => {
    saveEffects({ data: { projectName: data.projectName, effects, suppressions: supps } })
  }, [data.projectName])

  // Drag-select: hold+drag on track area to range-select keyframes
  // Hold 150ms to enter drag-select mode, then 5px movement activates the rectangle
  const dragSelectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleDragSelectDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const rect = scrollEl.getBoundingClientRect()
    const startX = e.clientX - rect.left + scrollEl.scrollLeft
    const startY = e.clientY - rect.top + scrollEl.scrollTop
    const shiftKey = e.shiftKey

    // Set up pending drag-select — activated after hold timer
    const pending = { startX, startY, shiftKey, active: false, armed: false }
    dragSelectRef.current = pending

    // After 150ms hold, arm the drag-select (mouse moves will now activate it)
    dragSelectTimer.current = setTimeout(() => {
      if (dragSelectRef.current === pending) {
        pending.armed = true
      }
    }, 150)
  }, [])

  useEffect(() => {
    const handleDragSelectMove = (e: MouseEvent) => {
      const ds = dragSelectRef.current
      if (!ds || !ds.armed) return
      const scrollEl = scrollRef.current
      if (!scrollEl) return
      const rect = scrollEl.getBoundingClientRect()
      const curX = e.clientX - rect.left + scrollEl.scrollLeft
      const curY = e.clientY - rect.top + scrollEl.scrollTop
      const dx = curX - ds.startX
      const dy = curY - ds.startY
      // Only activate rectangle after 5px movement
      if (!ds.active && Math.abs(dx) < 5 && Math.abs(dy) < 5) return
      ds.active = true

      const x = Math.min(ds.startX, curX)
      const y = Math.min(ds.startY, curY)
      const w = Math.abs(dx)
      const h = Math.abs(dy)
      setDragSelectRect({ x, y, w, h })

      // Compute time range
      const timeFrom = x / pxPerSec
      const timeTo = (x + w) / pxPerSec

      if (ds.shiftKey) {
        // Shift+drag: current track only
        const trackKfs = trackKeyframes.get(selectedTrackId) || []
        const ids = new Set(trackKfs.filter((kf) => kf.timeSeconds >= timeFrom && kf.timeSeconds <= timeTo).map((kf) => kf.id))
        setSelectedKeyframeIds(ids)
      } else {
        // Regular drag: all tracks
        const ids = new Set(keyframes.filter((kf) => kf.timeSeconds >= timeFrom && kf.timeSeconds <= timeTo).map((kf) => kf.id))
        setSelectedKeyframeIds(ids)
      }
    }

    const handleDragSelectUp = () => {
      if (dragSelectTimer.current) { clearTimeout(dragSelectTimer.current); dragSelectTimer.current = null }
      if (dragSelectRef.current?.active) {
        setDragSelectRect(null)
      }
      dragSelectRef.current = null
    }

    document.addEventListener('mousemove', handleDragSelectMove)
    document.addEventListener('mouseup', handleDragSelectUp)
    return () => {
      document.removeEventListener('mousemove', handleDragSelectMove)
      document.removeEventListener('mouseup', handleDragSelectUp)
    }
  }, [pxPerSec, keyframes, selectedTrackId, trackKeyframes])

  const handleAddEffect = useCallback((time: number) => {
    closeAllPanels()
    const id = `fx_${String(nextFxId.current++).padStart(3, '0')}`
    const newEffect: UserEffect = { id, time, type: 'pulse', intensity: 0.8, duration: 0.2 }
    const updated = [...userEffects, newEffect].sort((a, b) => a.time - b.time)
    setUserEffects(updated)
    setSelectedEffect(newEffect)
    persistEffects(updated, suppressions)
  }, [userEffects, suppressions, persistEffects, closeAllPanels])

  const handleEffectClick = useCallback((fx: UserEffect, e?: { shiftKey?: boolean }) => {
    if (e?.shiftKey) {
      // Shift+click: toggle in multi-select
      setSelectedEffectIds((prev) => {
        const next = new Set(prev)
        if (next.has(fx.id)) next.delete(fx.id)
        else next.add(fx.id)
        return next
      })
      setSelectedEffect(fx)
      return
    }
    closeAllPanels()
    setSelectedEffect((prev) => prev?.id === fx.id ? null : fx)
    setSelectedEffectIds(new Set([fx.id]))
  }, [closeAllPanels])

  const handleEffectDrag = useCallback((id: string, newTime: number) => {
    setUserEffects((prev) => prev.map((fx) => fx.id === id ? { ...fx, time: newTime } : fx))
  }, [])

  const handleEffectDragEnd = useCallback((id: string, newTime: number) => {
    setUserEffects((prev) => {
      const newEffects = prev.map((fx) => fx.id === id ? { ...fx, time: newTime } : fx)
      persistEffects(newEffects, suppressions)
      return newEffects
    })
  }, [suppressions, persistEffects])

  const handleEffectUpdate = useCallback((updated: UserEffect) => {
    const newEffects = userEffects.map((fx) => fx.id === updated.id ? updated : fx)
    setUserEffects(newEffects)
    setSelectedEffect(updated)
    persistEffects(newEffects, suppressions)
  }, [userEffects, suppressions, persistEffects])

  const handleEffectDelete = useCallback((id: string) => {
    const newEffects = userEffects.filter((fx) => fx.id !== id)
    setUserEffects(newEffects)
    setSelectedEffect(null)
    persistEffects(newEffects, suppressions)
  }, [userEffects, suppressions, persistEffects])

  // Suppression handlers
  const handleAddSuppression = useCallback((from: number, to: number) => {
    const id = `sup_${String(nextSupId.current++).padStart(3, '0')}`
    const newSup: BeatSuppression = { id, from, to }
    const updated = [...suppressions, newSup]
    setSuppressions(updated)
    setSelectedSuppressionId(id)
    persistEffects(userEffects, updated)
  }, [suppressions, userEffects, persistEffects])

  const handleDeleteSuppression = useCallback((id: string) => {
    const updated = suppressions.filter((s) => s.id !== id)
    setSuppressions(updated)
    setSelectedSuppressionId(null)
    persistEffects(userEffects, updated)
  }, [suppressions, userEffects, persistEffects])

  const handleResizeSuppression = useCallback((id: string, from: number, to: number) => {
    const updated = suppressions.map((s) => s.id === id ? { ...s, from, to } : s)
    setSuppressions(updated)
    persistEffects(userEffects, updated)
  }, [suppressions, userEffects, persistEffects])

  const handleUpdateSuppressionTypes = useCallback((id: string, effectTypes: EffectType[] | undefined) => {
    const updated = suppressions.map((s) => {
      if (s.id !== id) return s
      const next = { ...s }
      if (effectTypes) next.effectTypes = effectTypes
      else delete next.effectTypes
      return next
    })
    setSuppressions(updated)
    persistEffects(userEffects, updated)
  }, [suppressions, userEffects, persistEffects])

  const [selectedSuppressionIds, setSelectedSuppressionIds] = useState<Set<string>>(new Set())

  const handleSuppressionClick = useCallback((id: string, shiftKey?: boolean) => {
    if (shiftKey) {
      setSelectedSuppressionIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      return
    }
    closeAllPanels()
    setSelectedSuppressionIds(new Set())
    setSelectedSuppressionId((prev) => prev === id ? null : id)
  }, [closeAllPanels])

  // Keyframe boundary drag — updates local state during drag, persists to DB on release
  // Tracks the original time of the dragged kf for computing multi-select deltas
  const dragOriginalTime = useRef<number | null>(null)

  const handleKeyframeDrag = useCallback((id: string, newTimeSeconds: number) => {
    if (selectedKeyframeIds.has(id) && selectedKeyframeIds.size > 1) {
      // Multi-drag: compute delta from original position, apply to all selected
      const origKf = keyframes.find((k) => k.id === id)
      const origTime = dragOriginalTime.current ?? origKf?.timeSeconds ?? newTimeSeconds
      if (dragOriginalTime.current === null && origKf) {
        dragOriginalTime.current = origKf.timeSeconds
      }
      const delta = newTimeSeconds - origTime
      setDragOverrides((prev) => {
        const next = { ...prev, [id]: newTimeSeconds }
        for (const otherId of selectedKeyframeIds) {
          if (otherId !== id) {
            const otherKf = keyframes.find((k) => k.id === otherId)
            if (otherKf) {
              next[otherId] = Math.max(0, otherKf.timeSeconds + delta)
            }
          }
        }
        return next
      })
    } else {
      setDragOverrides((prev) => ({ ...prev, [id]: newTimeSeconds }))
    }
  }, [selectedKeyframeIds, keyframes])

  const handleKeyframeDragEnd = useCallback(async (id: string, newTimeSeconds: number) => {
    console.log(`[Timeline] dragEnd ${id}: newTime=${newTimeSeconds.toFixed(2)}s effectiveDuration=${effectiveDuration.toFixed(2)}s`)
    const isMultiDrag = selectedKeyframeIds.has(id) && selectedKeyframeIds.size > 1

    // Clamp to valid range — prevents corrupted timestamps from drag bugs
    const clamped = Math.max(0, Math.min(newTimeSeconds, effectiveDuration))
    if (Math.abs(clamped - newTimeSeconds) > 0.5) {
      console.warn(`[Timeline] Clamped drag for ${id}: ${newTimeSeconds.toFixed(2)}s → ${clamped.toFixed(2)}s (duration=${effectiveDuration.toFixed(2)}s)`)
    }

    // Collect all kfs to persist (multi-drag or single)
    const updates: { id: string; timestamp: string }[] = []
    if (isMultiDrag) {
      const origKf = keyframes.find((k) => k.id === id)
      const origTime = dragOriginalTime.current ?? origKf?.timeSeconds ?? clamped
      const delta = clamped - origTime
      for (const kfId of selectedKeyframeIds) {
        const kf = keyframes.find((k) => k.id === kfId)
        if (kf) {
          const newTime = Math.max(0, Math.min(kf.timeSeconds + delta, effectiveDuration))
          updates.push({ id: kfId, timestamp: secondsToTimestamp(newTime) })
        }
      }
    } else {
      updates.push({ id, timestamp: secondsToTimestamp(clamped) })
    }

    dragOriginalTime.current = null
    setDragOverrides({})

    // Update local data + persist
    for (const u of updates) {
      const kf = localKeyframes.find((k) => k.id === u.id)
      if (kf) kf.timestamp = u.timestamp
      try {
        await updateKeyframeTimestamp({
          data: { projectName: data.projectName, keyframeId: u.id, newTimestamp: u.timestamp },
        })
      } catch (err) {
        console.error('[Timeline] Failed to persist keyframe timestamp:', u.id, u.timestamp, err)
      }
    }
  }, [data, effectiveDuration, selectedKeyframeIds, keyframes])

  const handleAddKeyframe = useCallback(async () => {
    try {
      const timestamp = secondsToTimestamp(currentTimeRef.current)
      await addKeyframe({
        data: {
          projectName: data.projectName,
          timestamp,
          section: '',
          prompt: '',
          trackId: selectedTrackId,
        },
      })
      refreshTimeline()
    } catch (e) {
      console.error('Failed to add keyframe:', e)
    }
  }, [data.projectName, selectedTrackId, refreshTimeline])

  const handleDeleteKeyframe = useCallback(async (id: string) => {
    try {
      const result = await deleteKeyframe({ data: { projectName: data.projectName, keyframeId: id } })
      console.log('deleteKeyframe result:', result)
      setSelectedKeyframe(null)
      refreshTimeline()
    } catch (e) {
      console.error('Failed to delete keyframe:', e)
    }
  }, [data.projectName, refreshTimeline])

  const handleTransitionRemapChange = useCallback(async (transitionId: string, targetDuration: number) => {
    await updateTransitionRemap({ data: { projectName: data.projectName, transitionId, targetDuration } })
  }, [data.projectName])

  const handleDeleteTransition = useCallback(async (id: string) => {
    await deleteTransition({ data: { projectName: data.projectName, transitionId: id } })
    setSelectedTransition(null)
    refreshTimeline()
  }, [data.projectName, refreshTimeline])

  const handleRetryRender = useCallback(async (tr: Transition) => {
    const selectedVariant = tr.selected ?? 'none'
    const key = `tr:${tr.id}:v${selectedVariant}`
    setRenderProgress((prev) => ({ ...prev, [tr.id]: 0 }))
    await invalidateEntry(key)
    preloadTransition(key, beatlabFileUrl(data.projectName, `selected_transitions/${tr.id}_slot_0.mp4`))
  }, [data.projectName])

  const handleDropVideoOnTransition = useCallback(async (transitionId: string, poolPath: string, sourceTransitionId?: string) => {
    try {
      if (sourceTransitionId && sourceTransitionId !== transitionId) {
        const { postDuplicateTransitionVideo } = await import('@/lib/beatlab-client')
        await postDuplicateTransitionVideo(data.projectName, sourceTransitionId, transitionId)
      } else {
        const { postAssignPoolVideo } = await import('@/lib/beatlab-client')
        await postAssignPoolVideo(data.projectName, transitionId, poolPath)
      }
      // Invalidate old cached frames so new video is decoded
      const tr = localTransitions.find((t) => t.id === transitionId)
      if (tr) {
        const oldVariant = tr.selected ?? 'none'
        invalidateEntry(`tr:${transitionId}:v${oldVariant}`)
      }
      refreshTimeline()
    } catch (e) {
      console.error('[drop] assign video to transition failed:', e)
    }
  }, [data.projectName, localTransitions, refreshTimeline])

  const handleDropImageOnKeyframe = useCallback(async (keyframeId: string, imagePath: string) => {
    const { postAssignKeyframeImage } = await import('@/lib/beatlab-client')
    await postAssignKeyframeImage(data.projectName, keyframeId, imagePath)
    invalidateEntry(`kf:${keyframeId}`)
    refreshTimeline()
  }, [data.projectName, refreshTimeline])

  const handleDropVideoOnKeyframe = useCallback(async (keyframeId: string, poolPath: string) => {
    // Fallback: if somehow an image arrives here, route to image handler
    if (/\.(png|jpe?g|webp)$/i.test(poolPath)) {
      return handleDropImageOnKeyframe(keyframeId, poolPath)
    }
    // Video drop → assign to transition starting from this keyframe
    const tr = localTransitions.find((t) => t.from === keyframeId)
    if (tr) {
      const { postAssignPoolVideo } = await import('@/lib/beatlab-client')
      await postAssignPoolVideo(data.projectName, tr.id, poolPath)
      refreshTimeline()
    }
  }, [localTransitions, data.projectName, refreshTimeline])

  // Keyframe group clipboard for copy/paste
  const kfClipboard = useRef<string[]>([])

  // Transition clipboard for copy/paste (stores source transition ID)
  const trClipboard = useRef<string | null>(null)

  // Suppression clipboard for copy/paste (stores with relative times)
  const supClipboard = useRef<BeatSuppression[]>([])

  // Effect clipboard for copy/paste (supports multiple)
  const effectClipboard = useRef<UserEffect[]>([])

  // Delete key shortcut + Ctrl+C/V for effects
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea')) return

      if (matchesHotkey(e, 'delete') || matchesHotkey(e, 'deleteAlt')) {
        if (selectedKeyframeIds.size > 0) {
          const ids = [...selectedKeyframeIds]
          if (!confirm(`Delete ${ids.length} keyframes?`)) return
          batchDeleteKeyframes({ data: { projectName: data.projectName, keyframeIds: ids } }).then(() => {
            setSelectedKeyframeIds(new Set())
            setSelectedKeyframe(null)
            refreshTimeline()
          }).catch((err) => { console.error('Batch delete failed:', err); alert(`Batch delete failed: ${err}`) })
        } else if (selectedKeyframe) handleDeleteKeyframe(selectedKeyframe.id)
        else if (selectedEffectIds.size > 0) {
          const remaining = userEffects.filter((fx) => !selectedEffectIds.has(fx.id))
          setUserEffects(remaining)
          setSelectedEffect(null)
          setSelectedEffectIds(new Set())
          persistEffects(remaining, suppressions)
        } else if (selectedEffect) {
          handleEffectDelete(selectedEffect.id)
        } else if (selectedSuppressionId) {
          handleDeleteSuppression(selectedSuppressionId)
        }
      }

      // Copy selected keyframes, transition, suppression, or effects
      // Skip if user has text selected (let browser handle native copy)
      if (matchesHotkey(e, 'copy') && !window.getSelection()?.toString()) {
        if (selectedKeyframeIds.size > 0) {
          e.preventDefault()
          kfClipboard.current = [...selectedKeyframeIds]
          trClipboard.current = null
          supClipboard.current = []
          effectClipboard.current = []
        } else if (selectedKeyframe) {
          e.preventDefault()
          // Auto-include neighbor keyframes connected via transitions (if they have images)
          const kfId = selectedKeyframe.id
          const neighborIds = new Set([kfId])
          for (const tr of localTransitions) {
            if (tr.from === kfId || tr.to === kfId) {
              const otherId = tr.from === kfId ? tr.to : tr.from
              const otherKf = keyframes.find((k) => k.id === otherId)
              if (otherKf?.hasSelectedImage) neighborIds.add(otherId)
            }
          }
          kfClipboard.current = [...neighborIds]
          trClipboard.current = null
          supClipboard.current = []
          effectClipboard.current = []
        } else if (selectedTransition) {
          e.preventDefault()
          trClipboard.current = selectedTransition.id
          kfClipboard.current = []
          supClipboard.current = []
          effectClipboard.current = []
        } else if (selectedSuppressionIds.size > 0 || selectedSuppressionId) {
          e.preventDefault()
          const ids = selectedSuppressionIds.size > 0 ? selectedSuppressionIds : new Set(selectedSuppressionId ? [selectedSuppressionId] : [])
          const selected = suppressions.filter((s) => ids.has(s.id))
          if (selected.length > 0) {
            const minFrom = Math.min(...selected.map((s) => s.from))
            supClipboard.current = selected.map((s) => ({ ...s, from: s.from - minFrom, to: s.to - minFrom }))
            kfClipboard.current = []
            effectClipboard.current = []
          }
        } else if (selectedEffectIds.size > 0) {
          e.preventDefault()
          kfClipboard.current = []
          supClipboard.current = []
          const selected = userEffects.filter((fx) => selectedEffectIds.has(fx.id))
          if (selected.length > 0) {
            const minTime = Math.min(...selected.map((fx) => fx.time))
            effectClipboard.current = selected.map((fx) => ({ ...fx, time: fx.time - minTime }))
          }
        }
      }

      // Paste keyframes, transition style, suppression, or effects at playhead
      if (matchesHotkey(e, 'paste')) {
        if (trClipboard.current && selectedTransition && trClipboard.current !== selectedTransition.id) {
          e.preventDefault()
          import('@/lib/beatlab-client').then(({ postCopyTransitionStyle }) => {
            postCopyTransitionStyle(data.projectName, trClipboard.current!, selectedTransition.id)
              .then(() => refreshTimeline())
              .catch((err: Error) => { console.error('Paste transition style failed:', err); alert(`Paste style failed: ${err.message}`) })
          })
        } else if (kfClipboard.current.length > 0) {
          e.preventDefault()
          import('@/lib/beatlab-client').then(({ postPasteGroup }) => {
            postPasteGroup(data.projectName, kfClipboard.current, secondsToTimestamp(currentTimeRef.current), selectedTrackId)
              .then(() => refreshTimeline())
              .catch((err: Error) => { console.error('Paste group failed:', err); alert(`Paste failed: ${err.message}`) })
          })
        } else if (supClipboard.current.length > 0) {
          e.preventDefault()
          const newSups: BeatSuppression[] = supClipboard.current.map((src) => {
            const id = `sup_${String(nextSupId.current++).padStart(3, '0')}`
            return {
              id,
              from: currentTimeRef.current + src.from,
              to: currentTimeRef.current + src.to,
              ...(src.effectTypes ? { effectTypes: [...src.effectTypes] } : {}),
              ...(src.layerEffectTypes ? { layerEffectTypes: [...src.layerEffectTypes] } : {}),
            }
          })
          const updated = [...suppressions, ...newSups]
          setSuppressions(updated)
          setSelectedSuppressionIds(new Set(newSups.map((s) => s.id)))
          setSelectedSuppressionId(newSups[0]?.id ?? null)
          persistEffects(userEffects, updated)
        } else if (effectClipboard.current.length > 0) {
          e.preventDefault()
          const newIds = new Set<string>()
          const pasted = effectClipboard.current.map((src) => {
            const id = `fx_${String(nextFxId.current++).padStart(3, '0')}`
            newIds.add(id)
            return { ...src, id, time: currentTimeRef.current + src.time }
          })
          const updated = [...userEffects, ...pasted].sort((a, b) => a.time - b.time)
          setUserEffects(updated)
          setSelectedEffectIds(newIds)
          setSelectedEffect(pasted[0])
          persistEffects(updated, suppressions)
        }
      }

      // Select all effects
      if (matchesHotkey(e, 'selectAll') && selectedEffect) {
        handlePreventDefault(e, 'selectAll')
        setSelectedEffectIds(new Set(userEffects.map((fx) => fx.id)))
      }

      // Undo (Ctrl+Z)
      if (matchesHotkey(e, 'undo')) {
        handlePreventDefault(e, 'undo')
        import('@/lib/beatlab-client').then(({ postUndo }) => {
          postUndo(data.projectName).then((result) => {
            if (result.success) {
              refreshTimeline()
            }
          })
        })
      }

      // Redo (Ctrl+Shift+Z / Ctrl+Y)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z' || (e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault()
        import('@/lib/beatlab-client').then(({ postRedo }) => {
          postRedo(data.projectName).then((result) => {
            if (result.success) {
              refreshTimeline()
            }
          })
        })
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectedKeyframe, selectedKeyframeIds, selectedTrackId, selectedTransition, selectedEffect, selectedEffectIds, selectedSuppressionId, selectedSuppressionIds, handleDeleteKeyframe, handleEffectDelete, handleDeleteSuppression, userEffects, suppressions, persistEffects, data.projectName, refreshTimeline])

  // Preview divider drag
  const handlePreviewDividerDown = useCallback((e: React.MouseEvent) => {
    previewDragRef.current = { dragging: true, startY: e.clientY, startHeight: previewHeight }
    e.preventDefault()
  }, [previewHeight])

  // Track boundary drag
  const handleTrackDividerDown = useCallback((e: React.MouseEvent) => {
    trackDragRef.current = { dragging: true, startY: e.clientY, startHeight: videoTrackHeight }
    e.preventDefault()
  }, [videoTrackHeight])

  const handleAudioDividerDown = useCallback((e: React.MouseEvent) => {
    // If audio height is 0 (flex), measure current rendered height as starting point
    const audioEl = (e.target as HTMLElement).previousElementSibling as HTMLElement | null
    const currentHeight = audioTrackHeight || (audioEl ? audioEl.getBoundingClientRect().height : 120)
    audioDragRef.current = { dragging: true, startY: e.clientY, startHeight: currentHeight }
    e.preventDefault()
  }, [audioTrackHeight])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (previewDragRef.current.dragging) {
        const delta = e.clientY - previewDragRef.current.startY
        const newHeight = Math.max(MIN_PREVIEW_HEIGHT, Math.min(MAX_PREVIEW_HEIGHT, previewDragRef.current.startHeight + delta))
        setPreviewHeight(newHeight)
        return
      }
      if (audioDragRef.current.dragging) {
        const delta = e.clientY - audioDragRef.current.startY
        const newHeight = Math.max(MIN_AUDIO_HEIGHT, Math.min(MAX_AUDIO_HEIGHT, audioDragRef.current.startHeight + delta))
        setAudioTrackHeight(newHeight)
        return
      }
      if (!trackDragRef.current.dragging) return
      const delta = e.clientY - trackDragRef.current.startY
      const newHeight = Math.max(MIN_VIDEO_HEIGHT, Math.min(MAX_VIDEO_HEIGHT, trackDragRef.current.startHeight + delta))
      setVideoTrackHeight(newHeight)
    }
    const handleMouseUp = () => {
      if (previewDragRef.current.dragging) {
        previewDragRef.current.dragging = false
        setPreviewHeight((current) => {
          localStorage.setItem(PREVIEW_HEIGHT_KEY, String(current))
          return current
        })
      }
      if (audioDragRef.current.dragging) {
        audioDragRef.current.dragging = false
        setAudioTrackHeight((current) => {
          localStorage.setItem(AUDIO_HEIGHT_KEY, String(current))
          return current
        })
      }
      if (trackDragRef.current.dragging) {
        trackDragRef.current.dragging = false
        setVideoTrackHeight((current) => {
          localStorage.setItem(VIDEO_HEIGHT_KEY, String(current))
          return current
        })
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  currentTimeRef.current = currentTime

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea')) return

      if (matchesHotkey(e, 'playPause')) {
        handlePreventDefault(e, 'playPause')
        handlePlayPause()
      }

      if (matchesHotkey(e, 'toggleTransformMode')) {
        setTransformMode((p) => !p)
      }

      // Navigate between keyframes
      if (matchesHotkey(e, 'nextKeyframe')) {
        handlePreventDefault(e, 'nextKeyframe')
        const sorted = [...keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds)
        const next = sorted.find((kf) => kf.timeSeconds > currentTimeRef.current + 0.1)
        if (next) {
          seekFnRef.current?.(next.timeSeconds)
          setSelectedKeyframe(next)
        }
      }
      if (matchesHotkey(e, 'prevKeyframe')) {
        handlePreventDefault(e, 'prevKeyframe')
        const sorted = [...keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds)
        const prev = [...sorted].reverse().find((kf) => kf.timeSeconds < currentTimeRef.current - 0.1)
        if (prev) {
          seekFnRef.current?.(prev.timeSeconds)
          setSelectedKeyframe(prev)
        }
      }

      // Frame stepping: Left / Right
      if (matchesHotkey(e, 'frameForward')) {
        handlePreventDefault(e, 'frameForward')
        const frameDur = 1 / (data.meta.fps || 24)
        seekFnRef.current?.(currentTimeRef.current + frameDur)
      }
      if (matchesHotkey(e, 'frameBackward')) {
        handlePreventDefault(e, 'frameBackward')
        const frameDur = 1 / (data.meta.fps || 24)
        seekFnRef.current?.(Math.max(0, currentTimeRef.current - frameDur))
      }

      // Curve pin navigation: [ / ]
      if (matchesHotkey(e, 'nextCurvePin') || matchesHotkey(e, 'prevCurvePin')) {
        if (!selectedTransition) return
        const tr = selectedTransition
        const fromKf = keyframes.find((k) => k.id === tr.from)
        const toKf = keyframes.find((k) => k.id === tr.to)
        if (!fromKf || !toKf || toKf.timeSeconds <= fromKf.timeSeconds) return
        const span = toKf.timeSeconds - fromKf.timeSeconds
        const curProgress = (currentTimeRef.current - fromKf.timeSeconds) / span
        // Collect all pin times from all curves
        const curveKeys = ['opacityCurve', 'redCurve', 'greenCurve', 'blueCurve', 'blackCurve', 'saturationCurve', 'hueShiftCurve', 'invertCurve', 'brightnessCurve', 'contrastCurve', 'exposureCurve', 'transformXCurve', 'transformYCurve', 'transformZCurve'] as const
        const pinTimes = new Set<number>()
        for (const key of curveKeys) {
          const curve = (tr as Record<string, unknown>)[key] as [number, number][] | null
          if (curve) for (const [px] of curve) pinTimes.add(px)
        }
        const sorted = [...pinTimes].sort((a, b) => a - b)
        const isNext = matchesHotkey(e, 'nextCurvePin')
        const target = isNext
          ? sorted.find((p) => p > curProgress + 0.001)
          : [...sorted].reverse().find((p) => p < curProgress - 0.001)
        if (target != null) {
          const targetTime = fromKf.timeSeconds + target * span
          seekFnRef.current?.(targetTime)
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [keyframes, handlePlayPause, selectedTransition])


  return (
    <div className="h-full flex">
      {/* Main timeline area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Preview */}
        <div
          className="bg-gray-950 flex items-center justify-center shrink-0 overflow-hidden"
          style={{ height: previewHeight }}
        >
          <div ref={previewContainerRef} className="h-full aspect-video bg-gray-800 rounded overflow-hidden relative">
            {hoverPreviewUrl && (
              hoverPreviewUrl.endsWith('.mp4') ? (
                <video src={hoverPreviewUrl} className="absolute inset-0 w-full h-full object-cover z-10" autoPlay muted loop playsInline />
              ) : (
                <img src={hoverPreviewUrl} className="absolute inset-0 w-full h-full object-cover z-10" draggable={false} />
              )
            )}
            {currentKeyframe?.hasSelectedImage || crossfadeData.frameA ? (
              <BeatEffectPreview
                ref={previewRef}
                src={currentKeyframe?.hasSelectedImage
                  ? beatlabFileUrl(data.projectName, `selected_keyframes/${currentKeyframe.id}.png`) + `?v=${currentKeyframe.selected ?? 0}`
                  : ''}
                beats={data.beats}
                audioEvents={filteredAudioEvents}
                userEffects={userEffects}
                suppressions={suppressions}
                currentTime={currentTime}
                isPlaying={isPlaying}
                className="w-full h-full object-cover"
                canvasWidth={canvasWidth}
                canvasHeight={canvasHeight}
                transitionFrameA={crossfadeData.frameA}
                transitionFrameB={crossfadeData.frameB}
                blendFactor={crossfadeData.blendFactor}
                layers={trackLayers.length > 0 ? trackLayers : undefined}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-600 text-sm">
                No image
              </div>
            )}
            {isTransitionLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
                <span className="text-white/70 text-xs">Loading frames...</span>
              </div>
            )}
            <TransformHandles
              containerRef={previewContainerRef}
              transition={selectedTransition}
              linearProgress={(() => {
                if (!selectedTransition) return 0
                const fromKf = keyframes.find((k) => k.id === selectedTransition.from)
                const toKf = keyframes.find((k) => k.id === selectedTransition.to)
                if (!fromKf || !toKf || toKf.timeSeconds <= fromKf.timeSeconds) return 0
                return Math.max(0, Math.min(0.999, (currentTime - fromKf.timeSeconds) / (toKf.timeSeconds - fromKf.timeSeconds)))
              })()}
              transformMode={transformMode}
              onCurvePinUpdate={(trId, curveKey, progress, value) => {
                if (!selectedTransition) return
                // Auto-keyframe: insert or update pin on the curve
                const styleKey = curveKey === 'transformXCurve' ? 'transformXCurve' : curveKey === 'transformYCurve' ? 'transformYCurve' : 'transformZCurve'
                const existing = (selectedTransition as Record<string, unknown>)[curveKey] as [number, number][] | null
                const pts: [number, number][] = existing ? [...existing] : curveKey === 'transformZCurve' ? [[0, 1], [1, 1]] : [[0, 0], [1, 0]]
                // Find existing pin near this progress (±0.005)
                const idx = pts.findIndex((p) => Math.abs(p[0] - progress) < 0.005)
                if (idx >= 0) {
                  pts[idx] = [pts[idx][0], value]
                } else {
                  pts.push([progress, value])
                  pts.sort((a, b) => a[0] - b[0])
                }
                // Update in-memory for immediate preview
                ;(selectedTransition as Record<string, unknown>)[curveKey] = pts
                // Debounced persist
                import('@/lib/beatlab-client').then(({ postUpdateTransitionStyle }) => {
                  postUpdateTransitionStyle(data.projectName, trId, { [styleKey]: pts } as never)
                })
              }}
              onAnchorUpdate={async (trId, anchorX, anchorY) => {
                if (selectedTransition) { selectedTransition.anchorX = anchorX; selectedTransition.anchorY = anchorY }
                const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client')
                await postUpdateTransitionStyle(data.projectName, trId, { anchorX, anchorY } as never)
              }}
              onMaskCenterUpdate={async (trId, cx, cy) => {
                if (selectedTransition) { selectedTransition.maskCenterX = cx; selectedTransition.maskCenterY = cy }
                const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client')
                await postUpdateTransitionStyle(data.projectName, trId, { maskCenterX: cx, maskCenterY: cy } as never)
              }}
            />
          </div>
        </div>

        {/* Preview/tracks divider */}
        <div
          className="h-1.5 cursor-row-resize hover:bg-blue-500/50 active:bg-blue-500 bg-gray-800 transition-colors shrink-0 relative z-20"
          onMouseDown={handlePreviewDividerDown}
        />

        {/* Controls bar */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 bg-gray-900 border-b border-gray-800 shrink-0">
          <button
            onClick={handlePlayPause}
            className="w-8 h-8 flex items-center justify-center bg-gray-800 hover:bg-gray-700 rounded transition-colors"
          >
            {isPlaying ? '⏸' : '▶'}
          </button>

          <TimeDisplay
            currentTime={currentTime}
            duration={effectiveDuration}
            onSeek={(time) => { if (seekFnRef.current) seekFnRef.current(time); else setCurrentTime(time) }}
          />

          {/* Playback speed */}
          <div className="flex items-center gap-1">
            <input
              type="range" min={0.1} max={4} step={0.1}
              value={playbackRate}
              onChange={(e) => {
                const rate = parseFloat(e.target.value)
                setPlaybackRate(rate)
                if (audioElRef.current) audioElRef.current.playbackRate = rate
                localStorage.setItem('beatlab-playback-speed', String(rate))
              }}
              className="w-14 h-1.5 accent-gray-500"
            />
            <span className="text-[10px] text-gray-500 w-7">{playbackRate}x</span>
          </div>

          {/* Undo / Redo */}
          <button
            onClick={() => {
              import('@/lib/beatlab-client').then(({ postUndo }) => {
                postUndo(data.projectName).then((result) => {
                  if (result.success) refreshTimeline()
                })
              })
            }}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 px-2 py-1 rounded transition-colors"
            title="Undo (Ctrl+Z)"
          >
            ↩
          </button>
          <button
            onClick={() => {
              import('@/lib/beatlab-client').then(({ postRedo }) => {
                postRedo(data.projectName).then((result) => {
                  if (result.success) refreshTimeline()
                })
              })
            }}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 px-2 py-1 rounded transition-colors"
            title="Redo (Ctrl+Shift+Z)"
          >
            ↪
          </button>

          {/* Jump to playhead */}
          <button
            onClick={() => {
              const el = scrollRef.current
              if (el) el.scrollLeft = currentTime * pxPerSec - el.clientWidth / 2
            }}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 px-2 py-1 rounded transition-colors"
            title="Center timeline on playhead"
          >
            ◎
          </button>

          {/* Transform mode toggle */}
          <button
            onClick={() => setTransformMode((p) => !p)}
            className={`text-xs px-2 py-1 rounded transition-colors font-serif ${transformMode ? 'bg-blue-500/20 text-blue-300 border border-dashed border-blue-500/60' : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 border border-dashed border-gray-600'}`}
            title="Toggle transform mode (T)"
          >
            T
          </button>

          {/* Add keyframe at playhead */}
          <button
            onClick={handleAddKeyframe}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 px-2 py-1 rounded transition-colors"
            title="Add keyframe at playhead position"
          >
            + Keyframe
          </button>

          <button
            onClick={() => handleAddEffect(currentTime)}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-yellow-400/70 hover:text-yellow-300 px-2 py-1 rounded transition-colors"
            title="Add effect at playhead position"
          >
            + Effect
          </button>

          <button
            onClick={() => handleAddSuppression(currentTime, currentTime + 2)}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-red-400/70 hover:text-red-300 px-2 py-1 rounded transition-colors"
            title="Add suppression zone at playhead (2s default)"
          >
            + Suppress
          </button>

          {activeTransition && (
            <button
              onClick={async () => {
                try {
                  const { postSplitTransition } = await import('@/lib/beatlab-client')
                  await postSplitTransition(data.projectName, activeTransition.id, currentTime)
                  refreshTimeline()
                } catch (e) {
                  console.error('Split failed:', e)
                  alert(`Split failed: ${e}`)
                }
              }}
              className="text-xs bg-gray-800 hover:bg-gray-700 text-cyan-400/70 hover:text-cyan-300 px-2 py-1 rounded transition-colors"
              title="Split transition at playhead"
            >
              Split
            </button>
          )}

          <button
            onClick={async () => {
              try {
                console.log('[addTrack] sending request...')
                const result = await postAddTrack(data.projectName)
                console.log('[addTrack] result:', result)
                if (result.id) {
                  setSelectedTrackId(result.id)
                  router.invalidate()
                }
              } catch (e) {
                console.error('[addTrack] failed:', e)
                alert(`Add track failed: ${e}`)
              }
            }}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-teal-400/70 hover:text-teal-300 px-2 py-1 rounded transition-colors"
            title="Add a new video track"
          >
            + Track
          </button>

          {hiddenTracks.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  postUpdateTrack(data.projectName, e.target.value, { hidden: false } as never).then(() => router.invalidate())
                }
              }}
              className="text-[10px] bg-gray-800 text-gray-500 rounded px-1 py-1 border-none focus:outline-none cursor-pointer"
              title="Show hidden tracks"
            >
              <option value="">Show ({hiddenTracks.length})</option>
              {hiddenTracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}

          <button
            onClick={() => { const was = showDownloadPreview; closeAllPanels(); if (!was) setShowDownloadPreview(true) }}
            className={`text-xs px-2 py-1 rounded transition-colors ${showDownloadPreview ? 'bg-green-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-green-400/70 hover:text-green-300'}`}
            title="Download preview as WebM"
          >
            {recording ? `Rec ${Math.round(recording.progress * 100)}%` : 'Preview'}
          </button>

          {selectedKeyframeIds.size > 0 && (
            <button
              onClick={async () => {
                const ids = [...selectedKeyframeIds]
                if (!confirm(`Delete ${ids.length} keyframes?`)) return
                try {
                  await batchDeleteKeyframes({ data: { projectName: data.projectName, keyframeIds: ids } })
                  setSelectedKeyframeIds(new Set())
                  setSelectedKeyframe(null)
                  refreshTimeline()
                } catch (e) { alert(`Delete failed: ${e}`) }
              }}
              className="text-xs bg-red-900/50 hover:bg-red-800/60 text-red-400 hover:text-red-300 px-2 py-1 rounded transition-colors"
            >
              Delete {selectedKeyframeIds.size} KFs
            </button>
          )}

          {!v2 && <>
          <button
            onClick={() => { const was = showBin; closeAllPanels(); if (!was) setShowBin(true) }}
            className={`text-xs px-2 py-1 rounded transition-colors ${showBin ? 'bg-blue-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200'}`}
            title="Show deleted keyframes bin"
          >
            Bin
          </button>
          </>}

          <button
            onClick={async () => {
              try {
                const url = `${import.meta.env.VITE_BEATLAB_API_URL || 'http://localhost:8888'}/api/projects/${encodeURIComponent(data.projectName)}/bench/capture`
                const res = await fetch(url, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ time: currentTime, trackId: selectedTrackId }),
                })
                if (!res.ok) {
                  const text = await res.text()
                  console.error('Bench capture failed:', res.status, text)
                  alert(`Bench capture failed: ${res.status} ${text}`)
                }
              } catch (e) {
                console.error('Bench capture error:', e)
                alert(`Bench capture error: ${e}`)
              }
            }}
            disabled={!currentKeyframe}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-green-400 hover:text-green-300 disabled:text-gray-600 disabled:hover:bg-gray-800 px-2 py-1 rounded transition-colors"
            title="Capture the full-res frame at playhead (no effects) and save to bench"
          >
            Bench Keyframe
          </button>

          <button
            onClick={() => { closeAllPanels(); setShowImport(true) }}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 px-2 py-1 rounded transition-colors"
            title="Import images/videos from filesystem"
          >
            Import
          </button>

          {!v2 && <>
          <button
            onClick={() => setShowSections((v) => !v)}
            className={`text-xs px-2 py-1 rounded transition-colors ${showSections ? 'bg-purple-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200'}`}
            title="Edit narrative sections"
          >
            Sections
          </button>

          <button
            onClick={() => { const was = showVersions; closeAllPanels(); if (!was) setShowVersions(true) }}
            className={`text-xs px-2 py-1 rounded transition-colors ${showVersions ? 'bg-green-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200'}`}
            title="Version history — save, restore, branch"
          >
            Versions
          </button>

          <button
            onClick={() => { const was = showCheckpoints; closeAllPanels(); if (!was) setShowCheckpoints(true) }}
            className={`text-xs px-2 py-1 rounded transition-colors ${showCheckpoints ? 'bg-blue-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200'}`}
            title="Database checkpoints — save, restore, manage snapshots"
          >
            Checkpoints
          </button>

          <TimelineSwitcher projectName={data.projectName} onSwitch={() => router.invalidate()} />

          <button
            onClick={() => { const was = showSettings; closeAllPanels(); if (!was) setShowSettings(true) }}
            className={`text-xs px-2 py-1 rounded transition-colors ${showSettings ? 'bg-gray-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200'}`}
            title="Project settings"
          >
            Settings
          </button>

          <button
            onClick={() => { const was = showLogs; closeAllPanels(); if (!was) setShowLogs(true) }}
            className={`text-xs px-2 py-1 rounded transition-colors ${showLogs ? 'bg-gray-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200'}`}
            title="Server logs"
          >
            Logs
          </button>
          </>}

          {/* Batch generate when multiple transitions selected */}
          {selectedTransitionIds.size > 1 && (
            <button
              onClick={async () => {
                const ids = [...selectedTransitionIds]
                const trs = localTransitions.filter((t) => ids.includes(t.id))
                const withAction = trs.filter((t) => t.action)
                if (withAction.length === 0) { alert('None of the selected transitions have action prompts.'); return }
                if (withAction.length < trs.length && !confirm(`${trs.length - withAction.length} transitions have no action prompt and will be skipped. Continue with ${withAction.length}?`)) return
                for (const tr of withAction) {
                  try {
                    const result = await generateTransitionCandidates({ data: { projectName: data.projectName, transitionId: tr.id, count: 4, duration: tr.durationSeconds > 0 ? Math.round(tr.durationSeconds) : 8 } })
                    if (result.jobId) {
                      const { useJobContext: _jc } = await import('@/contexts/JobStateContext')
                      // Can't use hook here — fire and forget, status tracked via WebSocket
                    }
                  } catch (e) { console.error(`Batch generate failed for ${tr.id}:`, e) }
                }
              }}
              className="text-xs bg-orange-600 hover:bg-orange-500 text-white px-2 py-1 rounded transition-colors"
              title={`Generate videos for ${selectedTransitionIds.size} selected transitions`}
            >
              Generate {selectedTransitionIds.size} Videos
            </button>
          )}

          <div className="text-xs text-gray-600 ml-auto">
            Zoom: {pxPerSec.toFixed(0)}px/s (Ctrl+scroll)
          </div>
        </div>

        {/* Timeline tracks */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-x-auto overflow-y-auto relative"
          onWheel={handleWheel}
          onScroll={(e) => { setScrollLeft(e.currentTarget.scrollLeft); setScrollTop(e.currentTarget.scrollTop) }}
        >
          <div style={{ width: Math.max(totalWidth, 800), minHeight: '100%' }} className="relative flex flex-col">
            {/* Sticky header: time ruler, markers, descriptions */}
            <div className="sticky top-0 z-50 bg-gray-950">
              {/* Time ruler */}
              <TimeRuler duration={duration} pxPerSec={pxPerSec} onClick={handleTrackClick} />

              {/* Marker track */}
              <MarkerTrack
                markers={markers}
                pxPerSec={pxPerSec}
                scrollLeft={scrollLeft}
                viewportWidth={viewportWidth}
                onAdd={(time) => {
                  const id = `m_${Date.now()}`
                  const t = Math.round(time * 100) / 100
                  setMarkers((prev) => [...prev, { id, time: t, label: '' }])
                  postAddMarker(data.projectName, id, t).catch(() => {})
                }}
                onRemove={(id) => {
                  setMarkers((prev) => prev.filter((m) => m.id !== id))
                  postRemoveMarker(data.projectName, id).catch(() => {})
                }}
                onUpdate={(id, updates) => {
                  setMarkers((prev) => prev.map((m) => m.id === id ? { ...m, ...updates } : m))
                  postUpdateMarker(data.projectName, id, updates).catch(() => {})
                }}
                sectionMarkers={data.narrativeSections.map((s) => {
                  const parts = s.start.split(':')
                  const time = parts.length === 2 ? parseInt(parts[0], 10) * 60 + parseFloat(parts[1]) : 0
                  return { id: s.id, time, label: s.label, notes: s.notes }
                })}
                onSectionMarkerClick={(sectionId) => {
                  closeAllPanels()
                  setShowSections(true)
                  setScrollToSectionId(sectionId)
                }}
              />

              {/* Audio description track */}
              {aiAudioDescriptions.length > 0 && (
                <div className="relative shrink-0 border-b border-gray-800">
                  <div className="sticky left-0 top-0 px-2 py-0.5 text-[10px] text-gray-600 uppercase tracking-wider z-10 bg-gray-950/80 w-fit pointer-events-none">
                    Desc
                  </div>
                  <AudioDescriptionTrack
                    descriptions={aiAudioDescriptions}
                    audioEvents={aiAudioEvents}
                    pxPerSec={pxPerSec}
                    scrollLeft={scrollLeft}
                    viewportWidth={viewportWidth}
                    onSectionClick={(sec) => {
                      closeAllPanels()
                      setSelectedAudioDescription((prev) =>
                        prev?.sectionIndex === sec.sectionIndex ? null : sec
                      )
                    }}
                  />
                </div>
              )}
            </div>

            {/* Video tracks */}
            {sortedTracks.map((track, trackIdx) => {
              const tKfs = trackKeyframes.get(track.id) || []
              const tTrs = trackTransitions.get(track.id) || []
              const isActive = track.id === selectedTrackId
              return (
                <div key={track.id} className={isActive ? 'ring-1 ring-blue-500/30 rounded-sm' : ''}>
                  {/* Track header */}
                  <TrackHeader
                    track={track}
                    isActive={isActive}
                    scrollLeft={scrollLeft}
                    onSelect={() => setSelectedTrackId(track.id)}
                    onUpdate={(updates) => {
                      postUpdateTrack(data.projectName, track.id, updates).then(() => router.invalidate())
                    }}
                    onOpenSettings={() => {
                      closeAllPanels()
                      setTrackSettingsId(track.id)
                    }}
                    onMoveUp={trackIdx > 0 ? () => {
                      // Swap z_order with the track above (higher z_order in descending list = previous index)
                      const above = sortedTracks[trackIdx - 1]
                      Promise.all([
                        postUpdateTrack(data.projectName, track.id, { z_order: above.zOrder } as never),
                        postUpdateTrack(data.projectName, above.id, { z_order: track.zOrder } as never),
                      ]).then(() => router.invalidate())
                    } : undefined}
                    onMoveDown={trackIdx < sortedTracks.length - 1 ? () => {
                      const below = sortedTracks[trackIdx + 1]
                      Promise.all([
                        postUpdateTrack(data.projectName, track.id, { z_order: below.zOrder } as never),
                        postUpdateTrack(data.projectName, below.id, { z_order: track.zOrder } as never),
                      ]).then(() => router.invalidate())
                    } : undefined}
                  />
                  {/* Track content */}
                  <div
                    className={`relative cursor-pointer shrink-0 ${!track.enabled ? 'opacity-30' : ''} ${isActive ? 'ring-1 ring-inset ring-blue-500/40 bg-blue-900/5' : ''}`}
                    style={{ height: videoTrackHeight }}
                    onMouseDown={(e) => handleDragSelectDown(e)}
                    onClick={(e) => { if (dragSelectRef.current?.active || dragSelectRect) return; setSelectedTrackId(track.id); handleTrackClick(e) }}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes('application/x-beatlab-bin-kf')) {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'copy'
                      }
                    }}
                    onDrop={async (e) => {
                      const binKfId = e.dataTransfer.getData('application/x-beatlab-bin-kf')
                      if (!binKfId) return
                      e.preventDefault()
                      const rect = e.currentTarget.getBoundingClientRect()
                      const x = e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0)
                      const dropTime = x / pxPerSec
                      const ts = secondsToTimestamp(dropTime)
                      try {
                        await restoreKeyframe({ data: { projectName: data.projectName, keyframeId: binKfId } })
                        await updateKeyframeTimestamp({ data: { projectName: data.projectName, keyframeId: binKfId, newTimestamp: ts } })
                        refreshTimeline()
                      } catch (err) { console.error('Drop from bin failed:', err) }
                    }}
                  >
                    {isActive && <SectionBands sections={data.sections} pxPerSec={pxPerSec} />}
                    <VideoTrack
                      keyframes={tKfs}
                      pxPerSec={pxPerSec}
                      projectName={data.projectName}
                      selectedId={selectedKeyframe?.id ?? null}
                      selectedIds={selectedKeyframeIds}
                      duration={effectiveDuration}
                      onKeyframeClick={handleKeyframeClick}
                      onKeyframeDrag={handleKeyframeDrag}
                      onKeyframeDragEnd={handleKeyframeDragEnd}
                      scrollRef={scrollRef}
                      scrollLeft={scrollLeft}
                      viewportWidth={viewportWidth}
                      onDropVideo={handleDropVideoOnKeyframe}
                      onDropImage={handleDropImageOnKeyframe}
                      onDropStagedImage={async (kfId, stagingId, variant) => {
                        try {
                          const { promoteStagedCandidate } = await import('@/routes/project/$name/editor')
                          await promoteStagedCandidate({ data: { projectName: data.projectName, keyframeId: kfId, stagingId, variant } })
                          invalidateEntry(`kf:${kfId}`)
                          refreshTimeline()
                        } catch (e) { console.error('Drop staged image failed:', e) }
                      }}
                    />
                    <TransitionTrack
                      transitions={tTrs}
                      keyframes={tKfs}
                      pxPerSec={pxPerSec}
                      selectedId={selectedTransition?.id ?? null}
                      selectedIds={selectedTransitionIds}
                      duration={effectiveDuration}
                      onTransitionClick={handleTransitionClick}
                      onBoundaryDrag={handleKeyframeDrag}
                      onBoundaryDragEnd={handleKeyframeDragEnd}
                      onRemapChange={handleTransitionRemapChange}
                      onRetryRender={handleRetryRender}
                      onDropVideo={handleDropVideoOnTransition}
                      renderProgress={renderProgress}
                      scrollLeft={scrollLeft}
                      viewportWidth={viewportWidth}
                      isActiveTrack={isActive}
                    />
                  </div>
                </div>
              )
            })}

            {/* Draggable divider */}
            <div
              className="h-1.5 cursor-row-resize hover:bg-blue-500/50 active:bg-blue-500 bg-gray-800 transition-colors shrink-0 relative z-20"
              onMouseDown={handleTrackDividerDown}
            />

            {/* Audio track */}
            <div
              className={`relative cursor-pointer overflow-hidden ${audioTrackHeight ? '' : 'flex-1'}`}
              style={audioTrackHeight ? { height: audioTrackHeight } : { minHeight: 80 }}
              onClick={handleTrackClick}
            >
              <div className="sticky left-0 top-0 px-2 py-1 text-[10px] text-gray-600 uppercase tracking-wider z-10 bg-gray-950/80 w-fit pointer-events-none">
                Audio
              </div>
              {/* Beat markers */}
              <BeatMarkers beats={data.beats} audioEvents={aiAudioEvents} pxPerSec={pxPerSec} />
              {data.audioFile && (
                <AudioTrack
                  audioUrl={beatlabFileUrl(data.projectName, data.audioFile)}
                  pxPerSec={pxPerSec}
                  onTimeUpdate={setCurrentTime}
                  onDurationChange={setDuration}
                  onPlayingChange={setIsPlaying}
                  seekRef={seekFnRef}
                  playPauseRef={playPauseFnRef}
                  audioElRef={audioElRef}
                />
              )}
            </div>

            {/* Audio/FX divider */}
            <div
              className="h-1.5 cursor-row-resize hover:bg-blue-500/50 active:bg-blue-500 bg-gray-800 transition-colors shrink-0 relative z-20"
              onMouseDown={handleAudioDividerDown}
            />

            {/* Effects track */}
            <div className="relative h-8 shrink-0 cursor-crosshair">
              <div className="sticky left-0 top-0 px-2 py-0.5 text-[10px] text-gray-600 uppercase tracking-wider z-10 bg-gray-950/80 w-fit pointer-events-none">
                FX
              </div>
              <EffectsTrack
                effects={userEffects}
                pxPerSec={pxPerSec}
                selectedEffectId={selectedEffect?.id ?? null}
                selectedEffectIds={selectedEffectIds}
                onEffectClick={handleEffectClick}
                onSelectEffectsInRange={(from: number, to: number) => {
                  const ids = new Set(userEffects.filter((fx) => fx.time >= from && fx.time <= to).map((fx) => fx.id))
                  setSelectedEffectIds(ids)
                  if (ids.size > 0) {
                    const first = userEffects.find((fx) => ids.has(fx.id))
                    if (first) setSelectedEffect(first)
                  }
                }}
                onAddEffect={handleAddEffect}
                onEffectDrag={handleEffectDrag}
                onEffectDragEnd={handleEffectDragEnd}
                scrollLeft={scrollLeft}
                viewportWidth={viewportWidth}
              />
            </div>

            {/* Suppression track */}
            <div className="relative h-6 shrink-0 border-t border-gray-800 cursor-crosshair">
              <div className="absolute left-0 top-0 px-2 py-0.5 text-[10px] text-red-400/60 uppercase tracking-wider z-20 bg-gray-950/80 pointer-events-none">
                Mute
              </div>
              <SuppressionTrack
                suppressions={suppressions}
                pxPerSec={pxPerSec}
                onAddSuppression={handleAddSuppression}
                onResizeSuppression={handleResizeSuppression}
                selectedSuppressionId={selectedSuppressionId}
                selectedSuppressionIds={selectedSuppressionIds}
                onSuppressionClick={handleSuppressionClick}
                scrollLeft={scrollLeft}
                viewportWidth={viewportWidth}
              />
            </div>

            {/* Rules track */}
            {aiAudioRules.length > 0 && (
              <div className="relative shrink-0 border-t border-gray-800">
                <div className="sticky left-0 top-0 px-2 py-0.5 text-[10px] text-gray-600 uppercase tracking-wider z-10 bg-gray-950/80 w-fit pointer-events-none">
                  Rules
                </div>
                <RulesTrack
                  rules={aiAudioRules}
                  pxPerSec={pxPerSec}
                  scrollLeft={scrollLeft}
                  viewportWidth={viewportWidth}
                  selectedSectionKey={selectedRuleSection?.key ?? null}
                  onSectionClick={(sec) => {
                    closeAllPanels()
                    setSelectedRuleSection((prev) => prev?.key === sec.key ? null : sec)
                  }}
                />
              </div>
            )}

            {/* Drag-select rectangle */}
            {dragSelectRect && (
              <div
                className="absolute border border-blue-500/50 bg-blue-500/10 pointer-events-none z-40"
                style={{ left: dragSelectRect.x, top: dragSelectRect.y, width: dragSelectRect.w, height: dragSelectRect.h }}
              />
            )}

            {/* Playhead overlay */}
            {/* Hover markers for binned transition */}
            {hoveredBinTransition && (() => {
              const fromKf = keyframes.find((k) => k.id === hoveredBinTransition.from)
              const toKf = keyframes.find((k) => k.id === hoveredBinTransition.to)
              if (!fromKf || !toKf) return null
              const inX = fromKf.timeSeconds * pxPerSec
              const outX = toKf.timeSeconds * pxPerSec
              return (
                <>
                  <div className="absolute top-0 bottom-0 pointer-events-none z-40" style={{ left: inX }}>
                    <div className="w-px h-full bg-red-500/70" />
                    <div className="absolute top-0 left-1 text-[9px] text-red-400 bg-gray-900/80 px-1 rounded whitespace-nowrap">IN</div>
                  </div>
                  <div className="absolute top-0 bottom-0 pointer-events-none z-40" style={{ left: outX }}>
                    <div className="w-px h-full bg-red-500/70" />
                    <div className="absolute top-0 left-1 text-[9px] text-red-400 bg-gray-900/80 px-1 rounded whitespace-nowrap">OUT</div>
                  </div>
                  <div className="absolute top-0 bottom-0 pointer-events-none z-30 bg-red-500/5" style={{ left: inX, width: outX - inX }} />
                </>
              )
            })()}

            <Playhead
              currentTime={currentTime}
              pxPerSec={pxPerSec}
              duration={duration}
              onSeek={(time) => seekFnRef.current?.(time)}
              audioElRef={audioElRef}
              scrollTop={scrollTop}
            />
          </div>
        </div>
      </div>

      {/* Side panels — mutually exclusive: only one renders at a time.
         Priority order: settings > versions > bin > sections > keyframe > transition > audioDesc > effect
         In v2 mode, these panels live in dockview — skip rendering here. */}
      {v2 ? null : showDownloadPreview ? (
        <DownloadPreviewPanel
          currentTime={currentTime}
          duration={effectiveDuration}
          recording={recording}
          onRecord={async (startTime, endTime) => {
            const canvas = previewRef.current?.getCanvas()
            const audio = audioElRef.current
            if (!canvas || !audio) { alert('Preview canvas or audio not ready'); return }
            setRecording({ progress: 0 })
            try {
              const blob = await recordPreview({
                canvas, audioElement: audio,
                startTime, endTime,
                onProgress: (p) => setRecording({ progress: p }),
              })
              setRecording(null)
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `preview_${data.projectName}_${startTime.toFixed(0)}-${endTime.toFixed(0)}.webm`
              a.click()
              URL.revokeObjectURL(url)
            } catch (e) {
              setRecording(null)
              alert(`Recording failed: ${e}`)
            }
          }}
          onClose={() => setShowDownloadPreview(false)}
        />
      ) : showLogs ? (
        <LogPanel onClose={() => setShowLogs(false)} />
      ) : showSettings ? (
        <SettingsPanel
          data={data}
          projectName={data.projectName}
          onClose={() => setShowSettings(false)}
          onSave={() => router.invalidate()}
          onPreviewQualityChange={(q) => setPreviewQuality(q)}
        />
      ) : showVersions ? (
        <VersionHistoryPanel
          projectName={data.projectName}
          onClose={() => setShowVersions(false)}
          onRestore={() => router.invalidate()}
        />
      ) : showCheckpoints ? (
        <CheckpointsPanel
          projectName={data.projectName}
          onClose={() => setShowCheckpoints(false)}
          onRestore={() => router.invalidate()}
        />
      ) : showBin ? (
        <BinPanel
          projectName={data.projectName}
          onClose={() => setShowBin(false)}
          onRestore={() => router.invalidate()}
          poolSelection={poolSelection}
          onPoolSelect={setPoolSelection}
          onInsertPoolItem={async (selection, mode) => {
            try {
              if (mode === 'overwrite-current') {
                // Assign the pool item's image to the current keyframe
                if (!currentKeyframe) { alert('No keyframe under playhead'); return }
                const isImage = /\.(png|jpe?g|webp)$/i.test(selection.entry.path)
                if (isImage) {
                  const { postAssignKeyframeImage } = await import('@/lib/beatlab-client')
                  await postAssignKeyframeImage(data.projectName, currentKeyframe.id, selection.entry.path)
                  invalidateEntry(`kf:${currentKeyframe.id}`)
                }
                setPoolSelection(null)
                refreshTimeline()
                return
              }
              const { postInsertPoolItem } = await import('@/lib/beatlab-client')
              let insertTime = currentTime
              if (mode === 'after-current-kf' && currentKeyframe) {
                insertTime = currentKeyframe.timeSeconds + 0.01
              }
              await postInsertPoolItem(data.projectName, selection.type, selection.entry.path, insertTime)
              setPoolSelection(null)
              refreshTimeline()
            } catch (e) {
              alert(`Insert failed: ${e}`)
            }
          }}
          activeKeyframes={localKeyframes.map((kf) => ({ id: kf.id, timestamp: kf.timestamp, section: kf.section, prompt: kf.prompt, hasSelectedImage: kf.hasSelectedImage }))}
          activeTransitions={localTransitions.map((tr) => ({ id: tr.id, from: tr.from, to: tr.to, durationSeconds: tr.durationSeconds, hasSelectedVideo: tr.hasSelectedVideo }))}
          onHoverPreview={setHoverPreviewUrl}
          onHoverBinTransition={setHoveredBinTransition}
        />
      ) : selectedKeyframe ? (
        <KeyframePanel
          key={selectedKeyframe.id}
          keyframe={selectedKeyframe}
          projectName={data.projectName}
          onClose={() => setSelectedKeyframe(null)}
          onDelete={() => handleDeleteKeyframe(selectedKeyframe.id)}
          onMoveLeft={async () => {
            const trackKfs = keyframes.filter((kf) => kf.trackId === selectedKeyframe.trackId)
            const sorted = [...trackKfs].sort((a, b) => a.timeSeconds - b.timeSeconds)
            const idx = sorted.findIndex((kf) => kf.id === selectedKeyframe.id)
            if (idx <= 0) return
            const prev = sorted[idx - 1]
            const tmpTs = secondsToTimestamp(prev.timeSeconds)
            const curTs = secondsToTimestamp(selectedKeyframe.timeSeconds)
            try {
              await Promise.all([
                updateKeyframeTimestamp({ data: { projectName: data.projectName, keyframeId: selectedKeyframe.id, newTimestamp: tmpTs } }),
                updateKeyframeTimestamp({ data: { projectName: data.projectName, keyframeId: prev.id, newTimestamp: curTs } }),
              ])
              refreshTimeline()
            } catch (e) { console.error('Move left failed:', e) }
          }}
          onMoveRight={async () => {
            const trackKfs = keyframes.filter((kf) => kf.trackId === selectedKeyframe.trackId)
            const sorted = [...trackKfs].sort((a, b) => a.timeSeconds - b.timeSeconds)
            const idx = sorted.findIndex((kf) => kf.id === selectedKeyframe.id)
            if (idx < 0 || idx >= sorted.length - 1) return
            const next = sorted[idx + 1]
            const tmpTs = secondsToTimestamp(next.timeSeconds)
            const curTs = secondsToTimestamp(selectedKeyframe.timeSeconds)
            try {
              await Promise.all([
                updateKeyframeTimestamp({ data: { projectName: data.projectName, keyframeId: selectedKeyframe.id, newTimestamp: tmpTs } }),
                updateKeyframeTimestamp({ data: { projectName: data.projectName, keyframeId: next.id, newTimestamp: curTs } }),
              ])
              refreshTimeline()
            } catch (e) { console.error('Move right failed:', e) }
          }}
          onUnlink={async (side) => {
            const { postUnlinkKeyframe } = await import('@/lib/beatlab-client')
            await postUnlinkKeyframe(data.projectName, selectedKeyframe.id, side)
            refreshTimeline()
          }}
          onDuplicate={async () => {
            // Find next keyframe within same track
            const trackKfs = keyframes.filter((kf) => kf.trackId === selectedKeyframe.trackId)
            const sorted = [...trackKfs].sort((a, b) => a.timeSeconds - b.timeSeconds)
            const idx = sorted.findIndex((kf) => kf.id === selectedKeyframe.id)
            const nextKf = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null
            if (!nextKf) return
            const midTime = (selectedKeyframe.timeSeconds + nextKf.timeSeconds) / 2
            const ts = secondsToTimestamp(midTime)
            try {
              await duplicateKeyframe({
                data: { projectName: data.projectName, keyframeId: selectedKeyframe.id, timestamp: ts },
              })
              refreshTimeline()
            } catch (e) {
              console.error('Duplicate failed:', e)
              alert(`Duplicate failed: ${e}`)
            }
          }}
          onDataChange={() => refreshTimeline()}
          audioDescriptions={aiAudioDescriptions}
          audioEvents={aiAudioEvents}
          initialPromptRoster={data.promptRoster}
          onHoverPreview={setHoverPreviewUrl}
        />
      ) : selectedTransition ? (
        <TransitionPanel
          key={selectedTransition.id}
          transition={selectedTransition}
          projectName={data.projectName}
          motionPrompt={data.meta.motionPrompt}
          initialPromptRoster={data.promptRoster}
          audioDescriptions={aiAudioDescriptions}
          keyframes={keyframes}
          currentTime={currentTime}
          onClose={() => setSelectedTransition(null)}
          onDelete={() => handleDeleteTransition(selectedTransition.id)}
          onDuplicateToNext={async () => {
            const sorted = [...localTransitions].sort((a, b) => {
              const aFrom = keyframes.find((k) => k.id === a.from)
              const bFrom = keyframes.find((k) => k.id === b.from)
              return (aFrom?.timeSeconds ?? 0) - (bFrom?.timeSeconds ?? 0)
            })
            const idx = sorted.findIndex((t) => t.id === selectedTransition.id)
            const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null
            if (!next) { alert('No next transition'); return }
            const { postDuplicateTransitionVideo } = await import('@/lib/beatlab-client')
            await postDuplicateTransitionVideo(data.projectName, selectedTransition.id, next.id)
            refreshTimeline()
          }}
          onDuplicateToPrev={async () => {
            const sorted = [...localTransitions].sort((a, b) => {
              const aFrom = keyframes.find((k) => k.id === a.from)
              const bFrom = keyframes.find((k) => k.id === b.from)
              return (aFrom?.timeSeconds ?? 0) - (bFrom?.timeSeconds ?? 0)
            })
            const idx = sorted.findIndex((t) => t.id === selectedTransition.id)
            const prev = idx > 0 ? sorted[idx - 1] : null
            if (!prev) { alert('No previous transition'); return }
            const { postDuplicateTransitionVideo } = await import('@/lib/beatlab-client')
            await postDuplicateTransitionVideo(data.projectName, selectedTransition.id, prev.id)
            refreshTimeline()
          }}
          onDataChange={() => refreshTimeline()}
          onHoverPreview={setHoverPreviewUrl}
        />
      ) : selectedAudioDescription ? (
        <AudioDescriptionPanel
          key={selectedAudioDescription.sectionIndex}
          section={selectedAudioDescription}
          audioEvents={aiAudioEvents.filter(
            (ev) => ev.time >= selectedAudioDescription.startTime && ev.time <= selectedAudioDescription.endTime
          )}
          projectName={data.projectName}
          onClose={() => setSelectedAudioDescription(null)}
          onKeyframeInserted={() => refreshTimeline()}
        />
      ) : trackSettingsId ? (
        <TrackSettingsPanel
          track={data.tracks.find((t) => t.id === trackSettingsId) || data.tracks[0]}
          onClose={() => setTrackSettingsId(null)}
          onUpdate={(updates) => {
            postUpdateTrack(data.projectName, trackSettingsId!, updates as never).then(() => router.invalidate())
          }}
        />
      ) : selectedRuleSection ? (
        <RuleEditorPanel
          key={selectedRuleSection.key}
          section={selectedRuleSection}
          projectName={data.projectName}
          onClose={() => setSelectedRuleSection(null)}
          onUpdate={reloadAudioIntelligence}
          onRulesChange={(sectionRules) => {
            setLocalRules((prev) => {
              const sStart = selectedRuleSection.start
              const sEnd = selectedRuleSection.end
              const other = prev.filter((r) => {
                const s = r._start ?? r._group_start ?? 0
                const e = r._end ?? r._group_end ?? 0
                return !(s === sStart && e === sEnd)
              })
              const next = [...other, ...sectionRules]
              const changed = sectionRules.map((r) => `${r.stem}→${r.effect}${(r as Record<string,unknown>)._disabled ? '[OFF]' : ''}`).join(', ')
              console.log(`[Timeline] localRules updated: removed ${prev.length - other.length}, added ${sectionRules.length} (${changed})`)
              return next
            })
          }}
        />
      ) : selectedEffect ? (
        <EffectEditor
          effect={selectedEffect}
          onUpdate={handleEffectUpdate}
          onDelete={handleEffectDelete}
          onClose={() => { setSelectedEffect(null); setSelectedEffectIds(new Set()) }}
        />
      ) : selectedSuppressionId ? (() => {
        const sup = suppressions.find((s) => s.id === selectedSuppressionId)
        if (!sup) return null
        return (
          <SuppressionEditorPanel
            suppression={sup}
            onUpdate={(effectTypes) => handleUpdateSuppressionTypes(selectedSuppressionId, effectTypes)}
            onUpdateSuppression={(updates) => {
              const updated = suppressions.map((s) => s.id === selectedSuppressionId ? { ...s, ...updates } : s)
              setSuppressions(updated)
              persistEffects(userEffects, updated)
            }}
            onResize={(from, to) => handleResizeSuppression(selectedSuppressionId, from, to)}
            onDelete={() => { handleDeleteSuppression(selectedSuppressionId); setSelectedSuppressionId(null) }}
            onClose={() => setSelectedSuppressionId(null)}
          />
        )
      })() : null}

      {/* Sections sidebar — independent of mutex panel chain (v2: rendered in dockview) */}
      {!v2 && showSections && (
        <NarrativeSectionPanel
          sections={data.narrativeSections}
          projectName={data.projectName}
          markers={markers}
          onClose={() => { setShowSections(false); setScrollToSectionId(null) }}
          onSeek={(time) => {
            if (seekFnRef.current) seekFnRef.current(time)
            else setCurrentTime(time)
            if (scrollRef.current) {
              const x = time * pxPerSec
              const vw = scrollRef.current.clientWidth
              scrollRef.current.scrollLeft = Math.max(0, x - vw / 3)
            }
          }}
          onSectionsChange={() => router.invalidate()}
          currentTime={currentTime}
          scrollToId={scrollToSectionId}
        />
      )}

      {/* Import dialog */}
      {showImport && (
        <ImportDialog
          projectName={data.projectName}
          onClose={() => setShowImport(false)}
          onImported={() => router.invalidate()}
        />
      )}
    </div>
  )
}

const TimeRuler = memo(function TimeRuler({ duration, pxPerSec, onClick }: { duration: number; pxPerSec: number; onClick?: (e: React.MouseEvent) => void }) {
  const marks: { time: number; label: string }[] = []

  let interval = 60
  if (pxPerSec > 15) interval = 30
  if (pxPerSec > 30) interval = 10
  if (pxPerSec > 60) interval = 5
  if (pxPerSec > 120) interval = 1

  for (let t = 0; t <= duration; t += interval) {
    marks.push({ time: t, label: formatTime(t) })
  }

  return (
    <div className="h-5 border-b border-gray-800 relative bg-gray-950 shrink-0 cursor-pointer" onClick={onClick}>
      {marks.map((m) => (
        <div
          key={m.time}
          className="absolute top-0 h-full flex items-end"
          style={{ left: m.time * pxPerSec }}
        >
          <div className="w-px h-2 bg-gray-700" />
          <span className="text-[9px] text-gray-600 ml-1 whitespace-nowrap">{m.label}</span>
        </div>
      ))}
    </div>
  )
})

const STEM_COLORS: Record<string, string> = {
  kick: '239, 68, 68',     // red
  snare: '59, 130, 246',   // blue
  hh: '156, 163, 175',     // gray
  crash: '245, 158, 11',   // amber
  ride: '168, 85, 247',    // purple
  bass: '34, 197, 94',     // green
  piano: '236, 72, 153',   // pink
  guitar: '251, 146, 60',  // orange
  other: '107, 114, 128',  // gray
}

const BeatMarkers = memo(function BeatMarkers({ beats, audioEvents, pxPerSec }: { beats: Beat[]; audioEvents?: AudioEvent[]; pxPerSec: number }) {
  // Prefer audio intelligence events over raw beats
  if (audioEvents && audioEvents.length > 0) {
    const step = pxPerSec < 10 ? 4 : pxPerSec < 20 ? 2 : 1
    return (
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {audioEvents.map((ev, i) => {
          if (i % step !== 0) return null
          const x = ev.time * pxPerSec
          const w = Math.max(ev.duration * pxPerSec, 1)
          const color = STEM_COLORS[ev.stem_source] || STEM_COLORS.other
          const opacity = 0.1 + ev.intensity * 0.35
          return (
            <div
              key={i}
              className="absolute top-0 h-full"
              style={{ left: x, width: w, backgroundColor: `rgba(${color}, ${opacity})` }}
            />
          )
        })}
      </div>
    )
  }

  if (beats.length === 0) return null

  const step = pxPerSec < 10 ? 4 : pxPerSec < 20 ? 2 : 1

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {beats.map((beat, i) => {
        if (i % step !== 0) return null
        const x = beat.time * pxPerSec
        const opacity = 0.1 + beat.intensity * 0.3
        return (
          <div
            key={i}
            className="absolute top-0 h-full"
            style={{ left: x, width: 1, backgroundColor: `rgba(59, 130, 246, ${opacity})` }}
          />
        )
      })}
    </div>
  )
})

const SECTION_COLORS: Record<string, string> = {
  verse: 'rgba(59, 130, 246, 0.08)',
  chorus: 'rgba(168, 85, 247, 0.12)',
  drop: 'rgba(239, 68, 68, 0.12)',
  bridge: 'rgba(34, 197, 94, 0.08)',
  intro: 'rgba(107, 114, 128, 0.06)',
  outro: 'rgba(107, 114, 128, 0.06)',
  buildup: 'rgba(245, 158, 11, 0.10)',
  low_energy: 'rgba(59, 130, 246, 0.05)',
  high_energy: 'rgba(239, 68, 68, 0.08)',
  mid_energy: 'rgba(168, 85, 247, 0.06)',
}

const SectionBands = memo(function SectionBands({ sections, pxPerSec }: { sections: Section[]; pxPerSec: number }) {
  if (sections.length === 0) return null

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {sections.map((section, i) => {
        const x = section.start_time * pxPerSec
        const w = (section.end_time - section.start_time) * pxPerSec
        const color = SECTION_COLORS[section.type] || SECTION_COLORS[section.label] || 'rgba(107, 114, 128, 0.04)'
        return (
          <div
            key={i}
            className="absolute top-0 h-full"
            style={{ left: x, width: w, backgroundColor: color }}
          >
            {w > 40 && (
              <span className="absolute bottom-0.5 right-1 text-[7px] text-gray-600 truncate max-w-full">
                {section.label}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
})

const DESC_PANEL_WIDTH_KEY = 'beatlab-desc-panel-width'
const DESC_PANEL_DEFAULT_WIDTH = 360
const DESC_PANEL_MIN_WIDTH = 240

const ALL_SUPPRESSION_TYPES: import('@/lib/beatlab-client').EffectType[] = ['pulse', 'zoom', 'shake', 'glow', 'flash', 'echo']
const SUPPRESSION_COLORS: Record<string, string> = {
  pulse: 'bg-yellow-500', zoom: 'bg-blue-500', shake: 'bg-red-500', glow: 'bg-purple-500', flash: 'bg-white', echo: 'bg-teal-500',
}

function SuppressionEditorPanel({ suppression, onUpdate, onUpdateSuppression, onResize, onDelete, onClose }: {
  suppression: import('@/lib/beatlab-client').BeatSuppression
  onUpdate: (effectTypes: import('@/lib/beatlab-client').EffectType[] | undefined) => void
  onUpdateSuppression: (updates: Partial<import('@/lib/beatlab-client').BeatSuppression>) => void
  onResize: (from: number, to: number) => void
  onDelete: () => void
  onClose: () => void
}) {
  const STORAGE_KEY = 'beatlab-side-panel-width'
  const MIN_WIDTH = 240
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return 360
    return Math.max(MIN_WIDTH, parseInt(localStorage.getItem(STORAGE_KEY) || '360', 10))
  })
  const panelDrag = useRef(false)
  const panelStartX = useRef(0)
  const panelStartW = useRef(0)
  useEffect(() => {
    const move = (e: MouseEvent) => { if (!panelDrag.current) return; setWidth(Math.max(MIN_WIDTH, panelStartW.current + (panelStartX.current - e.clientX))) }
    const up = () => { if (panelDrag.current) { panelDrag.current = false; localStorage.setItem(STORAGE_KEY, String(width)) } }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
  }, [width])
  useEffect(() => { localStorage.setItem(STORAGE_KEY, String(width)) }, [width])

  const hasTypeFilter = suppression.effectTypes && suppression.effectTypes.length > 0
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

  return (
    <div className="relative flex shrink-0" style={{ width }}>
      <div
        className="w-1 cursor-col-resize hover:bg-blue-500/50 active:bg-blue-500 transition-colors shrink-0"
        onMouseDown={(e) => { panelDrag.current = true; panelStartX.current = e.clientX; panelStartW.current = width; e.preventDefault() }}
      />
      <div className="flex-1 bg-gray-900 border-l border-gray-800 flex flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <span className="text-xs text-red-400 font-medium">Mute Zone — {suppression.id}</span>
        <div className="flex items-center gap-2">
          <button onClick={onDelete} className="text-[10px] text-red-500/70 hover:text-red-400">Delete</button>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">&times;</button>
        </div>
      </div>
      <div className="p-3 space-y-4">
        <div className="text-[10px] text-gray-500">
          {fmtTime(suppression.from)} — {fmtTime(suppression.to)} ({(suppression.to - suppression.from).toFixed(1)}s)
        </div>

        {/* Time range */}
        <div className="space-y-2">
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-0.5">Start</label>
            <input type="text" defaultValue={fmtTime(suppression.from)}
              onBlur={(e) => {
                const parts = e.target.value.split(':')
                if (parts.length === 2) onResize(parseInt(parts[0]) * 60 + parseFloat(parts[1]), suppression.to)
              }}
              className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700 focus:border-red-500 focus:outline-none font-mono"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-0.5">End</label>
            <input type="text" defaultValue={fmtTime(suppression.to)}
              onBlur={(e) => {
                const parts = e.target.value.split(':')
                if (parts.length === 2) onResize(suppression.from, parseInt(parts[0]) * 60 + parseFloat(parts[1]))
              }}
              className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700 focus:border-red-500 focus:outline-none font-mono"
            />
          </div>
        </div>

        {/* Primary effect type toggles */}
        <div className="space-y-1">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Primary Effects</div>
          <div className="text-[9px] text-gray-600 mb-1">
            {hasTypeFilter ? `Muting: ${suppression.effectTypes!.join(', ')}` : 'Muting ALL primary'}
          </div>
          <div className="grid grid-cols-3 gap-1">
            {ALL_SUPPRESSION_TYPES.map((t) => {
              const active = !hasTypeFilter || suppression.effectTypes!.includes(t)
              return (
                <button
                  key={t}
                  className={`text-[10px] px-2 py-1.5 rounded transition-colors ${active ? `${SUPPRESSION_COLORS[t]} text-black font-bold` : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}
                  onClick={() => {
                    if (!hasTypeFilter) {
                      onUpdate(ALL_SUPPRESSION_TYPES.filter((et) => et !== t))
                    } else {
                      const current = suppression.effectTypes!
                      if (current.includes(t)) {
                        const next = current.filter((et) => et !== t)
                        onUpdate(next.length === 0 ? undefined : next)
                      } else {
                        const next = [...current, t]
                        onUpdate(next.length === ALL_SUPPRESSION_TYPES.length ? undefined : next)
                      }
                    }
                  }}
                >{t}</button>
              )
            })}
          </div>
          <button
            onClick={() => onUpdate(undefined)}
            className="w-full text-[10px] text-red-400 hover:text-red-300 bg-gray-800 py-1 rounded mt-1"
          >Mute All Primary</button>
        </div>

        {/* Layered effect type toggles */}
        <div className="space-y-1">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Layered Effects</div>
          {(() => {
            const hasLayerFilter = suppression.layerEffectTypes && suppression.layerEffectTypes.length > 0
            return (
              <>
                <div className="text-[9px] text-gray-600 mb-1">
                  {hasLayerFilter ? `Muting layers: ${suppression.layerEffectTypes!.join(', ')}` : 'Layers pass through'}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {ALL_SUPPRESSION_TYPES.map((t) => {
                    const active = hasLayerFilter && suppression.layerEffectTypes!.includes(t)
                    return (
                      <button
                        key={t}
                        className={`text-[10px] px-2 py-1.5 rounded transition-colors ${active ? `${SUPPRESSION_COLORS[t]} text-black font-bold` : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}
                        onClick={() => {
                          const current = suppression.layerEffectTypes || []
                          const next = current.includes(t)
                            ? current.filter((et) => et !== t)
                            : [...current, t]
                          onUpdateSuppression({ layerEffectTypes: next.length > 0 ? next : undefined })
                        }}
                      >{t}</button>
                    )
                  })}
                </div>
                <button
                  onClick={() => onUpdateSuppression({ layerEffectTypes: [...ALL_SUPPRESSION_TYPES] })}
                  className="w-full text-[10px] text-red-400 hover:text-red-300 bg-gray-800 py-1 rounded mt-1"
                >Mute All Layers</button>
              </>
            )
          })()}
        </div>
      </div>
      </div>
    </div>
  )
}

function TrackSettingsPanel({ track, onClose, onUpdate }: {
  track: Track
  onClose: () => void
  onUpdate: (updates: Partial<Track>) => void
}) {
  const STORAGE_KEY = 'beatlab-side-panel-width'
  const BLEND_MODES: import('@/lib/beatlab-client').BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'difference', 'add', 'soft-light']

  const [blendMode, setBlendMode] = useState(track.blendMode)
  const [opacity, setOpacity] = useState(track.baseOpacity)
  const [color, setColor] = useState<[number, number, number]>(track.chromaKey?.color || [0, 1, 0])
  const [threshold, setThreshold] = useState(track.chromaKey?.threshold ?? 0.3)
  const [feather, setFeather] = useState(track.chromaKey?.feather ?? 0.1)

  const hexColor = `#${color.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`

  return (
    <div className="shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col overflow-y-auto" style={{ width: parseInt(localStorage.getItem(STORAGE_KEY) || '360', 10) }}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <span className="text-xs text-amber-400 font-medium">Track Settings — {track.name}</span>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">&times;</button>
      </div>
      <div className="p-3 space-y-4">

        {/* Blend Mode */}
        <div className="space-y-1">
          <label className="text-[10px] text-gray-500 uppercase tracking-wider">Blend Mode</label>
          <select
            value={blendMode}
            onChange={(e) => {
              const v = e.target.value as import('@/lib/beatlab-client').BlendMode
              setBlendMode(v)
              onUpdate({ blendMode: v })
            }}
            className="w-full bg-gray-800 text-gray-200 text-xs px-2 py-1.5 rounded border border-gray-700"
          >
            {BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        {/* Opacity */}
        <div className="space-y-1">
          <label className="text-[10px] text-gray-500 uppercase tracking-wider">Opacity: {Math.round(opacity * 100)}%</label>
          <input type="range" min={0} max={100} step={1}
            value={Math.round(opacity * 100)}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10) / 100
              setOpacity(v)
              onUpdate({ baseOpacity: v })
            }}
            className="w-full h-1.5 accent-amber-500" />
        </div>

        {/* Chroma Key section — only show when blend mode is chroma-key */}
        {blendMode === 'chroma-key' && (
          <>
            <div className="border-t border-gray-800 pt-3">
              <div className="text-[10px] text-gray-500 mb-2">
                Remove a specific color from this track's frames. Pixels matching the key color become transparent, revealing the track below.
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-gray-500 uppercase tracking-wider">Key Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={hexColor}
                  onChange={(e) => {
                    const hex = e.target.value
                    const r = parseInt(hex.slice(1, 3), 16) / 255
                    const g = parseInt(hex.slice(3, 5), 16) / 255
                    const b = parseInt(hex.slice(5, 7), 16) / 255
                    setColor([r, g, b])
                  }}
                  className="w-10 h-8 rounded border border-gray-700 cursor-pointer"
                />
                <span className="text-[10px] text-gray-400 font-mono">{hexColor}</span>
                <button
                  onClick={async () => {
                    try {
                      const dropper = new ((window as Record<string, unknown>).EyeDropper as new () => { open: () => Promise<{ sRGBHex: string }> })()
                      const result = await dropper.open()
                      const hex = result.sRGBHex
                      const r = parseInt(hex.slice(1, 3), 16) / 255
                      const g = parseInt(hex.slice(3, 5), 16) / 255
                      const b = parseInt(hex.slice(5, 7), 16) / 255
                      setColor([r, g, b])
                    } catch {
                      // User cancelled or API not available
                    }
                  }}
                  className="text-[9px] px-1.5 py-0.5 rounded bg-gray-800 text-amber-400 hover:text-amber-300 border border-gray-700"
                  title="Pick color from screen"
                >
                  Eyedropper
                </button>
                <div className="flex gap-1">
                  <button onClick={() => setColor([0, 1, 0])} className="text-[9px] px-1.5 py-0.5 rounded bg-green-800 text-green-300">Green</button>
                  <button onClick={() => setColor([0, 0, 1])} className="text-[9px] px-1.5 py-0.5 rounded bg-blue-800 text-blue-300">Blue</button>
                  <button onClick={() => setColor([0, 0, 0])} className="text-[9px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">Black</button>
                  <button onClick={() => setColor([1, 1, 1])} className="text-[9px] px-1.5 py-0.5 rounded bg-white text-gray-800">White</button>
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-gray-500 uppercase tracking-wider">Threshold: {threshold.toFixed(2)}</label>
              <input type="range" min={0} max={100} step={1}
                value={Math.round(threshold * 100)}
                onChange={(e) => setThreshold(parseInt(e.target.value, 10) / 100)}
                className="w-full h-1.5 accent-amber-500" />
              <div className="text-[9px] text-gray-600">How close to the key color a pixel must be to become transparent.</div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-gray-500 uppercase tracking-wider">Feather: {feather.toFixed(2)}</label>
              <input type="range" min={0} max={50} step={1}
                value={Math.round(feather * 100)}
                onChange={(e) => setFeather(parseInt(e.target.value, 10) / 100)}
                className="w-full h-1.5 accent-amber-500" />
              <div className="text-[9px] text-gray-600">Edge softness for keyed pixels.</div>
            </div>

            <button
              onClick={() => onUpdate({ chromaKey: { color, threshold, feather } } as never)}
              className="w-full text-xs bg-amber-600 hover:bg-amber-500 text-white py-2 rounded transition-colors"
            >
              Apply Chroma Key
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function RuleEditorPanel({ section, projectName, onClose, onUpdate, onRulesChange }: {
  section: RuleSection
  projectName: string
  onClose: () => void
  onUpdate: () => void
  onRulesChange?: (rules: import('@/lib/beatlab-client').AudioRule[]) => void
}) {
  const [rules, setRules] = useState(section.rules.map((r) => ({ ...r })))
  const [saving, setSaving] = useState(false)

  const handleRuleChange = useCallback((idx: number, field: string, value: number | string) => {
    setRules((prev) => {
      const next = prev.map((r, i) => i === idx ? { ...r, [field]: value } : r)
      onRulesChange?.(next)
      return next
    })
  }, [onRulesChange])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      // Fetch all rules, replace this section's rules, save + reapply
      const allRes = await window.fetch(`${import.meta.env.VITE_BEATLAB_API_URL || 'http://localhost:8888'}/api/projects/${encodeURIComponent(projectName)}/audio-intelligence`)
      const allData = await allRes.json() as { rules: import('@/lib/beatlab-client').AudioRule[] }
      const allRules = allData.rules || []

      const sectionStart = section.start
      const sectionEnd = section.end
      const otherRules = allRules.filter((r) => {
        const s = r._start ?? r._group_start ?? 0
        const e = r._end ?? r._group_end ?? 0
        return !(s === sectionStart && e === sectionEnd)
      })
      const updated = [...otherRules, ...rules]

      // Save rules AND regenerate events in one call
      const sectionRuleSummary = rules.map((r) => `${r.stem}/${r.band}→${r.effect}${(r as Record<string,unknown>)._disabled ? ' [OFF]' : ''}`).join(', ')
      console.log(`[RuleEditor] Sending ${updated.length} rules (${otherRules.length} other + ${rules.length} section): ${sectionRuleSummary}`)
      const { postReapplyRules } = await import('@/lib/beatlab-client')
      const result = await postReapplyRules(projectName, updated, section.start, section.end)
      console.log(`[RuleEditor] Saved ${updated.length} rules, regenerated ${result.eventCount} events`)
      onUpdate()
    } catch (e) {
      alert(`Save failed: ${e}`)
    } finally {
      setSaving(false)
    }
  }, [rules, projectName, section, onUpdate])

  const RULE_EFFECTS = ['zoom_pulse', 'zoom_bounce', 'shake_x', 'shake_y', 'flash', 'hard_cut', 'contrast_pop', 'glow_swell', 'echo', 'echo_pulse'] as const
  const EFFECT_COLORS: Record<string, string> = {
    zoom_pulse: 'text-blue-400', zoom_bounce: 'text-blue-300', shake_x: 'text-red-400',
    shake_y: 'text-red-300', flash: 'text-yellow-400', hard_cut: 'text-yellow-500',
    contrast_pop: 'text-purple-400', glow_swell: 'text-emerald-400', echo: 'text-teal-400',
    echo_pulse: 'text-teal-300',
  }

  return (
    <div className="w-80 shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
        <div>
          <span className="text-xs text-amber-400 font-medium">{section.groupName || 'Rules'}</span>
          <span className="text-[10px] text-gray-500 ml-2">{section.start.toFixed(0)}s – {section.end.toFixed(0)}s</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-[10px] text-green-400 hover:text-green-300 disabled:text-gray-600"
          >{saving ? 'Applying...' : 'Save & Apply'}</button>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">&times;</button>
        </div>
      </div>

      <div className="p-2 space-y-2">
        {rules.map((r, i) => (
          <div key={i} className={`rounded p-2 space-y-1.5 ${(r as Record<string, unknown>)._disabled ? 'bg-gray-800/20 opacity-40' : 'bg-gray-800/50'}`}>
            <div className="flex items-center justify-between gap-1">
              <button
                onClick={() => handleRuleChange(i, '_disabled', (r as Record<string, unknown>)._disabled ? '' : 'true')}
                className={`text-[10px] w-4 h-4 flex items-center justify-center rounded shrink-0 ${(r as Record<string, unknown>)._disabled ? 'text-gray-600' : 'text-green-400'}`}
                title={(r as Record<string, unknown>)._disabled ? 'Enable rule' : 'Disable rule'}
              >{(r as Record<string, unknown>)._disabled ? '○' : '●'}</button>
              <span className="text-[10px] font-mono text-gray-300">{r.stem}/{r.band}</span>
              <button
                onClick={() => {
                  const idx = RULE_EFFECTS.indexOf(r.effect as typeof RULE_EFFECTS[number])
                  const next = RULE_EFFECTS[(idx + 1) % RULE_EFFECTS.length]
                  handleRuleChange(i, 'effect', next)
                }}
                className={`text-[10px] font-medium cursor-pointer hover:underline ${EFFECT_COLORS[r.effect] || 'text-gray-400'}`}
                title="Click to cycle effect type"
              >{r.effect}</button>
            </div>

            {/* Intensity scale */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-gray-500 w-14 shrink-0">Intensity</span>
              <input type="range" min={0} max={500} step={5}
                value={Math.round(r.intensity_scale * 100)}
                onChange={(e) => handleRuleChange(i, 'intensity_scale', parseInt(e.target.value, 10) / 100)}
                className="flex-1 h-1.5 accent-amber-500" />
              <span className="text-[9px] text-gray-400 w-8 text-right font-mono">×{r.intensity_scale.toFixed(2)}</span>
            </div>

            {/* Duration */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-gray-500 w-14 shrink-0">Duration</span>
              <input type="range" min={10} max={300} step={10}
                value={Math.round(r.duration * 100)}
                onChange={(e) => handleRuleChange(i, 'duration', parseInt(e.target.value, 10) / 100)}
                className="flex-1 h-1.5 accent-amber-500" />
              <span className="text-[9px] text-gray-400 w-8 text-right font-mono">{r.duration.toFixed(1)}s</span>
            </div>

            {/* Min strength */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-gray-500 w-14 shrink-0">Min str</span>
              <input type="range" min={0} max={100} step={5}
                value={Math.round(r.min_strength * 100)}
                onChange={(e) => handleRuleChange(i, 'min_strength', parseInt(e.target.value, 10) / 100)}
                className="flex-1 h-1.5 accent-amber-500" />
              <span className="text-[9px] text-gray-400 w-8 text-right font-mono">{r.min_strength.toFixed(2)}</span>
            </div>

            {/* Max strength */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-gray-500 w-14 shrink-0">Max str</span>
              <input type="range" min={0} max={100} step={5}
                value={Math.round(r.max_strength * 100)}
                onChange={(e) => handleRuleChange(i, 'max_strength', parseInt(e.target.value, 10) / 100)}
                className="flex-1 h-1.5 accent-amber-500" />
              <span className="text-[9px] text-gray-400 w-8 text-right font-mono">{r.max_strength.toFixed(2)}</span>
            </div>

            {r.rationale && (
              <div className="text-[8px] text-gray-600 italic mt-1">{r.rationale}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function AudioDescriptionPanel({ section, audioEvents, projectName, onClose, onKeyframeInserted }: {
  section: import('@/lib/beatlab-client').AudioDescription
  audioEvents: AudioEvent[]
  projectName: string
  onClose: () => void
  onKeyframeInserted: () => void
}) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return DESC_PANEL_DEFAULT_WIDTH
    const stored = localStorage.getItem(DESC_PANEL_WIDTH_KEY)
    return stored ? Math.max(DESC_PANEL_MIN_WIDTH, parseInt(stored, 10)) : DESC_PANEL_DEFAULT_WIDTH
  })
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)
  const [tab, setTab] = useState<'description' | 'suggest'>('description')

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    e.preventDefault()
  }, [width])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = startX.current - e.clientX
      const newWidth = Math.max(DESC_PANEL_MIN_WIDTH, startWidth.current + delta)
      setWidth(newWidth)
    }
    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false
        setWidth((current) => {
          localStorage.setItem(DESC_PANEL_WIDTH_KEY, String(current))
          return current
        })
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const STEM_DOT_COLORS: Record<string, string> = {
    kick: 'bg-red-400', snare: 'bg-blue-400', hh: 'bg-gray-400',
    crash: 'bg-yellow-400', ride: 'bg-green-400', bass: 'bg-orange-400', vocals: 'bg-purple-400',
  }

  return (
    <div className="relative flex shrink-0" style={{ width }}>
      {/* Drag handle */}
      <div
        className="w-1 cursor-col-resize hover:bg-teal-500/50 active:bg-teal-500 transition-colors shrink-0"
        onMouseDown={handleMouseDown}
      />

      <div className="flex-1 bg-gray-900 border-l border-gray-800 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
          <div className="text-sm font-medium text-teal-300 truncate">{section.label}</div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">&times;</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-800 shrink-0">
          <button
            onClick={() => setTab('description')}
            className={`flex-1 text-xs py-2 transition-colors ${tab === 'description' ? 'text-gray-200 border-b-2 border-teal-500' : 'text-gray-500 hover:text-gray-300'}`}
          >
            Description
          </button>
          <button
            onClick={() => setTab('suggest')}
            className={`flex-1 text-xs py-2 transition-colors ${tab === 'suggest' ? 'text-gray-200 border-b-2 border-teal-500' : 'text-gray-500 hover:text-gray-300'}`}
          >
            Suggest
          </button>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'description' ? (
            <div className="p-3 space-y-3">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">
                {formatTime(section.startTime)} &ndash; {formatTime(section.endTime)}
              </div>

              {/* Events (at top) */}
              {audioEvents.length > 0 && (
                <div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
                    Events ({audioEvents.length})
                  </div>
                  <div className="space-y-1 max-h-[300px] overflow-y-auto">
                    {audioEvents.slice(0, 100).map((ev, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs text-gray-400">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${STEM_DOT_COLORS[ev.stem_source] || 'bg-gray-500'}`} />
                        <span className="font-mono text-gray-500 w-12 shrink-0">{ev.time.toFixed(2)}s</span>
                        <span className="text-gray-300">{ev.stem_source}/{ev.effect}</span>
                        <span className="ml-auto text-gray-500">{(ev.intensity * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                    {audioEvents.length > 100 && (
                      <div className="text-xs text-gray-600 italic">...and {audioEvents.length - 100} more</div>
                    )}
                  </div>
                </div>
              )}

              {/* Section description (markdown) */}
              <div className="prose prose-sm prose-invert max-w-none text-gray-300 leading-relaxed [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_p]:text-sm [&_li]:text-sm [&_code]:text-xs [&_code]:bg-gray-800 [&_code]:px-1 [&_code]:rounded">
                <ReactMarkdown>{section.content}</ReactMarkdown>
              </div>
            </div>
          ) : (
            <KeyframeSuggestPanel
              section={section}
              audioEvents={audioEvents}
              projectName={projectName}
              onKeyframeInserted={onKeyframeInserted}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

const TimeDisplay = memo(function TimeDisplay({ currentTime, duration, onSeek }: { currentTime: number; duration: number; onSeek: (time: number) => void }) {
  const [editing, setEditing] = useState(false)
  const [inputValue, setInputValue] = useState('')

  const parseTime = (str: string): number | null => {
    const trimmed = str.trim()
    // Support M:SS.f or just seconds
    const colonMatch = trimmed.match(/^(\d+):(\d+\.?\d*)$/)
    if (colonMatch) return parseInt(colonMatch[1], 10) * 60 + parseFloat(colonMatch[2])
    const num = parseFloat(trimmed)
    return isNaN(num) ? null : num
  }

  const handleSubmit = () => {
    const time = parseTime(inputValue)
    if (time !== null && time >= 0 && time <= duration) {
      onSeek(time)
    }
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit()
          if (e.key === 'Escape') setEditing(false)
        }}
        onBlur={handleSubmit}
        autoFocus
        className="text-sm font-mono text-gray-300 bg-gray-800 border border-blue-500 rounded px-1.5 py-0.5 w-24 focus:outline-none"
        placeholder="M:SS.f"
      />
    )
  }

  return (
    <div
      className="text-sm font-mono text-gray-400 cursor-pointer hover:text-gray-200 transition-colors"
      onDoubleClick={() => { setInputValue(formatTime(currentTime)); setEditing(true) }}
      title="Double-click to enter a specific time"
    >
      {formatTime(currentTime)} / {formatTime(duration)}
    </div>
  )
})
