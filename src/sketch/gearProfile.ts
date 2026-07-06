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

import type { Point, SketchProfile } from '../types/project'

export const GEAR_MIN_TEETH = 6
export const GEAR_MAX_TEETH = 200
export const DEFAULT_GEAR_TEETH = 24
export const DEFAULT_GEAR_PRESSURE_ANGLE_DEG = 20

export type GearToothFlankProfile = 'involute' | 'straight'
export type GearRootForm = 'rounded' | 'flat' | 'sharp'
export type GearCrestForm = 'flat' | 'rounded'

export interface GearCreationParams {
  teeth: number
  wholeDepth: number
  flankProfile: GearToothFlankProfile
  pressureAngleDeg: number
  rootForm: GearRootForm
  rootFilletRadius: number
  crestForm: GearCrestForm
  crestRadius: number
  boreDiameter: number
}

export interface GearProfileParams extends GearCreationParams {
  center: Point
  outsideRadius: number
}

const TAU = Math.PI * 2
const INVOLUTE_FLANK_SAMPLES = 5
const ROOT_ARC_SAMPLES = 5
const CREST_ARC_SAMPLES = 5

export function gearModule(outsideRadius: number, teeth: number): number {
  return (outsideRadius * 2) / (teeth + 2)
}

export function gearPitchRadius(outsideRadius: number, teeth: number): number {
  return gearModule(outsideRadius, teeth) * teeth / 2
}

export function gearRootRadius(params: Pick<GearProfileParams, 'outsideRadius' | 'wholeDepth'>): number {
  return params.outsideRadius - params.wholeDepth
}

export function defaultGearCreationParams(outsideRadius: number): GearCreationParams {
  const safeOutsideRadius = Number.isFinite(outsideRadius) && outsideRadius > 0 ? outsideRadius : 10
  const module = gearModule(safeOutsideRadius, DEFAULT_GEAR_TEETH)
  return {
    teeth: DEFAULT_GEAR_TEETH,
    wholeDepth: module * 2.25,
    flankProfile: 'involute',
    pressureAngleDeg: DEFAULT_GEAR_PRESSURE_ANGLE_DEG,
    rootForm: 'rounded',
    rootFilletRadius: module * 0.15,
    crestForm: 'flat',
    crestRadius: module * 0.2,
    boreDiameter: 0,
  }
}

export function maxGearRootFilletRadius(params: Pick<GearProfileParams, 'outsideRadius' | 'wholeDepth' | 'teeth'>): number {
  const rootRadius = gearRootRadius(params)
  if (rootRadius <= 0 || params.teeth <= 0) {
    return 0
  }
  const circularPitchAtRoot = TAU * rootRadius / params.teeth
  return Math.max(0, Math.min(params.wholeDepth * 0.45, circularPitchAtRoot * 0.2))
}

export function maxGearCrestRadius(params: Pick<GearProfileParams, 'outsideRadius' | 'wholeDepth' | 'teeth'>): number {
  if (params.outsideRadius <= 0 || params.teeth <= 0) {
    return 0
  }
  const circularPitchAtOutside = TAU * params.outsideRadius / params.teeth
  return Math.max(0, Math.min(params.wholeDepth * 0.35, circularPitchAtOutside * 0.12))
}

function involuteCrestWouldCross(params: GearProfileParams): boolean {
  if (params.flankProfile !== 'involute' || params.teeth <= 0 || params.outsideRadius <= 0) {
    return false
  }
  const pitchRadius = gearPitchRadius(params.outsideRadius, params.teeth)
  const baseRadius = pitchRadius * Math.cos(params.pressureAngleDeg * Math.PI / 180)
  const flankEndRadius = params.crestForm === 'rounded'
    ? Math.max(gearRootShoulderRadius(params), gearCrestShoulderRadius(params))
    : params.outsideRadius
  const rollAtCrest = involuteAngle(baseRadius, flankEndRadius) - involuteAngle(baseRadius, pitchRadius)
  const halfToothAngleAtPitch = Math.PI / (2 * params.teeth)
  return rollAtCrest > halfToothAngleAtPitch + 1e-9
}

