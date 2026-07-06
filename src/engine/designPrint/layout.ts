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
 * Pure page-layout math for design printing: paper presets, printable-area,
 * bounds resolution, scale computation, centering, and clipping detection.
 * Everything physical is millimetres; see types.ts.
 */

import { getVisibleSceneBounds2D } from '../../sketch/sceneBounds'
import { getStockBounds } from '../../types/project'
import type { Bounds2D, Project } from '../../types/project'
import type { Units } from '../../utils/units'
import type {
  DesignPrintContent,
  DesignPrintLayout,
  DesignPrintOptions,
  PaperPreset,
  PrintAreaMode,
} from './types'

export const MM_PER_INCH = 25.4

/** Millimetres per project world unit. */
export function unitToMm(units: Units): number {
  return units === 'inch' ? MM_PER_INCH : 1
}

export const PAPER_PRESETS: PaperPreset[] = [
  { id: 'letter', label: 'Letter (8.5 × 11 in)', shortLabel: 'Letter', widthMm: 215.9, heightMm: 279.4 },
  { id: 'legal', label: 'Legal (8.5 × 14 in)', shortLabel: 'Legal', widthMm: 215.9, heightMm: 355.6 },
  { id: 'tabloid', label: 'Tabloid (11 × 17 in)', shortLabel: 'Tabloid', widthMm: 279.4, heightMm: 431.8 },
  { id: 'a4', label: 'A4 (210 × 297 mm)', shortLabel: 'A4', widthMm: 210, heightMm: 297 },
  { id: 'a3', label: 'A3 (297 × 420 mm)', shortLabel: 'A3', widthMm: 297, heightMm: 420 },
]

/** Height of the footer/title-block strip when enabled. */
export const FOOTER_HEIGHT_MM = 12

const MIN_PAPER_MM = 20
const CLIP_EPSILON_MM = 0.01

/**
 * Parse the custom-scale text into a ratio (output / actual size).
 * Accepts "1:2" / "2:1" ratios, "50%" percentages, and plain factors ("0.5").
 * Returns null for anything non-positive or unparseable.
 */
export function parseCustomScale(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const ratioMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/)
  if (ratioMatch) {
    const a = Number(ratioMatch[1])
    const b = Number(ratioMatch[2])
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null
    return a / b
  }

  const percentMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*%$/)
  if (percentMatch) {
    const v = Number(percentMatch[1])
    return Number.isFinite(v) && v > 0 ? v / 100 : null
  }

  const factor = Number(trimmed)
  return Number.isFinite(factor) && factor > 0 ? factor : null
}

/** Format a scale ratio for display, e.g. 0.5 → "1:2", 2 → "2:1", 1 → "1:1". */
export function formatScaleRatio(ratio: number): string {
  const round = (v: number): string => {
    const r = Math.round(v * 100) / 100
    return String(r)
  }
  if (ratio >= 1) return `${round(ratio)}:1`
  return `1:${round(1 / ratio)}`
}

/** Paper size in millimetres with orientation applied. */
export function resolvePaperSizeMm(
  options: DesignPrintOptions,
  units: Units,
): { widthMm: number; heightMm: number } {
  let widthMm: number
  let heightMm: number

  if (options.paper === 'custom') {
    const unitMm = unitToMm(units)
    widthMm = Math.max(options.customPaperWidth * unitMm, MIN_PAPER_MM)
    heightMm = Math.max(options.customPaperHeight * unitMm, MIN_PAPER_MM)
  } else {
    const preset = PAPER_PRESETS.find((p) => p.id === options.paper) ?? PAPER_PRESETS[0]
    widthMm = preset.widthMm
    heightMm = preset.heightMm
  }

  if (options.orientation === 'landscape') {
    return { widthMm: Math.max(widthMm, heightMm), heightMm: Math.min(widthMm, heightMm) }
  }
  return { widthMm: Math.min(widthMm, heightMm), heightMm: Math.max(widthMm, heightMm) }
}

/**
 * Resolve the world bounds to print for the selected area mode. `viewBounds`
 * is the sketch canvas's current pan/zoom window; when unavailable the `view`
 * mode falls back to visible-design extents.
 *
 * Visible-design extents follow the enabled content layers: tabs, clamps and
 * the backdrop only widen the bounds when they will actually be printed, so
 * the page is never scaled to fit content the output omits. Without a
 * `content` argument, tabs/clamps count and the backdrop does not — matching
 * the dialog's defaults.
 */
