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

import type {
  DimensionRef,
  Operation,
  Point,
  Project,
  SketchFeature,
  SketchProfile,
  Tool,
} from '../../types/project'
import { sampleProfilePoints } from '../../types/project'
import { convertToolUnits } from '../../utils/units'
import type {
  ClipperPath,
  FlattenedPath,
  NormalizedTool,
  ResolvedFeatureZSpan,
  ResolvedToolpathOperation,
} from './types'

export const DEFAULT_CLIPPER_SCALE = 10_000

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y }
}

export function resolveDimensionRef(project: Project, value: DimensionRef): number {
  if (typeof value === 'number') {
    return value
  }
  const named = project.dimensions[value]
  if (!named) {
    throw new Error(`Unknown dimension reference: ${value}`)
  }
  return named.value
}

export function resolveFeatureZSpan(project: Project, feature: SketchFeature): ResolvedFeatureZSpan {
  const top = resolveDimensionRef(project, feature.z_top)
  const bottom = resolveDimensionRef(project, feature.z_bottom)
  const min = Math.min(top, bottom)
  const max = Math.max(top, bottom)
  return {
    top,
    bottom,
    min,
    max,
    height: max - min,
  }
}

export function normalizeToolForProject(tool: Tool, project: Project): NormalizedTool {
  const normalizedTool = tool.units === project.meta.units ? tool : convertToolUnits(tool, project.meta.units)
  return {
    id: tool.id,
    name: tool.name,
    sourceUnits: tool.units,
    units: project.meta.units,
    type: normalizedTool.type,
    diameter: normalizedTool.diameter,
    radius: normalizedTool.diameter / 2,
    vBitAngle: normalizedTool.type === 'v_bit' ? normalizedTool.vBitAngle ?? 60 : null,
    flutes: normalizedTool.flutes,
    material: normalizedTool.material,
    defaultRpm: normalizedTool.defaultRpm,
    defaultFeed: normalizedTool.defaultFeed,
    defaultPlungeFeed: normalizedTool.defaultPlungeFeed,
    defaultStepdown: normalizedTool.defaultStepdown,
    defaultStepover: normalizedTool.defaultStepover,
    maxCutDepth: normalizedTool.maxCutDepth,
  }
}

export function resolveOperationTool(project: Project, operation: Operation): ResolvedToolpathOperation {
  const tool = operation.toolRef ? project.tools.find((c) => c.id === operation.toolRef) ?? null : null
  return {
    operation,
    tool: tool ? normalizeToolForProject(tool, project) : null,
    units: project.meta.units,
  }
}

export function flattenProfile(profile: SketchProfile, curveSamples = 24, arcStepRadians = Math.PI / 36): FlattenedPath {
  const sampled = sampleProfilePoints(profile, curveSamples, arcStepRadians)
  return {
    points: sampled.map(clonePoint),
    closed: profile.closed,
  }
}

export function ensureClosedPath(points: Point[]): Point[] {
  if (points.length === 0) return []
  const first = points[0]
  const last = points[points.length - 1]
  if (first.x === last.x && first.y === last.y) return points.map(clonePoint)
  return [...points.map(clonePoint), clonePoint(first)]
}

