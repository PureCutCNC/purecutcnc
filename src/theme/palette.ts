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

import type { ResolvedTheme } from './theme'
import type { Operation } from '../types/project'

/**
 * Every colour the 2D sketch canvas draws with. `CanvasRenderingContext2D`
 * cannot read CSS custom properties, so these are the canvas-side equivalent of
 * the `--*` tokens: one entry per semantic role, resolved per theme, and
 * user-editable through the Theme Editor.
 *
 * Renderers must read from here — a colour literal in a canvas renderer is a
 * bug (see the colour policy in `planning/THEME_TOKENIZATION_HANDOFF.md`).
 */
export interface CanvasThemePalette {
  // Surface, grid, and shared annotation colours.
  background: string
  gridMajor: string
  gridMinor: string
  labelBackground: string
  labelText: string
  mutedGeometry: string
  veil: string

  // Interaction accents: active/selected controls and in-progress drawing.
  active: string
  activeStrong: string
  draft: string
  draftStrong: string

  // Feature geometry by operation.
  featureCutFill: string
  featureCutStroke: string
  featureAddFill: string
  featureAddStroke: string
  featureModelFill: string
  featureModelStroke: string
  featureRegionFill: string
  featureRegionStroke: string
  featureRegionExcludeStroke: string
  featureConstructionStroke: string
  featureGroupFill: string
  featureGroupStroke: string
  featureInfoText: string
  featureInfoSubText: string

  // Sketch control points and handles.
  handleFill: string
  handleStroke: string
  nodeStroke: string
  vertexFill: string
  vertexStroke: string
  handleGuide: string

  // Toolpath move kinds (kept consistent with the 3D overlay and CSS legend).
  toolpathCut: string
  /** Slowest feed step of the feed-colour ramp (issue #498); intermediate
   *  steps are interpolated from toolpathCut. Dark themes go brighter. */
  toolpathCutSlow: string
  toolpathRapid: string
  toolpathPlunge: string
  toolpathCollision: string

  // Dimension annotations.
  dimensionLine: string
  dimensionText: string
  dimensionDriven: string
  dimensionWarning: string
  dimensionHighlight: string

  // Machine origin marker axes.
  originAxisX: string
  originAxisY: string
  originCenter: string

  // Clamp footprints.
  clampFill: string
  clampStroke: string
  clampSelectedFill: string
  clampSelectedStroke: string
  clampCollidingFill: string
  clampCollidingStroke: string
  clampCollidingSelectedFill: string
  clampCollidingSelectedStroke: string

  // Tab footprints.
  tabFill: string
  tabStroke: string
  tabSelectedFill: string
  tabSelectedStroke: string

  // Snapping and sketch-edit previews.
  snapPerpendicular: string
  editAddFill: string
  editAddStroke: string
  editDeleteFill: string
  editDeleteStroke: string
  editDisconnectFill: string
  editDisconnectStroke: string

  // Measurement/snap label chrome and validation states.
  measurementBackdrop: string
  measurementText: string
  stockExceeded: string
  invalidText: string
  invalidBackdrop: string

  // Sketch constraint overlays (anchor/reference picking and fixed distances).
  constraint: string
  constraintHighlight: string
  constraintInvalid: string
  /** Light halo drawn behind a marker so it reads on busy geometry. */
  markerHalo: string
  /** Dark outline drawn around a marker for the same reason. */
  markerOutline: string
}

export interface ThreeThemePalette {
  background: number
  gridMinorCenter: number
  gridMinor: number
  gridMajorCenter: number
  gridMajor: number
  /** Toolpath overlay colours; kept in step with the canvas + CSS legend. */
  toolpathCut: number
  /** Slowest feed step of the feed-colour ramp (issue #498); matches the
   *  canvas representation so both views render the same ramp. */
  toolpathCutSlow: number
  toolpathRapid: number
  toolpathPlunge: number
  /** Fallback stock material when the project defines no stock colour. */
  stockDefault: number
  /** Stock mesh material fallback (project has no stock colour). */
  stockMeshFallback: number
  /** Stock wireframe fallback (project has no stock colour). */
  stockWireframeFallback: number
  /** Feature mesh — default / neutral appearance. */
  meshFeatureDefault: number
  /** Feature mesh — selected highlight. */
  meshFeatureSelected: number
  /** Feature mesh — hovered highlight. */
  meshFeatureHovered: number
  /** Feature mesh — region walls. */
  meshFeatureRegion: number
  /** Feature mesh — subtract operation. */
  meshFeatureSubtract: number
  /** Feature mesh — add operation. */
  meshFeatureAdd: number
  /** Clamp fixture — default state. */
  clampDefault: number
  /** Clamp fixture — selected. */
  clampSelected: number
  /** Clamp fixture — colliding (with tool). */
  clampColliding: number
  /** Clamp fixture — colliding + selected. */
  clampCollidingSelected: number
  /** Tab fixture — default state. */
  tabDefault: number
  /** Tab fixture — selected. */
  tabSelected: number
  /** Machine-origin axis X (red). */
  originAxisX: number
  /** Machine-origin axis Y (green). */
  originAxisY: number
  /** Machine-origin axis Z (blue). */
  originAxisZ: number
  /** Machine-origin centre sphere. */
  originCenter: number
  /** Simulation tool cutter body. */
  toolCutter: number
  /** Simulation tool cutter emissive. */
  toolCutterEmissive: number
  /** Simulation tool shank. */
  toolShank: number
  /** Batched-line overlay — default / add features. */
  lineDefault: number
  /** Batched-line overlay — subtract features. */
  lineSubtract: number
}

