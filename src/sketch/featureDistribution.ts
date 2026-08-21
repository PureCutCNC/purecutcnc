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

import { sampleProfilePoints } from '../types/project'
import type { Matrix2D, Point, SketchProfile } from '../types/project'
import type { Units } from '../utils/units'

const EPSILON = 1e-9
const FULL_TURN = Math.PI * 2
const BEZIER_LENGTH_STEPS = 128

export type FeatureDistributionOrientation = 'fixed' | 'follow'

export type FeatureDistributionSpec =
  | {
      mode: 'grid'
      rows: number
      columns: number
      spacingX: number
      spacingY: number
      startScale: number
      endScale: number
    }

  | {
      mode: 'radial'
      center: Point
      copyCount: number
      sweepDegrees: number
      orientation: FeatureDistributionOrientation
      startScale: number
      endScale: number
    }

  | {
      mode: 'path'
      copyCount: number
      startOffset: number
      endOffset: number
      orientation: FeatureDistributionOrientation
      startScale: number
      endScale: number
    }

export type FeatureDistributionMode = FeatureDistributionSpec['mode']

export type FeatureDistributionValidationCode =
  | 'invalid-grid'
  | 'invalid-copy-count'
  | 'invalid-scale'
  | 'radial-center-overlaps-source'
  | 'path-guide-required'
  | 'path-guide-empty'
  | 'invalid-path-offsets'

export interface FeatureDistributionPlacement {
  /** Affine transform applied before the source feature's existing transform. */
  transform: Matrix2D
  position: Point
  rotationRadians: number
  scale: number
}

export type FeatureDistributionPlan =
  | {
      ok: true
      placements: FeatureDistributionPlacement[]
      /** Transform applied to the existing source for an along-guide distribution. */
      sourcePlacement?: FeatureDistributionPlacement
      guideLength?: number
    }
  | { ok: false; code: FeatureDistributionValidationCode; guideLength?: number }

export interface FeatureDistributionPlannerInput {
  spec: FeatureDistributionSpec
  sourcePivot: Point
  /** Direction of the source layout's local X axis, in world coordinates. */
  sourceOrientationRadians?: number
  guideProfile?: SketchProfile | null
}

interface PathPoint {
  point: Point
  tangent: Point
}

interface PathPiece {
  length: number
  at: (distance: number) => PathPoint
}

export interface ProfilePathMeasure {
  length: number
  closed: boolean
  at: (distance: number) => PathPoint
}

export function createDefaultFeatureDistributionSpec(units: Units = 'mm'): FeatureDistributionSpec {
  return createFeatureDistributionSpec('grid', units, { x: 0, y: 0 })
}

/** Creates the mode-specific starting values for a new distribution workflow. */
export function createFeatureDistributionSpec(
  mode: FeatureDistributionMode,
  units: Units = 'mm',
  sourcePivot: Point = { x: 0, y: 0 },
): FeatureDistributionSpec {
  if (mode === 'radial') {
    return {
      mode,
      // The radial dialog always asks the user to pick a real center before it
      // can be committed; the source pivot is only a safe transient fallback.
      center: sourcePivot,
      copyCount: 4,
      sweepDegrees: 360,
      orientation: 'follow',
      startScale: 100,
      endScale: 100,
    }
  }

  if (mode === 'path') {
    return {
      mode,
      copyCount: 4,
      startOffset: 0,
      endOffset: 0,
      orientation: 'follow',
      startScale: 100,
      endScale: 100,
    }
  }

  const spacing = units === 'inch' ? 2 : 20
  return {
    mode,
    rows: 1,
    columns: 2,
    spacingX: spacing,
    spacingY: spacing,
    startScale: 100,
    endScale: 100,
  }
}

