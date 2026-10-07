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

/**
 * How far an operation actually reaches into the stock, and whether a
 * through-feature cut from both setups is cut all the way (issue #946).
 *
 * Depths are entered from the face a setup turns up, so two operations on the
 * same through-feature — one from Top, one from Bottom — are easy to leave
 * short of each other. This module answers in stock Z, the one frame both
 * share:
 *
 * - `operationCutRange` — the stock-Z range an operation cuts at one feature;
 * - `throughFeatureCoverage` — for a through-feature targeted from both
 *   faces, whether the range cut from Top and the range cut from Bottom meet.
 *
 * Both read the **generated toolpath**, not the operation's settings: the
 * range is where the cutter went, so a depth clamped by the tool, raised by a
 * tab or left short by stock-to-leave is reported as it will be cut. Nothing
 * here is inferred. Without a toolpath for every operation involved the
 * answer is "unverified", and only ranges that were measured and found to
 * meet are ever reported as meeting.
 *
 * The range is the travel of the **tool tip**, which is the depth the
 * generators themselves work to. For a flat end mill that is the depth cut
 * across the whole tool; a drill point, ball or V-bit is narrower than the
 * tool at its tip, so material can remain beside the tip at the reported
 * depth.
 */

import type { Operation, Project, SetupFace } from '../types/project'
import { resolveFeatureInstances } from '../store/helpers/resolveFeatures'
import { normalizeToolForProject } from './toolpaths/geometry'
import type { ToolpathResult } from './toolpaths/types'
import { isThroughFeature, operationFace } from './setupTargets'
import { cutMoveZAtFeature, featureReachFootprint } from './setupReachGeometry'

/** A range of stock Z: 0 at the stock's bottom face, `thickness` at its top face. */
export interface StockZRange {
  min: number
  max: number
}

/** Ranges closer than this, in project units, count as touching. */
export const REACH_TOLERANCE = 1e-6

/**
 * The stock-Z range an operation cuts at one of its target features, read
 * from its generated toolpath, or null when it cuts nothing there.
 *
 * An operation cuts from the face its setup turns up, and a 3-axis cutter
 * removes everything between that face and its tip: from Top the range runs
 * from the deepest tip position up to the top face, from Bottom from the
 * bottom face up to the highest tip position. Only feeding moves count, and
 * only the portions intersecting the resolved target geometry expanded by the
 * cutter's radius. Curves and rounded offsets reserve approximation error,
 * so ambiguous boundary contact is not presented as verified reach. For
 * pointed/ball tools only the tip centre is credited at its deepest Z.
 * This measures intersecting tip depths, not complete area removal (#947).
 */
export function operationCutRange(
  project: Project,
  operation: Operation,
  toolpath: Pick<ToolpathResult, 'moves'>,
  featureId: string,
): StockZRange | null {
  const [feature] = resolveFeatureInstances(project, [featureId])
  if (!feature) return null
  const toolRecord = project.tools.find((tool) => tool.id === operation.toolRef)
  const tool = toolRecord ? normalizeToolForProject(toolRecord, project) : null
  const radius = tool?.type === 'flat_endmill' || tool?.type === 'plasma' ? tool.radius : 0
  const footprint = featureReachFootprint(feature, radius)
  const thickness = project.stock.thickness
  const face: SetupFace = operationFace(project, operation)

  let reached: number | null = null
  for (const move of toolpath.moves) {
    for (const z of cutMoveZAtFeature(footprint, move)) {
      // Above the face that is up the cutter is in air.
      if (face === 'top' ? z >= thickness : z <= 0) continue
      reached = reached === null ? z : face === 'top' ? Math.min(reached, z) : Math.max(reached, z)
    }
  }
  if (reached === null) return null
  return face === 'top'
    ? { min: Math.max(reached, 0), max: thickness }
    : { min: 0, max: Math.min(reached, thickness) }
}

