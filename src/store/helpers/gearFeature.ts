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

import {
  circleProfile,
  type FeatureFolder,
  type FeatureTreeEntry,
  type Point,
  type Project,
  type SketchFeature,
} from '../../types/project'
import type { StateCreator } from 'zustand'
import {
  buildGearProfile,
  validateGearProfileParams,
  type GearCreationParams,
} from '../../sketch/gearProfile'
import { uniqueName } from '../../import'
import type { ProjectStore } from '../types'
import { buildShapeFeature } from './buildShapeFeature'
import { createDefinitionForFeature, createFeatureInstance } from './featureDefinitions'
import { isMachinable, sectionForOperation } from './featureRoles'
import { nextUniqueGeneratedId } from './ids'
import { cloneProject, normalizeFeatureZRange, syncFeatureTreeProject } from './normalize'
import { resolvedProjectFeatures } from './resolveFeatures'

interface GroupedGearInsertResult {
  createdIds: string[]
  project: Project
  selection: ProjectStore['selection']
  history: ProjectStore['history']
}

const GEAR_NAME_PATTERN = /^Gear (\d+)$/
const GEAR_BORE_NAME_PATTERN = /^Gear Bore (\d+)$/

function gearNumberFromName(name: string): number | null {
  const match = GEAR_NAME_PATTERN.exec(name) ?? GEAR_BORE_NAME_PATTERN.exec(name)
  if (!match) {
    return null
  }
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : null
}

function nextGearNumber(project: Project, section: FeatureFolder['section']): number {
  const used = new Set<number>()
  for (const folder of project.featureFolders) {
    if ((folder.section ?? 'features') !== section) {
      continue
    }
    const value = gearNumberFromName(folder.name)
    if (value !== null) {
      used.add(value)
    }
  }
  for (const feature of resolvedProjectFeatures(project)) {
    if (sectionForOperation(feature.operation) !== section) {
      continue
    }
    const value = gearNumberFromName(feature.name)
    if (value !== null) {
      used.add(value)
    }
  }

  let candidate = 1
  while (used.has(candidate)) {
    candidate += 1
  }
  return candidate
}

function insertRootTreeEntryAfterSelection(
  project: Project,
  selectedNode: ProjectStore['selection']['selectedNode'],
  entry: FeatureTreeEntry,
): FeatureTreeEntry[] {
  let insertAfterIndex = -1

  if (selectedNode?.type === 'folder') {
    insertAfterIndex = project.featureTree.findIndex(
      (candidate) => candidate.type === 'folder' && candidate.folderId === selectedNode.folderId,
    )
  } else if (selectedNode?.type === 'feature') {
    const selectedFeature = project.features.find((feature) => feature.id === selectedNode.featureId)
    if (selectedFeature?.folderId) {
      insertAfterIndex = project.featureTree.findIndex(
        (candidate) => candidate.type === 'folder' && candidate.folderId === selectedFeature.folderId,
      )
    } else {
      insertAfterIndex = project.featureTree.findIndex(
        (candidate) => candidate.type === 'feature' && candidate.featureId === selectedNode.featureId,
      )
    }
  }

  if (insertAfterIndex < 0) {
    return [...project.featureTree, entry]
  }

  return [
    ...project.featureTree.slice(0, insertAfterIndex + 1),
    entry,
    ...project.featureTree.slice(insertAfterIndex + 1),
  ]
}

