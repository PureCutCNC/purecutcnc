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

import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { getFeatureGeometryProfiles } from '../text'
import type { Project, SketchFeature, SketchProfile } from '../types/project'
import { closeLinePolygonIfNeeded, profileToPolygon } from './profilePolyline'
import type { ThreeThemePalette } from '../theme/palette'

export const LINE_DEFAULT_COLOR = 0x33aa66 // theme-exempt: legacy constant, prefer palette.lineDefault
export const LINE_SUBTRACT_COLOR = 0x3366cc // theme-exempt: legacy constant, prefer palette.lineSubtract

export interface BatchLineMeta {
  objectCount: number
  /** Source endpoint count; each rendered segment contributes two endpoints. */
  vertexCount: number
  segmentCount: number
}

export interface BatchLineResult {
  lines: LineSegments2[]
  meta: BatchLineMeta
}

export interface LineProfileEntry {
  profile: SketchProfile
  zTop: number
}

function featureZTop(feature: SketchFeature, project: Project): number {
  if (typeof feature.z_top === 'number') return feature.z_top
  const dimension = project.dimensions[feature.z_top]
  if (dimension) return dimension.value
  const parsed = Number.parseFloat(feature.z_top)
  return Number.isFinite(parsed) ? parsed : 0
}

function collectLineProfiles(
  project: Project,
  features: SketchFeature[],
): LineProfileEntry[] {
  const entries: LineProfileEntry[] = []
  for (const feature of features) {
    const zTop = featureZTop(feature, project)
    for (const profile of getFeatureGeometryProfiles(feature)) {
      if (feature.operation === 'line' || !profile.closed) {
        entries.push({ profile, zTop })
      }
    }
  }
  return entries
}

/**
 * Convert already-expanded profiles to independent segment endpoint pairs.
 * This seam keeps multi-profile text behavior directly testable without WebGL.
 */
export function computeLineProfileBatch(
  entries: LineProfileEntry[],
): { positions: number[]; segmentCount: number } {
  const positions: number[] = []
  let segmentCount = 0

  for (const { profile, zTop } of entries) {
    const polygon = closeLinePolygonIfNeeded(
      profileToPolygon(profile),
      profile.closed,
    )
    for (let index = 0; index < polygon.length - 1; index += 1) {
      const start = polygon[index]
      const end = polygon[index + 1]
      positions.push(start[0], zTop, start[1], end[0], zTop, end[1])
      segmentCount += 1
    }
  }

  return { positions, segmentCount }
}

/** Compute one independent-segment batch for all line-renderable profiles. */
export function computeLineBatch(
  project: Project,
  features: SketchFeature[],
): { positions: number[]; meta: BatchLineMeta } {
  const { positions, segmentCount } = computeLineProfileBatch(
    collectLineProfiles(project, features),
  )
  return {
    positions,
    meta: {
      objectCount: segmentCount > 0 ? 1 : 0,
      vertexCount: segmentCount * 2,
      segmentCount,
    },
  }
}

function viewportResolution(): THREE.Vector2 {
  if (typeof window === 'undefined') return new THREE.Vector2(1024, 768)
  return new THREE.Vector2(window.innerWidth, window.innerHeight)
}

function buildLineSegmentsBatch(
  project: Project,
  features: SketchFeature[],
  color: number,
): { line: LineSegments2 | null; meta: BatchLineMeta } {
  const { positions, meta } = computeLineBatch(project, features)
  if (meta.segmentCount === 0) return { line: null, meta }

  const geometry = new LineSegmentsGeometry()
  geometry.setPositions(positions)
  const material = new LineMaterial({
    color,
    linewidth: 4,
    worldUnits: false,
    resolution: viewportResolution(),
  })
  const line = new LineSegments2(geometry, material)
  line.computeLineDistances()
  return { line, meta }
}

/**
 * Build at most two draw objects: green for Line/non-subtract open geometry
 * and blue for open Subtract geometry. Closed solids remain outside overlays.
 */
export function buildBatchedLines(
  project: Project,
  visibleFeatures: SketchFeature[],
  threePalette: ThreeThemePalette,
): BatchLineResult {
  const defaultFeatures: SketchFeature[] = []
  const subtractFeatures: SketchFeature[] = []
  for (const feature of visibleFeatures) {
    if (feature.operation === 'subtract') subtractFeatures.push(feature)
    else defaultFeatures.push(feature)
  }

  const lines: LineSegments2[] = []
  let vertexCount = 0
  let segmentCount = 0
  for (const [features, color] of [
    [defaultFeatures, threePalette.lineDefault],
    [subtractFeatures, threePalette.lineSubtract],
  ] as const) {
    const batch = buildLineSegmentsBatch(project, features, color)
    if (batch.line) lines.push(batch.line)
    vertexCount += batch.meta.vertexCount
    segmentCount += batch.meta.segmentCount
  }

  return {
    lines,
    meta: { objectCount: lines.length, vertexCount, segmentCount },
  }
}

export function disposeBatchedLines(lines: LineSegments2[]): void {
  for (const line of lines) {
    line.geometry.dispose()
    line.material.dispose()
  }
}
