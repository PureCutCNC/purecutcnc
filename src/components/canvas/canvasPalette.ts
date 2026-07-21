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

import type { CanvasThemePalette } from '../../theme/palette'

// Defaults mirror the dark built-in so helpers invoked outside a render pass
// (e.g. focused unit tests) still get correct colours.
let current: CanvasThemePalette = {
  background: '#0f151d',
  gridMajor: 'rgba(104, 132, 154, 0.34)',
  gridMinor: 'rgba(88, 112, 130, 0.18)',
  labelBackground: 'rgba(18, 26, 36, 0.88)',
  labelText: 'rgba(218, 232, 244, 0.96)',
  mutedGeometry: 'rgba(210, 221, 230, 0.62)',
  veil: 'rgba(8, 12, 18, 0.5)',

  active: '#4ea3ef',
  activeStrong: '#9bd0ff',
  draft: '#5aa6e8',
  draftStrong: '#bfe0ff',

  featureCutFill: 'rgba(78, 126, 170, 0.42)',
  featureCutStroke: '#4e8dc1',
  featureAddFill: 'rgba(92, 165, 115, 0.43)',
  featureAddStroke: '#63b176',
  featureModelFill: 'rgba(188, 200, 212, 0.35)',
  featureModelStroke: '#bcc8d4',
  featureRegionFill: 'rgba(153, 102, 204, 0.30)',
  featureRegionStroke: '#9966cc',
  featureRegionExcludeStroke: '#b58adf',
  featureConstructionStroke: '#8a9aab',
  featureGroupFill: 'rgba(94, 196, 196, 0.30)',
  featureGroupStroke: '#5ec4c4',
  featureInfoText: 'rgba(228, 236, 244, 0.9)',
  featureInfoSubText: 'rgba(171, 194, 213, 0.9)',

  handleFill: '#9bc0dd',
  handleStroke: '#6f8fa9',
  nodeStroke: '#3f708f',
  vertexFill: 'rgba(210, 221, 230, 0.22)',
  vertexStroke: '#d2dde6',
  handleGuide: 'rgba(125, 159, 189, 0.55)',

  toolpathCut: 'rgba(255, 115, 92, 0.96)',
  toolpathRapid: 'rgba(124, 184, 222, 0.8)',
  toolpathPlunge: 'rgba(213, 131, 223, 0.95)',
  toolpathCollision: 'rgba(227, 91, 91, 0.95)',
  toolpathDirection: '#5ec4c4',

  dimensionLine: 'rgba(180, 200, 224, 0.85)',
  dimensionText: 'rgba(200, 220, 240, 0.65)',
  dimensionDriven: 'rgba(91, 216, 165, 0.92)',
  dimensionWarning: 'rgba(240, 120, 120, 0.9)',
  dimensionHighlight: 'rgba(120, 200, 255, 0.98)',

  originAxisX: '#e35b5b',
  originAxisY: '#63c07a',
  originCenter: '#5b90e3',

  clampFill: 'rgba(86, 110, 168, 0.14)',
  clampStroke: 'rgba(122, 151, 224, 0.88)',
  clampSelectedFill: 'rgba(118, 144, 209, 0.24)',
  clampSelectedStroke: '#9db9ff',
  clampCollidingFill: 'rgba(184, 98, 98, 0.18)',
  clampCollidingStroke: 'rgba(235, 122, 122, 0.92)',
  clampCollidingSelectedFill: 'rgba(209, 118, 118, 0.28)',
  clampCollidingSelectedStroke: '#ffb0b0',

  tabFill: 'rgba(128, 175, 82, 0.14)',
  tabStroke: 'rgba(156, 205, 103, 0.88)',
  tabSelectedFill: 'rgba(168, 208, 110, 0.24)',
  tabSelectedStroke: '#c7ef94',

  snapPerpendicular: 'rgba(170, 221, 255, 0.9)',
  editAddFill: '#5daeea',
  editAddStroke: '#a9d2f5',
  editDeleteFill: '#d66c6c',
  editDeleteStroke: '#efb0b0',
  editDisconnectFill: '#3bb3c4',
  editDisconnectStroke: '#9fe0e8',

  measurementBackdrop: 'rgba(15, 21, 29, 0.92)',
  measurementText: 'rgba(191, 224, 255, 0.96)',
  stockExceeded: 'rgba(207, 138, 224, 0.9)',
  invalidText: 'rgba(255, 180, 180, 0.95)',
  invalidBackdrop: 'rgba(80, 20, 20, 0.9)',
}

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
