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

// Sheet nesting, project side (issue #846, step 2 of #741): turns a selection
// into one rigid part and a packer request. Pure — the store slice commits.

import ClipperLib from 'clipper-lib'
import {
  flattenProfileWithin,
  requestFromJob,
  type NestGravity,
  type NestJob,
  type NestPlacement,
  type NestRequest,
  type NestRing,
} from '../../engine/nesting'
import {
  differencePaths,
  NEST_SCALE,
  outerContours,
  pathsBox,
  pathToRing,
  rectPath,
  regionComponents,
  ringToPath,
  unionPaths,
} from '../../engine/nesting/clipperOps'
import { normalizeToolForProject, resolveFeatureZSpan } from '../../engine/toolpaths/geometry'
import { CLAMP_KEEPOUT_EPSILON } from '../../engine/toolpaths/modelProtection'
import type { ClipperPath } from '../../engine/toolpaths/types'
import { getFeatureGeometryProfiles, isTextFeature, resolveTextFeatureShapes } from '../../text'
import {
  getStockBounds,
  type FeatureOperation,
  type LocalConstraint,
  type Matrix2D,
  type NestMargins,
  type NestRecord,
  type NestSettings,
  type OperationKind,
  type Point,
  type Project,
  type SketchProfile,
} from '../../types/project'
import { isMachinable } from './featureRoles'
import { resolvedProjectFeatures, type ResolvedSketchFeature } from './resolveFeatures'

/**
 * Chord tolerance for flattening curves, in project units. Parts grow and the
 * sheet shrinks by it, so flattening never costs clearance.
 */
export function nestFlattenTolerance(project: Pick<Project, 'meta'>): number {
  return project.meta.units === 'inch' ? 0.0004 : 0.01
}

export type NestPartRefusal = 'empty' | 'locked' | 'model' | 'external-constraint' | 'no-closed-geometry'

function featureRings(feature: ResolvedSketchFeature, tolerance: number): { ring: NestRing; closed: boolean }[] {
  return getFeatureGeometryProfiles(feature)
    .filter((profile) => profile.segments.length > 0)
    .map((profile) => ({ ring: flattenProfileWithin(profile, tolerance), closed: profile.closed }))
}

function closedPaths(feature: ResolvedSketchFeature, tolerance: number): ClipperPath[] {
  return featureRings(feature, tolerance)
    .filter((entry) => entry.closed && entry.ring.length >= 3)
    .map((entry) => ringToPath(entry.ring))
}

function pathsArea(paths: ClipperPath[]): number {
  return paths.reduce((sum, path) => sum + Math.abs(ClipperLib.Clipper.Area(path)), 0)
}

function pointInPaths(point: Point, paths: ClipperPath[]): boolean {
  const x = point.x * NEST_SCALE
  const y = point.y * NEST_SCALE
  let inside = false
  for (const path of paths) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i, i += 1) {
      const a = path[i]
      const b = path[j]
      if ((a.Y > y) !== (b.Y > y) && x < ((b.X - a.X) * (y - a.Y)) / (b.Y - a.Y) + a.X) inside = !inside
    }
  }
  return inside
}

function perimeter(ring: NestRing): number {
  return ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length]
    return sum + Math.hypot(next.x - point.x, next.y - point.y)
  }, 0)
}

/**
 * Integer-unit area two independently flattened copies of the same boundary
 * can disagree by: a sliver no wider than twice the chord tolerance.
 */
function flatteningSlack(ring: NestRing, tolerance: number): number {
  return 2 * tolerance * perimeter(ring) * NEST_SCALE * NEST_SCALE
}

/** Every closed ring lies within `outline` and every open polyline's points do too. */
function liesWithin(feature: ResolvedSketchFeature, outline: ClipperPath[], tolerance: number): boolean {
  const rings = featureRings(feature, tolerance)
  if (rings.length === 0) return false
  return rings.every(({ ring, closed }) => (
    closed && ring.length >= 3
      ? pathsArea(differencePaths([ringToPath(ring)], outline)) <= flatteningSlack(ring, tolerance)
      : ring.every((point) => pointInPaths(point, outline))
  ))
}

/** The feature a constraint measures from, if any (fixed-distance rows mirror it in segment_ids[0]). */
export function constraintReference(constraint: LocalConstraint): string | undefined {
  return constraint.reference_feature_id ?? (constraint.type === 'fixed_distance' ? constraint.segment_ids[0] : undefined)
}

