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
import type { Tool } from '../../types/project'
import type { ProjectStore } from '../types'
import { nextUniqueGeneratedId } from '../helpers/ids'
import { defaultTool } from '../../types/project'
import { cloneProject, normalizeTool, projectsEqual } from '../helpers/normalize'
import { toolMatchesTemplate } from '../helpers/operationDefaults'

export type ToolsSlice = Pick<
  ProjectStore,
  | 'addTool'
  | 'importTools'
  | 'updateTool'
  | 'deleteTool'
  | 'duplicateTool'
>

function duplicateToolName(name: string, tools: Tool[]): string {
  const baseName = `${name} Copy`
  if (!tools.some((tool) => tool.name === baseName)) {
    return baseName
  }

  let index = 2
  while (tools.some((tool) => tool.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

export function createToolsSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): ToolsSlice {

  return {
    addTool: () => {
      const state = get()
      const nextId = nextUniqueGeneratedId(state.project, 't')
      const template = defaultTool(state.project.meta.units, state.project.tools.length + 1)
      const tool: Tool = {
        ...template,
        id: nextId,
      }

      set((s) => {
        const nextProject = {
          ...s.project,
          tools: [...s.project.tools, tool],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }
        return {
          project: nextProject,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })

      return nextId
    },

    importTools: (tools) => {
      const state = get()
      const imported: Tool[] = []
      let nextProject = state.project

      for (const sourceTool of tools) {
        if (nextProject.tools.some((tool) => toolMatchesTemplate(tool, sourceTool))) {
          continue
        }

        const nextId = nextUniqueGeneratedId(nextProject, 't')
        const tool = normalizeTool(
          {
            ...sourceTool,
            id: nextId,
          },
          sourceTool.units,
          nextProject.tools.length,
        )

        imported.push(tool)
        nextProject = {
          ...nextProject,
          tools: [...nextProject.tools, tool],
        }
      }

      if (imported.length === 0) {
        return []
      }

      set((s) => ({
        project: {
          ...nextProject,
          meta: { ...nextProject.meta, modified: new Date().toISOString() },
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }))

      return imported.map((tool) => tool.id)
    },

    updateTool: (id, patch) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          tools: s.project.tools.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
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

    deleteTool: (id) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          tools: s.project.tools.filter((tool) => tool.id !== id),
          operations: s.project.operations.map((operation) =>
            operation.toolRef === id ? { ...operation, toolRef: null } : operation
          ),
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

    duplicateTool: (id) => {
      const state = get()
      const sourceTool = state.project.tools.find((tool) => tool.id === id)
      if (!sourceTool) {
        return null
      }

      const nextId = nextUniqueGeneratedId(state.project, 't')
      const duplicate: Tool = {
        ...sourceTool,
        id: nextId,
        name: duplicateToolName(sourceTool.name, state.project.tools),
      }

      set((s) => ({
        project: {
          ...s.project,
          tools: [...s.project.tools, duplicate],
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
  }
}
