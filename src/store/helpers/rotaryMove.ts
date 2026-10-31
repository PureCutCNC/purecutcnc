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
 * Moving a canned rotary feature (issue #1112 rt6-d, item 42).
 *
 * Frank: "the Move preview lets them leave the bar's axis and the finished move
 * snaps them back; a Turn can't be moved at all." A Turn, Polygon, Thread or
 * Flutes stores its band as a start/length from the chuck end, so a free 2D
 * drag is not what these features can express: the *band* is what moves, along
 * the bar. This module is the one rule for that, used by both the canvas
 * preview and the commit, so what is drawn at release is what is stored:
 *
 * - the **along** part of a drag becomes a change of the stored start, clamped
 *   to the bar exactly like the Polygon panel's `start`/`length` range, so
 *   `Edit Turn…`/`Edit Thread…` and the regenerated model follow it;
 * - the **across** part is kept only for Thread/Flutes, where across the sheet
 *   is a turn around the bar and a commit has always kept it. A Turn or Polygon
 *   is a body about the bar's axis, so its across motion is dropped — that is
 *   the off-axis excursion Frank saw, and the reason the finished move looked
 *   like it snapped back onto the bar.
 *
 * A move is expressed on the *definition* (the stored start), exactly like a
 * parameter edit, so a linked copy follows it the same way a Polygon's
 * parameter edit moves its linked copies. The instance transform carries only
 * the across part, which no canned kind but Thread/Flutes has.
 */

import type { CannedShapeData, FeatureDefinition, Point, Project } from '../../types/project'
import { getStockBounds } from '../../types/project'
import { isBarStock } from '../../types/barStock'
import {
  FLUTES_CANNED_KIND,
  POLYGON_CANNED_KIND,
  THREAD_CANNED_KIND,
  TURN_CANNED_KIND,
} from '../../cannedShapes/generators/kinds'
import {
  rotarySolidBarLength,
  storedSolidFrameOf,
} from '../../cannedShapes/generators/rotarySolidParams'
import { storedFrameOf } from '../../cannedShapes/generators/rotaryPatternParams'
import { cannedShapeFrame } from '../../cannedShapes'
import { applyCannedShapeModelSpans, rebuildCannedShapeModelDefinitions } from '../../cannedShapes/model'
import { moveDelta, multiplyMatrix } from './instanceTransforms'

/** The four canned kinds whose band lies on the bar (Turn, Polygon, Thread, Flutes). */
export const ROTARY_MOVE_KINDS: readonly string[] = [
  TURN_CANNED_KIND,
  POLYGON_CANNED_KIND,
  THREAD_CANNED_KIND,
  FLUTES_CANNED_KIND,
]

/** The kinds that are a body about the bar's axis, so across motion means nothing. */
const ROTARY_MODEL_KINDS = new Set<string>([TURN_CANNED_KIND, POLYGON_CANNED_KIND])

/** Numeric slack for "did the move change anything" and the band bounds. */
const TOLERANCE = 1e-9

/** A feature as the move rule reads it: just its canned data. */
export interface RotaryMoveFeature {
  canned?: CannedShapeData | null
}

/** A band in stored terms: the start from the chuck end, its length, and the bar it sits on. */
export interface RotaryMoveBand {
  start: number
  length: number
  barLength: number
}

function isRotaryMoveKind(canned: CannedShapeData | null | undefined): boolean {
  return !!canned && ROTARY_MOVE_KINDS.includes(canned.kind)
}

/**
 * The bar axis a canned rotary move travels along, or null when this is an
 * ordinary 2D move.
 *
 * Null unless the stock is a bar and **every** given feature is one of the four
 * canned rotary kinds: a selection that also holds an ordinary feature keeps
 * the generic move, where one displacement has to mean one thing.
 */
export function rotaryMoveAxis(
  project: Pick<Project, 'stock'>,
  features: readonly RotaryMoveFeature[],
): 'x' | 'y' | null {
  if (features.length === 0) return null
  if (!isBarStock(project.stock)) return null
  if (!features.every((feature) => isRotaryMoveKind(feature.canned))) return null
  return project.stock.axis
}

/** `+1` on an X bar and `-1` on a Y bar: increasing `start` runs this way in stock coords. */
function alongStartDirection(axis: 'x' | 'y'): 1 | -1 {
  return axis === 'x' ? 1 : -1
}

/**
 * The stored band of a canned rotary feature, or null when its parameters do
 * not describe one.
 *
 * A Turn/Polygon's own frame snapshot gives the bar it was drawn against; a
 * Thread/Flutes frame stores the chuck end but not the far end, so those use the
 * project's bar length.
 */
export function rotaryMoveBand(
  project: Pick<Project, 'stock'>,
  canned: CannedShapeData,
): RotaryMoveBand | null {
  const start = canned.params.start
  const length = canned.params.length
  if (typeof start !== 'number' || typeof length !== 'number') return null
  if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) return null
  if (ROTARY_MODEL_KINDS.has(canned.kind)) {
    const frame = storedSolidFrameOf(canned.params)
    if (!frame) return null
    return { start, length, barLength: rotarySolidBarLength(frame) }
  }
  if (!storedFrameOf(canned.params)) return null
  if (!isBarStock(project.stock)) return null
  const bounds = getStockBounds(project.stock)
  const barLength = project.stock.axis === 'x'
    ? bounds.maxX - bounds.minX
    : bounds.maxY - bounds.minY
  return { start, length, barLength }
}

