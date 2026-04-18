# Milestone 6: WebGL Compositor Performance

**Goal**: Eliminate stuttery playback, partial renders, and held still frames in the multi-track WebGL compositor  
**Created**: 2026-04-16  
**Status**: Not Started  
**Estimated Duration**: 1-2 weeks  
**Design Reference**: [WebGL Compositor Performance](../design/local.webgl-compositor-performance.md)  

---

## Overview

The editor's WebGL compositor in `BeatEffectPreview.tsx` renders up to 6 layers per frame at 60fps. Users report stuttery playback during complex scenes, partial renders where some layers don't finish, and held still frames. This milestone implements three phases of WebGL best-practice fixes.

## Deliverables

1. Phase 1: Texture upload optimization (`texStorage2D`, `texSubImage2D`, identity skip, texture pool)
2. Phase 2: Sync stall audit + ping-pong FBO fix + uniform location cache
3. Phase 3: Shader variant cache with `KHR_parallel_shader_compile`

## Success Criteria

- [ ] Playback remains at 60fps with 6 active tracks
- [ ] No held frames during scrubbing (verified visually)
- [ ] No partial renders (all layers composite correctly)
- [ ] `texImage2D` call time reduced by 2-5× (measured)
- [ ] No regressions in existing editing operations

## Tasks

| Task | Name | Est. Hours | Status |
|------|------|------------|--------|
| task-28 | Phase 1: Texture upload optimization | 6 | Not Started |
| task-29 | Phase 2: Sync stall audit + ping-pong fix | 4 | Not Started |
| task-30 | Phase 3: Shader variant cache | 6 | Not Started |

## Deferred (Not in Scope)

- Phase 4: Single-pass texture array compositor (structural refactor)
- Phase 5: OffscreenCanvas + Worker compositor (off-main-thread)

Both deferred until Phases 1-3 are measured. Can be added as later tasks if still needed.
