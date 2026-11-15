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

import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  toClipperPath,
} from '../toolpaths/geometry'
import { simplifyOffsetContour } from '../toolpaths/arcReconstruction'
import { offsetClipperPaths } from '../../store/helpers/clipping'
import { mirrorProfile } from '../../store/helpers/transform'
import { getProfileBounds, rectProfile } from '../../types/project'
import type { Point, SketchProfile } from '../../types/project'
import type {
  InlayDerived,
  InlayGeometry,
  InlayGeometryInput,
  InlayInputShape,
  InlayProblem,
  InlayRole,
  InlayShape,
} from './types'

/** Extra bite into the V wall so the floor pass never leaves a hairline ridge. */
const FLOOR_OVERLAP = 0.05
/** Plug stock margin around the mirrored source. */
export const INLAY_FRAME_MARGIN = 5
/** The V generator refuses a zero contour stepdown (vcarve.ts). */
export const INLAY_MIN_WALL_STEP = 0.05
/** Anything below one square micron is a collapsed contour, not a shape. */
const MIN_SHAPE_AREA = 1e-6

export function computeInlayGeometry(input: InlayGeometryInput): InlayGeometry {
  const { shapes, params, plugOrigin } = input
  if (shapes.length === 0) {
    throw new RangeError('inlay geometry needs at least one source shape')
  }
  validateParams(params)

  const slope = Math.tan((params.vBitAngle * Math.PI) / 360)
  const plugDepth = params.pocketDepth + params.surfaceGap
  const floorInset = params.pocketDepth * slope - FLOOR_OVERLAP
  const ridgeInset = plugDepth * slope + params.fitAdjustment
  const shoulderInset = params.fitAdjustment
  const stepover = slope * params.wallStep
  const grooveWidth = 2 * plugDepth * slope

  const derived: InlayDerived = {
    slope,
    carveDepth: params.pocketDepth,
    plugDepth,
    floorInset,
    ridgeInset,
    shoulderInset,
    stepover,
    grooveWidth,
  }
  const problems: InlayProblem[] = []
  if (floorInset <= 0) {
    problems.push({ code: 'tooThin', detail: 'pocket depth is shallower than the floor overlap' })
  }
  if (grooveWidth > params.vBitDiameter + 1e-9) {
    problems.push({
      code: 'grooveWiderThanBit',
      detail: `groove ${grooveWidth.toFixed(3)} exceeds bit ${params.vBitDiameter}`,
    })
  }
  if (params.stockThickness - plugDepth < params.plugBaseThickness - 1e-9) {
    problems.push({
      code: 'baseTooThin',
      detail: `only ${(params.stockThickness - plugDepth).toFixed(3)} left under the plug`,
    })
  }
  if (plugDepth >= params.stockThickness) {
    problems.push({ code: 'depthTooDeep', detail: 'plug depth reaches through the stock' })
  }

  const mirrorAxisX = params.mirror ? plugOrigin.x : null
  const pocketFloor = collect(
    shapes,
    floorInset,
    null,
    'pocketFloor',
    false,
    false,
    problems,
  )
  const plugRidge = collect(
    shapes,
    ridgeInset,
    mirrorAxisX,
    'plugRidge',
    true,
    true,
    problems,
  )
  const plugShoulder = collect(
    shapes,
    shoulderInset,
    mirrorAxisX,
    'plugShoulder',
    true,
    true,
    problems,
  )

  return {
    pocketFloor,
    plugRidge,
    plugShoulder,
    frame: plugFrame(shapes, plugOrigin, mirrorAxisX !== null),
    derived,
    problems,
  }
}

/** shortcut: mirror=false keeps the plug at the source position; WP3 places it. */
function collect(
  shapes: InlayInputShape[],
  inset: number,
  mirrorAxisX: number | null,
  role: InlayRole,
  mirror: boolean,
  invertOperation: boolean,
  problems: InlayProblem[],
): InlayShape[] {
  const result: InlayShape[] = []
  for (const shape of shapes) {
    const profile = mirror && mirrorAxisX !== null
      ? mirrorProfile(shape.profile, (point) => mirrorPoint(point, mirrorAxisX))
      : shape.profile
    const offset = offsetProfile(shape, profile, inset)
    if (!offset) {
      problems.push({ code: 'tooThin', detail: `${role}: ${shape.sourceFeature.name}` })
      continue
    }
    result.push({
      profile: offset,
      operation: invertOperation ? invert(shape.operation) : shape.operation,
      role,
      sourceFeatureId: shape.sourceFeature.id,
    })
  }
  return result
}

