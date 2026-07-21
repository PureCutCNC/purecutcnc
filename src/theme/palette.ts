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
  toolpathRapid: string
  toolpathPlunge: string
  toolpathCollision: string
  toolpathDirection: string

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
}

export interface ThreeThemePalette {
  background: number
  gridMinorCenter: number
  gridMinor: number
  gridMajorCenter: number
  gridMajor: number
  /** Toolpath overlay colours; kept in step with the canvas + CSS legend. */
  toolpathCut: number
  toolpathRapid: number
  toolpathPlunge: number
  /** Fallback stock material when the project defines no stock colour. */
  stockDefault: number
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
    },
    three: {
      background: 0x141820,
      gridMinorCenter: 0x223344,
      gridMinor: 0x223344,
      gridMajorCenter: 0x334455,
      gridMajor: 0x51657a,
      toolpathCut: 0xff735c,
      toolpathRapid: 0x78b8de,
      toolpathPlunge: 0xd583df,
      stockDefault: 0xb5beca,
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
      toolpathRapid: 'rgba(56, 132, 184, 0.85)',
      toolpathPlunge: 'rgba(168, 74, 182, 0.95)',
      toolpathCollision: 'rgba(200, 60, 60, 0.95)',
      toolpathDirection: '#149494',

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
    },
    three: {
      background: 0xeef2f7,
      gridMinorCenter: 0xc8d2e0,
      gridMinor: 0xd6dee9,
      gridMajorCenter: 0x94a3b8,
      gridMajor: 0xb4c0d0,
      toolpathCut: 0xd64a34,
      toolpathRapid: 0x3884b8,
      toolpathPlunge: 0xa84ab6,
      stockDefault: 0xc2cad4,
    },
  },
}
