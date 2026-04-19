/**
 * Two-tier frame cache for transition video playback:
 * - In-memory: Map<key, ImageBitmap[]> for the render loop
 * - IndexedDB: persists decoded frames across page reloads
 */

const DB_NAME = 'beatlab-frame-cache'
const STORE_NAME = 'frames'
const DB_VERSION = 2 // bumped: keys now include resolution suffix
let PREVIEW_WIDTH = 256
let PREVIEW_HEIGHT = 144
const TARGET_FPS = 24

// Embed resolution in IndexedDB key so different resolutions coexist
function dbKey(key: string): string {
  return `${key}@${PREVIEW_WIDTH}x${PREVIEW_HEIGHT}`
}

let cacheGeneration = 0 // incremented on resolution change to detect stale writes

export function setPreviewResolution(width: number, height: number) {
  if (width === PREVIEW_WIDTH && height === PREVIEW_HEIGHT) return
  PREVIEW_WIDTH = width
  PREVIEW_HEIGHT = height
  cacheGeneration++
  // Flush in-memory cache — bitmaps are resolution-specific
  for (const key of [...memoryCache.keys()]) cacheDelete(key)
  loadingKeys.clear()
  // IndexedDB is NOT cleared — old-resolution entries have different keys
  // and will be ignored. They can be cleaned up later if needed.
}

// ── IndexedDB helpers ─────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('indexedDB unavailable')); return }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME)
      }
      db.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Request persistent storage so browsers don't evict our cache
if (typeof navigator !== 'undefined') {
  navigator.storage?.persist?.().catch(() => {})

  // Pre-populate persistedKeys from IndexedDB so isLoaded() is correct before preloads run
  openDb().then((db) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAllKeys()
    req.onsuccess = () => {
      for (const k of req.result as string[]) {
        const raw = String(k).replace(/@\d+x\d+$/, '')
        persistedKeys.add(raw)
      }
      console.log('[frame-cache] pre-populated', persistedKeys.size, 'persisted keys from IndexedDB')
    }
  }).catch(() => {})
}

async function getFromDb(key: string): Promise<Blob[] | null> {
  const db = await openDb()
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => {
      console.warn('[frame-cache] IndexedDB read failed:', key, req.error)
      resolve(null)
    }
  })
}

async function putToDb(key: string, blobs: Blob[]): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(blobs, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ── Video frame decoder ───────────────────────────────────────────

async function decodeVideoFrames(videoUrl: string, onProgress?: (progress: number) => void): Promise<ImageBitmap[]> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.preload = 'auto'
    video.playsInline = true

    video.onloadedmetadata = async () => {
      const duration = video.duration
      if (!isFinite(duration) || duration <= 0) {
        resolve([])
        return
      }

      // For short clips (< 2s), use playback-based capture instead of seeking.
      // Seeking is disproportionately slow on short clips because each seek
      // re-decodes from the nearest keyframe.
      const SHORT_CLIP_THRESHOLD = 2.0
      const fps = duration < 1.0 ? 12 : TARGET_FPS // lower fps for very short clips
      const frameCount = Math.max(2, Math.ceil(duration * fps))

      const canvas = new OffscreenCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT)
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve([])
        return
      }

      if (duration <= SHORT_CLIP_THRESHOLD && 'requestVideoFrameCallback' in video) {
        // Playback-based capture: play the video and grab frames as they render.
        // Much faster than seeking for short clips.
        //
        // Deterministic variant: track captures *initiated* (not just completed)
        // so async createImageBitmap races can't cause us to over-capture or
        // short-circuit the loop before the final frame is captured. Resolve
        // only after all pending bitmap promises settle.
        const pendingBitmaps: Promise<ImageBitmap>[] = []
        const interval = duration / frameCount
        let nextCapture = 0
        let capturesInitiated = 0
        let resolved = false

        const captureFrame = () => {
          ctx.drawImage(video, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT)
          const p = createImageBitmap(canvas)
          pendingBitmaps.push(p)
          capturesInitiated++
          p.then(() => { onProgress?.(capturesInitiated / frameCount) })
        }

        const finalize = async () => {
          if (resolved) return
          resolved = true
          // If we didn't manage to capture enough frames, grab a final frame
          // from whatever the video currently shows to pad up to frameCount.
          while (capturesInitiated < frameCount) {
            captureFrame()
          }
          const frames = await Promise.all(pendingBitmaps)
          video.src = ''
          resolve(frames)
        }

        const captureLoop = () => {
          // Capture every interval we've crossed, not just one at a time —
          // requestVideoFrameCallback may fire less often than 60Hz.
          while (video.currentTime >= nextCapture && capturesInitiated < frameCount) {
            captureFrame()
            nextCapture += interval
          }
          if (capturesInitiated >= frameCount) {
            finalize()
            return
          }
          if (!video.ended) {
            (video as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => void }).requestVideoFrameCallback(captureLoop)
          }
        }

        video.onended = () => { finalize() }

        ;(video as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => void }).requestVideoFrameCallback(captureLoop)
        video.play().catch(() => {
          // Playback failed (e.g. autoplay blocked) — fall back to seek-based
          resolved = true // prevent onended/loop from also resolving
          decodeViaSeek(video, canvas, ctx, frameCount, fps, onProgress).then((f) => { video.src = ''; resolve(f) })
        })
      } else {
        // Seek-based capture: works everywhere but slower
        const frames = await decodeViaSeek(video, canvas, ctx, frameCount, fps, onProgress)
        video.src = ''
        resolve(frames)
      }
    }

    video.onerror = () => reject(new Error(`Failed to load video: ${videoUrl}`))
    video.src = videoUrl
  })
}

