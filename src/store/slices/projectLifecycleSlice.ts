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
import {
  defaultGrid,
  defaultOrigin,
  defaultStock,
  isProjectVersionNewerThanSupported,
  LATEST_PROJECT_VERSION,
  type Project,
} from '../../types/project'
import type { ProjectStore } from '../types'
import {
  clearProjectMemoryCaches,
  cloneProject,
  instantiateProjectTemplate,
  projectsEqual,
} from '../helpers/normalize'
import { pruneUnusedModelAssets } from '../helpers/modelAssets'
import { emptySelection } from './selectionSlice'
import { decodeProjectFormat, type ProjectMigrationInfo } from '../helpers/projectFormat'
import { rescueMachinesToLibrary } from '../../machine/store'
import { machineLoadWarning } from '../../i18n/machineDiagnosticText'

/** Combine the independent load warnings into one message, or null if silent. */
function joinWarnings(...warnings: (string | null)[]): string | null {
  const present = warnings.filter((warning): warning is string => warning !== null)
  return present.length > 0 ? present.join('\n\n') : null
}

export interface ProjectLifecycleSliceDependencies {
  rawSet: Parameters<StateCreator<ProjectStore>>[0]
  normalizeProject: (project: Project, migrationInfo?: ProjectMigrationInfo) => Project
}

export type ProjectLifecycleSlice = Pick<
  ProjectStore,
  | 'createNewProject'
  | 'setProjectName'
  | 'setProjectClearances'
  | 'setShowDimensions'
  | 'setShowFeatureInfo'
  | 'setCopyMode'
  | 'clearLoadWarning'
  | 'loadProject'
  | 'saveProject'
  | 'openProjectFromText'
  | 'markSaved'
  | 'markExported'
  | 'markModelExported'
>

function freshMigrationInfo(): ProjectMigrationInfo {
  return {
    retractHeightsReexpressed: 0,
    edgeEntryStrategiesReset: 0,
    machineDiagnostics: [],
    rescuedMachineDefinitions: [],
    // Compaction may proceed only once the library write is durable (#1119).
    rescueMachineDefinitions: rescueMachinesToLibrary,
  }
}

