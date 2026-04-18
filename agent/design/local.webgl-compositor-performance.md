# WebGL Compositor Performance Improvements

**Concept**: Overhaul the frontend WebGL multi-track compositor to fix stuttery playback, partial renders, and held frames by addressing texture upload bottlenecks, FBO sync bugs, and driver stalls  
**Created**: 2026-04-16  
**Status**: Design Specification  

---

## Overview

The editor uses a fragment-shader-based compositor in `BeatEffectPreview.tsx` that renders up to 6 tracks per frame at 60fps. Users report:
- Stuttery playback during complex scenes
- Partial renders (some layers don't finish compositing)
- Held still frames when they should update

Research into WebGL best practices identifies three root causes: per-frame texture reallocation, missing identity-skip on unchanged bitmaps, and potential FBO read-after-write undefined behavior. This design captures a prioritized plan to address them.

---

## Problem Statement

**Current pipeline** (per frame, per layer):
1. `gl.texImage2D(ImageBitmap)` — reallocates texture storage every call
2. Set 20+ uniforms
3. Bind ping-pong FBO, sample from other FBO's attachment
4. Draw

With 6 layers × 60fps = 360 uploads/sec, this saturates the CPU→GPU upload pipeline. Drivers treat each `texImage2D` as a full realloc even at the same dimensions.

**Observed symptoms map to known WebGL pitfalls**:
- Stutter → `texImage2D` realloc cost
- Partial renders → FBO read-after-write (sampler bound to current write target on some drivers)
- Held frames → identity-skip absent; same `ImageBitmap` reference re-uploaded anyway

---

## Solution

**Three-phase rollout** — apply highest-impact fixes first without breaking existing architecture.

### Phase 1: Texture Upload Optimization (P0)

**Biggest win. Addresses stutter + held frames.**

1. Switch to `texStorage2D` + `texSubImage2D`:
   - Allocate immutable storage once per layer slot
   - Update in place with `texSubImage2D`
   - Drivers no longer treat every upload as a realloc
   - Expected 2-5× faster per upload

2. Identity-skip uploads:
   - Track `lastBitmap` reference per layer slot
   - Skip `texSubImage2D` if the bitmap reference is unchanged
   - Kills 95% of upload cost during still frames (pauses, static kfs)

3. Texture pool:
   - Pre-allocated textures keyed by `(w, h)` resolution class
   - Bind pooled texture instead of creating/destroying mid-playback
   - Eliminates GL object GC as a stutter source

4. Pixel store state (set once, never toggle):
   - `UNPACK_PREMULTIPLY_ALPHA_WEBGL = true`
   - `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`
   - Toggling forces bitmap re-decode on Chromium

5. Upload early in rAF:
   - Issue all layer `texSubImage2D` calls at the start of the frame
   - Draws follow after — driver can pipeline uploads with prior-frame rendering

### Phase 2: Sync Stall Audit (P0)

**Low effort, addresses partial renders and held frames from driver stalls.**

Audit for implicit CPU-GPU sync points:
- Never call `gl.readPixels`, `gl.finish`, `gl.getError` in the hot render loop
- Cache uniform locations once at program link, not per frame
- Check all `canvas.toDataURL`/`toBlob` call sites — disallow during playback
- Ping-pong audit: verify that the sampler for `u_base` is never bound to the FBO we're currently rendering to (undefined behavior on some drivers)
- Keep two permanent FBO objects, swap attachments instead of recreating

### Phase 3: Shader Variants (P1)

**Eliminates dead-code paths and driver state thrash.**

Compile shader variants keyed by active-effect bitmask:
- Current monolithic shader: many `if > 0.001` branches, one global program
- Variants: one program per feature combination (e.g., "chroma+sat+contrast")
- ~30-60 variants total, cached forever
- Use `KHR_parallel_shader_compile` extension — compile async on first use
- Check `COMPLETION_STATUS_KHR` before binding

### Phase 4: Single-Pass Texture Array Compositor (P2 — deferred)

**Structural refactor. Large scope, large payoff.**

WebGL2 rewrite:
- Bind all 6 layers as one `TEXTURE_2D_ARRAY`
- Per-layer params via Uniform Buffer Object (std140 layout)
- Single draw call loops over active layers
- Eliminates ping-pong entirely

Caveat: blend modes that sample the accumulator (overlay, soft-light, difference) still need a ping-pong-style read. Evaluate whether to keep those modes or limit to "fixed-function" blends.

### Phase 5: OffscreenCanvas + Worker (P3 — deferred)

**Moves GL off the main thread. Fixes jank from React re-renders.**

Biggest structural change. Defer until Phases 1-3 are complete and measured.

---

## Implementation

### Phase 1 — Code Pattern

```typescript
// Per layer slot (one-time setup)
type LayerSlot = {
  tex: WebGLTexture
  w: number
  h: number
  lastBitmap: ImageBitmap | null
}

function initSlot(gl: WebGL2RenderingContext, w: number, h: number): LayerSlot {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return { tex, w, h, lastBitmap: null }
}

// Per frame, per layer
function uploadLayer(gl: WebGL2RenderingContext, slot: LayerSlot, bitmap: ImageBitmap) {
  if (slot.lastBitmap === bitmap) return  // identity skip
  gl.bindTexture(gl.TEXTURE_2D, slot.tex)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
  slot.lastBitmap = bitmap
}

// Render loop
function renderFrame(layers: TrackLayer[]) {
  // Upload pass first — pipelined with prior-frame GPU work
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].frameA) uploadLayer(gl, slotsA[i], layers[i].frameA)
    if (layers[i].frameB) uploadLayer(gl, slotsB[i], layers[i].frameB)
  }
  // Draw pass
  for (let i = 0; i < layers.length; i++) {
    // set uniforms, bind textures, draw
  }
}
```

### Phase 2 — Ping-Pong Audit

```typescript
// CORRECT: two permanent FBOs, two permanent textures, swap roles per layer
let readIdx = 0, writeIdx = 1
for (const layer of layers) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[writeIdx])  // render target
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, accumTextures[readIdx])  // NEVER same as writeIdx
  // ...draw
  ;[readIdx, writeIdx] = [writeIdx, readIdx]
}
```

### Phase 3 — Shader Variant Cache

```typescript
type ShaderFlags = {
  chromaKey: boolean
  saturation: boolean
  hueShift: boolean
  brightness: boolean
  contrast: boolean
  exposure: boolean
  invert: boolean
  mask: boolean
  blendMode: number
}

function flagsKey(f: ShaderFlags): string {
  return `${f.blendMode}|${+f.chromaKey}${+f.saturation}${+f.hueShift}${+f.brightness}${+f.contrast}${+f.exposure}${+f.invert}${+f.mask}`
}

const programCache = new Map<string, WebGLProgram>()

function getProgram(gl: WebGL2RenderingContext, flags: ShaderFlags): WebGLProgram {
  const key = flagsKey(flags)
  if (programCache.has(key)) return programCache.get(key)!
  const fs = buildFragmentShader(flags)
  const prog = compileProgram(gl, VS, fs)
  programCache.set(key, prog)
  return prog
}
```

---

## Files to Modify

### Phase 1
- `src/components/editor/BeatEffectPreview.tsx` — texture slot pool, upload-before-draw, identity skip

### Phase 2
- `src/components/editor/BeatEffectPreview.tsx` — ping-pong audit, remove sync stalls, cache uniform locations
- Search entire codebase for `readPixels`, `toDataURL`, `toBlob`, `gl.finish`, `gl.getError` during playback

### Phase 3
- `src/components/editor/BeatEffectPreview.tsx` — fragment shader builder, variant cache, KHR_parallel_shader_compile

---

## Benefits

- **Stutter eliminated**: `texSubImage2D` + identity skip removes per-frame realloc cost
- **Held frames fixed**: identity skip ensures new frames aren't masked by stale uploads
- **Partial renders fixed**: ping-pong audit eliminates FBO read-after-write UB
- **Future-proof**: shader variants enable adding effects without shader bloat
- **Measurable**: each phase can be timed with `performance.mark` before/after

---

## Trade-offs

- **WebGL2 requirement**: `texStorage2D` is WebGL2-only. If any user browser is WebGL1-only, need a fallback path. (Check analytics — likely fine in 2026.)
- **Phase 3 complexity**: shader builder adds maintenance burden. 30+ variants need to be tested.
- **No performance gain for already-cached frames**: identity skip helps most during pauses and static sections.

---

## Dependencies

- WebGL2 context (already in use)
- `KHR_parallel_shader_compile` (widely supported)
- Existing frame cache (no changes)

---

## Testing Strategy

- Benchmark before/after with Chrome DevTools Performance tab
- Record 60-second playback of complex scene, count dropped frames
- Compare `texImage2D` call times before/after (expect 2-5× speedup)
- Visual smoke test: scrub through timeline, verify no held frames
- Multi-track test: enable all 6 tracks, verify composite is correct

---

## Key Design Decisions

### Architecture

| Decision | Choice | Rationale |
|---|---|---|
| Texture upload API | `texStorage2D` + `texSubImage2D` | 2-5× faster than `texImage2D`, no realloc |
| Identity skip | Reference equality on `ImageBitmap` | Cheap check, eliminates 95% of upload cost in still scenes |
| FBO strategy | Two permanent FBOs, swap attachments | Safer than recreate, avoids GC stalls |
| Shader architecture (Phase 3) | Variant cache keyed by feature bitmask | Eliminates dead branches, smaller register footprint |

### Rollout

| Decision | Choice | Rationale |
|---|---|---|
| Phase 1 first | Upload optimization | Biggest user-visible impact for least code |
| Phase 5 deferred | OffscreenCanvas + Worker | Too big a refactor until P1-3 measured |
| WebGL2 only | No WebGL1 fallback | Already required by existing code |

---

## Future Considerations

- **WebGPU migration**: revisit in 2026 when Safari stable ships. Compute shaders would allow blend mode chains without ping-pong.
- **Multi-pass effects**: radial mask could be its own pass for better quality at high feather values.
- **Adaptive resolution**: lower resolution during playback, full-res when paused (user-facing setting).

---

**Status**: Design Specification  
**Recommendation**: Implement Phase 1 first (4-6 hours). Measure. Then Phase 2 (audit). Then Phase 3 if still needed.  
**Related Documents**: [BeatEffectPreview.tsx](../../src/components/editor/BeatEffectPreview.tsx)  