/** Center of the complete source layout, shared by preview and commit. */
export function featureDistributionPivot(profiles: SketchProfile[]): Point {
  const points = profiles.flatMap((profile) => sampleProfilePoints(profile, 32))
  if (points.length === 0) return { x: 0, y: 0 }
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxY = Math.max(...points.map((point) => point.y))
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

export function planFeatureDistribution(input: FeatureDistributionPlannerInput): FeatureDistributionPlan {
  const { spec, sourcePivot } = input
  const sourceOrientation = input.sourceOrientationRadians ?? 0
  if (!validScaleRange(spec.startScale, spec.endScale)) {
    return { ok: false, code: 'invalid-scale' }
  }

  if (spec.mode === 'grid') {
    if (!Number.isInteger(spec.rows) || !Number.isInteger(spec.columns)
      || spec.rows < 1 || spec.columns < 1 || spec.rows * spec.columns < 2
      || !Number.isFinite(spec.spacingX) || !Number.isFinite(spec.spacingY)) {
      return { ok: false, code: 'invalid-grid' }
    }

    const targets: Array<{ position: Point; rotationRadians: number }> = []
    for (let row = 0; row < spec.rows; row += 1) {
      for (let column = 0; column < spec.columns; column += 1) {
        if (row === 0 && column === 0) continue
        targets.push({
          position: {
            x: sourcePivot.x + column * spec.spacingX,
            y: sourcePivot.y + row * spec.spacingY,
          },
          rotationRadians: 0,
        })
      }
    }
    return { ok: true, placements: placementsFromTargets(sourcePivot, targets, spec.startScale, spec.endScale) }
  }

  if (spec.mode === 'radial') {
    if (!isDistributionCount(spec.copyCount)
      || !Number.isFinite(spec.center.x) || !Number.isFinite(spec.center.y)
      || !Number.isFinite(spec.sweepDegrees)) {
      return { ok: false, code: 'invalid-copy-count' }
    }
    const radius = distance(sourcePivot, spec.center)
    if (radius < EPSILON) {
      return { ok: false, code: 'radial-center-overlaps-source' }
    }

    // The source stays as the first instance, so its existing position defines
    // both the radius and the start of the radial sweep.
    const startAngle = Math.atan2(sourcePivot.y - spec.center.y, sourcePivot.x - spec.center.x)
    const sweep = degreesToRadians(spec.sweepDegrees)
    const fullCircle = Math.abs(Math.abs(sweep) - FULL_TURN) < 1e-6
    const increment = fullCircle
      ? sweep / spec.copyCount
      : sweep / (spec.copyCount - 1)
    const targets = Array.from({ length: spec.copyCount - 1 }, (_, copyIndex) => {
      const angle = startAngle + increment * (copyIndex + 1)
      return {
        position: {
          x: spec.center.x + Math.cos(angle) * radius,
          y: spec.center.y + Math.sin(angle) * radius,
        },
        rotationRadians: spec.orientation === 'follow' ? angle - startAngle : 0,
      }
    })
    return { ok: true, placements: placementsFromTargets(sourcePivot, targets, spec.startScale, spec.endScale) }
  }

  if (!isDistributionCount(spec.copyCount)) {
    return { ok: false, code: 'invalid-copy-count' }
  }
  if (!input.guideProfile) {
    return { ok: false, code: 'path-guide-required' }
  }
  const path = measureProfilePath(input.guideProfile)
  if (!path || path.length < EPSILON) {
    return { ok: false, code: 'path-guide-empty' }
  }

  const pathRange = normalizedPathRange(path, spec.startOffset, spec.endOffset)
  if (!pathRange) {
    return { ok: false, code: 'invalid-path-offsets', guideLength: path.length }
  }
  const step = path.closed
    ? pathRange.span / spec.copyCount
    : pathRange.span / (spec.copyCount - 1)
  const sourcePathPoint = path.at(pathRange.start)
  const sourceRotationRadians = spec.orientation === 'follow'
    ? Math.atan2(sourcePathPoint.tangent.y, sourcePathPoint.tangent.x) - sourceOrientation
    : 0
  const targets = Array.from({ length: spec.copyCount - 1 }, (_, copyIndex) => {
    const pathPoint = path.at(pathRange.start + step * (copyIndex + 1))
    return {
      position: pathPoint.point,
      rotationRadians: spec.orientation === 'follow'
        ? Math.atan2(pathPoint.tangent.y, pathPoint.tangent.x) - sourceOrientation
        : 0,
    }
  })
  return {
    ok: true,
    sourcePlacement: {
      position: sourcePathPoint.point,
      rotationRadians: sourceRotationRadians,
      scale: 1,
      transform: placementTransform(sourcePivot, sourcePathPoint.point, sourceRotationRadians, 1),
    },
    placements: placementsFromTargets(sourcePivot, targets, spec.startScale, spec.endScale),
    guideLength: path.length,
  }
}

export function profilePathLength(profile: SketchProfile): number {
  return measureProfilePath(profile)?.length ?? 0
}

/**
 * Builds an arc-length measure for line, arc, circle, and cubic Bézier sketch
 * segments. Béziers use a fixed 128-step table so placement is deterministic
 * for preview, commit, and tests.
 */
export function measureProfilePath(profile: SketchProfile): ProfilePathMeasure | null {
  const pieces: PathPiece[] = []
  let current = profile.start
  for (const segment of profile.segments) {
    const piece = segment.type === 'line'
      ? linePiece(current, segment.to)
      : segment.type === 'bezier'
        ? bezierPiece(current, segment.control1, segment.control2, segment.to)
        : segment.type === 'circle'
          ? arcPiece(current, segment.center, current, segment.clockwise, true)
          : arcPiece(current, segment.center, segment.to, segment.clockwise, false)
    if (piece.length > EPSILON) pieces.push(piece)
    current = segment.type === 'circle' ? profile.start : segment.to
  }
  const length = pieces.reduce((total, piece) => total + piece.length, 0)
  if (length < EPSILON) return null

  return {
    length,
    closed: profile.closed,
    at: (distanceAt) => {
      const normalized = profile.closed
        ? modulo(distanceAt, length)
        : clamp(distanceAt, 0, length)
      let remaining = normalized
      for (const piece of pieces) {
        if (remaining <= piece.length || piece === pieces[pieces.length - 1]) {
          return piece.at(remaining)
        }
        remaining -= piece.length
      }
      return pieces[pieces.length - 1]!.at(pieces[pieces.length - 1]!.length)
    },
  }
}

export function applyFeatureDistributionTransform(matrix: Matrix2D, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  }
}

