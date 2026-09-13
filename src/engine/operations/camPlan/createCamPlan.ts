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
import { defaultTool, getStockBounds, type Operation, type OperationKind, type OperationPass, type OperationTarget, type Project, type Tab } from '../../../types/project'
import { getFeatureGeometryBounds } from '../../../text'
import { loadSTLTransformedGeometry } from '../../csg'
import { resolveDimensionRef } from '../../toolpaths/geometry'
import { generateEdgeRestRegionDrafts, generatePocketRestRegionDrafts } from '../../toolpaths/restRegions'
import { resolveInsideEdgeRegions, resolvePocketRegions } from '../../toolpaths/resolver'
import { isConstruction, isRegion } from '../../../store/helpers/featureRoles'
import { featuresOverlap } from '../../../store/helpers/clipping'
import { defaultOperationForTarget, isOperationTargetValid } from '../../../store/helpers/operationDefaults'
import { resolveFeatureInstances, type ResolvedSketchFeature } from '../../../store/helpers/resolveFeatures'
import { buildAutoTabsForFeature } from '../autoTabs'
import {
  camPlanToolPool,
  CAM_PLAN_INTERIOR_TOOL_FRACTION,
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
    features: project.features.map((feature) => [feature.id, feature.definitionId, feature.transform, feature.z_top, feature.z_bottom]),
    definitions: Object.values(project.featureDefinitions).map((definition) => [definition.id, definition.operation, definition.kind, definition.stl]),
    modelAssets: Object.entries(project.modelAssets ?? {}).sort(([a], [b]) => a.localeCompare(b)),
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

function groupDrillingCandidates(project: Project, features: ResolvedSketchFeature[]): ResolvedSketchFeature[][] {
  const groups = new Map<string, ResolvedSketchFeature[]>()
  for (const feature of features) {
    const bounds = getFeatureGeometryBounds(feature)
    const diameter = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
    const key = `${depthKey(project, feature)}:${diameter.toFixed(7)}`
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

function targetLabel(project: Project, features: ResolvedSketchFeature[]): string {
  if (features.length === 1) return features[0]?.name ?? 'Feature'
  const firstDepth = depthKey(project, features[0]!)
  const hasMixedDepths = features.some((feature) => depthKey(project, feature) !== firstDepth)
  return hasMixedDepths ? `${features.length} features across multiple depths` : `${features.length} features at the same depth`
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
  unresolvedModels: Map<string, string>
  sequence: number
}

function applyRoughStockToLeave(project: Project, operation: { kind: OperationKind; pass: OperationPass; stockToLeaveRadial: number; stockToLeaveAxial: number }): void {
  if (operation.pass !== 'rough') return
  if (
    operation.kind !== 'surface_clean'
    && operation.kind !== 'pocket'
    && operation.kind !== 'edge_route_inside'
    && operation.kind !== 'edge_route_outside'
    && operation.kind !== 'rough_surface'
  ) return
  const allowance = camPlanRoughStockToLeave(project.meta.units)
  operation.stockToLeaveRadial = allowance
  operation.stockToLeaveAxial = allowance
}

interface PlannerToolConstraints {
  requiredCutDepth?: number
  maximumToolDiameter?: number | null
  toolLimitSource?: 'feature-span' | 'model-footprint'
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
  constraints?: PlannerToolConstraints,
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
  const requiredDepth = constraints?.requiredCutDepth
    ?? Math.max(...plannedFeatures.map((feature) => featureDepth(builder.project, feature)))
  const ranked = rankCamPlanTools(
    builder.project,
    kind,
    target,
    builder.tools,
    requiredDepth,
    builder.reusedToolIds,
    constraints?.maximumToolDiameter,
  )
  const selected = forcedTool ?? ranked.tools[0] ?? null
  const missingToolError = kind === 'rough_surface' || kind === 'finish_surface'
    ? 'No compatible surface tool satisfies this model\'s footprint and reach. Choose or add one, or exclude the model.'
    : 'Choose or add a tool that fits this operation before creating it.'
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
    targetLabel: targetLabel(builder.project, plannedFeatures),
    rationale,
    toolReason: selected
      ? toolChoiceReason(selected, kind, ranked.maximumDiameter, wasReused, constraints?.toolLimitSource)
      : kind === 'rough_surface' || kind === 'finish_surface'
        ? missingToolError
        : 'No available tool satisfies this operation\'s type, scale, and reach constraints.',
    toolOptions: ranked.tools.map((candidate) => candidate.id),
    maximumToolDiameter: ranked.maximumDiameter,
    toolLimitSource: constraints?.toolLimitSource,
    requiredCutDepth: requiredDepth,
    coveredFeatureIds: featureIds,
    dependencies,
    hardError: !selected
      ? missingToolError
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
  forcedRoughTool?: CamPlanTool,
): CamPlanOperationDraft[] {
  const rough = addPlannedOperation(builder, kind, 'rough', features, `${rationale} Start with a roughing pass.`, [], forcedRoughTool)
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

interface ImportedModelCandidate {
  feature: ResolvedSketchFeature
  constraints: Required<PlannerToolConstraints>
}

function importedModelCandidate(
  project: Project,
  feature: ResolvedSketchFeature,
): { candidate: ImportedModelCandidate | null; reason: string | null } {
  const transformed = loadSTLTransformedGeometry(feature, project)
  if (!transformed) {
    return { candidate: null, reason: 'The imported mesh is unavailable, corrupt, or has no usable height.' }
  }

  const { positions } = transformed
  if (positions.length < 9 || positions.length % 3 !== 0) {
    return { candidate: null, reason: 'The imported mesh has no usable triangles.' }
  }

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index]!
    const y = positions[index + 1]!
    const z = positions[index + 2]!
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return { candidate: null, reason: 'The transformed imported mesh contains invalid coordinates.' }
    }
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    maxZ = Math.max(maxZ, z)
  }

  if (maxX - minX <= Z_EPSILON || maxY - minY <= Z_EPSILON || maxZ - minZ <= Z_EPSILON) {
    return { candidate: null, reason: 'The transformed imported mesh is degenerate.' }
  }

  const stock = getStockBounds(project.stock)
  const overlapWidth = Math.min(maxX, stock.maxX) - Math.max(minX, stock.minX)
  const overlapHeight = Math.min(maxY, stock.maxY) - Math.max(minY, stock.minY)
  const overlapDepth = Math.min(maxZ, project.stock.thickness) - Math.max(minZ, 0)
  if (overlapWidth <= Z_EPSILON || overlapHeight <= Z_EPSILON || overlapDepth <= Z_EPSILON) {
    return { candidate: null, reason: 'The transformed imported mesh does not overlap the stock with machinable volume.' }
  }

  return {
    candidate: {
      feature,
      constraints: {
        requiredCutDepth: Math.max(0, project.stock.thickness - Math.max(minZ, 0)),
        maximumToolDiameter: Math.min(overlapWidth, overlapHeight) * CAM_PLAN_INTERIOR_TOOL_FRACTION,
        toolLimitSource: 'model-footprint',
      },
    },
    reason: null,
  }
}

function addImportedModelSurfacePair(builder: PlanBuilder, candidate: ImportedModelCandidate): void {
  const { feature, constraints } = candidate
  const rough = addPlannedOperation(
    builder,
    'rough_surface',
    'rough',
    [feature],
    'This imported model intersects the stock, so rough its transformed surface before finishing it.',
    [],
    undefined,
    constraints,
  )
  addPlannedOperation(
    builder,
    'finish_surface',
    'finish',
    [feature],
    'This imported model needs a dedicated finish pass after roughing.',
    rough ? [rough.key] : [],
    undefined,
    constraints,
  )
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
      targetLabel: targetLabel(builder.project, features),
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

function resolvedNonTargetSubtractFeatureIdsForOperation(project: Project, operation: Operation): Set<string> {
  if (operation.target.source !== 'features') return new Set()
  const resolved = operation.kind === 'pocket'
    ? resolvePocketRegions(project, operation)
    : operation.kind === 'edge_route_inside'
      ? resolveInsideEdgeRegions(project, operation)
      : null
  const directTargetIds = new Set(operation.target.featureIds)
  const subtractIds = new Set<string>()
  for (const band of resolved?.bands ?? []) {
    for (const featureId of band.targetFeatureIds) {
      if (!directTargetIds.has(featureId)) subtractIds.add(featureId)
    }
  }
  return subtractIds
}

function resolvedNonTargetSubtractFeatureIds(builder: PlanBuilder): Set<string> {
  const subtractIds = new Set<string>()
  for (const draft of builder.operations) {
    if (draft.rest) continue
    for (const featureId of resolvedNonTargetSubtractFeatureIdsForOperation(builder.analysisProject, draft.operation)) {
      subtractIds.add(featureId)
    }
  }
  return subtractIds
}

interface PocketToolGroup {
  features: ResolvedSketchFeature[]
  tool: CamPlanTool | null
}

interface OutsideEdgeToolGroup {
  features: ResolvedSketchFeature[]
  tool: CamPlanTool | null
}

function pocketToolForFeature(builder: PlanBuilder, feature: ResolvedSketchFeature): CamPlanTool | null {
  const target: OperationTarget = { source: 'features', featureIds: [feature.id] }
  const ranked = rankCamPlanTools(
    builder.project,
    'pocket',
    target,
    builder.tools,
    featureDepth(builder.project, feature),
    builder.reusedToolIds,
  )
  return ranked.tools[0] ?? null
}

function outsideEdgeToolForFeature(builder: PlanBuilder, feature: ResolvedSketchFeature): CamPlanTool | null {
  const target: OperationTarget = { source: 'features', featureIds: [feature.id] }
  const ranked = rankCamPlanTools(
    builder.project,
    'edge_route_outside',
    target,
    builder.tools,
    featureDepth(builder.project, feature),
    builder.reusedToolIds,
  )
  return ranked.tools[0] ?? null
}

function pocketAnalysisOperation(builder: PlanBuilder, features: ResolvedSketchFeature[]): Operation {
  const target: OperationTarget = { source: 'features', featureIds: features.map((feature) => feature.id) }
  const operation = defaultOperationForTarget(
    builder.analysisProject,
    'pocket',
    'rough',
    target,
    builder.project.operations.length,
    { tool: defaultTool(builder.project.meta.units, 1), toolRef: null },
  )
  operation.target = target
  return operation
}

function pocketWouldFoldFeature(builder: PlanBuilder, features: ResolvedSketchFeature[], featureId: string): boolean {
  return resolvedNonTargetSubtractFeatureIdsForOperation(
    builder.analysisProject,
    pocketAnalysisOperation(builder, features),
  ).has(featureId)
}

function toolCanMachineConnectedPocketFeature(
  builder: PlanBuilder,
  tool: CamPlanTool,
  feature: ResolvedSketchFeature,
): boolean {
  const bounds = getFeatureGeometryBounds(feature)
  const narrowestSpan = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
  const reachesDepth = tool.tool.maxCutDepth <= 0 || tool.tool.maxCutDepth + Z_EPSILON >= featureDepth(builder.project, feature)
  return tool.tool.diameter <= narrowestSpan + Z_EPSILON && reachesDepth
}

function touchesDirectPocketTarget(
  directTargets: ResolvedSketchFeature[],
  candidate: ResolvedSketchFeature,
): boolean {
  return directTargets.some((target) => featuresOverlap(target, candidate))
}

/**
 * Group disjoint blind pockets when they choose the same primary cutter. Each
 * target keeps its own span in the resolver, so depth is not a grouping key.
 * A subtract already folded into a surrounding pocket stays out of the direct
 * target list, preserving the #526/#751 parent-pocket ownership rule.
 */
function nextBlindPocketToolGroup(
  builder: PlanBuilder,
  remaining: ResolvedSketchFeature[],
): PocketToolGroup | null {
  while (remaining.length > 0) {
    const root = remaining.shift()
    if (!root || resolvedNonTargetSubtractFeatureIds(builder).has(root.id)) continue

    const tool = pocketToolForFeature(builder, root)
    const grouped = [root]
    if (tool) {
      for (let index = 0; index < remaining.length;) {
        const candidate = remaining[index]!
        const candidateTool = pocketToolForFeature(builder, candidate)
        if (pocketWouldFoldFeature(builder, grouped, candidate.id)) {
          index += 1
          continue
        }
        const sharesTargetBoundary = touchesDirectPocketTarget(grouped, candidate)
        const sharesSelectedTool = candidateTool?.id === tool.id
        const selectedToolFitsConnectedFeature = sharesTargetBoundary
          && toolCanMachineConnectedPocketFeature(builder, tool, candidate)
        if (sharesSelectedTool || selectedToolFitsConnectedFeature) {
          grouped.push(candidate)
          remaining.splice(index, 1)
          continue
        }
        index += 1
      }
    }
    return { features: grouped, tool }
  }
  return null
}

/**
 * Group disjoint outer profiles only when their individually selected rough
 * cutter is identical. Feature-first edge routing and shared tab placement
 * already preserve per-profile geometry, so depth is not a grouping key.
 */
function nextOutsideEdgeToolGroup(
  builder: PlanBuilder,
  remaining: ResolvedSketchFeature[],
): OutsideEdgeToolGroup | null {
  const root = remaining.shift()
  if (!root) return null

  const tool = outsideEdgeToolForFeature(builder, root)
  const grouped = [root]
  if (tool) {
    for (let index = 0; index < remaining.length;) {
      const candidate = remaining[index]!
      if (outsideEdgeToolForFeature(builder, candidate)?.id === tool.id) {
        grouped.push(candidate)
        remaining.splice(index, 1)
        continue
      }
      index += 1
    }
  }
  return { features: grouped, tool }
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
    const unresolvedDetail = builder.unresolvedModels.get(feature.id)
    if (unresolvedDetail) {
      return [{ featureId: feature.id, featureName: feature.name, status: 'unresolved', detail: unresolvedDetail }]
    }
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
      return [{ featureId: feature.id, featureName: feature.name, status: 'unresolved', detail: 'The imported model cannot be planned safely.' }]
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
    existing: new Set(),
    unresolvedModels: new Map(),
    sequence: 0,
  }

  const closedAddBoundaries = features.filter((feature) =>
    (feature.operation === 'add' || feature.operation === 'model')
    && feature.kind !== 'stl'
    && feature.sketch.profile.closed,
  )
  const closedAdds = closedAddBoundaries
  const outerClosedAdds = closedAdds.filter((feature) =>
    !closedAddBoundaries.some((candidate) => candidate.id !== feature.id && boundsContain(candidate, feature)),
  )
  const loweredOuterAdds = outerClosedAdds.filter((feature) =>
    resolveDimensionRef(project, feature.z_top) < project.stock.thickness - Z_EPSILON,
  )
  for (const group of groupByDepth(project, loweredOuterAdds)) {
    addRoughFinishPair(builder, 'surface_clean', group, 'This retained surface sits below the stock top and needs cleanup.')
  }

  const subtracts = features.filter((feature) =>
    feature.operation === 'subtract'
    && feature.sketch.profile.closed,
  )
  const ordinarySubtracts: ResolvedSketchFeature[] = []
  for (const group of groupDrillingCandidates(project, subtracts.filter((candidate) => candidate.kind === 'circle'))) {
    const target: OperationTarget = { source: 'features', featureIds: group.map((feature) => feature.id) }
    const requiredDepth = Math.max(...group.map((feature) => featureDepth(project, feature)))
    const drillability = chooseDrillingTool(project, target, tools, requiredDepth, builder.reusedToolIds)
    if (!drillability) {
      ordinarySubtracts.push(...group)
      continue
    }
    const drill = addPlannedOperation(
      builder,
      'drilling',
      'rough',
      group,
      drillability.drillType === 'simple'
        ? 'The matching circular subtracts share an available drill.'
        : 'The matching circular subtracts can be helical-bored with a smaller flat end mill.',
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
  const remainingBlind = [...blind]
  for (let group = nextBlindPocketToolGroup(builder, remainingBlind); group; group = nextBlindPocketToolGroup(builder, remainingBlind)) {
    addRoughFinishPair(
      builder,
      'pocket',
      group.features,
      'This closed subtract stops above the stock bottom, so it is a blind pocket.',
      group.tool ?? undefined,
    )
  }
  for (const group of groupByDepth(project, through)) {
    addRoughFinishPair(builder, 'edge_route_inside', group, 'This closed subtract reaches the stock bottom, so the removable slug is routed on its inside edge.')
  }

  for (const feature of features.filter((candidate) => candidate.operation === 'model' && candidate.kind === 'stl')) {
    const result = importedModelCandidate(project, feature)
    if (!result.candidate) {
      builder.unresolvedModels.set(feature.id, result.reason ?? 'The imported model cannot be planned safely.')
      continue
    }
    addImportedModelSurfacePair(builder, result.candidate)
  }

  const outerAdds = outerClosedAdds.filter((feature) =>
    resolveDimensionRef(project, feature.z_bottom) <= Z_EPSILON
  )
  const outsideOperations: CamPlanOperationDraft[] = []
  const remainingOuterAdds = [...outerAdds]
  for (let group = nextOutsideEdgeToolGroup(builder, remainingOuterAdds); group; group = nextOutsideEdgeToolGroup(builder, remainingOuterAdds)) {
    outsideOperations.push(...addRoughFinishPair(
      builder,
      'edge_route_outside',
      group.features,
      'This is an outer retained perimeter, so it is routed from the surrounding stock.',
      group.tool ?? undefined,
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
