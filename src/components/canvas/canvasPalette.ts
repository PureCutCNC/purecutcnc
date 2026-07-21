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
 * Themeable canvas colour palette, resolved from the active theme.
 *
 * The canvas draws with `CanvasRenderingContext2D`, which cannot read CSS custom
 * properties, so these colours cannot come from `var(--...)` the way the DOM
 * chrome does. They are theme tokens — and therefore user-editable in the Theme
 * Editor — carried here through the palette. `SketchCanvas` calls
 * `setCanvasPalette` once at the top of each render pass; every primitive helper
 * reads from this module instead of the hex literals it used to hardcode.
 *
 * A single per-frame module value is used rather than threading the palette
 * through ~90 call sites: the canvas has exactly one active theme per frame, and
 * the whole scene is repainted synchronously after `setCanvasPalette` runs.
 */

import { THEME_PALETTES, type CanvasThemePalette } from '../../theme/palette'

// Defaults come from the dark built-in so helpers invoked outside a render pass
// (e.g. focused unit tests) still get correct colours, and so the dark palette
// keeps exactly one definition.
let current: CanvasThemePalette = THEME_PALETTES.dark.canvas

/** Adopt the active theme's canvas palette for this render pass. */
export function setCanvasPalette(palette: CanvasThemePalette): void {
  current = palette
}

/** The full canvas palette resolved from the active theme. */
export function canvasColors(): CanvasThemePalette {
  return current
}

/** Extract {r,g,b} from a hex or rgba() colour string. */
function parseRgb(color: string): { r: number; g: number; b: number } {
  if (color.startsWith('#')) {
    const hex = color.replace('#', '')
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    }
  }
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color)
  if (match) {
    return {
      r: Number.parseInt(match[1], 10),
      g: Number.parseInt(match[2], 10),
      b: Number.parseInt(match[3], 10),
    }
  }
  return { r: 136, g: 153, b: 170 }
}

/**
 * One of the current palette colours expressed as `rgba()` at the given alpha.
 * Lets primitive files build translucent washes without importing `hexToRgba`
 * from `previewPrimitives` (which would form an import cycle).
 */
export function canvasRgba(key: keyof CanvasThemePalette, alpha: number): string {
  const { r, g, b } = parseRgb(current[key])
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
