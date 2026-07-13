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

import { inferFeatureKind, profileVertices } from '../../types/project'
import type { BackdropImage, Matrix2D, Point, SketchFeature } from '../../types/project'
import {
  addPoint,
  clampNumber,
  crossPoint,
  dotPoint,
  normalizePoint,
  pointLength,
  scalePoint,
  subtractPoint,
} from './geometry'
import { angleToPoint, inferProfileOrientationAngle, normalizeAngleDegrees } from './normalize'
import { applyLineCornerChamfer, applyLineCornerFillet } from './profileEdit'
import { mirrorDelta, multiplyMatrix, rotateDelta, translateMatrix } from './instanceTransforms'
import {
  mirrorAngleAcrossLine,
  mirrorProfile,
  rotatePointAround,
  transformProfile,
  transformProfileAffine,
  transformStlFeatureData,
} from './transform'

function featureResizeBasis(feature: SketchFeature): { u: Point; v: Point } {
  const orientationAngle = normalizeAngleDegrees(
    feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
  )
  const v = angleToPoint(orientationAngle)
  const u = angleToPoint(orientationAngle - 90)
  return { u, v }
}

function snappedResizeScales(
  referenceVector: Point,
  previewVector: Point,
  u: Point,
  v: Point,
): { scaleU: number; scaleV: number } | null {
  const refU = dotPoint(referenceVector, u)
  const refV = dotPoint(referenceVector, v)
  const previewU = dotPoint(previewVector, u)
  const previewV = dotPoint(previewVector, v)

  const scaleU = Math.abs(refU) <= 1e-9 ? 1 : previewU / refU
  const scaleV = Math.abs(refV) <= 1e-9 ? 1 : previewV / refV

  const unit = normalizePoint(referenceVector)
  if (!unit) {
    return null
  }

  const axisSnapTolerance = Math.cos((12 * Math.PI) / 180)
  const alignU = Math.abs(dotPoint(unit, u))
  const alignV = Math.abs(dotPoint(unit, v))

  if (alignU >= axisSnapTolerance && alignU >= alignV) {
    return { scaleU, scaleV: 1 }
  }

  if (alignV >= axisSnapTolerance && alignV >= alignU) {
    return { scaleU: 1, scaleV }
  }

  return { scaleU, scaleV }
}

function scaleNumericZSpan(
  zTop: SketchFeature['z_top'],
  zBottom: SketchFeature['z_bottom'],
  scale: number,
): Pick<SketchFeature, 'z_top' | 'z_bottom'> {
  if (typeof zTop !== 'number' || typeof zBottom !== 'number') {
    return { z_top: zTop, z_bottom: zBottom }
  }

  return {
    z_top: zBottom + (zTop - zBottom) * scale,
    z_bottom: zBottom,
  }
}