export function signedArea(points: Point[]): number {
  if (points.length < 3) return 0
  let area = 0
  const closed = ensureClosedPath(points)
  for (let i = 0; i < closed.length - 1; i++) {
    const a = closed[i]
    const b = closed[i + 1]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

export function isClockwise(points: Point[]): boolean {
  return signedArea(points) < 0
}

export function normalizeWinding(points: Point[], wantClockwise: boolean): Point[] {
  const closed = ensureClosedPath(points)
  const alreadyClockwise = isClockwise(closed)
  if (alreadyClockwise === wantClockwise) return closed
  const reversed = [...closed].reverse()
  const first = reversed[0]
  const last = reversed[reversed.length - 1]
  if (first.x !== last.x || first.y !== last.y) {
    reversed.push({ x: first.x, y: first.y })
  }
  return reversed
}

export function applyContourDirection(contours: Point[][], direction: 'conventional' | 'climb' = 'conventional'): Point[][] {
  // Conventional = no-op: Clipper's natural output is CCW in machine Y-up (isClockwise=false),
  // which equals conventional direction for inside/pocket cuts.  For outside edge cuts the
  // caller must invert the direction before calling here (CCW = climb for outside cuts).
  // Climb simply reverses each contour.
  if (direction === 'conventional') {
    return contours
  }
  return contours.map((c) => normalizeWinding(c, !isClockwise(c)))
}

/**
 * Apply cut direction to a mix of outer-of-region and hole-of-region contours
 * where the tool's relationship to the contour differs per ring.
 *
 * `outerRingRole` describes whether the OUTER (CCW) rings have the tool on the
 * inside (e.g. roughing's clearable polygon — pocket-like) or on the outside
 * (e.g. waterline's offset-shadow — around-the-bump). HOLE rings (CW) get the
 * opposite role automatically within the same call.
 *
 * Why this exists: the simpler `applyContourDirection` assumes all contours
 * share one role (tool-inside) and lets the caller pre-invert direction for
 * tool-outside cases. That doesn't work when one set of contours mixes both
 * roles, as waterline rings do (outer ring around model, hole rings inside
 * pockets). This helper classifies per contour by natural winding and picks
 * the winding that produces the requested cut direction.
 *
 * Open polylines (e.g. closed contours clipped by a tab/clamp/add-feature
 * into segments) inherit the parent ring's traversal order. They are direction-
 * adjusted by reversing the point order when natural ≠ desired. Winding is
 * inferred from the polyline's signed area; for fragments that are tiny or
 * nearly straight this is ambiguous, so callers can pass an explicit per-
 * contour `naturalIsClockwise` hint via `closed`.
 */
export function applyContourDirectionBySide(
  contours: Point[][],
  direction: 'conventional' | 'climb' = 'conventional',
  outerRingRole: 'tool-inside' | 'tool-outside' = 'tool-inside',
  closed?: boolean[],
  naturalIsClockwise?: boolean[],
  toolInsidePerContour?: boolean[],
): Point[][] {
  return contours.map((c, i) => {
    if (c.length < 2) return c
    const isClosed = closed ? closed[i] : c.length >= 3

    // Determine tool-inside / tool-outside topology for THIS contour.
    //
    // Preferred: the caller has classified by an external geometric test
    // (e.g., is the ring's centroid inside the slice material?). That is
    // always more reliable than inferring from winding because Clipper's
    // open-path difference can flip closed-ring traversal direction even
    // when it doesn't actually clip the ring.
    //
    // Fallback: infer from winding combined with `outerRingRole`.
    const outerToolInside = outerRingRole === 'tool-inside'
    let toolInside: boolean
    if (toolInsidePerContour && i < toolInsidePerContour.length && toolInsidePerContour[i] !== undefined) {
      toolInside = toolInsidePerContour[i]
    } else {
      // Pick a winding source: actual signed area for closed contours
      // (definitive), hint for open polylines (signed area on a fragment is
      // ambiguous), and signed area as the last-resort fallback.
      const clockwiseHint = naturalIsClockwise ? naturalIsClockwise[i] : null
      const clockwise = isClosed
        ? isClockwise(c)
        : (clockwiseHint !== null && clockwiseHint !== undefined
            ? clockwiseHint
            : isClockwise(c))
      toolInside = clockwise ? !outerToolInside : outerToolInside
    }

    // Decide the WINDING the output should have to honor the user's setting.
    //   tool-inside  + climb       => CW
    //   tool-inside  + conventional=> CCW
    //   tool-outside + climb       => CCW
    //   tool-outside + conventional=> CW
    const wantClimb = direction === 'climb'
    const wantClockwise = toolInside ? wantClimb : !wantClimb

    if (isClosed) {
      return normalizeWinding(c, wantClockwise)
    }
    // Open polyline: ensure traversal order matches the desired winding.
    // For closed-ring-fragments, signed area on the fragment is ambiguous;
    // use the hint if provided to know whether the current order matches
    // the source ring's natural winding.
    const clockwiseHint = naturalIsClockwise ? naturalIsClockwise[i] : null
    const currentClockwise = clockwiseHint !== null && clockwiseHint !== undefined
      ? clockwiseHint
      : isClockwise(c)
    if (currentClockwise === wantClockwise) return c
    return [...c].reverse()
  })
}

export function toClipperPath(points: Point[], scale = DEFAULT_CLIPPER_SCALE): ClipperPath {
  return ensureClosedPath(points).map((p) => ({ X: Math.round(p.x * scale), Y: Math.round(p.y * scale) }))
}

export function fromClipperPath(path: ClipperPath, scale = DEFAULT_CLIPPER_SCALE): Point[] {
  return path.map((p) => ({ x: p.X / scale, y: p.Y / scale }))
}

export function checkMaxCutDepthWarning(tool: NormalizedTool, cutDepth: number): string | null {
  if (tool.maxCutDepth > 0 && cutDepth > tool.maxCutDepth) {
    return `Cut depth ${cutDepth.toFixed(3)} ${tool.units} exceeds tool max cut depth ${tool.maxCutDepth.toFixed(3)} ${tool.units}`
  }
  return null
}

export function getOperationClearance(project: Project): number {
  return Math.max(0, project.meta.operationClearanceZ)
}

export function getOperationSafeZ(project: Project, featureSpans: ResolvedFeatureZSpan[] = []): number {
  const highestFeatureZ = featureSpans.reduce((h, span) => Math.max(h, span.max), 0)
  const stockTop = project.stock.thickness
  return Math.max(stockTop, highestFeatureZ) + getOperationClearance(project)
}
