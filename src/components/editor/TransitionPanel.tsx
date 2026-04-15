import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { Transition } from '@/routes/project/$name/editor'
import { updateTransitionAction, updateMeta, generateTransitionAction, enhanceTransitionAction, generateTransitionCandidates, selectTransitions } from '@/routes/project/$name/editor'
import { beatlabFileUrl, fetchPool, postAssignPoolVideo, fetchBin, postUpdateTransitionRemap, type PoolEntry, type TransitionBinEntry } from '@/lib/beatlab-client'
import { autoSave } from '@/lib/version-client'
import { invalidateEntry } from '@/lib/frame-cache'
import { evaluateCurve, getEasing, EASING_LABELS, EASING_COUNT, type CurvePoint } from '@/lib/remap-curve'
import { useJobState, useJobContext } from '@/contexts/JobStateContext'

const STORAGE_KEY = 'beatlab-side-panel-width'
const DEFAULT_WIDTH = 360
const MIN_WIDTH = 240

// Module-level style clipboard — persists across panel opens
let _styleClipboardTrId: string | null = null

// Persist tab + scroll across panel switches
let _lastTrTab: 'details' | 'candidates' | 'browse' | 'bench' = 'details'
let _lastTrScroll: number = 0

type AudioDescription = { sectionIndex: number; label: string; startTime: number; endTime: number; content: string }
type KfWithTime = { id: string; timestamp: string; timeSeconds: number }

type TransitionPanelProps = {
  transition: Transition
  projectName: string
  motionPrompt: string
  audioDescriptions: AudioDescription[]
  keyframes: KfWithTime[]
  currentTime: number
  onClose: () => void
  onDelete: () => void
  onDuplicateToNext: () => void
  onDuplicateToPrev: () => void
  onDataChange: () => void
  onHoverPreview?: (url: string | null) => void
  initialPromptRoster?: import('@/lib/beatlab-client').PromptRosterEntry[]
}

export function TransitionPanel({
  transition,
  projectName,
  motionPrompt,
  audioDescriptions,
  keyframes,
  currentTime,
  onClose,
  onDelete,
  onDuplicateToNext,
  onDuplicateToPrev,
  onDataChange,
  onHoverPreview,
  initialPromptRoster,
}: TransitionPanelProps) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? Math.max(MIN_WIDTH, parseInt(stored, 10)) : DEFAULT_WIDTH
  })
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

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
      const newWidth = Math.max(MIN_WIDTH, startWidth.current + delta)
      setWidth(newWidth)
    }
    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false
        setWidth((current) => {
          localStorage.setItem(STORAGE_KEY, String(current))
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

  const [tab, setTabRaw] = useState<'details' | 'candidates' | 'browse' | 'bench'>(_lastTrTab)
  const setTab = useCallback((t: 'details' | 'candidates' | 'browse' | 'bench') => { _lastTrTab = t; setTabRaw(t) }, [])
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollContainerRef.current && _lastTrScroll > 0) {
      scrollContainerRef.current.scrollTop = _lastTrScroll
    }
  }, [])

  useEffect(() => {
    const el = scrollContainerRef.current
    return () => { if (el) _lastTrScroll = el.scrollTop }
  }, [])

  const tr = transition
  const totalCandidates = Object.values(tr.candidates).reduce((sum, arr) => sum + arr.length, 0)

  // Resolve the section description for this transition
  const sectionDescription = (() => {
    const fromKf = keyframes.find((k) => k.id === tr.from)
    const toKf = keyframes.find((k) => k.id === tr.to)
    if (!fromKf || !toKf || audioDescriptions.length === 0) return null
    const midTime = (fromKf.timeSeconds + toKf.timeSeconds) / 2
    return audioDescriptions.find((s) => midTime >= s.startTime && midTime <= s.endTime) ?? null
  })()

  return (
    <div className="relative flex shrink-0" style={{ width }}>
      {/* Drag handle */}
      <div
        className="w-1 cursor-col-resize hover:bg-orange-500/50 active:bg-orange-500 transition-colors shrink-0"
        onMouseDown={handleMouseDown}
      />

      <div ref={scrollContainerRef} className="flex-1 bg-gray-900 border-l border-gray-800 overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 sticky top-0 bg-gray-900 z-10 shrink-0">
          <div className="text-sm font-medium text-orange-300">{tr.id}</div>
          <div className="flex items-center gap-4">
            <button
              onClick={async () => {
                try {
                  const { postAddToBench } = await import('@/lib/beatlab-client')
                  await postAddToBench(projectName, 'transition', tr.id)
                } catch (e) { console.error('Bench failed:', e) }
              }}
              className="text-xs text-green-500/70 hover:text-green-400 transition-colors"
              title="Add to bench for quick access"
            >
              Bench
            </button>
            <button
              onClick={onDuplicateToPrev}
              className="text-xs text-blue-500/70 hover:text-blue-400 transition-colors"
              title="Copy this video to previous transition (overwrites)"
            >&larr; Copy</button>
            <button
              onClick={onDuplicateToNext}
              className="text-xs text-blue-500/70 hover:text-blue-400 transition-colors"
              title="Copy this video to next transition (overwrites)"
            >Copy &rarr;</button>
            <button
              onClick={async () => {
                const next = !tr.hidden
                tr.hidden = next
                const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client')
                await postUpdateTransitionStyle(projectName, tr.id, { hidden: next } as never)
                onDataChange()
              }}
              className={`text-xs transition-colors ${tr.hidden ? 'text-yellow-400 hover:text-yellow-300' : 'text-yellow-500/70 hover:text-yellow-400'}`}
              title={tr.hidden ? 'Show transition' : 'Hide transition (mute)'}
            >
              {tr.hidden ? 'Show' : 'Hide'}
            </button>
            <button
              onClick={onDelete}
              className="text-xs text-red-500/70 hover:text-red-400 transition-colors"
              title="Delete transition (move to bin)"
            >
              Del
            </button>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Tabs */}
        <TabBar tab={tab} setTab={setTab} candidateCount={totalCandidates} />

        <div className="flex-1 overflow-y-auto">
          {tab === 'details' ? (
            <>
              {/* Hidden toggle */}
              {tr.hidden && (
                <div className="px-3 py-2 bg-yellow-900/20 border-b border-yellow-800/30 text-center">
                  <span className="text-[10px] text-yellow-400">This transition is hidden (muted)</span>
                </div>
              )}

              {/* Metadata */}
              <div className="px-3 py-3 space-y-3 border-b border-gray-800">
                <Field label="From → To" value={`${tr.from} → ${tr.to}`} />
                <Field label="Duration" value={`${tr.durationSeconds.toFixed(1)}s`} />
                <Field label="Remap" value={`${tr.remap.method} (${tr.remap.target_duration.toFixed(1)}s)`} />

                {/* Copy / Paste Style */}
                <div className="flex gap-1">
                  <button
                    onClick={() => { _styleClipboardTrId = tr.id }}
                    className="flex-1 text-[10px] py-1.5 rounded bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
                  >Copy Style</button>
                  <button
                    onClick={async () => {
                      if (!_styleClipboardTrId || _styleClipboardTrId === tr.id) return
                      const { postCopyTransitionStyle } = await import('@/lib/beatlab-client')
                      await postCopyTransitionStyle(projectName, _styleClipboardTrId, tr.id)
                      onDataChange()
                    }}
                    disabled={!_styleClipboardTrId || _styleClipboardTrId === tr.id}
                    className="flex-1 text-[10px] py-1.5 rounded bg-gray-800 text-gray-400 hover:text-gray-200 disabled:text-gray-600 disabled:hover:text-gray-600 transition-colors"
                  >Paste Style</button>
                </div>

                {/* Adjustment layer toggle */}
                <button
                  onClick={async () => {
                    const next = !tr.isAdjustment
                    tr.isAdjustment = next
                    const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client')
                    await postUpdateTransitionStyle(projectName, tr.id, { isAdjustment: next } as never)
                    onDataChange()
                  }}
                  className={`w-full text-[10px] py-1.5 rounded transition-colors ${tr.isAdjustment ? 'bg-purple-900/50 text-purple-300 ring-1 ring-purple-500/50' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
                >
                  {tr.isAdjustment ? 'Adjustment Layer ✓' : 'Toggle Adjustment Layer'}
                </button>

                {/* Transform Curves (X/Y/Z) */}
                <TransformCurveEditor transition={tr} projectName={projectName} keyframes={keyframes} currentTime={currentTime} onDataChange={onDataChange} />

                {/* Radial Mask */}
                {(() => {
                  const hasMask = tr.maskRadius != null && tr.maskRadius < 1
                  return (
                    <div className="space-y-1">
                      <button
                        onClick={async () => {
                          if (hasMask) {
                            tr.maskRadius = null; tr.maskCenterX = null; tr.maskCenterY = null; tr.maskFeather = null
                            const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client')
                            await postUpdateTransitionStyle(projectName, tr.id, { maskRadius: null, maskCenterX: null, maskCenterY: null, maskFeather: null })
                            onDataChange()
                          } else {
                            tr.maskRadius = 0.5; tr.maskCenterX = 0.5; tr.maskCenterY = 0.5; tr.maskFeather = 0.3
                            const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client')
                            await postUpdateTransitionStyle(projectName, tr.id, { maskRadius: 0.5, maskCenterX: 0.5, maskCenterY: 0.5, maskFeather: 0.3 })
                            onDataChange()
                          }
                        }}
                        className={`w-full text-[10px] py-1 rounded transition-colors ${hasMask ? 'bg-cyan-900/40 text-cyan-300' : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}
                      >{hasMask ? 'Radial Mask ✓' : 'Radial Mask'}</button>
                      {hasMask && (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] text-gray-500 w-12">Center X</span>
                            <input type="range" min={0} max={1} step={0.01} value={tr.maskCenterX ?? 0.5}
                              onChange={async (e) => { const v = parseFloat(e.target.value); tr.maskCenterX = v; const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client'); await postUpdateTransitionStyle(projectName, tr.id, { maskCenterX: v }); onDataChange() }}
                              className="flex-1 h-1.5 accent-cyan-500" />
                            <span className="text-[9px] text-gray-400 w-8 text-right">{((tr.maskCenterX ?? 0.5) * 100).toFixed(0)}%</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] text-gray-500 w-12">Center Y</span>
                            <input type="range" min={0} max={1} step={0.01} value={tr.maskCenterY ?? 0.5}
                              onChange={async (e) => { const v = parseFloat(e.target.value); tr.maskCenterY = v; const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client'); await postUpdateTransitionStyle(projectName, tr.id, { maskCenterY: v }); onDataChange() }}
                              className="flex-1 h-1.5 accent-cyan-500" />
                            <span className="text-[9px] text-gray-400 w-8 text-right">{((tr.maskCenterY ?? 0.5) * 100).toFixed(0)}%</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] text-gray-500 w-12">Radius</span>
                            <input type="range" min={0.01} max={1} step={0.01} value={tr.maskRadius ?? 0.5}
                              onChange={async (e) => { const v = parseFloat(e.target.value); tr.maskRadius = v; const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client'); await postUpdateTransitionStyle(projectName, tr.id, { maskRadius: v }); onDataChange() }}
                              className="flex-1 h-1.5 accent-cyan-500" />
                            <span className="text-[9px] text-gray-400 w-8 text-right">{((tr.maskRadius ?? 0.5) * 100).toFixed(0)}%</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] text-gray-500 w-12">Feather</span>
                            <input type="range" min={0} max={1} step={0.01} value={tr.maskFeather ?? 0.3}
                              onChange={async (e) => { const v = parseFloat(e.target.value); tr.maskFeather = v; const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client'); await postUpdateTransitionStyle(projectName, tr.id, { maskFeather: v }); onDataChange() }}
                              className="flex-1 h-1.5 accent-cyan-500" />
                            <span className="text-[9px] text-gray-400 w-8 text-right">{((tr.maskFeather ?? 0.3) * 100).toFixed(0)}%</span>
                          </div>
                        </>
                      )}
                    </div>
                  )
                })()}

                {/* Blend Mode */}
                <div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Blend Mode</div>
                  <select
                    value={tr.blendMode || ''}
                    onChange={async (e) => {
                      const val = e.target.value
                      tr.blendMode = val
                      const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client')
                      await postUpdateTransitionStyle(projectName, tr.id, { blendMode: val })
                      onDataChange()
                    }}
                    className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700"
                  >
                    <option value="">Track default</option>
                    <option value="normal">normal</option>
                    <option value="multiply">multiply</option>
                    <option value="screen">screen</option>
                    <option value="overlay">overlay</option>
                    <option value="difference">difference</option>
                    <option value="add">add</option>
                    <option value="soft-light">soft-light</option>
                    <option value="chroma-key">chroma-key</option>
                  </select>
                </div>

                {/* Chroma Key settings — visible when blend mode is chroma-key */}
                {tr.blendMode === 'chroma-key' && (
                  <ChromaKeyEditor transition={tr} projectName={projectName} onDataChange={onDataChange} />
                )}
              </div>

              {/* Time remap curve editor */}
              <div className="px-3 py-3 border-b border-gray-800">
                <AnimCurveEditor
                  label="Keyframe Pins" defaultY={0} color="#f97316" yLabel="Video Frame →"
                  transition={tr} projectName={projectName} keyframes={keyframes} currentTime={currentTime}
                  initialPoints={(tr.remap.curve_points as CurvePoint[] | undefined) || [[0, 0], [1, 1]]}
                  lockY diagonalRef aspect={1.6}
                  onSave={async (sorted) => {
                    const method = sorted.length > 2 ? 'curve' : 'linear'
                    await postUpdateTransitionRemap(projectName, tr.id, tr.remap.target_duration, method, method === 'curve' ? sorted : undefined)
                    tr.remap.method = method
                    tr.remap.curve_points = method === 'curve' ? sorted : undefined
                  }}
                />
              </div>

              {/* Opacity curve editor */}
              <div className="px-3 py-3 border-b border-gray-800">
                <OpacityCurveEditor transition={tr} projectName={projectName} keyframes={keyframes} currentTime={currentTime} onDataChange={onDataChange} />
              </div>

              {/* RGBK curve editors */}
              <div className="px-3 py-3 border-b border-gray-800 space-y-3">
                <AnimCurveEditor
                  label="Red" defaultY={1} color="#ef4444" yLabel="Red →"
                  transition={tr} projectName={projectName} keyframes={keyframes} currentTime={currentTime}
                  curveKey="redCurve" styleKey="redCurve" onDataChange={onDataChange} maxY={2}
                />
                <AnimCurveEditor
                  label="Green" defaultY={1} color="#22c55e" yLabel="Green →"
                  transition={tr} projectName={projectName} keyframes={keyframes} currentTime={currentTime}
                  curveKey="greenCurve" styleKey="greenCurve" onDataChange={onDataChange} maxY={2}
                />
                <AnimCurveEditor
                  label="Blue" defaultY={1} color="#3b82f6" yLabel="Blue →"
                  transition={tr} projectName={projectName} keyframes={keyframes} currentTime={currentTime}
                  curveKey="blueCurve" styleKey="blueCurve" onDataChange={onDataChange} maxY={2}
                />
                <AnimCurveEditor
                  label="Black" defaultY={0} color="#9ca3af" yLabel="Black →"
                  transition={tr} projectName={projectName} keyframes={keyframes} currentTime={currentTime}
                  curveKey="blackCurve" styleKey="blackCurve" onDataChange={onDataChange}
                />
              </div>

              {/* Hue Shift curve editor */}
              <div className="px-3 py-3 border-b border-gray-800">
                <AnimCurveEditor
                  label="Hue Shift"
                  defaultY={0}
                  color="#a855f7"
                  yLabel="Shift →"
                  transition={tr}
                  projectName={projectName}
                  keyframes={keyframes}
                  currentTime={currentTime}
                  curveKey="hueShiftCurve"
                  styleKey="hueShiftCurve"
                  onDataChange={onDataChange}
                />
                <AnimCurveEditor
                  label="Saturation"
                  defaultY={1}
                  color="#f59e0b"
                  yLabel="Sat →"
                  transition={tr}
                  projectName={projectName}
                  keyframes={keyframes}
                  currentTime={currentTime}
                  curveKey="saturationCurve"
                  styleKey="saturationCurve"
                  onDataChange={onDataChange}
                  maxY={2}
                />
                <AnimCurveEditor
                  label="Brightness" defaultY={0} color="#e0e0e0" yLabel="Brightness"
                  transition={tr}
                  projectName={projectName}
                  keyframes={keyframes}
                  currentTime={currentTime}
                  curveKey="brightnessCurve"
                  styleKey="brightnessCurve"
                  onDataChange={onDataChange}
                />
                <AnimCurveEditor
                  label="Contrast" defaultY={1} color="#a0a0ff" yLabel="Contrast"
                  transition={tr}
                  projectName={projectName}
                  keyframes={keyframes}
                  currentTime={currentTime}
                  curveKey="contrastCurve"
                  styleKey="contrastCurve"
                  onDataChange={onDataChange}
                  maxY={3}
                />
                <AnimCurveEditor
                  label="Exposure" defaultY={0} color="#ffcc44" yLabel="Stops"
                  transition={tr}
                  projectName={projectName}
                  keyframes={keyframes}
                  currentTime={currentTime}
                  curveKey="exposureCurve"
                  styleKey="exposureCurve"
                  onDataChange={onDataChange}
                />
              </div>

              {/* Motion prompt (global) */}
              <div className="px-3 py-3">
                <MotionPromptEditor projectName={projectName} motionPrompt={motionPrompt} />
              </div>

              {/* Section description */}
              <SectionDescription transition={tr} audioDescriptions={audioDescriptions} keyframes={keyframes} />
            </>
          ) : tab === 'candidates' ? (
            <CandidatesTab transition={tr} projectName={projectName} onHoverPreview={onHoverPreview} sectionDescription={sectionDescription} initialPromptRoster={initialPromptRoster} />
          ) : tab === 'browse' ? (
            <BrowseTab transition={tr} projectName={projectName} onAssigned={() => {
              transition.hasSelectedVideo = true
              setTab('candidates')
              onDataChange()
            }} />
          ) : (
            <BenchTab transition={tr} projectName={projectName} onAssigned={() => {
              transition.hasSelectedVideo = true
              setTab('candidates')
              onDataChange()
            }} onSeek={onDataChange} />
          )}
        </div>
      </div>
    </div>
  )
}