export function createGroupedGearFeatureInsert(
  state: ProjectStore,
  name: string,
  center: Point,
  outsideRadius: number,
  params: GearCreationParams,
  depth: number,
): GroupedGearInsertResult {
  const rawGearFeature = buildShapeFeature(
    state.project,
    state.creationTarget,
    'composite',
    buildGearProfile({ ...params, center, outsideRadius }),
    name,
    depth,
  )
  const isFirstMachiningFeature = isMachinable(rawGearFeature)
    && !resolvedProjectFeatures(state.project).some(isMachinable)
  const section = sectionForOperation(isFirstMachiningFeature ? 'add' : rawGearFeature.operation)
  const gearNumber = nextGearNumber(state.project, section)
  const gearName = uniqueName(`Gear ${gearNumber}`, state.project.features.map((feature) => feature.name))
  const safeGearBase = normalizeFeatureZRange({
    ...rawGearFeature,
    name: gearName,
    operation: isFirstMachiningFeature ? 'add' : rawGearFeature.operation,
  })
  const groupFolderId = nextUniqueGeneratedId(state.project, 'fd')
  const groupFolder: FeatureFolder = {
    id: groupFolderId,
    name: uniqueName(`Gear ${gearNumber}`, state.project.featureFolders.map((folder) => folder.name)),
    collapsed: false,
    section,
    grouped: true,
  }

  const safeGear: SketchFeature = {
    ...safeGearBase,
    folderId: groupFolderId,
  }
  const boreFeatureBase = normalizeFeatureZRange({
    id: nextUniqueGeneratedId(state.project, 'f'),
    name: uniqueName(`Gear Bore ${gearNumber}`, [
      ...state.project.features.map((feature) => feature.name),
      safeGear.name,
    ]),
    kind: 'circle',
    folderId: groupFolderId,
    sketch: {
      profile: circleProfile(center.x, center.y, params.boreDiameter / 2),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: safeGear.z_top,
    z_bottom: safeGear.z_bottom,
    visible: true,
    locked: false,
  })
  const safeBore: SketchFeature = {
    ...boreFeatureBase,
    folderId: groupFolderId,
  }

  const gearMinted = createDefinitionForFeature(state.project, safeGear)
  const gearInstance = createFeatureInstance(safeGear, gearMinted.definitionId)

  const boreMinted = createDefinitionForFeature(
    state.project,
    safeBore,
  )
  const boreInstance = createFeatureInstance(safeBore, boreMinted.definitionId)

  const createdIds = [safeGear.id, safeBore.id]
  const project = syncFeatureTreeProject({
    ...state.project,
    featureFolders: [...state.project.featureFolders, groupFolder],
    features: [...state.project.features, gearInstance, boreInstance],
    featureTree: insertRootTreeEntryAfterSelection(
      state.project,
      state.selection.selectedNode,
      { type: 'folder', folderId: groupFolderId },
    ),
    featureDefinitions: {
      ...state.project.featureDefinitions,
      [gearMinted.definitionId]: gearMinted.definition,
      [boreMinted.definitionId]: boreMinted.definition,
    },
    meta: { ...state.project.meta, modified: new Date().toISOString() },
  })

  return {
    createdIds,
    project,
    selection: {
      ...state.selection,
      selectedFeatureId: safeGear.id,
      selectedFeatureIds: createdIds,
      selectedNode: { type: 'folder', folderId: groupFolderId },
      mode: 'feature',
      activeControl: null,
      groupFolderId,
    },
    history: {
      past: [...state.history.past, cloneProject(state.project)].slice(-100),
      future: [],
      transactionStart: null,
    },
  }
}

export function createAddGearFeatureAction(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): ProjectStore['addGearFeature'] {
  return (name, center, outsideRadius, params, depth) => {
    const state = get()
    const profileParams = { ...params, center, outsideRadius }
    const errors = validateGearProfileParams(profileParams)
    if (errors.length > 0) {
      return []
    }

    const gearFeature = buildShapeFeature(
      state.project,
      state.creationTarget,
      'composite',
      buildGearProfile(profileParams),
      name,
      depth,
    )
    const shouldCreateBore = params.boreDiameter > 0 && sectionForOperation(gearFeature.operation) === 'features'

    if (!shouldCreateBore) {
      state.addFeature(gearFeature)
      return [gearFeature.id]
    }

    let createdIds: string[] = []
    set((s) => {
      const result = createGroupedGearFeatureInsert(s, name, center, outsideRadius, params, depth)
      createdIds = result.createdIds
      return {
        project: result.project,
        selection: result.selection,
        history: result.history,
      }
    })
    return createdIds
  }
}
