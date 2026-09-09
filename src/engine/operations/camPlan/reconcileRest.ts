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

import { defaultTool, type Operation, type Project } from '../../../types/project'
import { defaultOperationForTarget } from '../../../store/helpers/operationDefaults'
import { resolveFeatureInstances } from '../../../store/helpers/resolveFeatures'
import { resolveDimensionRef } from '../../toolpaths/geometry'
import { generateEdgeRestRegionDrafts, generatePocketRestRegionDrafts } from '../../toolpaths/restRegions'
import { materiallySmallerCamPlanTools, rankCamPlanTools, toolChoiceReason } from './toolPlanning'
import type { CamPlanDraft, CamPlanOperationDraft, CamPlanOperationField, CamPlanTool } from './types'

function analysisProject(project: Project, plan: CamPlanDraft): Project {
  const tools = new Map(project.tools.map((tool) => [tool.id, tool]))
  for (const candidate of plan.tools) tools.set(candidate.id, candidate.tool)
  return { ...project, tools: [...tools.values()] }
}

function candidateById(plan: CamPlanDraft, id: string | null): CamPlanTool | null {
  return id ? plan.tools.find((candidate) => candidate.id === id) ?? null : null
}

function requiredCutDepth(project: Project, operation: Operation): number {
  if (operation.target.source === 'stock') return project.stock.thickness
  const features = resolveFeatureInstances(project, operation.target.featureIds)
  return Math.max(0, ...features.map((feature) => (
    project.stock.thickness - resolveDimensionRef(project, feature.z_bottom)
  )))
}

function operationWithSuggestedTool(
  operation: Operation,
  candidate: CamPlanTool,
  overrides: ReadonlySet<CamPlanOperationField>,
): Operation {
  return {
    ...operation,
    toolRef: candidate.id,
    ...(!overrides.has('feed') ? { feed: candidate.tool.defaultFeed } : {}),
    ...(!overrides.has('plungeFeed') ? { plungeFeed: candidate.tool.defaultPlungeFeed } : {}),
    ...(!overrides.has('stepdown') ? { stepdown: candidate.tool.defaultStepdown } : {}),
    ...(!overrides.has('stepover') ? { stepover: candidate.tool.defaultStepover } : {}),
    ...(!overrides.has('rpm') ? { rpm: candidate.tool.defaultRpm } : {}),
  }
}

function restAnalysisOperation(operation: Operation): Operation {
  return {
    ...operation,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
  }
}

function sameFamily(a: CamPlanOperationDraft, b: CamPlanOperationDraft): boolean {
  return !a.rest
    && a.operation.kind === b.operation.kind
    && a.operation.pass === 'finish'
    && a.coveredFeatureIds.length === b.coveredFeatureIds.length
    && a.coveredFeatureIds.every((id) => b.coveredFeatureIds.includes(id))
}

function replaceDependencies(
  draft: CamPlanOperationDraft,
  oldKeys: ReadonlySet<string>,
  replacement: string,
): CamPlanOperationDraft {
  if (!draft.dependencies.some((key) => oldKeys.has(key))) return draft
  return {
    ...draft,
    dependencies: [...new Set(draft.dependencies.map((key) => oldKeys.has(key) ? replacement : key))],
  }
}

function removeRestOperations(
  operations: CamPlanOperationDraft[],
  source: CamPlanOperationDraft,
  dependents: CamPlanOperationDraft[],
): CamPlanOperationDraft[] {
  const removedKeys = new Set(dependents.map((draft) => draft.key))
  return operations
    .filter((draft) => !removedKeys.has(draft.key))
    .map((draft) => replaceDependencies(draft, removedKeys, source.key))
}

function createRestOperation(
  project: Project,
  plan: CamPlanDraft,
  source: CamPlanOperationDraft,
  finish: CamPlanOperationDraft | null,
  key: string,
  selected: CamPlanTool | null,
): Operation {
  const context = analysisProject(project, plan)
  const operation = defaultOperationForTarget(
    { ...context, operations: [...project.operations, ...plan.operations.map((draft) => draft.operation)] },
    source.operation.kind,
    'finish',
    source.operation.target,
    project.operations.length + plan.operations.length,
    {
      tool: selected?.tool ?? defaultTool(project.meta.units, 1),
      toolRef: selected?.id ?? null,
    },
  )
  operation.id = key
  operation.name = `${finish?.operation.name ?? source.operation.name.replace('Rough', 'Finish')} Rest`
  operation.target = source.operation.target
  return operation
}

function selectedRestTool(
  plan: CamPlanDraft,
  existing: CamPlanOperationDraft | null,
  candidates: CamPlanTool[],
): { selected: CamPlanTool | null; preservedConflict: boolean } {
  const userSelected = existing?.userOverrides.includes('toolRef') ?? false
  if (!userSelected) return { selected: candidates[0] ?? null, preservedConflict: false }
  const selected = candidateById(plan, existing?.operation.toolRef ?? null)
  return {
    selected,
    preservedConflict: !selected || !candidates.some((candidate) => candidate.id === selected.id),
  }
}