function ActionPromptEditor({ transition, projectName, sectionDescription, initialPromptRoster }: { transition: Transition; projectName: string; sectionDescription: AudioDescription | null; initialPromptRoster?: import('@/lib/beatlab-client').PromptRosterEntry[] }) {
  const jobCtx = useJobContext()
  const entityKey = `tr:${transition.id}:action`
  const job = useJobState(entityKey)

  const [action, setAction] = useState(transition.action)
  const [useGlobal, setUseGlobal] = useState(transition.useGlobalPrompt)
  const [useSectionDesc, setUseSectionDesc] = useState(transition.includeSectionDesc ?? !!sectionDescription)
  const [saving, setSaving] = useState(false)
  const [promptRoster, setPromptRoster] = useState<import('@/lib/beatlab-client').PromptRosterEntry[]>(initialPromptRoster || [])

  useEffect(() => {
    setAction(transition.action)
    setUseGlobal(transition.useGlobalPrompt)
  }, [transition.id, transition.action, transition.useGlobalPrompt])

  // Apply completed job result (persists across panel switches)
  useEffect(() => {
    if (job?.status === 'completed' && job.result) {
      const res = job.result as { action?: string }
      if (res?.action) {
        setAction(res.action)
        transition.action = res.action
        // Auto-save the generated action
        updateTransitionAction({
          data: { projectName, transitionId: transition.id, action: res.action, useGlobalPrompt: useGlobal },
        })
      }
      jobCtx.consumeResult(entityKey)
    }
  }, [job?.status, job?.result])

  const [generating, setGenerating] = useState(false)

  const save = useCallback(async () => {
    setSaving(true)
    await updateTransitionAction({
      data: { projectName, transitionId: transition.id, action, useGlobalPrompt: useGlobal, includeSectionDesc: useSectionDesc },
    })
    transition.action = action
    transition.useGlobalPrompt = useGlobal
    transition.includeSectionDesc = useSectionDesc
    setSaving(false)
  }, [action, useGlobal, useSectionDesc, transition, projectName])

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    try {
      const result = await generateTransitionAction({
        data: { projectName, transitionId: transition.id, sectionContext: useSectionDesc && sectionDescription ? sectionDescription.content : undefined },
      })
      if (result.action) {
        setAction(result.action)
        transition.action = result.action
        updateTransitionAction({
          data: { projectName, transitionId: transition.id, action: result.action, useGlobalPrompt: useGlobal },
        })
      }
    } catch (e) {
      console.error('Generate action failed:', e)
    } finally {
      setGenerating(false)
    }
  }, [projectName, transition, useGlobal, useSectionDesc, sectionDescription])

  const handleEnhance = useCallback(async () => {
    if (!action) return
    setGenerating(true)
    try {
      const result = await enhanceTransitionAction({
        data: { projectName, transitionId: transition.id, action, sectionContext: useSectionDesc && sectionDescription ? sectionDescription.content : undefined },
      })
      if (result.action) {
        setAction(result.action)
        transition.action = result.action
        updateTransitionAction({
          data: { projectName, transitionId: transition.id, action: result.action, useGlobalPrompt: useGlobal },
        })
      }
    } catch (e) {
      console.error('Enhance action failed:', e)
    } finally {
      setGenerating(false)
    }
  }, [projectName, transition, action, useGlobal, useSectionDesc, sectionDescription])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Action Prompt</div>
        <div className="flex items-center gap-2">
          {action && (
            <button
              onClick={handleEnhance}
              disabled={generating || saving}
              className="text-[10px] text-blue-400 hover:text-blue-300 disabled:text-gray-600 transition-colors"
            >
              {generating ? '...' : 'Enhance'}
            </button>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating || saving}
            className="text-[10px] text-orange-400 hover:text-orange-300 disabled:text-gray-600 transition-colors"
          >
            {generating ? 'Generating...' : action ? 'Regenerate' : 'Generate'}
          </button>
        </div>
      </div>

      {/* Prompt roster selector */}
      <div className="flex items-center gap-1">
        <select
          className="flex-1 bg-gray-800 text-[10px] text-gray-400 border border-gray-700 rounded px-1.5 py-0.5 focus:outline-none focus:border-orange-500"
          value=""
          onChange={(e) => {
            const entry = promptRoster.find((p) => p.id === e.target.value)
            if (entry) setAction(entry.template)
          }}
        >
          <option value="">Insert from roster...</option>
          {Object.entries(
            promptRoster.reduce<Record<string, typeof promptRoster>>((acc, p) => {
              (acc[p.category] = acc[p.category] || []).push(p)
              return acc
            }, {})
          ).map(([cat, entries]) => (
            <optgroup key={cat} label={cat}>
              {entries.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
          ))}
        </select>
        <button
          onClick={async () => {
            if (!action.trim()) { alert('Write a prompt first, then save it to the roster.'); return }
            const name = prompt('Name for this prompt template:')
            if (!name) return
            const category = prompt('Category (e.g., general, camera, style):', 'general') || 'general'
            const { postAddPromptRoster, fetchPromptRoster } = await import('@/lib/beatlab-client')
            await postAddPromptRoster(projectName, name, action, category)
            setPromptRoster(await fetchPromptRoster(projectName))
          }}
          className="text-[9px] text-orange-400 hover:text-orange-300 whitespace-nowrap"
          title="Save current prompt to roster"
        >
          + Save
        </button>
      </div>

      <textarea
        ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
        value={action}
        onChange={(e) => { setAction(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px' }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save() }
          if (e.key === 'Escape') { setAction(transition.action) }
        }}
        onBlur={save}
        className="w-full bg-gray-800 text-sm text-gray-300 rounded p-2 border border-gray-700 focus:border-orange-500 focus:outline-none resize-none leading-relaxed overflow-hidden"
        disabled={saving || generating}
        placeholder={generating ? 'Analyzing keyframe images with Claude...' : 'Enter a transition action prompt...'}
      />
      <div className="flex items-center justify-between text-[9px] text-gray-600">
        <span>{action ? 'Ctrl+Enter to save, Esc to revert. ' : ''}Sent to Veo for video generation.</span>
        {action && (
          <button
            onClick={async () => {
              const name = window.prompt('Save prompt as:', action.slice(0, 40))
              if (!name) return
              const category = window.prompt('Category:', 'general') || 'general'
              const { postAddPromptRoster, fetchPromptRoster } = await import('@/lib/beatlab-client')
              await postAddPromptRoster(projectName, name, action, category)
              setPromptRoster(await fetchPromptRoster(projectName))
            }}
            className="text-orange-400 hover:text-orange-300"
          >
            Save to roster
          </button>
        )}
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={useGlobal}
          onChange={(e) => {
            setUseGlobal(e.target.checked)
            setSaving(true)
            updateTransitionAction({
              data: { projectName, transitionId: transition.id, action, useGlobalPrompt: e.target.checked },
            }).then(() => {
              transition.useGlobalPrompt = e.target.checked
              setSaving(false)
            })
          }}
          className="rounded border-gray-600 bg-gray-800 text-orange-500 focus:ring-orange-500"
        />
        <span className="text-xs text-gray-400">Append global motion prompt</span>
      </label>

      {sectionDescription && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={useSectionDesc}
            onChange={(e) => {
              setUseSectionDesc(e.target.checked)
              updateTransitionAction({
                data: { projectName, transitionId: transition.id, action, useGlobalPrompt: useGlobal, includeSectionDesc: e.target.checked },
              })
              transition.includeSectionDesc = e.target.checked
            }}
            className="rounded border-gray-600 bg-gray-800 text-orange-500 focus:ring-orange-500"
          />
          <span className="text-xs text-gray-400">Include section description in generation</span>
        </label>
      )}

      {/* Per-transition effects */}
      <TransitionEffectsEditor transition={transition} projectName={projectName} />
    </div>
  )
}

