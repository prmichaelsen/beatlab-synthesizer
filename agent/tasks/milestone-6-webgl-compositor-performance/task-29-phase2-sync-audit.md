# Task 29: Phase 2 — Sync Stall Audit + Ping-Pong Fix

**Milestone**: [M6 - WebGL Compositor Performance](../../milestones/milestone-6-webgl-compositor-performance.md)  
**Design Reference**: [WebGL Compositor Performance](../../design/local.webgl-compositor-performance.md)  
**Estimated Time**: 4 hours  
**Status**: Not Started  
**Dependencies**: Task 28  

---

## Objective

Eliminate implicit CPU-GPU sync points that cause driver stalls. Verify ping-pong FBO correctness to fix partial renders. Cache uniform locations.

---

## Steps

### 1. Ping-pong FBO audit

Verify the sampler for `u_base` is NEVER bound to the FBO currently being rendered to.

```typescript
// Two permanent FBOs, two permanent accumulator textures
const fbos: [WebGLFramebuffer, WebGLFramebuffer]
const accumTex: [WebGLTexture, WebGLTexture]

let readIdx = 0, writeIdx = 1
for (const layer of layers) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[writeIdx])  // write target
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, accumTex[readIdx])    // read source
  // CRITICAL: readIdx !== writeIdx
  drawLayer(layer)
  ;[readIdx, writeIdx] = [writeIdx, readIdx]
}
```

- Keep both FBOs + textures allocated for the lifetime of the context
- Never recreate on resize — use `gl.texStorage2D` once at proper size, or allocate extra-large once
- Assert `readIdx !== writeIdx` in dev mode

### 2. Remove sync stalls from hot loop

Search `BeatEffectPreview.tsx` for:
- `gl.readPixels` — should not be called during playback
- `gl.finish` — should never be in render loop
- `gl.getError` — remove from hot path (only call on dev/debug)
- `canvas.toDataURL` / `canvas.toBlob` — should not be called during playback

### 3. Cache uniform locations

Current: `gl.getUniformLocation(program, 'u_*')` called per draw.  
New: cache all uniform locations once at program link time.

```typescript
const locs = {
  u_base: gl.getUniformLocation(program, 'u_base'),
  u_layerA: gl.getUniformLocation(program, 'u_layerA'),
  // ... all uniforms
}
```

Use `locs.u_base` in the render loop.

### 4. Audit project-wide for sync-causing ops during playback

Grep the codebase:
```
src/**/*.tsx | grep -E 'readPixels|toDataURL|toBlob|gl.finish|gl.getError'
```

For each hit, verify it's not called during playback. If it is (e.g., screenshot/capture feature), gate it behind `!isPlaying`.

### 5. Measure

Record Chrome DevTools Performance profile during complex scene playback. Look for:
- `texSubImage2D` dominance (good — GPU-bound)
- Any JS main thread gaps > 16ms (bad — stalls)
- `readPixels` / `finish` / `getError` in the flame graph (must be zero during playback)

---

## Verification

- [ ] Both FBOs allocated once, never recreated
- [ ] Sampler never bound to active render target
- [ ] All uniform locations cached at program link
- [ ] Zero calls to `readPixels` / `finish` / `getError` / `toDataURL` during playback
- [ ] Performance profile shows no main-thread gaps > 16ms during playback
- [ ] Partial renders no longer occur (all layers composite correctly)
