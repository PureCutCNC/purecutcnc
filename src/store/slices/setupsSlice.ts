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

/**
 * Machining-setup actions (issue #944). Only what the Top/Bottom UI and CAM
 * slices build on: no cross-face validation lives here — moving an operation
 * or a feature to another face is accepted as asked, and the rules for what
 * may target what arrive with the CAM grouping slice (#946).
 */

import type { StateCreator } from 'zustand'
import { uniqueName } from '../../import'
import { isSupportedSetupOrientation, setupFace } from '../../engine/setupOrientation'
import type { MachiningSetup, Project } from '../../types/project'
import { nextUniqueGeneratedId } from '../helpers/ids'
import { cloneProject, projectsEqual } from '../helpers/normalize'
import { syncProjectSetups } from '../helpers/setups'
import type { ProjectStore } from '../types'

export type SetupsSlice = Pick<
  ProjectStore,
  | 'createSetup'
  | 'renameSetup'
  | 'deleteSetup'
  | 'setActiveSetup'
  | 'assignOperationToSetup'
  | 'setFeatureAuthoringFace'
>

type SetFn = Parameters<StateCreator<ProjectStore>>[0]

/**
 * Wrap the store's `set` so every project it writes has its setups in their
 * invariant: a new operation joins the active setup, a deleted one leaves its
 * setup's list, a reorder is reflected in it. The operation actions therefore
 * never have to know setups exist.
 */
export function withSetupSync<S extends { project: Project }>(
  set: (update: Partial<S> | ((state: S) => Partial<S>)) => void,
): (update: Partial<S> | ((state: S) => Partial<S>)) => void {
  const sync = (patch: Partial<S>): Partial<S> => {
    if (!patch.project) return patch
    const project = syncProjectSetups(patch.project)
    return project === patch.project ? patch : { ...patch, project }
  }
  return (update) => {
    if (typeof update === 'function') set((state) => sync(update(state)))
    else set(sync(update))
  }
}

function touched(project: Project): Project {
  return { ...project, meta: { ...project.meta, modified: new Date().toISOString() } }
}

export function createSetupsSlice(
  set: SetFn,
  get: Parameters<StateCreator<ProjectStore>>[1],
): SetupsSlice {
  /** Commit a project edit as one undo step, or do nothing when it changed nothing. */
  const commit = (edit: (project: Project) => Project | null): boolean => {
    let changed = false
    set((s) => {
      const edited = edit(s.project)
      if (!edited || projectsEqual(edited, s.project)) return {}
      changed = true
      const project = touched(edited)
      if (s.history.transactionStart) return { project }
      return {
        project,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    })
    return changed
  }

  return {
    createSetup: (input) => {
      if (!isSupportedSetupOrientation(input.orientation)) return null
      const project = get().project
      const id = nextUniqueGeneratedId(project, 'su')
      const face = setupFace(input)
      const setup: MachiningSetup = {
        id,
        name: uniqueName(
          input.name?.trim() || (face === 'top' ? 'Top' : 'Bottom'),
          project.setups.map((entry) => entry.name),
        ),
        orientation: { axis: input.orientation.axis, angleDeg: input.orientation.angleDeg },
        indexing: 'manual',
        registration: [],
        notes: '',
        operationIds: [],
      }
      return commit((current) => ({ ...current, setups: [...current.setups, setup] })) ? id : null
    },

    renameSetup: (id, name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      commit((project) => ({
        ...project,
        setups: project.setups.map((setup) => (setup.id === id ? { ...setup, name: trimmed } : setup)),
      }))
    },

    // A setup takes its operations with it, as one undo step. They are not
    // moved to another setup: that is a cross-face move, and a move needs the
    // validation an explicit Move action brings (#946).
    deleteSetup: (id) => commit((project) => {
      if (project.setups.length <= 1 || !project.setups.some((setup) => setup.id === id)) return null
      return {
        ...project,
        setups: project.setups.filter((setup) => setup.id !== id),
        operations: project.operations.filter((operation) => operation.setupId !== id),
      }
    }),

    // Which face the workspace is on is a view choice that travels with the
    // file: it adds no undo step and does not mark the project as changed.
    setActiveSetup: (id) =>
      set((s) => (
        s.project.activeSetupId === id || !s.project.setups.some((setup) => setup.id === id)
          ? {}
          : { project: { ...s.project, activeSetupId: id }, dirty: s.dirty }
      )),

    assignOperationToSetup: (operationId, setupId) => {
      commit((project) => (
        project.setups.some((setup) => setup.id === setupId)
          ? {
              ...project,
              operations: project.operations.map((operation) => (
                operation.id === operationId ? { ...operation, setupId } : operation
              )),
            }
          : null
      ))
    },

    // Only where the feature is drawn changes. `z_top`/`z_bottom` are the
    // feature's stock-space span and are deliberately left alone.
    setFeatureAuthoringFace: (featureIds, face) => {
      const ids = new Set(featureIds)
      commit((project) => ({
        ...project,
        features: project.features.map((feature) => (
          ids.has(feature.id) && !feature.locked && feature.authoringFace !== face
            ? { ...feature, authoringFace: face }
            : feature
        )),
      }))
    },
  }
}