export function resizeFeatureFromReference<TFeature extends SketchFeature & { transform: Matrix2D }>(
  feature: TFeature,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): TFeature | null {
  const referenceVector = subtractPoint(referenceEnd, referenceStart)
  const referenceLength = pointLength(referenceVector)
  if (referenceLength <= 1e-9) {
    return null
  }

  const unit = scalePoint(referenceVector, 1 / referenceLength)
  const projectedLength = dotPoint(subtractPoint(previewPoint, referenceStart), unit)
  const constrainedPreview = addPoint(referenceStart, scalePoint(unit, projectedLength))
  const { u, v } = featureResizeBasis(feature)
  const previewVector = subtractPoint(constrainedPreview, referenceStart)
  const snappedScales = snappedResizeScales(referenceVector, previewVector, u, v)
  if (!snappedScales) {
    return null
  }

  const uniformModelScale = feature.kind === 'stl'
    ? projectedLength / referenceLength
    : null
  const scaleU = uniformModelScale ?? snappedScales.scaleU
  const scaleV = uniformModelScale ?? snappedScales.scaleV
  if (
    !Number.isFinite(scaleU)
    || !Number.isFinite(scaleV)
    || scaleU <= 1e-6
    || scaleV <= 1e-6
  ) {
    return null
  }

  const transformPoint = (point: Point): Point => {
    const local = subtractPoint(point, referenceStart)
    const localU = dotPoint(local, u)
    const localV = dotPoint(local, v)
    return {
      x: referenceStart.x + u.x * localU * scaleU + v.x * localV * scaleV,
      y: referenceStart.y + u.y * localU * scaleU + v.y * localV * scaleV,
    }
  }

  const profile = transformProfileAffine(feature.sketch.profile, transformPoint)
  const resizedZ = feature.kind === 'stl'
    ? scaleNumericZSpan(feature.z_top, feature.z_bottom, scaleU)
    : { z_top: feature.z_top, z_bottom: feature.z_bottom }
  const linearPart: Matrix2D = {
    a: u.x * u.x * scaleU + v.x * v.x * scaleV,
    b: u.y * u.x * scaleU + v.y * v.x * scaleV,
    c: u.x * u.y * scaleU + v.x * v.y * scaleV,
    d: u.y * u.y * scaleU + v.y * v.y * scaleV,
    e: 0,
    f: 0,
  }
  const scaleTransform = multiplyMatrix(
    translateMatrix(referenceStart.x, referenceStart.y),
    multiplyMatrix(linearPart, translateMatrix(-referenceStart.x, -referenceStart.y)),
  )
  const nextTransform = multiplyMatrix(scaleTransform, feature.transform)

  return {
    ...feature,
    kind: feature.kind === 'text' ? 'text' : (feature.kind === 'stl' ? 'stl' : inferFeatureKind(profile)),
    stl: feature.stl
      ? {
          ...transformStlFeatureData(feature.stl, transformPoint)!,
          scale: feature.stl.scale * scaleU,
        }
      : feature.stl,
    z_top: resizedZ.z_top,
    z_bottom: resizedZ.z_bottom,
    sketch: {
      ...feature.sketch,
      origin: transformPoint(feature.sketch.origin),
      orientationAngle: normalizeAngleDegrees(
        feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
      ),
      profile,
    },
    transform: nextTransform,
  } as TFeature
}

export function rotateFeatureFromReference<TFeature extends SketchFeature & { transform: Matrix2D }>(
  feature: TFeature,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): TFeature | null {
  const startVector = subtractPoint(referenceEnd, referenceStart)
  const endVector = subtractPoint(previewPoint, referenceStart)
  const startLength = pointLength(startVector)
  const endLength = pointLength(endVector)
  if (startLength <= 1e-9 || endLength <= 1e-9) {
    return null
  }

  const angle = Math.atan2(crossPoint(startVector, endVector), dotPoint(startVector, endVector))
  if (!Number.isFinite(angle)) {
    return null
  }

  const rotatePoint = (point: Point) => rotatePointAround(point, referenceStart, angle)
  const profile = transformProfile(feature.sketch.profile, rotatePoint)
  const nextTransform = multiplyMatrix(rotateDelta(referenceStart, angle), feature.transform)
  return {
    ...feature,
    kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(profile),
    stl: transformStlFeatureData(feature.stl, rotatePoint),
    sketch: {
      ...feature.sketch,
      origin: rotatePoint(feature.sketch.origin),
      orientationAngle: normalizeAngleDegrees(
        (feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile)) + angle * (180 / Math.PI),
      ),
      profile,
    },
    transform: nextTransform,
  } as TFeature
}

export function mirrorFeatureFromReference<TFeature extends SketchFeature & { transform: Matrix2D }>(
  feature: TFeature,
  referenceStart: Point,
  referenceEnd: Point,
): TFeature | null {
  const axis = normalizePoint(subtractPoint(referenceEnd, referenceStart))
  if (!axis) {
    return null
  }

  const mirrorPoint = (point: Point): Point => {
    const local = subtractPoint(point, referenceStart)
    const projected = scalePoint(axis, dotPoint(local, axis))
    return addPoint(referenceStart, subtractPoint(scalePoint(projected, 2), local))
  }
  const profile = mirrorProfile(feature.sketch.profile, mirrorPoint)
  const orientationAngle = mirrorAngleAcrossLine(
    feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
    referenceStart,
    referenceEnd,
  )
  if (orientationAngle === null) {
    return null
  }
  const nextTransform = multiplyMatrix(mirrorDelta(referenceStart, referenceEnd), feature.transform)

  return {
    ...feature,
    kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(profile),
    stl: transformStlFeatureData(feature.stl, mirrorPoint),
    sketch: {
      ...feature.sketch,
      origin: mirrorPoint(feature.sketch.origin),
      orientationAngle,
      profile,
    },
    transform: nextTransform,
  } as TFeature
}

