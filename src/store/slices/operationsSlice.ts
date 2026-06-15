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

import type { StateCreator } from 'zustand'
import { generateEdgeRestRegionDrafts, generatePocketRestRegionDrafts } from '../../engine/toolpaths/restRegions'
import { selectToolForOperation } from '../../engine/operations/toolSelection'
import { uniqueName } from '../../import'
import { defaultTool, inferFeatureKind } from '../../types/project'
import type {
  FeatureFolder,
  Operation,
  OperationKind,
  OperationPass,
  OperationTarget,
  Project,
  SketchFeature,
  Tool,
} from '../../types/project'
import { nextUniqueGeneratedId } from '../helpers/ids'
import { normalizeFeatureZRange } from '../helpers/normalize'
import type { ProjectStore } from '../types'

export interface OperationsSliceDependencies {
  cloneProject: (project: Project) => Project
  projectsEqual: (a: Project, b: Project) => boolean
  toolMatchesTemplate: (existingTool: Tool, candidate: Omit<Tool, 'id'>) => boolean
  isOperationTargetValid: (project: Project, kind: OperationKind, target: OperationTarget) => boolean
  defaultOperationForTarget: (
    project: Project,
    kind: OperationKind,
    pass: OperationPass,
    target: OperationTarget,
    index: number,
    resolved?: { tool: Tool; toolRef: string | null },
  ) => Operation
  defaultOperationName: (kind: OperationKind, pass: OperationPass, operations: Operation[]) => string
  uniqueFolderName: (preferred: string, folders: FeatureFolder[]) => string
  syncFeatureTreeProject: (project: Project) => Project
}