function offsetProfile(
  shape: InlayInputShape,
  profile: SketchProfile,
  inset: number,
): SketchProfile | null {
  // Every boundary moves toward the side the cutter removes.
  const delta = (shape.operation === 'add' ? inset : -inset) * DEFAULT_CLIPPER_SCALE
  const contour = toClipperPath(flattenProfile(profile).points)
  const offsets = offsetClipperPaths([contour], delta)

  let best: SketchProfile | null = null
  let bestArea = 0
  for (const candidate of offsets) {
    const simplified = simplifyOffsetContour(candidate, [shape.sourceFeature], delta)
    if (!simplified) {
      continue
    }
    const area = Math.abs(signedArea(simplified))
    if (area > bestArea) {
      best = simplified
      bestArea = area
    }
  }
  return best && bestArea >= MIN_SHAPE_AREA ? best : null
}

function signedArea(profile: SketchProfile): number {
  const points = flattenProfile(profile).points
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    sum += current.x * next.y - next.x * current.y
  }
  return sum / 2
}

function mirrorPoint(point: Point, axisX: number): Point {
  return { x: 2 * axisX - point.x, y: point.y }
}

function invert(operation: 'subtract' | 'add'): 'subtract' | 'add' {
  return operation === 'subtract' ? 'add' : 'subtract'
}

function plugFrame(
  shapes: InlayInputShape[],
  plugOrigin: Point,
  mirrored: boolean,
): SketchProfile {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const shape of shapes) {
    const bounds = getProfileBounds(shape.profile)
    const left = mirrored ? 2 * plugOrigin.x - bounds.maxX : bounds.minX
    const right = mirrored ? 2 * plugOrigin.x - bounds.minX : bounds.maxX
    minX = Math.min(minX, left)
    minY = Math.min(minY, bounds.minY)
    maxX = Math.max(maxX, right)
    maxY = Math.max(maxY, bounds.maxY)
  }
  return rectProfile(
    minX - INLAY_FRAME_MARGIN,
    minY - INLAY_FRAME_MARGIN,
    maxX - minX + 2 * INLAY_FRAME_MARGIN,
    maxY - minY + 2 * INLAY_FRAME_MARGIN,
  )
}

function validateParams(params: InlayGeometryInput['params']): void {
  const finite = (name: string, value: number): void => {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${name} must be finite`)
    }
  }
  finite('vBitAngle', params.vBitAngle)
  finite('vBitDiameter', params.vBitDiameter)
  finite('pocketDepth', params.pocketDepth)
  finite('surfaceGap', params.surfaceGap)
  finite('fitAdjustment', params.fitAdjustment)
  finite('stockThickness', params.stockThickness)
  finite('plugBaseThickness', params.plugBaseThickness)
  finite('wallStep', params.wallStep)

  if (params.vBitAngle <= 0 || params.vBitAngle >= 180) {
    throw new RangeError('vBitAngle must be between 0 and 180 degrees')
  }
  if (params.vBitDiameter <= 0) {
    throw new RangeError('vBitDiameter must be positive')
  }
  if (params.pocketDepth <= 0) {
    throw new RangeError('pocketDepth must be positive')
  }
  if (params.surfaceGap < 0) {
    throw new RangeError('surfaceGap must not be negative')
  }
  if (params.fitAdjustment < 0) {
    throw new RangeError('fitAdjustment must not be negative')
  }
  if (params.stockThickness <= 0) {
    throw new RangeError('stockThickness must be positive')
  }
  if (params.plugBaseThickness < 0) {
    throw new RangeError('plugBaseThickness must not be negative')
  }
  if (params.wallStep < INLAY_MIN_WALL_STEP) {
    throw new RangeError(`wallStep must be at least ${INLAY_MIN_WALL_STEP}`)
  }
}