async function decodeViaSeek(
  video: HTMLVideoElement, canvas: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D,
  frameCount: number, fps: number, onProgress?: (progress: number) => void
): Promise<ImageBitmap[]> {
  const frames: ImageBitmap[] = []
  for (let i = 0; i < frameCount; i++) {
    const time = i / fps
    video.currentTime = time
    await new Promise<void>((res) => { video.onseeked = () => res() })
    ctx.drawImage(video, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT)
    const bitmap = await createImageBitmap(canvas)
    frames.push(bitmap)
    onProgress?.((i + 1) / frameCount)
  }
  return frames
}

async function bitmapsToBlobs(bitmaps: ImageBitmap[]): Promise<Blob[]> {
  const canvas = new OffscreenCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT)
  const ctx = canvas.getContext('2d')!
  const blobs: Blob[] = []
  for (const bmp of bitmaps) {
    ctx.drawImage(bmp, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
    blobs.push(blob)
  }
  return blobs
}

async function blobsToBitmaps(blobs: Blob[]): Promise<ImageBitmap[]> {
  return Promise.all(blobs.map((b) => createImageBitmap(b)))
}

// ── Frame Cache ───────────────────────────────────────────────────

type CacheEntry = {
  frames: ImageBitmap[]
  fps: number
  duration: number
  bytes: number // estimated memory: width * height * 4 * frameCount
}

const memoryCache = new Map<string, CacheEntry>()
const loadingKeys = new Set<string>()
const loadProgress = new Map<string, number>() // key -> 0.0 to 1.0
const persistedKeys = new Set<string>() // raw keys known to exist in IndexedDB (cold tier)

// ── Memory tracking ──────────────────────────────────────────────

let totalMemoryBytes = 0

// ImageBitmaps live in GPU/process memory, not JS heap.
// 32GB allows ~26 transitions at 1920x1080 (~1.2GB each) in memory.
let MEMORY_LIMIT = (() => {
  if (typeof window === 'undefined') return 2 * 1024 * 1024 * 1024
  const stored = localStorage.getItem('beatlab-cache-memory-gb')
  return (stored ? parseFloat(stored) : 2) * 1024 * 1024 * 1024
})()

/** Update the memory limit (in GB). Called from settings. */
export function setCacheMemoryLimit(gb: number) {
  MEMORY_LIMIT = gb * 1024 * 1024 * 1024
  localStorage.setItem('beatlab-cache-memory-gb', String(gb))
}

function estimateEntryBytes(frames: ImageBitmap[]): number {
  if (frames.length === 0) return 0
  const f = frames[0]
  // ImageBitmap GPU memory is 2-3x the raw RGBA size due to driver overhead,
  // mipmaps, alignment padding. Use 2.5x multiplier so eviction math matches
  // actual memory pressure the browser reports.
  return Math.round(f.width * f.height * 4 * frames.length * 2.5)
}

// ── Playhead-proximity eviction ─────────────────────────────────
// Each key is tagged with its timeline position (seconds).
// Eviction removes the entry farthest from the current playhead.

const keyTimestamps = new Map<string, number>() // key -> timeline position in seconds
let currentPlayhead = 0