export type OperationsSlice = Pick<
  ProjectStore,
  | 'addOperation'
  | 'updateOperation'
  | 'createRestOperation'
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
  deps: OperationsSliceDependencies,
): OperationsSlice {
  const {
    cloneProject,
    projectsEqual,
    toolMatchesTemplate,
    isOperationTargetValid,
    defaultOperationForTarget,
    defaultOperationName,
    uniqueFolderName,
    syncFeatureTreeProject,
  } = deps

  return {
    addOperation: (kind, pass, target, libraryTools) => {
      const state = get()
      if (!isOperationTargetValid(state.project, kind, target)) {
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
        resolvedTool = state.project.tools[0] ?? defaultTool(state.project.meta.units, 1)
        resolvedToolRef = state.project.tools[0]?.id ?? null
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
        const nextProject = {
          ...s.project,
          operations: s.project.operations.map((operation) => {
            if (operation.id !== id) {
              return operation
            }

            const nextOperation = { ...operation, ...patch }
            return isOperationTargetValid(s.project, nextOperation.kind, nextOperation.target)
              ? nextOperation
              : operation
          }),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        return {
          project: nextProject,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    createRestOperation: (operationId) => {
      const state = get()
      const operation = state.project.operations.find((item) => item.id === operationId)
      if (!operation) {
        return { operationId: null, regionIds: [], warnings: ['Operation not found'] }
      }
      if ((operation.kind !== 'pocket' && operation.kind !== 'edge_route_inside' && operation.kind !== 'edge_route_outside') || operation.target.source !== 'features') {
        return { operationId: null, regionIds: [], warnings: ['Rest operations can only be created from pocket or edge-route operations with feature targets'] }
      }

      if (operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside') {
        const result = generateEdgeRestRegionDrafts(state.project, operation)
        if (result.drafts.length === 0) {
          return { operationId: null, regionIds: [], warnings: result.warnings }
        }

        let nextProjectLike = state.project
        const targetFeatures = operation.target.featureIds
          .map((featureId) => state.project.features.find((item) => item.id === featureId) ?? null)
          .filter((feature): feature is SketchFeature => feature !== null)
        const machiningTargetIds = targetFeatures
          .filter((feature) => feature.operation !== 'region')
          .map((feature) => feature.id)
        const restFolderId = nextUniqueGeneratedId(nextProjectLike, 'fd')
        const restFolder: FeatureFolder = {
          id: restFolderId,
          name: uniqueFolderName(`${operation.name || defaultOperationName(operation.kind, operation.pass, state.project.operations)} Rest Regions`, state.project.featureFolders),
          collapsed: false,
          section: 'regions',
        }
        nextProjectLike = {
          ...nextProjectLike,
          featureFolders: [...nextProjectLike.featureFolders, restFolder],
        }
        const createdFeatures: SketchFeature[] = result.drafts.map((draft, index) => {
          const id = nextUniqueGeneratedId(nextProjectLike, 'f')
          const feature = normalizeFeatureZRange({
            id,
            name: uniqueName(
              `${operation.name || defaultOperationName(operation.kind, operation.pass, state.project.operations)} Rest Region${result.drafts.length > 1 ? ` ${index + 1}` : ''}`,
              nextProjectLike.features.map((feature) => feature.name),
            ),
            kind: inferFeatureKind(draft.profile),
            folderId: restFolderId,
            sketch: {
              profile: draft.profile,
              origin: { x: 0, y: 0 },
              orientationAngle: 0,
              dimensions: [],
              constraints: [],
            },
            operation: 'region',
            z_top: state.project.stock.thickness,
            z_bottom: 0,
            visible: true,
            locked: false,
          })
          nextProjectLike = {
            ...nextProjectLike,
            features: [...nextProjectLike.features, feature],
          }
          return feature
        })
        const createdIds = createdFeatures.map((feature) => feature.id)
        const restTarget: OperationTarget = {
          source: 'features',
          featureIds: [...machiningTargetIds, ...createdIds],
        }
        const nextOperationId = nextUniqueGeneratedId(nextProjectLike, 'op')
        const restOperation: Operation = {
          ...operation,
          id: nextOperationId,
          name: uniqueName(`${operation.name || defaultOperationName(operation.kind, operation.pass, state.project.operations)} Rest`, state.project.operations.map((item) => item.name)),
          showToolpath: true,
          target: restTarget,
          toolRef: null,
        }

        set((s) => {
          const nextProject = syncFeatureTreeProject({
            ...s.project,
            featureFolders: [...s.project.featureFolders, restFolder],
            features: [...s.project.features, ...createdFeatures],
            operations: [...s.project.operations, restOperation],
            featureTree: [...s.project.featureTree, { type: 'folder', folderId: restFolder.id }],
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          })

          return {
            project: nextProject,
            history: {
              past: [...s.history.past, cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
          }
        })

        return { operationId: nextOperationId, regionIds: createdIds, warnings: result.warnings }
      }

      const result = generatePocketRestRegionDrafts(state.project, operation)
      if (result.drafts.length === 0) {
        return { operationId: null, regionIds: [], warnings: result.warnings }
      }

      let nextProjectLike = state.project
      const restFolderId = nextUniqueGeneratedId(nextProjectLike, 'fd')
      const restFolder: FeatureFolder = {
        id: restFolderId,
        name: uniqueFolderName(`${operation.name || 'Pocket'} Rest Regions`, state.project.featureFolders),
        collapsed: false,
        section: 'regions',
      }
      nextProjectLike = {
        ...nextProjectLike,
        featureFolders: [...nextProjectLike.featureFolders, restFolder],
      }
      const createdFeatures: SketchFeature[] = result.drafts.map((draft, index) => {
        const id = nextUniqueGeneratedId(nextProjectLike, 'f')
        const feature = normalizeFeatureZRange({
          id,
          name: uniqueName(
            `${operation.name || 'Pocket'} Rest Region${result.drafts.length > 1 ? ` ${index + 1}` : ''}`,
            nextProjectLike.features.map((feature) => feature.name),
          ),
          kind: inferFeatureKind(draft.profile),
          folderId: restFolderId,
          sketch: {
            profile: draft.profile,
            origin: { x: 0, y: 0 },
            orientationAngle: 0,
            dimensions: [],
            constraints: [],
          },
          operation: 'region',
          z_top: state.project.stock.thickness,
          z_bottom: 0,
          visible: true,
          locked: false,
        })
        nextProjectLike = {
          ...nextProjectLike,
          features: [...nextProjectLike.features, feature],
        }
        return feature
      })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const machiningTargetIds = operation.target.featureIds.filter((featureId) => {
        const feature = state.project.features.find((item) => item.id === featureId)
        return feature?.operation !== 'region'
      })
      const restTarget: OperationTarget = {
        source: 'features',
        featureIds: [...machiningTargetIds, ...createdIds],
      }
      const nextOperationId = nextUniqueGeneratedId(nextProjectLike, 'op')
      const restOperation: Operation = {
        ...operation,
        id: nextOperationId,
        name: uniqueName(`${operation.name || 'Pocket'} Rest`, state.project.operations.map((item) => item.name)),
        pass: 'rough',
        showToolpath: true,
        target: restTarget,
        toolRef: null,
      }

      set((s) => {
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          featureFolders: [...s.project.featureFolders, restFolder],
          features: [...s.project.features, ...createdFeatures],
          operations: [...s.project.operations, restOperation],
          featureTree: [
            ...s.project.featureTree,
            { type: 'folder', folderId: restFolderId },
          ],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })

        return {
          project: nextProject,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })

      return { operationId: nextOperationId, regionIds: createdIds, warnings: result.warnings }
    },

    setAllOperationToolpathVisibility: (visible) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          operations: s.project.operations.map((operation) => ({
            ...operation,
            showToolpath: visible,
          })),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        return {
          project: nextProject,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    deleteOperation: (id) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          operations: s.project.operations.filter((operation) => operation.id !== id),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        return {
          project: nextProject,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    duplicateOperation: (id) => {
      const state = get()
      const sourceOperation = state.project.operations.find((operation) => operation.id === id)
      if (!sourceOperation) {
        return null
      }

      const nextId = nextUniqueGeneratedId(state.project, 'op')
      const duplicate: Operation = {
        ...sourceOperation,
        id: nextId,
        name: duplicateOperationName(sourceOperation.name, state.project.operations),
        showToolpath: true,
      }

      set((s) => ({
        project: {
          ...s.project,
          operations: [...s.project.operations, duplicate],
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

    reorderOperations: (ids) =>
      set((s) => {
        const byId = new Map(s.project.operations.map((operation) => [operation.id, operation]))
        const reordered = ids
          .map((id) => byId.get(id))
          .filter((operation): operation is Operation => Boolean(operation))

        const untouched = s.project.operations.filter((operation) => !ids.includes(operation.id))
        const nextOperations = [...reordered, ...untouched]
        const nextProject = {
          ...s.project,
          operations: nextOperations,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        return {
          project: nextProject,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),
  }
}