export function resolvePrintBounds(
  project: Project,
  area: PrintAreaMode,
  viewBounds: Bounds2D | null,
  content?: Pick<DesignPrintContent, 'backdrop' | 'tabs' | 'clamps'>,
): Bounds2D {
  if (area === 'stock') {
    return getStockBounds(project.stock)
  }
  if (area === 'view' && viewBounds) {
    return viewBounds
  }

  const bounds = getVisibleSceneBounds2D(project, {
    includeBackdrop: false,
    includeTabs: content?.tabs ?? true,
    includeClamps: content?.clamps ?? true,
  })

  // The backdrop toggle prints the image regardless of its sketch
  // visibility, so it widens the bounds exactly when it will be drawn.
  if (content?.backdrop && project.backdrop) {
    const halfW = project.backdrop.width / 2
    const halfH = project.backdrop.height / 2
    return {
      minX: Math.min(bounds.minX, project.backdrop.center.x - halfW),
      maxX: Math.max(bounds.maxX, project.backdrop.center.x + halfW),
      minY: Math.min(bounds.minY, project.backdrop.center.y - halfH),
      maxY: Math.max(bounds.maxY, project.backdrop.center.y + halfH),
    }
  }
  return bounds
}

/** Full physical layout for the given options and world bounds. */
export function computeDesignPrintLayout(
  options: DesignPrintOptions,
  bounds: Bounds2D,
  units: Units,
): DesignPrintLayout {
  const unitMm = unitToMm(units)
  const { widthMm: paperWidthMm, heightMm: paperHeightMm } = resolvePaperSizeMm(options, units)

  // Clamp the margin so a printable area always survives.
  const maxMarginMm = Math.max(0, Math.min(paperWidthMm, paperHeightMm) / 2 - 5)
  const marginMm = Math.min(Math.max(options.margin * unitMm, 0), maxMarginMm)

  const printableXMm = marginMm
  const printableYMm = marginMm
  const printableWidthMm = paperWidthMm - marginMm * 2
  const printableHeightMm = paperHeightMm - marginMm * 2

  const footerHeightMm =
    options.content.footer && printableHeightMm > FOOTER_HEIGHT_MM + 10 ? FOOTER_HEIGHT_MM : 0
  const drawableXMm = printableXMm
  const drawableYMm = printableYMm
  const drawableWidthMm = printableWidthMm
  const drawableHeightMm = printableHeightMm - footerHeightMm

  const contentWidth = Math.max(bounds.maxX - bounds.minX, 1e-6)
  const contentHeight = Math.max(bounds.maxY - bounds.minY, 1e-6)

  let scale: number
  let customScaleValid = true
  if (options.scaleMode === 'fit') {
    scale = Math.min(drawableWidthMm / contentWidth, drawableHeightMm / contentHeight)
  } else if (options.scaleMode === 'actual') {
    scale = unitMm
  } else {
    const ratio = parseCustomScale(options.customScale)
    customScaleValid = ratio !== null
    scale = (ratio ?? 1) * unitMm
  }
  scale = Math.max(scale, 1e-9)

  const outputWidthMm = contentWidth * scale
  const outputHeightMm = contentHeight * scale

  const originXMm = drawableXMm + (drawableWidthMm - outputWidthMm) / 2 + options.offsetX * unitMm
  const originYMm = drawableYMm + (drawableHeightMm - outputHeightMm) / 2 + options.offsetY * unitMm

  const clipped =
    originXMm < drawableXMm - CLIP_EPSILON_MM ||
    originYMm < drawableYMm - CLIP_EPSILON_MM ||
    originXMm + outputWidthMm > drawableXMm + drawableWidthMm + CLIP_EPSILON_MM ||
    originYMm + outputHeightMm > drawableYMm + drawableHeightMm + CLIP_EPSILON_MM

  return {
    paperWidthMm,
    paperHeightMm,
    marginMm,
    printableXMm,
    printableYMm,
    printableWidthMm,
    printableHeightMm,
    footerHeightMm,
    drawableXMm,
    drawableYMm,
    drawableWidthMm,
    drawableHeightMm,
    bounds,
    scale,
    scaleRatio: scale / unitMm,
    outputWidthMm,
    outputHeightMm,
    originXMm,
    originYMm,
    clipped,
    customScaleValid,
  }
}