export function createProjectLifecycleSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
  deps: ProjectLifecycleSliceDependencies,
): ProjectLifecycleSlice {
  const {
    normalizeProject,
  } = deps

  return {
    createNewProject: (template, name) =>
      set((state) => {
        clearProjectMemoryCaches()
        const info = freshMigrationInfo()
        const nextProject = normalizeProject(instantiateProjectTemplate(template, name), info)
        return {
          project: nextProject,
          machineLoadDiagnostics: info.machineDiagnostics,
          dirty: false,
          filePath: null,
          // A remembered export path belongs to the project it was exported
          // from; a new document must choose its own destination (issue #1081).
          lastExportPath: null,
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: null,
          pendingOffset: null,
          // A nest panel belongs to the project it was opened on (#886).
          pendingNest: null,
          nestSearching: false,
          selection: emptySelection(),
          projectKey: state.projectKey + 1,
          history: {
            past: [],
            future: [],
            transactionStart: null,
          },
        }
      }),

    setProjectName: (name) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          meta: { ...s.project.meta, name, modified: new Date().toISOString() },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        if (s.history.transactionStart) {
          return { project: nextProject }
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

    setProjectClearances: (patch) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            ...patch,
            modified: new Date().toISOString(),
          },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        if (s.history.transactionStart) {
          return { project: nextProject }
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

    setShowDimensions: (visible) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            showDimensions: visible,
            modified: new Date().toISOString(),
          },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        if (s.history.transactionStart) {
          return { project: nextProject }
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

    setShowFeatureInfo: (visible) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            showFeatureInfo: visible,
            modified: new Date().toISOString(),
          },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        if (s.history.transactionStart) {
          return { project: nextProject }
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

    setCopyMode: (mode) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            copyMode: mode,
            modified: new Date().toISOString(),
          },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        if (s.history.transactionStart) {
          return { project: nextProject }
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

    loadProject: (p) =>
      set((state) => {
        clearProjectMemoryCaches()
        const info = freshMigrationInfo()
        const normalizedProject = normalizeProject(p, info)
        const stockDefaults = defaultStock(undefined, undefined, undefined, normalizedProject.meta.units)
        const gridDefaults = defaultGrid(normalizedProject.meta.units)
        const nextProject = {
          ...normalizedProject,
          grid: {
            ...gridDefaults,
            ...normalizedProject.grid,
          },
          stock: {
            ...stockDefaults,
            ...normalizedProject.stock,
            origin: normalizedProject.stock?.origin ?? stockDefaults.origin,
            profile: normalizedProject.stock?.profile ?? stockDefaults.profile,
          },
          origin: normalizedProject.origin ?? defaultOrigin(normalizedProject.stock ?? stockDefaults),
        }
        clearProjectMemoryCaches()
        return {
          project: nextProject,
          machineLoadDiagnostics: info.machineDiagnostics,
          // Loading a document starts its export identity over, even though
          // the path it was loaded from is unrelated to any G-code file.
          lastExportPath: null,
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: null,
          pendingOffset: null,
          pendingNest: null,
          nestSearching: false,
          selection: emptySelection(),
          projectKey: state.projectKey + 1,
          history: {
            past: [],
            future: [],
            transactionStart: null,
          },
        }
      }),

    saveProject: () => {
      // Nest records are session state and stay out of the file (#889).
      const info = freshMigrationInfo()
      const { nests: _nests, ...p } = normalizeProject(pruneUnusedModelAssets(get().project), info)
      void _nests
      // Save normalization has the same rescue seam as a load: a machine the
      // in-memory project still carries is added to My Machines rather than
      // dropped from the saved file. If the library cannot store it, the
      // machine stays in the serialized project and the reason is surfaced
      // (#1119) — the returned JSON is never the place data is lost.
      const keptDiagnostics = info.machineDiagnostics.filter(
        (diagnostic) => diagnostic.kind === 'machine-kept-in-project',
      )
      if (keptDiagnostics.length > 0) {
        deps.rawSet({ machineLoadDiagnostics: info.machineDiagnostics })
      }
      const updated = {
        ...p,
        version: LATEST_PROJECT_VERSION,
        meta: { ...p.meta, modified: new Date().toISOString() },
      }
      return JSON.stringify(updated, null, 2)
    },

    openProjectFromText: (content, path) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        throw new Error('Failed to parse project file.')
      }
      const rawVersion = (parsed as { version?: string } | null)?.version
      const versionWarning = isProjectVersionNewerThanSupported(rawVersion)
        ? `This project was created with a newer version of PureCutCNC (file format ${rawVersion}; this build supports up to ${LATEST_PROJECT_VERSION}). It will still open, but newer features may be missing or display incorrectly.`
        : null
      // Decode owns the rescue seam: a legacy file's extra machines are stored
      // in My Machines before the project is compacted, and stay in the project
      // when that store cannot be made durable (#1119).
      const decoded = decodeProjectFormat(parsed, rescueMachinesToLibrary)
      const normalized = decoded.project
      const machineDiagnostics = decoded.machineMigration.diagnostics
      const machineWarning = machineLoadWarning(machineDiagnostics)
      // Compaction can also drop unmodified bundled copies the build supplies,
      // which is not a library move. Only a real move gets the library warning.
      const machineMovedToLibrary = machineDiagnostics.some(
        (diagnostic) => diagnostic.kind === 'machine-moved-to-library',
      )
      const migratedMachineLibrary = decoded.machineMigration.compacted || machineMovedToLibrary
      const stockDefaults = defaultStock(undefined, undefined, undefined, normalized.meta.units)
      const gridDefaults = defaultGrid(normalized.meta.units)
      clearProjectMemoryCaches()
      set((state) => ({
        project: {
          ...normalized,
          grid: { ...gridDefaults, ...normalized.grid },
          stock: {
            ...stockDefaults,
            ...normalized.stock,
            origin: normalized.stock?.origin ?? stockDefaults.origin,
            profile: normalized.stock?.profile ?? stockDefaults.profile,
          },
          origin: normalized.origin ?? defaultOrigin(normalized.stock ?? stockDefaults),
        },
        filePath: path,
        machineLoadDiagnostics: machineDiagnostics,
        // The opened document has no G-code destination yet; a previous
        // project's export path must never authorize an overwrite (#1081).
        lastExportPath: null,
        dirty: decoded.convertedLegacy || migratedMachineLibrary,
        loadWarning: joinWarnings(
          versionWarning ?? (decoded.convertedLegacy
            ? `This legacy project was converted in memory to file format ${LATEST_PROJECT_VERSION}. The original file is unchanged until you save. Files saved in ${LATEST_PROJECT_VERSION} are not compatible with older PureCutCNC builds.`
            : null),
          machineMovedToLibrary
            ? 'Machine definitions moved to the application library. This project now stores only its selected machine; any custom machines it no longer stores were added to My Machines. The original file is unchanged until you save.'
            : null,
          decoded.retractHeightsReexpressed > 0
            ? `${decoded.retractHeightsReexpressed === 1 ? 'One drilling retract height was' : `${decoded.retractHeightsReexpressed} drilling retract heights were`} re-expressed relative to the material surface to match the current file format (issue #481). The original file is unchanged until you save.`
            : null,
          decoded.edgeEntryStrategiesReset > 0
            ? `${decoded.edgeEntryStrategiesReset === 1 ? 'One edge route entry strategy was' : `${decoded.edgeEntryStrategiesReset} edge route entry strategies were`} reset to Plunge to match how this file cut in v0.4 (issue #891). The original file is unchanged until you save.`
            : null,
          machineWarning,
        ),
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        pendingNest: null,
        nestSearching: false,
        selection: emptySelection(),
        projectKey: state.projectKey + 1,
        history: {
          past: [],
          future: [],
          transactionStart: null,
        },
      }))
    },

    clearLoadWarning: () => set({ loadWarning: null, machineLoadDiagnostics: [] }),

    markSaved: (path) =>
      deps.rawSet({ filePath: path, dirty: false }),

    markExported: (path) =>
      set({ lastExportPath: path }),

    markModelExported: (path) =>
      set({ lastModelExportPath: path }),
  }
}
