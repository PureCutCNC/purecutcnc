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
 * Option and result types for the design-print engine (issue #254).
 *
 * All physical quantities inside the engine are millimetres; user-facing
 * inputs (margins, custom paper size, offsets) are entered in project units
 * and converted by the layout math.
 */

import type { Bounds2D, Project } from '../../types/project'
import type { Units } from '../../utils/units'

export type PaperPresetId = 'letter' | 'legal' | 'tabloid' | 'a4' | 'a3' | 'custom'

export interface PaperPreset {
  id: Exclude<PaperPresetId, 'custom'>
  /** Full label for pickers, e.g. "Letter (8.5 × 11 in)". */
  label: string
  /** Short label for the footer/title block, e.g. "Letter". */
  shortLabel: string
  /** Portrait dimensions in millimetres. */
  widthMm: number
  heightMm: number
}

export type PaperOrientation = 'portrait' | 'landscape'

/** Which world-space region of the design gets printed. */
export type PrintAreaMode = 'visible' | 'stock' | 'view'

export type PrintScaleMode = 'fit' | 'actual' | 'custom'

export type PrintColorMode = 'color' | 'monochrome'

/** Optional content layers beyond the always-printed design geometry. */
export interface DesignPrintContent {
  grid: boolean
  backdrop: boolean
  featureLabels: boolean
  tabs: boolean
  clamps: boolean
  toolpaths: boolean
  footer: boolean
}

export interface DesignPrintOptions {
  paper: PaperPresetId
  /** Custom paper size in project units; used when `paper === 'custom'`. */
  customPaperWidth: number
  customPaperHeight: number
  orientation: PaperOrientation
  /** Uniform page margin in project units. */
  margin: number
  area: PrintAreaMode
  scaleMode: PrintScaleMode
  /** Custom scale text: a ratio ("1:2", "2:1"), percentage ("50%"), or factor ("0.5"). */
  customScale: string
  /** Registration offsets in project units, applied after centering. */
  offsetX: number
  offsetY: number
  colorMode: PrintColorMode
  content: DesignPrintContent
}

/** Resolved physical page layout produced by `computeDesignPrintLayout`. */
export interface DesignPrintLayout {
  paperWidthMm: number
  paperHeightMm: number
  marginMm: number
  /** Printable area (paper minus margins). */
  printableXMm: number
  printableYMm: number
  printableWidthMm: number
  printableHeightMm: number
  /** Height reserved for the footer/title block (0 when disabled). */
  footerHeightMm: number
  /** Drawing area (printable area minus footer strip). */
  drawableXMm: number
  drawableYMm: number
  drawableWidthMm: number
  drawableHeightMm: number
  /** World bounds being printed. */
  bounds: Bounds2D
  /** Paper millimetres per project world unit. */
  scale: number
  /** Scale relative to actual size (1 = 1:1 physical). */
  scaleRatio: number
  /** Physical size of the printed drawing. */
  outputWidthMm: number
  outputHeightMm: number
  /** Paper position (mm) where `bounds.minX/minY` lands. */
  originXMm: number
  originYMm: number
  /** True when the drawing overflows the drawable area at this scale. */
  clipped: boolean
  /** False when scaleMode is `custom` and the custom scale text failed to parse. */
  customScaleValid: boolean
}

/**
 * Structural subset of the sketch view's toolpath layer visibility. Matches
 * `ToolpathVisibility` from the component layer without importing it here.
 */
export interface PrintToolpathVisibility {
  cuts: boolean
  rapids: boolean
  plunges: boolean
  retractions: boolean
}

/** Default margin in project units (10 mm / 0.5 in). */
export function defaultPrintMargin(units: Units): number {
  return units === 'inch' ? 0.5 : 10
}

/**
 * Sensible starting options for a project: unit-appropriate paper, orientation
 * matched to the printed bounds, content toggles following project visibility.
 */
export function defaultDesignPrintOptions(
  project: Project,
  visibleBounds: Bounds2D,
): DesignPrintOptions {
  const units = project.meta.units
  const wide = visibleBounds.maxX - visibleBounds.minX > visibleBounds.maxY - visibleBounds.minY
  return {
    paper: units === 'inch' ? 'letter' : 'a4',
    customPaperWidth: units === 'inch' ? 8.5 : 210,
    customPaperHeight: units === 'inch' ? 11 : 297,
    orientation: wide ? 'landscape' : 'portrait',
    margin: defaultPrintMargin(units),
    area: 'visible',
    scaleMode: 'fit',
    customScale: '1:1',
    offsetX: 0,
    offsetY: 0,
    colorMode: 'color',
    content: {
      grid: false,
      backdrop: false,
      featureLabels: false,
      tabs: project.tabs.some((tab) => tab.visible),
      clamps: project.clamps.some((clamp) => clamp.visible),
      toolpaths: false,
      footer: true,
    },
  }
}