/**
 * The displacement a move of these features actually applies: the along part
 * clamped so every band stays between the bar's ends, plus the across part for
 * Thread/Flutes only.
 *
 * Returning the input unchanged for anything that is not a canned rotary move
 * keeps this callable from the shared preview code without a branch at the call
 * site.
 */
export function rotaryMoveDelta(
  project: Pick<Project, 'stock'>,
  features: readonly RotaryMoveFeature[],
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  const axis = rotaryMoveAxis(project, features)
  if (!axis) return { dx, dy }

  const direction = alongStartDirection(axis)
  const along = axis === 'x' ? dx : dy
  const across = axis === 'x' ? dy : dx

  // Every selected band has to stay on the bar, so the allowed start change is
  // the intersection of their own ranges. A band already outside (a stale frame)
  // contributes an empty range, which clamps to no along move rather than
  // pushing it further out.
  let lowest = Number.NEGATIVE_INFINITY
  let highest = Number.POSITIVE_INFINITY
  for (const feature of features) {
    const band = feature.canned ? rotaryMoveBand(project, feature.canned) : null
    if (!band) return { dx, dy }
    lowest = Math.max(lowest, -band.start)
    highest = Math.min(highest, band.barLength - band.start - band.length)
  }
  if (lowest > highest) lowest = highest = 0

  const startDelta = Math.min(Math.max(along * direction, lowest), highest)
  const appliedAlong = startDelta * direction
  const keepsAcross = features.every((feature) => !!feature.canned && !ROTARY_MODEL_KINDS.has(feature.canned.kind))

  return axis === 'x'
    ? { dx: appliedAlong, dy: keepsAcross ? across : 0 }
    : { dx: keepsAcross ? across : 0, dy: appliedAlong }
}

/** Where the canvas preview draws the feature for a proposed drag: the committed place. */
export function projectedRotaryMovePoint(
  project: Pick<Project, 'stock'>,
  features: readonly RotaryMoveFeature[],
  from: Point,
  to: Point,
): Point {
  const delta = rotaryMoveDelta(project, features, to.x - from.x, to.y - from.y)
  return { x: from.x + delta.dx, y: from.y + delta.dy }
}

/** The canned data of a move's selected rows, as {@link projectedRotaryMovePoint} reads it. */
export function rotaryMoveFeatures(
  project: Pick<Project, 'features' | 'featureDefinitions'>,
  featureIds: readonly string[],
): RotaryMoveFeature[] {
  return featureIds.map((id) => {
    const row = project.features.find((feature) => feature.id === id)
    const definition = row ? project.featureDefinitions[row.definitionId] : undefined
    return { canned: definition?.canned ?? null }
  })
}

/**
 * A pending move's target point, projected onto the bar for a canned rotary
 * move and returned unchanged for every other move or for a copy (a copy is a
 * new row, not this feature's band). Both the pointer preview and the click
 * that ends the drag go through this, so the drawn guide, the typed default
 * distance and the stored result come from one place.
 */
export function projectedMoveTarget(
  project: Pick<Project, 'stock' | 'features' | 'featureDefinitions'>,
  move: { mode: 'move' | 'copy'; entityType: string; entityIds: readonly string[] },
  from: Point,
  to: Point,
): Point {
  if (move.mode !== 'move' || move.entityType !== 'feature') return to
  return projectedRotaryMovePoint(project, rotaryMoveFeatures(project, move.entityIds), from, to)
}

/**
 * A copied Turn profile with every contour moved `along` the bar, in the
 * absolute stock coordinates the profile stores (its points are checked against
 * the bar's ends when they are copied).
 */
function shiftedTurnProfile(profile: unknown, along: number): unknown | null {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null
  const contours = (profile as { contours?: unknown }).contours
  if (!Array.isArray(contours)) return null
  return {
    ...(profile as Record<string, unknown>),
    contours: contours.map((contour) => {
      if (!contour || typeof contour !== 'object') return contour
      const points = (contour as { points?: unknown }).points
      if (!Array.isArray(points)) return contour
      return {
        ...(contour as Record<string, unknown>),
        points: points.map((point) => (
          point && typeof point === 'object'
            ? { ...(point as Record<string, unknown>), along: Number((point as { along?: unknown }).along) + along }
            : point
        )),
      }
    }),
  }
}

