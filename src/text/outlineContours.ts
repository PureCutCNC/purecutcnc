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

import ClipperLib from 'clipper-lib'
import { DEFAULT_CLIPPER_SCALE } from '../engine/toolpaths/geometry'
import type { Point } from '../types/project'

const POINT_EPSILON = 1e-9
const SIGNIFICANT_CONTOUR_AREA_RATIO = 0.001

interface ClipperPoint {
  X: number
  Y: number
}

function pointsEqual(left: Point, right: Point): boolean {
  return Math.abs(left.x - right.x) < POINT_EPSILON && Math.abs(left.y - right.y) < POINT_EPSILON
}

function normalizeClosedPoints(points: Point[]): Point[] {
  const normalized = points.map((point) => ({ x: point.x, y: point.y }))
  if (normalized.length > 1 && pointsEqual(normalized[0], normalized[normalized.length - 1])) {
    normalized.pop()
  }
  return normalized
}

function signedArea(points: Point[]): number {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return area * 0.5
}

function toClipperPath(points: Point[]): ClipperPoint[] {
  return points.map((point) => ({
    X: Math.round(point.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE),
  }))
}

function fromClipperPath(path: ClipperPoint[]): Point[] {
  return path.map((point) => ({
    x: point.X / DEFAULT_CLIPPER_SCALE,
    y: point.Y / DEFAULT_CLIPPER_SCALE,
  }))
}

function uniqueClipperPointCount(path: ClipperPoint[]): number {
  return new Set(path.map((point) => `${point.X},${point.Y}`)).size
}

function restoreWinding(points: Point[], sourceArea: number, componentArea: number): Point[] {
  if (sourceArea === 0 || componentArea === 0 || Math.sign(sourceArea) === Math.sign(componentArea)) {
    return points
  }
  return [...points].reverse()
}

/**
 * Resolve self-intersections before applying the existing area cutoff.
 * Filtering the unsimplified loop cannot remove a tiny sliver attached to a
 * much larger contour, while keeping only the largest simplified component
 * would erase legitimate disconnected glyph geometry.
 */
export function cleanOutlineContour(points: Point[], size: number): Point[][] {
  const normalized = normalizeClosedPoints(points)
  const clipperPath = toClipperPath(normalized)
  if (uniqueClipperPointCount(clipperPath) < 3) {
    return []
  }

  const sourceArea = signedArea(normalized)
  const minimumArea = size * size * SIGNIFICANT_CONTOUR_AREA_RATIO
  const simplified = ClipperLib.Clipper.SimplifyPolygon(
    clipperPath,
    ClipperLib.PolyFillType.pftNonZero,
  )
  const cleaned: Point[][] = []

  for (const path of simplified) {
    if (uniqueClipperPointCount(path) < 3) {
      continue
    }
    const component = normalizeClosedPoints(fromClipperPath(path))
    const componentArea = signedArea(component)
    if (Math.abs(componentArea) <= minimumArea) {
      continue
    }
    cleaned.push(restoreWinding(component, sourceArea, componentArea))
  }

  return cleaned
}