function updateFinishFromSource(
  draft: CamPlanOperationDraft,
  source: CamPlanOperationDraft,
  sourceTool: CamPlanTool | null,
): CamPlanOperationDraft {
  if (!sameFamily(draft, source)) return draft
  if (!sourceTool || draft.userOverrides.includes('toolRef')) return draft
  return {
    ...draft,
    operation: operationWithSuggestedTool(draft.operation, sourceTool, new Set(draft.userOverrides)),
  }
}

/**
 * Recomputes only rest proposals derived from one edited operation. Explicit
 * values on the rest proposal survive; suggested tool/default values may move
 * to a newly compatible cutter.
 */
export function reconcileCamPlanRest(project: Project, plan: CamPlanDraft, sourceKey: string): CamPlanDraft {
  const source = plan.operations.find((draft) => draft.key === sourceKey) ?? null
  if (!source) return plan
  if (source.operation.pass !== 'rough') return plan
  if (
    source.operation.kind !== 'pocket'
    && source.operation.kind !== 'edge_route_inside'
    && source.operation.kind !== 'edge_route_outside'
  ) return plan

  const dependents = plan.operations.filter((draft) => draft.rest?.sourceOperationKey === sourceKey)
  const existing = dependents[0] ?? null
  const sourceTool = candidateById(plan, source.operation.toolRef)
  const context = analysisProject(project, plan)
  const result = source.operation.kind === 'pocket'
    ? generatePocketRestRegionDrafts(context, restAnalysisOperation(source.operation))
    : generateEdgeRestRegionDrafts(context, restAnalysisOperation(source.operation))
  const withoutRest = removeRestOperations(plan.operations, source, dependents).map((draft) =>
    updateFinishFromSource(draft, source, sourceTool),
  )
  const finish = withoutRest.find((draft) => sameFamily(draft, source)) ?? null
  if (result.drafts.length === 0) {
    return {
      ...plan,
      operations: withoutRest,
    }
  }

  const reusedToolIds = new Set(plan.operations.flatMap((draft) => draft.operation.toolRef ? [draft.operation.toolRef] : []))
  const ranked = rankCamPlanTools(
    project,
    source.operation.kind,
    source.operation.target,
    plan.tools,
    requiredCutDepth(project, source.operation),
    reusedToolIds,
  )
  const candidates = sourceTool
    ? materiallySmallerCamPlanTools(sourceTool, ranked.tools)
    : []
  const { selected, preservedConflict } = selectedRestTool(plan, existing, candidates)
  const key = existing?.key ?? `${source.key}:rest`
  const overrides = new Set(existing?.userOverrides ?? [])
  const restName = `${finish?.operation.name ?? source.operation.name.replace('Rough', 'Finish')} Rest`
  let operation = existing?.operation
    ? {
      ...existing.operation,
      pass: 'finish' as const,
      target: source.operation.target,
      ...(!overrides.has('name') ? { name: restName } : {}),
      ...(!overrides.has('stockToLeaveRadial') ? { stockToLeaveRadial: 0 } : {}),
      ...(!overrides.has('stockToLeaveAxial') ? { stockToLeaveAxial: 0 } : {}),
    }
    : createRestOperation(project, plan, source, finish, key, selected)
  if (selected && !overrides.has('toolRef')) {
    operation = operationWithSuggestedTool(operation, selected, overrides)
  } else if (!selected && !overrides.has('toolRef')) {
    operation = { ...operation, toolRef: null }
  }

  const currentUserTool = existing?.userOverrides.includes('toolRef') && existing.operation.toolRef
    ? [existing.operation.toolRef]
    : []
  const rest: CamPlanOperationDraft = {
    key,
    enabled: existing?.enabled ?? source.enabled,
    operation,
    targetLabel: source.targetLabel,
    rationale: `A smaller finish cutter can clean ${result.drafts.length} residual area${result.drafts.length === 1 ? '' : 's'} that ${source.operation.name} cannot reach.`,
    toolReason: existing?.userOverrides.includes('toolRef')
      ? existing.toolReason
      : (selected
        ? toolChoiceReason(selected, source.operation.kind, ranked.maximumDiameter, reusedToolIds.has(selected.id))
        : 'No available smaller tool satisfies this rest operation\'s type, scale, and reach constraints.'),
    toolOptions: [...new Set([...currentUserTool, ...candidates.map((candidate) => candidate.id)])],
    coveredFeatureIds: [...source.coveredFeatureIds],
    dependencies: [finish?.key ?? source.key],
    hardError: preservedConflict
      ? 'Your selected rest tool is no longer compatible with the corrected source operation.'
      : (!selected ? 'Residual material remains, but no smaller compatible tool is available.' : null),
    staleReason: null,
    userOverrides: existing?.userOverrides ?? [],
    rest: {
      sourceOperationKey: source.key,
      sourceFeatureIds: source.operation.target.source === 'features'
        ? [...source.operation.target.featureIds]
        : [],
      regions: result.drafts,
    },
  }

  const anchorKey = finish?.key ?? source.key
  const anchorIndex = withoutRest.findIndex((draft) => draft.key === anchorKey)
  const insertionIndex = anchorIndex >= 0 ? anchorIndex : withoutRest.length - 1
  const operations = [
    ...withoutRest.slice(0, insertionIndex + 1),
    rest,
    ...withoutRest.slice(insertionIndex + 1),
  ]
  return {
    ...plan,
    operations,
  }
}
