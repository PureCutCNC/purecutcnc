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

import type { ToolLibraryEntry } from '../../../toolLibrary'
import type { OperationKind, OperationTarget, Project, Tool } from '../../../types/project'
import { convertLength } from '../../../utils/units'
import { HELICAL_BORE_MAX_HOLE_TO_TOOL_RATIO } from '../../toolpaths/drilling'
import { AUTO_TOOL_MAX_DIAMETER_INCH, autoToolDiameterLimit, capAutoToolDiameter, preferredToolTypes, targetFeatureSize, toolInUnits } from '../toolSelection'
import type { CamPlanTool } from './types'

export const CAM_PLAN_FINISH_REST_TOOL_FRACTION = 0.5
export const CAM_PLAN_ROUGH_STOCK_TO_LEAVE_INCH = 0.005
export const CAM_PLAN_HELICAL_BORE_FRACTION = 0.8
export const CAM_PLAN_DRILL_DIAMETER_TOLERANCE = 0.02

export function camPlanRoughStockToLeave(units: Tool['units']): number {
  return convertLength(CAM_PLAN_ROUGH_STOCK_TO_LEAVE_INCH, 'inch', units)
}

function libraryTool(entry: ToolLibraryEntry): CamPlanTool {
  return {
    id: `cam-plan-tool:${entry.key}`,
    source: 'library',
    libraryKey: entry.key,
    tool: { ...entry, id: `cam-plan-tool:${entry.key}` },
  }
}

export function camPlanToolPool(project: Project, libraryTools: ToolLibraryEntry[]): CamPlanTool[] {
  // The plan picks and imports only tools written in the project's units, the
  // same rule the Add-operation path follows (issue #1132). A project tool in
  // the other unit system stays assignable by hand but is never a candidate,
  // and a library entry in it is never imported by conversion.
  const units = project.meta.units
  const existing = project.tools
    .filter((tool) => toolInUnits(tool, units))
    .map((tool) => ({
      id: tool.id,
      source: 'existing' as const,
      tool,
    }))
  const imported = libraryTools
    .filter((entry) => toolInUnits(entry, units))
    .map((entry) => libraryTool(entry))
  return [...existing, ...imported]
}

function toolCanReach(tool: Tool, requiredDepth: number): boolean {
  return tool.maxCutDepth <= 0 || tool.maxCutDepth + 1e-9 >= requiredDepth
}

function toolTypeRank(kind: OperationKind, tool: Tool): number {
  const preferred = preferredToolTypes(kind)
  const index = preferred.indexOf(tool.type)
  return index < 0 ? Number.POSITIVE_INFINITY : index
}

function compareTools(kind: OperationKind, reusedToolIds: ReadonlySet<string>) {
  return (a: CamPlanTool, b: CamPlanTool): number => {
    const typeDelta = toolTypeRank(kind, a.tool) - toolTypeRank(kind, b.tool)
    if (typeDelta !== 0) return typeDelta
    const existingDelta = Number(b.source === 'existing') - Number(a.source === 'existing')
    if (existingDelta !== 0) return existingDelta
    const reusedDelta = Number(reusedToolIds.has(b.id)) - Number(reusedToolIds.has(a.id))
    if (reusedDelta !== 0) return reusedDelta
    const diameterDelta = b.tool.diameter - a.tool.diameter
    if (Math.abs(diameterDelta) > 1e-9) return diameterDelta
    return a.tool.name.localeCompare(b.tool.name) || a.id.localeCompare(b.id)
  }
}

export interface RankedCamPlanTools {
  tools: CamPlanTool[]
  maximumDiameter: number | null
}

/**
 * A finish-rest cutter must reach substantially tighter geometry than the
 * primary cutter. Limiting it to half the primary diameter avoids a nearly
 * duplicate pass that cannot clear the corners or narrow channels the first
 * cutter left behind.
 */