function backdropResizeBasis(backdrop: BackdropImage): { u: Point; v: Point } {
  const orientationAngle = normalizeAngleDegrees(backdrop.orientationAngle ?? 90)
  return {
    u: angleToPoint(orientationAngle - 90),
    v: angleToPoint(orientationAngle),
  }
}

export function resizeBackdropFromReference(
  backdrop: BackdropImage,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): BackdropImage | null {
  const referenceVector = subtractPoint(referenceEnd, referenceStart)
  const referenceLength = pointLength(referenceVector)
  if (referenceLength <= 1e-9) {
    return null
  }

  const unit = scalePoint(referenceVector, 1 / referenceLength)
  const projectedLength = dotPoint(subtractPoint(previewPoint, referenceStart), unit)
  const constrainedPreview = addPoint(referenceStart, scalePoint(unit, projectedLength))
  const { u, v } = backdropResizeBasis(backdrop)
  const previewVector = subtractPoint(constrainedPreview, referenceStart)
  const snappedScales = snappedResizeScales(referenceVector, previewVector, u, v)
  if (!snappedScales) {
    return null
  }

  const { scaleU, scaleV } = snappedScales
  if (
    !Number.isFinite(scaleU)
    || !Number.isFinite(scaleV)
    || scaleU <= 1e-6
    || scaleV <= 1e-6
  ) {
    return null
  }

  const local = subtractPoint(backdrop.center, referenceStart)
  const localU = dotPoint(local, u)
  const localV = dotPoint(local, v)

  return {
    ...backdrop,
    center: {
      x: referenceStart.x + u.x * localU * scaleU + v.x * localV * scaleV,
      y: referenceStart.y + u.y * localU * scaleU + v.y * localV * scaleV,
    },
    width: backdrop.width * scaleU,
    height: backdrop.height * scaleV,
  }
}

export function rotateBackdropFromReference(
  backdrop: BackdropImage,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): BackdropImage | null {
  const startVector = subtractPoint(referenceEnd, referenceStart)
  const endVector = subtractPoint(previewPoint, referenceStart)
  const startLength = pointLength(startVector)
  const endLength = pointLength(endVector)
  if (startLength <= 1e-9 || endLength <= 1e-9) {
    return null
  }

  const angle = Math.atan2(crossPoint(startVector, endVector), dotPoint(startVector, endVector))
  if (!Number.isFinite(angle)) {
    return null
  }

  return {
    ...backdrop,
    center: rotatePointAround(backdrop.center, referenceStart, angle),
    orientationAngle: normalizeAngleDegrees(backdrop.orientationAngle + angle * (180 / Math.PI)),
  }
}

export function filletRadiusFromPoint(
  feature: SketchFeature,
  anchorIndex: number,
  previewPoint: Point,
): number | null {
  const profile = feature.sketch.profile
  const anchors = profileVertices(profile)
  const anchorCount = anchors.length
  const hasIncoming = profile.closed || anchorIndex > 0
  const hasOutgoing = profile.closed || anchorIndex < anchorCount - 1
  if (!hasIncoming || !hasOutgoing || anchorIndex < 0 || anchorIndex >= anchorCount) {
    return null
  }

  const corner = anchors[anchorIndex]
  const previousAnchor = anchors[(anchorIndex - 1 + anchorCount) % anchorCount]
  const nextAnchor = anchors[(anchorIndex + 1) % anchorCount]
  const incomingDirection = normalizePoint(subtractPoint(previousAnchor, corner))
  const outgoingDirection = normalizePoint(subtractPoint(nextAnchor, corner))
  if (!incomingDirection || !outgoingDirection) {
    return null
  }

  const incomingIndex = profile.closed ? (anchorIndex - 1 + profile.segments.length) % profile.segments.length : anchorIndex - 1
  const outgoingIndex = anchorIndex
  const incomingSegment = profile.segments[incomingIndex]
  const outgoingSegment = profile.segments[outgoingIndex]
  if (!incomingSegment || !outgoingSegment || incomingSegment.type !== 'line' || outgoingSegment.type !== 'line') {
    return null
  }

  const previewVector = subtractPoint(previewPoint, corner)
  const trim = Math.max(0, dotPoint(previewVector, incomingDirection), dotPoint(previewVector, outgoingDirection))
  if (!(trim > 1e-9)) {
    return null
  }

  const turnDot = clampNumber(dotPoint(incomingDirection, outgoingDirection), -1, 1)
  const interiorAngle = Math.acos(turnDot)
  if (!Number.isFinite(interiorAngle) || interiorAngle <= 1e-3 || Math.abs(Math.PI - interiorAngle) <= 1e-3) {
    return null
  }

  return trim * Math.tan(interiorAngle / 2)
}