export function normalizeGearCreationParams(params: GearCreationParams): GearCreationParams {
  const teeth = Number.isFinite(params.teeth)
    ? Math.max(GEAR_MIN_TEETH, Math.min(GEAR_MAX_TEETH, Math.round(params.teeth)))
    : DEFAULT_GEAR_TEETH
  return {
    teeth,
    wholeDepth: Number.isFinite(params.wholeDepth) ? Math.max(0, params.wholeDepth) : 0,
    flankProfile: params.flankProfile,
    pressureAngleDeg: Number.isFinite(params.pressureAngleDeg)
      ? Math.max(10, Math.min(35, params.pressureAngleDeg))
      : DEFAULT_GEAR_PRESSURE_ANGLE_DEG,
    rootForm: params.rootForm,
    rootFilletRadius: Number.isFinite(params.rootFilletRadius) ? Math.max(0, params.rootFilletRadius) : 0,
    crestForm: params.crestForm,
    crestRadius: Number.isFinite(params.crestRadius) ? Math.max(0, params.crestRadius) : 0,
    boreDiameter: Number.isFinite(params.boreDiameter) ? Math.max(0, params.boreDiameter) : 0,
  }
}

export function validateGearProfileParams(params: GearProfileParams): string[] {
  const errors: string[] = []
  if (!Number.isFinite(params.center.x) || !Number.isFinite(params.center.y)) {
    errors.push('Center must be finite.')
  }
  if (!Number.isFinite(params.outsideRadius) || params.outsideRadius <= 0) {
    errors.push('Outside radius must be greater than 0.')
  }
  if (!Number.isInteger(params.teeth) || params.teeth < GEAR_MIN_TEETH || params.teeth > GEAR_MAX_TEETH) {
    errors.push(`Tooth count must be ${GEAR_MIN_TEETH}-${GEAR_MAX_TEETH}.`)
  }
  if (!Number.isFinite(params.wholeDepth) || params.wholeDepth <= 0) {
    errors.push('Whole depth must be greater than 0.')
  }
  const rootRadius = gearRootRadius(params)
  if (Number.isFinite(params.outsideRadius) && Number.isFinite(params.wholeDepth) && rootRadius <= 0) {
    errors.push('Whole depth must be smaller than the outside radius.')
  }
  if (params.flankProfile === 'involute' && (!Number.isFinite(params.pressureAngleDeg) || params.pressureAngleDeg < 10 || params.pressureAngleDeg > 35)) {
    errors.push('Pressure angle must be 10-35 degrees.')
  }
  if (involuteCrestWouldCross(params)) {
    errors.push('Pressure angle is too high for this tooth count; the involute flanks would cross at the crest.')
  }
  if (params.rootForm === 'rounded' && (!Number.isFinite(params.rootFilletRadius) || params.rootFilletRadius < 0)) {
    errors.push('Root fillet radius must be 0 or greater.')
  }
  if (params.rootForm === 'rounded' && params.rootFilletRadius > maxGearRootFilletRadius(params)) {
    errors.push('Root fillet radius is too large for the tooth spacing.')
  }
  if (params.crestForm === 'rounded' && (!Number.isFinite(params.crestRadius) || params.crestRadius < 0)) {
    errors.push('Crest radius must be 0 or greater.')
  }
  if (params.crestForm === 'rounded' && params.crestRadius > maxGearCrestRadius(params)) {
    errors.push('Crest radius is too large for the tooth spacing.')
  }
  if (!Number.isFinite(params.boreDiameter) || params.boreDiameter < 0) {
    errors.push('Bore diameter must be 0 or greater.')
  }
  if (params.boreDiameter > 0 && params.boreDiameter >= rootRadius * 2) {
    errors.push('Bore diameter must be smaller than the root diameter.')
  }
  return errors
}

