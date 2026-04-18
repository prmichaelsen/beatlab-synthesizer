# Task 30: Phase 3 — Shader Variant Cache

**Milestone**: [M6 - WebGL Compositor Performance](../../milestones/milestone-6-webgl-compositor-performance.md)  
**Design Reference**: [WebGL Compositor Performance](../../design/local.webgl-compositor-performance.md)  
**Estimated Time**: 6 hours  
**Status**: Not Started  
**Dependencies**: Task 29  

---

## Objective

Replace the monolithic fragment shader (many `if > 0.001` branches for each effect) with compiled variants keyed by active-effect bitmask. Each variant contains only the code for its active features. Use `KHR_parallel_shader_compile` for async compilation.

---

## Steps

### 1. Define feature flags

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
  blendMode: number // 0-7
}

function flagsFromLayer(layer: TrackLayer): ShaderFlags {
  return {
    chromaKey: !!layer.chromaKey,
    saturation: Math.abs((layer.saturation ?? 1) - 1) > 0.001,
    hueShift: (layer.hueShift ?? 0) > 0.001,
    brightness: Math.abs(layer.brightness ?? 0) > 0.001,
    contrast: Math.abs((layer.contrast ?? 1) - 1) > 0.001,
    exposure: Math.abs(layer.exposure ?? 0) > 0.001,
    invert: (layer.invert ?? 0) > 0.001,
    mask: !!layer.mask,
    blendMode: BLEND_MODE_MAP[layer.blendMode] ?? 0,
  }
}

function flagsKey(f: ShaderFlags): string {
  return `${f.blendMode}|${+f.chromaKey}${+f.saturation}${+f.hueShift}${+f.brightness}${+f.contrast}${+f.exposure}${+f.invert}${+f.mask}`
}
```

### 2. Fragment shader builder

Split the monolithic shader into composable chunks. Build only the ones for active flags.

```typescript
function buildFragmentShader(flags: ShaderFlags): string {
  return `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform sampler2D u_base;
    uniform sampler2D u_layerA;
    uniform sampler2D u_layerB;
    uniform float u_layerBlend;
    uniform float u_opacity;
    // ...always-on uniforms

    ${flags.chromaKey ? `
      uniform vec3 u_keyColor;
      uniform float u_keyThreshold;
      uniform float u_keyFeather;
    ` : ''}

    ${flags.saturation || flags.hueShift ? RGB_HSV_HELPERS : ''}

    void main() {
      // ...texture sampling

      ${flags.brightness ? 'layer += u_brightness;' : ''}
      ${flags.contrast ? 'layer = (layer - 0.5) * u_contrast + 0.5;' : ''}
      ${flags.exposure ? 'layer *= pow(2.0, u_exposure);' : ''}
      ${flags.invert ? 'layer = mix(layer, vec3(1.0) - layer, u_invert);' : ''}

      ${flags.saturation || flags.hueShift ? `
        vec3 hsv = rgb2hsv(layer);
        ${flags.saturation ? 'hsv.y = clamp(hsv.y * u_saturation, 0.0, 1.0);' : ''}
        ${flags.hueShift ? 'hsv.x = fract(hsv.x + u_hueShift);' : ''}
        layer = hsv2rgb(hsv);
      ` : ''}

      ${flags.mask ? MASK_CHUNK : ''}
      ${getBlendModeChunk(flags.blendMode)}

      gl_FragColor = vec4(blended, 1.0) * u_opacity;
    }
  `
}
```

### 3. Variant cache

```typescript
const programCache = new Map<string, WebGLProgram>()
let parallelExt: KHR_parallel_shader_compile | null = null

function initParallelCompile(gl: WebGL2RenderingContext) {
  parallelExt = gl.getExtension('KHR_parallel_shader_compile')
}

function getProgram(gl: WebGL2RenderingContext, flags: ShaderFlags): WebGLProgram | null {
  const key = flagsKey(flags)
  const cached = programCache.get(key)
  if (cached) {
    // Check if ready (async compile)
    if (parallelExt && !gl.getProgramParameter(cached, parallelExt.COMPLETION_STATUS_KHR)) {
      return null  // still compiling — fall back to default program
    }
    return cached
  }
  const fs = buildFragmentShader(flags)
  const prog = compileProgram(gl, VERTEX_SHADER, fs)
  programCache.set(key, prog)
  return parallelExt ? null : prog  // async: return null on first request
}
```

### 4. Fallback program

While a variant compiles asynchronously, use a "full" program (all features enabled) as fallback. Avoid a visible skip on first use.

### 5. Measure

Count unique variant keys across a typical session. Should see ~30-60 over the full editing flow.
- If >100, consider coarser key (group similar flags)
- If <10, the variants aren't worth the complexity

Measure compile time per variant. Should be <20ms each with parallel compile.

---

## Verification

- [ ] Fragment shader split into composable chunks
- [ ] `programCache` correctly keys by flags bitmask
- [ ] `KHR_parallel_shader_compile` enabled
- [ ] Fallback program used while variants compile
- [ ] Visual output identical to monolithic shader (pixel-compare)
- [ ] Variant count <100 after full editing session
- [ ] No visible first-use hitch when a new variant compiles
- [ ] All existing effects produce correct output in each variant