/** Tell the cache where a key lives on the timeline */
export function setKeyTimestamp(key: string, timeSeconds: number) {
  keyTimestamps.set(key, timeSeconds)
}

/** Update the playhead position for proximity-based eviction */
export function setPlayheadPosition(time: number) {
  currentPlayhead = time
}

let evictionProtectSeconds = 30 // never evict entries within the preload window

export function setEvictionProtectWindow(seconds: number) {
  evictionProtectSeconds = seconds
}

function evictFarthest(protectKey?: string, protectRadius?: number) {
  const radius = protectRadius ?? evictionProtectSeconds
  let farthestKey: string | null = null
  let farthestDist = -1
  for (const key of memoryCache.keys()) {
    if (key === protectKey) continue
    const t = keyTimestamps.get(key) ?? 0
    const dist = Math.abs(t - currentPlayhead)
    if (dist <= radius) continue
    if (dist > farthestDist) {
      farthestDist = dist
      farthestKey = key
    }
  }
  if (farthestKey) cacheDelete(farthestKey)
  return !!farthestKey
}

function cacheSet(key: string, entry: CacheEntry) {
  const existing = memoryCache.get(key)
  if (existing) { totalMemoryBytes -= existing.bytes; existing.frames.forEach((f) => f.close()) }
  memoryCache.set(key, entry)
  totalMemoryBytes += entry.bytes
  // GPU memory for ImageBitmap textures can be 2-4x the estimated RGBA bytes
  // due to driver overhead, mipmapping, and padding. Evict aggressively at 60%.
  const evictionThreshold = MEMORY_LIMIT * 0.6
  if (totalMemoryBytes <= evictionThreshold) return

  // Phase 1: evict outside the protection zone
  let attempts = 0
  while (totalMemoryBytes > evictionThreshold && memoryCache.size > 1 && attempts < 100) {
    if (!evictFarthest(key)) break
    attempts++
  }
  if (totalMemoryBytes <= MEMORY_LIMIT * 0.85) return

  // Phase 2: over 85% — shrink protection to 10s
  while (totalMemoryBytes > MEMORY_LIMIT * 0.7 && memoryCache.size > 1 && attempts < 200) {
    if (!evictFarthest(key, 10)) break
    attempts++
  }
  if (totalMemoryBytes <= MEMORY_LIMIT * 0.95) return

  // Phase 3: critical — evict everything except what's immediately playing
  while (totalMemoryBytes > MEMORY_LIMIT * 0.7 && memoryCache.size > 1 && attempts < 500) {
    if (!evictFarthest(key, 2)) break
    attempts++
  }
  if (attempts >= 500) {
    console.warn(`[frame-cache] eviction hit iteration limit — ${(totalMemoryBytes / 1024 / 1024 / 1024).toFixed(1)}GB still cached, ${memoryCache.size} entries`)
  }
}

function cacheDelete(key: string) {
  const entry = memoryCache.get(key)
  if (entry) {
    totalMemoryBytes -= entry.bytes
    entry.frames.forEach((f) => f.close())
    memoryCache.delete(key)
  }
}

export function getMemoryUsage(): { usedBytes: number; limitBytes: number; pct: number } {
  return { usedBytes: totalMemoryBytes, limitBytes: MEMORY_LIMIT, pct: Math.round(totalMemoryBytes / MEMORY_LIMIT * 100) }
}

// ── Concurrency-limited preload queue ────────────────────────────

let MAX_CONCURRENT_PRELOADS = 6

export function setMaxConcurrentPreloads(n: number) {
  MAX_CONCURRENT_PRELOADS = Math.max(1, Math.min(20, n))
  drainQueue()
}
let activePreloads = 0
const preloadQueue: Array<() => Promise<void>> = []
const DEFERRED_RETRY_MS = 5000
const MAX_DEFERRED_RETRIES = 6 // give up after ~30s of retries
const deferredRetries = new Map<string, number>() // key -> retry count

function enqueuePreload(fn: () => Promise<void>) {
  // Hard memory guard: skip new preloads when we're at 95% of the limit.
  // New decodes would push us over — let the eviction catch up first.
  if (totalMemoryBytes > MEMORY_LIMIT * 0.95) {
    if (preloadQueue.length === 0) {
      console.warn(`[frame-cache] preload skipped: memory at ${(totalMemoryBytes / 1024 / 1024 / 1024).toFixed(1)}GB / ${(MEMORY_LIMIT / 1024 / 1024 / 1024).toFixed(1)}GB`)
    }
    return
  }
  preloadQueue.push(fn)
  drainQueue()
}

