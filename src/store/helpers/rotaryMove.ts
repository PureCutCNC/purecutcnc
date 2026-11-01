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
 * - the **across** part is dropped for all four kinds (issue #1112 rt7-f
 *   review). Frank asked for the preview "locked to the bar axis"; a canned
 *   rotary shape's only freedom along the sheet is its band, and the off-axis
 *   excursion is the bug rt6-d set out to remove. Thread and Flutes used to keep
 *   it on the theory that across the sheet is a turn around the bar — but a
 *   turn around the bar is the bar's own rotation, not a placement, so the
 *   result was a shape the bar cannot hold and a Move that visibly slid off the
 *   axis. Nothing is lost that the shape can express.
 *
 * A move is expressed on the *definition* (the stored start), exactly like a
 * parameter edit, so a linked copy follows it the same way a Polygon's
 * parameter edit moves its linked copies. The instance transform is left
 * untouched: a rotary move changes the band, never a placement.
 *
 * The clamp reads the band where it is *placed*, so a translated copy travels
 * as far as its own band has room. The write it lands on is still the shared
 * start, and a copy can sit far enough along the bar that the start the move
 * implies is one the kind's own generator refuses — a copy at +30 dragged to the
 * chuck end implies a negative start, which a Polygon does not normalize. That
 * write is refused and the row translates by the same drawn displacement
 * instead (the caller's existing fallback), so the band still lands where the
 * preview put it and the stored band stays one the generator accepts (third
 * review of rt6-d).
 *
 * A copy is the same definition **translated**, so each row's band may already
 * sit further along the bar than the stored start says. The bar's ends bound
 * the band where it is *placed*, and every clamp below reads it that way, so a
 * move can never carry a translated copy past the end (second review of rt6-d:
 * clamping against the shared start let repeated moves walk the copy off the
 * bar).
 */

import type { CannedShapeData, FeatureDefinition, FeatureInstance, Point, Project } from '../../types/project'
import { getStockBounds } from '../../types/project'
import { isBarStock } from '../../types/barStock'
import {
  FLUTES_CANNED_KIND,
  POLYGON_CANNED_KIND,
  THREAD_CANNED_KIND,
  TURN_CANNED_KIND,
} from '../../cannedShapes/generators/kinds'
import {
  rotarySolidBandProblem,
  rotarySolidBarLength,
  storedSolidFrameOf,
} from '../../cannedShapes/generators/rotarySolidParams'
import { storedFrameOf } from '../../cannedShapes/generators/rotaryPatternParams'
import { cannedShapeFrame } from '../../cannedShapes'
import { applyCannedShapeModelSpans, rebuildCannedShapeModelDefinitions } from '../../cannedShapes/model'

/** The four canned kinds whose band lies on the bar (Turn, Polygon, Thread, Flutes). */
export const ROTARY_MOVE_KINDS: readonly string[] = [
  TURN_CANNED_KIND,
  POLYGON_CANNED_KIND,
  THREAD_CANNED_KIND,
  FLUTES_CANNED_KIND,
]

/**
 * The kinds modelled as a solid body about the bar's axis: they carry their own
 * bar-frame snapshot and a regenerated mesh, unlike Thread/Flutes, which draw
 * lines on whatever surface they land on.
 */
const ROTARY_MODEL_KINDS = new Set<string>([TURN_CANNED_KIND, POLYGON_CANNED_KIND])

/** Numeric slack for "did the move change anything" and the band bounds. */
const TOLERANCE = 1e-9

/** A feature as the move rule reads it: its canned data and where its row sits. */
export interface RotaryMoveFeature {
  canned?: CannedShapeData | null
  /**
   * How far this row's band already sits along the bar from the shared
   * definition's stored start, in stored-start units.
   *
   * A definition is shared by every linked copy and a copy is placed by its
   * instance transform, so a row's band can be further along the bar than the
   * parameters say. The bar's ends bound the *placed* band, so the clamp has to
   * include this: without it a translated copy is clamped against the
   * definition's start and walks past the bar's end one move at a time (review
   * of rt6-d).
   */
  alongOffset?: number
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
 * The displacement a move of these features actually applies: the along part,
 * clamped so every band stays between the bar's ends, and nothing across — a
 * rotary canned band has no across placement, for any of the four kinds
 * (issue #1112 rt7-f review).
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

  // Every selected band has to stay on the bar, so the allowed start change is
  // the intersection of their own ranges. The range is the *placed* band's —
  // the stored start plus where this row's own instance translate puts it — so
  // a linked copy that has already been moved is clamped from where it is, not
  // from the shared definition's start (review of rt6-d). A band already
  // outside (a stale frame) contributes an empty range, which clamps to no
  // along move rather than pushing it further out.
  let lowest = Number.NEGATIVE_INFINITY
  let highest = Number.POSITIVE_INFINITY
  for (const feature of features) {
    const band = feature.canned ? rotaryMoveBand(project, feature.canned) : null
    if (!band) return { dx, dy }
    const placedStart = band.start + (feature.alongOffset ?? 0)
    lowest = Math.max(lowest, -placedStart)
    highest = Math.min(highest, band.barLength - placedStart - band.length)
  }
  if (lowest > highest) lowest = highest = 0

  const startDelta = Math.min(Math.max(along * direction, lowest), highest)
  const appliedAlong = startDelta * direction

  return axis === 'x' ? { dx: appliedAlong, dy: 0 } : { dx: 0, dy: appliedAlong }
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

/**
 * The displacement copy number `step` (1-based) of a rotary canned selection is
 * placed by, clamped to the bar *from where the previous copy landed*.
 *
 * A count greater than one does not repeat one clamp: a copy is placed by a
 * multiple of the drag, so the first copy can stop at the bar's end and the
 * second, placed another `dx` further, lands past it (issue #1112 rt7-f review:
 * a 10 mm Turn copied three times on a 120 mm bar landed at 110, 200 and
 * 290 mm). Each step therefore re-runs the same clamp the single-copy
 * projection uses, from the band the previous step left, so every copy is a
 * placement the bar can hold.
 *
 * A selection that is not a canned rotary one gets the ordinary multiple of the
 * drag back, which is what a copy has always been, so the copy builders and the
 * canvas can call this for every feature copy without a branch of their own.
 */
export function rotaryCopyStepDelta(
  project: Pick<Project, 'stock' | 'features' | 'featureDefinitions'>,
  featureIds: readonly string[],
  dx: number,
  dy: number,
  step: number,
): { dx: number; dy: number } {
  const features = rotaryMoveFeatures(project, featureIds)
  const axis = rotaryMoveAxis(project, features)
  if (!axis) return { dx: dx * step, dy: dy * step }

  const direction = alongStartDirection(axis)
  // The displacement `rotaryMoveDelta` answers with is in stock coordinates;
  // `alongOffset` is in stored-start units, so the two are linked by the bar's
  // own direction. `along` stays in stock coordinates, which is what the copy
  // transform is written in.
  let along = 0
  for (let index = 1; index <= step; index += 1) {
    const placed = features.map((feature) => ({
      ...feature,
      alongOffset: (feature.alongOffset ?? 0) + along * direction,
    }))
    const applied = rotaryMoveDelta(project, placed, dx, dy)
    along += axis === 'x' ? applied.dx : applied.dy
  }
  return axis === 'x' ? { dx: along, dy: 0 } : { dx: 0, dy: along }
}

/**
 * Where a row's own instance places its band along the bar, in stored-start
 * units: the translation component along the axis, signed the way `start`
 * runs from the chuck end.
 *
 * A linked copy is the same definitions translated, so this is what separates
 * its band from the shared start. Only the translation is read — a canned rotary
 * row is created by translation and its only other placement is a copy's, so a
 * rotation or scale can only arrive from a decoded file — and the bar's own ends
 * are what the clamp measures the placed band against.
 */
function instanceAlongOffset(row: FeatureInstance, axis: 'x' | 'y'): number {
  const along = axis === 'x' ? row.transform.e : row.transform.f
  return Number.isFinite(along) ? along * alongStartDirection(axis) : 0
}

/**
 * The rows a move holds, as {@link projectedRotaryMovePoint} reads them: each
 * row's canned data and its own along-bar placement, so a translated linked
 * copy clamps from where it actually sits.
 */
export function rotaryMoveFeatures(
  project: Pick<Project, 'stock' | 'features' | 'featureDefinitions'>,
  featureIds: readonly string[],
): RotaryMoveFeature[] {
  const axis = isBarStock(project.stock) ? project.stock.axis : null
  return featureIds.map((id) => {
    const row = project.features.find((feature) => feature.id === id)
    const definition = row ? project.featureDefinitions[row.definitionId] : undefined
    return {
      canned: definition?.canned ?? null,
      alongOffset: row && axis ? instanceAlongOffset(row, axis) : 0,
    }
  })
}

/**
 * A pending move's target point, projected onto the bar for a canned rotary
 * move or copy and returned unchanged for every other move.
 *
 * A **copy** is projected too (issue #1112 rt7-f): Frank's copy of a rotary
 * feature slid off the bar's axis while a move of the same shape stayed on it.
 * A copy is placed by its own instance translate, so the same displacement that
 * places a moved band places the copy, with the same clamp: the copy's band is
 * the source band translated, so keeping `source + delta` inside the bar keeps
 * the copy inside it too. Both the pointer preview and the click that ends the
 * drag go through this, so the drawn guide, the typed default distance and the
 * stored result come from one place.
 */
export function projectedMoveTarget(
  project: Pick<Project, 'stock' | 'features' | 'featureDefinitions'>,
  move: { mode: 'move' | 'copy'; entityType: string; entityIds: readonly string[] },
  from: Point,
  to: Point,
): Point {
  if (move.entityType !== 'feature') return to
  return projectedRotaryMovePoint(project, rotaryMoveFeatures(project, move.entityIds), from, to)
}

/**
 * The point a pending move's outline is drawn at for a raw preview point.
 *
 * Every way a preview point arrives — a pointer drag, a typed distance, a
 * resnap after typing — publishes through one call, and that call is this one,
 * so no path can draw a place the commit will not store. A move and a copy
 * project alike; every non-rotary selection, and every other entity type,
 * passes through unchanged, exactly as {@link projectedMoveTarget} does.
 */
export function projectMovePreviewPoint(
  project: Pick<Project, 'stock' | 'features' | 'featureDefinitions'>,
  move: { mode: 'move' | 'copy'; entityType: string; entityIds: readonly string[] } | null | undefined,
  fromPoint: Point | null | undefined,
  point: Point,
): Point {
  if (!move || !fromPoint) return point
  return projectedMoveTarget(project, move, fromPoint, point)
}

/**
 * The displacement the selected rows are actually translated by.
 *
 * Three callers, one projection:
 *  - a **move** that cannot write the shared band — its definition also places
 *    a linked copy the selection does not hold — keeps the definition and
 *    translates the selected rows, which is what a Polygon's move did before
 *    this slice;
 *  - a **copy** is placed by the same projected displacement (issue #1112
 *    rt7-f), so a copy travels along the bar exactly as far as a move would and
 *    stops at the bar's ends;
 *  - a non-rotary selection gets its displacement back unchanged.
 *
 * The translation is the same projection the preview drew, so the drawn place
 * is still the stored one.
 */
export function rotaryMoveTranslateDelta(
  project: Pick<Project, 'stock' | 'features' | 'featureDefinitions'>,
  featureIds: readonly string[],
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  return rotaryMoveDelta(project, rotaryMoveFeatures(project, featureIds), dx, dy)
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
 * True when `start` is a stored start this kind's own parameters accept.
 *
 * A Turn or a Polygon validates its band with `rotarySolidBandProblem` —
 * `start >= 0` and `start + length <= the bar` — while a Thread or a Flute line
 * build only refuses a negative start. A move may write nothing else, or the
 * shape would keep the mesh it has while the preview promised a new place
 * (third review of rt6-d).
 */
function storedStartFits(canned: CannedShapeData, band: RotaryMoveBand, start: number): boolean {
  if (!Number.isFinite(start)) return false
  if (ROTARY_MODEL_KINDS.has(canned.kind)) {
    const frame = storedSolidFrameOf(canned.params)
    if (!frame) return false
    return rotarySolidBandProblem(frame, start, band.length) === null
  }
  return start >= 0
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
 *
 * Returns null when there is no band to write or when the start the move
 * implies is outside the range the kind accepts: the caller then translates the
 * row instead, which is what the preview drew anyway.
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
  if (!storedStartFits(canned, band, start)) return null
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
 * regenerated model follow), the model's mesh and every linked instance's Z
 * span. Nothing is written across, for any of the four kinds (issue #1112 rt7-f
 * review). The caller adds the undo entry, so a move stays one step.
 *
 * A definition is shared with every linked copy, so its stored start belongs to
 * all of them. This returns null — the caller's per-instance translate — unless
 * the selection holds every row that shares the definition, because writing the
 * start would move a copy the user did not select (review of rt6-d). It returns
 * null for the same reason when the start the move implies is outside the range
 * the kind accepts: a translated copy dragged to a bar end implies a negative
 * start, and storing that band left the shape's mesh where it was (third review
 * of rt6-d). The translate is the same projected displacement the preview drew.
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

  const selected = new Set(featureIds)
  if (instances.some((row) => project.features.some(
    (other) => other.definitionId === row.definitionId && !selected.has(other.id),
  ))) {
    return null
  }

  const definitions = instances.map((row) => project.featureDefinitions[row.definitionId] ?? null)
  if (definitions.some((definition) => definition === null)) return null
  const canned = definitions.map((definition) => (definition as FeatureDefinition).canned ?? null)
  if (!canned.every((data) => isRotaryMoveKind(data))) return null

  // Each row's own placement is part of its band here too: this writes the
  // shared start, and the clamp that decides how far it may go is the placed
  // band's, exactly as the preview's (review of rt6-d).
  const stockAxis = isBarStock(project.stock) ? project.stock.axis : null
  if (!stockAxis) return null
  const moveFeatures = canned.map((data, index) => ({
    canned: data,
    alongOffset: instanceAlongOffset(instances[index], stockAxis),
  }))
  const axis = rotaryMoveAxis(project, moveFeatures)
  if (!axis) return null
  const delta = rotaryMoveDelta(project, moveFeatures, to.x - from.x, to.y - from.y)

  const startMoves = canned
    .map((data) => (data ? movedCannedBand(project, data, delta) : null))
    .filter((data): data is CannedShapeData => data !== null)
  if (startMoves.length !== canned.length) return null

  const changedStart = startMoves.some((data, index) => data !== canned[index])
  if (!changedStart) return project

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
    return {
      ...project,
      features: applyCannedShapeModelSpans(project, project.features, rebuilt.models),
      featureDefinitions: rebuilt.featureDefinitions,
      modelAssets: rebuilt.modelAssets,
    }
  }

  return { ...project, featureDefinitions }
}
