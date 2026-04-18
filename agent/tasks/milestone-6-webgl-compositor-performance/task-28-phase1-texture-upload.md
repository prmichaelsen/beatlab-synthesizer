# Task 28: Phase 1 — Texture Upload Optimization

**Milestone**: [M6 - WebGL Compositor Performance](../../milestones/milestone-6-webgl-compositor-performance.md)  
**Design Reference**: [WebGL Compositor Performance](../../design/local.webgl-compositor-performance.md)  
**Estimated Time**: 6 hours  
**Status**: Not Started  

---

## Objective

Replace per-frame `gl.texImage2D` calls with `texStorage2D` + `texSubImage2D`, add identity-skip for unchanged bitmaps, and implement a texture pool. This is the biggest-impact change — should eliminate most of the stutter and all held-frame bugs.

---

## Steps

### 1. Add texture slot type and pool

In `BeatEffectPreview.tsx`, introduce:

```typescript
type LayerSlot = {
  tex: WebGLTexture
  w: number
  h: number
  lastBitmap: ImageBitmap | null
}

function initLayerSlot(gl: WebGL2RenderingContext, w: number, h: number): LayerSlot {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return { tex, w, h, lastBitmap: null }
}
```

### 2. Reallocate slot if bitmap dimensions change

If an incoming bitmap has different `w/h` than the slot, delete the texture and re-init. This should be rare (only on resolution changes).

### 3. Implement identity-skip upload

```typescript
function uploadLayer(gl: WebGL2RenderingContext, slot: LayerSlot, bitmap: ImageBitmap) {
  if (slot.lastBitmap === bitmap) return  // identity skip
  if (bitmap.width !== slot.w || bitmap.height !== slot.h) {
    // reallocate
    gl.deleteTexture(slot.tex)
    Object.assign(slot, initLayerSlot(gl, bitmap.width, bitmap.height))
  }
  gl.bindTexture(gl.TEXTURE_2D, slot.tex)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
  slot.lastBitmap = bitmap
}
```

### 4. Set pixel store state once (not per frame)

At WebGL context init:
```typescript
gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
```

Never toggle these per frame.

### 5. Restructure render loop to upload-then-draw

Current: interleaved upload + draw per layer.  
New: upload all layers first, then draw all layers. Lets driver pipeline uploads with prior-frame rendering.

```typescript
function renderFrame(layers: TrackLayer[]) {
  // Upload pass
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].frameA) uploadLayer(gl, slotsA[i], layers[i].frameA)
    if (layers[i].frameB) uploadLayer(gl, slotsB[i], layers[i].frameB)
  }
  // Draw pass (existing logic)
  for (let i = 0; i < layers.length; i++) {
    drawLayer(layers[i], i)
  }
}
```

### 6. Replace existing texImage2D call sites

Find all `gl.texImage2D` in `BeatEffectPreview.tsx` and replace with the new slot-based path. Make sure to allocate slots when layers are added/removed.

### 7. Instrument and measure

Add `performance.mark('upload-start')` / `performance.measure` around the upload pass. Compare before/after:
- Time per upload
- Total upload time per frame
- Frame rate during complex scenes

---

## Verification

- [ ] No `texImage2D` calls remain in the render hot path (only `texSubImage2D`)
- [ ] `texStorage2D` called once per slot allocation
- [ ] Identity-skip working: pause playback, observe zero uploads per frame
- [ ] Visual output identical to before (pixel-compare)
- [ ] Measured upload time reduced 2-5×
- [ ] No visible held frames during scrubbing
- [ ] No regression: all existing editing operations work (keyframe drag, video assign, transition select)