export interface NestPartSpec {
  /** The part's instances, in authored order. */
  featureIds: string[]
  /** Filled outer contours of its closed machinable outlines. */
  footprint: NestRing[]
  /** Holes other parts may be placed in (see {@link nestPartHoles}). */
  holes: NestRing[]
  /** A grouped folder's name, or the name of the part's largest feature. */
  name: string
}

export type NestPartsResolution =
  | { ok: true; parts: NestPartSpec[] }
  | { ok: false; refusal: NestPartRefusal; featureId?: string }

function pathsBoxOverlap(a: ClipperPath, b: ClipperPath): boolean {
  const box = (path: ClipperPath) => path.reduce((acc, p) => ({
    minX: Math.min(acc.minX, p.X), minY: Math.min(acc.minY, p.Y), maxX: Math.max(acc.maxX, p.X), maxY: Math.max(acc.maxY, p.Y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
  const ba = box(a)
  const bb = box(b)
  return ba.minX <= bb.maxX && bb.minX <= ba.maxX && ba.minY <= bb.maxY && bb.minY <= ba.maxY
}

/**
 * Splits a selection into rigid parts (#741 decision 1, extended in #855):
 *
 * - every grouped folder the selection touches is one part;
 * - the rest is split by outline — closed machinable outlines that overlap or
 *   touch form one part, and a feature with several outlines (a text run's
 *   glyphs) keeps them in one part;
 * - every other feature lying inside a part's outline joins that part.
 *
 * Parts the nest must not move are refused: a locked member, an imported
 * model, or a constraint that measures from outside its own part.
 */
export function resolveNestParts(project: Project, selectedIds: string[]): NestPartsResolution {
  const resolved = resolvedProjectFeatures(project)
  const byId = new Map(resolved.map((feature) => [feature.id, feature]))
  const selected = new Set(selectedIds.filter((id) => byId.has(id)))
  if (selected.size === 0) return { ok: false, refusal: 'empty' }
  const tolerance = nestFlattenTolerance(project)
  const closedOf = new Map<string, ClipperPath[]>()
  const closed = (id: string) => {
    let paths = closedOf.get(id)
    if (!paths) {
      const feature = byId.get(id)!
      paths = isMachinable(feature) ? closedPaths(feature, tolerance) : []
      closedOf.set(id, paths)
    }
    return paths
  }

  const groupedFolders = new Map(project.featureFolders.filter((folder) => folder.grouped).map((folder) => [folder.id, folder]))
  const touchedGroups = new Set(
    [...selected].map((id) => byId.get(id)!.folderId).filter((folderId): folderId is string => !!folderId && groupedFolders.has(folderId)),
  )
  const drafts: { ids: Set<string>; outline: ClipperPath[]; name: string | null }[] = []
  for (const folderId of touchedGroups) {
    const ids = new Set(resolved.filter((feature) => feature.folderId === folderId).map((feature) => feature.id))
    const outline = outerContours([...ids].flatMap(closed))
    if (outline.length > 0) drafts.push({ ids, outline, name: groupedFolders.get(folderId)!.name })
  }

  // Loose selection: connected components over the union's outer contours.
  const loose = [...selected].filter((id) => !touchedGroups.has(byId.get(id)!.folderId ?? ''))
  const looseClosed = loose.filter((id) => closed(id).length > 0)
  const contours = outerContours(looseClosed.flatMap(closed))
  const parent = contours.map((_, index) => index)
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])))
  const contoursOf = new Map<string, number[]>()
  for (const id of looseClosed) {
    const owned = new Set<number>()
    for (const path of closed(id)) {
      const index = contours.findIndex((contour) => pathsBoxOverlap(path, contour)
        && pathsArea(differencePaths([path], [contour])) <= flatteningSlack(pathToRing(path), tolerance))
      if (index >= 0) owned.add(index)
    }
    const list = [...owned]
    list.slice(1).forEach((index) => { parent[find(index)] = find(list[0]) })
    contoursOf.set(id, list)
  }
  const components = new Map<number, { ids: Set<string>; outline: ClipperPath[] }>()
  contours.forEach((contour, index) => {
    const root = find(index)
    const component = components.get(root) ?? { ids: new Set<string>(), outline: [] }
    component.outline.push(contour)
    components.set(root, component)
  })
  for (const [id, list] of contoursOf) {
    if (list.length > 0) components.get(find(list[0]))!.ids.add(id)
  }
  // A contour no feature claims (possible only through rounding) is skipped
  // rather than nested as an empty part.
  for (const component of components.values()) {
    if (component.ids.size > 0) drafts.push({ ...component, name: null })
  }
  if (drafts.length === 0) return { ok: false, refusal: 'no-closed-geometry' }

  // Everything else inside a part's outline travels with it.
  const assigned = new Set(drafts.flatMap((draft) => [...draft.ids]))
  for (const feature of resolved) {
    if (assigned.has(feature.id)) continue
    const draft = drafts.find((candidate) => liesWithin(feature, candidate.outline, tolerance))
    if (draft) {
      draft.ids.add(feature.id)
      assigned.add(feature.id)
    }
  }

  const order = new Map(project.features.map((feature, index) => [feature.id, index]))
  const parts: NestPartSpec[] = []
  for (const draft of drafts) {
    const featureIds = [...draft.ids].sort((a, b) => order.get(a)! - order.get(b)!)
    for (const id of featureIds) {
      const feature = byId.get(id)!
      if (feature.locked) return { ok: false, refusal: 'locked', featureId: id }
      if (feature.kind === 'stl') return { ok: false, refusal: 'model', featureId: id }
      const external = feature.sketch.constraints.some((constraint) => {
        const reference = constraintReference(constraint)
        return reference !== undefined && reference !== id && !draft.ids.has(reference)
      })
      if (external) return { ok: false, refusal: 'external-constraint', featureId: id }
    }
    const largest = featureIds
      .map((id) => ({ id, area: pathsArea(closed(id)) }))
      .reduce((best, entry) => (entry.area > best.area ? entry : best), { id: featureIds[0], area: -1 })
    parts.push({
      featureIds,
      footprint: draft.outline.map(pathToRing),
      holes: nestPartHoles(project, featureIds.map((id) => byId.get(id)!), tolerance),
      name: draft.name ?? byId.get(largest.id)!.name,
    })
  }
  const spanning = project.global_constraints.find((constraint) => parts.some((part) => (
    constraint.feature_ids.some((id) => part.featureIds.includes(id)) && constraint.feature_ids.some((id) => !part.featureIds.includes(id))
  )))
  if (spanning) {
    return { ok: false, refusal: 'external-constraint', featureId: spanning.feature_ids.find((id) => assigned.has(id)) }
  }
  parts.sort((a, b) => order.get(a.featureIds[0])! - order.get(b.featureIds[0])!)
  return { ok: true, parts }
}

