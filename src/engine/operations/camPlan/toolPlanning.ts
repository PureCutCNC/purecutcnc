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
import { convertToolUnits } from '../../../utils/units'
import { preferredToolTypes, targetFeatureSize } from '../toolSelection'
import type { CamPlanTool } from './types'

/**
 * Outside profiles have no geometric clearance constraint, so the ordinary
 * half-span selector can choose a cutter that is visually and practically out
 * of scale with the part. The preview deliberately starts more conservatively:
 * at most one quarter of the part's smaller span. This is isolated and fixture-
 * backed because POC feedback may change it.
 */
export const CAM_PLAN_OUTSIDE_TOOL_FRACTION = 0.25
export const CAM_PLAN_INTERIOR_TOOL_FRACTION = 0.5
export const CAM_PLAN_HELICAL_BORE_FRACTION = 0.8
export const CAM_PLAN_DRILL_DIAMETER_TOLERANCE = 0.02

function libraryTool(entry: ToolLibraryEntry, units: Tool['units']): CamPlanTool {
  const converted = convertToolUnits({ ...entry, id: `cam-plan-tool:${entry.key}` }, units)
  return {
    id: converted.id,
    source: 'library',
    libraryKey: entry.key,
    tool: converted,
  }
}

export function camPlanToolPool(project: Project, libraryTools: ToolLibraryEntry[]): CamPlanTool[] {
  const existing = project.tools.map((tool) => ({
    id: tool.id,
    source: 'existing' as const,
    tool: tool.units === project.meta.units ? tool : convertToolUnits(tool, project.meta.units),
  }))
  const imported = libraryTools.map((entry) => libraryTool(entry, project.meta.units))
  return [...existing, ...imported]
}

function maximumDiameter(project: Project, kind: OperationKind, target: OperationTarget): number | null {
  const span = targetFeatureSize(project, target)
  if (span == null) return null
  if (kind === 'drilling') return span
  const fraction = kind === 'edge_route_outside'
    ? CAM_PLAN_OUTSIDE_TOOL_FRACTION
    : CAM_PLAN_INTERIOR_TOOL_FRACTION
  return span * fraction
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

export function rankCamPlanTools(
  project: Project,
  kind: OperationKind,
  target: OperationTarget,
  pool: CamPlanTool[],
  requiredDepth: number,
  reusedToolIds: ReadonlySet<string>,
): RankedCamPlanTools {
  const diameterLimit = maximumDiameter(project, kind, target)
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

  const helical = ranked.find((candidate) =>
    candidate.tool.type === 'flat_endmill'
    && candidate.tool.diameter <= holeDiameter * CAM_PLAN_HELICAL_BORE_FRACTION + 1e-9,
  )
  return helical ? { tool: helical, drillType: 'helical', options: ranked } : null
}

export function toolChoiceReason(
  candidate: CamPlanTool,
  kind: OperationKind,
  maximum: number | null,
  reused: boolean,
): string {
  const origin = candidate.source === 'existing' ? 'already in this project' : 'from the bundled library'
  const scale = maximum == null
    ? 'selected because no reliable target span was available'
    : `fits the operation's ${maximum.toFixed(3)} ${candidate.tool.units} cutter limit`
  const reuse = reused ? ' and is reused by another planned operation' : ''
  return `${candidate.tool.name} is ${origin}, ${scale}${reuse}; preferred for ${kind.replaceAll('_', ' ')}.`
}
