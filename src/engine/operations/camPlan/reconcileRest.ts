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

function supportsRestOperation(draft: CamPlanOperationDraft): boolean {
  return draft.operation.pass === 'rough'
    && (
      draft.operation.kind === 'pocket'
      || draft.operation.kind === 'edge_route_inside'
      || draft.operation.kind === 'edge_route_outside'
    )
}

function primaryRoughForFinish(
  draft: CamPlanOperationDraft,
  operationByKey: ReadonlyMap<string, CamPlanOperationDraft>,
): CamPlanOperationDraft | null {
  if (draft.rest || draft.operation.pass !== 'finish') return null
  for (const dependency of draft.dependencies) {
    const source = operationByKey.get(dependency)
    if (source && source.operation.pass === 'rough' && sameFamily(draft, source)) return source
  }
  return null
}

function sourceToolIds(operations: CamPlanOperationDraft[]): Set<string> {
  return new Set(operations.flatMap((draft) => draft.operation.toolRef ? [draft.operation.toolRef] : []))
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
export function reconcileCamPlanRest(
  project: Project,
  plan: CamPlanDraft,
  sourceKey: string,
  reusedToolIdsOverride?: ReadonlySet<string>,
): CamPlanDraft {
  const source = plan.operations.find((draft) => draft.key === sourceKey) ?? null
  if (!source) return plan
  if (!supportsRestOperation(source)) return plan

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

  const reusedToolIds = reusedToolIdsOverride ?? sourceToolIds(plan.operations)
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

/**
 * Replans automatic choices from one user correction forward. Operations
 * before the correction are intentionally frozen, while explicit choices in
 * the suffix still win over the refreshed recommendation.
 */
export function reconcileCamPlanDownstream(project: Project, plan: CamPlanDraft, sourceKey: string): CamPlanDraft {
  const sourceIndex = plan.operations.findIndex((draft) => draft.key === sourceKey)
  if (sourceIndex < 0) return plan

  const operations = [...plan.operations]
  const reusedToolIds = sourceToolIds(operations.slice(0, sourceIndex))
  const restSourceKeys: string[] = []

  for (let index = sourceIndex; index < operations.length; index += 1) {
    const draft = operations[index]!
    if (draft.rest) continue
    if (supportsRestOperation(draft)) restSourceKeys.push(draft.key)

    const selected = candidateById(plan, draft.operation.toolRef)
    const isCorrection = index === sourceIndex
    if (isCorrection || draft.userOverrides.includes('toolRef')) {
      if (selected) reusedToolIds.add(selected.id)
      continue
    }

    const pairedRough = primaryRoughForFinish(draft, new Map(operations.map((candidate) => [candidate.key, candidate])))
    const forcedTool = pairedRough && draft.operation.kind !== 'finish_surface'
      ? candidateById(plan, pairedRough.operation.toolRef)
      : null
    const ranked = rankCamPlanTools(
      project,
      draft.operation.kind,
      draft.operation.target,
      plan.tools,
      draft.requiredCutDepth ?? requiredCutDepth(project, draft.operation),
      reusedToolIds,
      draft.maximumToolDiameter,
    )
    const suggested = forcedTool ?? ranked?.tools[0] ?? null
    const wasReused = suggested ? reusedToolIds.has(suggested.id) : false
    const overrides = new Set(draft.userOverrides)
    operations[index] = {
      ...draft,
      operation: suggested
        ? operationWithSuggestedTool(draft.operation, suggested, overrides)
        : { ...draft.operation, toolRef: null },
      toolReason: suggested
        ? toolChoiceReason(suggested, draft.operation.kind, ranked.maximumDiameter, wasReused, draft.toolLimitSource)
        : draft.operation.kind === 'rough_surface' || draft.operation.kind === 'finish_surface'
          ? 'No compatible surface tool satisfies this model\'s footprint and reach. Choose or add one, or exclude the model.'
          : 'No available tool satisfies this operation\'s type, scale, and reach constraints.',
      toolOptions: [...new Set([...(forcedTool ? [forcedTool.id] : []), ...ranked.tools.map((candidate) => candidate.id)])],
      hardError: suggested ? null : draft.operation.kind === 'rough_surface' || draft.operation.kind === 'finish_surface'
        ? 'No compatible surface tool satisfies this model\'s footprint and reach. Choose or add one, or exclude the model.'
        : 'Choose or add a tool that fits this operation before creating it.',
    }
    if (suggested) reusedToolIds.add(suggested.id)
  }

  let reconciled: CamPlanDraft = { ...plan, operations }
  for (const key of restSourceKeys) {
    const roughIndex = reconciled.operations.findIndex((draft) => draft.key === key)
    if (roughIndex < 0) continue
    const prefixToolIds = sourceToolIds(reconciled.operations.slice(0, roughIndex + 1))
    reconciled = reconcileCamPlanRest(project, reconciled, key, prefixToolIds)
  }
  return reconciled
}
