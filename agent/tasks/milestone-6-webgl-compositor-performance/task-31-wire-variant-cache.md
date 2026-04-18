# Task 31: Wire Shader Variant Cache into Render Loop

**Milestone**: [M6 - WebGL Compositor Performance](../../milestones/milestone-6-webgl-compositor-performance.md)  
**Design Reference**: [WebGL Compositor Performance](../../design/local.webgl-compositor-performance.md)  
**Estimated Time**: 3 hours  
**Status**: Not Started  
**Dependencies**: Task 30  

---

## Objective

Task 30 built the variant cache infrastructure (buildFragmentShader, compileVariant, getVariantProgram, variantCache on ctx) but left the render loop using the monolithic shader. This task switches the render loop to use compiled variants per layer, picking the right minimal-code variant based on active effects.

---

## Steps

1. In the render loop (`render` useCallback), compute `ShaderFlags` for each layer via `shaderFlagsForLayer`
2. Before draw: call `getVariantProgram(ctx, flags)` to get the variant; fall back to `ctx.compProgram` if compile fails
3. `gl.useProgram(variant.program)` per layer (programs change between layers — cheap switch)
4. Bind sampler uniforms (u_base=0, u_layerA=1, u_layerB=2) per program switch
5. Use the variant's cached `locs` for uniform uploads (not `ctx.compLocs`)
6. Skip uniforms that aren't present in the variant (e.g., skip u_brightness if flags.brightness is false)
7. Keep monolithic shader as safety fallback — if any variant fails to compile, fall back

---

## Verification

- [ ] Visual output matches the monolithic shader (pixel compare)
- [ ] Shader variant cache accumulates entries across a typical editing session
- [ ] No shader compile errors in console
- [ ] Simple layers (no effects) use smaller, faster variants
- [ ] Complex layers (many effects) still render correctly
- [ ] No regressions in existing editing operations
