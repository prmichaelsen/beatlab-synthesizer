import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react'
import { VirtuosoGrid } from 'react-virtuoso'
import { getBin, restoreKeyframe, restoreTransition } from '@/routes/project/$name/editor'
import { beatlabFileUrl, beatlabThumbUrl, fetchWatchedFolders, postUnwatchFolder, fetchPool, postUpdatePoolTags, fetchUnselectedCandidates, fetchVideoCandidates, type PoolEntry, type UnselectedCandidate } from '@/lib/beatlab-client'
import type { BinEntry, TransitionBinEntry } from '@/lib/beatlab-client'
import { useBeatlabSocket } from '@/hooks/useBeatlabSocket'

export type PoolSelection = {
  type: 'keyframe' | 'segment'
  entry: PoolEntry
}

type ActiveKeyframe = { id: string; timestamp: string; section: string; prompt: string; hasSelectedImage: boolean }
type ActiveTransition = { id: string; from: string; to: string; durationSeconds: number; hasSelectedVideo: boolean }

type BinPanelProps = {
  projectName: string
  onClose: () => void
  onRestore: () => void
  onPoolSelect: (selection: PoolSelection | null) => void
  onInsertPoolItem: (selection: PoolSelection, mode: 'at-playhead' | 'after-current-kf' | 'overwrite-current') => void
  poolSelection: PoolSelection | null
  activeKeyframes: ActiveKeyframe[]
  activeTransitions: ActiveTransition[]
  onHoverPreview?: (url: string | null) => void
  onHoverBinTransition?: (entry: TransitionBinEntry | null) => void
}

const PANEL_STORAGE_KEY = 'beatlab-side-panel-width'
const PANEL_DEFAULT = 360
const PANEL_MIN = 240

function BinVideoPreview({ projectName, transitionId, videoPath }: { projectName: string; transitionId: string; videoPath?: string }) {
  const [failed, setFailed] = useState(false)
  const src = beatlabFileUrl(projectName, videoPath || `selected_transitions/${transitionId}_slot_0.mp4`)
  if (failed) {
    return <div className="w-full aspect-video bg-gray-800 flex items-center justify-center"><span className="text-[9px] text-gray-600">No video</span></div>
  }
  return (
    <video
      src={src}
      className="w-full aspect-video object-cover"
      muted loop playsInline preload="none"
      onMouseEnter={(e) => { const v = e.currentTarget as HTMLVideoElement; v.preload = 'metadata'; v.play().catch(() => {}) }}
      onMouseLeave={(e) => { const v = e.currentTarget as HTMLVideoElement; v.pause(); v.currentTime = 0 }}
      onError={() => setFailed(true)}
    />
  )
}