export interface ThemePalette {
  canvas: CanvasThemePalette
  three: ThreeThemePalette
}

export const THEME_PALETTES: Record<ResolvedTheme, ThemePalette> = {
  dark: {
    canvas: {
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
      toolpathCutSlow: 'rgba(255, 224, 170, 0.96)',
      toolpathRapid: 'rgba(124, 184, 222, 0.8)',
      toolpathPlunge: 'rgba(213, 131, 223, 0.95)',
      toolpathCollision: 'rgba(227, 91, 91, 0.95)',

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

      constraint: '#5ba5d8',
      constraintHighlight: '#7bc7f6',
      constraintInvalid: '#dc3c3c',
      markerHalo: 'rgba(255, 255, 255, 0.9)',
      markerOutline: 'rgba(0, 0, 0, 0.4)',
    },
    three: {
      background: 0x141820,
      gridMinorCenter: 0x223344,
      gridMinor: 0x223344,
      gridMajorCenter: 0x334455,
      gridMajor: 0x51657a,
      toolpathCut: 0xff735c,
      toolpathCutSlow: 0xffe0aa,
      toolpathRapid: 0x78b8de,
      toolpathPlunge: 0xd583df,
      stockDefault: 0xb5beca,
      stockMeshFallback: 0x8899aa,
      stockWireframeFallback: 0xaabbcc,
      meshFeatureDefault: 0xb7c2cf,
      meshFeatureSelected: 0x9bd0ff,
      meshFeatureHovered: 0x44aaff,
      meshFeatureRegion: 0x9966cc,
      meshFeatureSubtract: 0x3366cc,
      meshFeatureAdd: 0x33aa66,
      clampDefault: 0x6c89d1,
      clampSelected: 0x9db9ff,
      clampColliding: 0xd46b6b,
      clampCollidingSelected: 0xff9c9c,
      tabDefault: 0x9ccd67,
      tabSelected: 0xc7ef94,
      originAxisX: 0xe35b5b,
      originAxisY: 0x63c07a,
      originAxisZ: 0x5b90e3,
      originCenter: 0xe6edf5,
      toolCutter: 0xd9dde3,
      toolCutterEmissive: 0x2a3443,
      toolShank: 0x7d8591,
      lineDefault: 0x33aa66,
      lineSubtract: 0x3366cc,
    },
  },
  light: {
    canvas: {
      background: '#fbfbf9',
      gridMajor: 'rgba(100, 125, 155, 0.30)',
      gridMinor: 'rgba(120, 140, 165, 0.15)',
      labelBackground: 'rgba(255, 255, 255, 0.95)',
      labelText: 'rgba(30, 41, 59, 0.96)',
      mutedGeometry: 'rgba(71, 85, 105, 0.68)',
      veil: 'rgba(248, 250, 252, 0.66)',

      active: '#2f7fc8',
      activeStrong: '#7fb4e6',
      draft: '#3d84c4',
      draftStrong: '#6fa8dc',

      featureCutFill: 'rgba(96, 152, 208, 0.30)',
      featureCutStroke: '#2c5f9e',
      featureAddFill: 'rgba(56, 142, 96, 0.28)',
      featureAddStroke: '#2f855a',
      featureModelFill: 'rgba(120, 138, 158, 0.24)',
      featureModelStroke: '#64748b',
      featureRegionFill: 'rgba(121, 71, 165, 0.22)',
      featureRegionStroke: '#7947a5',
      featureRegionExcludeStroke: '#9b6fc4',
      featureConstructionStroke: '#64748b',
      featureGroupFill: 'rgba(20, 148, 148, 0.22)',
      featureGroupStroke: '#149494',
      featureInfoText: 'rgba(30, 41, 59, 0.92)',
      featureInfoSubText: 'rgba(71, 85, 105, 0.9)',

      handleFill: '#5b8fb8',
      handleStroke: '#3f6d8f',
      nodeStroke: '#2c5f9e',
      vertexFill: 'rgba(71, 85, 105, 0.18)',
      vertexStroke: '#64748b',
      handleGuide: 'rgba(90, 120, 150, 0.5)',

      toolpathCut: 'rgba(214, 74, 52, 0.96)',
      toolpathCutSlow: 'rgba(122, 22, 22, 0.96)',
      toolpathRapid: 'rgba(56, 132, 184, 0.85)',
      toolpathPlunge: 'rgba(168, 74, 182, 0.95)',
      toolpathCollision: 'rgba(200, 60, 60, 0.95)',

      dimensionLine: 'rgba(90, 116, 148, 0.85)',
      dimensionText: 'rgba(51, 65, 85, 0.75)',
      dimensionDriven: 'rgba(21, 145, 100, 0.92)',
      dimensionWarning: 'rgba(190, 60, 60, 0.9)',
      dimensionHighlight: 'rgba(30, 120, 200, 0.98)',

      originAxisX: '#c53030',
      originAxisY: '#2f855a',
      originCenter: '#2b6cb0',

      clampFill: 'rgba(56, 84, 150, 0.12)',
      clampStroke: 'rgba(70, 100, 170, 0.85)',
      clampSelectedFill: 'rgba(56, 84, 150, 0.22)',
      clampSelectedStroke: '#3a5fae',
      clampCollidingFill: 'rgba(170, 60, 60, 0.14)',
      clampCollidingStroke: 'rgba(190, 70, 70, 0.9)',
      clampCollidingSelectedFill: 'rgba(190, 70, 70, 0.24)',
      clampCollidingSelectedStroke: '#c04040',

      tabFill: 'rgba(90, 140, 50, 0.14)',
      tabStroke: 'rgba(100, 150, 60, 0.88)',
      tabSelectedFill: 'rgba(100, 150, 60, 0.24)',
      tabSelectedStroke: '#4d7c1f',

      snapPerpendicular: 'rgba(60, 130, 190, 0.9)',
      editAddFill: '#2f7fc8',
      editAddStroke: '#1f5f9e',
      editDeleteFill: '#c05050',
      editDeleteStroke: '#a03a3a',
      editDisconnectFill: '#1a8f9e',
      editDisconnectStroke: '#0f6b78',

      measurementBackdrop: 'rgba(255, 255, 255, 0.94)',
      measurementText: 'rgba(30, 41, 59, 0.95)',
      stockExceeded: 'rgba(142, 58, 134, 0.9)',
      invalidText: 'rgba(150, 30, 30, 0.95)',
      invalidBackdrop: 'rgba(255, 235, 235, 0.92)',

      constraint: '#2f7fc8',
      constraintHighlight: '#1f5f9e',
      constraintInvalid: '#c53030',
      markerHalo: 'rgba(255, 255, 255, 0.95)',
      markerOutline: 'rgba(15, 23, 42, 0.35)',
    },
    three: {
      background: 0xeef2f7,
      gridMinorCenter: 0xc8d2e0,
      gridMinor: 0xd6dee9,
      gridMajorCenter: 0x94a3b8,
      gridMajor: 0xb4c0d0,
      toolpathCut: 0xd64a34,
      toolpathCutSlow: 0x7a1616,
      toolpathRapid: 0x3884b8,
      toolpathPlunge: 0xa84ab6,
      stockDefault: 0xc2cad4,
      stockMeshFallback: 0x7a8b9b,
      stockWireframeFallback: 0x96a7b6,
      meshFeatureDefault: 0xb7c2cf,
      meshFeatureSelected: 0x0d4f8c,
      meshFeatureHovered: 0x2288dd,
      meshFeatureRegion: 0x7b4fab,
      meshFeatureSubtract: 0x224d99,
      meshFeatureAdd: 0x22884d,
      clampDefault: 0x4a67b0,
      clampSelected: 0x5a7dd4,
      clampColliding: 0xb05050,
      clampCollidingSelected: 0xd47070,
      tabDefault: 0x6fa33f,
      tabSelected: 0x8cc44a,
      originAxisX: 0xc53030,
      originAxisY: 0x2f855a,
      originAxisZ: 0x2b6cb0,
      originCenter: 0x334155,
      toolCutter: 0x8899a6,
      toolCutterEmissive: 0x1a2433,
      toolShank: 0x5a6470,
      lineDefault: 0x22884d,
      lineSubtract: 0x224d99,
    },
  },
}

