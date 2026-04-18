import { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react'
import type { Beat } from '@/routes/project/$name/editor'
import type { UserEffect, BeatSuppression, AudioEvent, EffectType } from '@/lib/beatlab-client'

import type { BlendMode } from '@/lib/beatlab-client'

export type TrackLayer = {
  frameA: ImageBitmap | null
  frameB: ImageBitmap | null
  blendFactor: number
  opacity: number
  red: number
  green: number
  blue: number
  black: number
  saturation: number
  hueShift: number
  invert: number
  brightness: number
  contrast: number
  exposure: number
  blendMode: BlendMode
  chromaKey?: { color: [number, number, number]; threshold: number; feather: number }
  isAdjustment?: boolean
  mask?: { centerX: number; centerY: number; radius: number; feather: number }
  transform?: { x: number; y: number; scale?: number; anchorX?: number; anchorY?: number }
}

type BeatEffectPreviewProps = {
  src: string
  beats: Beat[]
  audioEvents?: AudioEvent[]
  userEffects?: UserEffect[]
  suppressions?: BeatSuppression[]
  currentTime: number
  isPlaying: boolean
  className?: string
  canvasWidth?: number
  canvasHeight?: number
  // Single-track (legacy) or multi-track layers
  transitionFrameA?: ImageBitmap | null
  transitionFrameB?: ImageBitmap | null
  blendFactor?: number
  layers?: TrackLayer[]
}

const VERTEX_SHADER = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  uniform float u_flipY;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = vec2(a_texCoord.x, mix(a_texCoord.y, 1.0 - a_texCoord.y, u_flipY));
  }
`

const FRAGMENT_SHADER = `
  precision mediump float;
  varying vec2 v_texCoord;
  uniform sampler2D u_imageA;
  uniform sampler2D u_imageB;
  uniform float u_blend;
  uniform float u_zoom;          // zoom_pulse / zoom_bounce intensity
  uniform float u_shakeX;        // horizontal shake offset
  uniform float u_shakeY;        // vertical shake offset
  uniform float u_contrastPop;   // contrast enhancement intensity
  uniform float u_glowSwell;     // glow/bloom intensity
  uniform float u_flash;         // flash to white intensity
  uniform float u_echo;          // echo concentric zoom layers

  vec4 sampleBlended(vec2 uv) {
    return mix(texture2D(u_imageA, uv), texture2D(u_imageB, uv), u_blend);
  }

  void main() {
    vec2 center = vec2(0.5, 0.5);

    // Zoom toward center
    float zoom = 1.0 - u_zoom * 0.06;
    vec2 uv = center + (v_texCoord - center) * zoom;

    // Shake: translate UV
    uv.x += u_shakeX * 0.02;
    uv.y += u_shakeY * 0.02;

    vec4 color = sampleBlended(uv);

    // Echo: concentric zoom layers
    if (u_echo > 0.01) {
      for (float i = 1.0; i <= 5.0; i += 1.0) {
        float layerZoom = zoom - u_echo * 0.04 * i;
        vec2 layerUv = center + (v_texCoord - center) * layerZoom;
        layerUv.x += u_shakeX * 0.02;
        layerUv.y += u_shakeY * 0.02;
        vec4 layerColor = sampleBlended(layerUv);
        float layerAlpha = u_echo * (1.0 - i / 6.0) * 0.4;
        color = mix(color, layerColor, layerAlpha);
      }
    }

    // Contrast pop: increase contrast around midpoint
    if (u_contrastPop > 0.01) {
      float c = 1.0 + u_contrastPop * 0.4;
      color.rgb = clamp((color.rgb - 0.5) * c + 0.5, 0.0, 1.0);
    }

    // Glow swell: bloom-like brightness + soft saturation boost
    if (u_glowSwell > 0.01) {
      float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      vec3 glow = color.rgb + (color.rgb - vec3(lum)) * u_glowSwell * 0.5;
      color.rgb = mix(color.rgb, glow, u_glowSwell) * (1.0 + u_glowSwell * 0.3);
      color.rgb = clamp(color.rgb, 0.0, 1.0);
    }

    // Brightness pulse from zoom
    color.rgb *= 1.0 + u_zoom * 0.3;

    // Flash to white
    if (u_flash > 0.01) {
      color.rgb = mix(color.rgb, vec3(1.0), u_flash * 0.7);
    }

    // Warm tint on zoom beats
    color.r += u_zoom * 0.02;
    color.g += u_zoom * 0.005;

    gl_FragColor = color;
  }