function deferPreload(key: string, fn: () => Promise<void>) {
  const retries = deferredRetries.get(key) ?? 0
  if (retries >= MAX_DEFERRED_RETRIES) {
    deferredRetries.delete(key)
    loadingKeys.delete(key)
    loadProgress.delete(key)
    return
  }
  deferredRetries.set(key, retries + 1)
  loadingKeys.delete(key)
  setTimeout(() => {
    if (!memoryCache.has(key) && !loadingKeys.has(key)) {
      loadingKeys.add(key)
      enqueuePreload(fn)
    }
  }, DEFERRED_RETRY_MS)
}

function drainQueue() {
  if (preloadQueue.length > 0 && activePreloads >= MAX_CONCURRENT_PRELOADS) {
    console.log(`[frame-cache] queue blocked: ${preloadQueue.length} queued, ${activePreloads} active`)
  }
  while (activePreloads < MAX_CONCURRENT_PRELOADS && preloadQueue.length > 0) {
    const next = preloadQueue.shift()!
    activePreloads++
    next().finally(() => {
      activePreloads--
      drainQueue()
    })
  }
}

export function getFrames(key: string): CacheEntry | null {
  return memoryCache.get(key) ?? null
}

export function getFrameAtProgress(key: string, progress: number): ImageBitmap | null {
  const entry = memoryCache.get(key)
  if (!entry || entry.frames.length === 0) return null
  const idx = Math.min(Math.floor(progress * entry.frames.length), entry.frames.length - 1)
  return entry.frames[Math.max(0, idx)]
}

/** True if data is available — either hot (in memory) or cold (in IndexedDB) */
export function isLoaded(key: string): boolean {
  return memoryCache.has(key) || persistedKeys.has(key)
}

/** True if bitmaps are immediately drawable without async reload */
export function isInMemory(key: string): boolean {
  return memoryCache.has(key)
}

export function isLoading(key: string): boolean {
  return loadingKeys.has(key)
}

/** Returns 0-1 decode progress for a key, or null if not loading */
export function getLoadProgress(key: string): number | null {
  if (memoryCache.has(key)) return 1
  return loadProgress.get(key) ?? null
}

export type PreloadStatus = { key: string; progress: number }

/** Returns a snapshot of all in-progress preload items */
export function getActivePreloads(): PreloadStatus[] {
  const items: PreloadStatus[] = []
  for (const [key, progress] of loadProgress) {
    items.push({ key, progress })
  }
  return items
}

/**
 * Invalidate a cache entry — clears memory and IndexedDB.
 * Returns a promise that resolves when IndexedDB deletion is complete.
 * Await this before re-preloading to prevent restoring stale data.
 */
export async function invalidateEntry(key: string): Promise<void> {
  cacheDelete(key)
  persistedKeys.delete(key)
  loadingKeys.delete(key)
  loadProgress.delete(key)
  deferredRetries.delete(key)
  drainQueue()
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(dbKey(key))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {}
}

/**
 * Preload a transition's video frames into the cache.
 * IndexedDB restore runs immediately (fast). Video decode is queued (slow).
 */
export function preloadTransition(key: string, videoUrl: string): void {
  if (memoryCache.has(key) || loadingKeys.has(key)) return
  loadingKeys.add(key)

  const resolvedDbKey = dbKey(key)
  const startGen = cacheGeneration

  // Try IndexedDB restore immediately — don't queue behind slow video decodes
  restoreFromDb(key, resolvedDbKey, startGen).then((restored) => {
    if (restored) {
      loadingKeys.delete(key)
      loadProgress.delete(key)
      return
    }
    // IndexedDB miss — enqueue the slow video decode path
    console.log('[frame-cache] enqueuing decode', key, 'gen', startGen, 'current', cacheGeneration)
    enqueuePreload(() => decodeAndCache(key, videoUrl, resolvedDbKey, startGen))
  })
}

