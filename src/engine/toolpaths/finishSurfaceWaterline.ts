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
import type { CutDirection, Operation, Project, SketchFeature } from '../../types/project'
import {
  DEFAULT_CLIPPER_SCALE,
  applyContourDirection,
  checkMaxCutDepthWarning,
  normalizeWinding,
  toClipperPath,
} from './geometry'
import { getMeshSliceIndex, sliceMeshAtZ } from './meshSlicing'
import {
  buildProtectedFootprintPaths,
  clipperPathsToPointContours,
  differenceClipperPaths,
  offsetClipperPaths,
  unionClipperPaths,
} from './modelProtection'
import { contourStartPoint, toClosedCutMoves, transitionToCutEntry } from './pocket'
import { buildRegionMask, clipToolpathResultToRegionMask } from './regions'
import type { ClipperPath, NormalizedTool, ToolpathMove, ToolpathPoint } from './types'

const MIN_Z_STEP = 0.01

function slicePolygonsToClipperPaths(slicePolygons: Array<Array<[number, number]>>): ClipperPath[] {
  return slicePolygons
    .filter((poly) => poly.length >= 3)
    .map((poly) => toClipperPath(
      normalizeWinding(poly.map(([x, y]) => ({ x, y })), false),
      DEFAULT_CLIPPER_SCALE,
    ))
}

export function maxContourGap(pathsA: ClipperPath[], pathsB: ClipperPath[]): number {
  if (pathsA.length === 0 && pathsB.length === 0) return 0

  const clipper = new ClipperLib.Clipper()
  if (pathsA.length > 0) clipper.AddPaths(pathsA, ClipperLib.PolyType.ptSubject, true)
  if (pathsB.length > 0) clipper.AddPaths(pathsB, ClipperLib.PolyType.ptClip, true)
  const xorResult = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctXor,
    xorResult,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )

  if (xorResult.length === 0) return 0

  let maxWidth = 0
  for (const path of xorResult as ClipperPath[]) {
    if (path.length < 3) continue
    const area = Math.abs(ClipperLib.Clipper.Area(path))
    const perimeter = ClipperLib.JS.PerimeterOfPath(path, true, 1)
    if (perimeter > 0) {
      const width = (2 * area) / perimeter / DEFAULT_CLIPPER_SCALE
      if (width > maxWidth) maxWidth = width
    }
  }

  return maxWidth
}

interface WaterlineLevel {
  z: number
  contourPaths: ClipperPath[]
}

interface WaterlineRing {
  z: number
  contourPaths: ClipperPath[]
}

function pointDistance3D(a: ToolpathPoint, b: ToolpathPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function movesAreContiguous(a: ToolpathMove, b: ToolpathMove, epsilon: number): boolean {
  return pointDistance3D(a.to, b.from) <= epsilon
}

function movesAreCollinear3D(a: ToolpathMove, b: ToolpathMove, epsilon: number): boolean {
  const ax = a.to.x - a.from.x
  const ay = a.to.y - a.from.y
  const az = a.to.z - a.from.z
  const bx = b.to.x - b.from.x
  const by = b.to.y - b.from.y
  const bz = b.to.z - b.from.z

  const aLen = Math.hypot(ax, ay, az)
  const bLen = Math.hypot(bx, by, bz)
  if (aLen <= epsilon || bLen <= epsilon) return true

  const crossX = ay * bz - az * by
  const crossY = az * bx - ax * bz
  const crossZ = ax * by - ay * bx
  const crossLen = Math.hypot(crossX, crossY, crossZ)
  const normalizedCross = crossLen / (aLen * bLen)
  if (normalizedCross > 1e-4) return false

  const dot = ax * bx + ay * by + az * bz
  return dot >= -epsilon
}

function simplifyContiguousCutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  if (moves.length < 2) return moves
  const epsilon = 1e-6
  const simplified: ToolpathMove[] = []

  for (const move of moves) {
    if (move.kind === 'cut' && pointDistance3D(move.from, move.to) <= epsilon) {
      continue
    }

    const last = simplified[simplified.length - 1]
    if (
      last
      && last.kind === 'cut'
      && move.kind === 'cut'
      && movesAreContiguous(last, move, epsilon)
      && movesAreCollinear3D(last, move, epsilon)
      && last.source === move.source
    ) {
      last.to = move.to
      continue
    }

    simplified.push({
      kind: move.kind,
      from: { ...move.from },
      to: { ...move.to },
      source: move.source,
    })
  }

  return simplified
}

