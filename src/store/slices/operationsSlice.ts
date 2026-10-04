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

import { isToolCompatibleWithOperation, withCompatibleOperationTool } from '../../toolPolicy'
import type { StateCreator } from 'zustand'
import { generateEdgeRestRegionDrafts, generatePocketRestRegionDrafts } from '../../engine/toolpaths/restRegions'
import { selectToolForOperation } from '../../engine/operations/toolSelection'
import { materializeCamPlan } from '../helpers/camPlanApply'
import { uniqueName } from '../../import'
import { defaultTool, inferFeatureKind } from '../../types/project'
import type {
  FeatureFolder,
  Operation,
  OperationTarget,
  SketchFeature,
  Tool,
} from '../../types/project'
import { isMachinable } from '../helpers/featureRoles'
import { nextUniqueGeneratedId } from '../helpers/ids'
import { cloneProject, normalizeFeatureZRange, projectsEqual, syncFeatureTreeProject } from '../helpers/normalize'
import { uniqueFolderName } from '../helpers/naming'
import { defaultOperationForTarget, defaultOperationName, isOperationTargetValid, toolMatchesTemplate } from '../helpers/operationDefaults'
import { rejectedOperationTargets, targetAllowedInSetup } from '../../engine/setupTargets'
import { createDefinitionForFeature, createFeatureInstance } from '../helpers/featureDefinitions'
import { resolveFeatureInstance } from '../helpers/resolveFeatures'
import type { ProjectStore } from '../types'

export type OperationsSlice = Pick<
  ProjectStore,
  | 'addOperation'
  | 'updateOperation'
  | 'createRestOperation'
  | 'applyCamPlan'
  | 'setAllOperationToolpathVisibility'
  | 'deleteOperation'
  | 'duplicateOperation'
  | 'reorderOperations'
>

function duplicateOperationName(name: string, operations: Operation[]): string {
  const baseName = `${name} Copy`
  if (!operations.some((operation) => operation.name === baseName)) {
    return baseName
  }

  let index = 2
  while (operations.some((operation) => operation.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

export function createOperationsSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): OperationsSlice {

  return {
    applyCamPlan: (plan) => {
      const state = get()
      const result = materializeCamPlan(state.project, plan)
      if (!result.ok) return result
      set((current) => ({
        project: result.project,
        history: {
          past: [...current.history.past, cloneProject(current.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }))
      return { ok: true, operationIds: result.operationIds }
    },

    addOperation: (kind, pass, target, libraryTools) => {
      const state = get()
      if (!isOperationTargetValid(state.project, kind, target)) {
        return null
      }
      // A new operation joins the active setup, so its targets are judged
      // from that setup's face (issue #946).
      if (!targetAllowedInSetup(state.project, target, state.project.activeSetupId)) {
        return null
      }

      const nextId = nextUniqueGeneratedId(state.project, 'op')

      // Choose a proper tool for this operation (type/units/feature size) instead
      // of always using tools[0]. An 'import' result is added to the project's
      // tool list in the same undo step; operation defaults derive from it.
      const selection = selectToolForOperation(state.project, kind, target, libraryTools ?? [])
      let toolToAdd: Tool | null = null
      let resolvedTool: Tool
      let resolvedToolRef: string | null

      if (selection?.source === 'existing') {
        resolvedTool = state.project.tools.find((tool) => tool.id === selection.toolId) ?? defaultTool(state.project.meta.units, 1)
        resolvedToolRef = selection.toolId
      } else if (selection?.source === 'import') {
        const existingMatch = state.project.tools.find((tool) => toolMatchesTemplate(tool, selection.tool))
        if (existingMatch) {
          resolvedTool = existingMatch
          resolvedToolRef = existingMatch.id
        } else {
          toolToAdd = { ...selection.tool, id: nextUniqueGeneratedId(state.project, 't') }
          resolvedTool = toolToAdd
          resolvedToolRef = toolToAdd.id
        }
      } else {
        const fallback = state.project.tools.find((tool) => isToolCompatibleWithOperation(tool, kind))
        resolvedTool = fallback ?? defaultTool(state.project.meta.units, 1)
        resolvedToolRef = fallback?.id ?? null
      }

      const template = defaultOperationForTarget(
        state.project,
        kind,
        pass,
        target,
        state.project.operations.length,
        { tool: resolvedTool, toolRef: resolvedToolRef },
      )
      const operation: Operation = {
        ...template,
        id: nextId,
        showToolpath: true,
        pass,
      }

      set((s) => ({
        project: {
          ...s.project,
          tools: toolToAdd ? [...s.project.tools, toolToAdd] : s.project.tools,
          operations: [...s.project.operations, operation],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }))

      return nextId
    },

    updateOperation: (id, patch) =>
      set((s) => {
        const current = s.project.operations.find((operation) => operation.id === id)
        if (current) {
          const next = { ...current, ...patch }
          const tool = s.project.tools.find((candidate) => candidate.id === next.toolRef)
          if (tool && !isToolCompatibleWithOperation(tool, next.kind)
            && (patch.toolRef !== undefined || patch.kind !== undefined)) return {}
        }
        const nextProject = {
          ...s.project,
          operations: s.project.operations.map((operation) => {
            if (operation.id !== id) {
              return operation
            }

            const nextOperation = withCompatibleOperationTool(s.project, { ...operation, ...patch })
            if (!isOperationTargetValid(s.project, nextOperation.kind, nextOperation.target)) {
              return operation
            }
            // A target or setup edit may not hand the operation a feature its
            // setup cannot reach (issue #946). Judged on what the edit adds: a
            // target that became unreachable some other way — its feature was
            // made shallower — must not lock every later edit out, including
            // the one that removes it.
            if (patch.target !== undefined || patch.setupId !== undefined) {
              const before = new Set(rejectedOperationTargets(s.project, operation).map((verdict) => verdict.featureId))
              const introduced = rejectedOperationTargets(s.project, nextOperation)
                .some((verdict) => !before.has(verdict.featureId))
              if (introduced) return operation
            }
            return nextOperation
