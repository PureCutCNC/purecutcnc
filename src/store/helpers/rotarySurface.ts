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
 * Which surface Thread/Flutes measure their depth from (issue #1112 slice H,
 * decision 10).
 *
 * A Thread or Flutes band lying wholly on **one Turn** takes that Turn's
 * diameter: the radial depth starts at the turned surface instead of the bar
 * surface, and the dialog shows it read-only. A band over the plain bar uses
 * the bar, exactly as before. An **imported model** never supplies a diameter
 * (a mesh is not known to be round), so the depth falls back to the bar surface
 * and the row says so. A band whose diameter changes — crossing a Turn's end,
 * crossing two Turns, a step inside one Turn — or a taper is not guessed: it is
 * warned about and measured from the bar. The warning says which change it is:
 * an **end** crossing vs a diameter change **inside** the Turn (#1112 rt3-c
 * correction 1), because a groove in the middle of a Turn does not cross
 * anything's end.
 *
 * Both halves of the question are read through the **placement transform**:
 * a band is where the user put the Thread, not where its stored parameters were
 * typed, and a Turn's along span, radial size and coaxiality are those of the
 * placed body. A Turn moved off the bar centreline, raised out of the bar's Z
 * plane or rotated no longer presents one diameter about the bar axis, so it is
 * warned about and measured from the bar rather than keeping a stale constant
 * diameter.
 *
 * The resolver is shared by the dialog, the tree and the Properties line, so
 * the number shown and the cut generated cannot disagree. Nothing is stored on
 * the Thread: its instance Z span is the persisted result, and an edit of the
 * Turn moves it by re-running this resolver (`syncRotaryPatternSurfaces`).
 *
 * **The derived span is the only span** (#1112 rt6-c): a stored span that does
 * not match the surface is rewritten, on a write and on load, because a span
 * that used to count as an "explicit override" made a Thread silently stop
 * following its Turn. An unchanged span stays byte-identical, so a write that
 * does not move a surface keeps the rows it had.
 */

import { getProfileBounds, type DimensionRef, type Point, type Project, type Stock } from '../../types/project'
import type { MessageKey } from '../../i18n/locales/en'
import type { RotaryPatternFrame } from '../../engine/rotaryPatterns'
import { buildRotaryPatternLines, rotaryPatternFrame } from '../../engine/rotaryPatterns'
import { TURN_CANNED_KIND } from '../../cannedShapes/generators/kinds'
import { FLUTES_CANNED_KIND, THREAD_CANNED_KIND } from '../../cannedShapes/generators/kinds'
import { normalizeTurnCannedParams } from '../../cannedShapes/generators/turn'
import {
  turnProfileMaxRadius,
  turnProfileRadiusRange,
  type TurnCannedProfile,
} from '../../cannedShapes/generators/turnProfile'
import { rotarySolidAlong } from '../../cannedShapes/generators/rotarySolidParams'
import {
  applyMatrixToPoint,
  resolveFeatureInstance,
} from './resolveFeatures'
import { invertMatrix } from './instanceTransforms'
import {
  normalizeThreadCannedParams,
  type ThreadCannedParams,
} from '../../cannedShapes/generators/thread'
import { normalizeFlutesCannedParams, type FlutesCannedParams } from '../../cannedShapes/generators/flutes'

/** Numeric slack for the band and diameter comparisons. */
const TOLERANCE = 1e-6

/**
 * `twoDiameters` is a band crossing a Turn's **end** (or two Turns meeting);
 * `step` is a diameter change **inside** one Turn — a groove/step in its
 * copied profile, or a placed Turn that no longer presents one diameter.
 * `taper` is a varying surface. All three warn and measure from the bar.
 */
export type RotaryPatternSurfaceKind = 'bar' | 'turn' | 'model' | 'twoDiameters' | 'step' | 'taper'

export interface RotaryPatternSurface {
  kind: RotaryPatternSurfaceKind
  /** The diameter the depth is measured from: the bar's for every non-Turn kind. */
  diameter: number
  /** The one Turn the band lies wholly on (`kind === 'turn'`). */
  turnFeatureId?: string
  turnName?: string
  /**
   * The Turn rows a warned band crosses, in row order (`twoDiameters`,
   * `step`, `taper`), so the warning can name the Turn whose diameter changes
   * instead of saying only "more than one diameter" (#1112 rt3-c item 30).
   */
  turnNames?: string[]
  /** The model rows the band crosses (`kind === 'model'`). */
  modelNames?: string[]
}

/** The numbers a surface is resolved from: the pattern's band, from the chuck end. */
export interface RotaryPatternBand {
  start: number
  length: number
}

/** A band already placed on the bar: absolute stock-space along positions. */
interface WorldBand {
  min: number
  max: number
}

function bandAlong(frame: RotaryPatternFrame, band: RotaryPatternBand): WorldBand | null {
  if (!Number.isFinite(band.start) || !Number.isFinite(band.length) || band.length <= 0) return null
  const first = frame.alongOrigin + frame.alongDirection * band.start
  const second = first + frame.alongDirection * band.length
  return { min: Math.min(first, second), max: Math.max(first, second) }
}

function overlap(first: WorldBand, second: WorldBand): WorldBand | null {
  const min = Math.max(first.min, second.min)
  const max = Math.min(first.max, second.max)
  return max - min > TOLERANCE ? { min, max } : null
}

/** Why a placed Turn no longer supplies one diameter about the bar axis. */
type TurnAmbiguity = 'offCentre' | 'tilted'

/** An instance Z bound as a number; a named dimension resolves on the project. */
function zValue(project: Pick<Project, 'dimensions'>, value: DimensionRef): number {
  return typeof value === 'number' ? value : project.dimensions[value]?.value ?? 0
}

interface TurnBand {
  id: string
  name: string
  /** World-space along range, after this instance's placement transform. */
  alongMin: number
  alongMax: number
  /** Constant radius of a plain-diameter Turn, after the placement scale. */
  diameterRadius: number
  /** The placement's radial scale, applied to a copied profile too. */
  radiusScale: number
  /**
   * Set when the placed body is not a surface of revolution about the bar:
   * its transformed axis left the bar axis (`tilted`) or its centreline left
   * the bar's centre (`offCentre`). Such a Turn has no one surface diameter.
   */
  ambiguity: TurnAmbiguity | null
  /** Farthest radial distance the placed footprint reaches from the centreline. */
  maxRadius: number
  /** Map a world along position back to the copied profile's stored along. */
  toProfileAlong: (worldAlong: number) => number
  /** A profile Turn's copied outlines; the band's range is read per overlap. */
  profile?: TurnCannedProfile
}

/** Point in the bar's project frame from an along/across pair on `axis`. */
function pointOn(axis: 'x' | 'y', along: number, across: number): Point {
  return axis === 'x' ? { x: along, y: across } : { x: across, y: along }
}

/**
 * One Turn instance's world band. A Turn is stored in the bar frame it was
 * drawn on, and the instance transform places that stored geometry, so both
 * the along span and the radial size are read through the transform. Linked
 * copies share the definition but not the placement, so each row is resolved
 * from its own matrix.
 *
 * The placed footprint is what decides the numbers, not the stored summary:
 * a profile's along extent is its copied outlines' extent, and a rotation that
 * tilts the body is visible in the footprint instead of being assumed away.
 */
function turnBands(project: Project, frame: RotaryPatternFrame): TurnBand[] {
  const bands: TurnBand[] = []
  const worldAxis = frame.axis
  const alongOf = (point: Point): number => (worldAxis === 'x' ? point.x : point.y)
  const acrossOf = (point: Point): number => (worldAxis === 'x' ? point.y : point.x)
  for (const feature of project.features) {
    const definition = project.featureDefinitions[feature.definitionId]
    if (definition?.canned?.kind !== TURN_CANNED_KIND) continue
    const params = normalizeTurnCannedParams(definition.canned.params)
    if (!params) continue
    const localAxis = params.frame.axis
    const acrossCentre = params.frame.acrossCentre
    const { alongStart, alongEnd } = rotarySolidAlong(params.frame, params.start, params.length)
    const transform = feature.transform
    const localPoint = (along: number, across: number): Point => pointOn(localAxis, along, across)
    const axisStart = applyMatrixToPoint(transform, localPoint(alongStart, acrossCentre))
    const axisEnd = applyMatrixToPoint(transform, localPoint(alongEnd, acrossCentre))
    const axisX = axisEnd.x - axisStart.x
    const axisY = axisEnd.y - axisStart.y
    const axisLength = Math.hypot(axisX, axisY)
    // The bar's along unit vector; a placement that leaves it parallel (either
    // direction) keeps the Turn coaxial, anything else tilts the body.
    const alongUnitX = worldAxis === 'x' ? 1 : 0
    const alongUnitY = worldAxis === 'x' ? 0 : 1
    const parallel = axisLength > TOLERANCE
      && Math.abs(axisX * alongUnitY - axisY * alongUnitX) <= TOLERANCE * axisLength
    // Coaxiality is a 3D fact: the 2D placement puts the axis on the bar's
    // centreline, and the instance Z span puts it in the bar's Z plane. The
    // placed body's axis is the middle of that span, so a Turn lifted in Z
    // (Properties, a transform) is off-centre exactly like one moved across,
    // even though its stored diameter is unchanged.
    const placedAxisZ = (zValue(project, feature.z_top) + zValue(project, feature.z_bottom)) / 2
    const centred = Math.abs(acrossOf(axisStart) - frame.zero) <= TOLERANCE
      && Math.abs(acrossOf(axisEnd) - frame.zero) <= TOLERANCE
      && Math.abs(placedAxisZ - frame.radius) <= TOLERANCE
    const ambiguity: TurnAmbiguity | null = !parallel
      ? 'tilted'
      : !centred ? 'offCentre' : null
    // The radial scale is the transform's effect across the bar. A similarity
    // has the same factor along the bar, so scaling a Turn scales its diameter
    // and its band together, as the placed mesh does.
    const acrossUnit = localAxis === 'x' ? { x: 0, y: 1 } : { x: 1, y: 0 }
    const radiusScale = Math.hypot(
      transform.a * acrossUnit.x + transform.c * acrossUnit.y,
      transform.b * acrossUnit.x + transform.d * acrossUnit.y,
    )
    const localRadius = params.diameter / 2
    const profileMaxRadius = params.profile ? turnProfileMaxRadius(params.profile) : localRadius
    // The placed footprint's extreme points: the plain cylinder's rectangle, or
    // both sides of a copied profile. Transforming them gives the world along
    // span (a rotation moves the body even when its centre does not) and the
    // farthest radial reach used when the body is no longer coaxial.
    const footprint: Array<{ along: number; across: number }> = []
    if (params.profile) {
      for (const contour of params.profile.contours) {
        for (const point of contour.points) {
          footprint.push({ along: point.along, across: acrossCentre + point.radius })
          footprint.push({ along: point.along, across: acrossCentre - point.radius })
        }
      }
    } else {
      footprint.push(
        { along: alongStart, across: acrossCentre - localRadius },
        { along: alongEnd, across: acrossCentre - localRadius },
        { along: alongEnd, across: acrossCentre + localRadius },
        { along: alongStart, across: acrossCentre + localRadius },
      )
    }
    if (footprint.length === 0) {
      footprint.push(
        { along: alongStart, across: acrossCentre },
        { along: alongEnd, across: acrossCentre },
      )
    }
    let alongMin = Number.POSITIVE_INFINITY
    let alongMax = Number.NEGATIVE_INFINITY
    let maxRadius = 0
    for (const point of footprint) {
      const world = applyMatrixToPoint(transform, localPoint(point.along, point.across))
      const along = alongOf(world)
      alongMin = Math.min(alongMin, along)
      alongMax = Math.max(alongMax, along)
      maxRadius = Math.max(maxRadius, Math.abs(acrossOf(world) - frame.zero))
    }
    if (!Number.isFinite(alongMin) || !Number.isFinite(alongMax)) continue
    const inverse = invertMatrix(transform)
    bands.push({
      id: feature.id,
      name: feature.name,
      alongMin,
      alongMax,
      diameterRadius: localRadius * radiusScale,
      radiusScale,
      ambiguity,
      maxRadius: Math.max(maxRadius, profileMaxRadius * radiusScale),
      toProfileAlong: (worldAlong: number) => {
        const local = applyMatrixToPoint(inverse, pointOn(worldAxis, worldAlong, frame.zero))
        return localAxis === 'x' ? local.x : local.y
      },
      ...(params.profile ? { profile: params.profile } : {}),
    })
  }
  return bands
}

interface TurnOverlap extends TurnBand {
  overlapMin: number
  overlapMax: number
  radiusMin: number
  radiusMax: number
  step: boolean
}

function turnOverlaps(index: SurfaceIndex, range: WorldBand): TurnOverlap[] {
  const overlaps: TurnOverlap[] = []
  for (const turn of index.turns) {
    const overlapRange = overlap(range, { min: turn.alongMin, max: turn.alongMax })
    if (!overlapRange) continue
    if (turn.ambiguity !== null) {
      // The placed body is not one diameter about the bar axis: a moved Turn
      // spans a near and a far surface, a tilted one spans a range along the
      // band. Either way there is no single diameter to measure from, so the
      // caller warns and falls back to the bar instead of keeping a constant.
      overlaps.push({
        ...turn,
        overlapMin: overlapRange.min,
        overlapMax: overlapRange.max,
        radiusMin: 0,
        radiusMax: Math.max(turn.maxRadius, turn.diameterRadius, TOLERANCE * 10),
        step: turn.ambiguity === 'offCentre',
      })
      continue
    }
    // The surface over the *pattern's* band matters, not the whole Turn: a
    // pattern on the constant section of a stepped profile is on one diameter.
    // The profile is stored in the Turn's own along coordinates, so the world
    // overlap is mapped back through the placement before it is read.
    if (turn.profile) {
      const first = turn.toProfileAlong(overlapRange.min)
      const second = turn.toProfileAlong(overlapRange.max)
      const sampled = turnProfileRadiusRange(
        turn.profile,
        Math.min(first, second),
        Math.max(first, second),
      )
      if (!sampled) continue
      overlaps.push({
        ...turn,
        overlapMin: overlapRange.min,
        overlapMax: overlapRange.max,
        radiusMin: sampled.min * turn.radiusScale,
        radiusMax: sampled.max * turn.radiusScale,
        step: sampled.step,
      })
    } else {
      overlaps.push({
        ...turn,
        overlapMin: overlapRange.min,
        overlapMax: overlapRange.max,
        radiusMin: turn.diameterRadius,
        radiusMax: turn.diameterRadius,
        step: false,
      })
    }
  }
  return overlaps
}

interface ModelBand {
  name: string
  alongMin: number
  alongMax: number
}

function modelBands(project: Project, axis: 'x' | 'y'): ModelBand[] {
  const bands: ModelBand[] = []
  for (const feature of project.features) {
    const definition = project.featureDefinitions[feature.definitionId]
    if (!definition) continue
    // The Turn is a model too, and it supplies the diameter rather than
    // warning; every other model is a shape we do not read a radius from.
    if (definition.canned?.kind === TURN_CANNED_KIND) continue
    if (definition.kind !== 'stl' || definition.operation !== 'model') continue
    const resolved = resolveFeatureInstance(project, feature.id)
    if (!resolved) continue
    // Models are authored on Top regardless of the face they belong to, and
    // their placement frame is the silhouette box in the project plane.
    const bounds = getProfileBounds(resolved.sketch.profile)
    bands.push({
      name: feature.name,
      alongMin: axis === 'x' ? bounds.minX : bounds.minY,
      alongMax: axis === 'x' ? bounds.maxX : bounds.maxY,
    })
  }
  return bands
}

/**
 * The rotary facts one sync (or one warning pass) needs, built **once**:
 * every Turn is scanned and normalized a single time instead of once per
 * Thread/Flutes row. On a 1000 Threads + 1000 Turns project that is the
 * difference between a per-write quadratic scan and two linear passes.
 */
interface SurfaceIndex {
  frame: RotaryPatternFrame
  turns: TurnBand[]
  models: ModelBand[]
}

function buildSurfaceIndex(project: Project): SurfaceIndex | null {
  const frame = rotaryPatternFrame(project)
  if (!frame) return null
  return {
    frame,
    turns: turnBands(project, frame),
    models: modelBands(project, frame.axis),
  }
}

/**
 * The surface a Thread/Flutes depth is measured from. `bar` means the plain
 * bar (as before this decision); `turn` names the one Turn; `model`,
 * `twoDiameters`, `step` and `taper` are the warned cases and all measure from
 * the bar. Every warned case that crosses a Turn carries its row name(s) so the
 * warning can say which Turn's diameter changes.
 */
export function rotaryPatternSurface(
  project: Project,
  band: RotaryPatternBand,
): RotaryPatternSurface {
  const index = buildSurfaceIndex(project)
  if (!index) return { kind: 'bar', diameter: project.stock.thickness }
  const range = bandAlong(index.frame, band)
  if (!range) return { kind: 'bar', diameter: project.stock.thickness }
  return surfaceAtRange(project, index, range)
}

function surfaceAtRange(project: Project, index: SurfaceIndex, range: WorldBand): RotaryPatternSurface {
  const barDiameter = project.stock.thickness
  const models = index.models
    .map((model) => ({ ...model, overlap: overlap(range, { min: model.alongMin, max: model.alongMax }) }))
    .filter((model) => model.overlap !== null)
  if (models.length > 0) {
    return {
      kind: 'model',
      diameter: barDiameter,
      modelNames: models.map((model) => model.name),
    }
  }

  const turns = turnOverlaps(index, range)
  if (turns.length === 0) return { kind: 'bar', diameter: barDiameter }
  if (turns.length > 1) {
    return {
      kind: 'twoDiameters',
      diameter: barDiameter,
      turnNames: turns.map((crossed) => crossed.name),
    }
  }

  const turn = turns[0]
  if (!turn) return { kind: 'bar', diameter: barDiameter }
  const coversWhole = turn.alongMin <= range.min + TOLERANCE && turn.alongMax >= range.max - TOLERANCE
  const constant = turn.radiusMax - turn.radiusMin <= TOLERANCE
  if (!coversWhole) {
    // Part of the band is still plain bar. The same diameter on both is not a
    // guess; a different one is.
    const sameAsBar = constant && Math.abs(turn.radiusMax - barDiameter / 2) <= TOLERANCE
    return sameAsBar
      ? { kind: 'bar', diameter: barDiameter }
      : { kind: 'twoDiameters', diameter: barDiameter, turnNames: [turn.name] }
  }
  if (!constant) {
    // The band is wholly on this Turn, but the surface under it is not one
    // diameter. A step is a change *inside* the Turn (a groove, or a placed
    // body off the bar axis); calling that an end crossing is a false warning
    // (#1112 rt3-c correction 1). A taper is a varying surface instead.
    return {
      kind: turn.step ? 'step' : 'taper',
      diameter: barDiameter,
      turnNames: [turn.name],
    }
  }
  return {
    kind: 'turn',
    diameter: turn.radiusMax * 2,
    turnFeatureId: turn.id,
    turnName: turn.name,
  }
}

/** The instance Z span a Thread/Flutes depth gets on this surface. */
export function rotaryPatternSurfaceSpan(
  project: Project,
  band: RotaryPatternBand,
  depth: number,
): { surface: RotaryPatternSurface; zTop: number; zBottom: number } {
  const surface = rotaryPatternSurface(project, band)
  return spanForSurface(project, surface, depth)
}

/**
 * The instance Z span a depth gets on an **already resolved** surface. The
 * dialog uses this so an Apply measures from the same placed band the line and
 * the store sync show, rather than resolving the stored band a second time.
 */
export function rotaryPatternSurfaceSpanOn(
  project: Project,
  surface: RotaryPatternSurface,
  depth: number,
): { zTop: number; zBottom: number } {
  const span = spanForSurface(project, surface, depth)
  return { zTop: span.zTop, zBottom: span.zBottom }
}

function spanForSurface(
  project: Project,
  surface: RotaryPatternSurface,
  depth: number,
): { surface: RotaryPatternSurface; zTop: number; zBottom: number } {
  // Around features store Top-like heights: the bar surface is the stock
  // thickness, so a surface at radius r is at half the thickness plus r.
  const zTop = rotarySurfaceZ(project.stock, surface.diameter)
  return { surface, zTop, zBottom: zTop - depth }
}

/**
 * The Z a surface of `diameter` sits at: the bar's turning axis plus its
 * radius, in the frame Around features store (a height from the bottom of the
 * bar, so the axis is mid-thickness and the bar surface — diameter = thickness
 * — lands on the thickness).
 *
 * This is the one formula: the Thread/Flutes span goes through it, and the
 * Properties lines read it to say "surface at Z …", so the number the user sees
 * cannot be a second derivation of the same surface.
 */
export function rotarySurfaceZ(stock: Pick<Stock, 'thickness'>, diameter: number): number {
  return stock.thickness / 2 + diameter / 2
}

/** The warning a Thread/Flutes row and dialog show, or null on a plain bar/Turn. */
export interface RotaryPatternSurfaceWarning {
  key: MessageKey
  values?: Record<string, string | number>
}

export function rotaryPatternSurfaceWarning(
  surface: RotaryPatternSurface,
): RotaryPatternSurfaceWarning | null {
  switch (surface.kind) {
    case 'model':
      return {
        key: 'dialogs.rotary.surface.model',
        values: { model: surface.modelNames?.join(', ') ?? '' },
      }
    case 'twoDiameters':
      return {
        key: 'dialogs.rotary.surface.twoDiameters',
        values: { turn: surface.turnNames?.join(', ') ?? '' },
      }
    case 'step':
      return {
        key: 'dialogs.rotary.surface.step',
        values: { turn: surface.turnNames?.join(', ') ?? '' },
      }
    case 'taper':
      return { key: 'dialogs.rotary.surface.taper' }
    case 'bar':
    case 'turn':
      return null
  }
}

/** A Thread/Flutes row's stored parameters, with the kind that owns them. */
type PatternParams =
  | { kind: 'thread'; params: ThreadCannedParams }
  | { kind: 'flutes'; params: FlutesCannedParams }

function patternParams(
  definition: Project['featureDefinitions'][string] | undefined,
): PatternParams | null {
  if (!definition?.canned) return null
  if (definition.canned.kind === THREAD_CANNED_KIND) {
    const params = normalizeThreadCannedParams(definition.canned.params)
    return params ? { kind: 'thread', params } : null
  }
  if (definition.canned.kind === FLUTES_CANNED_KIND) {
    const params = normalizeFlutesCannedParams(definition.canned.params)
    return params ? { kind: 'flutes', params } : null
  }
  return null
}

/** True when the placement only translates (the common case, and the cheap one). */
function isTranslation(feature: Project['features'][number]): boolean {
  const { a, b, c, d } = feature.transform
  return Math.abs(a - 1) <= TOLERANCE
    && Math.abs(b) <= TOLERANCE
    && Math.abs(c) <= TOLERANCE
    && Math.abs(d - 1) <= TOLERANCE
}

/**
 * The world along range one Thread/Flutes row actually occupies. The stored
 * `start`/`length` are in the bar frame the row was drawn in; the instance
 * transform is where the user put it, so the band must be placed through that
 * transform before it is compared with a Turn's placed span.
 */
function patternWorldRange(
  frame: RotaryPatternFrame,
  feature: Project['features'][number],
  pattern: PatternParams,
): WorldBand | null {
  const stored = pattern.params.frame
  if (isTranslation(feature)) {
    const range = bandAlong(stored, pattern.params)
    if (!range) return null
    const shift = frame.axis === 'x' ? feature.transform.e : feature.transform.f
    return { min: range.min + shift, max: range.max + shift }
  }
  const input = pattern.kind === 'thread'
    ? {
      kind: 'thread' as const,
      start: pattern.params.start,
      length: pattern.params.length,
      pitch: pattern.params.pitch,
      starts: pattern.params.starts,
      hand: pattern.params.hand,
      depth: pattern.params.depth,
    }
    : {
      kind: 'flutes' as const,
      start: pattern.params.start,
      length: pattern.params.length,
      count: pattern.params.count,
      twist: pattern.params.twist,
      depth: pattern.params.depth,
    }
  const built = buildRotaryPatternLines(stored, input)
  if (!built.ok) return null
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const line of built.lines) {
    for (const [along, across] of [
      [line.alongStart, line.acrossStart],
      [line.alongEnd, line.acrossEnd],
    ] as const) {
      const world = applyMatrixToPoint(feature.transform, pointOn(stored.axis, along, across))
      const value = frame.axis === 'x' ? world.x : world.y
      min = Math.min(min, value)
      max = Math.max(max, value)
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null
}

/** The surface a Thread/Flutes row measures from, with its placement applied. */
export function rotaryPatternSurfaceOfFeature(
  project: Project,
  featureId: string,
): RotaryPatternSurface | null {
  const index = buildSurfaceIndex(project)
  if (!index) return null
  const feature = project.features.find((row) => row.id === featureId)
  if (!feature) return null
  const pattern = patternParams(project.featureDefinitions[feature.definitionId])
  if (!pattern) return null
  const range = patternWorldRange(index.frame, feature, pattern)
  return range ? surfaceAtRange(project, index, range) : null
}

/**
 * The warning for every Thread/Flutes row that is not simply on the bar or on
 * one Turn. The tree translates the key; the helper only decides which rows
 * warn, so a row and the dialog cannot disagree.
 */
export function rotaryPatternSurfaceWarnings(
  project: Project,
  featureIds?: readonly string[],
): Map<string, RotaryPatternSurfaceWarning> {
  const warnings = new Map<string, RotaryPatternSurfaceWarning>()
  const index = buildSurfaceIndex(project)
  if (!index) return warnings
  const ids = featureIds ?? project.features.map((feature) => feature.id)
  const byId = new Map(project.features.map((feature) => [feature.id, feature]))
  for (const id of ids) {
    const feature = byId.get(id)
    if (!feature) continue
    const pattern = patternParams(project.featureDefinitions[feature.definitionId])
    if (!pattern) continue
    const range = patternWorldRange(index.frame, feature, pattern)
    if (!range) continue
    const warning = rotaryPatternSurfaceWarning(surfaceAtRange(project, index, range))
    if (warning) warnings.set(id, warning)
  }
  return warnings
}

/** The derived span of one row, from its placed band and the current Turns. */
function derivedSpan(
  project: Project,
  index: SurfaceIndex,
  feature: Project['features'][number],
  pattern: PatternParams,
): { zTop: number; zBottom: number } | null {
  const range = patternWorldRange(index.frame, feature, pattern)
  if (!range) return null
  const span = spanForSurface(project, surfaceAtRange(project, index, range), pattern.params.depth)
  return { zTop: span.zTop, zBottom: span.zBottom }
}

/**
 * True when no Turn, model, Thread/Flutes row, definition or stock could have
 * changed: every row and its definition are still the same object. The store
 * writes immutably, so a reference is a sound "unchanged" test, and a stock
 * edit replaces the stock object.
 */
function rotaryGeometryUnchanged(previous: Project, next: Project): boolean {
  if (previous.stock !== next.stock) return false
  if (previous.features.length !== next.features.length) return false
  for (let index = 0; index < next.features.length; index += 1) {
    const before = previous.features[index]
    const after = next.features[index]
    if (!before || !after || before !== after) return false
    if (previous.featureDefinitions[before.definitionId]
      !== next.featureDefinitions[after.definitionId]) return false
  }
  return true
}

function dimensionNumber(value: number | string): number {
  return typeof value === 'number' ? value : 0
}

/**
 * Move every Thread/Flutes row onto the surface it lies on. The band and the
 * number come from the same resolver the dialog shows; an unchanged span is
 * left byte-identical (no history churn, no byte-changed file).
 *
 * The derived span is the only span (#1112 rt6-c): a stored one that differs —
 * an old file's Properties Z, a file written before the surface existed — is
 * rewritten here, on a write and on load. Keeping such a span as an "override"
 * was what made a Thread silently stop following its Turn.
 *
 * `previous` is the project *before* this write, when there is one. A write
 * that leaves every rotary row, definition and the stock the same object is
 * skipped without resolving anything; the load path passes none, so a document
 * opened from disk is measured row by row.
 */
export function syncRotaryPatternSurfaces(
  project: Project,
  features: Project['features'],
  featureDefinitions: Project['featureDefinitions'],
  previous?: Project,
): Project['features'] {
  const nextProject = project.features === features && project.featureDefinitions === featureDefinitions
    ? project
    : { ...project, features, featureDefinitions }
  // Every write passes through here, but most of them (a name, a selection, an
  // operation edit) leave every rotary row and definition object untouched.
  // Comparing references is O(rows) and skips the whole resolver in that case.
  if (previous && rotaryGeometryUnchanged(previous, nextProject)) return features
  const index = buildSurfaceIndex(nextProject)
  if (!index) return features

  let changed = false
  const next = features.map((feature) => {
    const pattern = patternParams(featureDefinitions[feature.definitionId])
    if (!pattern) return feature
    const span = derivedSpan(nextProject, index, feature, pattern)
    if (!span) return feature
    if (Math.abs(dimensionNumber(feature.z_top) - span.zTop) <= TOLERANCE
      && Math.abs(dimensionNumber(feature.z_bottom) - span.zBottom) <= TOLERANCE) {
      return feature
    }
    changed = true
    return { ...feature, z_top: span.zTop, z_bottom: span.zBottom }
  })
  return changed ? next : features
}

/**
 * The same sync for a whole project: one call after any write, so deleting,
 * moving, transforming, expanding, making unique, re-parenting or importing a
 * Turn moves its Thread/Flutes rows without every mutation knowing about the
 * resolver. Returns the same project object when no span changed, so a write
 * that does not touch a surface keeps its identity (and its undo comparison).
 */
export function syncRotaryPatternSurfaceProject(project: Project, previous?: Project): Project {
  const features = syncRotaryPatternSurfaces(
    project,
    project.features,
    project.featureDefinitions,
    previous,
  )
  return features === project.features ? project : { ...project, features }
}
