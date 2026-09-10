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
import { defaultTool, type Operation, type OperationKind, type OperationPass, type OperationTarget, type Project, type Tab } from '../../../types/project'
import { getFeatureGeometryBounds } from '../../../text'
import { resolveDimensionRef } from '../../toolpaths/geometry'
import { generateEdgeRestRegionDrafts, generatePocketRestRegionDrafts } from '../../toolpaths/restRegions'
import { resolveInsideEdgeRegions, resolvePocketRegions } from '../../toolpaths/resolver'
import { isConstruction, isRegion } from '../../../store/helpers/featureRoles'
import { defaultOperationForTarget, isOperationTargetValid } from '../../../store/helpers/operationDefaults'
import { resolveFeatureInstances, type ResolvedSketchFeature } from '../../../store/helpers/resolveFeatures'
import { buildAutoTabsForFeature } from '../autoTabs'
import {
  camPlanToolPool,
  camPlanRoughStockToLeave,
  chooseDrillingTool,
  materiallySmallerCamPlanTools,
  rankCamPlanTools,
  toolChoiceReason,
} from './toolPlanning'
import type {
  CamPlanCoverage,
  CamPlanDraft,
  CamPlanOperationDraft,
  CamPlanRestDraft,
  CamPlanSharedTabsDraft,
  CamPlanTool,
} from './types'

const Z_EPSILON = 1e-7

export function camPlanProjectFingerprint(project: Project): string {
  return JSON.stringify({
    modified: project.meta.modified,
    features: project.features.map((feature) => [feature.id, feature.definitionId, feature.z_top, feature.z_bottom]),
    definitions: Object.values(project.featureDefinitions).map((definition) => [definition.id, definition.operation, definition.kind]),
    tools: project.tools.map((tool) => [tool.id, tool.type, tool.units, tool.diameter, tool.maxCutDepth]),
    operations: project.operations.map((operation) => [operation.id, operation.kind, operation.pass, operation.enabled, operation.target, operation.toolRef]),
    tabs: project.tabs.map((tab) => [tab.id, tab.x, tab.y, tab.w, tab.h, tab.z_top, tab.z_bottom]),
  })
}

function featureDepth(project: Project, feature: ResolvedSketchFeature): number {
  const bottom = resolveDimensionRef(project, feature.z_bottom)
  return Math.max(0, project.stock.thickness - bottom)
}

function depthKey(project: Project, feature: ResolvedSketchFeature): string {
  const top = resolveDimensionRef(project, feature.z_top)
  const bottom = resolveDimensionRef(project, feature.z_bottom)
  return `${top.toFixed(7)}:${bottom.toFixed(7)}`
}

function groupByDepth(project: Project, features: ResolvedSketchFeature[]): ResolvedSketchFeature[][] {
  const groups = new Map<string, ResolvedSketchFeature[]>()
  for (const feature of features) {
    const key = depthKey(project, feature)
    groups.set(key, [...(groups.get(key) ?? []), feature])
  }
  return [...groups.values()]
}

function operationAlreadyCovers(project: Project, kind: OperationKind, pass: OperationPass, featureId: string): boolean {
  return project.operations.some((operation) =>
    operation.enabled
    && operation.kind === kind
    && operation.pass === pass
    && operation.target.source === 'features'
    && operation.target.featureIds.includes(featureId),
  )
}

function featuresCoveredByExistingOperations(project: Project): Set<string> {
  return new Set(project.operations.flatMap((operation) => (
    operation.enabled && operation.target.source === 'features'
      ? operation.target.featureIds
      : []
  )))
}

function boundsContain(outer: ResolvedSketchFeature, inner: ResolvedSketchFeature): boolean {
  const a = getFeatureGeometryBounds(outer)
  const b = getFeatureGeometryBounds(inner)
  const areaA = (a.maxX - a.minX) * (a.maxY - a.minY)
  const areaB = (b.maxX - b.minX) * (b.maxY - b.minY)
  return areaA > areaB + 1e-9
    && a.minX <= b.minX + 1e-9
    && a.minY <= b.minY + 1e-9
    && a.maxX >= b.maxX - 1e-9
    && a.maxY >= b.maxY - 1e-9
}

function targetLabel(features: ResolvedSketchFeature[]): string {
  if (features.length === 1) return features[0]?.name ?? 'Feature'
  return `${features.length} features at the same depth`
}