function TransitionEffectsEditor({ transition, projectName }: { transition: Transition; projectName: string }) {
  const [effects, setEffects] = useState(transition.effects || [])

  useEffect(() => { setEffects(transition.effects || []) }, [transition.id, transition.effects])

  const handleAdd = useCallback(async (type: string) => {
    const { postAddTransitionEffect } = await import('@/lib/beatlab-client')
    const defaults: Record<string, Record<string, number>> = {
      strobe: { flashMs: 60, blackMs: 60 },
      invert: { amount: 1 },
      'chroma-key': { r: 0, g: 1, b: 0, threshold: 0.3, feather: 0.1 },
    }
    const result = await postAddTransitionEffect(projectName, transition.id, type, defaults[type] || {})
    setEffects((prev) => [...prev, { id: result.id, type, params: defaults[type] || {}, enabled: true }])
  }, [projectName, transition.id])

  const handleUpdate = useCallback((id: string, updates: { params?: Record<string, number>; enabled?: boolean }) => {
    setEffects((prev) => prev.map((e) => e.id === id ? { ...e, ...updates } : e))
  }, [])
  const handleUpdatePersist = useCallback(async (id: string, updates: { params?: Record<string, number>; enabled?: boolean }) => {
    const { postUpdateTransitionEffect } = await import('@/lib/beatlab-client')
    await postUpdateTransitionEffect(projectName, id, updates)
  }, [projectName])

  const handleDelete = useCallback(async (id: string) => {
    const { postDeleteTransitionEffect } = await import('@/lib/beatlab-client')
    await postDeleteTransitionEffect(projectName, id)
    setEffects((prev) => prev.filter((e) => e.id !== id))
  }, [projectName])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Effects</div>
        <select
          onChange={(e) => { if (e.target.value) { handleAdd(e.target.value); e.target.value = '' } }}
          className="text-[10px] bg-gray-800 text-gray-400 rounded px-1 py-0.5 border-none focus:outline-none cursor-pointer"
          defaultValue=""
        >
          <option value="" disabled>+ Add</option>
          <option value="strobe">Strobe</option>
          <option value="invert">Invert</option>
          <option value="chroma-key">Chroma Key</option>
        </select>
      </div>
      {effects.map((fx) => (
        <div key={fx.id} className="bg-gray-800/50 rounded p-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={fx.enabled}
                onChange={(e) => { const v = e.target.checked; handleUpdate(fx.id, { enabled: v }); handleUpdatePersist(fx.id, { enabled: v }) }}
                className="rounded border-gray-600 bg-gray-800 text-teal-500 w-3 h-3"
              />
              <span className="text-[10px] text-gray-300 uppercase">{fx.type}</span>
            </div>
            <button onClick={() => handleDelete(fx.id)} className="text-[9px] text-red-400/60 hover:text-red-400">&times;</button>
          </div>
          {fx.type === 'strobe' && (() => {
            // Derive flashMs/blackMs from legacy period/duty or new params
            const flashMs = fx.params.flashMs ?? ((fx.params.period || 0.125) * (fx.params.duty || 0.5) * 1000)
            const blackMs = fx.params.blackMs ?? ((fx.params.period || 0.125) * (1 - (fx.params.duty || 0.5)) * 1000)
            return (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-gray-500 w-12">Flash</span>
                  <input
                    type="range" min={10} max={500} step={5}
                    value={flashMs}
                    onChange={(e) => {
                      const newFlash = parseFloat(e.target.value)
                      const totalSec = (newFlash + blackMs) / 1000
                      const duty = newFlash / (newFlash + blackMs)
                      handleUpdate(fx.id, { params: { ...fx.params, flashMs: newFlash, blackMs, period: totalSec, duty } })
                    }}
                    onPointerUp={() => handleUpdatePersist(fx.id, { params: fx.params })}
                    className="flex-1 h-1.5 accent-teal-500"
                  />
                  <span className="text-[9px] text-gray-400 w-12 text-right">{Math.round(flashMs)}ms</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-gray-500 w-12">Black</span>
                  <input
                    type="range" min={10} max={500} step={5}
                    value={blackMs}
                    onChange={(e) => {
                      const newBlack = parseFloat(e.target.value)
                      const totalSec = (flashMs + newBlack) / 1000
                      const duty = flashMs / (flashMs + newBlack)
                      handleUpdate(fx.id, { params: { ...fx.params, flashMs, blackMs: newBlack, period: totalSec, duty } })
                    }}
                    onPointerUp={() => handleUpdatePersist(fx.id, { params: fx.params })}
                    className="flex-1 h-1.5 accent-teal-500"
                  />
                  <span className="text-[9px] text-gray-400 w-12 text-right">{Math.round(blackMs)}ms</span>
                </div>
              </div>
            )
          })()}
          {fx.type === 'invert' && (
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-gray-500 w-12">Amount</span>
              <input
                type="range" min={0} max={1} step={0.05}
                value={fx.params.amount ?? 1}
                onChange={(e) => handleUpdate(fx.id, { params: { ...fx.params, amount: parseFloat(e.target.value) } })}
                onPointerUp={() => handleUpdatePersist(fx.id, { params: fx.params })}
                className="flex-1 h-1.5 accent-pink-500"
              />
              <span className="text-[9px] text-gray-400 w-12 text-right">{Math.round((fx.params.amount ?? 1) * 100)}%</span>
            </div>
          )}
          {fx.type === 'chroma-key' && (() => {
            const r = fx.params.r ?? 0, g = fx.params.g ?? 1, b = fx.params.b ?? 0
            const hexColor = `#${[r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`
            return (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-gray-500 w-12">Color</span>
                  <input
                    type="color"
                    value={hexColor}
                    onChange={(e) => {
                      const hex = e.target.value
                      const nr = parseInt(hex.slice(1, 3), 16) / 255
                      const ng = parseInt(hex.slice(3, 5), 16) / 255
                      const nb = parseInt(hex.slice(5, 7), 16) / 255
                      handleUpdate(fx.id, { params: { ...fx.params, r: nr, g: ng, b: nb } })
                    }}
                    onBlur={() => handleUpdatePersist(fx.id, { params: fx.params })}
                    className="w-8 h-6 rounded border border-gray-700 cursor-pointer"
                  />
                  <span className="text-[8px] text-gray-500 font-mono">{hexColor}</span>
                  <div className="flex gap-0.5">
                    <button onClick={() => { handleUpdate(fx.id, { params: { ...fx.params, r: 0, g: 1, b: 0 } }); handleUpdatePersist(fx.id, { params: { ...fx.params, r: 0, g: 1, b: 0 } }) }} className="text-[7px] px-1 py-0.5 rounded bg-green-900 text-green-300">G</button>
                    <button onClick={() => { handleUpdate(fx.id, { params: { ...fx.params, r: 0, g: 0, b: 1 } }); handleUpdatePersist(fx.id, { params: { ...fx.params, r: 0, g: 0, b: 1 } }) }} className="text-[7px] px-1 py-0.5 rounded bg-blue-900 text-blue-300">B</button>
                    <button onClick={() => { handleUpdate(fx.id, { params: { ...fx.params, r: 0, g: 0, b: 0 } }); handleUpdatePersist(fx.id, { params: { ...fx.params, r: 0, g: 0, b: 0 } }) }} className="text-[7px] px-1 py-0.5 rounded bg-gray-800 text-gray-300">K</button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-gray-500 w-12">Thresh</span>
                  <input type="range" min={0} max={100} step={1}
                    value={Math.round((fx.params.threshold ?? 0.3) * 100)}
                    onChange={(e) => handleUpdate(fx.id, { params: { ...fx.params, threshold: parseInt(e.target.value) / 100 } })}
                    onPointerUp={() => handleUpdatePersist(fx.id, { params: fx.params })}
                    className="flex-1 h-1.5 accent-teal-500"
                  />
                  <span className="text-[9px] text-gray-400 w-12 text-right">{Math.round((fx.params.threshold ?? 0.3) * 100)}%</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-gray-500 w-12">Feather</span>
                  <input type="range" min={0} max={50} step={1}
                    value={Math.round((fx.params.feather ?? 0.1) * 100)}
                    onChange={(e) => handleUpdate(fx.id, { params: { ...fx.params, feather: parseInt(e.target.value) / 100 } })}
                    onPointerUp={() => handleUpdatePersist(fx.id, { params: fx.params })}
                    className="flex-1 h-1.5 accent-teal-500"
                  />
                  <span className="text-[9px] text-gray-400 w-12 text-right">{Math.round((fx.params.feather ?? 0.1) * 100)}%</span>
                </div>
              </div>
            )
          })()}
        </div>
      ))}
    </div>
  )
}

function SectionDescription({ transition, audioDescriptions, keyframes }: { transition: Transition; audioDescriptions: AudioDescription[]; keyframes: KfWithTime[] }) {
  // Find the transition's midpoint time
  const fromKf = keyframes.find((k) => k.id === transition.from)
  const toKf = keyframes.find((k) => k.id === transition.to)
  if (!fromKf || !toKf || audioDescriptions.length === 0) return null

  const midTime = (fromKf.timeSeconds + toKf.timeSeconds) / 2
  const section = audioDescriptions.find((s) => midTime >= s.startTime && midTime <= s.endTime)
  if (!section) return null

  return (
    <div className="px-3 py-3 border-t border-gray-800">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{section.label}</div>
      <div className="text-[11px] text-gray-400 leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap">
        {section.content.replace(/\*\*/g, '').replace(/\*Time\*:.*\n?/, '').trim()}
      </div>
    </div>
  )
}

