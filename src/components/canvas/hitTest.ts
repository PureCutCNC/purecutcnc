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

import { rectProfile, sampleProfilePoints } from '../../types/project'
import type { Clamp, Point, SketchFeature, SketchProfile, Tab } from '../../types/project'
import type { CanvasPoint, ViewTransform } from './viewTransform'

export function pointInProfile(x: number, y: number, profile: SketchProfile): boolean {
  if (!profile.closed) {
    return false
  }

  const points = sampleProfilePoints(profile)
  if (points.length < 3) return false

  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i].x
    const yi = points[i].y
    const xj = points[j].x
    const yj = points[j].y

    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }

  return inside
}

function distancePointToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    return Math.hypot(point.x - start.x, point.y - start.y)
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)))
  const projection = {
    x: start.x + dx * t,
    y: start.y + dy * t,
  }
  return Math.hypot(point.x - projection.x, point.y - projection.y)
}

export function pointNearProfile(worldPoint: Point, profile: SketchProfile, vt: ViewTransform, tolerancePx = 8): boolean {
  const points = sampleProfilePoints(profile)
  if (points.length < 2) {
    return false
  }

  const toleranceWorld = tolerancePx / Math.max(vt.scale, 1e-6)
  const segmentCount = profile.closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (distancePointToSegment(worldPoint, start, end) <= toleranceWorld) {
      return true
    }
  }

  return false
}

export function findHitFeatureId(worldPoint: Point, features: SketchFeature[], vt: ViewTransform): string | null {
  for (let index = features.length - 1; index >= 0; index -= 1) {
    const feature = features[index]
    if (!feature.visible) continue
    if (
      pointInProfile(worldPoint.x, worldPoint.y, feature.sketch.profile)
      || pointNearProfile(worldPoint, feature.sketch.profile, vt)
    ) {
      return feature.id
    }
  }
  return null
}

function pointInRect(point: Point, minX: number, minY: number, maxX: number, maxY: number): boolean {
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY
}

export function featureFullyInsideRect(feature: SketchFeature, minX: number, minY: number, maxX: number, maxY: number): boolean {
  const points = sampleProfilePoints(feature.sketch.profile)
  if (points.length === 0) {
    return false
  }

  return points.every((point) => pointInRect(point, minX, minY, maxX, maxY))
}

export function findHitClampId(worldPoint: Point, clamps: Clamp[]): string | null {
  for (let index = clamps.length - 1; index >= 0; index -= 1) {
    const clamp = clamps[index]
    if (!clamp.visible) continue
    if (pointInProfile(worldPoint.x, worldPoint.y, rectProfile(clamp.x, clamp.y, clamp.w, clamp.h))) {
      return clamp.id
    }
  }
  return null
}

export function findHitTabId(worldPoint: Point, tabs: Tab[]): string | null {
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index]
    if (!tab.visible) continue
    if (pointInProfile(worldPoint.x, worldPoint.y, rectProfile(tab.x, tab.y, tab.w, tab.h))) {
      return tab.id
    }
  }
  return null
}

export function distance2(a: CanvasPoint, b: CanvasPoint): number {
  const dx = a.cx - b.cx
  const dy = a.cy - b.cy
  return dx * dx + dy * dy
}

export function pointsEqual(a: Point, b: Point, epsilon = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon
}