`


// Compositor shader: blends a layer onto an accumulator with blend modes
const COMPOSITE_SHADER = `
  precision mediump float;
  varying vec2 v_texCoord;
  uniform sampler2D u_base;    // accumulator
  uniform sampler2D u_layerA;  // track frame A
  uniform sampler2D u_layerB;  // track frame B
  uniform float u_layerBlend;  // crossfade A->B
  uniform float u_opacity;
  uniform float u_red;         // red channel multiplier (0=none, 1=full)
  uniform float u_green;       // green channel multiplier
  uniform float u_blue;        // blue channel multiplier
  uniform float u_black;       // fade to black (0=full color, 1=black)
  uniform float u_saturation;   // 1=normal, 0=grayscale, >1=oversaturated
  uniform float u_hueShift;    // 0=no shift, 1=full 360° rotation
  uniform float u_invert;      // 0=no invert, 1=full invert
  uniform float u_brightness;  // offset added to RGB (-1 to 1, 0=no change)
  uniform float u_contrast;    // scale around midpoint (0=flat gray, 1=normal, 2=double)
  uniform float u_exposure;    // stops of exposure (-3 to 3, 0=no change)
  uniform int u_blendMode;     // 0=normal,1=multiply,2=screen,3=overlay,4=difference,5=add,6=chroma-key,7=soft-light
  uniform vec3 u_keyColor;     // chroma key target color
  uniform float u_keyThreshold;// how close to key color = transparent (0-1)
  uniform float u_keyFeather;  // edge softness (0-0.5)
  uniform vec2 u_maskCenter;    // radial mask center (0-1)
  uniform float u_maskRadius;   // radial mask radius (0-1 of diagonal)
  uniform float u_maskFeather;  // radial mask edge softness (0-1)
  uniform float u_aspectRatio;  // canvas width/height
  uniform vec2 u_transform;     // layer position offset (0,0 = no shift)
  uniform float u_scale;        // layer scale (1.0 = no scale)
  uniform vec2 u_anchor;        // scale pivot point (default 0.5, 0.5)
  uniform float u_isAdjustment; // 1.0 = adjustment layer (skip Y-flip)
  uniform float u_hasChromaKey; // 1.0 = apply chroma key alpha masking before blend

  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    vec4 base = texture2D(u_base, v_texCoord);
    // Layer textures are ImageBitmaps (top-down) — flip Y to match FBO (bottom-up) accumulator
    // Adjustment layers read from the accumulator (already FBO space) — no flip needed
    // Apply transform: scale around anchor, then position offset
    vec2 baseCoord = u_isAdjustment > 0.5
      ? v_texCoord
      : vec2(v_texCoord.x, 1.0 - v_texCoord.y);
    // Scale around anchor point
    vec2 scaled = (baseCoord - u_anchor) / u_scale + u_anchor;
    // Position offset
    vec2 layerCoord = scaled - vec2(u_transform.x, u_isAdjustment > 0.5 ? u_transform.y : -u_transform.y);
    vec4 lA = texture2D(u_layerA, layerCoord);
    vec4 lB = texture2D(u_layerB, layerCoord);
    vec3 layer = mix(lA.rgb, lB.rgb, u_layerBlend);

    // Apply per-channel RGB multipliers and black fade
    layer.r *= u_red;
    layer.g *= u_green;
    layer.b *= u_blue;
    layer *= (1.0 - u_black);

    // Apply saturation + hue shift (share HSV conversion when both active)
    if (abs(u_saturation - 1.0) > 0.001 || u_hueShift > 0.001) {
      vec3 hsv = rgb2hsv(layer);
      if (abs(u_saturation - 1.0) > 0.001) hsv.y = clamp(hsv.y * u_saturation, 0.0, 1.0);
      if (u_hueShift > 0.001) hsv.x = fract(hsv.x + u_hueShift);
      layer = hsv2rgb(hsv);
    }

    if (u_invert > 0.001) { layer = mix(layer, vec3(1.0) - layer, u_invert); }

    // Brightness (offset), Contrast (scale around 0.5), Exposure (2^stops)
    if (abs(u_brightness) > 0.001) { layer += u_brightness; }
    if (abs(u_contrast - 1.0) > 0.001) { layer = (layer - 0.5) * u_contrast + 0.5; }
    if (abs(u_exposure) > 0.001) { layer *= pow(2.0, u_exposure); }

    // Radial mask — applied to layer before blending so masked areas are transparent
    float maskAlpha = 1.0;
    if (u_maskRadius < 0.999) {
      vec2 d = (v_texCoord - u_maskCenter) * vec2(1.0, 1.0 / u_aspectRatio);
      float dist = length(d);
      float inner = u_maskRadius * (1.0 - u_maskFeather);
      maskAlpha = 1.0 - smoothstep(inner, u_maskRadius, dist);
    }
    float effectiveOpacity = u_opacity * maskAlpha;

    // Chroma key: compute per-pixel alpha (0 = keyed out, 1 = visible)
    float chromaAlpha = 1.0;
    if (u_hasChromaKey > 0.5) {
      float cdist = distance(layer, u_keyColor);
      chromaAlpha = smoothstep(u_keyThreshold, u_keyThreshold + u_keyFeather, cdist);
    }
    float finalAlpha = effectiveOpacity * chromaAlpha;

    // Blend mode identity: what the layer should become when fully masked out
    // For multiply: identity is white (base * 1 = base)
    // For all others: mix(base, blended, 0) = base, so identity doesn't matter
    if (u_blendMode == 1) { layer = mix(vec3(1.0), layer, maskAlpha); }  // multiply: fade to white

    vec3 blended;
    if (u_blendMode == 1) { blended = base.rgb * layer; }                                      // multiply
    else if (u_blendMode == 2) { blended = 1.0 - (1.0 - base.rgb) * (1.0 - layer); }          // screen
    else if (u_blendMode == 3) { blended = mix(2.0*base.rgb*layer, 1.0-2.0*(1.0-base.rgb)*(1.0-layer), step(0.5, base.rgb)); } // overlay
    else if (u_blendMode == 4) { blended = abs(base.rgb - layer); }                            // difference
    else if (u_blendMode == 5) { blended = min(base.rgb + layer, 1.0); }                       // add
    else if (u_blendMode == 6) { blended = layer; }                                            // chroma-key (legacy: treat as normal, chroma applied via finalAlpha)
    else if (u_blendMode == 7) {                                                                // soft-light (W3C spec)
      vec3 D = mix(
        ((16.0 * base.rgb - 12.0) * base.rgb + 4.0) * base.rgb,
        sqrt(base.rgb),
        step(0.25, base.rgb)
      );
      blended = mix(
        base.rgb - (1.0 - 2.0 * layer) * base.rgb * (1.0 - base.rgb),
        base.rgb + (2.0 * layer - 1.0) * (D - base.rgb),
        step(0.5, layer)
      );
    }
    else { blended = layer; }                                                                   // normal

    gl_FragColor = vec4(mix(base.rgb, blended, finalAlpha), 1.0);
  }