function placementsFromTargets(
  sourcePivot: Point,
  targets: Array<{ position: Point; rotationRadians: number }>,
  startScalePercent: number,
  endScalePercent: number,
): FeatureDistributionPlacement[] {
  return targets.map((target, index) => {
    const scale = lerp(startScalePercent, endScalePercent, fraction(index, targets.length)) / 100
    return {
      position: target.position,
      rotationRadians: target.rotationRadians,
      scale,
      transform: placementTransform(sourcePivot, target.position, target.rotationRadians, scale),
    }
  })
}

function placementTransform(sourcePivot: Point, target: Point, rotation: number, scale: number): Matrix2D {
  const cosine = Math.cos(rotation) * scale
  const sine = Math.sin(rotation) * scale
  return {
    a: cosine,
    b: sine,
    c: -sine,
    d: cosine,
    e: target.x - cosine * sourcePivot.x + sine * sourcePivot.y,
    f: target.y - sine * sourcePivot.x - cosine * sourcePivot.y,
  }
}

function linePiece(start: Point, end: Point): PathPiece {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  const tangent = normalized({ x: dx, y: dy })
  return {
    length,
    at: (distanceAt) => ({
      point: {
        x: start.x + tangent.x * clamp(distanceAt, 0, length),
        y: start.y + tangent.y * clamp(distanceAt, 0, length),
      },
      tangent,
    }),
  }
}

