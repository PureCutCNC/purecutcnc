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
 * The Around frame (issue #395): a round bar unrolled for top-down generators.
 * `thickness` is diameter D, radius R = D/2. Along is the bar's project axis;
 * across is Y for an X bar and X for a Y bar. X and Y are never swapped.
 * The zero line (a = 0, the top of the bar) is the bar's centreline across
 * coordinate, `zero` (issue #1026). The sheet keeps the along extent and runs
 * across from `sheetStart = zero − C/2` to `zero + C/2`, C = π·D, so the zero
 * line runs through its middle and its two edges are the seam (the bottom of
 * the bar, a = ±180°). Geometry outside it keeps turning.
 * Around features store Top-like heights: surface z = D, centreline z = R.
 * Flat heights are lowered by R: the sheet's top is R, its bottom is zero.
 * a = 360·(across − zero)/C, never reduced to one turn. Per rotaryFrame,
 * a flat height r cuts stock across = centre + r·sin a, z = R + r·cos a;
 * toolSpacePoint of that stock point at a is the wrapped tool point.
 *
 * A square blank (#1016 C2-S3) unrolls in the same frame with the *nominal
 * reference cylinder*: radius = side / 2 (the inscribed radius) and
 * circumference = π · side. That cylinder is a coordinate mapping only — the
 * angle a square sheet column stands for, and the height a flat point is
 * lowered by — never a claim that the blank's surface is round. The real
 * surfaces (flats and corners) are the sampler's and the runout guard's
 * business, not the sheet's; `barSurfaceRadius` is ray geometry and is
 * deliberately not used here. On a round bar this is exactly the old frame.
 *
 * A chuck or tailstock is a band across the *whole* bar, so it covers every
 * turn the job can reach: `unrolledProject` spreads it from one circumference
 * below the lowest across coordinate on the sheet to one above the highest.
 */

import { getStockBounds, isAroundSetup, rectProfile } from '../types/project'
import type { BarStock, Operation, Project } from '../types/project'
import { barCentre, barInscribedRadius, isBarStock } from '../types/barStock'
import { getFeatureGeometryBounds } from '../text'
import { TURN_CANNED_KIND } from '../cannedShapes/generators/kinds'
import { resolveFeatureInstance } from '../store/helpers/resolveFeatures'
import { rotaryTurnSurfaceSections } from '../store/helpers/rotarySurface'
import { setupForOperation } from './setupOrientation'
import { resolveDimensionRef } from './toolpaths/geometry'
import type { ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './toolpaths/types'

export interface AroundFrame {
  readonly axis: 'x' | 'y'
  /** The centreline's across coordinate (barCentre); the same as `zero`. */
  readonly centre: number
  readonly radius: number
  /**
   * Across coordinate of the zero line — the top of the bar at a = 0
   * (issue #1026). It is the bar's centreline, `centre`, and every angle is
   * taken from it: `a = 360·(across − zero)/C`.
   */
  readonly zero: number
  /**
   * Across coordinate of the sheet's first edge: `zero − C/2`, one
   * circumference below the zero line. The far edge is `sheetStart + C`; the
   * two edges are the seam (the bottom of the bar, a = ±180°).
   */
  readonly sheetStart: number
  readonly circumference: number
}

export function aroundFrame(stock: BarStock): AroundFrame {
  const circumference = Math.PI * stock.thickness
  const zero = barCentre(stock)
  return {
    axis: stock.axis,
    centre: zero,
    radius: barInscribedRadius(stock),
    zero,
    sheetStart: zero - circumference / 2,
    circumference,
  }
}

/**
 * Around requires a bar (round or square) and the same axis: never guess a
 * frame. A block is still refused. A square blank maps through its nominal
 * reference cylinder (see the header); whether an Around operation may be
 * *authored* on one is the active-face/authoring guard's decision, not this
 * module's.
 */
export function aroundFrameForOperation(
  project: Pick<Project, 'setups' | 'stock'>,
  operation: Pick<Operation, 'id' | 'setupId'>,
): AroundFrame | undefined {
  const setup = setupForOperation(project, operation)
  if (!setup || !isAroundSetup(setup)) return undefined
  if (!isBarStock(project.stock)) throw new Error('An Around setup requires a bar (round or square).')
  if (setup.orientation.axis !== project.stock.axis) throw new Error('The Around setup axis must match the bar axis.')
  return aroundFrame(project.stock)
}

/**
 * The project as a flat face reads it (issue #395): a feature authored on the
 * Around face stores the unrolled sheet's coordinates, which mean nothing on
 * the bar's own rectangle — a Top or Bottom cut that numerically overlaps one
 * must never fold it into its own region, and a flat setup's simulation must
 * not draw it.
 *
 * Returns the input project **itself** when it holds no Around feature, so a
 * project without Around content takes exactly the path it always did.
 */
export function flatFaceProject(project: Project): Project {
  const features = project.features.filter((feature) => feature.authoringFace !== 'around')
  return features.length === project.features.length ? project : { ...project, features }
}

/** Flat point → tool point on the bar. Always carries `a`. */
export function wrapPoint(flat: { x: number; y: number; z: number }, frame: AroundFrame): ToolpathPoint {
  const across = frame.axis === 'x' ? flat.y : flat.x
  const a = 360 * (across - frame.zero) / frame.circumference
  return frame.axis === 'x'
    ? { x: flat.x, y: frame.centre, z: flat.z + frame.radius, a }
    : { x: frame.centre, y: flat.y, z: flat.z + frame.radius, a }
}

/**
 * Exact inverse of wrapPoint; an unwrapped point has no `a` key. The angle is
 * taken from the frame's zero line, so a point on the sheet comes back in the
 * same one-circumference window the sheet is framed in (`zero − C/2` to
 * `zero + C/2`) and an angle past a full turn keeps turning, never reduced
 * (issue #395).
 */
export function unwrapPoint(point: ToolpathPoint, frame: AroundFrame): { x: number; y: number; z: number } {
  if (point.a === undefined) throw new Error('Unwrapping an Around point requires a rotary angle.')
  const across = frame.zero + point.a * frame.circumference / 360
  return frame.axis === 'x'
    ? { x: point.x, y: across, z: point.z - frame.radius }
    : { x: across, y: point.y, z: point.z - frame.radius }
}

/**
 * The across extent a fixture band must cover: one circumference below the
 * lowest across coordinate of anything on the sheet and one above the highest
 * — the sheet itself and every Around feature's transformed bounds. A cutter
 * clearance or lead move past a feature is therefore inside the band too.
 */
function bandAcrossExtent(project: Project, frame: AroundFrame): { min: number; max: number } {
  let min = frame.sheetStart
  let max = frame.sheetStart + frame.circumference
  for (const feature of project.features) {
    if (feature.authoringFace !== 'around') continue
    const resolved = resolveFeatureInstance(project, feature.id)
    if (!resolved) continue
    const bounds = getFeatureGeometryBounds(resolved)
    const acrossMin = frame.axis === 'x' ? bounds.minY : bounds.minX
    const acrossMax = frame.axis === 'x' ? bounds.maxY : bounds.maxX
    if (Number.isFinite(acrossMin)) min = Math.min(min, acrossMin)
    if (Number.isFinite(acrossMax)) max = Math.max(max, acrossMax)
  }
  return { min: min - frame.circumference, max: max + frame.circumference }
}

/** The project as a flat block for the generators. Transient; never stored. */
export function unrolledProject(project: Project, frame: AroundFrame): Project {
  const bounds = getStockBounds(project.stock)
  const band = bandAcrossExtent(project, frame)
  const { shape: _shape, sourceFeature: _source, ...stock } = project.stock
  void _shape
  void _source
  // A block carries neither the bar axis nor a source feature.
  const { axis: _axis, ...plainStock } = stock as typeof stock & { axis?: 'x' | 'y' }
  void _axis
  return {
    ...project,
    meta: { ...project.meta, maxTravelZ: Math.max(0, project.meta.maxTravelZ - frame.radius) },
    stock: {
      ...plainStock,
      profile: frame.axis === 'x'
        ? rectProfile(bounds.minX, frame.sheetStart, bounds.maxX - bounds.minX, frame.circumference)
        : rectProfile(frame.sheetStart, bounds.minY, frame.circumference, bounds.maxY - bounds.minY),
      thickness: frame.radius,
    },
    features: project.features.filter((feature) => feature.authoringFace === 'around').map((feature) => ({
      ...feature,
      z_top: resolveDimensionRef(project, feature.z_top) - frame.radius,
      z_bottom: resolveDimensionRef(project, feature.z_bottom) - frame.radius,
    })),
    tabs: [],
    clamps: project.clamps.filter((clamp) => clamp.type === 'chuck' || clamp.type === 'tailstock').map((clamp) => ({
      ...clamp,
      ...(frame.axis === 'x'
        ? { y: band.min, h: band.max - band.min }
        : { x: band.min, w: band.max - band.min }),
      // Clamp.height is its absolute top Z, measured from the stock's bottom.
      height: clamp.height - frame.radius,
    })),
    origin: { ...project.origin, z: project.origin.z - frame.radius },
    setups: project.setups.map((setup) => {
      if (!isAroundSetup(setup)) return setup
      const { kind: _kind, ...plain } = setup
      void _kind
      return plain
    }),
  }
}

/**
 * What a band of material on the Around sheet is, for the Follow line keep-out
 * (issue #1112 slice rt6-e).
 *
 * - `bar` — the stock where no model has been cut into it. It is the surface a
 *   follow line may itself be cut on, so it is a wall only where it stands
 *   **above** the guide's surface: the uncut shoulder beside a smaller Turn.
 * - `turn` — a Turn is the surface a Thread/Flutes over it is cut *on*, so a
 *   Turn is a wall only where its surface is **above** the guide's: a Turn of
 *   larger diameter. At the same diameter it is the same cylinder, and the
 *   guide's groove simply ends on it.
 * - `body` — a Polygon/Hex or a placed model: a distinct body with an end face.
 *   It counts at **or above** the guide's surface, because a body whose top is
 *   level with the guide is still a wall the cutter's flank enters. Frank's bolt
 *   is exactly that case: the Hex's Z top and the Thread's surface are both
 *   measured from the same Ø0.75, and at 0.122 deep a 30° V-bit is 0.0327 half-
 *   width at that height — the 0.033 in the report.
 */
export type AroundMaterialKind = 'bar' | 'turn' | 'body'

/** One body of material on the sheet, as an interval along the bar. */
export interface AroundMaterialBand {
  /** The feature's name; `''` for the bar itself. */
  name: string
  kind: AroundMaterialKind
  /** Absolute stock interval along the bar, in the bar's own coordinates. */
  alongMin: number
  alongMax: number
  /** Material surface height in the unrolled sheet's Top-like frame. */
  surfaceZ: number
}

export interface AroundMaterialBands {
  /** The stock's axis; `along` names the project coordinate in each band. */
  axis: 'x' | 'y'
  bands: AroundMaterialBand[]
}

/** Slack for a model's along extent: a degenerate band is not a body. */
const MATERIAL_EXTENT_TOLERANCE = 1e-9

/**
 * The material standing on the Around sheet, one band per body, for a Follow
 * line's keep-out (issue #1112 slice rt6-e). Read from the project's own
 * models and stock — their instance Z top is the surface height in the bar's
 * Top-like frame — rather than from a new geometry model.
 *
 * A model band **replaces** the bar over its span: the rotary work cuts the bar
 * down to the model, which is why a Thread beside a Hex measures against the
 * Hex's surface, not the raw bar it was cut from. The bar therefore contributes
 * only the stretches no model covers, which is what "uncut bar next to a Turn"
 * means. Every surface is lowered by the frame radius, so it is in the same
 * frame as the unrolled project's feature Z tops (the one the generator reads).
 *
 * A Turn with a copied profile is split into its along sections, each carrying
 * its own local surface (#1112 rt6-e correction 1). Its single Z top is the
 * largest section's, so a guide on a smaller section would otherwise be called
 * a wall against its own supporting Turn.
 */
export function aroundMaterialBands(project: Project, frame: AroundFrame): AroundMaterialBands {
  const bounds = getStockBounds(project.stock)
  const alongMin = frame.axis === 'x' ? bounds.minX : bounds.minY
  const alongMax = frame.axis === 'x' ? bounds.maxX : bounds.maxY
  const bodies: AroundMaterialBand[] = []
  const covered: Array<{ min: number; max: number }> = []
  const turnSections = rotaryTurnSurfaceSections(project)

  for (const feature of project.features) {
    const definition = project.featureDefinitions[feature.definitionId]
    // A model is the part the rotary work leaves standing; every other feature
    // is geometry the guide is drawn from, not material to keep it out of.
    if (definition?.kind !== 'stl' || definition.operation !== 'model') continue
    const resolved = resolveFeatureInstance(project, feature.id)
    if (!resolved) continue
    const extent = getFeatureGeometryBounds(resolved)
    const min = frame.axis === 'x' ? extent.minX : extent.minY
    const max = frame.axis === 'x' ? extent.maxX : extent.maxY
    if (!Number.isFinite(min) || !Number.isFinite(max) || max - min <= MATERIAL_EXTENT_TOLERANCE) continue
    covered.push({ min, max })
    // A model placed off the bar's length is still a target, but it stands on
    // no material the sheet can reach, so it is not a band here.
    const clippedMin = Math.max(alongMin, min)
    const clippedMax = Math.min(alongMax, max)
    if (clippedMax - clippedMin <= MATERIAL_EXTENT_TOLERANCE) continue
    const kind: AroundMaterialKind = definition.canned?.kind === TURN_CANNED_KIND ? 'turn' : 'body'
    const sections = kind === 'turn' ? turnSections.get(feature.id) : undefined
    if (sections && sections.length > 0) {
      for (const section of sections) {
        const sectionMin = Math.max(clippedMin, section.alongMin)
        const sectionMax = Math.min(clippedMax, section.alongMax)
        if (sectionMax - sectionMin <= MATERIAL_EXTENT_TOLERANCE) continue
        bodies.push({
          name: feature.name,
          kind,
          alongMin: sectionMin,
          alongMax: sectionMax,
          surfaceZ: section.radius,
        })
      }
      continue
    }
    bodies.push({
      name: feature.name,
      kind,
      alongMin: clippedMin,
      alongMax: clippedMax,
      surfaceZ: resolveDimensionRef(project, feature.z_top) - frame.radius,
    })
  }

  const bands: AroundMaterialBand[] = subtractSpans(alongMin, alongMax, covered).map((piece) => ({
    name: '',
    kind: 'bar' as const,
    alongMin: piece.min,
    alongMax: piece.max,
    // The bar surface is the stock thickness in the Top-like frame, i.e. one
    // radius above the turning axis on the unrolled sheet.
    surfaceZ: project.stock.thickness - frame.radius,
  }))
  return { axis: frame.axis, bands: [...bands, ...bodies] }
}

/** `[min, max]` minus every covered interval, in ascending order. */
function subtractSpans(
  min: number,
  max: number,
  covered: ReadonlyArray<{ min: number; max: number }>,
): Array<{ min: number; max: number }> {
  const pieces: Array<{ min: number; max: number }> = []
  let cursor = min
  for (const span of [...covered].sort((left, right) => left.min - right.min)) {
    if (span.max <= cursor) continue
    if (span.min > cursor) pieces.push({ min: cursor, max: Math.min(span.min, max) })
    cursor = Math.max(cursor, span.max)
    if (cursor >= max) break
  }
  if (cursor < max) pieces.push({ min: cursor, max })
  return pieces.filter((piece) => piece.max - piece.min > MATERIAL_EXTENT_TOLERANCE)
}

function boundsOf(moves: readonly ToolpathMove[]): ToolpathBounds | null {
  if (moves.length === 0) return null
  const bounds: ToolpathBounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  }
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      bounds.minX = Math.min(bounds.minX, point.x)
      bounds.minY = Math.min(bounds.minY, point.y)
      bounds.minZ = Math.min(bounds.minZ, point.z)
      bounds.maxX = Math.max(bounds.maxX, point.x)
      bounds.maxY = Math.max(bounds.maxY, point.y)
      bounds.maxZ = Math.max(bounds.maxZ, point.z)
    }
  }
  return bounds
}

function shiftLevels<T extends ToolpathResult>(result: T, offset: number): void {
  const levels = (result as { stepLevels?: number[] }).stepLevels
  if (levels) (result as { stepLevels?: number[] }).stepLevels = levels.map((z) => z + offset)
}

/** A flat toolpath carried onto the bar; ramping turns are split in flat space. */
export function wrapToolpath<T extends ToolpathResult>(result: T, frame: AroundFrame): T {
  const moves: ToolpathMove[] = []
  const collisions = new Set(result.collidingMoveIndices)
  const collidingMoveIndices: number[] = []
  result.moves.forEach((move, index) => {
    const acrossFrom = frame.axis === 'x' ? move.from.y : move.from.x
    const acrossTo = frame.axis === 'x' ? move.to.y : move.to.x
    const dz = move.to.z - move.from.z
    const n = acrossFrom !== acrossTo && dz !== 0
      ? Math.min(64, Math.ceil(Math.abs(dz) / (0.1 * Math.max(Math.min(move.from.z, move.to.z), 1e-9))))
      : 1
    const at = (i: number): ToolpathPoint => i === 0 ? move.from : i === n ? move.to : {
      x: move.from.x + (move.to.x - move.from.x) * i / n,
      y: move.from.y + (move.to.y - move.from.y) * i / n,
      z: move.from.z + dz * i / n,
    }
    for (let i = 0; i < n; i++) {
      if (collisions.has(index)) collidingMoveIndices.push(moves.length)
      moves.push({ ...move, from: wrapPoint(at(i), frame), to: wrapPoint(at(i + 1), frame) })
    }
  })
  const wrapped: T = { ...result, moves, bounds: boundsOf(moves) }
  if (result.collidingMoveIndices) wrapped.collidingMoveIndices = collidingMoveIndices
  delete wrapped.drillCycles
  shiftLevels(wrapped, frame.radius)
  return wrapped
}

/** A wrapped toolpath back on the sheet; pieces stay split. */
export function unwrapToolpath<T extends ToolpathResult>(result: T, frame: AroundFrame): T {
  const moves = result.moves.map((move) => ({ ...move, from: unwrapPoint(move.from, frame), to: unwrapPoint(move.to, frame) }))
  const unwrapped: T = { ...result, moves, bounds: boundsOf(moves) }
  shiftLevels(unwrapped, -frame.radius)
  return unwrapped
}