function MotionPromptEditor({ projectName, motionPrompt }: { projectName: string; motionPrompt: string }) {
  const [motion, setMotion] = useState(motionPrompt)
  const [saving, setSaving] = useState(false)

  const save = useCallback(async () => {
    setSaving(true)
    await updateMeta({ data: { projectName, fields: { motion_prompt: motion } } })
    setSaving(false)
  }, [motion, projectName])

  return (
    <div className="space-y-1">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">Global Motion Prompt</div>
      <textarea
        ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
        value={motion}
        onChange={(e) => { setMotion(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px' }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save() }
        }}
        placeholder="e.g. Slow camera drift, dreamy bokeh..."
        className="w-full bg-gray-800 text-xs text-gray-400 rounded p-2 border border-gray-700 focus:border-gray-500 focus:outline-none resize-none leading-relaxed overflow-hidden"
        disabled={saving}
      />
      <div className="text-[9px] text-gray-600">Appended as "Camera and motion: ..." to every transition with the checkbox enabled</div>
    </div>
  )
}

function TabBar({ tab, setTab, candidateCount }: { tab: string; setTab: (t: 'details' | 'candidates' | 'browse' | 'bench') => void; candidateCount: number }) {
  return (
    <div className="flex border-b border-gray-800 shrink-0">
      <button
        onClick={() => setTab('details')}
        className={`flex-1 text-xs py-2 transition-colors ${tab === 'details' ? 'text-gray-200 border-b-2 border-orange-500' : 'text-gray-500 hover:text-gray-400'}`}
      >
        Details
      </button>
      <button
        onClick={() => setTab('candidates')}
        className={`flex-1 text-xs py-2 transition-colors ${tab === 'candidates' ? 'text-gray-200 border-b-2 border-orange-500' : 'text-gray-500 hover:text-gray-400'}`}
      >
        Videos{candidateCount > 0 ? ` (${candidateCount})` : ''}
      </button>
      <button
        onClick={() => setTab('browse')}
        className={`flex-1 text-xs py-2 transition-colors ${tab === 'browse' ? 'text-gray-200 border-b-2 border-green-500' : 'text-gray-500 hover:text-gray-400'}`}
      >
        Browse
      </button>
      <button
        onClick={() => setTab('bench')}
        className={`flex-1 text-xs py-2 transition-colors ${tab === 'bench' ? 'text-gray-200 border-b-2 border-yellow-500' : 'text-gray-500 hover:text-gray-400'}`}
      >
        Bench
      </button>
    </div>
  )
}

function CandidatesTab({ transition, projectName, onHoverPreview, sectionDescription, initialPromptRoster }: { transition: Transition; projectName: string; onHoverPreview?: (url: string | null) => void; sectionDescription: AudioDescription | null; initialPromptRoster?: import('@/lib/beatlab-client').PromptRosterEntry[] }) {
  const jobCtx = useJobContext()
  const entityKey = `tr:${transition.id}:video`
  const job = useJobState(entityKey)

  const [selecting, setSelecting] = useState(false)
  const [candidates, setCandidates] = useState(() => {
    console.log(`[CandidatesTab] init ${transition.id}: ${transition.candidates.length} candidates`, transition.candidates)
    return transition.candidates
  })
  const [selectedVariant, setSelectedVariant] = useState<number | null>(
    typeof transition.selected === 'number' ? transition.selected : null
  )
  const [showModal, setShowModal] = useState(false)

  // Video generation duration — closest of [4, 6, 8] to transition duration
  const DURATION_OPTIONS = [4, 6, 8] as const
  const [generationDuration, setGenerationDuration] = useState<number>(() => {
    const dur = transition.durationSeconds
    return DURATION_OPTIONS.reduce((best, opt) => Math.abs(opt - dur) < Math.abs(best - dur) ? opt : best, 8)
  })
  const COUNT_OPTIONS = [1, 2, 3, 4] as const
  const [generationCount, setGenerationCount] = useState<number>(4)

  // Load defaults from project meta
  useEffect(() => {
    import('@/lib/beatlab-client').then(({ fetchMeta }) => {
      fetchMeta(projectName).then((meta) => {
        if (meta.default_video_duration) setGenerationDuration(meta.default_video_duration)
        if (meta.default_gen_count) setGenerationCount(meta.default_gen_count)
      }).catch(() => {})
    })
  }, [projectName])
  const [endFrameMode, setEndFrameMode] = useState<'keyframe' | 'next-tr' | 'none'>('keyframe')

  useEffect(() => {
    setCandidates(transition.candidates)
  }, [transition.id, transition.candidates])

  // Apply completed job result (works even if panel was unmounted during generation)
  useEffect(() => {
    if (job?.status === 'completed' && job.result) {
      console.log('[CandidatesTab] job completed, result:', job.result)
      const res = job.result as { candidates?: Record<string, string[]> }
      const newCandidates = res?.candidates?.['slot_0'] || Object.values(res?.candidates || {})[0] || []
      console.log('[CandidatesTab] extracted candidates:', newCandidates)
      if (newCandidates.length > 0) {
        setCandidates(newCandidates)
        transition.candidates = newCandidates
      }
      jobCtx.consumeResult(entityKey)
      autoSave(projectName, `Generated ${transition.id} video candidates`)
    }
  }, [job?.status, job?.result])

  const generating = job?.status === 'in_progress'
  const jobFailed = job?.status === 'failed'
  const jobStatus = job?.detail || ''

  const handleGenerate = useCallback(async () => {
    if (!transition.action) {
      alert('Enter an action prompt above before generating video candidates.')
      return
    }

    try {
      const result = await generateTransitionCandidates({
        data: { projectName, transitionId: transition.id, count: generationCount, duration: generationDuration, ...(endFrameMode === 'next-tr' && { useNextTransitionFrame: true }), ...(endFrameMode === 'none' && { noEndFrame: true }) },
      })
      console.log('[TransitionPanel] generate result:', result)

      if (result.jobId) {
        jobCtx.startJob(entityKey, result.jobId)
      } else {
        const newCandidates = result.candidates?.['slot_0'] || Object.values(result.candidates || {})[0] || []
        if (newCandidates.length > 0) {
          setCandidates(newCandidates)
          transition.candidates = newCandidates
        }
      }
    } catch (e) {
      console.error('Generate transition candidates failed:', e)
      alert(`Failed to generate: ${e}`)
    }
  }, [projectName, transition, jobCtx, entityKey, generationCount, generationDuration, endFrameMode])

  const handleSelect = useCallback(async (variantIndex: number) => {
    setSelecting(true)
    const selectionKey = `${transition.id}_slot_0`
    const isDeselect = selectedVariant === variantIndex
    try {
      await selectTransitions({
        data: { projectName, selections: { [selectionKey]: isDeselect ? null as unknown as number : variantIndex } },
      })
      const oldVariant = selectedVariant ?? 'none'
      invalidateEntry(`tr:${transition.id}:v${oldVariant}`)
      if (isDeselect) {
        setSelectedVariant(null)
        transition.selected = null
        transition.hasSelectedVideo = false
        autoSave(projectName, `Deselected ${transition.id}`)
      } else {
        invalidateEntry(`tr:${transition.id}:v${variantIndex}`)
        setSelectedVariant(variantIndex)
        transition.selected = variantIndex
        transition.hasSelectedVideo = true
        autoSave(projectName, `Selected ${transition.id} v${variantIndex}`)
      }
    } finally {
      setSelecting(false)
    }
  }, [projectName, transition.id, selectedVariant])

  return (
    <div className="p-2 space-y-3">
      {/* Action prompt */}
      <ActionPromptEditor transition={transition} projectName={projectName} sectionDescription={sectionDescription} initialPromptRoster={initialPromptRoster} />

      {/* Generation settings */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider shrink-0 w-14">Duration</span>
          <div className="flex gap-0.5 flex-1">
            {DURATION_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => { setGenerationDuration(d); updateMeta({ data: { projectName, fields: { default_video_duration: d } } }) }}
                className={`flex-1 text-[10px] py-1 rounded transition-colors ${generationDuration === d ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
              >
                {d}s
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider shrink-0 w-14">Count</span>
          <div className="flex gap-0.5 flex-1">
            {COUNT_OPTIONS.map((c) => (
              <button
                key={c}
                onClick={() => { setGenerationCount(c); updateMeta({ data: { projectName, fields: { default_gen_count: c } } }) }}
                className={`flex-1 text-[10px] py-1 rounded transition-colors ${generationCount === c ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* End frame mode */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider shrink-0 w-14">End</span>
        <div className="flex gap-0.5 flex-1">
          {([['keyframe', 'Keyframe'], ['next-tr', 'Next Tr'], ['none', 'None']] as const).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setEndFrameMode(mode)}
              className={`flex-1 text-[10px] py-1 rounded transition-colors ${endFrameMode === mode ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Generate button + refresh */}
      <div className="flex items-center justify-between">
        <button
          onClick={handleGenerate}
          disabled={generating}
          className={`flex-1 text-xs py-2 rounded transition-colors ${jobFailed ? 'bg-red-700 hover:bg-red-600 text-white' : 'bg-orange-600 hover:bg-orange-500 disabled:bg-gray-700 disabled:text-gray-500 text-white'}`}
        >
          {generating ? (jobStatus || 'Generating with Veo...') : jobFailed ? `Failed: ${jobStatus}` : candidates.length > 0 ? 'Generate More' : 'Generate Video'}
        </button>
        <button
          onClick={async () => {
            try {
              const { fetchDirectoryListing } = await import('@/lib/beatlab-client')
              const files = await fetchDirectoryListing(projectName, `transition_candidates/${transition.id}/slot_0`)
              const newCandidates = files
                .filter((f: { name: string; isDirectory: boolean }) => !f.isDirectory && f.name.endsWith('.mp4'))
                .map((f: { name: string }) => `transition_candidates/${transition.id}/slot_0/${f.name}`)
                .sort()
              console.log('[CandidatesTab] refresh got', newCandidates.length, 'candidates')
              setCandidates(newCandidates)
              transition.candidates = newCandidates
            } catch (e) { console.error('Refresh failed:', e) }
          }}
          className="ml-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors px-1"
          title="Refresh candidates from server"
        >
          ↻
        </button>
        {candidates.length > 0 && (
          <button
            onClick={() => setShowModal(true)}
            className="ml-1 text-[10px] text-orange-400 hover:text-orange-300 transition-colors"
          >
            Expand
          </button>
        )}
      </div>

      {showModal && createPortal(
        <CandidateModal
          title={`${transition.id} — Video Candidates`}
          groups={{ videos: candidates }}
          selectedMap={{ videos: selectedVariant }}
          disabled={selecting}
          projectName={projectName}
          mediaType="video"
          onSelect={(_groupKey, variantIndex) => handleSelect(variantIndex)}
          onClose={() => setShowModal(false)}
        />,
        document.body,
      )}

      {/* Candidates grid */}
      {candidates.length === 0 && !generating ? (
        <div className="text-center text-sm text-gray-600 py-4">No video candidates yet.</div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {[...candidates].sort((a, b) => {
            const na = parseInt(a.match(/v(\d+)\./)?.[1] || '0', 10)
            const nb = parseInt(b.match(/v(\d+)\./)?.[1] || '0', 10)
            return na - nb
          }).map((videoPath) => {
            const filename = videoPath.split('/').pop() || ''
            const variantNum = parseInt(filename.match(/v(\d+)\./)?.[1] || '0', 10)
            const label = filename || `v${variantNum}`
            const isSelected = selectedVariant === variantNum
            return (
              <LazyVideoCard
                key={videoPath}
                videoPath={videoPath}
                projectName={projectName}
                label={label}
                isSelected={isSelected}
                disabled={selecting}
                onSelect={() => handleSelect(variantNum)}
                onMouseEnter={() => onHoverPreview?.(beatlabFileUrl(projectName, videoPath))}
                onMouseLeave={() => onHoverPreview?.(null)}
                onBench={async () => {
                  const { postAddToBench } = await import('@/lib/beatlab-client')
                  await postAddToBench(projectName, 'transition', undefined, videoPath)
                }}
                onPool={async () => {
                  const url = `${import.meta.env.VITE_BEATLAB_API_URL || 'http://localhost:8888'}/api/projects/${encodeURIComponent(projectName)}/pool/add`
                  await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sourcePath: videoPath, type: 'transition' }),
                  })
                }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

export function CandidateModal({ title, groups, selectedMap, disabled, projectName, mediaType, onSelect, onClose }: {
  title: string
  groups: Record<string, string[]>
  selectedMap: Record<string, number | null>
  disabled: boolean
  projectName: string
  mediaType: 'image' | 'video'
  onSelect: (groupKey: string, variantIndex: number) => void
  onClose: () => void
}) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const accentColor = mediaType === 'video' ? 'orange' : 'blue'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/80" />
      <div
        className="relative bg-gray-900 w-screen h-screen overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className={`text-sm font-medium text-${accentColor}-300`}>{title}</div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">&times;</button>
        </div>

        {Object.keys(groups).sort().map((groupKey) => (
          <div key={groupKey} className="mb-6">
            <div className="text-xs text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1">
              {groupKey.replace(/_/g, ' ')}
              {selectedMap[groupKey] != null && <span className="text-green-400">&#10003;</span>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[...groups[groupKey]].sort((a, b) => {
                const na = parseInt(a.match(/v(\d+)\./)?.[1] || '0', 10)
                const nb = parseInt(b.match(/v(\d+)\./)?.[1] || '0', 10)
                return na - nb
              }).map((filePath) => {
                const vMatch = filePath.match(/v(\d+)\./)
                const variantNum = vMatch ? parseInt(vMatch[1], 10) : 0
                const isSelected = selectedMap[groupKey] === variantNum
                const label = filePath.split('/').pop() || `v${variantNum}`
                return (
                  <div
                    key={filePath}
                    onClick={() => !disabled && onSelect(groupKey, variantNum)}
                    className={`relative rounded-lg overflow-hidden border-2 cursor-pointer transition-colors ${
                      isSelected ? `border-${accentColor}-500` : 'border-transparent hover:border-gray-600'
                    } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    {mediaType === 'video' ? (
                      <ModalVideoCard videoPath={filePath} projectName={projectName} />
                    ) : (
                      <img
                        src={beatlabFileUrl(projectName, filePath)}
                        alt={label}
                        className="w-full aspect-video object-cover"
                      />
                    )}
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-300 font-mono">{label}</span>
                        {isSelected && (
                          <span className={`text-[10px] bg-${accentColor}-500 text-white px-1.5 py-0.5 rounded`}>selected</span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ModalVideoCard({ videoPath, projectName }: { videoPath: string; projectName: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => videoBlobCache.get(videoPath) ?? null)
  const [hovered, setHovered] = useState(false)
  const url = beatlabFileUrl(projectName, videoPath)

  useEffect(() => {
    if (videoBlobCache.has(videoPath)) { setBlobUrl(videoBlobCache.get(videoPath)!); return }
    fetch(url).then((r) => r.blob()).then((b) => {
      const bu = URL.createObjectURL(b)
      videoBlobCache.set(videoPath, bu)
      setBlobUrl(bu)
    }).catch(() => {})
  }, [videoPath, url])

  return blobUrl ? (
    <video
      src={blobUrl}
      className="w-full aspect-video object-cover"
      muted loop playsInline preload="metadata"
      autoPlay={hovered}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      ref={(el) => {
        if (!el) return
        if (hovered) el.play().catch(() => {})
        else { el.pause(); el.currentTime = 0 }
      }}
    />
  ) : (
    <div className="w-full aspect-video bg-gray-800 flex items-center justify-center">
      <span className="text-[10px] text-gray-500">...</span>
    </div>
  )
}

const videoBlobCache = new Map<string, string>() // url -> blob URL

function LazyVideoCard({ videoPath, projectName, label, isSelected, disabled, onSelect, onMouseEnter, onMouseLeave, onBench, onPool }: {
  videoPath: string; projectName: string; label: string; isSelected: boolean; disabled: boolean; onSelect: () => void
  onMouseEnter?: () => void; onMouseLeave?: () => void
  onBench?: () => void; onPool?: () => void
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => videoBlobCache.get(videoPath) ?? null)
  const [loading, setLoading] = useState(false)
  const [hovered, setHovered] = useState(false)
  const url = beatlabFileUrl(projectName, videoPath)

  // Download video once into a blob URL on first mount
  useEffect(() => {
    if (videoBlobCache.has(videoPath)) {
      setBlobUrl(videoBlobCache.get(videoPath)!)
      return
    }
    setLoading(true)
    fetch(url)
      .then((res) => res.blob())
      .then((blob) => {
        const bu = URL.createObjectURL(blob)
        videoBlobCache.set(videoPath, bu)
        setBlobUrl(bu)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [videoPath, url])

  return (
    <div
      className={`relative rounded overflow-hidden border-2 cursor-pointer transition-colors group ${
        isSelected ? 'border-orange-500' : 'border-transparent hover:border-gray-600'
      } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      onClick={onSelect}
      onMouseEnter={() => { setHovered(true); onMouseEnter?.() }}
      onMouseLeave={() => { setHovered(false); onMouseLeave?.() }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-beatlab-pool-path', videoPath)
        e.dataTransfer.effectAllowed = 'copy'
        const preview = e.currentTarget.cloneNode(true) as HTMLElement
        preview.style.width = '120px'
        preview.style.height = '68px'
        preview.style.opacity = '0.85'
        preview.style.borderRadius = '4px'
        preview.style.overflow = 'hidden'
        preview.style.position = 'absolute'
        preview.style.top = '-9999px'
        document.body.appendChild(preview)
        e.dataTransfer.setDragImage(preview, -12, -8)
        requestAnimationFrame(() => document.body.removeChild(preview))
      }}
    >
      {blobUrl ? (
        <video
          src={blobUrl}
          className="w-full aspect-video object-cover"
          muted
          loop
          playsInline
          preload="metadata"
          autoPlay={hovered}
          ref={(el) => {
            if (!el) return
            if (hovered) el.play().catch(() => {})
            else { el.pause(); el.currentTime = 0 }
          }}
        />
      ) : (
        <div className="w-full aspect-video bg-gray-800 flex items-center justify-center">
          <span className="text-[10px] text-gray-500 font-mono">{loading ? '...' : label}</span>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-300 font-mono">{label}</span>
          <div className="flex items-center gap-1">
            {onPool && (
              <button
                onClick={(e) => { e.stopPropagation(); onPool() }}
                className="text-[8px] text-purple-400/60 hover:text-purple-400 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Add to pool"
              >
                pool
              </button>
            )}
            {onBench && (
              <button
                onClick={(e) => { e.stopPropagation(); onBench() }}
                className="text-[8px] text-cyan-400/60 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Add to bench"
              >
                bench
              </button>
            )}
            {isSelected && (
              <span className="text-[9px] bg-orange-500 text-white px-1 rounded">selected</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ChromaKeyEditor({ transition, projectName, onDataChange }: { transition: Transition; projectName: string; onDataChange: () => void }) {
  const ck = transition.chromaKey || { color: [0, 1, 0] as [number, number, number], threshold: 0.3, feather: 0.1 }
  const [color, setColor] = useState<[number, number, number]>(ck.color)
  const [threshold, setThreshold] = useState(ck.threshold)
  const [feather, setFeather] = useState(ck.feather)

  const hexColor = `#${color.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`

  const save = useCallback(async (c: [number, number, number], t: number, f: number) => {
    const val = { color: c, threshold: t, feather: f }
    transition.chromaKey = val
    const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client')
    await postUpdateTransitionStyle(projectName, transition.id, { chromaKey: val })
    onDataChange()
  }, [projectName, transition, onDataChange])

  return (
    <div className="space-y-2 pt-1">
      <div className="text-[9px] text-gray-600">Remove a specific color from this transition's frames.</div>
      <div className="space-y-1">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Key Color</div>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="color" value={hexColor}
            onChange={(e) => {
              const hex = e.target.value
              const nc: [number, number, number] = [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255]
              setColor(nc); save(nc, threshold, feather)
            }}
            className="w-8 h-7 rounded border border-gray-700 cursor-pointer"
          />
          <span className="text-[9px] text-gray-400 font-mono">{hexColor}</span>
          <button
            onClick={async () => {
              try {
                const dropper = new ((window as Record<string, unknown>).EyeDropper as new () => { open: () => Promise<{ sRGBHex: string }> })()
                const result = await dropper.open()
                const hex = result.sRGBHex
                const nc: [number, number, number] = [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255]
                setColor(nc); save(nc, threshold, feather)
              } catch { /* cancelled or unsupported */ }
            }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-gray-800 text-amber-400 hover:text-amber-300 border border-gray-700"
            title="Pick color from screen"
          >Eyedropper</button>
        </div>
        <div className="flex gap-1">
          {([['Green', [0, 1, 0], 'bg-green-800 text-green-300'], ['Blue', [0, 0, 1], 'bg-blue-800 text-blue-300'], ['Black', [0, 0, 0], 'bg-gray-800 text-gray-300'], ['White', [1, 1, 1], 'bg-white text-gray-800']] as const).map(([lbl, cv, cls]) => (
            <button key={lbl} onClick={() => { const nc = cv as unknown as [number, number, number]; setColor(nc); save(nc, threshold, feather) }} className={`text-[9px] px-1.5 py-0.5 rounded ${cls}`}>{lbl}</button>
          ))}
        </div>
      </div>
      <div className="space-y-0.5">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Threshold: {threshold.toFixed(2)}</div>
        <input type="range" min={0} max={100} step={1} value={Math.round(threshold * 100)}
          onChange={(e) => { const t = parseInt(e.target.value, 10) / 100; setThreshold(t); save(color, t, feather) }}
          className="w-full h-1.5 accent-amber-500" />
      </div>
      <div className="space-y-0.5">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Feather: {feather.toFixed(2)}</div>
        <input type="range" min={0} max={50} step={1} value={Math.round(feather * 100)}
          onChange={(e) => { const f = parseInt(e.target.value, 10) / 100; setFeather(f); save(color, threshold, f) }}
          className="w-full h-1.5 accent-amber-500" />
      </div>
    </div>
  )
}

const TRANSFORM_AXES = ['X', 'Y', 'Z'] as const
type TransformAxis = typeof TRANSFORM_AXES[number]
const TRANSFORM_COLORS: Record<TransformAxis, string> = { X: '#00cccc', Y: '#cc44cc', Z: '#cccc00' }
const TRANSFORM_LABELS: Record<TransformAxis, string> = { X: 'X Offset', Y: 'Y Offset', Z: 'Scale' }
const TRANSFORM_DEFAULTS: Record<TransformAxis, number> = { X: 0, Y: 0, Z: 1 }
const TRANSFORM_RANGES: Record<TransformAxis, { min: number; max: number; log?: boolean }> = { X: { min: -1, max: 1 }, Y: { min: -1, max: 1 }, Z: { min: 0.1, max: 10, log: true } }
const TRANSFORM_CURVE_KEYS: Record<TransformAxis, 'transformXCurve' | 'transformYCurve' | 'transformZCurve'> = { X: 'transformXCurve', Y: 'transformYCurve', Z: 'transformZCurve' }
const TRANSFORM_STYLE_KEYS: Record<TransformAxis, string> = { X: 'transformXCurve', Y: 'transformYCurve', Z: 'transformZCurve' }

function TransformCurveEditor({ transition, projectName, keyframes, currentTime, onDataChange }: {
  transition: Transition; projectName: string; keyframes: KfWithTime[]; currentTime: number; onDataChange?: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [activeAxis, setActiveAxis] = useState<TransformAxis>('X')
  const [allPoints, setAllPoints] = useState<Record<TransformAxis, CurvePoint[]>>(() => ({
    X: (transition.transformXCurve as CurvePoint[]) || [[0, 0], [1, 0]],
    Y: (transition.transformYCurve as CurvePoint[]) || [[0, 0], [1, 0]],
    Z: (transition.transformZCurve as CurvePoint[]) || [[0, 1], [1, 1]],
  }))
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  // Dynamic ranges that expand when points approach boundaries
  const [dynamicRanges, setDynamicRanges] = useState<Record<TransformAxis, { min: number; max: number }>>(() => ({
    X: { ...TRANSFORM_RANGES.X }, Y: { ...TRANSFORM_RANGES.Y }, Z: { ...TRANSFORM_RANGES.Z },
  }))

  // Expand range if any point is near the boundary (within 15% of range)
  const expandRangeIfNeeded = useCallback((axis: TransformAxis, value: number) => {
    setDynamicRanges((prev) => {
      const r = prev[axis]
      const base = TRANSFORM_RANGES[axis]
      const isLogAxis = !!base.log
      let { min, max } = r
      const threshold = isLogAxis ? 0.15 : 0.15
      const span = isLogAxis ? (Math.log(max) - Math.log(min)) : (max - min)

      if (isLogAxis) {
        const logVal = Math.log(Math.max(0.001, value))
        const logMin = Math.log(min)
        const logMax = Math.log(max)
        if ((logVal - logMin) / span < threshold) {
          min = Math.max(0.001, Math.exp(logMin - span * 0.5))
        }
        if ((logMax - logVal) / span < threshold) {
          max = Math.exp(logMax + span * 0.5)
        }
      } else {
        if ((value - min) / span < threshold) {
          min = min - span * 0.5
        }
        if ((max - value) / span < threshold) {
          max = max + span * 0.5
        }
      }
      if (min === r.min && max === r.max) return prev
      return { ...prev, [axis]: { min, max } }
    })
  }, [])

  const PAD = 10
  const ASPECT = 2
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 240, h: 120 })
  const W = canvasSize.w
  const H = canvasSize.h

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect
      if (width > 0) setCanvasSize({ w: width, h: Math.round(width / ASPECT) })
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  const range = dynamicRanges[activeAxis]
  const isLog = !!TRANSFORM_RANGES[activeAxis].log
  const logMin = isLog ? Math.log(range.min) : 0
  const logMax = isLog ? Math.log(range.max) : 0
  const toCanvas = useCallback((x: number, y: number): [number, number] => {
    const cx = PAD + x * (W - 2 * PAD)
    let normalizedY: number
    if (isLog) {
      const logY = Math.log(Math.max(range.min, y))
      normalizedY = (logY - logMin) / (logMax - logMin)
    } else {
      normalizedY = (y - range.min) / (range.max - range.min)
    }
    const cy = H - PAD - normalizedY * (H - 2 * PAD)
    return [cx, cy]
  }, [W, H, range, isLog, logMin, logMax])
  const fromCanvas = useCallback((cx: number, cy: number): [number, number] => {
    const x = Math.max(0, Math.min(1, (cx - PAD) / (W - 2 * PAD)))
    const normalizedY = (H - PAD - cy) / (H - 2 * PAD)
    let y: number
    if (isLog) {
      y = Math.exp(logMin + normalizedY * (logMax - logMin))
    } else {
      y = range.min + normalizedY * (range.max - range.min)
    }
    return [x, Math.max(range.min, Math.min(range.max, y))]
  }, [W, H, range, isLog, logMin, logMax])
  const mouseToCanvas = (e: React.MouseEvent): [number, number] | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  // Draw all 3 curves
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, W, H)

    // Grid
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 0.5
    // Vertical grid lines (progress axis)
    for (let i = 0; i <= 4; i++) {
      const [x] = toCanvas(i / 4, range.min)
      ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, H - PAD); ctx.stroke()
    }
    // Horizontal grid lines — log-spaced for Z, linear for X/Y
    const logGridTicks = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 10, 20, 50, 100, 500, 1000]
    const gridValues = isLog ? logGridTicks.filter((v) => v >= range.min && v <= range.max) : Array.from({ length: 5 }, (_, i) => range.min + (i / 4) * (range.max - range.min))
    for (const gv of gridValues) {
      if (gv < range.min || gv > range.max) continue
      const [, y] = toCanvas(0, gv)
      ctx.strokeStyle = gv === 1 && isLog ? '#666' : '#333'
      ctx.lineWidth = gv === 1 && isLog ? 1 : 0.5
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke()
      if (isLog) {
        ctx.fillStyle = '#555'
        ctx.font = '7px monospace'
        ctx.textAlign = 'right'
        ctx.fillText(gv >= 1 ? `${gv}x` : `${gv}x`, PAD - 2, y + 3)
      }
    }

    // Axis labels
    ctx.fillStyle = '#666'
    ctx.font = '8px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('Progress \u2192', W / 2, H - 1)
    ctx.save()
    ctx.translate(8, H / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText(TRANSFORM_LABELS[activeAxis], 0, 0)
    ctx.restore()

    // Reference line at default value
    const defaultY = TRANSFORM_DEFAULTS[activeAxis]
    const [, refY] = toCanvas(0, defaultY)
    ctx.strokeStyle = '#555'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(PAD, refY)
    ctx.lineTo(W - PAD, refY)
    ctx.stroke()
    ctx.setLineDash([])

    // Draw all 3 curves
    for (const axis of TRANSFORM_AXES) {
      const pts = [...allPoints[axis]].sort((a, b) => a[0] - b[0]) as CurvePoint[]
      const color = TRANSFORM_COLORS[axis]
      const isActive = axis === activeAxis
      const axisRange = dynamicRanges[axis]

      const axisToCanvas = (x: number, y: number): [number, number] => {
        const cx = PAD + x * (W - 2 * PAD)
        let normalizedY: number
        if (TRANSFORM_RANGES[axis].log) {
          const lMin = Math.log(axisRange.min), lMax = Math.log(axisRange.max)
          normalizedY = (Math.log(Math.max(axisRange.min, y)) - lMin) / (lMax - lMin)
        } else {
          normalizedY = (y - axisRange.min) / (axisRange.max - axisRange.min)
        }
        return [cx, H - PAD - normalizedY * (H - 2 * PAD)]
      }

      // Curve line
      const STEPS = 24
      const curvePath: [number, number][] = []
      for (let i = 0; i < pts.length; i++) {
        if (i === 0) {
          curvePath.push(axisToCanvas(pts[0][0], pts[0][1]))
        } else {
          const [x0] = pts[i - 1]
          const [x1, y1] = pts[i]
          const easing = getEasing(pts[i])
          if (easing === 0) {
            curvePath.push(axisToCanvas(x1, y1))
          } else {
            for (let s = 1; s <= STEPS; s++) {
              const t = s / STEPS
              const val = evaluateCurve(pts, x0 + t * (x1 - x0))
              curvePath.push(axisToCanvas(x0 + t * (x1 - x0), val))
            }
          }
        }
      }

      ctx.strokeStyle = isActive ? color : color + '33'
      ctx.lineWidth = isActive ? 1.5 : 1
      ctx.beginPath()
      for (let i = 0; i < curvePath.length; i++) {
        if (i === 0) ctx.moveTo(curvePath[i][0], curvePath[i][1])
        else ctx.lineTo(curvePath[i][0], curvePath[i][1])
      }
      ctx.stroke()

      // Points (only for active axis, or all for hit-testing visual)
      for (let i = 0; i < pts.length; i++) {
        const [cx, cy] = axisToCanvas(pts[i][0], pts[i][1])
        const isEndpoint = i === 0 || i === pts.length - 1
        const isHovered = isActive && hoveredIdx === i
        const isDragging = isActive && draggingIdx === i
        const r = isDragging ? 3.5 : isHovered ? 3 : isActive ? 2.5 : 1.5

        ctx.beginPath()
        if (isEndpoint) {
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.fillStyle = isDragging ? color : isHovered ? color : isActive ? '#555' : color + '33'
        } else {
          ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath()
          ctx.fillStyle = isActive ? color : color + '33'
        }
        ctx.fill()

        if (isActive && (isHovered || isDragging)) {
          ctx.fillStyle = color
          ctx.font = '7px monospace'
          ctx.textAlign = cx > W / 2 ? 'right' : 'left'
          const labelX = cx > W / 2 ? cx - 8 : cx + 8
          ctx.fillText(`${pts[i][1].toFixed(2)}`, labelX, cy + 3)
        }
        const ptEasing = getEasing(pts[i])
        if (isActive && i > 0 && ptEasing > 0) {
          ctx.fillStyle = color + 'cc'
          ctx.font = 'bold 8px monospace'
          ctx.textAlign = 'center'
          ctx.fillText(EASING_LABELS[ptEasing], cx, cy - r - 3)
        }
      }
    }

    // Playhead
    const fromKf = keyframes.find((k) => k.id === transition.from)
    const toKf = keyframes.find((k) => k.id === transition.to)
    if (fromKf && toKf) {
      const span = toKf.timeSeconds - fromKf.timeSeconds
      if (span > 0) {
        const linearProgress = Math.max(0, Math.min(1, (currentTime - fromKf.timeSeconds) / span))
        const activePts = [...allPoints[activeAxis]].sort((a, b) => a[0] - b[0]) as CurvePoint[]
        const val = evaluateCurve(activePts, linearProgress)
        const [phx, phy] = toCanvas(linearProgress, val)
        const [, bottomY] = toCanvas(0, range.min)
        const [, topY] = toCanvas(0, range.max)

        ctx.strokeStyle = '#ffffff44'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(phx, topY)
        ctx.lineTo(phx, bottomY)
        ctx.stroke()

        ctx.beginPath()
        ctx.arc(phx, phy, 4, 0, Math.PI * 2)
        ctx.fillStyle = '#fff'
        ctx.fill()
        ctx.strokeStyle = TRANSFORM_COLORS[activeAxis]
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }
  }, [allPoints, activeAxis, hoveredIdx, draggingIdx, currentTime, keyframes, transition.from, transition.to, W, H, dynamicRanges, toCanvas])

  const save = useCallback(async (axis: TransformAxis, newPoints: CurvePoint[]) => {
    setSaving(true)
    const sorted = [...newPoints].sort((a, b) => a[0] - b[0])
    const cleaned: CurvePoint[] = sorted.map((p) => p[2] ? [p[0], p[1], p[2]] : [p[0], p[1]])
    try {
      const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client')
      const defaultVal = TRANSFORM_DEFAULTS[axis]
      const isDefault = cleaned.length === 2 && cleaned[0][1] === defaultVal && cleaned[1][1] === defaultVal && !cleaned[0][2] && !cleaned[1][2]
      await postUpdateTransitionStyle(projectName, transition.id, { [TRANSFORM_STYLE_KEYS[axis]]: isDefault ? null : cleaned } as Record<string, unknown> as never)
      ;(transition as Record<string, unknown>)[TRANSFORM_CURVE_KEYS[axis]] = isDefault ? null : cleaned
      onDataChange?.()
    } catch (e) {
      console.error(`Save transform ${axis} curve failed:`, e)
    } finally {
      setSaving(false)
    }
  }, [projectName, transition, onDataChange])

  const handleCycleEasing = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const pos = mouseToCanvas(e)
    if (!pos) return
    const sorted = [...allPoints[activeAxis]].sort((a, b) => a[0] - b[0]) as CurvePoint[]
    for (let i = 1; i < sorted.length; i++) {
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(pos[0] - px, pos[1] - py) < 10) {
        const cur = getEasing(sorted[i])
        const next = (cur + 1) % EASING_COUNT
        sorted[i] = [sorted[i][0], sorted[i][1], next]
        setAllPoints((prev) => ({ ...prev, [activeAxis]: sorted }))
        save(activeAxis, sorted)
        return
      }
    }
  }, [allPoints, activeAxis, save, toCanvas])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) return
    const pos = mouseToCanvas(e)
    if (!pos) return

    // Auto-switch: check active axis first, then others (so overlapping points prefer active)
    const axisOrder = [activeAxis, ...TRANSFORM_AXES.filter((a) => a !== activeAxis)]
    for (const axis of axisOrder) {
      const axisRange = dynamicRanges[axis]
      const axisToCanvas = (x: number, y: number): [number, number] => {
        const cx = PAD + x * (W - 2 * PAD)
        let normalizedY: number
        if (TRANSFORM_RANGES[axis].log) {
          const lMin = Math.log(axisRange.min), lMax = Math.log(axisRange.max)
          normalizedY = (Math.log(Math.max(axisRange.min, y)) - lMin) / (lMax - lMin)
        } else {
          normalizedY = (y - axisRange.min) / (axisRange.max - axisRange.min)
        }
        return [cx, H - PAD - normalizedY * (H - 2 * PAD)]
      }
      const sorted = [...allPoints[axis]].sort((a, b) => a[0] - b[0])
      for (let i = 0; i < sorted.length; i++) {
        const [px, py] = axisToCanvas(sorted[i][0], sorted[i][1])
        if (Math.hypot(pos[0] - px, pos[1] - py) < 6) {
          if (axis !== activeAxis) setActiveAxis(axis)
          setDraggingIdx(i)
          return
        }
      }
    }

    // No existing point hit — add new point on active axis
    const [nx, ny] = fromCanvas(pos[0], pos[1])
    const newPoints: CurvePoint[] = [...allPoints[activeAxis], [nx, ny]]
    newPoints.sort((a, b) => a[0] - b[0])
    setAllPoints((prev) => ({ ...prev, [activeAxis]: newPoints }))
    save(activeAxis, newPoints)
  }, [allPoints, activeAxis, save, fromCanvas, W, H])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = mouseToCanvas(e)
    if (!pos) return
    if (draggingIdx !== null) {
      const [nx, ny] = fromCanvas(pos[0], pos[1])
      expandRangeIfNeeded(activeAxis, ny)
      setAllPoints((prev) => {
        const sorted = [...prev[activeAxis]].sort((a, b) => a[0] - b[0])
        const minX = sorted[draggingIdx - 1]?.[0] ?? 0
        const maxX = sorted[draggingIdx + 1]?.[0] ?? 1
        const isEndpoint = draggingIdx === 0 || draggingIdx === sorted.length - 1
        const existingEasing = sorted[draggingIdx][2]
        sorted[draggingIdx] = existingEasing != null
          ? [Math.max(minX, Math.min(maxX, nx)), ny, existingEasing]
          : [Math.max(minX, Math.min(maxX, nx)), ny]
        // Shift+drag endpoint: move both endpoints to same Y
        if (e.shiftKey && isEndpoint) {
          const otherIdx = draggingIdx === 0 ? sorted.length - 1 : 0
          const otherEasing = sorted[otherIdx][2]
          sorted[otherIdx] = otherEasing != null
            ? [sorted[otherIdx][0], ny, otherEasing]
            : [sorted[otherIdx][0], ny]
        }
        return { ...prev, [activeAxis]: sorted }
      })
      return
    }
    // Hover detection on active axis only
    const sorted = [...allPoints[activeAxis]].sort((a, b) => a[0] - b[0])
    let found: number | null = null
    for (let i = 0; i < sorted.length; i++) {
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(pos[0] - px, pos[1] - py) < 6) { found = i; break }
    }
    setHoveredIdx(found)
  }, [draggingIdx, allPoints, activeAxis, fromCanvas, toCanvas, expandRangeIfNeeded])

  const handleMouseUp = useCallback(() => {
    if (draggingIdx !== null) { setDraggingIdx(null); save(activeAxis, allPoints[activeAxis]) }
  }, [draggingIdx, allPoints, activeAxis, save])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const pos = mouseToCanvas(e)
    if (!pos) return
    const sorted = [...allPoints[activeAxis]].sort((a, b) => a[0] - b[0])
    for (let i = 1; i < sorted.length - 1; i++) {
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(pos[0] - px, pos[1] - py) < 6) {
        const newPoints = sorted.filter((_, j) => j !== i)
        setAllPoints((prev) => ({ ...prev, [activeAxis]: newPoints }))
        save(activeAxis, newPoints)
        setHoveredIdx(null)
        return
      }
    }
  }, [allPoints, activeAxis, save, toCanvas])

  const handleReset = useCallback(() => {
    const defaultVal = TRANSFORM_DEFAULTS[activeAxis]
    const defaultPoints: CurvePoint[] = [[0, defaultVal], [1, defaultVal]]
    setAllPoints((prev) => ({ ...prev, [activeAxis]: defaultPoints }))
    save(activeAxis, defaultPoints)
    setHoveredIdx(null)
  }, [activeAxis, save])

  const activePoints = allPoints[activeAxis]
  const defaultVal = TRANSFORM_DEFAULTS[activeAxis]
  const hasChanges = activePoints.length > 2 || activePoints.some((p) => p[1] !== defaultVal || (p[2] && p[2] > 0))

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Transform</div>
        <button
          onClick={handleReset}
          disabled={saving || !hasChanges}
          className="text-[10px] text-gray-500 hover:text-gray-300 disabled:text-gray-700 transition-colors"
        >
          Reset {activeAxis}
        </button>
      </div>
      {/* Pill tabs */}
      <div className="flex gap-0.5">
        {TRANSFORM_AXES.map((axis) => (
          <button
            key={axis}
            onClick={() => setActiveAxis(axis)}
            className={`flex-1 text-[9px] py-1 rounded transition-colors ${activeAxis === axis ? 'text-white font-medium' : 'text-gray-500 hover:text-gray-300 bg-gray-800'}`}
            style={activeAxis === axis ? { backgroundColor: TRANSFORM_COLORS[axis] + '44', color: TRANSFORM_COLORS[axis] } : undefined}
          >
            {axis}
          </button>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        className="w-full rounded border border-gray-700 cursor-crosshair"
        style={{ width: '100%', height: 'auto', aspectRatio: `${ASPECT} / 1` }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { handleMouseUp(); setHoveredIdx(null) }}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleCycleEasing}
      />
      <div className="text-[8px] text-gray-600">
        <span className="text-gray-500">Click</span> add · <span className="text-gray-500">Drag</span> move · <span className="text-gray-500">Dbl-click</span> remove · <span className="text-gray-500">Right-click</span> easing
      </div>
    </div>
  )
}