async function restoreFromDb(key: string, resolvedDbKey: string, startGen: number): Promise<boolean> {
  try {
    console.log('[frame-cache] lookup', resolvedDbKey)
    const cached = await getFromDb(resolvedDbKey)
    if (!cached || cached.length === 0) {
      console.log('[frame-cache] MISS', resolvedDbKey)
      return false
    }
    console.log('[frame-cache] HIT', resolvedDbKey, cached.length, 'blobs')
    persistedKeys.add(key)
    if (startGen !== cacheGeneration) return true
    const frames = await blobsToBitmaps(cached)
    if (startGen !== cacheGeneration) { frames.forEach((f) => f.close()); return true }
    cacheSet(key, {
      frames,
      fps: TARGET_FPS,
      duration: frames.length / TARGET_FPS,
      bytes: estimateEntryBytes(frames),
    })
    deferredRetries.delete(key)
    return true
  } catch {
    return false
  }
}

async function decodeAndCache(key: string, videoUrl: string, resolvedDbKey: string, startGen: number): Promise<void> {
  let frames: ImageBitmap[] = []
  const work = async () => {
    try {
      if (startGen !== cacheGeneration) { console.log('[frame-cache] stale generation, skipping', key); return }

      console.log('[frame-cache] decoding', key)
      const headRes = await fetch(videoUrl, { method: 'HEAD' }).catch(() => null)
      if (!headRes || !headRes.ok) {
        deferPreload(key, work)
        return
      }

      if (startGen !== cacheGeneration) return

      loadProgress.set(key, 0)
      frames = await decodeVideoFrames(videoUrl, (p) => loadProgress.set(key, p))
      if (startGen !== cacheGeneration) { frames.forEach((f) => f.close()); frames = []; return }
      if (frames.length > 0) {
        // Persist to IndexedDB BEFORE cacheSet — LRU eviction closes bitmaps
        try {
          const blobs = await bitmapsToBlobs(frames)
          await putToDb(resolvedDbKey, blobs)
          persistedKeys.add(key)
        } catch (err) {
          console.warn('[frame-cache] IndexedDB persist failed:', key, err)
        }

        if (startGen !== cacheGeneration) { frames.forEach((f) => f.close()); frames = []; return }
        cacheSet(key, {
          frames,
          fps: TARGET_FPS,
          duration: frames.length / TARGET_FPS,
          bytes: estimateEntryBytes(frames),
        })
      }
      frames = []
      deferredRetries.delete(key)
    } catch {
      frames.forEach((f) => f.close())
      frames = []
      deferPreload(key, work)
    } finally {
      loadingKeys.delete(key)
      loadProgress.delete(key)
    }
  }
  await work()
}

/**
 * Preload a keyframe image into the cache (single frame).
 * Checks IndexedDB first, falls back to fetching from server.
 */
export function preloadKeyframeImage(key: string, imageUrl: string): void {
  if (memoryCache.has(key) || loadingKeys.has(key)) return
  loadingKeys.add(key)

  const resolvedDbKey = dbKey(key)

  // Try IndexedDB first (fast), then queue the network fetch (slow)
  restoreFromDb(key, resolvedDbKey, cacheGeneration).then((restored) => {
    if (restored) {
      loadingKeys.delete(key)
      return
    }
    enqueuePreload(() => _fetchKeyframeImage(key, imageUrl, resolvedDbKey))
  })
}

async function _fetchKeyframeImage(key: string, imageUrl: string, resolvedDbKey: string): Promise<void> {
  let bitmap: ImageBitmap | null = null
  try {
    // Fetch from server
    const img = new Image()
    img.crossOrigin = 'anonymous'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject()
      img.src = imageUrl
    })
    bitmap = await createImageBitmap(img, { resizeWidth: PREVIEW_WIDTH, resizeHeight: PREVIEW_HEIGHT })

    // Persist to IndexedDB BEFORE cacheSet (LRU eviction may close bitmaps)
    const blobs = await bitmapsToBlobs([bitmap])
    await putToDb(resolvedDbKey, blobs)
    persistedKeys.add(key)

    cacheSet(key, { frames: [bitmap], fps: 1, duration: Infinity, bytes: estimateEntryBytes([bitmap]) })
    bitmap = null
  } catch {
    bitmap?.close()
  } finally {
    loadingKeys.delete(key)
  }
}

/**
 * Evict entries far from the current playhead to free memory.
 */
export function evictFarEntries(keepKeys: Set<string>) {
  let evicted = false
  for (const key of [...memoryCache.keys()]) {
    if (!keepKeys.has(key)) {
      cacheDelete(key)
      evicted = true
    }
  }
  // Freeing memory may unblock queued preloads
  if (evicted) drainQueue()
}
