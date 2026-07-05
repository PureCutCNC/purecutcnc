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
 * DOM-free SVG renderer for design printing. Converts project geometry into a
 * self-contained SVG string sized in physical millimetres, so actual-size
 * printing is independent of screen DPI.
 *
 * Coordinate flow: world coordinates (Y down) are drawn inside a group with
 * `translate(tx ty) scale(s)` where `s` is paper-mm per world unit, so world Y
 * down maps directly onto SVG Y down — no axis flip. Stroke widths and font
 * sizes are specified in paper millimetres and divided by `s` inside that
 * group so line weights stay constant at any scale.
 */

import {
  dimensionLabelText,
  dimensionLayout,
  isDimensionDangling,
  measureValue,
} from '../../sketch/dimensions'
import { getFeatureGeometryBounds, getFeatureGeometryProfiles } from '../../text'
import { getStockBounds, rectProfile } from '../../types/project'
import type { Point, Project, SketchFeature, SketchProfile } from '../../types/project'
import { formatAngle, formatLength } from '../../utils/units'
import type { Units } from '../../utils/units'
import type { ToolpathResult } from '../toolpaths/types'
import { PAPER_PRESETS, formatScaleRatio } from './layout'
import type {
  DesignPrintLayout,
  DesignPrintOptions,
  PrintToolpathVisibility,
} from './types'

export interface DesignPrintSvgExtras {
  /** Toolpath overlays; drawn only when `options.content.toolpaths` is on. */
  toolpaths?: ToolpathResult[]
  /** Sketch-view layer visibility for toolpath overlays; defaults to all on. */
  toolpathVisibility?: PrintToolpathVisibility
  /** Preformatted date for the footer; omitted from the footer when absent. */
  footerDate?: string
  /**
   * When false, the root svg omits physical width/height attributes so the
   * preview can scale to its container via the viewBox. Defaults to true.
   */
  physicalSize?: boolean
}

interface PrintPalette {
  stock: string
  subtract: string
  add: string
  model: string
  region: string
  regionExclude: string
  construction: string
  tab: string
  clamp: string
  dimension: string
  dimensionExt: string
  label: string
  originX: string
  originY: string
  originDot: string
  gridMinor: string
  gridMajor: string
  cut: string
  rapid: string
  plunge: string
  footer: string
}

const COLOR_PALETTE: PrintPalette = {
  stock: '#6b6b6b',
  subtract: '#1f6fb2',
  add: '#2e8b57',
  model: '#75828f',
  region: '#8a5fc0',
  regionExclude: '#a37fd4',
  construction: '#8a97a5',
  tab: '#5f8f33',
  clamp: '#5b6fb5',
  dimension: '#333333',
  dimensionExt: '#8c8c8c',
  label: '#333333',
  originX: '#c0392b',
  originY: '#27ae60',
  originDot: '#2e6fb2',
  gridMinor: '#d9dde2',
  gridMajor: '#b8bfc7',
  cut: '#d84315',
  rapid: '#1e88e5',
  plunge: '#8e24aa',
  footer: '#333333',
}

const MONO_PALETTE: PrintPalette = {
  stock: '#555555',
  subtract: '#222222',
  add: '#222222',
  model: '#666666',
  region: '#444444',
  regionExclude: '#666666',
  construction: '#777777',
  tab: '#555555',
  clamp: '#555555',
  dimension: '#222222',
  dimensionExt: '#777777',
  label: '#222222',
  originX: '#222222',
  originY: '#222222',
  originDot: '#222222',
  gridMinor: '#dddddd',
  gridMajor: '#bbbbbb',
  cut: '#333333',
  rapid: '#888888',
  plunge: '#666666',
  footer: '#222222',
}