export function materiallySmallerCamPlanTools(
  source: CamPlanTool,
  candidates: CamPlanTool[],
): CamPlanTool[] {
  return candidates.filter((candidate) =>
    candidate.tool.diameter <= source.tool.diameter * CAM_PLAN_FINISH_REST_TOOL_FRACTION + 1e-9,
  )
}

export function rankCamPlanTools(
  project: Project,
  kind: OperationKind,
  target: OperationTarget,
  pool: CamPlanTool[],
  requiredDepth: number,
  reusedToolIds: ReadonlySet<string>,
  maximumDiameterOverride?: number | null,
): RankedCamPlanTools {
  const diameterLimit = maximumDiameterOverride != null
    ? capAutoToolDiameter(kind, project.meta.units, maximumDiameterOverride)
    : autoToolDiameterLimit(project, kind, target)
  const tools = pool
    .filter((candidate) => Number.isFinite(toolTypeRank(kind, candidate.tool)))
    .filter((candidate) => candidate.tool.diameter > 0)
    .filter((candidate) => diameterLimit == null || candidate.tool.diameter <= diameterLimit + 1e-9)
    .filter((candidate) => toolCanReach(candidate.tool, requiredDepth))
    .sort(compareTools(kind, reusedToolIds))

  return { tools, maximumDiameter: diameterLimit }
}

export type Drillability =
  | { tool: CamPlanTool; drillType: 'simple' | 'helical'; options: CamPlanTool[] }
  | null

export function chooseDrillingTool(
  project: Project,
  target: OperationTarget,
  pool: CamPlanTool[],
  requiredDepth: number,
  reusedToolIds: ReadonlySet<string>,
): Drillability {
  const holeDiameter = targetFeatureSize(project, target)
  if (holeDiameter == null) return null
  const ranked = rankCamPlanTools(project, 'drilling', target, pool, requiredDepth, reusedToolIds).tools
  const matchingDrill = ranked.find((candidate) =>
    candidate.tool.type === 'drill'
    && Math.abs(candidate.tool.diameter - holeDiameter) <= holeDiameter * CAM_PLAN_DRILL_DIAMETER_TOLERANCE,
  )
  if (matchingDrill) return { tool: matchingDrill, drillType: 'simple', options: ranked }

  // A helical bore needs an endmill small enough to orbit, big enough that the
  // generator will not refuse the hole, and within the same auto-pick ceiling
  // as the pocket that would otherwise clear it.
  const helicalCeiling = convertLength(AUTO_TOOL_MAX_DIAMETER_INCH, 'inch', project.meta.units)
  const helical = ranked.find((candidate) =>
    candidate.tool.type === 'flat_endmill'
    && candidate.tool.diameter <= holeDiameter * CAM_PLAN_HELICAL_BORE_FRACTION + 1e-9
    && candidate.tool.diameter <= helicalCeiling + 1e-9
    && holeDiameter - candidate.tool.diameter * HELICAL_BORE_MAX_HOLE_TO_TOOL_RATIO <= 1e-9,
  )
  return helical ? { tool: helical, drillType: 'helical', options: ranked } : null
}

export function toolChoiceReason(
  candidate: CamPlanTool,
  kind: OperationKind,
  maximum: number | null,
  reused: boolean,
  limitSource: 'feature-span' | 'model-footprint' = 'feature-span',
): string {
  const origin = candidate.source === 'existing' ? 'already in this project' : 'from the bundled library'
  const scale = maximum == null
    ? 'selected because no reliable target span was available'
    : `fits the ${limitSource === 'model-footprint' ? 'transformed model footprint' : 'operation'} ${maximum.toFixed(3)} ${candidate.tool.units} cutter limit`
  const reuse = reused ? ' and is reused by another planned operation' : ''
  return `${candidate.tool.name} is ${origin}, ${scale}${reuse}; preferred for ${kind.replaceAll('_', ' ')}.`
}