function planToolById(tools: CamPlanTool[], id: string | null): CamPlanTool | null {
  return id ? tools.find((candidate) => candidate.id === id) ?? null : null
}

interface PlanBuilder {
  project: Project
  analysisProject: Project
  tools: CamPlanTool[]
  operations: CamPlanOperationDraft[]
  reusedToolIds: Set<string>
  covered: Set<string>
  existing: Set<string>
  sequence: number
}

function applyRoughStockToLeave(project: Project, operation: { kind: OperationKind; pass: OperationPass; stockToLeaveRadial: number; stockToLeaveAxial: number }): void {
  if (operation.pass !== 'rough') return
  if (
    operation.kind !== 'pocket'
    && operation.kind !== 'edge_route_inside'
    && operation.kind !== 'edge_route_outside'
  ) return
  const allowance = camPlanRoughStockToLeave(project.meta.units)
  operation.stockToLeaveRadial = allowance
  operation.stockToLeaveAxial = allowance
}

function restAnalysisOperation(operation: Operation): Operation {
  return {
    ...operation,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
  }
}

function addPlannedOperation(
  builder: PlanBuilder,
  kind: OperationKind,
  pass: OperationPass,
  features: ResolvedSketchFeature[],
  rationale: string,
  dependencies: string[] = [],
  forcedTool?: CamPlanTool,
): CamPlanOperationDraft | null {
  const featureIds = features
    .map((feature) => feature.id)
    .filter((featureId) => !operationAlreadyCovers(builder.project, kind, pass, featureId))
  for (const feature of features) {
    if (operationAlreadyCovers(builder.project, kind, pass, feature.id)) builder.existing.add(feature.id)
  }
  if (featureIds.length === 0) return null

  const plannedFeatures = features.filter((feature) => featureIds.includes(feature.id))
  const target: OperationTarget = { source: 'features', featureIds }
  const requiredDepth = Math.max(...plannedFeatures.map((feature) => featureDepth(builder.project, feature)))
  const ranked = rankCamPlanTools(
    builder.project,
    kind,
    target,
    builder.tools,
    requiredDepth,
    builder.reusedToolIds,
  )
  const selected = forcedTool ?? ranked.tools[0] ?? null
  const key = `cam-plan-op:${builder.sequence + 1}`
  builder.sequence += 1
  const wasReused = selected ? builder.reusedToolIds.has(selected.id) : false
  const operation = defaultOperationForTarget(
    { ...builder.analysisProject, operations: [...builder.project.operations, ...builder.operations.map((draft) => draft.operation)] },
    kind,
    pass,
    target,
    builder.project.operations.length + builder.operations.length,
    {
      tool: selected?.tool ?? defaultTool(builder.project.meta.units, 1),
      toolRef: selected?.id ?? null,
    },
  )
  operation.id = key
  operation.target = target
  applyRoughStockToLeave(builder.project, operation)
  if (selected) builder.reusedToolIds.add(selected.id)

  const draft: CamPlanOperationDraft = {
    key,
    enabled: true,
    operation,
    targetLabel: targetLabel(plannedFeatures),
    rationale,
    toolReason: selected
      ? toolChoiceReason(selected, kind, ranked.maximumDiameter, wasReused)
      : 'No available tool satisfies this operation\'s type, scale, and reach constraints.',
    toolOptions: ranked.tools.map((candidate) => candidate.id),
    coveredFeatureIds: featureIds,
    dependencies,
    hardError: !selected
      ? 'Choose or add a tool that fits this operation before creating it.'
      : (!isOperationTargetValid(builder.project, kind, target) ? 'The proposed target is not valid for this operation.' : null),
    staleReason: null,
    userOverrides: [],
  }
  builder.operations.push(draft)
  featureIds.forEach((id) => builder.covered.add(id))
  return draft
}