export type ThroughCoverageStatus =
  /** Targeted from one face only: there are no two ranges to compare. */
  | 'singleSide'
  /** Targeted from both faces, but an operation has no toolpath to measure. */
  | 'unverified'
  /** The measured ranges leave material between them. */
  | 'gap'
  /** The measured ranges meet or overlap. */
  | 'meets'

/** What the operations of one face cut at a feature. */
export interface FaceReach {
  /** The enabled operations of this face that target the feature, in project order. */
  operationIds: string[]
  /** Their combined range; null when none of them cuts there, or one is unmeasured. */
  range: StockZRange | null
}

export interface ThroughFeatureCoverage {
  featureId: string
  status: ThroughCoverageStatus
  top: FaceReach
  bottom: FaceReach
  /** How far the two ranges overlap, when they meet (0 when they just touch). */
  overlap: number | null
  /** The material left between the two ranges, when they do not meet. */
  gap: number | null
}

/**
 * For a through-feature, whether the operations cutting it from Top and from
 * Bottom reach each other. `toolpaths` holds the generated result of each
 * operation that has one, by operation id.
 *
 * Returns null for a feature that is not a through-feature or is not targeted
 * at all. Disabled operations are ignored: they are not cut.
 *
 * A side whose operations were all measured and cut nothing at the feature
 * counts as reaching nothing, so the result is a gap the full width of what
 * the other side left — never "meets".
 */
export function throughFeatureCoverage(
  project: Project,
  featureId: string,
  toolpaths: ReadonlyMap<string, Pick<ToolpathResult, 'moves'>>,
): ThroughFeatureCoverage | null {
  const feature = project.features.find((entry) => entry.id === featureId)
  if (!feature || !isThroughFeature(project, feature)) return null

  const operations = project.operations.filter((operation) => (
    operation.enabled
    && operation.target.source === 'features'
    && operation.target.featureIds.includes(featureId)
  ))
  if (operations.length === 0) return null

  const thickness = project.stock.thickness
  const sides: Record<SetupFace, { operationIds: string[]; ranges: Array<StockZRange | null>; measured: boolean }> = {
    top: { operationIds: [], ranges: [], measured: true },
    bottom: { operationIds: [], ranges: [], measured: true },
  }
  for (const operation of operations) {
    const side = sides[operationFace(project, operation)]
    side.operationIds.push(operation.id)
    const toolpath = toolpaths.get(operation.id)
    if (!toolpath) {
      side.measured = false
      continue
    }
    side.ranges.push(operationCutRange(project, operation, toolpath, featureId))
  }

  const combined = (face: SetupFace): StockZRange | null => {
    const ranges = sides[face].ranges.filter((range): range is StockZRange => range !== null)
    if (!sides[face].measured || ranges.length === 0) return null
    return face === 'top'
      ? { min: Math.min(...ranges.map((range) => range.min)), max: thickness }
      : { min: 0, max: Math.max(...ranges.map((range) => range.max)) }
  }
  const top: FaceReach = { operationIds: sides.top.operationIds, range: combined('top') }
  const bottom: FaceReach = { operationIds: sides.bottom.operationIds, range: combined('bottom') }
  const base = { featureId, top, bottom }

  if (top.operationIds.length === 0 || bottom.operationIds.length === 0) {
    return { ...base, status: 'singleSide', overlap: null, gap: null }
  }
  if (!sides.top.measured || !sides.bottom.measured) {
    return { ...base, status: 'unverified', overlap: null, gap: null }
  }

  // A measured side that cut nothing reaches no further than its own face.
  const topReach = top.range?.min ?? thickness
  const bottomReach = bottom.range?.max ?? 0
  const overlap = bottomReach - topReach
  return overlap >= -REACH_TOLERANCE
    ? { ...base, status: 'meets', overlap: Math.max(overlap, 0), gap: null }
    : { ...base, status: 'gap', overlap: null, gap: -overlap }
}