function arcPiece(start: Point, center: Point, end: Point, clockwise: boolean, fullCircle: boolean): PathPiece {
  const radius = distance(start, center)
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x)
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x)
  let sweep = fullCircle ? (clockwise ? -FULL_TURN : FULL_TURN) : endAngle - startAngle
  if (!fullCircle && clockwise && sweep > 0) sweep -= FULL_TURN
  if (!fullCircle && !clockwise && sweep < 0) sweep += FULL_TURN
  const length = Math.abs(sweep) * radius
  return {
    length,
    at: (distanceAt) => {
      const ratio = length < EPSILON ? 0 : clamp(distanceAt, 0, length) / length
      const angle = startAngle + sweep * ratio
      const direction = sweep < 0 ? -1 : 1
      return {
        point: {
          x: center.x + Math.cos(angle) * radius,
          y: center.y + Math.sin(angle) * radius,
        },
        tangent: { x: -Math.sin(angle) * direction, y: Math.cos(angle) * direction },
      }
    },
  }
}

function bezierPiece(start: Point, control1: Point, control2: Point, end: Point): PathPiece {
  const points = Array.from({ length: BEZIER_LENGTH_STEPS + 1 }, (_, index) => (
    cubicBezierPoint(start, control1, control2, end, index / BEZIER_LENGTH_STEPS)
  ))
  const lengths = [0]
  for (let index = 1; index < points.length; index += 1) {
    lengths.push(lengths[index - 1]! + distance(points[index - 1]!, points[index]!))
  }
  const length = lengths[lengths.length - 1]!
  return {
    length,
    at: (distanceAt) => {
      const target = clamp(distanceAt, 0, length)
      const upper = lengths.findIndex((value) => value >= target)
      const index = Math.max(1, upper)
      const before = lengths[index - 1]!
      const segmentLength = lengths[index]! - before
      const local = segmentLength < EPSILON ? 0 : (target - before) / segmentLength
      const t = ((index - 1) + local) / BEZIER_LENGTH_STEPS
      return {
        point: cubicBezierPoint(start, control1, control2, end, t),
        tangent: normalized(cubicBezierDerivative(start, control1, control2, end, t)),
      }
    },
  }
}

function normalizedPathRange(path: ProfilePathMeasure, startOffset: number, endOffset: number): { start: number; span: number } | null {
  if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset)
    || startOffset < 0 || endOffset < 0 || startOffset > path.length || endOffset > path.length) {
    return null
  }
  if (!path.closed) {
    if (endOffset < startOffset || endOffset - startOffset < EPSILON) return null
    return { start: startOffset, span: endOffset - startOffset }
  }
  const span = endOffset >= startOffset
    ? endOffset - startOffset
    : path.length - startOffset + endOffset
  return { start: startOffset, span: span < EPSILON ? path.length : span }
}

function validScaleRange(startScale: number, endScale: number): boolean {
  return Number.isFinite(startScale) && Number.isFinite(endScale) && startScale > 0 && endScale > 0
}

function isDistributionCount(value: number): boolean {
  return Number.isInteger(value) && value >= 2
}

function cubicBezierPoint(start: Point, control1: Point, control2: Point, end: Point, t: number): Point {
  const inverse = 1 - t
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * t * control1.x + 3 * inverse * t ** 2 * control2.x + t ** 3 * end.x,
    y: inverse ** 3 * start.y + 3 * inverse ** 2 * t * control1.y + 3 * inverse * t ** 2 * control2.y + t ** 3 * end.y,
  }
}

function cubicBezierDerivative(start: Point, control1: Point, control2: Point, end: Point, t: number): Point {
  const inverse = 1 - t
  return {
    x: 3 * inverse ** 2 * (control1.x - start.x)
      + 6 * inverse * t * (control2.x - control1.x)
      + 3 * t ** 2 * (end.x - control2.x),
    y: 3 * inverse ** 2 * (control1.y - start.y)
      + 6 * inverse * t * (control2.y - control1.y)
      + 3 * t ** 2 * (end.y - control2.y),
  }
}

function normalized(vector: Point): Point {
  const length = Math.hypot(vector.x, vector.y)
  return length < EPSILON ? { x: 1, y: 0 } : { x: vector.x / length, y: vector.y / length }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function fraction(index: number, length: number): number {
  return length <= 1 ? 0 : index / (length - 1)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180
}
