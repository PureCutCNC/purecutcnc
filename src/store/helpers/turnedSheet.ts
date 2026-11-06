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
 * Around sheet work over a **turned** section (issue #1131).
 *
 * A square bar is a special case of a round bar (#1112): a Turn makes its
 * section round, so from there the section behaves like round stock and the
 * Around sheet's coordinates describe a real surface. This module answers the
 * two questions that follow from that, from the same placed-Turn facts the
 * Thread/Flutes surface resolver reads (`rotarySurface.ts`):
 *
 * 1. **May sheet work be cut here?** On a square bar, only where the feature —
 *    and, for an operation, the cutter's reach along the bar — lies wholly over
 *    sections that Turns **above it in the tree** have made round. A Turn whose
 *    diameter is larger than the blank's inscribed circle leaves flats, so it
 *    does not count; a Polygon or an imported model above the feature over the
 *    same span is not round either. Everything else stays disabled with a
 *    reason ({@link SquareSheetBlock}).
 * 2. **Does the feature start above its surface?** Around features measure
 *    their depth from the bar surface (decided 2026-10-29), so a cut over a
 *    smaller Turned section starts in air. The warning says by how much and
 *    offers the one-click fix that lowers the span onto the Turn's surface; a
 *    band crossing a diameter change says so with no fix (Frank, 2026-10-31).
 *
 * A round bar never asks question 1; question 2 applies to both bar shapes.
 */

import type { DimensionRef, Operation, Project } from '../../types/project'
import { convertToolUnits } from '../../utils/units'
import { barInscribedRadius, isBarStock, isSquareStock } from '../../types/barStock'
import { getFeatureGeometryBounds } from '../../text'
import { aroundFeaturesActive } from './projectType'
import { resolveFeatureInstance } from './resolveFeatures'
import {
  buildSurfaceIndex,
  isRotaryPatternDefinition,
  overlap,
  rotarySurfaceZ,
  surfaceAtRange,
  turnSurfaceSections,
  type SurfaceIndex,
  type WorldBand,
} from './rotarySurface'

/** Numeric slack for along and radius comparisons, as in `rotarySurface.ts`. */
const TOLERANCE = 1e-6
/** Half-width given to a band with no along extent, so overlap tests can see it. */
const POINT_BAND = 1e-5

/**
 * Why square-bar sheet work is not cut. `uncut` is a section no Turn above the
 * feature has made round ("Turn this section round first"); `flats` is a
 * section a Polygon above it shapes into flats.
 */
export type SquareSheetBlock = 'uncut' | 'flats'

/** True for a rotary project on a square blank: the only place the turned-section rule applies. */
export function squareSheetRuleApplies(project: Pick<Project, 'meta' | 'stock'>): boolean {
  return aroundFeaturesActive(project) && isSquareStock(project.stock)
}

/**
 * The world along range an Around feature occupies on the bar. Around
 * geometry stores the unrolled sheet, whose along coordinate is the bar's own
 * project axis, so the placed geometry's bounds along that axis are the band.
 * Text and canned flat shapes are read through their generated outlines.
 */
export function aroundFeatureAlongRange(
  project: Project,
  featureId: string,
): WorldBand | null {
  if (!isBarStock(project.stock)) return null
  const resolved = resolveFeatureInstance(project, featureId)
  if (!resolved) return null
  const bounds = getFeatureGeometryBounds(resolved)
  const min = project.stock.axis === 'x' ? bounds.minX : bounds.minY
  const max = project.stock.axis === 'x' ? bounds.maxX : bounds.maxY
  return Number.isFinite(min) && Number.isFinite(max) && max >= min ? { min, max } : null
}

/** The along intervals Turns above `before` have made round, merged and sorted. */
function roundIntervals(project: Project, index: SurfaceIndex, before: number): WorldBand[] {
  if (!isBarStock(project.stock)) return []
  const limit = barInscribedRadius(project.stock) + TOLERANCE
  const pieces: WorldBand[] = []
  for (const turn of index.turns) {
    if (turn.order >= before) continue
    for (const section of turnSurfaceSections(turn)) {
      // A section larger than the inscribed circle only trims the corners:
      // flats are left, so the sheet's coordinates still do not describe it.
      if (!(section.radius <= limit)) continue
      if (section.alongMax - section.alongMin > TOLERANCE) {
        pieces.push({ min: section.alongMin, max: section.alongMax })
      }
    }
  }
  pieces.sort((left, right) => left.min - right.min)
  const merged: WorldBand[] = []
  for (const piece of pieces) {
    const last = merged[merged.length - 1]
    if (last && piece.min <= last.max + TOLERANCE) last.max = Math.max(last.max, piece.max)
    else merged.push({ ...piece })
  }
  return merged
}

/** True when the sorted, merged intervals leave no gap anywhere in `range`. */
function covered(intervals: readonly WorldBand[], range: WorldBand): boolean {
  let cursor = range.min
  for (const interval of intervals) {
    if (interval.max < cursor - TOLERANCE) continue
    if (interval.min > cursor + TOLERANCE) return false
    cursor = Math.max(cursor, interval.max)
    if (cursor >= range.max - TOLERANCE) return true
  }
  return false
}

/**
 * Whether a world along range on a square bar is round, judged for a row at
 * tree position `before`: null when every part of it lies over sections Turns
 * above that row have made round, otherwise why not.
 */
export function squareSheetRangeBlock(
  project: Project,
  index: SurfaceIndex,
  range: WorldBand,
  before: number,
): SquareSheetBlock | null {
  return squareSheetRangesBlock(project, index, [range], before)
}

/**
 * {@link squareSheetRangeBlock} for many ranges at once — every move of a
 * generated path — with the round sections read a single time.
 */
export function squareSheetRangesBlock(
  project: Project,
  index: SurfaceIndex,
  ranges: readonly WorldBand[],
  before: number,
): SquareSheetBlock | null {
  const models = index.models.filter((model) => model.order < before)
  const intervals = roundIntervals(project, index, before)
  for (const range of ranges) {
    if (!(range.max >= range.min)) return 'uncut'
    for (const model of models) {
      if (!overlap(range, { min: model.alongMin, max: model.alongMax })) continue
      // A Polygon cuts flats; an imported model is not known to be round.
      // Either way the sheet's cylinder is not the surface there.
      return model.polygon ? 'flats' : 'uncut'
    }
    if (!covered(intervals, range)) return 'uncut'
  }
  return null
}

/**
 * Why an Around feature's sheet work cannot be cut on this square bar, or
 * null when it can (or the rule does not apply). `reach` grows the feature's
 * band along the bar on both sides — an operation passes its cutter radius, so
 * the tool body has to stay over the turned section too.
 */
export function squareSheetFeatureBlock(
  project: Project,
  featureId: string,
  reach = 0,
  index: SurfaceIndex | null = buildSurfaceIndex(project),
): SquareSheetBlock | null {
  if (!squareSheetRuleApplies(project)) return null
  const order = project.features.findIndex((feature) => feature.id === featureId)
  const range = order >= 0 ? aroundFeatureAlongRange(project, featureId) : null
  if (!index || !range || order < 0) return 'uncut'
  const grown = Math.max(0, Number.isFinite(reach) ? reach : 0)
  return squareSheetRangeBlock(project, index, { min: range.min - grown, max: range.max + grown }, order)
}

/**
 * Whether a square bar has any section a Turn has made round, so drawing on
 * its Around sheet can make sense at all. A new row is appended below every
 * Turn, so every Turn in the tree counts.
 */
export function squareSheetHasRoundSection(project: Project): boolean {
  const index = buildSurfaceIndex(project)
  return index !== null && roundIntervals(project, index, Number.POSITIVE_INFINITY).length > 0
}

/**
 * The lowest surface under an Around feature, as a radius from the bar axis:
 * the bar's own (the inscribed radius on a square blank) or a smaller section
 * of a Turn above the feature in the tree. The 3D view pushes a subtract whose
 * top reaches this surface out past it, so the cut breaks through instead of
 * leaving a skin coplanar with the Turn (#1131 retest). Null without a bar or
 * a resolvable band.
 */
export function aroundLowestSurfaceRadius(
  project: Project,
  featureId: string,
  index: SurfaceIndex | null = buildSurfaceIndex(project),
): number | null {
  if (!isBarStock(project.stock) || !index) return null
  const order = project.features.findIndex((feature) => feature.id === featureId)
  const range = order >= 0 ? aroundFeatureAlongRange(project, featureId) : null
  if (!range) return null
  const band = range.max - range.min > POINT_BAND ? range : { min: range.min - POINT_BAND, max: range.max + POINT_BAND }
  let lowest = barInscribedRadius(project.stock)
  for (const turn of index.turns) {
    if (turn.order >= order) continue
    for (const section of turnSurfaceSections(turn)) {
      if (overlap(band, { min: section.alongMin, max: section.alongMax })) lowest = Math.min(lowest, section.radius)
    }
  }
  return lowest
}

// ── "Starts above its surface" (Frank, 2026-10-31) ─────────────

/**
 * An Around shape whose depth starts above the surface it sits on. `above`
 * lies wholly on one Turn and carries the span the one-click fix writes (the
 * same depth, lowered onto the Turn's surface); `crossing` sits over a Turn
 * edge or a step, where there is no one surface to start from, so no fix.
 */
export type AroundSurfaceStart =
  | { kind: 'above'; turnName: string; distance: number; zTop: number; zBottom: number }
  | { kind: 'crossing'; turnNames: string[] }

function zNumber(project: Project, value: DimensionRef): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const named = project.dimensions[value]?.value
  if (typeof named === 'number' && Number.isFinite(named)) return named
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Every Around shape — line, pocket, island, text, canned flat shape — whose
 * Z top is above the surface it actually sits on, judged against Turns above it
 * in the tree. Thread/Flutes are absent: they follow their Turn by themselves
 * (#1126 item 39). Nothing is changed here; the tree and Properties show it.
 */
export function aroundSurfaceStarts(
  project: Project,
  featureIds?: readonly string[],
): Map<string, AroundSurfaceStart> {
  const starts = new Map<string, AroundSurfaceStart>()
  if (!aroundFeaturesActive(project)) return starts
  const index = buildSurfaceIndex(project)
  if (!index || index.turns.length === 0) return starts
  const wanted = featureIds ? new Set(featureIds) : null
  for (const [order, feature] of project.features.entries()) {
    if (wanted && !wanted.has(feature.id)) continue
    if (feature.authoringFace !== 'around') continue
    const definition = project.featureDefinitions[feature.definitionId]
    if (!definition || definition.kind === 'stl') continue
    if (definition.operation !== 'add' && definition.operation !== 'subtract' && definition.operation !== 'line') continue
    if (isRotaryPatternDefinition(definition)) continue
    const zTop = zNumber(project, feature.z_top)
    const zBottom = zNumber(project, feature.z_bottom)
    if (zTop === null || zBottom === null) continue
    const placed = aroundFeatureAlongRange(project, feature.id)
    if (!placed) continue
    // A line around the bar at one axial position has no along extent; it
    // still sits on whatever surface is at that station.
    const range = placed.max - placed.min > POINT_BAND
      ? placed
      : { min: placed.min - POINT_BAND, max: placed.max + POINT_BAND }
    const surface = surfaceAtRange(project, index, range, order)
    if (surface.kind === 'turn') {
      const surfaceZ = rotarySurfaceZ(project.stock, surface.diameter)
      const distance = zTop - surfaceZ
      if (distance > TOLERANCE) {
        starts.set(feature.id, {
          kind: 'above',
          turnName: surface.turnName ?? '',
          distance,
          zTop: surfaceZ,
          zBottom: zBottom - distance,
        })
      }
      continue
    }
    if ((surface.kind === 'twoDiameters' || surface.kind === 'step' || surface.kind === 'taper')
      && (surface.turnNames?.length ?? 0) > 0) {
      starts.set(feature.id, { kind: 'crossing', turnNames: surface.turnNames ?? [] })
    }
  }
  return starts
}

// ── Operations ─────────────────────────────────────────────────

/**
 * The cutter's reach along the bar: its radius in project units. A missing or
 * unusable tool reaches everywhere, so the operation is refused rather than
 * judged with no body at all (the same fail-closed rule as the square
 * physical guard).
 */
export function squareSheetToolReach(
  project: Pick<Project, 'tools' | 'meta'>,
  operation: Pick<Operation, 'toolRef'>,
): number {
  const record = operation.toolRef ? project.tools.find((tool) => tool.id === operation.toolRef) : undefined
  if (!record) return Number.POSITIVE_INFINITY
  const radius = convertToolUnits(record, project.meta.units).diameter / 2
  return Number.isFinite(radius) && radius > 0 ? radius : Number.POSITIVE_INFINITY
}

/** Why a square-bar sheet operation is not cut, with the target rows it names. */
export interface SquareSheetOperationBlock {
  block: SquareSheetBlock
  featureIds: string[]
}

/**
 * Whether a 2D (non-rotary) operation on a square bar's Around face may cut
 * (#1131): every target is an Around feature whose band, grown by the
 * cutter's radius, lies over sections Turns above it have made round. A stock
 * target, or none, is never sheet work over a turned section. Null when the
 * operation is admitted; the caller decides the face and the kind.
 */
export function squareSheetOperationBlock(
  project: Project,
  operation: Pick<Operation, 'target' | 'toolRef'>,
): SquareSheetOperationBlock | null {
  const target = operation.target
  if (target.source !== 'features' || target.featureIds.length === 0) {
    return { block: 'uncut', featureIds: [] }
  }
  const index = buildSurfaceIndex(project)
  const reach = squareSheetToolReach(project, operation)
  let first: SquareSheetBlock | null = null
  const featureIds: string[] = []
  for (const featureId of target.featureIds) {
    const feature = project.features.find((row) => row.id === featureId)
    const block = !feature || feature.authoringFace !== 'around'
      ? 'uncut'
      : squareSheetFeatureBlock(project, featureId, reach, index)
    if (block === null) continue
    first ??= block
    featureIds.push(featureId)
  }
  return first === null ? null : { block: first, featureIds }
}