export function BinPanel({ projectName, onClose, onRestore, onPoolSelect, onInsertPoolItem, poolSelection, activeKeyframes, activeTransitions, onHoverPreview, onHoverBinTransition }: BinPanelProps) {
  const [panelWidth, setPanelWidth] = useState(() => {
    if (typeof window === 'undefined') return PANEL_DEFAULT
    const stored = localStorage.getItem(PANEL_STORAGE_KEY)
    return stored ? Math.max(PANEL_MIN, parseInt(stored, 10)) : PANEL_DEFAULT
  })
  const panelDragging = useRef(false)
  const panelStartX = useRef(0)
  const panelStartW = useRef(0)

  const handlePanelDragDown = useCallback((e: React.MouseEvent) => {
    panelDragging.current = true
    panelStartX.current = e.clientX
    panelStartW.current = panelWidth
    e.preventDefault()
  }, [panelWidth])

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!panelDragging.current) return
      const delta = panelStartX.current - e.clientX
      setPanelWidth(Math.max(PANEL_MIN, panelStartW.current + delta))
    }
    const up = () => {
      if (panelDragging.current) {
        panelDragging.current = false
        localStorage.setItem(PANEL_STORAGE_KEY, String(panelWidth))
      }
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
  }, [panelWidth])

  useEffect(() => { localStorage.setItem(PANEL_STORAGE_KEY, String(panelWidth)) }, [panelWidth])

  const socket = useBeatlabSocket()
  const [keyframeEntries, setKeyframeEntries] = useState<BinEntry[]>([])
  const [transitionEntries, setTransitionEntries] = useState<TransitionBinEntry[]>([])
  const [poolKeyframes, setPoolKeyframes] = useState<PoolEntry[]>([])
  const [poolSegments, setPoolSegments] = useState<PoolEntry[]>([])
  const [watchedFolders, setWatchedFolders] = useState<string[]>([])
  const [unselectedCandidates, setUnselectedCandidates] = useState<UnselectedCandidate[]>([])
  const [videoCandidates, setVideoCandidates] = useState<import('@/lib/beatlab-client').VideoCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'keyframes' | 'transitions' | 'pool' | 'candidates' | 'videos'>('keyframes')
  const [kfSubTab, setKfSubTab] = useState<'active' | 'bin'>('active')
  const [trSubTab, setTrSubTab] = useState<'active' | 'bin'>('active')
  const scrollPositions = useRef<Record<string, number>>(
    typeof window !== 'undefined' ? (() => { try { return JSON.parse(localStorage.getItem('beatlab-bin-scroll') || '{}') } catch { return {} } })() : {}
  )
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const loadBin = useCallback(async () => {
    setLoading(true)
    try {
      const [binData, watchData, poolData, candData, vidCandData] = await Promise.all([
        getBin({ data: { projectName } }).catch(() => ({ bin: [], transitionBin: [] })),
        fetchWatchedFolders(projectName).catch(() => ({ watchedFolders: [] })),
        fetchPool(projectName).catch(() => ({ keyframes: [], segments: [] })),
        fetchUnselectedCandidates(projectName).catch(() => []),
        fetchVideoCandidates(projectName).catch(() => []),
      ])
      setKeyframeEntries(binData.bin || [])
      setTransitionEntries(binData.transitionBin || [])
      setWatchedFolders(watchData.watchedFolders || [])
      setPoolKeyframes(poolData.keyframes || [])
      setPoolSegments(poolData.segments || [])
      setUnselectedCandidates(candData)
      setVideoCandidates(vidCandData)

      // Background preload thumbnails into IndexedDB
      const thumbUrls = [
        ...(poolData.keyframes || []).map((e: PoolEntry) => beatlabFileUrl(projectName, e.path)),
        ...(candData || []).map((c: UnselectedCandidate) => beatlabFileUrl(projectName, c.path)),
      ]
      preloadThumbs(thumbUrls)
    } finally {
      setLoading(false)
    }
  }, [projectName])

  useEffect(() => { loadBin() }, [loadBin])


  // Restore scroll position after loading completes and content renders
  useEffect(() => {
    if (loading) return
    // Double rAF: first fires after React commits, second after browser paints
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollPositions.current[tab] || 0
        }
      })
    })
  }, [loading, tab])

  const handleUnwatch = useCallback(async (folderPath: string) => {
    await postUnwatchFolder(projectName, folderPath)
    setWatchedFolders((prev) => prev.filter((p) => p !== folderPath))
  }, [projectName])

  // Auto-refresh bin when folder watcher imports new files
  useEffect(() => {
    return socket.subscribeAll((msg) => {
      if ('type' in msg && (msg as { type: string }).type === 'folder_import') {
        loadBin()
      }
    })
  }, [socket, loadBin])

  const handleRestoreKeyframe = useCallback(async (id: string) => {
    await restoreKeyframe({ data: { projectName, keyframeId: id } })
    setKeyframeEntries((prev) => prev.filter((e) => e.id !== id))
    onRestore()
  }, [projectName, onRestore])

  const handleRestoreTransition = useCallback(async (id: string) => {
    await restoreTransition({ data: { projectName, transitionId: id } })
    setTransitionEntries((prev) => prev.filter((e) => e.id !== id))
    onRestore()
  }, [projectName, onRestore])

  const [sortBy, setSortBy] = useState<'timeline' | 'recent' | 'oldest'>('timeline')

  const parseTs = (ts: string) => {
    const parts = ts.split(':')
    if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseFloat(parts[1])
    return parseFloat(ts) || 0
  }
  const idNum = (id: string) => parseInt(id.replace(/\D/g, '') || '0', 10)
  // Build a map from keyframe ID to timeline position for transition sorting
  const kfTimeMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const kf of activeKeyframes) m.set(kf.id, parseTs(kf.timestamp))
    for (const kf of keyframeEntries) m.set(kf.id, parseTs(kf.timestamp))
    return m
  }, [activeKeyframes, keyframeEntries])
  const sortItems = <T extends { id: string }>(items: T[]) => {
    if (sortBy === 'recent') return [...items].sort((a, b) => (b.modified ?? idNum(b.id)) - (a.modified ?? idNum(a.id)))
    if (sortBy === 'oldest') return [...items].sort((a, b) => (a.modified ?? idNum(a.id)) - (b.modified ?? idNum(b.id)))
    // Timeline sort: by timestamp for keyframes, by from-kf timestamp for transitions
    return [...items].sort((a, b) => {
      const aTs = 'timestamp' in a ? parseTs((a as { timestamp: string }).timestamp) : ('from' in a ? (kfTimeMap.get((a as { from: string }).from) ?? 0) : 0)
      const bTs = 'timestamp' in b ? parseTs((b as { timestamp: string }).timestamp) : ('from' in b ? (kfTimeMap.get((b as { from: string }).from) ?? 0) : 0)
      return aTs - bTs
    })
  }
  const sortByName = <T extends { name: string }>(items: T[]) => {
    if (sortBy === 'recent') return [...items].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))
    if (sortBy === 'oldest') return [...items].sort((a, b) => a.name.localeCompare(b.name))
    return items
  }
  const [poolTagFilter, setPoolTagFilter] = useState('')

  const handleUpdatePoolTags = useCallback(async (entry: PoolEntry, newTags: string[]) => {
    entry.tags = newTags
    // Update in both lists
    setPoolKeyframes((prev) => prev.map((e) => e.path === entry.path ? { ...e, tags: newTags } : e))
    setPoolSegments((prev) => prev.map((e) => e.path === entry.path ? { ...e, tags: newTags } : e))
    try {
      await postUpdatePoolTags(projectName, entry.path, newTags)
    } catch (e) {
      console.error('Failed to update pool tags:', e)
    }
  }, [projectName])

  const allPoolTags = useMemo(() => {
    const tags = new Set<string>()
    for (const e of [...poolKeyframes, ...poolSegments]) {
      for (const t of e.tags || []) tags.add(t)
    }
    return [...tags].sort()
  }, [poolKeyframes, poolSegments])

  const filterByTag = useCallback(<T extends PoolEntry>(items: T[]) => {
    if (!poolTagFilter) return items
    return items.filter((e) => e.tags?.includes(poolTagFilter))
  }, [poolTagFilter])

  const allKfCount = activeKeyframes.length + keyframeEntries.length
  const allTrCount = activeTransitions.length + transitionEntries.length
  const poolCount = poolKeyframes.length + poolSegments.length

  return (
    <div className="relative flex shrink-0" style={{ width: panelWidth }}>
      {/* Drag handle */}
      <div
        className="w-1 cursor-col-resize hover:bg-blue-500/50 active:bg-blue-500 transition-colors shrink-0"
        onMouseDown={handlePanelDragDown}
      />
      <div className="flex-1 bg-gray-900 border-l border-gray-800 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Bin</span>
          <button
            onClick={() => setSortBy((s) => s === 'timeline' ? 'recent' : s === 'recent' ? 'oldest' : 'timeline')}
            className="text-[9px] text-gray-500 hover:text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded transition-colors"
            title={`Sort: ${sortBy}`}
          >{sortBy === 'timeline' ? '⏱ Timeline' : sortBy === 'recent' ? '↓ Newest' : '↑ Oldest'}</button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => loadBin()}
            className="text-xs text-green-500 hover:text-green-400 transition-colors px-1"
            title="Refresh bin/pool data"
          >
            ↻ Refresh
          </button>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-lg leading-none"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Watched folders */}
      {watchedFolders.length > 0 && (
        <div className="px-3 py-2 border-b border-gray-800 shrink-0 space-y-1">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Watching</div>
          {watchedFolders.map((folder) => (
            <div key={folder} className="flex items-center justify-between text-[10px]">
              <span className="text-green-400 truncate flex-1" title={folder}>{folder || '/'}</span>
              <button
                onClick={() => handleUnwatch(folder)}
                className="text-red-400/60 hover:text-red-400 ml-2 shrink-0"
              >
                stop
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-gray-800 shrink-0">
        {(['keyframes', 'transitions', 'pool', 'candidates', 'videos'] as const).map((t) => {
          const candCount = unselectedCandidates.length
          const vidCount = videoCandidates.length
          const label = t === 'keyframes' ? `KFs${allKfCount > 0 ? ` (${allKfCount})` : ''}` : t === 'transitions' ? `TRs${allTrCount > 0 ? ` (${allTrCount})` : ''}` : t === 'pool' ? `Pool${poolCount > 0 ? ` (${poolCount})` : ''}` : t === 'candidates' ? `Cands${candCount > 0 ? ` (${candCount})` : ''}` : `Vids${vidCount > 0 ? ` (${vidCount})` : ''}`
          const color = t === 'keyframes' ? 'blue' : t === 'transitions' ? 'orange' : t === 'pool' ? 'green' : t === 'candidates' ? 'purple' : 'cyan'
          return (
            <button
              key={t}
              onClick={() => {
                // Save current scroll position before switching
                if (scrollContainerRef.current) {
                  scrollPositions.current[tab] = scrollContainerRef.current.scrollTop
                  localStorage.setItem('beatlab-bin-scroll', JSON.stringify(scrollPositions.current))
                }
                setTab(t)
                // Restore scroll position after render
                requestAnimationFrame(() => { if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = scrollPositions.current[t] || 0 })
              }}
              className={`flex-1 text-xs py-2 transition-colors ${tab === t ? `text-gray-200 border-b-2 border-${color}-500` : 'text-gray-500 hover:text-gray-400'}`}
            >{label}</button>
          )
        })}
      </div>

      {/* Sort toggle */}
      <div className="flex items-center justify-end px-2 py-1 border-b border-gray-800 shrink-0">
        <button
          onClick={() => setSortBy((s) => s === 'timeline' ? 'recent' : s === 'recent' ? 'oldest' : 'timeline')}
          className="text-[9px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          Sort: {sortBy === 'timeline' ? 'Timeline' : 'Recent'}
        </button>
      </div>

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto" onScroll={(e) => { scrollPositions.current[tab] = e.currentTarget.scrollTop }}>
        {loading ? (
          <div className="p-4 text-center text-sm text-gray-600">Loading...</div>
        ) : tab === 'keyframes' ? (
          <div className="flex flex-col h-full">
            <div className="flex border-b border-gray-800 shrink-0">
              <button onClick={() => setKfSubTab('active')} className={`flex-1 text-[10px] py-1.5 ${kfSubTab === 'active' ? 'text-gray-200 border-b border-blue-500' : 'text-gray-500'}`}>Active ({activeKeyframes.length})</button>
              <button onClick={() => setKfSubTab('bin')} className={`flex-1 text-[10px] py-1.5 ${kfSubTab === 'bin' ? 'text-gray-200 border-b border-red-500' : 'text-gray-500'}`}>Bin ({keyframeEntries.length})</button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {kfSubTab === 'active' ? (
                activeKeyframes.length === 0 ? <div className="text-center text-sm text-gray-600 py-4">No keyframes</div> : (
                  <div className="grid grid-cols-3 gap-1">
                    {sortItems(activeKeyframes).map((kf) => (
                      <div
                        key={kf.id}
                        className="relative group rounded overflow-hidden cursor-grab active:cursor-grabbing"
                        draggable={kf.hasSelectedImage}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('application/x-beatlab-pool-path', `selected_keyframes/${kf.id}.png`)
                          e.dataTransfer.effectAllowed = 'copy'
                        }}
                        onMouseEnter={() => kf.hasSelectedImage && onHoverPreview?.(beatlabFileUrl(projectName, `selected_keyframes/${kf.id}.png?v=${kf.selected ?? 0}`))}
                        onMouseLeave={() => onHoverPreview?.(null)}
                      >
                        {kf.hasSelectedImage ? (
                          <img src={beatlabFileUrl(projectName, `selected_keyframes/${kf.id}.png`)} alt={kf.id} className="w-full aspect-video object-cover pointer-events-none" draggable={false} loading="lazy" />
                        ) : (
                          <div className="w-full aspect-video bg-gray-800 flex items-center justify-center"><span className="text-[8px] text-gray-600">{kf.id}</span></div>
                        )}
                        <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <div className="text-[7px] text-gray-300 truncate">{kf.id} @ {kf.timestamp}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                keyframeEntries.length === 0 ? <div className="text-center text-sm text-gray-600 py-4">Bin empty</div> : (
                  <div className="grid grid-cols-3 gap-1">
                    {sortItems(keyframeEntries).map((entry) => (
                      <div
                        key={entry.id}
                        className="relative group rounded overflow-hidden opacity-60 hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('application/x-beatlab-bin-kf', entry.id)
                          if (entry.hasSelectedImage) e.dataTransfer.setData('application/x-beatlab-pool-path', `selected_keyframes/${entry.id}.png`)
                          e.dataTransfer.effectAllowed = 'copy'
                        }}
                        onClick={() => handleRestoreKeyframe(entry.id)}
                        onMouseEnter={() => entry.hasSelectedImage && onHoverPreview?.(beatlabFileUrl(projectName, `selected_keyframes/${entry.id}.png`))}
                        onMouseLeave={() => onHoverPreview?.(null)}
                      >
                        {entry.hasSelectedImage ? (
                          <img src={beatlabFileUrl(projectName, `selected_keyframes/${entry.id}.png`)} alt={entry.id} className="w-full aspect-video object-cover pointer-events-none" draggable={false} loading="lazy" />
                        ) : (
                          <div className="w-full aspect-video bg-gray-800 flex items-center justify-center"><span className="text-[8px] text-gray-600">{entry.id}</span></div>
                        )}
                        <div className="absolute bottom-0 left-0 right-0 bg-red-900/70 px-1 py-0.5">
                          <div className="text-[7px] text-red-300 truncate">{entry.id} — click to restore</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </div>
        ) : tab === 'transitions' ? (
          <div className="flex flex-col h-full">
            <div className="flex border-b border-gray-800 shrink-0">
              <button onClick={() => setTrSubTab('active')} className={`flex-1 text-[10px] py-1.5 ${trSubTab === 'active' ? 'text-gray-200 border-b border-orange-500' : 'text-gray-500'}`}>Active ({activeTransitions.length})</button>
              <button onClick={() => setTrSubTab('bin')} className={`flex-1 text-[10px] py-1.5 ${trSubTab === 'bin' ? 'text-gray-200 border-b border-red-500' : 'text-gray-500'}`}>Bin ({transitionEntries.length})</button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {trSubTab === 'active' ? (
                activeTransitions.length === 0 ? <div className="text-center text-sm text-gray-600 py-4">No transitions</div> : (
                  <>
                    <div className="grid grid-cols-2 gap-1">
                      {sortItems(activeTransitions.filter((tr) => tr.hasSelectedVideo)).map((tr) => (
                        <PoolVideoCard
                          key={tr.id}
                          entry={{ name: `${tr.id} (${tr.from}→${tr.to})`, path: `selected_transitions/${tr.id}_slot_0.mp4`, size: 0 }}
                          projectName={projectName}
                          isSelected={false}
                          onSelect={() => {}}
                          draggable
                        />
                      ))}
                    </div>
                    {activeTransitions.filter((tr) => !tr.hasSelectedVideo).length > 0 && (
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-2">No Video</div>
                    )}
                    {sortItems(activeTransitions.filter((tr) => !tr.hasSelectedVideo)).map((tr) => (
                      <div key={tr.id} className="px-2 py-1 bg-gray-800/30 rounded text-[10px] text-gray-500">
                        {tr.id}: {tr.from} → {tr.to} ({tr.durationSeconds.toFixed(1)}s)
                      </div>
                    ))}
                  </>
                )
              ) : (
                transitionEntries.length === 0 ? <div className="text-center text-sm text-gray-600 py-4">Bin empty</div> : (
                  <VirtuosoGrid
                    data={sortItems(transitionEntries)}
                    listClassName="grid grid-cols-2 gap-1 p-1"
                    itemClassName=""
                    itemContent={(_index, entry) => (
                      <div
                        className="relative group rounded overflow-hidden border border-red-900/30 hover:border-red-500/50 cursor-pointer transition-colors"
                        onMouseEnter={() => onHoverBinTransition?.(entry)}
                        onMouseLeave={() => onHoverBinTransition?.(null)}
                      >
                        <BinVideoPreview projectName={projectName} transitionId={entry.id} />
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] text-gray-300 font-mono">{entry.id}</span>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRestoreTransition(entry.id) }}
                                className="text-[8px] text-green-400/70 hover:text-green-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                title="Restore to timeline"
                              >
                                restore
                              </button>
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation()
                                  const { postAddToBench } = await import('@/lib/beatlab-client')
                                  await postAddToBench(projectName, 'transition', entry.id)
                                }}
                                className="text-[8px] text-cyan-400/60 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                title="Add to bench"
                              >
                                bench
                              </button>
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation()
                                  const url = `${import.meta.env.VITE_BEATLAB_API_URL || 'http://localhost:8888'}/api/projects/${encodeURIComponent(projectName)}/pool/add`
                                  await fetch(url, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ sourcePath: `selected_transitions/${entry.id}_slot_0.mp4`, type: 'transition' }),
                                  })
                                }}
                                className="text-[8px] text-purple-400/60 hover:text-purple-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                title="Add to pool"
                              >
                                pool
                              </button>
                            </div>
                          </div>
                          <div className="text-[8px] text-gray-500">{entry.from} → {entry.to} ({entry.durationSeconds.toFixed(1)}s)</div>
                        </div>
                      </div>
                    )}
                    style={{ height: '100%' }}
                  />
                )
              )}
            </div>
          </div>
        ) : tab === 'candidates' ? (
          unselectedCandidates.length === 0 ? (
            <div className="p-4 text-center text-sm text-gray-600">No unselected candidates</div>
          ) : (
            <div className="p-2">
              <div className="grid grid-cols-3 gap-1">
                {(sortBy === 'recent' ? [...unselectedCandidates].sort((a, b) => idNum(b.keyframeId) - idNum(a.keyframeId)) : unselectedCandidates).map((c) => (
                  <div
                    key={`${c.keyframeId}-v${c.variant}`}
                    className="relative group rounded overflow-hidden cursor-grab active:cursor-grabbing"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/x-beatlab-pool-path', c.path)
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    onMouseEnter={() => onHoverPreview?.(beatlabFileUrl(projectName, c.path))}
                    onMouseLeave={() => onHoverPreview?.(null)}
                  >
                    <img
                      src={beatlabFileUrl(projectName, c.path)}
                      alt={`${c.keyframeId} v${c.variant}`}
                      className="w-full aspect-video object-cover pointer-events-none"
                      loading="lazy"
                      draggable={false}
                    />
                    <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-between">
                      <div className="text-[7px] text-gray-300 truncate">{c.keyframeId} v{c.variant}</div>
                      <div className="flex gap-1">
                        <button
                          onClick={async (e) => {
                            e.stopPropagation()
                            const { postSelectKeyframes } = await import('@/lib/beatlab-client')
                            await postSelectKeyframes(projectName, { [c.keyframeId]: c.variant })
                            onRestore?.()
                          }}
                          className="text-[7px] text-blue-400 hover:text-blue-300"
                          title="Set as selected still for this keyframe"
                        >
                          Still
                        </button>
                        <button
                          onClick={async (e) => {
                            e.stopPropagation()
                            const { postAddToBench } = await import('@/lib/beatlab-client')
                            await postAddToBench(projectName, 'keyframe', c.keyframeId, c.path)
                          }}
                          className="text-[7px] text-green-400 hover:text-green-300"
                          title="Add to bench"
                        >
                          Bench
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        ) : tab === 'videos' ? (
          videoCandidates.length === 0 ? (
            <div className="p-4 text-center text-sm text-gray-600">No video candidates</div>
          ) : (
            <VirtuosoGrid
              data={videoCandidates}
              listClassName="grid grid-cols-2 gap-1 p-1"
              itemClassName=""
              itemContent={(_index, vc) => (
                <div
                  className="relative group rounded overflow-hidden cursor-pointer transition-colors border border-transparent hover:border-gray-600"
                >
                  <BinVideoPreview projectName={projectName} transitionId={vc.transitionId} videoPath={vc.path} />
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-gray-300 font-mono">{vc.transitionId} v{vc.variant}</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={async (e) => {
                            e.stopPropagation()
                            const { postAddToBench } = await import('@/lib/beatlab-client')
                            await postAddToBench(projectName, 'transition', undefined, vc.path)
                          }}
                          className="text-[8px] text-cyan-400/60 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Add to bench"
                        >
                          bench
                        </button>
                        <button
                          onClick={async (e) => {
                            e.stopPropagation()
                            const url = `${import.meta.env.VITE_BEATLAB_API_URL || 'http://localhost:8888'}/api/projects/${encodeURIComponent(projectName)}/pool/add`
                            await fetch(url, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ sourcePath: vc.path, type: 'transition' }),
                            })
                          }}
                          className="text-[8px] text-purple-400/60 hover:text-purple-400 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Add to pool"
                        >
                          pool
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              style={{ height: '100%' }}
            />
          )
        ) : (
          /* Pool tab */
          poolCount === 0 ? (
            <div className="p-4 text-center text-sm text-gray-600">Pool is empty</div>
          ) : (
            <div className="space-y-3 p-2">
              {/* Tag filter */}
              {allPoolTags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  <button
                    onClick={() => setPoolTagFilter('')}
                    className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${!poolTagFilter ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
                  >
                    All
                  </button>
                  {allPoolTags.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => setPoolTagFilter(poolTagFilter === tag ? '' : tag)}
                      className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${poolTagFilter === tag ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
              {poolKeyframes.length > 0 && (
                <div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                    Keyframe Images ({filterByTag(poolKeyframes).length})
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {sortByName(filterByTag(poolKeyframes)).map((entry) => {
                      const isSelected = poolSelection?.type === 'keyframe' && poolSelection.entry.name === entry.name
                      return (
                        <PoolItemWithTags
                          key={entry.name}
                          entry={entry}
                          isSelected={isSelected}
                          onSelect={() => onPoolSelect(isSelected ? null : { type: 'keyframe', entry })}
                          onUpdateTags={(tags) => handleUpdatePoolTags(entry, tags)}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('application/x-beatlab-pool-path', entry.path)
                            e.dataTransfer.effectAllowed = 'copy'
                          }}
                          onMouseEnter={() => onHoverPreview?.(beatlabFileUrl(projectName, entry.path))}
                          onMouseLeave={() => onHoverPreview?.(null)}
                        >
                          <img
                            src={beatlabFileUrl(projectName, entry.path)}
                            alt={entry.name}
                            className="w-full aspect-video object-cover"
                            loading="lazy"
                            draggable={false}
                          />
                        </PoolItemWithTags>
                      )
                    })}
                  </div>
                </div>
              )}
              {poolSegments.length > 0 && (
                <div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                    Video Segments ({filterByTag(poolSegments).length})
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {sortByName(filterByTag(poolSegments)).map((entry) => (
                      <PoolVideoCard
                        key={entry.name}
                        entry={entry}
                        projectName={projectName}
                        isSelected={poolSelection?.type === 'segment' && poolSelection.entry.name === entry.name}
                        onSelect={() => onPoolSelect(
                          poolSelection?.type === 'segment' && poolSelection.entry.name === entry.name
                            ? null : { type: 'segment', entry }
                        )}
                        onUpdateTags={(tags) => handleUpdatePoolTags(entry, tags)}
                        draggable
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Insert buttons — only shown when a pool item is selected */}
              {poolSelection && (
                <div className="sticky bottom-0 bg-gray-900 border-t border-gray-800 p-2">
                  <div className="text-[9px] text-gray-500 text-center">Drag items onto the timeline to assign</div>
                </div>
              )}
            </div>
          )
        )}
      </div>
      </div>
    </div>
  )
}

// Thumbnail cache: memory + IndexedDB, background preloading
const thumbMemCache = new Map<string, string>() // url → objectURL
const THUMB_DB = 'beatlab-thumb-cache'
const THUMB_STORE = 'thumbs'

function openThumbDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(THUMB_DB, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(THUMB_STORE)) req.result.createObjectStore(THUMB_STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function getOrFetchThumb(url: string): Promise<string> {
  if (thumbMemCache.has(url)) return thumbMemCache.get(url)!
  try {
    const db = await openThumbDb()
    const cached: Blob | null = await new Promise((resolve) => {
      const req = db.transaction(THUMB_STORE, 'readonly').objectStore(THUMB_STORE).get(url)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    })
    if (cached) {
      const blobUrl = URL.createObjectURL(cached)
      thumbMemCache.set(url, blobUrl)
      return blobUrl
    }
  } catch {}
  // Network fetch + persist
  const res = await fetch(url)
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  thumbMemCache.set(url, blobUrl)
  try { const db = await openThumbDb(); db.transaction(THUMB_STORE, 'readwrite').objectStore(THUMB_STORE).put(blob, url) } catch {}
  return blobUrl
}

/** Preload a batch of thumbnail URLs in the background. */
async function preloadThumbs(urls: string[]) {
  const BATCH = 20
  for (let i = 0; i < urls.length; i += BATCH) {
    await Promise.all(urls.slice(i, i + BATCH).map((u) => getOrFetchThumb(u).catch(() => {})))
  }
}

/** Hook: returns a cached blob URL for a thumbnail, fetching if needed. */
function useCachedThumb(url: string | null): string {
  const [blobUrl, setBlobUrl] = useState(() => (url && thumbMemCache.get(url)) || '')
  useEffect(() => {
    if (!url) { setBlobUrl(''); return }
    if (thumbMemCache.has(url)) { setBlobUrl(thumbMemCache.get(url)!); return }
    let cancelled = false
    getOrFetchThumb(url).then((u) => { if (!cancelled) setBlobUrl(u) }).catch(() => {})
    return () => { cancelled = true }
  }, [url])
  return blobUrl
}

// Pool blob cache: in-memory + IndexedDB persistence
const poolBlobCache = new Map<string, string>()
const POOL_DB_NAME = 'beatlab-pool-cache'
const POOL_STORE = 'blobs'

function openPoolDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(POOL_DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(POOL_STORE)) db.createObjectStore(POOL_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function getPoolBlob(key: string): Promise<Blob | null> {
  try {
    const db = await openPoolDb()
    return new Promise((resolve) => {
      const tx = db.transaction(POOL_STORE, 'readonly')
      const req = tx.objectStore(POOL_STORE).get(key)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

async function putPoolBlob(key: string, blob: Blob): Promise<void> {
  try {
    const db = await openPoolDb()
    const tx = db.transaction(POOL_STORE, 'readwrite')
    tx.objectStore(POOL_STORE).put(blob, key)
  } catch {}
}

async function loadPoolBlobUrl(path: string, fetchUrl: string): Promise<string> {
  // In-memory hit
  if (poolBlobCache.has(path)) return poolBlobCache.get(path)!

  // IndexedDB hit
  const cached = await getPoolBlob(path)
  if (cached) {
    const bu = URL.createObjectURL(cached)
    poolBlobCache.set(path, bu)
    return bu
  }

  // Network fetch + persist
  const res = await fetch(fetchUrl)
  const blob = await res.blob()
  const bu = URL.createObjectURL(blob)
  poolBlobCache.set(path, bu)
  putPoolBlob(path, blob) // fire and forget
  return bu
}

function PoolTagEditor({ tags, onUpdateTags }: { tags: string[]; onUpdateTags: (tags: string[]) => void }) {
  const [adding, setAdding] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  const handleAdd = () => {
    const tag = inputValue.trim().toLowerCase()
    if (tag && !tags.includes(tag)) {
      onUpdateTags([...tags, tag])
    }
    setInputValue('')
    setAdding(false)
  }

  return (
    <div className="flex flex-wrap gap-0.5 mt-0.5" onClick={(e) => e.stopPropagation()}>
      {tags.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-0.5 text-[7px] bg-blue-900/60 text-blue-300 px-1 py-0 rounded">
          {tag}
          <button
            onClick={() => onUpdateTags(tags.filter((t) => t !== tag))}
            className="text-blue-400/60 hover:text-blue-300 leading-none"
          >&times;</button>
        </span>
      ))}
      {adding ? (
        <input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
            if (e.key === 'Escape') { setAdding(false); setInputValue('') }
          }}
          onBlur={handleAdd}
          className="text-[7px] bg-gray-800 text-gray-300 px-1 py-0 rounded border border-gray-600 outline-none w-12"
          placeholder="tag"
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="text-[7px] text-gray-600 hover:text-gray-400 px-0.5"
          title="Add tag"
        >+</button>
      )}
    </div>
  )
}

function PoolItemWithTags({ entry, isSelected, onSelect, onUpdateTags, children, draggable: isDraggable, onDragStart, onMouseEnter, onMouseLeave }: {
  entry: PoolEntry; isSelected: boolean; onSelect: () => void; onUpdateTags: (tags: string[]) => void; children: ReactNode; draggable?: boolean; onDragStart?: (e: React.DragEvent) => void; onMouseEnter?: () => void; onMouseLeave?: () => void
}) {
  return (
    <div
      className={`relative group cursor-pointer rounded overflow-hidden border-2 transition-colors ${isSelected ? 'border-blue-500' : 'border-transparent hover:border-gray-600'}`}
      onClick={onSelect}
      draggable={isDraggable}
      onDragStart={onDragStart}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
      <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5">
        <div className="text-[7px] text-gray-300 truncate">{entry.name}</div>
        <PoolTagEditor tags={entry.tags || []} onUpdateTags={onUpdateTags} />
      </div>
    </div>
  )
}

function PoolVideoCard({ entry, projectName, isSelected, onSelect, onUpdateTags, draggable }: { entry: PoolEntry; projectName: string; isSelected: boolean; onSelect: () => void; onUpdateTags?: (tags: string[]) => void; draggable?: boolean }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => poolBlobCache.get(entry.path) ?? null)
  const [loading, setLoading] = useState(false)
  const [hovered, setHovered] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const url = beatlabFileUrl(projectName, entry.path)

  // Lazy-load blob on first hover (checks IndexedDB before network)
  useEffect(() => {
    if (!hovered || blobUrl || loading) return
    setLoading(true)
    loadPoolBlobUrl(entry.path, url)
      .then((bu) => setBlobUrl(bu))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [hovered, blobUrl, loading, url, entry.path])

  // Play/pause on hover
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (hovered) el.play().catch(() => {})
    else { el.pause(); el.currentTime = 0 }
  }, [hovered, blobUrl])

  return (
    <div
      className={`relative rounded overflow-hidden bg-gray-800 group cursor-pointer border-2 transition-colors ${isSelected ? 'border-orange-500' : 'border-transparent hover:border-gray-600'}`}
      draggable={!!draggable}
      onDragStart={draggable ? (e) => {
        e.dataTransfer.setData('application/x-beatlab-pool-path', entry.path)
        e.dataTransfer.effectAllowed = 'copy'
        // Position drag preview bottom-right of cursor
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
      } : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
    >
      {blobUrl ? (
        <video
          ref={videoRef}
          src={blobUrl}
          className="w-full aspect-video object-cover"
          muted
          loop
          playsInline
          preload="metadata"
        />
      ) : (
        <div className="w-full aspect-video flex items-center justify-center">
          <span className="text-[9px] text-gray-500 font-mono">{loading ? '...' : entry.name.replace(/\.\w+$/, '')}</span>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1 py-0.5">
        <div className="text-[7px] text-gray-300 truncate">{entry.name}</div>
        {onUpdateTags && <PoolTagEditor tags={entry.tags || []} onUpdateTags={onUpdateTags} />}
      </div>
    </div>
  )
}

