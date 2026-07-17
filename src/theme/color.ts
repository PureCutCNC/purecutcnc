/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Color math for the theme system: parsing the allowlisted color formats,
 * normalizing to hex, WCAG contrast ratios (with alpha compositing), and a
 * perceptual distance used to warn when semantic colors become hard to tell
 * apart. No CSS keywords, gradients, or functions beyond rgb()/rgba() are
 * accepted — theme values stay plain colors by construction.
 */

export interface RgbaColor {
  /** 0–255 */
  r: number
  /** 0–255 */
  g: number
  /** 0–255 */
  b: number
  /** 0–1 */
  a: number
}

const HEX_PATTERN = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_PATTERN = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)))
}

function clampAlpha(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Parse a theme color value. Accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
 * `rgb(r, g, b)`, and `rgba(r, g, b, a)`. Returns `null` for anything else,
 * which callers treat as a validation failure.
 */
export function parseColor(value: string): RgbaColor | null {
  const trimmed = value.trim()

  const hexMatch = HEX_PATTERN.exec(trimmed)
  if (hexMatch) {
    const hex = hexMatch[1]
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16)
      const g = parseInt(hex[1] + hex[1], 16)
      const b = parseInt(hex[2] + hex[2], 16)
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1
      return { r, g, b, a }
    }
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return { r, g, b, a }
  }

  const rgbMatch = RGB_PATTERN.exec(trimmed)
  if (rgbMatch) {
    const r = Number(rgbMatch[1])
    const g = Number(rgbMatch[2])
    const b = Number(rgbMatch[3])
    if (![r, g, b].every((channel) => Number.isFinite(channel) && channel <= 255)) return null
    let a = 1
    if (rgbMatch[4] !== undefined) {
      const rawAlpha = rgbMatch[4]
      a = rawAlpha.endsWith('%') ? Number(rawAlpha.slice(0, -1)) / 100 : Number(rawAlpha)
      if (!Number.isFinite(a)) return null
    }
    return { r: clampChannel(r), g: clampChannel(g), b: clampChannel(b), a: clampAlpha(a) }
  }

  return null
}

function channelHex(value: number): string {
  return clampChannel(value).toString(16).padStart(2, '0')
}

/** Normalize to lowercase `#rrggbb`, or `#rrggbbaa` when alpha < 1. */
export function formatColor(color: RgbaColor): string {
  const base = `#${channelHex(color.r)}${channelHex(color.g)}${channelHex(color.b)}`
  if (color.a >= 1) return base
  return `${base}${channelHex(color.a * 255)}`
}

/** Normalize an accepted color string, or return `null` when unparseable. */
export function normalizeColorValue(value: string): string | null {
  const parsed = parseColor(value)
  return parsed ? formatColor(parsed) : null
}

/** The opaque `#rrggbb` part, for `<input type="color">` which cannot show alpha. */
export function opaqueHex(color: RgbaColor): string {
  return `#${channelHex(color.r)}${channelHex(color.g)}${channelHex(color.b)}`
}

/** Source-over composite of `fg` onto `bg`. `bg` is treated as opaque. */
export function compositeOver(fg: RgbaColor, bg: RgbaColor): RgbaColor {
  const a = fg.a + bg.a * (1 - fg.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  }
}

function linearChannel(channel: number): number {
  const srgb = channel / 255
  return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4)
}

/** WCAG 2.x relative luminance of an (assumed opaque) color. */
export function relativeLuminance(color: RgbaColor): number {
  return (
    0.2126 * linearChannel(color.r)
    + 0.7152 * linearChannel(color.g)
    + 0.0722 * linearChannel(color.b)
  )
}

/**
 * WCAG 2.x contrast ratio between a foreground and a background. Translucent
 * inputs are composited: the background stack must already be flattened to
 * opaque by the caller (see `flattenStack`), then the foreground is composited
 * over it before measuring.
 */
export function contrastRatio(fg: RgbaColor, bg: RgbaColor): number {
  const solidFg = fg.a < 1 ? compositeOver(fg, bg) : fg
  const fgLum = relativeLuminance(solidFg)
  const bgLum = relativeLuminance(bg)
  const lighter = Math.max(fgLum, bgLum)
  const darker = Math.min(fgLum, bgLum)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Flatten a stack of possibly-translucent layers (topmost first) into one
 * opaque color. The last layer acts as the base; any residual translucency
 * is composited over black to keep the result deterministic.
 */
export function flattenStack(layers: RgbaColor[]): RgbaColor {
  let result: RgbaColor = { r: 0, g: 0, b: 0, a: 1 }
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    result = compositeOver(layers[i], result)
  }
  return { ...result, a: 1 }
}

interface LabColor {
  l: number
  a: number
  b: number
}

function toLab(color: RgbaColor): LabColor {
  // sRGB → XYZ (D65) → CIELAB
  const rl = linearChannel(color.r)
  const gl = linearChannel(color.g)
  const bl = linearChannel(color.b)
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047
  const y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

/**
 * CIE76 ΔE between two colors (composited over `base` when translucent).
 * Used as a "can a user tell these apart" heuristic: values below ~12 are
 * hard to distinguish at small sizes.
 */
export function perceptualDistance(a: RgbaColor, b: RgbaColor, base: RgbaColor): number {
  const labA = toLab(a.a < 1 ? compositeOver(a, base) : a)
  const labB = toLab(b.a < 1 ? compositeOver(b, base) : b)
  return Math.sqrt(
    (labA.l - labB.l) ** 2 + (labA.a - labB.a) ** 2 + (labA.b - labB.b) ** 2,
  )
}
