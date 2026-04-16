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
  inferFeatureKind,
  type FeatureOperation,
  type Point,
  type Project,
  type Segment,
  type SketchFeature,
  type SketchProfile,
} from '../types/project'
import type { ImportedShape } from './types'

const IMPORT_ORIENTATION_ANGLE = 90

export function stripFileExtension(fileName: string): string {
  const trimmed = fileName.trim()
  const dotIndex = trimmed.lastIndexOf('.')
  return dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed
}

export function uniqueName(preferred: string, existingNames: string[]): string {
  const base = preferred.trim() || 'Imported'
  if (!existingNames.includes(base)) {
    return base
  }

  let index = 2
  while (existingNames.includes(`${base} ${index}`)) {
    index += 1
  }
  return `${base} ${index}`
}

export function createImportedFeature(
  shape: ImportedShape,
  project: Project,
  folderId: string | null,
  preferredName: string,
  operation: FeatureOperation = 'subtract',
): SketchFeature {
  return {
    id: '',
    name: preferredName,
    kind: inferFeatureKind(shape.profile),
    folderId,
    sketch: {
      profile: shape.profile,
      origin: { x: 0, y: 0 },
      orientationAngle: IMPORT_ORIENTATION_ANGLE,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: project.stock.thickness,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

export function isProfileDegenerate(profile: SketchProfile, epsilon = 1e-9): boolean {
  if (profile.segments.length === 0) {
    return true
  }

  if (profile.segments.length === 1 && profile.segments[0].type === 'circle') {
    const seg = profile.segments[0]
    return Math.abs(profile.start.x - seg.center.x) <= epsilon && Math.abs(profile.start.y - seg.center.y) <= epsilon
  }

  const points = [profile.start, ...profile.segments.map((segment) => (segment as any).to)]
  return points.every((point) => Math.abs(point.x - points[0].x) <= epsilon && Math.abs(point.y - points[0].y) <= epsilon)
}

export interface AffineMatrix2D {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export function identityMatrix(): AffineMatrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
}

export function multiplyMatrix(left: AffineMatrix2D, right: AffineMatrix2D): AffineMatrix2D {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  }
}

export function applyMatrixToPoint(point: Point, matrix: AffineMatrix2D): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  }
}

export function transformProfile(profile: SketchProfile, matrix: AffineMatrix2D): SketchProfile {
  const transformPoint = (point: Point) => applyMatrixToPoint(point, matrix)
  const det = matrix.a * matrix.d - matrix.b * matrix.c
  const reflected = det < 0

  const segments: Segment[] = profile.segments.map((segment) => {
    if (segment.type === 'arc') {
      return {
        ...segment,
        to: transformPoint(segment.to),
        center: transformPoint(segment.center),
        clockwise: reflected ? !segment.clockwise : segment.clockwise,
      }
    }

    if (segment.type === 'bezier') {
      return {
        ...segment,
        to: transformPoint(segment.to),
        control1: transformPoint(segment.control1),
        control2: transformPoint(segment.control2),
      }
    }

    if (segment.type === 'circle') {
      return {
        ...segment,
        center: transformPoint(segment.center),
        to: transformPoint(segment.to),
      }
    }
    return {
      ...segment,
      to: transformPoint(segment.to),
    }
  })

  return {
    ...profile,
    start: transformPoint(profile.start),
    segments,
  }
}