function AnimCurveEditor({ label, defaultY, color, yLabel, transition, projectName, keyframes, currentTime, curveKey, styleKey, onDataChange, lockY, diagonalRef, aspect: aspectProp, onSave: customSave, initialPoints: initialPointsProp, maxY: maxYProp }: {
  label: string; defaultY: number; color: string; yLabel: string
  transition: Transition; projectName: string; keyframes: KfWithTime[]; currentTime: number
  curveKey?: string; styleKey?: string; onDataChange?: () => void
  lockY?: boolean; diagonalRef?: boolean; aspect?: number; onSave?: (points: CurvePoint[]) => Promise<void>; initialPoints?: CurvePoint[]
  maxY?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [points, setPoints] = useState<CurvePoint[]>(() =>
    initialPointsProp || (curveKey ? (transition as Record<string, unknown>)[curveKey] as CurvePoint[] : null) || [[0, defaultY], [1, defaultY]]
  )
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const PAD = 10
  const ASPECT = aspectProp ?? 3
  const maxY = maxYProp ?? 1
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 240, h: Math.round(240 / (aspectProp ?? 3)) })
  const W = canvasSize.w
  const H = canvasSize.h

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect
      if (width > 0) setCanvasSize({ w: width, h: Math.round(width / ASPECT) })
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  const toCanvas = (x: number, y: number): [number, number] => [
    PAD + x * (W - 2 * PAD),
    H - PAD - (y / maxY) * (H - 2 * PAD),
  ]
  const fromCanvas = (cx: number, cy: number): [number, number] => [
    Math.max(0, Math.min(1, (cx - PAD) / (W - 2 * PAD))),
    Math.max(0, Math.min(maxY, ((H - PAD - cy) / (H - 2 * PAD)) * maxY)),
  ]
  const mouseToCanvas = (e: React.MouseEvent): [number, number] | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, W, H)

    // Grid
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 0.5
    for (let i = 0; i <= 4; i++) {
      const [x] = toCanvas(i / 4, 0)
      const [, y] = toCanvas(0, i / 4)
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, H - PAD); ctx.stroke()
    }

    ctx.fillStyle = '#666'
    ctx.font = '8px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('Progress \u2192', W / 2, H - 1)
    ctx.save()
    ctx.translate(8, H / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText(yLabel, 0, 0)
    ctx.restore()
    ctx.fillStyle = '#555'
    ctx.font = '7px monospace'
    ctx.textAlign = 'left'
    ctx.fillText('0%', PAD, H - PAD + 9)
    ctx.textAlign = 'right'
    ctx.fillText('100%', W - PAD, H - PAD + 9)
    ctx.textAlign = 'left'
    ctx.fillText(`${Math.round(maxY * 100)}%`, 1, PAD + 3)
    // Draw 100% reference line when maxY > 1
    if (maxY > 1) {
      const [, y100] = toCanvas(0, 1)
      ctx.strokeStyle = '#444'
      ctx.lineWidth = 0.5
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(PAD, y100)
      ctx.lineTo(W - PAD, y100)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#444'
      ctx.fillText('100%', 1, y100 + 3)
    }

    // Reference line (diagonal for remap, horizontal at y=0 for others)
    ctx.strokeStyle = '#555'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    const [lx0, ly0] = toCanvas(0, 0)
    const [lx1, ly1] = toCanvas(1, diagonalRef ? 1 : 0)
    ctx.moveTo(lx0, ly0)
    ctx.lineTo(lx1, ly1)
    ctx.stroke()
    ctx.setLineDash([])

    const sorted = [...points].sort((a, b) => a[0] - b[0]) as CurvePoint[]

    // Draw eased curve segments with sub-sampling
    const STEPS_PER_SEGMENT = 24
    const curvePath: [number, number][] = []
    for (let i = 0; i < sorted.length; i++) {
      if (i === 0) {
        curvePath.push(toCanvas(sorted[0][0], sorted[0][1]))
      } else {
        const [x0] = sorted[i - 1]
        const [x1, y1] = sorted[i]
        const easing = getEasing(sorted[i])
        if (easing === 0) {
          // Linear — single line segment
          curvePath.push(toCanvas(x1, y1))
        } else {
          // Eased — sub-sample the segment
          for (let s = 1; s <= STEPS_PER_SEGMENT; s++) {
            const t = s / STEPS_PER_SEGMENT
            const val = evaluateCurve(sorted, x0 + t * (x1 - x0))
            curvePath.push(toCanvas(x0 + t * (x1 - x0), val))
          }
        }
      }
    }

    // Curve line
    ctx.strokeStyle = color + '66'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < curvePath.length; i++) {
      if (i === 0) ctx.moveTo(curvePath[i][0], curvePath[i][1])
      else ctx.lineTo(curvePath[i][0], curvePath[i][1])
    }
    ctx.stroke()

    // Fill area under curve
    ctx.fillStyle = color + '11'
    ctx.beginPath()
    const [bx0, by0] = toCanvas(sorted[0][0], 0)
    ctx.moveTo(bx0, by0)
    for (const [cx, cy] of curvePath) ctx.lineTo(cx, cy)
    const [bxN, byN] = toCanvas(sorted[sorted.length - 1][0], 0)
    ctx.lineTo(bxN, byN)
    ctx.closePath()
    ctx.fill()

    // Points
    for (let i = 0; i < sorted.length; i++) {
      const [cx, cy] = toCanvas(sorted[i][0], sorted[i][1])
      const isEndpoint = i === 0 || i === sorted.length - 1
      const isHovered = hoveredIdx === i
      const isDragging = draggingIdx === i

      if (!isEndpoint) {
        const [, bottomY] = toCanvas(0, 0)
        ctx.strokeStyle = isDragging ? color : isHovered ? color + 'aa' : color + '44'
        ctx.lineWidth = 1
        ctx.setLineDash([2, 2])
        ctx.beginPath()
        ctx.moveTo(cx, bottomY)
        ctx.lineTo(cx, cy)
        ctx.stroke()
        ctx.setLineDash([])
      }

      const r = isDragging ? 3.5 : isHovered ? 3 : 2.5
      if (isEndpoint) {
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fillStyle = isDragging ? color : isHovered ? color : '#555'
        ctx.fill()
        ctx.strokeStyle = isDragging ? '#fff' : '#888'
        ctx.lineWidth = 0.5
        ctx.stroke()
      } else {
        ctx.beginPath()
        ctx.moveTo(cx, cy - r)
        ctx.lineTo(cx + r, cy)
        ctx.lineTo(cx, cy + r)
        ctx.lineTo(cx - r, cy)
        ctx.closePath()
        ctx.fillStyle = isDragging ? color : color
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 0.5
        ctx.stroke()
      }

      if (isHovered || isDragging) {
        ctx.fillStyle = color
        ctx.font = '7px monospace'
        ctx.textAlign = cx > W / 2 ? 'right' : 'left'
        const labelX = cx > W / 2 ? cx - 8 : cx + 8
        ctx.fillText(`${Math.round(sorted[i][1] * 100)}%`, labelX, cy + 3)
      }
      // Easing type indicator for non-first points with non-linear easing
      const ptEasing = getEasing(sorted[i])
      if (i > 0 && ptEasing > 0) {
        ctx.fillStyle = color + 'cc'
        ctx.font = 'bold 8px monospace'
        ctx.textAlign = 'center'
        ctx.fillText(EASING_LABELS[ptEasing], cx, cy - r - 3)
      }
    }

    // Playhead
    const fromKf = keyframes.find((k) => k.id === transition.from)
    const toKf = keyframes.find((k) => k.id === transition.to)
    if (fromKf && toKf) {
      const span = toKf.timeSeconds - fromKf.timeSeconds
      if (span > 0) {
        const linearProgress = Math.max(0, Math.min(1, (currentTime - fromKf.timeSeconds) / span))
        const val = evaluateCurve(sorted, linearProgress)
        const [phx, phy] = toCanvas(linearProgress, val)
        const [, bottomY] = toCanvas(0, 0)
        const [, topY] = toCanvas(0, 1)

        ctx.strokeStyle = '#ffffff44'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(phx, topY)
        ctx.lineTo(phx, bottomY)
        ctx.stroke()

        ctx.beginPath()
        ctx.arc(phx, phy, 4, 0, Math.PI * 2)
        ctx.fillStyle = '#fff'
        ctx.fill()
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }
  }, [points, hoveredIdx, draggingIdx, currentTime, keyframes, transition.from, transition.to, color, yLabel, diagonalRef, W, H])

  const save = useCallback(async (newPoints: CurvePoint[]) => {
    setSaving(true)
    const sorted = [...newPoints].sort((a, b) => a[0] - b[0])
    // Strip easing=0 (linear) from points to keep data compact for backward compat
    const cleaned: CurvePoint[] = sorted.map((p) => p[2] ? [p[0], p[1], p[2]] : [p[0], p[1]])
    try {
      if (customSave) {
        await customSave(cleaned)
      } else {
        const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client')
        const isDefault = cleaned.length === 2 && cleaned[0][1] === defaultY && cleaned[1][1] === defaultY && !cleaned[0][2] && !cleaned[1][2]
        await postUpdateTransitionStyle(projectName, transition.id, { [styleKey!]: isDefault ? null : cleaned } as Record<string, unknown> as never)
        ;(transition as Record<string, unknown>)[curveKey!] = isDefault ? null : cleaned
        onDataChange?.()
      }
    } catch (e) {
      console.error(`Save ${label} curve failed:`, e)
    } finally {
      setSaving(false)
    }
  }, [projectName, transition, onDataChange, curveKey, styleKey, defaultY, label])

  const handleCycleEasing = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const pos = mouseToCanvas(e)
    if (!pos) return
    const sorted = [...points].sort((a, b) => a[0] - b[0]) as CurvePoint[]
    for (let i = 1; i < sorted.length; i++) { // skip first point (no incoming segment)
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(pos[0] - px, pos[1] - py) < 10) {
        const cur = getEasing(sorted[i])
        const next = (cur + 1) % EASING_COUNT
        sorted[i] = [sorted[i][0], sorted[i][1], next]
        setPoints(sorted)
        save(sorted)
        return
      }
    }
  }, [points, save])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) return // right-click handled by context menu
    const pos = mouseToCanvas(e)
    if (!pos) return
    const sorted = [...points].sort((a, b) => a[0] - b[0])
    for (let i = 0; i < sorted.length; i++) {
      // Skip endpoints when lockY (time remap) — they're fixed at [0,0] and [1,1]
      if (lockY && (i === 0 || i === sorted.length - 1)) continue
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(pos[0] - px, pos[1] - py) < 6) {
        setDraggingIdx(i)
        return
      }
    }
    const [nx, ny] = fromCanvas(pos[0], pos[1])
    const newPoints: CurvePoint[] = [...points, [nx, ny]]
    newPoints.sort((a, b) => a[0] - b[0])
    setPoints(newPoints)
    save(newPoints)
  }, [points, save])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = mouseToCanvas(e)
    if (!pos) return
    if (draggingIdx !== null) {
      const [nx, ny] = fromCanvas(pos[0], pos[1])
      setPoints((prev) => {
        const sorted = [...prev].sort((a, b) => a[0] - b[0])
        // For lockY (time remap): endpoints are fully locked, intermediate points lock Y only
        if (lockY && (draggingIdx === 0 || draggingIdx === sorted.length - 1)) return sorted
        const minX = sorted[draggingIdx - 1]?.[0] ?? 0
        const maxX = sorted[draggingIdx + 1]?.[0] ?? 1
        const newY = lockY ? sorted[draggingIdx][1] : ny
        const existingEasing = sorted[draggingIdx][2]
        sorted[draggingIdx] = existingEasing != null
          ? [Math.max(minX, Math.min(maxX, nx)), newY, existingEasing]
          : [Math.max(minX, Math.min(maxX, nx)), newY]
        // Shift+drag endpoint: move both endpoints to same Y
        const isEndpoint = draggingIdx === 0 || draggingIdx === sorted.length - 1
        if (e.shiftKey && isEndpoint && !lockY) {
          const otherIdx = draggingIdx === 0 ? sorted.length - 1 : 0
          const otherEasing = sorted[otherIdx][2]
          sorted[otherIdx] = otherEasing != null
            ? [sorted[otherIdx][0], newY, otherEasing]
            : [sorted[otherIdx][0], newY]
        }
        return sorted
      })
      return
    }
    const sorted = [...points].sort((a, b) => a[0] - b[0])
    let found: number | null = null
    for (let i = 0; i < sorted.length; i++) {
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(pos[0] - px, pos[1] - py) < 6) { found = i; break }
    }
    setHoveredIdx(found)
  }, [draggingIdx, points])

  const handleMouseUp = useCallback(() => {
    if (draggingIdx !== null) { setDraggingIdx(null); save(points) }
  }, [draggingIdx, points, save])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const pos = mouseToCanvas(e)
    if (!pos) return
    const sorted = [...points].sort((a, b) => a[0] - b[0])
    for (let i = 1; i < sorted.length - 1; i++) {
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(pos[0] - px, pos[1] - py) < 6) {
        const newPoints = sorted.filter((_, j) => j !== i)
        setPoints(newPoints)
        save(newPoints)
        setHoveredIdx(null)
        return
      }
    }
  }, [points, save])

  const handleReset = useCallback(() => {
    const defaultPoints: CurvePoint[] = [[0, defaultY], [1, defaultY]]
    setPoints(defaultPoints)
    save(defaultPoints)
    setHoveredIdx(null)
  }, [save, defaultY])

  const hasChanges = points.length > 2 || points.some((p) => p[1] !== defaultY || (p[2] && p[2] > 0))

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</div>
        <button
          onClick={handleReset}
          disabled={saving || !hasChanges}
          className="text-[10px] text-gray-500 hover:text-gray-300 disabled:text-gray-700 transition-colors"
        >
          Reset
        </button>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full rounded border border-gray-700 cursor-crosshair"
        style={{ width: '100%', height: 'auto', aspectRatio: `${ASPECT} / 1` }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { handleMouseUp(); setHoveredIdx(null) }}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleCycleEasing}
      />
      <div className="text-[8px] text-gray-600">
        <span className="text-gray-500">Click</span> add · <span className="text-gray-500">Drag</span> move · <span className="text-gray-500">Dbl-click</span> remove · <span className="text-gray-500">Right-click</span> cycle easing
      </div>
    </div>
  )
}

