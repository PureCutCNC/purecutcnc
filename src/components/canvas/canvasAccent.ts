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
 * Interaction-accent colors for the 2D sketch canvas, resolved from the active
 * theme.
 *
 * The canvas draws with `CanvasRenderingContext2D`, which cannot read CSS custom
 * properties, so these colors cannot come from `var(--accent)` the way the DOM
 * chrome does. They are theme tokens (`canvas.active`, `canvas.activeStrong`,
 * `canvas.draft`, `canvas.draftStrong`) — and therefore user-editable in the
 * Theme Editor — carried here through the palette. `SketchCanvas` calls
 * `setCanvasAccent` once at the top of each render pass; the primitive helpers
 * read `canvasAccent()` instead of the amber hexes they used to hardcode.
 *
 * A single per-frame module value is used rather than threading the palette
 * through ~90 call sites: the canvas has exactly one active theme per frame, and
 * the whole scene is repainted synchronously after `setCanvasAccent` runs.
 */

import type { CanvasThemePalette } from '../../theme/palette'

export interface CanvasAccent {
  /** Active/selected control fill. */
  active: string
  /** Active/selected control ring/stroke. */
  activeStrong: string
  /** Drawing/preview stroke while sketching. */
  draft: string
  /** Draft ring / close-target highlight. */
  draftStrong: string
}

// Defaults mirror the dark built-in so helpers invoked outside a render pass
// (e.g. focused unit tests) still get non-amber colors.
let current: CanvasAccent = {
  active: '#4ea3ef',
  activeStrong: '#9bd0ff',
  draft: '#5aa6e8',
  draftStrong: '#bfe0ff',
}

/** Adopt the active theme's canvas interaction accents for this render pass. */
export function setCanvasAccent(palette: CanvasThemePalette): void {
  current = {
    active: palette.active,
    activeStrong: palette.activeStrong,
    draft: palette.draft,
    draftStrong: palette.draftStrong,
  }
}

/** The canvas interaction accents resolved from the active theme. */
export function canvasAccent(): CanvasAccent {
  return current
}

/**
 * One of the current accents expressed as `rgba()` at the given alpha. Lets
 * primitive files build translucent accent washes without importing
 * `hexToRgba` from `previewPrimitives` (which would form an import cycle).
 */
export function accentRgba(color: keyof CanvasAccent, alpha: number): string {
  const hex = current[color].replace('#', '')
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
