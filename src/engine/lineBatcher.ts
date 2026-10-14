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
import { isRoundStock } from '../types/project'
import type { Project, SketchFeature, SketchProfile } from '../types/project'
import { closeLinePolygonIfNeeded, profileToPolygon } from './profilePolyline'
import { aroundFrame, type AroundFrame } from './aroundFrame'
import type { ThreeThemePalette } from '../theme/palette'

export const LINE_DEFAULT_COLOR = 0x33aa66 // theme-exempt: legacy constant, prefer palette.lineDefault
export const LINE_SUBTRACT_COLOR = 0x3366cc // theme-exempt: legacy constant, prefer palette.lineSubtract

/** The most turn one drawn piece may span: 5°. */
const CHORD_STEP_RADIANS = (5 * Math.PI) / 180

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
  /**
   * Present for an Around feature (issue #395): its profile is in sheet
   * coordinates and its drawn points are wrapped onto the bar.
   */
  frame?: AroundFrame
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
  const around = isRoundStock(project.stock) ? aroundFrame(project.stock) : undefined
  for (const feature of features) {
    const zTop = featureZTop(feature, project)
    const frame = feature.authoringFace === 'around' ? around : undefined
    for (const profile of getFeatureGeometryProfiles(feature)) {
      if (feature.operation === 'line' || !profile.closed) {
        entries.push({ profile, zTop, frame })
      }
    }
  }
  return entries
}

/**
 * One wrapped line segment as a run of scene-space points (x, project z,
 * project y — the layout `computeLineProfileBatch` uses for flat entries): the
 * sheet point is wrapped onto the bar at `radius`, subdivided so no piece spans
 * more than 5° of turn. An Around line that runs 1.5 turns is drawn as 1.5
 * turns round the bar, because `a` is never reduced to one turn.
 */
function aroundSegmentPoints(
  start: [number, number],
  end: [number, number],
  frame: AroundFrame,
  radius: number,
): [number, number, number][] {
  const acrossFrom = frame.axis === 'x' ? start[1] : start[0]
  const acrossTo = frame.axis === 'x' ? end[1] : end[0]
  const divisions = Math.max(1, Math.ceil(Math.abs(acrossTo - acrossFrom) / (frame.radius * CHORD_STEP_RADIANS)))
  const points: [number, number, number][] = []
  for (let index = 0; index <= divisions; index += 1) {
    const t = index / divisions
    const x = start[0] + (end[0] - start[0]) * t
    const y = start[1] + (end[1] - start[1]) * t
    const across = frame.axis === 'x' ? y : x
    const along = frame.axis === 'x' ? x : y
    const angle = (across - frame.zero) / frame.radius
    const acrossOffset = radius * Math.sin(angle)
    const up = frame.radius + radius * Math.cos(angle)
    points.push(frame.axis === 'x'
      ? [along, up, frame.centre + acrossOffset]
      : [frame.centre + acrossOffset, up, along])
  }
  return points
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

  for (const { profile, zTop, frame } of entries) {
    const polygon = closeLinePolygonIfNeeded(
      profileToPolygon(profile),
      profile.closed,
    )
    for (let index = 0; index < polygon.length - 1; index += 1) {
      const start = polygon[index]
      const end = polygon[index + 1]
      if (!frame) {
        positions.push(start[0], zTop, start[1], end[0], zTop, end[1])
        segmentCount += 1
        continue
      }
      const points = aroundSegmentPoints(start, end, frame, zTop - frame.radius)
      for (let piece = 0; piece < points.length - 1; piece += 1) {
        const from = points[piece]
        const to = points[piece + 1]
        positions.push(from[0], from[1], from[2], to[0], to[1], to[2])
        segmentCount += 1
      }
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