// ---------------------------------------------------------------------------
// Feed-colour ramp (issue #498 S4/S5)
//
// The engagement engine quantizes cut feeds to a fixed number of buckets whose
// rungs depend on the operation's slot-feed scale: rung k = slot + k·(1−slot)/5
// for k = 0…5 — top rung 1 (full feed), bottom rung the slot scale. Each rung
// maps to a colour step derived by interpolating between `toolpathCut` (full
// feed, step 0) and `toolpathCutSlow` (slowest bucket, last step), per theme
// and per representation. Ordering is carried by lightness, not hue, so the
// ramp survives greyscale and print. Step 0 is `toolpathCut` by construction —
// a move with `feedScale` absent or 1 renders exactly like it always has.
// ---------------------------------------------------------------------------

/** Number of rungs the engine quantizer emits (ENGAGEMENT_FEED_BUCKET_COUNT);
 *  fixed by the engine, not per operation. */
const FEED_COLOUR_RUNG_COUNT = 6

/**
 * The operation's pocket slot-feed percentage (1-99), or null when it has no
 * scaled-feed ladder in force — non-pocket/surface-clean, unset, or 100%.
 * Mirrors the engine's `resolveSlotFeedScale` gate, which skips all slot-feed
 * work in those cases so the emitted move stream carries no scaled feeds at
 * all.
 */