// Stroke widths and lettering sizes in paper millimetres.
const STROKE_FEATURE_MM = 0.3
const STROKE_CONSTRUCTION_MM = 0.2
const STROKE_STOCK_MM = 0.35
const STROKE_FIXTURE_MM = 0.25
const STROKE_DIMENSION_MM = 0.18
const STROKE_EXTENSION_MM = 0.13
const STROKE_GRID_MINOR_MM = 0.1
const STROKE_GRID_MAJOR_MM = 0.18
const STROKE_ORIGIN_MM = 0.3
const STROKE_CUT_MM = 0.3
const STROKE_RAPID_MM = 0.18
const STROKE_PLUNGE_MM = 0.2
const FONT_LABEL_MM = 2.6
const FONT_DIMENSION_MM = 2.8
const FONT_ORIGIN_MM = 2.4
const ORIGIN_AXIS_MM = 8
const DIMENSION_ARROW_MM = 2.2
const TEXT_HALO_MM = 0.7
const MAX_GRID_LINES_PER_AXIS = 1200

function fmt(value: number): string {
  const rounded = Math.round(value * 10000) / 10000
  // Avoid "-0" noise in output.
  return String(rounded === 0 ? 0 : rounded)
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** SVG path data for a sketch profile in world coordinates. */
export function profileToPathD(profile: SketchProfile): string {
  const parts: string[] = [`M ${fmt(profile.start.x)} ${fmt(profile.start.y)}`]
  let current = profile.start

  for (const segment of profile.segments) {
    if (segment.type === 'line') {
      parts.push(`L ${fmt(segment.to.x)} ${fmt(segment.to.y)}`)
      current = segment.to
      continue
    }

    if (segment.type === 'bezier') {
      parts.push(
        `C ${fmt(segment.control1.x)} ${fmt(segment.control1.y)} ` +
          `${fmt(segment.control2.x)} ${fmt(segment.control2.y)} ` +
          `${fmt(segment.to.x)} ${fmt(segment.to.y)}`,
      )
      current = segment.to
      continue
    }

    if (segment.type === 'circle') {
      // A full circle needs two arc commands; direction is irrelevant visually
      // but kept consistent with the stored winding.
      const radius = Math.hypot(current.x - segment.center.x, current.y - segment.center.y)
      const sweepFlag = segment.clockwise ? 0 : 1
      const opposite = {
        x: segment.center.x * 2 - current.x,
        y: segment.center.y * 2 - current.y,
      }
      parts.push(
        `A ${fmt(radius)} ${fmt(radius)} 0 1 ${sweepFlag} ${fmt(opposite.x)} ${fmt(opposite.y)}`,
        `A ${fmt(radius)} ${fmt(radius)} 0 1 ${sweepFlag} ${fmt(current.x)} ${fmt(current.y)}`,
      )
      current = profile.start
      continue
    }

    // Arc: recover sweep the same way sampleProfilePoints does, then translate
    // to SVG large-arc/sweep flags (increasing atan2 angle = sweep-flag 1).
    const radius = Math.hypot(current.x - segment.center.x, current.y - segment.center.y)
    const startAngle = Math.atan2(current.y - segment.center.y, current.x - segment.center.x)
    const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
    let sweep = endAngle - startAngle
    if (segment.clockwise && sweep > 0) sweep -= Math.PI * 2
    else if (!segment.clockwise && sweep < 0) sweep += Math.PI * 2
    const largeArc = Math.abs(sweep) > Math.PI ? 1 : 0
    const sweepFlag = sweep > 0 ? 1 : 0
    parts.push(
      `A ${fmt(radius)} ${fmt(radius)} 0 ${largeArc} ${sweepFlag} ${fmt(segment.to.x)} ${fmt(segment.to.y)}`,
    )
    current = segment.to
  }

  if (profile.closed) parts.push('Z')
  return parts.join(' ')
}

function hexToRgba(hex: string, alpha: number): string {
  const match = hex.trim().match(/^#?([0-9a-f]{6})$/i)
  if (!match) return `rgba(0, 0, 0, ${alpha})`
  const value = parseInt(match[1], 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface WorldContext {
  /** Paper mm per world unit. */
  scale: number
  palette: PrintPalette
  mono: boolean
  units: Units
}

/** A length given in paper millimetres expressed in world units. */
function mm(ctx: WorldContext, valueMm: number): number {
  return valueMm / ctx.scale
}

function dash(ctx: WorldContext, ...pattern: number[]): string {
  return pattern.map((v) => fmt(mm(ctx, v))).join(' ')
}

function textEl(
  ctx: WorldContext,
  x: number,
  y: number,
  content: string,
  options: {
    sizeMm: number
    fill: string
    anchor?: 'start' | 'middle' | 'end'
    rotateDeg?: number
    halo?: boolean
    weight?: number
  },
): string {
  const anchor = options.anchor ?? 'middle'
  const transform =
    options.rotateDeg !== undefined && Math.abs(options.rotateDeg) > 0.01
      ? ` transform="rotate(${fmt(options.rotateDeg)} ${fmt(x)} ${fmt(y)})"`
      : ''
  const halo = options.halo === false
    ? ''
    : ` stroke="#ffffff" stroke-width="${fmt(mm(ctx, TEXT_HALO_MM))}" paint-order="stroke" stroke-linejoin="round"`
  const weight = options.weight ? ` font-weight="${options.weight}"` : ''
  return (
    `<text x="${fmt(x)}" y="${fmt(y)}" font-family="Helvetica, Arial, sans-serif"` +
    ` font-size="${fmt(mm(ctx, options.sizeMm))}" fill="${options.fill}"` +
    ` text-anchor="${anchor}" dominant-baseline="middle"${weight}${halo}${transform}>` +
    `${escapeXml(content)}</text>`
  )
}

function buildGrid(
  project: Project,
  ctx: WorldContext,
  window: { minX: number; maxX: number; minY: number; maxY: number },
): string[] {
  const grid = project.grid
  const parts: string[] = []

  // Grid extent is centred on the stock, matching the sketch canvas.
  const bounds = getStockBounds(project.stock)
  const centerX = bounds.minX + (bounds.maxX - bounds.minX) / 2
  const centerY = bounds.minY + (bounds.maxY - bounds.minY) / 2
  const halfExtent = Math.max(grid.extent / 2, 10)
  const minX = Math.max(centerX - halfExtent, window.minX)
  const maxX = Math.min(centerX + halfExtent, window.maxX)
  const minY = Math.max(centerY - halfExtent, window.minY)
  const maxY = Math.min(centerY + halfExtent, window.maxY)
  if (minX >= maxX || minY >= maxY) return parts

  const minorSpacing = Math.max(grid.minorSpacing, 1e-4)
  const majorSpacing = Math.max(grid.majorSpacing, minorSpacing)
  // Guard against pathological settings flooding the document with lines.
  const spacing =
    (maxX - minX) / minorSpacing > MAX_GRID_LINES_PER_AXIS ||
    (maxY - minY) / minorSpacing > MAX_GRID_LINES_PER_AXIS
      ? majorSpacing
      : minorSpacing
  if ((maxX - minX) / spacing > MAX_GRID_LINES_PER_AXIS || (maxY - minY) / spacing > MAX_GRID_LINES_PER_AXIS) {
    return parts
  }

  const tolerance = spacing * 0.001
  const minorLines: string[] = []
  const majorLines: string[] = []

  for (let x = Math.ceil(minX / spacing) * spacing; x <= maxX + tolerance; x += spacing) {
    const isMajor = Math.abs(x / majorSpacing - Math.round(x / majorSpacing)) < tolerance / Math.max(majorSpacing, 1)
    ;(isMajor ? majorLines : minorLines).push(`M ${fmt(x)} ${fmt(minY)} L ${fmt(x)} ${fmt(maxY)}`)
  }
  for (let y = Math.ceil(minY / spacing) * spacing; y <= maxY + tolerance; y += spacing) {
    const isMajor = Math.abs(y / majorSpacing - Math.round(y / majorSpacing)) < tolerance / Math.max(majorSpacing, 1)
    ;(isMajor ? majorLines : minorLines).push(`M ${fmt(minX)} ${fmt(y)} L ${fmt(maxX)} ${fmt(y)}`)
  }

  if (minorLines.length > 0) {
    parts.push(
      `<path class="pc-grid" d="${minorLines.join(' ')}" fill="none" stroke="${ctx.palette.gridMinor}" stroke-width="${fmt(mm(ctx, STROKE_GRID_MINOR_MM))}"/>`,
    )
  }
  if (majorLines.length > 0) {
    parts.push(
      `<path class="pc-grid" d="${majorLines.join(' ')}" fill="none" stroke="${ctx.palette.gridMajor}" stroke-width="${fmt(mm(ctx, STROKE_GRID_MAJOR_MM))}"/>`,
    )
  }
  return parts
}

function buildBackdrop(project: Project): string[] {
  const backdrop = project.backdrop
  if (!backdrop || !backdrop.imageDataUrl) return []
  const x = backdrop.center.x - backdrop.width / 2
  const y = backdrop.center.y - backdrop.height / 2
  const rotation = (backdrop.orientationAngle ?? 90) - 90
  const transform =
    Math.abs(rotation) > 0.01
      ? ` transform="rotate(${fmt(rotation)} ${fmt(backdrop.center.x)} ${fmt(backdrop.center.y)})"`
      : ''
  const opacity = Math.min(Math.max(backdrop.opacity, 0), 1)
  return [
    `<image class="pc-backdrop" href="${backdrop.imageDataUrl}" x="${fmt(x)}" y="${fmt(y)}"` +
      ` width="${fmt(backdrop.width)}" height="${fmt(backdrop.height)}"` +
      ` opacity="${fmt(opacity)}" preserveAspectRatio="none"${transform}/>`,
  ]
}

function buildStock(project: Project, ctx: WorldContext): string[] {
  if (!project.stock.visible) return []
  const d = profileToPathD(project.stock.profile)
  return [
    `<path class="pc-stock" d="${d}" fill="none" stroke="${ctx.palette.stock}"` +
      ` stroke-width="${fmt(mm(ctx, STROKE_STOCK_MM))}" stroke-dasharray="${dash(ctx, 2.5, 1.5)}"/>`,
  ]
}

function featureStroke(feature: SketchFeature, palette: PrintPalette): { stroke: string; dashed: boolean } {
  switch (feature.operation) {
    case 'add':
      return { stroke: palette.add, dashed: false }
    case 'model':
      return { stroke: palette.model, dashed: false }
    case 'region':
      return feature.regionMaskMode === 'exclude'
        ? { stroke: palette.regionExclude, dashed: true }
        : { stroke: palette.region, dashed: false }
    case 'construction':
      return { stroke: palette.construction, dashed: true }
    default:
      return { stroke: palette.subtract, dashed: false }
  }
}

function buildFeatures(project: Project, ctx: WorldContext): string[] {
  const parts: string[] = []

  for (const feature of project.features) {
    if (!feature.visible) continue

    const { stroke, dashed } = featureStroke(feature, ctx.palette)
    const construction = feature.operation === 'construction'
    const strokeWidth = fmt(mm(ctx, construction ? STROKE_CONSTRUCTION_MM : STROKE_FEATURE_MM))
    const dashAttr = dashed || construction ? ` stroke-dasharray="${dash(ctx, 2, 1.4)}"` : ''

    // Imported models print their full silhouette path set when available;
    // sketch.profile only mirrors the largest silhouette loop.
    const silhouettes = feature.stl?.silhouettePaths
    if (feature.kind === 'stl' && silhouettes && silhouettes.length > 0) {
      for (const path of silhouettes) {
        if (path.length < 2) continue
        const points = path.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')
        parts.push(
          `<polygon class="pc-feature" data-op="${feature.operation}" points="${points}"` +
            ` fill="${ctx.mono ? 'none' : hexToRgba(stroke, 0.08)}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`,
        )
      }
      continue
    }

    for (const profile of getFeatureGeometryProfiles(feature)) {
      const fill =
        profile.closed && !construction && !ctx.mono ? hexToRgba(stroke, 0.08) : 'none'
      parts.push(
        `<path class="pc-feature" data-op="${feature.operation}" d="${profileToPathD(profile)}"` +
          ` fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"${dashAttr}/>`,
      )
    }
  }

  return parts
}

function buildFeatureLabels(project: Project, ctx: WorldContext): string[] {
  const parts: string[] = []
  for (const feature of project.features) {
    if (!feature.visible) continue
    const bounds = getFeatureGeometryBounds(feature)
    const cx = bounds.minX + (bounds.maxX - bounds.minX) / 2
    const cy = bounds.minY + (bounds.maxY - bounds.minY) / 2
    parts.push(textEl(ctx, cx, cy - mm(ctx, 1.8), feature.name, {
      sizeMm: FONT_LABEL_MM,
      fill: ctx.palette.label,
    }))
    if (feature.operation !== 'construction') {
      const zTop = typeof feature.z_top === 'number' ? feature.z_top : 0
      const zBottom = typeof feature.z_bottom === 'number' ? feature.z_bottom : 0
      parts.push(textEl(
        ctx,
        cx,
        cy + mm(ctx, 1.8),
        `z ${formatLength(zTop, ctx.units)} → ${formatLength(zBottom, ctx.units)}`,
        { sizeMm: FONT_LABEL_MM * 0.85, fill: ctx.palette.label },
      ))
    }
  }
  return parts.length > 0 ? [`<g class="pc-feature-labels">${parts.join('')}</g>`] : []
}

function buildTabsAndClamps(project: Project, ctx: WorldContext, options: DesignPrintOptions): string[] {
  const parts: string[] = []
  const strokeWidth = fmt(mm(ctx, STROKE_FIXTURE_MM))

  if (options.content.tabs) {
    for (const tab of project.tabs) {
      if (!tab.visible) continue
      parts.push(
        `<path class="pc-tab" d="${profileToPathD(rectProfile(tab.x, tab.y, tab.w, tab.h))}"` +
          ` fill="${ctx.mono ? 'none' : hexToRgba(ctx.palette.tab, 0.08)}" stroke="${ctx.palette.tab}"` +
          ` stroke-width="${strokeWidth}" stroke-dasharray="${dash(ctx, 1.8, 1.2)}"/>`,
      )
    }
  }

  if (options.content.clamps) {
    for (const clamp of project.clamps) {
      if (!clamp.visible) continue
      parts.push(
        `<path class="pc-clamp" d="${profileToPathD(rectProfile(clamp.x, clamp.y, clamp.w, clamp.h))}"` +
          ` fill="${ctx.mono ? 'none' : hexToRgba(ctx.palette.clamp, 0.08)}" stroke="${ctx.palette.clamp}"` +
          ` stroke-width="${strokeWidth}" stroke-dasharray="${dash(ctx, 1.8, 1.2)}"/>`,
      )
    }
  }

  return parts
}

function buildToolpaths(ctx: WorldContext, extras: DesignPrintSvgExtras): string[] {
  const toolpaths = extras.toolpaths ?? []
  if (toolpaths.length === 0) return []
  const visibility: PrintToolpathVisibility =
    extras.toolpathVisibility ?? { cuts: true, rapids: true, plunges: true, retractions: true }

  const layers: Array<{
    className: string
    stroke: string
    widthMm: number
    dashed: boolean
    filter: (move: ToolpathResult['moves'][number]) => boolean
  }> = [
    {
      className: 'pc-toolpath-cut',
      stroke: ctx.palette.cut,
      widthMm: STROKE_CUT_MM,
      dashed: false,
      filter: (move) =>
        visibility.cuts && (move.kind === 'cut' || move.kind === 'lead_in' || move.kind === 'lead_out'),
    },
    {
      className: 'pc-toolpath-rapid',
      stroke: ctx.palette.rapid,
      widthMm: STROKE_RAPID_MM,
      dashed: true,
      filter: (move) => {
        if (move.kind !== 'rapid') return false
        const isRetraction = move.to.z > move.from.z + 1e-9
        const isHorizontal = Math.abs(move.from.z - move.to.z) < 1e-9
        return (visibility.rapids && isHorizontal) || (visibility.retractions && isRetraction)
      },
    },
    {
      className: 'pc-toolpath-plunge',
      stroke: ctx.palette.plunge,
      widthMm: STROKE_PLUNGE_MM,
      dashed: true,
      filter: (move) => visibility.plunges && move.kind === 'plunge',
    },
  ]

  const parts: string[] = []
  for (const layer of layers) {
    const segments: string[] = []
    for (const toolpath of toolpaths) {
      for (const move of toolpath.moves) {
        if (!layer.filter(move)) continue
        segments.push(
          `M ${fmt(move.from.x)} ${fmt(move.from.y)} L ${fmt(move.to.x)} ${fmt(move.to.y)}`,
        )
      }
    }
    if (segments.length === 0) continue
    const dashAttr = layer.dashed ? ` stroke-dasharray="${dash(ctx, 1.6, 1.2)}"` : ''
    parts.push(
      `<path class="${layer.className}" d="${segments.join(' ')}" fill="none"` +
        ` stroke="${layer.stroke}" stroke-width="${fmt(mm(ctx, layer.widthMm))}"${dashAttr}/>`,
    )
  }
  return parts
}

function buildOrigin(project: Project, ctx: WorldContext): string[] {
  if (!project.origin.visible) return []
  const { x, y } = project.origin
  const len = mm(ctx, ORIGIN_AXIS_MM)
  const head = mm(ctx, 1.8)
  const halfHead = mm(ctx, 0.9)
  const strokeWidth = fmt(mm(ctx, STROKE_ORIGIN_MM))

  return [
    `<g class="pc-origin">` +
      `<path d="M ${fmt(x)} ${fmt(y)} L ${fmt(x + len)} ${fmt(y)}" stroke="${ctx.palette.originX}" stroke-width="${strokeWidth}" fill="none"/>` +
      `<polygon points="${fmt(x + len)},${fmt(y)} ${fmt(x + len - head)},${fmt(y - halfHead)} ${fmt(x + len - head)},${fmt(y + halfHead)}" fill="${ctx.palette.originX}"/>` +
      `<path d="M ${fmt(x)} ${fmt(y)} L ${fmt(x)} ${fmt(y - len)}" stroke="${ctx.palette.originY}" stroke-width="${strokeWidth}" fill="none"/>` +
      `<polygon points="${fmt(x)},${fmt(y - len)} ${fmt(x - halfHead)},${fmt(y - len + head)} ${fmt(x + halfHead)},${fmt(y - len + head)}" fill="${ctx.palette.originY}"/>` +
      `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(mm(ctx, 1))}" fill="${ctx.palette.originDot}"/>` +
      textEl(ctx, x + len + mm(ctx, 2), y, 'X', { sizeMm: FONT_ORIGIN_MM, fill: ctx.palette.originX, anchor: 'start' }) +
      textEl(ctx, x, y - len - mm(ctx, 2), 'Y', { sizeMm: FONT_ORIGIN_MM, fill: ctx.palette.originY }) +
      `</g>`,
  ]
}

function dimensionArrow(ctx: WorldContext, tip: Point, from: Point, color: string): string {
  const dx = tip.x - from.x
  const dy = tip.y - from.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return ''
  const ux = dx / len
  const uy = dy / len
  const size = mm(ctx, DIMENSION_ARROW_MM)
  const baseX = tip.x - ux * size
  const baseY = tip.y - uy * size
  const half = size * 0.36
  const nx = -uy
  const ny = ux
  return (
    `<polygon points="${fmt(tip.x)},${fmt(tip.y)} ${fmt(baseX + nx * half)},${fmt(baseY + ny * half)}` +
    ` ${fmt(baseX - nx * half)},${fmt(baseY - ny * half)}" fill="${color}"/>`
  )
}

function buildDimensions(project: Project, ctx: WorldContext): string[] {
  if (!project.meta.showDimensions) return []
  const parts: string[] = []
  const lenFmt = (v: number): string => formatLength(v, ctx.units)

  for (const dim of project.annotations) {
    if (!dim.visible) continue
    if (isDimensionDangling(dim, project)) continue
    const layout = dimensionLayout(dim, project)
    if (!layout) continue
    const value = measureValue(dim, project)
    if (value === null) continue

    const pieces: string[] = []
    const extWidth = fmt(mm(ctx, STROKE_EXTENSION_MM))
    for (const [from, to] of layout.extensions) {
      pieces.push(
        `<path d="M ${fmt(from.x)} ${fmt(from.y)} L ${fmt(to.x)} ${fmt(to.y)}" stroke="${ctx.palette.dimensionExt}" stroke-width="${extWidth}" fill="none"/>`,
      )
    }

    const lineWidth = fmt(mm(ctx, STROKE_DIMENSION_MM))
    if (
      layout.type === 'angle' &&
      layout.vertex &&
      layout.startAngle !== undefined &&
      layout.endAngle !== undefined
    ) {
      const radius = Math.hypot(layout.lineStart.x - layout.vertex.x, layout.lineStart.y - layout.vertex.y)
      let delta = layout.endAngle - layout.startAngle
      while (delta <= -Math.PI) delta += Math.PI * 2
      while (delta > Math.PI) delta -= Math.PI * 2
      const largeArc = Math.abs(delta) > Math.PI ? 1 : 0
      const sweepFlag = delta > 0 ? 1 : 0
      pieces.push(
        `<path d="M ${fmt(layout.lineStart.x)} ${fmt(layout.lineStart.y)}` +
          ` A ${fmt(radius)} ${fmt(radius)} 0 ${largeArc} ${sweepFlag} ${fmt(layout.lineEnd.x)} ${fmt(layout.lineEnd.y)}"` +
          ` stroke="${ctx.palette.dimension}" stroke-width="${lineWidth}" fill="none"/>`,
      )
    } else {
      pieces.push(
        `<path d="M ${fmt(layout.lineStart.x)} ${fmt(layout.lineStart.y)} L ${fmt(layout.lineEnd.x)} ${fmt(layout.lineEnd.y)}"` +
          ` stroke="${ctx.palette.dimension}" stroke-width="${lineWidth}" fill="none"/>`,
      )
      pieces.push(dimensionArrow(ctx, layout.lineStart, layout.lineEnd, ctx.palette.dimension))
      pieces.push(dimensionArrow(ctx, layout.lineEnd, layout.lineStart, ctx.palette.dimension))
    }

    const labelText = dimensionLabelText(dim, value, lenFmt, formatAngle)
    let rotateDeg = (layout.labelAngle * 180) / Math.PI
    if (rotateDeg > 90) rotateDeg -= 180
    if (rotateDeg < -90) rotateDeg += 180
    pieces.push(textEl(ctx, layout.labelPos.x, layout.labelPos.y, labelText, {
      sizeMm: FONT_DIMENSION_MM,
      fill: ctx.palette.dimension,
      rotateDeg,
    }))

    parts.push(`<g class="pc-dimension">${pieces.join('')}</g>`)
  }

  return parts
}

function paperLabel(options: DesignPrintOptions): string {
  if (options.paper === 'custom') return 'Custom'
  const preset = PAPER_PRESETS.find((p) => p.id === options.paper)
  return preset?.shortLabel ?? options.paper
}

function scaleLabel(options: DesignPrintOptions, layout: DesignPrintLayout): string {
  if (options.scaleMode === 'actual') return '1:1'
  if (options.scaleMode === 'fit') return `Fit (${formatScaleRatio(layout.scaleRatio)})`
  return formatScaleRatio(layout.scaleRatio)
}

function buildFooter(
  project: Project,
  options: DesignPrintOptions,
  layout: DesignPrintLayout,
  palette: PrintPalette,
  extras: DesignPrintSvgExtras,
): string[] {
  if (layout.footerHeightMm <= 0) return []
  const x = layout.printableXMm
  const y = layout.printableYMm + layout.printableHeightMm - layout.footerHeightMm
  const w = layout.printableWidthMm
  const h = layout.footerHeightMm
  const midY = y + h / 2

  const orientation = options.orientation === 'landscape' ? 'Landscape' : 'Portrait'
  const fields = [
    `Units: ${project.meta.units === 'inch' ? 'inch' : 'mm'}`,
    `Scale: ${scaleLabel(options, layout)}`,
    `Paper: ${paperLabel(options)} · ${orientation}`,
  ]
  if (extras.footerDate) fields.push(extras.footerDate)

  const name = escapeXml(project.meta.name)
  const meta = escapeXml(fields.join('   ·   '))

  return [
    `<g class="pc-footer">` +
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="none" stroke="${palette.footer}" stroke-width="0.25"/>` +
      `<text x="${fmt(x + 3)}" y="${fmt(midY)}" font-family="Helvetica, Arial, sans-serif" font-size="3.2"` +
      ` font-weight="600" fill="${palette.footer}" text-anchor="start" dominant-baseline="middle">${name}</text>` +
      `<text x="${fmt(x + w - 3)}" y="${fmt(midY)}" font-family="Helvetica, Arial, sans-serif" font-size="2.6"` +
      ` fill="${palette.footer}" text-anchor="end" dominant-baseline="middle">${meta}</text>` +
      `</g>`,
  ]
}

/**
 * Render the full print document as an SVG string. The SVG is self-contained
 * (inline styles only) and sized in physical millimetres unless
 * `extras.physicalSize` is false.
 */
export function buildDesignPrintSvg(
  project: Project,
  options: DesignPrintOptions,
  layout: DesignPrintLayout,
  extras: DesignPrintSvgExtras = {},
): string {
  const units = project.meta.units
  const palette = options.colorMode === 'monochrome' ? MONO_PALETTE : COLOR_PALETTE
  const ctx: WorldContext = {
    scale: layout.scale,
    palette,
    mono: options.colorMode === 'monochrome',
    units,
  }

  const tx = layout.originXMm - layout.bounds.minX * layout.scale
  const ty = layout.originYMm - layout.bounds.minY * layout.scale

  // World-space window corresponding to the drawable paper area (for the grid).
  const worldWindow = {
    minX: (layout.drawableXMm - tx) / layout.scale,
    maxX: (layout.drawableXMm + layout.drawableWidthMm - tx) / layout.scale,
    minY: (layout.drawableYMm - ty) / layout.scale,
    maxY: (layout.drawableYMm + layout.drawableHeightMm - ty) / layout.scale,
  }

  const world: string[] = []
  if (options.content.grid) {
    world.push(...buildGrid(project, ctx, worldWindow))
  }
  if (options.content.backdrop) {
    world.push(...buildBackdrop(project))
  }
  world.push(...buildStock(project, ctx))
  world.push(...buildFeatures(project, ctx))
  world.push(...buildTabsAndClamps(project, ctx, options))
  if (options.content.toolpaths) {
    world.push(...buildToolpaths(ctx, extras))
  }
  world.push(...buildOrigin(project, ctx))
  world.push(...buildDimensions(project, ctx))
  if (options.content.featureLabels) {
    world.push(...buildFeatureLabels(project, ctx))
  }

  const sizeAttrs = extras.physicalSize === false
    ? ''
    : ` width="${fmt(layout.paperWidthMm)}mm" height="${fmt(layout.paperHeightMm)}mm"`

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg"${sizeAttrs}` +
      ` viewBox="0 0 ${fmt(layout.paperWidthMm)} ${fmt(layout.paperHeightMm)}">`,
  )
  parts.push(
    `<rect x="0" y="0" width="${fmt(layout.paperWidthMm)}" height="${fmt(layout.paperHeightMm)}" fill="#ffffff"/>`,
  )
  parts.push(
    `<defs><clipPath id="pc-print-clip"><rect x="${fmt(layout.drawableXMm)}" y="${fmt(layout.drawableYMm)}"` +
      ` width="${fmt(layout.drawableWidthMm)}" height="${fmt(layout.drawableHeightMm)}"/></clipPath></defs>`,
  )
  parts.push(`<g clip-path="url(#pc-print-clip)">`)
  parts.push(`<g transform="translate(${fmt(tx)} ${fmt(ty)}) scale(${fmt(layout.scale)})">`)
  parts.push(...world)
  parts.push(`</g>`)
  parts.push(`</g>`)
  parts.push(...buildFooter(project, options, layout, palette, extras))
  parts.push(`</svg>`)
  return parts.join('\n')
}