export function filletFeatureFromPoint(
  feature: SketchFeature,
  anchorIndex: number,
  previewPoint: Point,
): SketchFeature | null {
  const radius = filletRadiusFromPoint(feature, anchorIndex, previewPoint)
  if (!radius) {
    return null
  }

  return filletFeatureFromRadius(feature, anchorIndex, radius)
}

export function filletFeatureFromRadius(
  feature: SketchFeature,
  anchorIndex: number,
  radius: number,
): SketchFeature | null {
  const profile = applyLineCornerFillet(feature.sketch.profile, anchorIndex, radius)
  if (!profile) {
    return null
  }

  return {
    ...feature,
    kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(profile),
    sketch: {
      ...feature.sketch,
      profile,
    },
  }
}

export function chamferDistanceFromPoint(
  feature: SketchFeature,
  anchorIndex: number,
  previewPoint: Point,
): number | null {
  const profile = feature.sketch.profile
  const anchors = profileVertices(profile)
  const anchorCount = anchors.length
  const hasIncoming = profile.closed || anchorIndex > 0
  const hasOutgoing = profile.closed || anchorIndex < anchorCount - 1
  if (!hasIncoming || !hasOutgoing || anchorIndex < 0 || anchorIndex >= anchorCount) {
    return null
  }

  const corner = anchors[anchorIndex]
  const previousAnchor = anchors[(anchorIndex - 1 + anchorCount) % anchorCount]
  const nextAnchor = anchors[(anchorIndex + 1) % anchorCount]
  const incomingDirection = normalizePoint(subtractPoint(previousAnchor, corner))
  const outgoingDirection = normalizePoint(subtractPoint(nextAnchor, corner))
  if (!incomingDirection || !outgoingDirection) {
    return null
  }

  const incomingIndex = profile.closed ? (anchorIndex - 1 + profile.segments.length) % profile.segments.length : anchorIndex - 1
  const outgoingIndex = anchorIndex
  const incomingSegment = profile.segments[incomingIndex]
  const outgoingSegment = profile.segments[outgoingIndex]
  if (!incomingSegment || !outgoingSegment || incomingSegment.type !== 'line' || outgoingSegment.type !== 'line') {
    return null
  }

  const previewVector = subtractPoint(previewPoint, corner)
  const distance = Math.max(0, dotPoint(previewVector, incomingDirection), dotPoint(previewVector, outgoingDirection))
  return distance > 1e-9 ? distance : null
}

export function chamferFeatureFromPoint(
  feature: SketchFeature,
  anchorIndex: number,
  previewPoint: Point,
): SketchFeature | null {
  const distance = chamferDistanceFromPoint(feature, anchorIndex, previewPoint)
  return distance ? chamferFeatureFromDistance(feature, anchorIndex, distance) : null
}

export function chamferFeatureFromDistance(
  feature: SketchFeature,
  anchorIndex: number,
  distance: number,
): SketchFeature | null {
  const profile = applyLineCornerChamfer(feature.sketch.profile, anchorIndex, distance)
  if (!profile) {
    return null
  }

  return {
    ...feature,
    kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(profile),
    sketch: {
      ...feature.sketch,
      profile,
    },
  }
}