/** Operations that cut only along a boundary, leaving what it encloses whole. */
const EDGE_ROUTE_KINDS: ReadonlySet<OperationKind> = new Set(['edge_route_inside', 'edge_route_outside'])

/** Nothing clears, drills or carves inside the feature: every operation targeting it only routes its edge. */
function onlyEdgeRouted(project: Project, featureId: string): boolean {
  return project.operations.every((operation) => (
    operation.target.source !== 'features'
    || !operation.target.featureIds.includes(featureId)
    || EDGE_ROUTE_KINDS.has(operation.kind)
  ))
}

function intersectionArea(a: ClipperPath[], b: ClipperPath[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(a, ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths(b, ClipperLib.PolyType.ptClip, true)
  const solution: ClipperPath[] = new ClipperLib.Paths()
  clipper.Execute(ClipperLib.ClipType.ctIntersection, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return solution.reduce((sum, path) => sum + ClipperLib.Clipper.Area(path), 0)
}

/** An open polyline as a closed sliver two units wide, so it can be intersected. */
function polylineSliver(ring: NestRing): ClipperPath[] {
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths([ringToPath(ring)], ClipperLib.JoinType.jtSquare, ClipperLib.EndType.etOpenSquare)
  const solution: ClipperPath[] = new ClipperLib.Paths()
  offset.Execute(solution, 1)
  return solution
}

interface PartShape {
  featureId: string
  operation: FeatureOperation
  profile: SketchProfile
  min: number
  max: number
}

/**
 * Holes another part may be placed in (#859): regions enclosed by the part's
 * material where nothing would machine a part lying inside.
 *
 * The material is built in row order: add shapes are unioned, and a subtract
 * shape that cuts the part's full depth and is only ever edge-routed opens it.
 * A text feature's counters are such subtracts. A hole survives only if every
 * other shape either misses it or covers it whole — so no open profile, other
 * subtract or crossing boundary lies inside, while an island of material may.
 * Anything doubtful drops the hole, which costs placements, never clearance.
 */
export function nestPartHoles(project: Project, features: ResolvedSketchFeature[], tolerance: number): NestRing[] {
  const shapes: PartShape[] = features.filter(isMachinable).flatMap((feature) => {
    const span = resolveFeatureZSpan(project, feature)
    const own = isTextFeature(feature)
      ? resolveTextFeatureShapes(feature)
      : [{ operation: feature.operation, profile: feature.sketch.profile }]
    return own.map((shape) => ({ featureId: feature.id, operation: shape.operation, profile: shape.profile, min: span.min, max: span.max }))
  })
  const adds = shapes.filter((shape) => shape.operation === 'add' && shape.profile.closed)
  if (adds.length === 0) return []
  const top = Math.max(...adds.map((shape) => shape.max))
  const bottom = Math.min(...adds.map((shape) => shape.min))
  const Z_EPSILON = 1e-9
  const edgeRouted = new Map<string, boolean>()
  const opens = (shape: PartShape) => {
    if (shape.operation !== 'subtract' || !shape.profile.closed) return false
    if (shape.max < top - Z_EPSILON || shape.min > bottom + Z_EPSILON) return false
    if (!edgeRouted.has(shape.featureId)) edgeRouted.set(shape.featureId, onlyEdgeRouted(project, shape.featureId))
    return edgeRouted.get(shape.featureId)!
  }

  const pathsOf = new Map<PartShape, ClipperPath[]>()
  for (const shape of shapes) {
    const ring = flattenProfileWithin(shape.profile, tolerance)
    pathsOf.set(shape, shape.profile.closed ? (ring.length >= 3 ? [ringToPath(ring)] : []) : polylineSliver(ring))
  }
  let material: ClipperPath[] = []
  for (const shape of shapes) {
    if (shape.operation === 'add' && shape.profile.closed) material = unionPaths([...material, ...pathsOf.get(shape)!])
    else if (opens(shape)) material = differencePaths(material, pathsOf.get(shape)!)
  }
  const components = regionComponents(differencePaths(outerContours(material), material))

  return components.filter((component) => {
    const area = component.reduce((sum, path) => sum + ClipperLib.Clipper.Area(path), 0)
    // A two-unit sliver along the boundary absorbs Clipper's rounding.
    const slack = 2 * component.reduce((sum, path) => sum + perimeter(pathToRing(path)) * NEST_SCALE, 0)
    return shapes.every((shape) => {
      const overlap = intersectionArea(pathsOf.get(shape)!, component)
      // A path is thinner than the slack, so any touch at all counts.
      if (!shape.profile.closed) return overlap <= 0
      if (overlap <= slack) return true
      const bounding = shape.profile.closed && (shape.operation === 'add' || opens(shape))
      return bounding && overlap >= area - slack
    })
  }).flatMap((component) => component.map(pathToRing))
}

/**
 * Clearance the tool needs between two parts (#741 decision 6): the largest
 * cutter diameter plus radial stock-to-leave on both sides, over the outside
 * edge routes that cut the part. Null when nothing cuts its outline.
 */
export function nestGapForPart(project: Project, featureIds: string[]): number | null {
  const cutters = outlineCutters(project, featureIds)
  if (cutters.length === 0) return null
  return Math.max(...cutters.map((cutter) => cutter.diameter + 2 * cutter.leave))
}

/**
 * How far the cut reaches outside the part's outline — the largest tool
 * diameter plus radial stock-to-leave over the operations that route it
 * outside (#881) — or null when nothing does. A margin is kept on top of it.
 */
export function nestEdgeClearance(project: Project, featureIds: string[]): number | null {
  const cutters = outlineCutters(project, featureIds)
  if (cutters.length === 0) return null
  return Math.max(...cutters.map((cutter) => cutter.diameter + cutter.leave))
}

/** The tool and radial leave of every outside edge route that cuts one of `featureIds`. */
function outlineCutters(project: Project, featureIds: string[]): { diameter: number; leave: number }[] {
  const ids = new Set(featureIds)
  return project.operations.flatMap((operation) => {
    if (operation.kind !== 'edge_route_outside' || operation.target.source !== 'features') return []
    if (!operation.target.featureIds.some((id) => ids.has(id))) return []
    const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
    if (!tool) return []
    return [{ diameter: normalizeToolForProject(tool, project).diameter, leave: Math.max(0, operation.stockToLeaveRadial) }]
  })
}

function offsetRings(rings: NestRing[], delta: number): NestRing[] {
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(rings.map(ringToPath), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution: ClipperPath[] = new ClipperLib.Paths()
  offset.Execute(solution, delta * NEST_SCALE)
  return solution.map(pathToRing)
}

/**
 * Everything the part must keep clear of: clamps grown by the clamp XY
 * clearance, and every other closed machinable feature on the stock —
 * including the part itself when its originals stay in place. A feature that
 * contains the part (a sheet outline drawn as a feature) is not an obstacle.
 *
 * A clamp also gets the corner pad of {@link clampCornerPad}, so that a part
 * kept `minimumGap` from it clears the toolpaths' square clamp keep-out.
 */
export function nestObstacleRings(
  project: Project,
  partIds: string[],
  footprint: NestRing[],
  keepOriginals: boolean,
  minimumGap: number,
): NestRing[] {
  const tolerance = nestFlattenTolerance(project)
  const part = new Set(partIds)
  const partPaths = footprint.map(ringToPath)
  const clearance = project.meta.clampClearanceXY + clampCornerPad(minimumGap)
  const clamps = project.clamps.map((clamp) => [
    { x: clamp.x - clearance, y: clamp.y - clearance },
    { x: clamp.x + clamp.w + clearance, y: clamp.y - clearance },
    { x: clamp.x + clamp.w + clearance, y: clamp.y + clamp.h + clearance },
    { x: clamp.x - clearance, y: clamp.y + clamp.h + clearance },
  ])
  const features = resolvedProjectFeatures(project).flatMap((feature) => {
    if (!isMachinable(feature) || (part.has(feature.id) && !keepOriginals)) return []
    const paths = closedPaths(feature, tolerance)
    const slack = footprint.reduce((sum, ring) => sum + flatteningSlack(ring, tolerance), 0)
    if (!part.has(feature.id) && paths.length > 0 && pathsArea(differencePaths(partPaths, paths)) <= slack) return []
    return paths.map(pathToRing)
  })
  return [...clamps, ...features]
}

/**
 * Extra growth for a clamp's rectangle before nesting (#882). Toolpaths keep
 * the cutter out of the clamp grown with mitered joins — a rectangle whose
 * corners are square — while the nest keeps parts a round distance away. Off
 * a corner the square reaches √2 times as far, so the rectangle is grown by
 * `a` with `√2 (r − a) + r + leave ≤ gap` for every cutter radius `r` and
 * radial leave the gap allows (`2r + leave ≤ gap`): `a = (gap / 2)(1 − 1/√2)`,
 * plus the keep-out's own epsilon.
 */
export function clampCornerPad(minimumGap: number): number {
  return (Math.max(0, minimumGap) / 2) * (1 - Math.SQRT1_2) + CLAMP_KEEPOUT_EPSILON
}

/**
 * The stock outline, shrunk by the flattening tolerance. With `margins` (#881)
 * it is also cut to the stock's bounding box inset on each side by that side's
 * margin plus `edgeClearance`, the cut's reach outside a part; a side with no
 * margin is not inset. Exact for rectangular stock, and on any other outline
 * it only takes more room away.
 */
export function nestSheetRing(project: Project, margins?: NestMargins, edgeClearance = 0): NestRing | null {
  const tolerance = nestFlattenTolerance(project)
  let stock = flattenProfileWithin(project.stock.profile, tolerance)
  if (margins && Object.values(margins).some((margin) => margin > 0)) {
    const inset = (margin: number) => (margin > 0 ? margin + Math.max(0, edgeClearance) : 0)
    const box = pathsBox([ringToPath(stock)])
    const allowed = rectPath({
      minX: box.minX + Math.round(inset(margins.left) * NEST_SCALE),
      minY: box.minY + Math.round(inset(margins.bottom) * NEST_SCALE),
      maxX: box.maxX - Math.round(inset(margins.right) * NEST_SCALE),
      maxY: box.maxY - Math.round(inset(margins.top) * NEST_SCALE),
    })
    if (allowed[0].X >= allowed[2].X || allowed[0].Y >= allowed[2].Y) return null
    const outside = differencePaths([rectPath({ minX: box.minX - 1, minY: box.minY - 1, maxX: box.maxX + 1, maxY: box.maxY + 1 })], [allowed])
    const pieces = differencePaths([ringToPath(stock)], outside)
    if (pieces.length === 0) return null
    stock = pathToRing(pieces.reduce((best, path) => (Math.abs(ClipperLib.Clipper.Area(path)) > Math.abs(ClipperLib.Clipper.Area(best)) ? path : best)))
  }
  const shrunk = offsetRings([stock], -tolerance)
  if (shrunk.length === 0) return null
  return shrunk.reduce((best, ring) => (
    Math.abs(ClipperLib.Clipper.Area(ringToPath(ring))) > Math.abs(ClipperLib.Clipper.Area(ringToPath(best))) ? ring : best
  ))
}

/** Simplification tolerance for grown footprints, in project units (#855). */
export function nestSimplifyTolerance(project: Pick<Project, 'meta'>): number {
  return project.meta.units === 'inch' ? 0.002 : 0.05
}

/**
 * A serializable packer job (see `requestFromJob`). Part `i` of the job is
 * `parts[i]`, with `quantities[i]` counted the way the panel shows them:
 * parts on the sheet, originals included.
 */
export function buildNestJob(
  project: Project,
  parts: Pick<NestPartSpec, 'featureIds' | 'footprint' | 'holes'>[],
  quantities: number[],
  settings: NestSettings,
): NestJob | null {
  const featureIds = parts.flatMap((part) => part.featureIds)
  const sheet = nestSheetRing(project, settings.margins, nestEdgeClearance(project, featureIds) ?? 0)
  if (!sheet || parts.length === 0) return null
  return {
    sheet,
    obstacles: nestObstacleRings(
      project,
      featureIds,
      parts.flatMap((part) => part.footprint),
      settings.keepOriginals,
      settings.minimumGap,
    ),
    parts: parts.map((part, index) => ({
      id: String(index),
      footprint: part.footprint,
      holes: part.holes,
      quantity: Math.max(0, (quantities[index] ?? 0) - (settings.keepOriginals ? 1 : 0)),
      rotations: settings.rotations,
    })),
    minimumGap: settings.minimumGap,
    growthPadding: nestFlattenTolerance(project),
    simplifyTolerance: nestSimplifyTolerance(project),
    gravity: nestGravity(project),
  }
}

/** A ready-to-run packer request (see `buildNestJob`). */
export function buildNestRequest(
  project: Project,
  parts: Pick<NestPartSpec, 'featureIds' | 'footprint' | 'holes'>[],
  quantities: number[],
  settings: NestSettings,
): NestRequest | null {
  const job = buildNestJob(project, parts, quantities, settings)
  return job ? requestFromJob(job) : null
}

/** The nest a selection belongs to — through a source or a copy — if any. */
export function findNestForSelection(project: Project, selectedIds: string[]): NestRecord | null {
  const selected = new Set(selectedIds)
  return project.nests?.find((nest) => (
    nest.parts.some((part) => part.sourceIds.some((id) => selected.has(id))) || nest.copyIds.some((id) => selected.has(id))
  )) ?? null
}

/** Pack toward the stock corner nearest the machine origin. */
export function nestGravity(project: Project): NestGravity {
  const bounds = getStockBounds(project.stock)
  return {
    x: project.origin.x <= (bounds.minX + bounds.maxX) / 2 ? 1 : -1,
    y: project.origin.y <= (bounds.minY + bounds.maxY) / 2 ? 1 : -1,
  }
}

/** The world-space transform a placement applies: rotate about the origin, then translate. */
export function nestPlacementMatrix(placement: NestPlacement): Matrix2D {
  const quarter = placement.rotation / 90
  const exact = Math.abs(quarter - Math.round(quarter)) < 1e-12
  const turns = ((Math.round(quarter) % 4) + 4) % 4
  const radians = (placement.rotation * Math.PI) / 180
  const cos = exact ? [1, 0, -1, 0][turns] : Math.cos(radians)
  const sin = exact ? [0, 1, 0, -1][turns] : Math.sin(radians)
  return { a: cos, b: sin, c: -sin, d: cos, e: placement.translation.x, f: placement.translation.y }
}