function addFinishRestOperation(
  builder: PlanBuilder,
  source: CamPlanOperationDraft | null,
  finish: CamPlanOperationDraft | null,
): CamPlanOperationDraft | null {
  if (!source || source.hardError || source.operation.target.source !== 'features') return null
  if (
    source.operation.kind !== 'pocket'
    && source.operation.kind !== 'edge_route_inside'
    && source.operation.kind !== 'edge_route_outside'
  ) return null
  const sourceTool = planToolById(builder.tools, source.operation.toolRef)
  if (!sourceTool) return null
  const sourceFeatures = resolveFeatureInstances(builder.project, source.operation.target.featureIds)
  const requiredDepth = Math.max(...sourceFeatures.map((feature) => featureDepth(builder.project, feature)))
  const ranked = rankCamPlanTools(
    builder.project,
    source.operation.kind,
    source.operation.target,
    builder.tools,
    requiredDepth,
    builder.reusedToolIds,
  )
  const smaller = materiallySmallerCamPlanTools(sourceTool, ranked.tools)[0]
  if (!smaller) return null

  const result = source.operation.kind === 'pocket'
    ? generatePocketRestRegionDrafts(builder.analysisProject, restAnalysisOperation(source.operation))
    : generateEdgeRestRegionDrafts(builder.analysisProject, restAnalysisOperation(source.operation))
  if (result.drafts.length === 0) return null

  const rest = addPlannedOperation(
    builder,
    source.operation.kind,
    'finish',
    sourceFeatures,
    `A smaller finish cutter can clean ${result.drafts.length} residual area${result.drafts.length === 1 ? '' : 's'} that ${source.operation.name} cannot reach.`,
    [finish?.key ?? source.key],
    smaller,
  )
  if (!rest) return null
  rest.operation.name = `${finish?.operation.name ?? source.operation.name.replace('Rough', 'Finish')} Rest`
  rest.rest = {
    sourceOperationKey: source.key,
    sourceFeatureIds: [...source.operation.target.featureIds],
    regions: result.drafts,
  } satisfies CamPlanRestDraft
  return rest
}

function addRoughFinishPair(
  builder: PlanBuilder,
  kind: OperationKind,
  features: ResolvedSketchFeature[],
  rationale: string,
): CamPlanOperationDraft[] {
  const rough = addPlannedOperation(builder, kind, 'rough', features, `${rationale} Start with a roughing pass.`)
  const finishTool = rough ? planToolById(builder.tools, rough.operation.toolRef) ?? undefined : undefined
  const finish = addPlannedOperation(
    builder,
    kind,
    'finish',
    features,
    `${rationale} Finish the walls and floor after roughing.`,
    rough ? [rough.key] : [],
    finishTool,
  )
  const rest = addFinishRestOperation(builder, rough, finish)
  return [rough, finish, rest].filter((draft): draft is CamPlanOperationDraft => draft !== null)
}

function buildSharedTabs(builder: PlanBuilder): CamPlanSharedTabsDraft[] {
  const edgeGroups = new Map<string, CamPlanOperationDraft[]>()
  for (const operation of builder.operations) {
    if (operation.operation.kind !== 'edge_route_inside' && operation.operation.kind !== 'edge_route_outside') continue
    if (operation.rest || operation.operation.target.source !== 'features') continue
    const key = `${operation.operation.kind}:${[...operation.operation.target.featureIds].sort().join(',')}`
    edgeGroups.set(key, [...(edgeGroups.get(key) ?? []), operation])
  }

  return [...edgeGroups.entries()].map(([key, operations], index) => {
    const targetIds = operations[0]?.operation.target.source === 'features'
      ? operations[0].operation.target.featureIds
      : []
    const features = resolveFeatureInstances(builder.project, targetIds)
    const reusedExistingTabs = builder.project.tabs.length > 0
    const tools = operations
      .map((operation) => planToolById(builder.tools, operation.operation.toolRef))
      .filter((tool): tool is CamPlanTool => tool !== null)
      .sort((a, b) => b.tool.diameter - a.tool.diameter)
    const placementOperation = operations.find((operation) => operation.operation.toolRef === tools[0]?.id)?.operation
      ?? operations[0]?.operation
    const tabs: Tab[] = []
    if (!reusedExistingTabs && placementOperation) {
      for (const feature of features) {
        tabs.push(...buildAutoTabsForFeature(
          feature,
          builder.analysisProject,
          placementOperation,
          [...builder.project.tabs, ...tabs],
        ))
      }
    }
    const stableTabs = tabs.map((tab, tabIndex) => ({
      ...tab,
      id: `cam-plan-tab:${index + 1}:${tabIndex + 1}`,
    }))

    return {
      key: `cam-plan-tabs:${index + 1}:${key}`,
      enabled: true,
      targetFeatureIds: targetIds,
      operationKeys: operations.map((operation) => operation.key),
      targetLabel: targetLabel(features),
      reusedExistingTabs,
      tabs: stableTabs,
      warning: reusedExistingTabs
        ? 'Existing project tabs will be shared by these edge operations; review their placement before generating toolpaths.'
        : stableTabs.length === 0 ? 'No valid automatic tab placement was found.' : null,
    }
  })
}