export function generateFinishSurfaceWaterline(
  project: Project,
  operation: Operation,
  regionFeatures: SketchFeature[],
  tool: NormalizedTool,
  stepLevels: number[],
  stlData: { positions: Float32Array; index: Uint32Array; sliceIndex?: unknown },
  safeZ: number,
  effectiveBottom: number,
  modelTopZ: number,
  warnings: string[],
): { moves: ToolpathMove[]; stepLevels: Set<number> } {
  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const toolOffset = tool.radius + radialLeave
  const direction: CutDirection = operation.cutDirection ?? 'conventional'
  const stepoverRatio = operation.stepover ?? 0.5
  const stepoverDistance = Math.max(stepoverRatio * tool.diameter, MIN_Z_STEP)

  const regionMask = buildRegionMask(regionFeatures)
  const sliceIndex = getMeshSliceIndex(stlData as Parameters<typeof getMeshSliceIndex>[0])
  const sliceSampleEpsilon = Math.max(Math.abs(modelTopZ - effectiveBottom) * 1e-6, 1e-6)

  const targetFeatureIds = new Set(
    operation.target.source === 'features' ? operation.target.featureIds : [],
  )

  if (operation.debugToolpath) {
    warnings.push(
      `Debug: waterline mode, stepover=${stepoverDistance.toFixed(4)}, toolOffset=${toolOffset.toFixed(4)}`,
    )
  }

  const sliceAtZ = (z: number): ClipperPath[] => {
    const clampedZ = z >= modelTopZ - sliceSampleEpsilon
      ? Math.max(effectiveBottom + sliceSampleEpsilon, modelTopZ - sliceSampleEpsilon)
      : z
    const polygons = sliceMeshAtZ(sliceIndex, clampedZ)
    if (polygons.length === 0) return []
    return unionClipperPaths(slicePolygonsToClipperPaths(polygons))
  }

  const coarseLevels: WaterlineLevel[] = []
  {
    let shadow: ClipperPath[] = []
    for (const z of stepLevels) {
      const slice = sliceAtZ(z)
      if (slice.length > 0) {
        shadow = shadow.length === 0
          ? slice
          : unionClipperPaths([...shadow, ...slice])
      }
      coarseLevels.push({
        z,
        contourPaths: shadow.length > 0 ? offsetClipperPaths(shadow, toolOffset) : [],
      })
    }
  }

  const allRings: WaterlineRing[] = []
  for (const level of coarseLevels) {
    if (level.contourPaths.length === 0) continue
    allRings.push({
      z: level.z,
      contourPaths: level.contourPaths,
    })
  }

  allRings.sort((a, b) => b.z - a.z)

  const machiningEnvelopePaths = unionClipperPaths(
    coarseLevels.flatMap((level) => level.contourPaths),
  )
  const protectedPathsByZ = new Map<string, ClipperPath[]>()
  const protectedPathsAtZ = (z: number): ClipperPath[] => {
    const key = z.toFixed(6)
    const cached = protectedPathsByZ.get(key)
    if (cached) return cached

    const paths = buildProtectedFootprintPaths(project, {
      targetFeatureIds,
      z,
      featureExpansion: toolOffset,
      tabExpansion: tool.radius,
      clampExpansion: tool.radius,
      includeTabs: false,
      machiningEnvelopePaths: machiningEnvelopePaths.length > 0 ? machiningEnvelopePaths : undefined,
    })
    protectedPathsByZ.set(key, paths)
    return paths
  }

  if (operation.debugToolpath) {
    warnings.push(
      `Debug: ${coarseLevels.length} coarse levels → ${allRings.length} total rings`,
    )
  }

  const allMoves: ToolpathMove[] = []
  const allStepLevels = new Set<number>()
  let currentPosition: ToolpathPoint | null = null

  const depthWarning = checkMaxCutDepthWarning(tool, Math.abs(modelTopZ - effectiveBottom))
  if (depthWarning) warnings.push(depthWarning)

  for (const ring of allRings) {
    let contourPaths = ring.contourPaths
    if (contourPaths.length === 0) continue

    const protectionQueryZ = ring.z
    const protectedAtLevel = protectedPathsAtZ(protectionQueryZ)
    if (protectedAtLevel.length > 0) {
      contourPaths = differenceClipperPaths(contourPaths, protectedAtLevel)
    }

    if (contourPaths.length === 0) continue

    const pointContours = clipperPathsToPointContours(contourPaths)
    const directedContours = applyContourDirection(pointContours, direction)

    for (const contour of directedContours) {
      if (contour.length < 3) continue

      const cutZ = ring.z
      allStepLevels.add(cutZ)
      const entry = contourStartPoint(contour, cutZ)
      currentPosition = transitionToCutEntry(allMoves, currentPosition, entry, safeZ, 0)
      allMoves.push(...simplifyContiguousCutMoves(toClosedCutMoves(contour, cutZ)))
      currentPosition = { x: contour[0].x, y: contour[0].y, z: cutZ }
    }
  }

  const regionClipped = clipToolpathResultToRegionMask(project, {
    operationId: operation.id,
    moves: allMoves,
    warnings: [],
    bounds: null,
  }, regionMask)
  if (regionClipped.warnings.length > 0) {
    warnings.push(...regionClipped.warnings)
  }

  const finalStepLevels = new Set<number>()
  for (const move of regionClipped.moves) {
    if (move.kind !== 'cut') continue
    finalStepLevels.add(move.from.z)
    finalStepLevels.add(move.to.z)
  }

  return {
    moves: regionClipped.moves,
    stepLevels: finalStepLevels.size > 0 ? finalStepLevels : allStepLevels,
  }
}