function pointAt(center: Point, radius: number, angle: number): Point {
  return {
    x: center.x + radius * Math.cos(angle),
    y: center.y + radius * Math.sin(angle),
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function rootShoulderLift(params: GearProfileParams): number {
  if (params.rootForm === 'flat') {
    return 0
  }
  if (params.rootForm === 'sharp') {
    return maxGearRootFilletRadius(params)
  }
  return Math.min(params.rootFilletRadius, maxGearRootFilletRadius(params))
}

function gearRootShoulderRadius(params: GearProfileParams): number {
  return gearRootRadius(params) + rootShoulderLift(params)
}

function crestShoulderDrop(params: GearProfileParams): number {
  if (params.crestForm !== 'rounded') {
    return 0
  }
  return Math.min(params.crestRadius, maxGearCrestRadius(params))
}

function gearCrestShoulderRadius(params: GearProfileParams): number {
  return params.outsideRadius - crestShoulderDrop(params)
}

function addDistinctPoint(points: Point[], point: Point): void {
  const last = points[points.length - 1]
  if (last && Math.hypot(last.x - point.x, last.y - point.y) < 1e-9) {
    return
  }
  points.push(point)
}

function addCrestTransition(points: Point[], params: GearProfileParams, leftAngle: number, centerAngle: number, rightAngle: number): void {
  if (params.crestForm === 'flat') {
    addDistinctPoint(points, pointAt(params.center, params.outsideRadius, rightAngle))
    return
  }

  const shoulderRadius = gearCrestShoulderRadius(params)
  for (let step = 1; step <= CREST_ARC_SAMPLES; step += 1) {
    const t = step / (CREST_ARC_SAMPLES + 1)
    const angle = t <= 0.5
      ? lerp(leftAngle, centerAngle, t * 2)
      : lerp(centerAngle, rightAngle, (t - 0.5) * 2)
    const radius = shoulderRadius + (params.outsideRadius - shoulderRadius) * Math.sin(Math.PI * t)
    addDistinctPoint(points, pointAt(params.center, radius, angle))
  }
  addDistinctPoint(points, pointAt(params.center, shoulderRadius, rightAngle))
}

function involuteParam(baseRadius: number, radius: number): number {
  if (baseRadius <= 0 || radius <= baseRadius) {
    return 0
  }
  return Math.sqrt((radius * radius) / (baseRadius * baseRadius) - 1)
}

function involuteAngle(baseRadius: number, radius: number): number {
  const t = involuteParam(baseRadius, radius)
  return t - Math.atan(t)
}

function buildInvoluteToothPoints(params: GearProfileParams, toothIndex: number): {
  points: Point[]
  rootRightAngle: number
  nextRootLeftAngle: number
} {
  const pitch = TAU / params.teeth
  const toothCenterAngle = toothIndex * pitch
  const nextToothCenterAngle = (toothIndex + 1) * pitch
  const rootShoulderRadius = gearRootShoulderRadius(params)
  const crestShoulderRadius = gearCrestShoulderRadius(params)
  const pitchRadius = gearPitchRadius(params.outsideRadius, params.teeth)
  const baseRadius = pitchRadius * Math.cos(params.pressureAngleDeg * Math.PI / 180)
  const flankStartRadius = Math.max(rootShoulderRadius, Math.min(baseRadius, params.outsideRadius))
  const flankEndRadius = params.crestForm === 'rounded'
    ? Math.max(flankStartRadius, crestShoulderRadius)
    : params.outsideRadius
  const pitchInvolute = involuteAngle(baseRadius, pitchRadius)
  const halfToothAngleAtPitch = Math.PI / (2 * params.teeth)

  const flankAngle = (side: 'left' | 'right', radius: number, centerAngle = toothCenterAngle): number => {
    const roll = involuteAngle(baseRadius, radius) - pitchInvolute
    return side === 'left'
      ? centerAngle - halfToothAngleAtPitch + roll
      : centerAngle + halfToothAngleAtPitch - roll
  }

  const leftRootAngle = flankAngle('left', flankStartRadius)
  const rightRootAngle = flankAngle('right', flankStartRadius)
  const leftCrestAngle = flankAngle('left', flankEndRadius)
  const rightCrestAngle = flankAngle('right', flankEndRadius)
  const nextRootLeftAngle = flankAngle('left', flankStartRadius, nextToothCenterAngle)

  const points: Point[] = []
  addDistinctPoint(points, pointAt(params.center, rootShoulderRadius, leftRootAngle))
  if (flankStartRadius > rootShoulderRadius + 1e-9) {
    addDistinctPoint(points, pointAt(params.center, flankStartRadius, leftRootAngle))
  }
  for (let step = 1; step <= INVOLUTE_FLANK_SAMPLES; step += 1) {
    const t = step / INVOLUTE_FLANK_SAMPLES
    const radius = flankStartRadius + (flankEndRadius - flankStartRadius) * t
    addDistinctPoint(points, pointAt(params.center, radius, flankAngle('left', radius)))
  }

  addCrestTransition(points, params, leftCrestAngle, toothCenterAngle, rightCrestAngle)

  for (let step = INVOLUTE_FLANK_SAMPLES - 1; step >= 0; step -= 1) {
    const t = step / INVOLUTE_FLANK_SAMPLES
    const radius = flankStartRadius + (flankEndRadius - flankStartRadius) * t
    addDistinctPoint(points, pointAt(params.center, radius, flankAngle('right', radius)))
  }
  if (flankStartRadius > rootShoulderRadius + 1e-9) {
    addDistinctPoint(points, pointAt(params.center, rootShoulderRadius, rightRootAngle))
  }

  return { points, rootRightAngle: rightRootAngle, nextRootLeftAngle }
}

function buildStraightToothPoints(params: GearProfileParams, toothIndex: number): {
  points: Point[]
  rootRightAngle: number
  nextRootLeftAngle: number
} {
  const pitch = TAU / params.teeth
  const toothCenterAngle = toothIndex * pitch
  const nextToothCenterAngle = (toothIndex + 1) * pitch
  const rootShoulderRadius = gearRootShoulderRadius(params)
  const crestShoulderRadius = gearCrestShoulderRadius(params)
  const rootHalfAngle = pitch * 0.32
  const crestHalfAngle = pitch * 0.18

  const rootLeftAngle = toothCenterAngle - rootHalfAngle
  const rootRightAngle = toothCenterAngle + rootHalfAngle
  const crestLeftAngle = toothCenterAngle - crestHalfAngle
  const crestRightAngle = toothCenterAngle + crestHalfAngle
  const nextRootLeftAngle = nextToothCenterAngle - rootHalfAngle

  const points: Point[] = []
  addDistinctPoint(points, pointAt(params.center, rootShoulderRadius, rootLeftAngle))
  addDistinctPoint(points, pointAt(params.center, crestShoulderRadius, crestLeftAngle))
  addCrestTransition(points, params, crestLeftAngle, toothCenterAngle, crestRightAngle)
  addDistinctPoint(points, pointAt(params.center, rootShoulderRadius, rootRightAngle))

  return { points, rootRightAngle, nextRootLeftAngle }
}

function addRootTransition(points: Point[], params: GearProfileParams, fromAngle: number, toAngle: number): void {
  const rootRadius = gearRootRadius(params)
  const rootShoulderRadius = gearRootShoulderRadius(params)
  if (params.rootForm === 'flat') {
    return
  }
  if (params.rootForm === 'sharp') {
    addDistinctPoint(points, pointAt(params.center, rootRadius, lerp(fromAngle, toAngle, 0.5)))
    return
  }

  const samples = ROOT_ARC_SAMPLES
  for (let step = 1; step <= samples; step += 1) {
    const t = step / (samples + 1)
    const radius = rootShoulderRadius - (rootShoulderRadius - rootRadius) * Math.sin(Math.PI * t)
    addDistinctPoint(points, pointAt(params.center, radius, lerp(fromAngle, toAngle, t)))
  }
}

function profileFromPoints(points: Point[]): SketchProfile {
  if (points.length < 3) {
    throw new Error('Gear profile requires at least three points.')
  }
  return {
    start: points[0],
    segments: [
      ...points.slice(1).map((point) => ({ type: 'line' as const, to: point })),
      { type: 'line' as const, to: points[0] },
    ],
    closed: true,
  }
}

export function buildGearProfile(input: GearProfileParams): SketchProfile {
  const params: GearProfileParams = {
    ...input,
    ...normalizeGearCreationParams(input),
    center: input.center,
    outsideRadius: input.outsideRadius,
  }
  const errors = validateGearProfileParams(params)
  if (errors.length > 0) {
    throw new Error(errors[0])
  }

  const points: Point[] = []
  for (let toothIndex = 0; toothIndex < params.teeth; toothIndex += 1) {
    const tooth = params.flankProfile === 'straight'
      ? buildStraightToothPoints(params, toothIndex)
      : buildInvoluteToothPoints(params, toothIndex)
    for (const point of tooth.points) {
      addDistinctPoint(points, point)
    }
    addRootTransition(points, params, tooth.rootRightAngle, tooth.nextRootLeftAngle)
  }

  return profileFromPoints(points)
}