function resolvedIslandFeatureIds(builder: PlanBuilder): Set<string> {
  const islandIds = new Set<string>()
  for (const draft of builder.operations) {
    if (draft.rest) continue
    const resolved = draft.operation.kind === 'pocket'
      ? resolvePocketRegions(builder.analysisProject, draft.operation)
      : draft.operation.kind === 'edge_route_inside'
        ? resolveInsideEdgeRegions(builder.analysisProject, draft.operation)
        : null
    for (const band of resolved?.bands ?? []) {
      for (const featureId of band.islandFeatureIds) islandIds.add(featureId)
    }
  }
  return islandIds
}

function resolvedNonTargetSubtractFeatureIds(builder: PlanBuilder): Set<string> {
  const subtractIds = new Set<string>()
  for (const draft of builder.operations) {
    if (draft.rest || draft.operation.target.source !== 'features') continue
    const resolved = draft.operation.kind === 'pocket'
      ? resolvePocketRegions(builder.analysisProject, draft.operation)
      : draft.operation.kind === 'edge_route_inside'
        ? resolveInsideEdgeRegions(builder.analysisProject, draft.operation)
        : null
    const directTargetIds = new Set(draft.operation.target.featureIds)
    for (const band of resolved?.bands ?? []) {
      for (const featureId of band.targetFeatureIds) {
        if (!directTargetIds.has(featureId)) subtractIds.add(featureId)
      }
    }
  }
  return subtractIds
}

function coverageFor(
  features: ResolvedSketchFeature[],
  builder: PlanBuilder,
): CamPlanCoverage[] {
  const hasSurfacePlan = builder.operations.some((draft) => draft.operation.kind === 'surface_clean')
  const resolvedIslandIds = resolvedIslandFeatureIds(builder)
  const resolvedNonTargetSubtractIds = resolvedNonTargetSubtractFeatureIds(builder)
  return features.flatMap<CamPlanCoverage>((feature) => {
    if (isRegion(feature) || isConstruction(feature)) return []
    if (builder.covered.has(feature.id)) {
      return [{ featureId: feature.id, featureName: feature.name, status: 'planned', detail: 'Covered by one or more recommendations.' }]
    }
    if (builder.existing.has(feature.id)) {
      return [{ featureId: feature.id, featureName: feature.name, status: 'existing', detail: 'Covered by an enabled operation already in the project.' }]
    }
    if (resolvedIslandIds.has(feature.id)) {
      return [{ featureId: feature.id, featureName: feature.name, status: 'not_needed', detail: 'Retained island geometry is included in the surrounding pocket or inside-edge operation.' }]
    }
    if (resolvedNonTargetSubtractIds.has(feature.id)) {
      return [{ featureId: feature.id, featureName: feature.name, status: 'not_needed', detail: 'This subtract is machined by the surrounding pocket operation that resolves it.' }]
    }
    if ((feature.operation === 'add' || feature.operation === 'model') && feature.kind !== 'stl' && hasSurfacePlan) {
      return [{ featureId: feature.id, featureName: feature.name, status: 'not_needed', detail: 'Retained model geometry informs the surrounding surface-clean operation.' }]
    }
    if (feature.operation === 'line') {
      return [{ featureId: feature.id, featureName: feature.name, status: 'unsupported', detail: 'Line engraving is outside this POC.' }]
    }
    if (feature.kind === 'stl') {
      return [{ featureId: feature.id, featureName: feature.name, status: 'unsupported', detail: 'Imported-model planning is outside this POC.' }]
    }
    return [{ featureId: feature.id, featureName: feature.name, status: 'unsupported', detail: 'No confident POC rule matched this feature.' }]
  })
}

