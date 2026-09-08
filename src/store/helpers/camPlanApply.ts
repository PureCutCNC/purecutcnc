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

import type { CamPlanDraft, CamPlanOperationDraft } from '../../engine/operations/camPlan/types'
import { camPlanProjectFingerprint } from '../../engine/operations/camPlan/createCamPlan'
import { uniqueName } from '../../import'
import { inferFeatureKind, type FeatureFolder, type Operation, type OperationTarget, type Project, type SketchFeature, type Tab, type Tool } from '../../types/project'
import { createDefinitionForFeature, createFeatureInstance } from './featureDefinitions'
import { nextUniqueGeneratedId } from './ids'
import { normalizeFeatureZRange, syncFeatureTreeProject } from './normalize'
import { uniqueFolderName } from './naming'
import { isOperationTargetValid, toolMatchesTemplate } from './operationDefaults'

export type CamPlanMaterializationResult =
  | { ok: true; project: Project; operationIds: string[] }
  | { ok: false; reason: 'stale' | 'invalid'; message: string }

function importReferencedTools(project: Project, plan: CamPlanDraft, enabled: CamPlanOperationDraft[]): {
  project: Project
  toolIds: Map<string, string>
} {
  let next = project
  const toolIds = new Map(next.tools.map((tool) => [tool.id, tool.id]))
  const referenced = new Set(enabled.map((draft) => draft.operation.toolRef).filter((id): id is string => id !== null))
  for (const candidate of plan.tools) {
    if (!referenced.has(candidate.id) || candidate.source === 'existing') continue
    const template: Omit<Tool, 'id'> = {
      name: candidate.tool.name,
      units: candidate.tool.units,
      type: candidate.tool.type,
      diameter: candidate.tool.diameter,
      vBitAngle: candidate.tool.vBitAngle,
      flutes: candidate.tool.flutes,
      material: candidate.tool.material,
      defaultRpm: candidate.tool.defaultRpm,
      defaultFeed: candidate.tool.defaultFeed,
      defaultPlungeFeed: candidate.tool.defaultPlungeFeed,
      defaultStepdown: candidate.tool.defaultStepdown,
      defaultStepover: candidate.tool.defaultStepover,
      maxCutDepth: candidate.tool.maxCutDepth,
    }
    const existing = next.tools.find((tool) => toolMatchesTemplate(tool, template))
    if (existing) {
      toolIds.set(candidate.id, existing.id)
      continue
    }
    const id = nextUniqueGeneratedId(next, 't')
    next = { ...next, tools: [...next.tools, { ...template, id }] }
    toolIds.set(candidate.id, id)
  }
  return { project: next, toolIds }
}

function appendTabs(project: Project, plan: CamPlanDraft, enabledOperationKeys: ReadonlySet<string>): Project {
  let next = project
  for (const group of plan.sharedTabs.filter((draft) => (
    draft.enabled
    && !draft.reusedExistingTabs
    && draft.operationKeys.some((key) => enabledOperationKeys.has(key))
  ))) {
    for (const draft of group.tabs) {
      const tab: Tab = {
        ...draft,
        id: nextUniqueGeneratedId(next, 'tb'),
        name: uniqueName(draft.name, next.tabs.map((entry) => entry.name)),
      }
      next = { ...next, tabs: [...next.tabs, tab] }
    }
  }
  return next
}

function appendRestRegions(
  project: Project,
  draft: CamPlanOperationDraft,
): { project: Project; target: OperationTarget } {
  if (!draft.rest) return { project, target: draft.operation.target }
  let next = project
  const folder: FeatureFolder = {
    id: nextUniqueGeneratedId(next, 'fd'),
    name: uniqueFolderName(`${draft.operation.name} regions`, next.featureFolders),
    collapsed: false,
    section: 'regions',
  }
  next = { ...next, featureFolders: [...next.featureFolders, folder] }
  const regionIds: string[] = []

  for (const [index, region] of draft.rest.regions.entries()) {
    const id = nextUniqueGeneratedId(next, 'f')
    const feature = normalizeFeatureZRange({
      id,
      name: uniqueName(
        `${draft.operation.name} Region${draft.rest.regions.length > 1 ? ` ${index + 1}` : ''}`,
        next.features.map((entry) => entry.name),
      ),
      kind: inferFeatureKind(region.profile),
      folderId: folder.id,
      sketch: {
        profile: region.profile,
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'region',
      regionMaskMode: region.regionMaskMode ?? 'include',
      z_top: next.stock.thickness,
      z_bottom: 0,
      visible: true,
      locked: false,
    } satisfies SketchFeature)
    const created = createDefinitionForFeature(next, feature)
    const instance = createFeatureInstance(feature, created.definitionId)
    next = {
      ...next,
      features: [...next.features, instance],
      featureDefinitions: { ...next.featureDefinitions, [created.definition.id]: created.definition },
    }
    regionIds.push(id)
  }

  next = syncFeatureTreeProject({
    ...next,
    featureTree: [...next.featureTree, { type: 'folder', folderId: folder.id }],
  })
  return {
    project: next,
    target: { source: 'features', featureIds: [...draft.rest.sourceFeatureIds, ...regionIds] },
  }
}

export function materializeCamPlan(project: Project, plan: CamPlanDraft): CamPlanMaterializationResult {
  if (camPlanProjectFingerprint(project) !== plan.sourceFingerprint) {
    return { ok: false, reason: 'stale', message: 'The project changed after this plan was calculated. Recalculate it before creating operations.' }
  }
  const enabled = plan.operations.filter((draft) => draft.enabled)
  if (enabled.some((draft) => draft.hardError || draft.staleReason || !draft.operation.toolRef)) {
    return { ok: false, reason: 'invalid', message: 'The plan still contains an invalid or stale operation.' }
  }

  const imported = importReferencedTools(project, plan, enabled)
  const enabledOperationKeys = new Set(enabled.map((draft) => draft.key))
  let next = appendTabs(imported.project, plan, enabledOperationKeys)
  const operationIds: string[] = []
  for (const draft of enabled) {
    const withRegions = appendRestRegions(next, draft)
    next = withRegions.project
    const toolRef = draft.operation.toolRef ? imported.toolIds.get(draft.operation.toolRef) ?? null : null
    const operation: Operation = {
      ...draft.operation,
      id: nextUniqueGeneratedId(next, 'op'),
      name: uniqueName(draft.operation.name, next.operations.map((entry) => entry.name)),
      target: withRegions.target,
      toolRef,
      showToolpath: true,
    }
    if (!toolRef || !isOperationTargetValid(next, operation.kind, operation.target)) {
      return { ok: false, reason: 'invalid', message: `${draft.operation.name} no longer has a valid target or tool.` }
    }
    next = { ...next, operations: [...next.operations, operation] }
    operationIds.push(operation.id)
  }

  return {
    ok: true,
    project: syncFeatureTreeProject({
      ...next,
      meta: { ...next.meta, modified: new Date().toISOString() },
    }),
    operationIds,
  }
}