`

const BLEND_MODE_MAP: Record<string, number> = {
  normal: 0, multiply: 1, screen: 2, overlay: 3, difference: 4, add: 5, 'chroma-key': 6, 'soft-light': 7,
}

// ── Phase 3: Shader variant cache ──
// Build fragment shaders on demand keyed by active-effect bitmask. Each variant
// contains only the code for its active features, eliminating dead branches and
// reducing register pressure. Variants are cached forever (expect ~20-60 total
// across a typical editing session).
type ShaderFlags = {
  chromaKey: boolean
  saturation: boolean
  hueShift: boolean
  brightness: boolean
  contrast: boolean
  exposure: boolean
  invert: boolean
  mask: boolean
  rgbMult: boolean       // any of red/green/blue/black non-default
  blendMode: number      // 0-7 (encoded in shader via #define)
  isAdjustment: boolean  // changes texture lookup path
}

function shaderFlagsKey(f: ShaderFlags): string {
  return `${f.blendMode}|${+f.isAdjustment}|${+f.chromaKey}${+f.saturation}${+f.hueShift}${+f.brightness}${+f.contrast}${+f.exposure}${+f.invert}${+f.mask}${+f.rgbMult}`
}

function shaderFlagsForLayer(layer: {
  blendMode: string; red: number; green: number; blue: number; black: number;
  saturation: number; hueShift: number; invert: number; brightness: number; contrast: number; exposure: number;
  mask?: unknown; chromaKey?: unknown; isAdjustment?: boolean
}): ShaderFlags {
  return {
    chromaKey: !!layer.chromaKey,
    saturation: Math.abs(layer.saturation - 1) > 0.001,
    hueShift: layer.hueShift > 0.001,
    brightness: Math.abs(layer.brightness) > 0.001,
    contrast: Math.abs(layer.contrast - 1) > 0.001,
    exposure: Math.abs(layer.exposure) > 0.001,
    invert: layer.invert > 0.001,
    mask: !!layer.mask,
    rgbMult: Math.abs(layer.red - 1) > 0.001 || Math.abs(layer.green - 1) > 0.001 ||
             Math.abs(layer.blue - 1) > 0.001 || Math.abs(layer.black) > 0.001,
    blendMode: BLEND_MODE_MAP[layer.blendMode] ?? 0,
    isAdjustment: !!layer.isAdjustment,
  }
}

// Shared helper functions (only included when needed)
const HSV_HELPERS = `
  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
  }
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
`

function buildBlendChunk(mode: number): string {
  switch (mode) {
    case 1: return `layer = mix(vec3(1.0), layer, maskAlpha); blended = base.rgb * layer;`  // multiply
    case 2: return `blended = 1.0 - (1.0 - base.rgb) * (1.0 - layer);`  // screen
    case 3: return `blended = mix(2.0*base.rgb*layer, 1.0-2.0*(1.0-base.rgb)*(1.0-layer), step(0.5, base.rgb));`  // overlay
    case 4: return `blended = abs(base.rgb - layer);`  // difference
    case 5: return `blended = min(base.rgb + layer, 1.0);`  // add
    case 6: return `blended = layer;`  // chroma-key (alpha applied via finalAlpha)
    case 7: return `
      vec3 D = mix(((16.0 * base.rgb - 12.0) * base.rgb + 4.0) * base.rgb, sqrt(base.rgb), step(0.25, base.rgb));
      blended = mix(base.rgb - (1.0 - 2.0 * layer) * base.rgb * (1.0 - base.rgb), base.rgb + (2.0 * layer - 1.0) * (D - base.rgb), step(0.5, layer));
    `
    default: return `blended = layer;`  // normal
  }
}

function buildFragmentShader(f: ShaderFlags): string {
  const needHSV = f.saturation || f.hueShift
  return `
  precision mediump float;
  varying vec2 v_texCoord;
  uniform sampler2D u_base;
  uniform sampler2D u_layerA;
  uniform sampler2D u_layerB;
  uniform float u_layerBlend;
  uniform float u_opacity;
  ${f.rgbMult ? 'uniform float u_red; uniform float u_green; uniform float u_blue; uniform float u_black;' : ''}
  ${f.saturation ? 'uniform float u_saturation;' : ''}
  ${f.hueShift ? 'uniform float u_hueShift;' : ''}
  ${f.invert ? 'uniform float u_invert;' : ''}
  ${f.brightness ? 'uniform float u_brightness;' : ''}
  ${f.contrast ? 'uniform float u_contrast;' : ''}
  ${f.exposure ? 'uniform float u_exposure;' : ''}
  ${f.chromaKey ? 'uniform vec3 u_keyColor; uniform float u_keyThreshold; uniform float u_keyFeather;' : ''}
  ${f.mask ? 'uniform vec2 u_maskCenter; uniform float u_maskRadius; uniform float u_maskFeather; uniform float u_aspectRatio;' : ''}
  uniform vec2 u_transform;
  uniform float u_scale;
  uniform vec2 u_anchor;
  ${needHSV ? HSV_HELPERS : ''}
  void main() {
    vec4 base = texture2D(u_base, v_texCoord);
    vec2 baseCoord = ${f.isAdjustment ? 'v_texCoord' : 'vec2(v_texCoord.x, 1.0 - v_texCoord.y)'};
    vec2 scaled = (baseCoord - u_anchor) / u_scale + u_anchor;
    vec2 layerCoord = scaled - vec2(u_transform.x, ${f.isAdjustment ? 'u_transform.y' : '-u_transform.y'});
    vec4 lA = texture2D(u_layerA, layerCoord);
    vec4 lB = texture2D(u_layerB, layerCoord);
    vec3 layer = mix(lA.rgb, lB.rgb, u_layerBlend);
    ${f.rgbMult ? 'layer.r *= u_red; layer.g *= u_green; layer.b *= u_blue; layer *= (1.0 - u_black);' : ''}
    ${needHSV ? `
      vec3 hsv = rgb2hsv(layer);
      ${f.saturation ? 'hsv.y = clamp(hsv.y * u_saturation, 0.0, 1.0);' : ''}
      ${f.hueShift ? 'hsv.x = fract(hsv.x + u_hueShift);' : ''}
      layer = hsv2rgb(hsv);
    ` : ''}
    ${f.invert ? 'layer = mix(layer, vec3(1.0) - layer, u_invert);' : ''}
    ${f.brightness ? 'layer += u_brightness;' : ''}
    ${f.contrast ? 'layer = (layer - 0.5) * u_contrast + 0.5;' : ''}
    ${f.exposure ? 'layer *= pow(2.0, u_exposure);' : ''}
    float maskAlpha = 1.0;
    ${f.mask ? `
      vec2 mdist = (v_texCoord - u_maskCenter) * vec2(1.0, 1.0 / u_aspectRatio);
      float mlen = length(mdist);
      float minner = u_maskRadius * (1.0 - u_maskFeather);
      maskAlpha = 1.0 - smoothstep(minner, u_maskRadius, mlen);
    ` : ''}
    float effectiveOpacity = u_opacity * maskAlpha;
    float chromaAlpha = 1.0;
    ${f.chromaKey ? `
      float cdist = distance(layer, u_keyColor);
      chromaAlpha = smoothstep(u_keyThreshold, u_keyThreshold + u_keyFeather, cdist);
    ` : ''}
    float finalAlpha = effectiveOpacity * chromaAlpha;
    vec3 blended;
    ${buildBlendChunk(f.blendMode)}
    gl_FragColor = vec4(mix(base.rgb, blended, finalAlpha), 1.0);
  }
  `
}

type VariantProgram = {
  program: WebGLProgram
  locs: CompLocs
}

function compileVariant(gl: WebGLRenderingContext, vs: WebGLShader, flags: ShaderFlags): VariantProgram | null {
  const src = buildFragmentShader(flags)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)
  if (!fs) return null
  gl.shaderSource(fs, src)
  gl.compileShader(fs)
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    console.error('[shader variant] compile failed:', gl.getShaderInfoLog(fs), '\nsource:', src)
    gl.deleteShader(fs)
    return null
  }
  const program = gl.createProgram()
  if (!program) { gl.deleteShader(fs); return null }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.bindAttribLocation(program, 0, 'a_position')
  gl.bindAttribLocation(program, 1, 'a_texCoord')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[shader variant] link failed:', gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    gl.deleteShader(fs)
    return null
  }
  const locs: CompLocs = {
    u_base: gl.getUniformLocation(program, 'u_base'),
    u_layerA: gl.getUniformLocation(program, 'u_layerA'),
    u_layerB: gl.getUniformLocation(program, 'u_layerB'),
    u_layerBlend: gl.getUniformLocation(program, 'u_layerBlend'),
    u_opacity: gl.getUniformLocation(program, 'u_opacity'),
    u_red: gl.getUniformLocation(program, 'u_red'),
    u_green: gl.getUniformLocation(program, 'u_green'),
    u_blue: gl.getUniformLocation(program, 'u_blue'),
    u_black: gl.getUniformLocation(program, 'u_black'),
    u_saturation: gl.getUniformLocation(program, 'u_saturation'),
    u_hueShift: gl.getUniformLocation(program, 'u_hueShift'),
    u_invert: gl.getUniformLocation(program, 'u_invert'),
    u_brightness: gl.getUniformLocation(program, 'u_brightness'),
    u_contrast: gl.getUniformLocation(program, 'u_contrast'),
    u_exposure: gl.getUniformLocation(program, 'u_exposure'),
    u_blendMode: null,  // variants bake in the blend mode, no uniform needed
    u_hasChromaKey: null,  // variants bake chroma-key presence
    u_keyColor: gl.getUniformLocation(program, 'u_keyColor'),
    u_keyThreshold: gl.getUniformLocation(program, 'u_keyThreshold'),
    u_keyFeather: gl.getUniformLocation(program, 'u_keyFeather'),
    u_maskCenter: gl.getUniformLocation(program, 'u_maskCenter'),
    u_maskRadius: gl.getUniformLocation(program, 'u_maskRadius'),
    u_maskFeather: gl.getUniformLocation(program, 'u_maskFeather'),
    u_aspectRatio: gl.getUniformLocation(program, 'u_aspectRatio'),
    u_transform: gl.getUniformLocation(program, 'u_transform'),
    u_scale: gl.getUniformLocation(program, 'u_scale'),
    u_anchor: gl.getUniformLocation(program, 'u_anchor'),
    u_isAdjustment: null,  // variants bake adjustment flag
  }
  return { program, locs }
}

// Map detailed AI effect names to suppression categories
const EFFECT_TO_CATEGORY: Record<string, EffectType> = {
  zoom_pulse: 'zoom', zoom_bounce: 'zoom', zoom: 'zoom',
  shake_x: 'shake', shake_y: 'shake', shake: 'shake',
  contrast_pop: 'pulse', // contrast maps to pulse category
  glow_swell: 'glow', glow: 'glow',
  flash: 'flash', hard_cut: 'flash',
  echo: 'echo', echo_pulse: 'echo',
  pulse: 'pulse',
}

function isTimeSuppressed(time: number, suppressions: BeatSuppression[], effectType?: string, isLayered?: boolean): boolean {
  return suppressions.some((s) => {
    if (time < s.from || time > s.to) return false
    const category = effectType ? (EFFECT_TO_CATEGORY[effectType] || effectType) as EffectType : undefined

    if (isLayered) {
      // Layered: only suppressed if layerEffectTypes is set and includes this type
      if (!s.layerEffectTypes || s.layerEffectTypes.length === 0) return false
      if (!category) return false
      return s.layerEffectTypes.includes(category) || s.layerEffectTypes.includes(effectType as EffectType)
    }

    // Primary: check effectTypes (undefined = suppress all primary)
    if (!s.effectTypes || s.effectTypes.length === 0) return true
    if (!category) return true
    return s.effectTypes.includes(category) || s.effectTypes.includes(effectType as EffectType)
  })
}

function findEffectIntensity(
  beats: Beat[],
  audioEvents: AudioEvent[],
  userEffects: UserEffect[],
  suppressions: BeatSuppression[],
  time: number,
): EffectValues {
  const fx: EffectValues = { zoom: 0, shakeX: 0, shakeY: 0, contrastPop: 0, glowSwell: 0, flash: 0, echo: 0 }

  function addEffect(effect: string, value: number) {
    if (effect === 'zoom_pulse' || effect === 'zoom_bounce' || effect === 'zoom') fx.zoom = Math.max(fx.zoom, value)
    else if (effect === 'shake_x') fx.shakeX = Math.max(fx.shakeX, value) * (Math.sin(time * 40) > 0 ? 1 : -1)
    else if (effect === 'shake_y') fx.shakeY = Math.max(Math.abs(fx.shakeY), value) * (Math.cos(time * 35) > 0 ? 1 : -1)
    else if (effect === 'shake') { fx.shakeX = Math.max(Math.abs(fx.shakeX), value * 0.7) * (Math.sin(time * 40) > 0 ? 1 : -1); fx.shakeY = Math.max(Math.abs(fx.shakeY), value * 0.7) * (Math.cos(time * 35) > 0 ? 1 : -1) }
    else if (effect === 'contrast_pop') fx.contrastPop = Math.max(fx.contrastPop, value)
    else if (effect === 'glow_swell' || effect === 'glow') fx.glowSwell = Math.max(fx.glowSwell, value)
    else if (effect === 'flash') fx.flash = Math.max(fx.flash, value)
    else if (effect === 'echo' || effect === 'echo_pulse') fx.echo = Math.max(fx.echo, value)
    else if (effect === 'pulse') fx.zoom = Math.max(fx.zoom, value) // legacy
    else fx.zoom = Math.max(fx.zoom, value * 0.5) // unknown → mild zoom
  }

  // Audio intelligence events
  if (audioEvents.length > 0) {
    let lo = 0, hi = audioEvents.length - 1
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (audioEvents[mid].time <= time) lo = mid + 1; else hi = mid - 1 }
    for (let i = hi; i >= Math.max(0, hi - 8); i--) {
      const ev = audioEvents[i]
      const dist = time - ev.time
      if (dist < 0) continue
      if (dist > ev.duration + 0.1) break
      if (isTimeSuppressed(time, suppressions, ev.effect, ev.isLayered)) continue
      if (dist <= ev.duration) {
        const decay = Math.max(0, 1 - dist / ev.duration)
        addEffect(ev.effect, ev.intensity * decay * decay)
      }
    }
  } else if (beats.length > 0 && !isTimeSuppressed(time, suppressions)) {
    let lo = 0, hi = beats.length - 1
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (beats[mid].time <= time) lo = mid + 1; else hi = mid - 1 }
    if (hi >= 0) {
      const dist = time - beats[hi].time
      if (dist <= 0.3) {
        const decay = Math.max(0, 1 - dist / 0.2)
        addEffect('zoom_pulse', beats[hi].intensity * decay * decay)
      }
    }
  }

  // User effects
  for (const ufx of userEffects) {
    const dist = time - ufx.time
    if (dist >= 0 && dist <= ufx.duration) {
      const decay = Math.max(0, 1 - dist / ufx.duration)
      addEffect(ufx.type, ufx.intensity * decay * decay)
    }
  }

  return fx
}

type EffectValues = { zoom: number; shakeX: number; shakeY: number; contrastPop: number; glowSwell: number; flash: number; echo: number }

// Phase 1 optimization: per-layer texture slot
// Pre-allocated texture storage + identity-skip upload via texSubImage2D
type LayerSlot = {
  tex: WebGLTexture
  w: number
  h: number
  lastSource: TexImageSource | null
}

type CompLocs = {
  u_base: WebGLUniformLocation | null
  u_layerA: WebGLUniformLocation | null
  u_layerB: WebGLUniformLocation | null
  u_layerBlend: WebGLUniformLocation | null
  u_opacity: WebGLUniformLocation | null
  u_red: WebGLUniformLocation | null
  u_green: WebGLUniformLocation | null
  u_blue: WebGLUniformLocation | null
  u_black: WebGLUniformLocation | null
  u_saturation: WebGLUniformLocation | null
  u_hueShift: WebGLUniformLocation | null
  u_invert: WebGLUniformLocation | null
  u_brightness: WebGLUniformLocation | null
  u_contrast: WebGLUniformLocation | null
  u_exposure: WebGLUniformLocation | null
  u_blendMode: WebGLUniformLocation | null
  u_hasChromaKey: WebGLUniformLocation | null
  u_keyColor: WebGLUniformLocation | null
  u_keyThreshold: WebGLUniformLocation | null
  u_keyFeather: WebGLUniformLocation | null
  u_maskCenter: WebGLUniformLocation | null
  u_maskRadius: WebGLUniformLocation | null
  u_maskFeather: WebGLUniformLocation | null
  u_aspectRatio: WebGLUniformLocation | null
  u_transform: WebGLUniformLocation | null
  u_scale: WebGLUniformLocation | null
  u_anchor: WebGLUniformLocation | null
  u_isAdjustment: WebGLUniformLocation | null
}

/**
 * Get or create a texture slot for a layer.
 * Reallocates storage if dimensions changed.
 */
function getOrCreateLayerSlot(
  gl: WebGLRenderingContext,
  slots: Map<string, LayerSlot>,
  key: string,
  w: number,
  h: number,
): LayerSlot {
  let slot = slots.get(key)
  if (slot && (slot.w !== w || slot.h !== h)) {
    // Dimensions changed — reallocate
    gl.deleteTexture(slot.tex)
    slot = undefined
  }
  if (!slot) {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    // Allocate storage once — per-frame uploads will use texSubImage2D
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    slot = { tex, w, h, lastSource: null }
    slots.set(key, slot)
  }
  return slot
}

/**
 * Upload a frame to a layer slot. Skips upload if the source reference is unchanged (identity skip).
 * Uses texSubImage2D for zero-alloc in-place update.
 */
function uploadLayerFrame(gl: WebGLRenderingContext, slot: LayerSlot, source: TexImageSource) {
  if (slot.lastSource === source) return  // identity skip — no upload needed
  gl.bindTexture(gl.TEXTURE_2D, slot.tex)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source)
  slot.lastSource = source
}

function getSourceDims(source: TexImageSource): { w: number; h: number } {
  if (source instanceof HTMLVideoElement) return { w: source.videoWidth, h: source.videoHeight }
  if (source instanceof HTMLImageElement) return { w: source.naturalWidth, h: source.naturalHeight }
  // ImageBitmap, HTMLCanvasElement, OffscreenCanvas, ImageData
  return { w: (source as { width: number }).width, h: (source as { height: number }).height }
}

export type BeatEffectPreviewHandle = {
  getCanvas: () => HTMLCanvasElement | null
}

export const BeatEffectPreview = forwardRef<BeatEffectPreviewHandle, BeatEffectPreviewProps>(function BeatEffectPreview({ src, beats, audioEvents = [], userEffects = [], suppressions = [], currentTime, isPlaying, className, canvasWidth = 256, canvasHeight = 144, transitionFrameA, transitionFrameB, blendFactor = 0, layers }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useImperativeHandle(ref, () => ({
    getCanvas: () => canvasRef.current,
  }), [])
  const glRef = useRef<{
    gl: WebGLRenderingContext
    program: WebGLProgram
    textureA: WebGLTexture
    textureB: WebGLTexture
    blendLoc: WebGLUniformLocation
    zoomLoc: WebGLUniformLocation
    shakeXLoc: WebGLUniformLocation
    shakeYLoc: WebGLUniformLocation
    contrastPopLoc: WebGLUniformLocation
    glowSwellLoc: WebGLUniformLocation
    flashLoc: WebGLUniformLocation
    echoLoc: WebGLUniformLocation
    flipYLoc: WebGLUniformLocation
    // Compositor
    compProgram: WebGLProgram
    compBaseTex: WebGLTexture
    compFbo: WebGLFramebuffer
    compAccumTex: WebGLTexture
    compFbo2: WebGLFramebuffer
    compAccumTex2: WebGLTexture
    blackTex: WebGLTexture
    // Per-layer texture slot pool (Phase 1 optimization)
    // Maps (layer index + 'A'|'B') → slot for identity-skip + zero-alloc upload
    layerSlots: Map<string, LayerSlot>
    // Cached compositor uniform locations (set once at program link)
    compLocs: CompLocs
    // Phase 3: shader variant cache (keyed by flags bitmask — see shaderFlagsKey)
    // Variants compile lazily on first use and are cached forever.
    // Infrastructure is ready; hot-path integration deferred pending Phase 1 measurement.
    variantCache: Map<string, VariantProgram>
    compVs: WebGLShader  // shared vertex shader for variant compilation
  } | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const animRef = useRef<number>(0)
  const currentSrc = useRef('')

  const initGL = useCallback((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: false })
    if (!gl) return null

    // Phase 1: set pixel store state once (toggling forces bitmap re-decode in Chromium)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)

    // Compile shaders
    const vs = gl.createShader(gl.VERTEX_SHADER)!
    gl.shaderSource(vs, VERTEX_SHADER)
    gl.compileShader(vs)

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!
    gl.shaderSource(fs, FRAGMENT_SHADER)
    gl.compileShader(fs)

    const program = gl.createProgram()!
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.bindAttribLocation(program, 0, 'a_position')
    gl.bindAttribLocation(program, 1, 'a_texCoord')
    gl.linkProgram(program)
    gl.useProgram(program)

    // Quad vertices (position + texcoord)
    const posLoc = gl.getAttribLocation(program, 'a_position')
    const texLoc = gl.getAttribLocation(program, 'a_texCoord')

    const posBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

    const texBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0, 1, 0, 0, 1,
      0, 1, 1, 0, 1, 1,
    ]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(texLoc)
    gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0)

    // Create two textures for crossfade blending
    const textureA = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, textureA)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    const textureB = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, textureB)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    // Bind sampler uniforms to texture units
    gl.uniform1i(gl.getUniformLocation(program, 'u_imageA'), 0)
    gl.uniform1i(gl.getUniformLocation(program, 'u_imageB'), 1)

    // ── Compositor program ───────────────────────────────────
    const compVs = gl.createShader(gl.VERTEX_SHADER)!
    gl.shaderSource(compVs, VERTEX_SHADER)
    gl.compileShader(compVs)
    const compFs = gl.createShader(gl.FRAGMENT_SHADER)!
    gl.shaderSource(compFs, COMPOSITE_SHADER)
    gl.compileShader(compFs)
    const compProgram = gl.createProgram()!
    gl.attachShader(compProgram, compVs)
    gl.attachShader(compProgram, compFs)
    gl.bindAttribLocation(compProgram, 0, 'a_position')
    gl.bindAttribLocation(compProgram, 1, 'a_texCoord')
    gl.linkProgram(compProgram)

    // FBO helper
    function makeFbo() {
      const tex = gl!.createTexture()!
      gl!.bindTexture(gl!.TEXTURE_2D, tex)
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, canvas.width, canvas.height, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
      const fbo = gl!.createFramebuffer()!
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo)
      gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, tex, 0)
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null)
      return { fbo, tex }
    }
    const accum1 = makeFbo()
    const accum2 = makeFbo()

    // 1x1 black texture for empty layers (kf/tr with no video)
    const blackTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, blackTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    // Phase 1: cache all compositor uniform locations once (avoid per-draw lookup)
    const compLocs: CompLocs = {
      u_base: gl.getUniformLocation(compProgram, 'u_base'),
      u_layerA: gl.getUniformLocation(compProgram, 'u_layerA'),
      u_layerB: gl.getUniformLocation(compProgram, 'u_layerB'),
      u_layerBlend: gl.getUniformLocation(compProgram, 'u_layerBlend'),
      u_opacity: gl.getUniformLocation(compProgram, 'u_opacity'),
      u_red: gl.getUniformLocation(compProgram, 'u_red'),
      u_green: gl.getUniformLocation(compProgram, 'u_green'),
      u_blue: gl.getUniformLocation(compProgram, 'u_blue'),
      u_black: gl.getUniformLocation(compProgram, 'u_black'),
      u_saturation: gl.getUniformLocation(compProgram, 'u_saturation'),
      u_hueShift: gl.getUniformLocation(compProgram, 'u_hueShift'),
      u_invert: gl.getUniformLocation(compProgram, 'u_invert'),
      u_brightness: gl.getUniformLocation(compProgram, 'u_brightness'),
      u_contrast: gl.getUniformLocation(compProgram, 'u_contrast'),
      u_exposure: gl.getUniformLocation(compProgram, 'u_exposure'),
      u_blendMode: gl.getUniformLocation(compProgram, 'u_blendMode'),
      u_hasChromaKey: gl.getUniformLocation(compProgram, 'u_hasChromaKey'),
      u_keyColor: gl.getUniformLocation(compProgram, 'u_keyColor'),
      u_keyThreshold: gl.getUniformLocation(compProgram, 'u_keyThreshold'),
      u_keyFeather: gl.getUniformLocation(compProgram, 'u_keyFeather'),
      u_maskCenter: gl.getUniformLocation(compProgram, 'u_maskCenter'),
      u_maskRadius: gl.getUniformLocation(compProgram, 'u_maskRadius'),
      u_maskFeather: gl.getUniformLocation(compProgram, 'u_maskFeather'),
      u_aspectRatio: gl.getUniformLocation(compProgram, 'u_aspectRatio'),
      u_transform: gl.getUniformLocation(compProgram, 'u_transform'),
      u_scale: gl.getUniformLocation(compProgram, 'u_scale'),
      u_anchor: gl.getUniformLocation(compProgram, 'u_anchor'),
      u_isAdjustment: gl.getUniformLocation(compProgram, 'u_isAdjustment'),
    }

    return {
      gl,
      program,
      textureA,
      textureB,
      blendLoc: gl.getUniformLocation(program, 'u_blend')!,
      zoomLoc: gl.getUniformLocation(program, 'u_zoom')!,
      shakeXLoc: gl.getUniformLocation(program, 'u_shakeX')!,
      shakeYLoc: gl.getUniformLocation(program, 'u_shakeY')!,
      contrastPopLoc: gl.getUniformLocation(program, 'u_contrastPop')!,
      glowSwellLoc: gl.getUniformLocation(program, 'u_glowSwell')!,
      flashLoc: gl.getUniformLocation(program, 'u_flash')!,
      echoLoc: gl.getUniformLocation(program, 'u_echo')!,
      flipYLoc: gl.getUniformLocation(program, 'u_flipY')!,
      compProgram,
      compBaseTex: textureA, // reuse for uploads
      compFbo: accum1.fbo,
      compAccumTex: accum1.tex,
      compFbo2: accum2.fbo,
      compAccumTex2: accum2.tex,
      blackTex,
      layerSlots: new Map<string, LayerSlot>(),
      compLocs,
      variantCache: new Map<string, VariantProgram>(),
      compVs,
    }
  }, [])

  // Variant cache infrastructure — preserved but not used in the render loop for now.
  // Reference these to prevent TS6133 unused-var errors until we re-enable variants.
  void shaderFlagsKey
  void shaderFlagsForLayer
  void compileVariant


  // Init WebGL on mount or when canvas dimensions change
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    glRef.current = initGL(canvas)
    return () => {
      cancelAnimationFrame(animRef.current)
    }
  }, [initGL, canvasWidth, canvasHeight])

  // Load image when src changes
  useEffect(() => {
    if (!src) {
      // No image — clear stale reference so we don't render the wrong keyframe
      imgRef.current = null
      currentSrc.current = ''
      return
    }
    if (src === currentSrc.current) return
    currentSrc.current = src

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imgRef.current = img
      // Draw once immediately — render() will upload via the layer slot pool
      render({ zoom: 0, shakeX: 0, shakeY: 0, contrastPop: 0, glowSwell: 0, flash: 0, echo: 0 }, 0)
    }
    img.src = src
  }, [src])

  const setEffectUniforms = useCallback((ctx: NonNullable<typeof glRef.current>, fx: EffectValues) => {
    const { gl } = ctx
    gl.uniform1f(ctx.zoomLoc, fx.zoom)
    gl.uniform1f(ctx.shakeXLoc, fx.shakeX)
    gl.uniform1f(ctx.shakeYLoc, fx.shakeY)
    gl.uniform1f(ctx.contrastPopLoc, fx.contrastPop)
    gl.uniform1f(ctx.glowSwellLoc, fx.glowSwell)
    gl.uniform1f(ctx.flashLoc, fx.flash)
    gl.uniform1f(ctx.echoLoc, fx.echo)
  }, [])

  const render = useCallback((fx: EffectValues, blend: number) => {
    const ctx = glRef.current
    if (!ctx) return
    const { gl } = ctx
    const canvas = canvasRef.current
    if (!canvas) return

    // ── Single render path: always go through FBO compositor ──
    // Build content layers from tracks, or fall back to legacy single-frame sources
    type ContentLayer = {
      frameA: TexImageSource | null
      frameB: TexImageSource | null
      blendFactor: number
      opacity: number
      red: number
      green: number
      blue: number
      black: number
      saturation: number
      hueShift: number
      invert: number
      brightness: number
      contrast: number
      exposure: number
      blendMode: string
      chromaKey?: { color: number[]; threshold: number; feather: number }
      isAdjustment?: boolean
      mask?: { centerX: number; centerY: number; radius: number; feather: number }
      transform?: { x: number; y: number; scale?: number; anchorX?: number; anchorY?: number }
    }
    const contentLayers: ContentLayer[] = []

    if (layers && layers.length > 0) {
      for (const l of layers) {
        if (l.isAdjustment) {
          contentLayers.push({ frameA: null, frameB: null, blendFactor: 0, opacity: l.opacity, red: l.red ?? 1, green: l.green ?? 1, blue: l.blue ?? 1, black: l.black ?? 0, saturation: l.saturation ?? 1, hueShift: l.hueShift ?? 0, invert: l.invert ?? 0, brightness: l.brightness ?? 0, contrast: l.contrast ?? 1, exposure: l.exposure ?? 0, blendMode: 'normal', isAdjustment: true, mask: l.mask, transform: l.transform })
        } else if (l.frameA) {
          contentLayers.push({ frameA: l.frameA, frameB: l.frameB || l.frameA, blendFactor: l.blendFactor, opacity: l.opacity, red: l.red ?? 1, green: l.green ?? 1, blue: l.blue ?? 1, black: l.black ?? 0, saturation: l.saturation ?? 1, hueShift: l.hueShift ?? 0, invert: l.invert ?? 0, brightness: l.brightness ?? 0, contrast: l.contrast ?? 1, exposure: l.exposure ?? 0, blendMode: l.blendMode, chromaKey: l.chromaKey as never, mask: l.mask, transform: l.transform })
        }
      }
    }
    // Fallback: no track layers have content — use legacy sources
    if (contentLayers.length === 0) {
      const fallbackA = transitionFrameA || imgRef.current
      if (!fallbackA) return
      contentLayers.push({ frameA: fallbackA, frameB: transitionFrameB || fallbackA, blendFactor: blend, opacity: 1, red: 1, green: 1, blue: 1, black: 0, saturation: 1, hueShift: 0, invert: 0, brightness: 0, contrast: 1, exposure: 0, blendMode: 'normal' })
    }

    // ── Phase 1: upload pass first (pipelined with prior-frame rendering) ──
    // For each layer, allocate a texture slot of the right size and upload the frame
    // with identity-skip (same ImageBitmap reference = no upload). Uses texSubImage2D
    // (zero-alloc) after the initial texImage2D.
    const slotsForLayers: (LayerSlot | null)[] = new Array(contentLayers.length * 2)
    for (let i = 0; i < contentLayers.length; i++) {
      const layer = contentLayers[i]
      if (layer.isAdjustment || !layer.frameA) {
        slotsForLayers[i * 2] = null
        slotsForLayers[i * 2 + 1] = null
        continue
      }
      // Frame A
      const dimsA = getSourceDims(layer.frameA)
      if (dimsA.w > 0 && dimsA.h > 0) {
        const slotA = getOrCreateLayerSlot(gl, ctx.layerSlots, `${i}:A`, dimsA.w, dimsA.h)
        uploadLayerFrame(gl, slotA, layer.frameA)
        slotsForLayers[i * 2] = slotA
      }
      // Frame B (if present and different from A)
      if (layer.frameB && layer.frameB !== layer.frameA) {
        const dimsB = getSourceDims(layer.frameB)
        if (dimsB.w > 0 && dimsB.h > 0) {
          const slotB = getOrCreateLayerSlot(gl, ctx.layerSlots, `${i}:B`, dimsB.w, dimsB.h)
          uploadLayerFrame(gl, slotB, layer.frameB)
          slotsForLayers[i * 2 + 1] = slotB
        }
      } else {
        slotsForLayers[i * 2 + 1] = slotsForLayers[i * 2]  // frame B = frame A
      }
    }

    // Clear FBO to black, then composite ALL layers (including base) via ping-pong
    gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.compFbo)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    let readIdx = 0
    const fbos = [ctx.compFbo, ctx.compFbo2]
    const texs = [ctx.compAccumTex, ctx.compAccumTex2]
    const aspectRatio = canvas.width / canvas.height

    // Use monolithic compositor shader — variant cache infrastructure exists but is
    // disabled in the render loop for stability. Re-enable via variantCache once
    // crash reports are resolved. See Task 31 / 32.
    gl.useProgram(ctx.compProgram)
    const locs = ctx.compLocs
    // Sampler units are program state — bind once per program use
    gl.uniform1i(locs.u_base, 0)
    gl.uniform1i(locs.u_layerA, 1)
    gl.uniform1i(locs.u_layerB, 2)

    for (let i = 0; i < contentLayers.length; i++) {
      const layer = contentLayers[i]
      const writeIdx = 1 - readIdx
      // Invariant: readIdx !== writeIdx (required for FBO read-after-write correctness on all drivers)

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[writeIdx])
      gl.viewport(0, 0, canvas.width, canvas.height)

      // unit 0 = accumulator (previous result) — bound to texs[readIdx], never texs[writeIdx]
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texs[readIdx])

      const slotA = slotsForLayers[i * 2]
      const slotB = slotsForLayers[i * 2 + 1]

      if (layer.isAdjustment) {
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, texs[readIdx])
        gl.activeTexture(gl.TEXTURE2)
        gl.bindTexture(gl.TEXTURE_2D, texs[readIdx])
      } else if (slotA && slotB) {
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, slotA.tex)
        gl.activeTexture(gl.TEXTURE2)
        gl.bindTexture(gl.TEXTURE_2D, slotB.tex)
      } else {
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, ctx.blackTex)
        gl.activeTexture(gl.TEXTURE2)
        gl.bindTexture(gl.TEXTURE_2D, ctx.blackTex)
      }

      // Upload uniforms (cached locations — no per-draw lookup)
      gl.uniform1f(locs.u_layerBlend, layer.blendFactor)
      gl.uniform1f(locs.u_opacity, layer.opacity)
      gl.uniform1f(locs.u_red, layer.red ?? 1)
      gl.uniform1f(locs.u_green, layer.green ?? 1)
      gl.uniform1f(locs.u_blue, layer.blue ?? 1)
      gl.uniform1f(locs.u_black, layer.black ?? 0)
      gl.uniform1f(locs.u_saturation, layer.saturation ?? 1)
      gl.uniform1f(locs.u_hueShift, layer.hueShift ?? 0)
      gl.uniform1f(locs.u_invert, layer.invert ?? 0)
      gl.uniform1f(locs.u_brightness, layer.brightness ?? 0)
      gl.uniform1f(locs.u_contrast, layer.contrast ?? 1)
      gl.uniform1f(locs.u_exposure, layer.exposure ?? 0)
      gl.uniform1i(locs.u_blendMode, BLEND_MODE_MAP[layer.blendMode] ?? 0)
      gl.uniform1f(locs.u_hasChromaKey, layer.chromaKey ? 1.0 : 0.0)
      gl.uniform1f(locs.u_isAdjustment, layer.isAdjustment ? 1.0 : 0.0)

      const ck = layer.chromaKey
      gl.uniform3f(locs.u_keyColor, ck?.color[0] ?? 0, ck?.color[1] ?? 1, ck?.color[2] ?? 0)
      gl.uniform1f(locs.u_keyThreshold, ck?.threshold ?? 0.3)
      gl.uniform1f(locs.u_keyFeather, ck?.feather ?? 0.1)

      const mask = layer.mask
      gl.uniform2f(locs.u_maskCenter, mask?.centerX ?? 0.5, mask?.centerY ?? 0.5)
      gl.uniform1f(locs.u_maskRadius, mask?.radius ?? 1.0)
      gl.uniform1f(locs.u_maskFeather, mask?.feather ?? 0.0)
      gl.uniform1f(locs.u_aspectRatio, aspectRatio)
      const tfm = layer.transform
      gl.uniform2f(locs.u_transform, tfm?.x ?? 0, tfm?.y ?? 0)
      gl.uniform1f(locs.u_scale, tfm?.scale ?? 1.0)
      gl.uniform2f(locs.u_anchor, tfm?.anchorX ?? 0.5, tfm?.anchorY ?? 0.5)

      gl.drawArrays(gl.TRIANGLES, 0, 6)
      readIdx = writeIdx
    }

    // Final pass: blit FBO result to screen with beat effects
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(ctx.program)
    gl.uniform1f(ctx.flipYLoc, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texs[readIdx])
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, texs[readIdx])
    gl.uniform1f(ctx.blendLoc, 0)
    setEffectUniforms(ctx, fx)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }, [transitionFrameA, transitionFrameB, layers, setEffectUniforms])

  // Render loop when playing
  useEffect(() => {
    if (!isPlaying) {
      render({ zoom: 0, shakeX: 0, shakeY: 0, contrastPop: 0, glowSwell: 0, flash: 0, echo: 0 }, blendFactor)
      return
    }

    const loop = () => {
      const effectValues = findEffectIntensity(beats, audioEvents, userEffects, suppressions, currentTime)
      render(effectValues, blendFactor)
      animRef.current = requestAnimationFrame(loop)
    }
    loop()

    return () => cancelAnimationFrame(animRef.current)
  }, [isPlaying, beats, audioEvents, userEffects, suppressions, currentTime, render, blendFactor])

  // Render on time changes when paused (seeking) or when frame/effects change
  useEffect(() => {
    if (isPlaying) return
    const effectValues = findEffectIntensity(beats, audioEvents, userEffects, suppressions, currentTime)
    render(effectValues, blendFactor)
  }, [currentTime, isPlaying, beats, audioEvents, userEffects, suppressions, render, transitionFrameA, transitionFrameB, blendFactor])

  return (
    <canvas
      ref={canvasRef}
      width={canvasWidth}
      height={canvasHeight}
      className={className}
    />
  )
})