export function createCamPlan(project: Project, libraryTools: ToolLibraryEntry[]): CamPlanDraft {
  const features = resolveFeatureInstances(project)
  const tools = camPlanToolPool(project, libraryTools)
  const analysisProject = {
    ...project,
    tools: [...project.tools, ...tools.filter((candidate) => candidate.source === 'library').map((candidate) => candidate.tool)],
  }
  const builder: PlanBuilder = {
    project,
    analysisProject,
    tools,
    operations: [],
    reusedToolIds: new Set(),
    covered: new Set(),
    existing: featuresCoveredByExistingOperations(project),
    sequence: 0,
  }

  const closedAdds = features.filter((feature) =>
    !builder.existing.has(feature.id)
    && (feature.operation === 'add' || feature.operation === 'model')
    && feature.kind !== 'stl'
    && feature.sketch.profile.closed,
  )
  const loweredAdds = closedAdds.filter((feature) =>
    resolveDimensionRef(project, feature.z_top) < project.stock.thickness - Z_EPSILON,
  )
  for (const group of groupByDepth(project, loweredAdds)) {
    addRoughFinishPair(builder, 'surface_clean', group, 'This retained surface sits below the stock top and needs cleanup.')
  }

  const subtracts = features.filter((feature) =>
    !builder.existing.has(feature.id)
    && feature.operation === 'subtract'
    && feature.sketch.profile.closed,
  )
  const ordinarySubtracts: ResolvedSketchFeature[] = []
  for (const feature of subtracts.filter((candidate) => candidate.kind === 'circle')) {
    const target: OperationTarget = { source: 'features', featureIds: [feature.id] }
    const requiredDepth = featureDepth(project, feature)
    const drillability = chooseDrillingTool(project, target, tools, requiredDepth, builder.reusedToolIds)
    if (!drillability) {
      ordinarySubtracts.push(feature)
      continue
    }
    const drill = addPlannedOperation(
      builder,
      'drilling',
      'rough',
      [feature],
      drillability.drillType === 'simple'
        ? 'The circular subtract matches an available drill.'
        : 'The circular subtract can be helical-bored with a smaller flat end mill.',
      [],
      drillability.tool,
    )
    if (drill) {
      drill.operation.drillType = drillability.drillType
      drill.toolOptions = drillability.options.map((candidate) => candidate.id)
    }
  }
  ordinarySubtracts.push(...subtracts.filter((candidate) => candidate.kind !== 'circle'))

  const blind = ordinarySubtracts.filter((feature) => resolveDimensionRef(project, feature.z_bottom) > Z_EPSILON)
  const through = ordinarySubtracts.filter((feature) => resolveDimensionRef(project, feature.z_bottom) <= Z_EPSILON)
  for (const group of groupByDepth(project, blind)) {
    const directTargets = group.filter((feature) => !resolvedNonTargetSubtractFeatureIds(builder).has(feature.id))
    if (directTargets.length === 0) continue
    addRoughFinishPair(builder, 'pocket', directTargets, 'This closed subtract stops above the stock bottom, so it is a blind pocket.')
  }
  for (const group of groupByDepth(project, through)) {
    addRoughFinishPair(builder, 'edge_route_inside', group, 'This closed subtract reaches the stock bottom, so the removable slug is routed on its inside edge.')
  }

  const outerAdds = closedAdds.filter((feature) =>
    resolveDimensionRef(project, feature.z_bottom) <= Z_EPSILON
    && !closedAdds.some((candidate) => candidate.id !== feature.id && boundsContain(candidate, feature)),
  )
  const outsideOperations: CamPlanOperationDraft[] = []
  for (const feature of outerAdds) {
    outsideOperations.push(...addRoughFinishPair(
      builder,
      'edge_route_outside',
      [feature],
      'This is an outer retained perimeter, so it is routed from the surrounding stock.',
    ))
  }

  const outsideKeys = new Set(outsideOperations.map((draft) => draft.key))
  const internalKeys = builder.operations.filter((draft) => !outsideKeys.has(draft.key)).map((draft) => draft.key)
  for (const draft of outsideOperations) {
    if (draft.dependencies.length === 0) draft.dependencies = [...internalKeys]
  }

  const sharedTabs = buildSharedTabs(builder)
  return {
    sourceFingerprint: camPlanProjectFingerprint(project),
    tools,
    operations: builder.operations,
    sharedTabs,
    coverage: coverageFor(features, builder),
  }
}