function OpacityCurveEditor({ transition, projectName, keyframes, currentTime, onDataChange }: {
  transition: Transition; projectName: string; keyframes: KfWithTime[]; currentTime: number; onDataChange: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [points, setPoints] = useState<[number, number][]>(() =>
    transition.opacityCurve || [[0, 1], [1, 1]]
  )
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const PAD = 10
  const ASPECT = 3 // width:height ratio
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 240, h: 80 })
  const W = canvasSize.w
  const H = canvasSize.h

  // Measure actual rendered size
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect
      if (width > 0) setCanvasSize({ w: width, h: Math.round(width / ASPECT) })
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  const toCanvas = (x: number, y: number): [number, number] => [
    PAD + x * (W - 2 * PAD),
    H - PAD - y * (H - 2 * PAD),
  ]
  const fromCanvas = (cx: number, cy: number): [number, number] => [
    Math.max(0, Math.min(1, (cx - PAD) / (W - 2 * PAD))),
    Math.max(0, Math.min(1, (H - PAD - cy) / (H - 2 * PAD))),
  ]

  const mouseToCanvas = (e: React.MouseEvent): [number, number] | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return [
      e.clientX - rect.left,
      e.clientY - rect.top,
    ]
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    // Background
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, W, H)

    // Grid
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 0.5
    for (let i = 0; i <= 4; i++) {
      const [x] = toCanvas(i / 4, 0)
      const [, y] = toCanvas(0, i / 4)
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, H - PAD); ctx.stroke()
    }

    // Axis labels
    ctx.fillStyle = '#666'
    ctx.font = '8px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('Progress \u2192', W / 2, H - 1)
    ctx.save()
    ctx.translate(8, H / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('Opacity \u2192', 0, 0)
    ctx.restore()
    ctx.fillStyle = '#555'
    ctx.font = '7px monospace'
    ctx.textAlign = 'left'
    ctx.fillText('0%', PAD, H - PAD + 9)
    ctx.textAlign = 'right'
    ctx.fillText('100%', W - PAD, H - PAD + 9)
    ctx.textAlign = 'left'
    ctx.fillText('100%', 1, PAD + 3)

    // 100% reference line (horizontal)
    ctx.strokeStyle = '#555'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    const [lx0, ly0] = toCanvas(0, 1)
    const [lx1] = toCanvas(1, 1)
    ctx.moveTo(lx0, ly0)
    ctx.lineTo(lx1, ly0)
    ctx.stroke()
    ctx.setLineDash([])

    const sorted = [...points].sort((a, b) => a[0] - b[0])

    // Curve line
    ctx.strokeStyle = '#38bdf866'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < sorted.length; i++) {
      const [cx, cy] = toCanvas(sorted[i][0], sorted[i][1])
      if (i === 0) ctx.moveTo(cx, cy)
      else ctx.lineTo(cx, cy)
    }
    ctx.stroke()

    // Fill area under curve
    ctx.fillStyle = '#38bdf811'
    ctx.beginPath()
    const [bx0, by0] = toCanvas(sorted[0][0], 0)
    ctx.moveTo(bx0, by0)
    for (let i = 0; i < sorted.length; i++) {
      const [cx, cy] = toCanvas(sorted[i][0], sorted[i][1])
      ctx.lineTo(cx, cy)
    }
    const [bxN, byN] = toCanvas(sorted[sorted.length - 1][0], 0)
    ctx.lineTo(bxN, byN)
    ctx.closePath()
    ctx.fill()

    // Points
    for (let i = 0; i < sorted.length; i++) {
      const [cx, cy] = toCanvas(sorted[i][0], sorted[i][1])
      const isEndpoint = i === 0 || i === sorted.length - 1
      const isHovered = hoveredIdx === i
      const isDragging = draggingIdx === i

      if (!isEndpoint) {
        // Vertical guide
        const [, bottomY] = toCanvas(0, 0)
        ctx.strokeStyle = isDragging ? '#38bdf8' : isHovered ? '#38bdf8aa' : '#38bdf844'
        ctx.lineWidth = 1
        ctx.setLineDash([2, 2])
        ctx.beginPath()
        ctx.moveTo(cx, bottomY)
        ctx.lineTo(cx, cy)
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Diamond for intermediate, circle for endpoints — fixed size regardless of canvas stretch
      const r = isDragging ? 3.5 : isHovered ? 3 : 2.5
      if (isEndpoint) {
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fillStyle = isDragging ? '#38bdf8' : isHovered ? '#38bdf8' : '#555'
        ctx.fill()
        ctx.strokeStyle = isDragging ? '#fff' : '#888'
        ctx.lineWidth = 0.5
        ctx.stroke()
      } else {
        ctx.beginPath()
        ctx.moveTo(cx, cy - r)
        ctx.lineTo(cx + r, cy)
        ctx.lineTo(cx, cy + r)
        ctx.lineTo(cx - r, cy)
        ctx.closePath()
        ctx.fillStyle = isDragging ? '#38bdf8' : '#0ea5e9'
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 0.5
        ctx.stroke()
      }

      // Label
      if (isHovered || isDragging) {
        ctx.fillStyle = '#7dd3fc'
        ctx.font = '7px monospace'
        ctx.textAlign = cx > W / 2 ? 'right' : 'left'
        const labelX = cx > W / 2 ? cx - 8 : cx + 8
        ctx.fillText(`${Math.round(sorted[i][1] * 100)}%`, labelX, cy + 3)
      }
    }

    // Playhead
    const fromKf = keyframes.find((k) => k.id === transition.from)
    const toKf = keyframes.find((k) => k.id === transition.to)
    if (fromKf && toKf) {
      const span = toKf.timeSeconds - fromKf.timeSeconds
      if (span > 0) {
        const linearProgress = Math.max(0, Math.min(1, (currentTime - fromKf.timeSeconds) / span))
        const opacityVal = evaluateCurve(sorted, linearProgress)
        const [phx, phy] = toCanvas(linearProgress, opacityVal)
        const [, bottomY] = toCanvas(0, 0)
        const [, topY] = toCanvas(0, 1)

        ctx.strokeStyle = '#ffffff44'
        ctx.lineWidth = 1
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.moveTo(phx, topY)
        ctx.lineTo(phx, bottomY)
        ctx.stroke()

        ctx.beginPath()
        ctx.arc(phx, phy, 4, 0, Math.PI * 2)
        ctx.fillStyle = '#fff'
        ctx.fill()
        ctx.strokeStyle = '#0ea5e9'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }
  }, [points, hoveredIdx, draggingIdx, currentTime, keyframes, transition.from, transition.to])

  const save = useCallback(async (newPoints: [number, number][]) => {
    setSaving(true)
    const sorted = [...newPoints].sort((a, b) => a[0] - b[0])
    try {
      const { postUpdateTransitionStyle } = await import('@/lib/beatlab-client')
      const isDefault = sorted.length === 2 && sorted[0][1] === 1 && sorted[1][1] === 1
      await postUpdateTransitionStyle(projectName, transition.id, { opacityCurve: isDefault ? null : sorted })
      transition.opacityCurve = isDefault ? null : sorted
      onDataChange()
    } catch (e) {
      console.error('Save opacity curve failed:', e)
    } finally {
      setSaving(false)
    }
  }, [projectName, transition, onDataChange])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const pos = mouseToCanvas(e)
    if (!pos) return
    const [cx, cy] = pos

    const sorted = [...points].sort((a, b) => a[0] - b[0])
    for (let i = 0; i < sorted.length; i++) {
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(cx - px, cy - py) < 6) {
        setDraggingIdx(i)
        return
      }
    }

    // Add new point
    const [nx, ny] = fromCanvas(cx, cy)
    const newPoints: [number, number][] = [...points, [nx, ny]]
    newPoints.sort((a, b) => a[0] - b[0])
    setPoints(newPoints)
    save(newPoints)
  }, [points, save])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = mouseToCanvas(e)
    if (!pos) return

    if (draggingIdx !== null) {
      const [nx, ny] = fromCanvas(pos[0], pos[1])
      setPoints((prev) => {
        const sorted = [...prev].sort((a, b) => a[0] - b[0])
        const minX = sorted[draggingIdx - 1]?.[0] ?? 0
        const maxX = sorted[draggingIdx + 1]?.[0] ?? 1
        sorted[draggingIdx] = [Math.max(minX, Math.min(maxX, nx)), ny]
        // Shift+drag endpoint: move both endpoints to same Y
        const isEndpoint = draggingIdx === 0 || draggingIdx === sorted.length - 1
        if (e.shiftKey && isEndpoint) {
          const otherIdx = draggingIdx === 0 ? sorted.length - 1 : 0
          sorted[otherIdx] = [sorted[otherIdx][0], ny]
        }
        return sorted
      })
      return
    }

    const sorted = [...points].sort((a, b) => a[0] - b[0])
    let found: number | null = null
    for (let i = 0; i < sorted.length; i++) {
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(pos[0] - px, pos[1] - py) < 8) {
        found = i
        break
      }
    }
    setHoveredIdx(found)
  }, [draggingIdx, points])

  const handleMouseUp = useCallback(() => {
    if (draggingIdx !== null) {
      setDraggingIdx(null)
      save(points)
    }
  }, [draggingIdx, points, save])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const pos = mouseToCanvas(e)
    if (!pos) return

    const sorted = [...points].sort((a, b) => a[0] - b[0])
    for (let i = 1; i < sorted.length - 1; i++) {
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(pos[0] - px, pos[1] - py) < 6) {
        const newPoints = sorted.filter((_, j) => j !== i)
        setPoints(newPoints)
        save(newPoints)
        setHoveredIdx(null)
        return
      }
    }
  }, [points, save])

  const handleReset = useCallback(() => {
    const defaultPoints: [number, number][] = [[0, 1], [1, 1]]
    setPoints(defaultPoints)
    save(defaultPoints)
    setHoveredIdx(null)
  }, [save])

  const pinCount = points.length - 2

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Opacity Curve</div>
        <button
          onClick={handleReset}
          disabled={saving || pinCount <= 0}
          className="text-[10px] text-gray-500 hover:text-gray-300 disabled:text-gray-700 transition-colors"
        >
          Reset
        </button>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full rounded border border-gray-700 cursor-crosshair"
        style={{ width: '100%', height: `${H}px` }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { handleMouseUp(); setHoveredIdx(null) }}
        onDoubleClick={handleDoubleClick}
      />
      <div className="text-[9px] text-gray-600 space-y-0.5">
        <div><span className="text-gray-500">Click</span> to add · <span className="text-gray-500">Drag</span> to move · <span className="text-gray-500">Dbl-click</span> to remove</div>
      </div>
    </div>
  )
}