export function pocketSlotFeedPercent(operation: Operation | null | undefined): number | null {
  if (!operation || (operation.kind !== 'pocket' && operation.kind !== 'surface_clean')) return null
  const percent = operation.pocketSlotFeedPercent
  if (percent === undefined || !(percent > 0) || percent >= 100) return null
  return percent
}

/** Emitted feed-scale rungs for a slot-feed scale (fraction of full feed at
 *  full-slot engagement), full feed down to the slowest. Matches the engine
 *  quantizer exactly: rung k = slot + k·(1−slot)/(count−1), k = 0…count−1,
 *  computed with the same arithmetic so a rung the engine emits compares equal
 *  to its threshold here. At slotScale 1 every rung is 1 — the engine emits no
 *  scaled moves there. */
export function feedColourScales(slotScale: number): readonly number[] {
  const clamped = Math.min(1, Math.max(0, slotScale))
  const bucketWidth = (1 - clamped) / (FEED_COLOUR_RUNG_COUNT - 1)
  const rungs: number[] = []
  for (let k = 0; k < FEED_COLOUR_RUNG_COUNT; k += 1) {
    rungs[FEED_COLOUR_RUNG_COUNT - 1 - k] = clamped + k * bucketWidth
  }
  return rungs
}

/** Ramp step index for an emitted feed scale under a slot-feed scale; absent
 *  or >= 1 is full feed (step 0). Thresholds are the rungs themselves, so
 *  every rung the engine emits maps to its own distinct step. */
export function feedColourStep(feedScale: number | undefined, slotScale: number): number {
  if (feedScale === undefined || feedScale >= 1) {
    return 0
  }
  const clamped = Math.min(1, Math.max(0, slotScale))
  if (clamped >= 1) {
    return 0
  }
  const bucketWidth = (1 - clamped) / (FEED_COLOUR_RUNG_COUNT - 1)
  for (let k = FEED_COLOUR_RUNG_COUNT - 1; k >= 0; k -= 1) {
    if (feedScale >= clamped + k * bucketWidth - 1e-9) {
      return FEED_COLOUR_RUNG_COUNT - 1 - k
    }
  }
  return FEED_COLOUR_RUNG_COUNT - 1
}

interface Rgb { r: number; g: number; b: number }

function parseRgbChannels(color: string): Rgb {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color)
  if (match) {
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
  }
  const hex = color.replace('#', '')
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  }
}

function alphaOf(color: string): string {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\)/.exec(color)
  return match ? match[4] : '1'
}

function mixChannel(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * t)
}

/** Canvas-rep colour for a ramp step (0 = full feed). Preserves the cut token's alpha. */
export function canvasFeedColour(step: number, palette: CanvasThemePalette): string {
  const cut = parseRgbChannels(palette.toolpathCut)
  const slow = parseRgbChannels(palette.toolpathCutSlow)
  const t = Math.min(1, Math.max(0, step / (FEED_COLOUR_RUNG_COUNT - 1)))
  return `rgba(${mixChannel(cut.r, slow.r, t)}, ${mixChannel(cut.g, slow.g, t)}, ${mixChannel(cut.b, slow.b, t)}, ${alphaOf(palette.toolpathCut)})`
}

/** Three-rep colour for a ramp step (0 = full feed). */
export function threeFeedColour(step: number, palette: ThreeThemePalette): number {
  const cut = palette.toolpathCut
  const slow = palette.toolpathCutSlow
  const t = Math.min(1, Math.max(0, step / (FEED_COLOUR_RUNG_COUNT - 1)))
  const r = mixChannel((cut >> 16) & 0xff, (slow >> 16) & 0xff, t)
  const g = mixChannel((cut >> 8) & 0xff, (slow >> 8) & 0xff, t)
  const b = mixChannel(cut & 0xff, slow & 0xff, t)
  return (r << 16) | (g << 8) | b
}