/**
 * The same canned parameters with the band moved by an applied along
 * displacement.
 *
 * A Turn profile is the geometry, not a decoration (issue #1112 H): its
 * contours are absolute stock-space `(along, radius)` points and the stored
 * start is derived from them, so moving a profiled Turn shifts the contours and
 * lets the start follow — changing the start alone would regenerate the same
 * mesh in the same place.
 */
function movedCannedBand(
  project: Pick<Project, 'stock'>,
  canned: CannedShapeData,
  applied: { dx: number; dy: number },
): CannedShapeData | null {
  const axis = project.stock && isBarStock(project.stock) ? project.stock.axis : null
  if (!axis) return null
  const band = rotaryMoveBand(project, canned)
  if (!band) return null
  const along = axis === 'x' ? applied.dx : applied.dy
  if (Math.abs(along) <= TOLERANCE) return canned
  const start = band.start + along * alongStartDirection(axis)
  if (!Number.isFinite(start)) return null
  const storedProfile = canned.params.profile
  if (storedProfile === undefined || storedProfile === null) {
    return { kind: canned.kind, params: { ...canned.params, start } }
  }
  const profile = shiftedTurnProfile(storedProfile, along)
  if (!profile) return null
  return {
    kind: canned.kind,
    params: {
      ...canned.params,
      start,
      profile: profile as CannedShapeData['params'][string],
    },
  }
}

/**
 * The project a committed move of these canned rotary features writes, or null
 * when the request is not one (a lock, a missing row, an ordinary feature, no
 * bar) and the generic move should run instead.
 *
 * One write: the definition's stored start (so the edit panel and the
 * regenerated model follow), the model's mesh, every linked instance's Z span,
 * and the across displacement a Thread/Flutes keeps. The caller adds the undo
 * entry, so a move stays one step.
 */
export function moveCannedRotaryFeatures(
  project: Project,
  featureIds: readonly string[],
  from: Point,
  to: Point,
): Project | null {
  if (featureIds.length === 0) return null
  const rows = featureIds.map((id) => project.features.find((feature) => feature.id === id) ?? null)
  if (rows.some((row) => row === null)) return null
  const instances = rows as NonNullable<(typeof rows)[number]>[]
  if (instances.some((row) => row.locked)) return null

  const definitions = instances.map((row) => project.featureDefinitions[row.definitionId] ?? null)
  if (definitions.some((definition) => definition === null)) return null
  const canned = definitions.map((definition) => (definition as FeatureDefinition).canned ?? null)
  if (!canned.every((data) => isRotaryMoveKind(data))) return null

  const moveFeatures = canned.map((data) => ({ canned: data }))
  const axis = rotaryMoveAxis(project, moveFeatures)
  if (!axis) return null
  const delta = rotaryMoveDelta(project, moveFeatures, to.x - from.x, to.y - from.y)

  // The across part is the only thing the instance transform carries; the along
  // part lives in the stored start.
  const acrossX = axis === 'x' ? 0 : delta.dx
  const acrossY = axis === 'x' ? delta.dy : 0
  const startMoves = canned
    .map((data) => (data ? movedCannedBand(project, data, delta) : null))
    .filter((data): data is CannedShapeData => data !== null)
  if (startMoves.length !== canned.length) return null

  const changedStart = startMoves.some((data, index) => data !== canned[index])
  const movedAcross = Math.abs(acrossX) > TOLERANCE || Math.abs(acrossY) > TOLERANCE
  if (!changedStart && !movedAcross) return project

  let featureDefinitions = project.featureDefinitions
  const changedDefinitions = new Set<string>()
  instances.forEach((row, index) => {
    const next = startMoves[index]
    const current = featureDefinitions[row.definitionId]
    if (!current || next === canned[index]) return
    featureDefinitions = {
      ...featureDefinitions,
      [row.definitionId]: {
        ...current,
        canned: next,
        profile: cannedShapeFrame(next) ?? current.profile,
      },
    }
    changedDefinitions.add(row.definitionId)
  })

  let nextFeatures = movedAcross
    ? project.features.map((row) => {
        if (!featureIds.includes(row.id)) return row
        return { ...row, transform: multiplyMatrix(moveDelta(acrossX, acrossY), row.transform) }
      })
    : project.features

  const modelDefinitionIds = new Set(
    [...changedDefinitions].filter((id) => {
      const data = featureDefinitions[id]?.canned
      return !!data && ROTARY_MODEL_KINDS.has(data.kind)
    }),
  )
  if (modelDefinitionIds.size > 0) {
    const rebuilt = rebuildCannedShapeModelDefinitions(
      { ...project, featureDefinitions },
      modelDefinitionIds,
    )
    featureDefinitions = rebuilt.featureDefinitions
    nextFeatures = applyCannedShapeModelSpans(project, nextFeatures, rebuilt.models)
    return {
      ...project,
      features: nextFeatures,
      featureDefinitions,
      modelAssets: rebuilt.modelAssets,
    }
  }

  return { ...project, features: nextFeatures, featureDefinitions }
}