const browseBlobCache = new Map<string, string>()

function BenchTab({ transition, projectName, onAssigned, onSeek }: { transition: Transition; projectName: string; onAssigned: () => void; onSeek: () => void }) {
  const [items, setItems] = useState<import('@/lib/beatlab-client').BenchItem[]>([])
  const [loading, setLoading] = useState(true)
  const [assigning, setAssigning] = useState(false)

  useEffect(() => {
    import('@/lib/beatlab-client').then(({ fetchBench }) =>
      fetchBench(projectName).then(setItems)
    ).finally(() => setLoading(false))
  }, [projectName])

  const handleAssign = useCallback(async (sourcePath: string) => {
    setAssigning(true)
    try {
      await postAssignPoolVideo(projectName, transition.id, sourcePath)
      autoSave(projectName, `Assigned bench video to ${transition.id}`)
      const oldVariant = transition.selected ?? 'none'
      invalidateEntry(`tr:${transition.id}:v${oldVariant}`)
      transition.hasSelectedVideo = true
      onAssigned()
    } catch (e) {
      console.error('Assign from bench failed:', e)
    } finally {
      setAssigning(false)
    }
  }, [projectName, transition, onAssigned])

  const handleRemove = useCallback(async (benchId: string) => {
    try {
      const { postRemoveFromBench } = await import('@/lib/beatlab-client')
      await postRemoveFromBench(projectName, benchId)
      setItems((prev) => prev.filter((i) => i.id !== benchId))
    } catch (e) {
      console.error('Remove from bench failed:', e)
    }
  }, [projectName])

  if (loading) return <div className="p-4 text-center text-sm text-gray-600">Loading...</div>

  const trItems = items.filter((i) => i.type === 'transition')

  if (trItems.length === 0) {
    return <div className="p-4 text-center text-sm text-gray-600">No benched transitions. Click "Bench" on a transition to add it here.</div>
  }

  return (
    <div className="p-2 space-y-2">
      {trItems.map((item) => (
        <div key={item.id} className="bg-gray-800/50 rounded p-2 space-y-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BrowseVideoCard
                path={item.sourcePath}
                label={item.label}
                projectName={projectName}
                disabled={assigning}
                onAssign={() => handleAssign(item.sourcePath)}
              />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-gray-500">{item.usageCount} uses</span>
            <button
              onClick={() => handleRemove(item.id)}
              className="text-[9px] text-red-400/60 hover:text-red-400"
            >
              Remove
            </button>
          </div>
          {item.usages.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {item.usages.map((u) => (
                <button
                  key={u.entityId}
                  className="text-[8px] bg-gray-700 text-yellow-300 px-1 py-0.5 rounded hover:bg-gray-600"
                  title={`Jump to ${u.entityId}`}
                  onClick={onSeek}
                >
                  {u.timestamp}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function BrowseTab({ transition, projectName, onAssigned }: { transition: Transition; projectName: string; onAssigned: () => void }) {
  const [poolSegments, setPoolSegments] = useState<PoolEntry[]>([])
  const [binTransitions, setBinTransitions] = useState<TransitionBinEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [assigning, setAssigning] = useState(false)
  const [tagFilter, setTagFilter] = useState('')

  useEffect(() => {
    Promise.all([
      fetchPool(projectName).catch(() => ({ keyframes: [], segments: [] })),
      fetchBin(projectName).catch(() => ({ bin: [], transitionBin: [] })),
    ]).then(([poolData, binData]) => {
      setPoolSegments(poolData.segments || [])
      setBinTransitions(binData.transitionBin || [])
    }).finally(() => setLoading(false))
  }, [projectName])

  const allTags = useMemo(() => {
    const tags = new Set<string>()
    for (const e of poolSegments) for (const t of e.tags || []) tags.add(t)
    return [...tags].sort()
  }, [poolSegments])

  const filteredSegments = tagFilter
    ? poolSegments.filter((e) => e.tags?.includes(tagFilter))
    : poolSegments

  const handleAssign = useCallback(async (poolPath: string) => {
    setAssigning(true)
    try {
      const result = await postAssignPoolVideo(projectName, transition.id, poolPath)
      // Invalidate frame cache so the new video gets decoded
      const oldVariant = transition.selected ?? 'none'
      invalidateEntry(`tr:${transition.id}:v${oldVariant}`)
      if (result.variant) {
        invalidateEntry(`tr:${transition.id}:v${result.variant}`)
        transition.selected = result.variant
      }
      transition.hasSelectedVideo = true
      autoSave(projectName, `Assigned pool video to ${transition.id}`)
      onAssigned()
    } catch (e) {
      console.error('Assign failed:', e)
      alert(`Assign failed: ${e}`)
    } finally {
      setAssigning(false)
    }
  }, [projectName, transition.id])

  if (loading) return <div className="p-4 text-center text-sm text-gray-600">Loading...</div>

  return (
    <div className="p-2 space-y-3">
      {/* Tag filter */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => setTagFilter('')}
            className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${!tagFilter ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
          >
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}
              className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${tagFilter === tag ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {/* Pool videos */}
      {filteredSegments.length > 0 && (
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
            Pool ({filteredSegments.length})
          </div>
          <div className="grid grid-cols-2 gap-1">
            {filteredSegments.map((entry) => (
              <BrowseVideoCard
                key={entry.name}
                path={entry.path}
                label={entry.name}
                tags={entry.tags}
                projectName={projectName}
                disabled={assigning}
                onAssign={() => handleAssign(entry.path)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Binned transitions */}
      {binTransitions.length > 0 && (
        <div>
          <div className="text-[10px] text-red-400/60 uppercase tracking-wider mb-1">
            Deleted Transitions ({binTransitions.length})
          </div>
          <div className="grid grid-cols-2 gap-1">
            {binTransitions.map((entry) => (
              <BrowseVideoCard
                key={entry.id}
                path={`selected_transitions/${entry.id}_slot_0.mp4`}
                label={`${entry.id} (${entry.from}→${entry.to})`}
                projectName={projectName}
                disabled={assigning}
                onAssign={() => handleAssign(`selected_transitions/${entry.id}_slot_0.mp4`)}
              />
            ))}
          </div>
        </div>
      )}

      {poolSegments.length === 0 && binTransitions.length === 0 && (
        <div className="p-4 text-center text-sm text-gray-600">No videos available</div>
      )}
    </div>
  )
}

function BrowseVideoCard({ path, label, tags, projectName, disabled, onAssign }: {
  path: string; label: string; tags?: string[]; projectName: string; disabled: boolean; onAssign: () => void
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => browseBlobCache.get(path) ?? null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [hovered, setHovered] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const url = beatlabFileUrl(projectName, path)

  useEffect(() => {
    if (!hovered || blobUrl || loading || failed) return
    setLoading(true)
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`)
        return res.blob()
      })
      .then((blob) => {
        const bu = URL.createObjectURL(blob)
        browseBlobCache.set(path, bu)
        setBlobUrl(bu)
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }, [hovered, blobUrl, loading, failed, url, path])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (hovered) el.play().catch(() => {})
    else { el.pause(); el.currentTime = 0 }
  }, [hovered, blobUrl])

  return (
    <div
      className={`relative rounded overflow-hidden bg-gray-800 group cursor-pointer border-2 border-transparent hover:border-green-500 transition-colors ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onAssign}
    >
      {blobUrl ? (
        <video
          ref={videoRef}
          src={blobUrl}
          className="w-full aspect-video object-cover"
          muted loop playsInline preload="metadata"
        />
      ) : (
        <div className="w-full aspect-video flex items-center justify-center">
          <span className={`text-[9px] font-mono ${failed ? 'text-red-500' : 'text-gray-500'}`}>{loading ? '...' : failed ? 'Failed to load' : label.slice(0, 20)}</span>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1 py-0.5">
        <div className="text-[7px] text-gray-300 truncate">{label}</div>
        {tags && tags.length > 0 && (
          <div className="flex flex-wrap gap-0.5 mt-0.5">
            {tags.map((tag) => (
              <span key={tag} className="text-[7px] bg-blue-900/60 text-blue-300 px-1 rounded">{tag}</span>
            ))}
          </div>
        )}
      </div>
      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="text-xs bg-green-600/90 text-white px-2 py-1 rounded">Assign</span>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{label}</div>
      <div className="text-sm text-gray-300">{value}</div>
    </div>
  )
}
