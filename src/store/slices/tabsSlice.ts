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
import type { Tab, Project, SketchFeature, Operation } from '../../types/project'
import type { ProjectStore, SelectionState } from '../types'
import { getProfileBounds } from '../../types/project'
import { flattenProfile } from '../../engine/toolpaths/geometry'
import { tabLayoutFreeFraction, toolCentreContours, type TabRect } from '../../engine/toolpaths/tabs'
import { convertLength } from '../../utils/units'
import { nextUniqueGeneratedId } from '../helpers/ids'
import { emptySelection, sanitizeSelection } from './selectionSlice'
import { cloneProject, projectsEqual } from '../helpers/normalize'
import { resolveFeatureInstance } from '../helpers/resolveFeatures'

export type TabsSlice = Pick<
  ProjectStore,
  | 'moveTabControl'
  | 'updateTab'
  | 'updateTabs'
  | 'deleteTab'
  | 'deleteTabs'
  | 'setAllTabsVisible'
  | 'autoPlaceTabsForOperation'
>

function nextAutoTabName(baseName: string, tabs: Tab[]): string {
  const preferred = `${baseName} Tab`
  if (!tabs.some((tab) => tab.name === preferred)) {
    return preferred
  }

  let index = 2
  while (tabs.some((tab) => tab.name === `${preferred} ${index}`)) {
    index += 1
  }
  return `${preferred} ${index}`
}

function defaultAutoTabZTop(project: Project): number {
  return Math.min(project.stock.thickness, convertLength(3, 'mm', project.meta.units))
}

function resolveToolDiameterInProjectUnits(project: Project, operation: Operation): number | null {
  if (!operation.toolRef) {
    return null
  }

  const tool = project.tools.find((entry) => entry.id === operation.toolRef) ?? null
  if (!tool || !(tool.diameter > 0)) {
    return null
  }

  return tool.units === project.meta.units
    ? tool.diameter
    : convertLength(tool.diameter, tool.units, project.meta.units)
}

/**
 * Share of the tool-centre path a tab layout must leave uncovered to be usable. Below
 * this the part is barely attached — and at zero the operation never reaches final
 * depth at all, which `tabsBlockFinalDepth` reports.
 */
const MIN_FREE_PATH_FRACTION = 0.15

function tabRectsAt(
  count: 2 | 4,
  size: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  cx: number,
  cy: number,
  widthIsLongest: boolean,
): TabRect[] {
  if (count === 2) {
    return widthIsLongest
      ? [
          { x: cx - size / 2, y: bounds.minY - size / 2, w: size, h: size },
          { x: cx - size / 2, y: bounds.maxY - size / 2, w: size, h: size },
        ]
      : [
          { x: bounds.minX - size / 2, y: cy - size / 2, w: size, h: size },
          { x: bounds.maxX - size / 2, y: cy - size / 2, w: size, h: size },
        ]
  }

  return [
    { x: cx - size / 2, y: bounds.minY - size / 2, w: size, h: size },
    { x: cx - size / 2, y: bounds.maxY - size / 2, w: size, h: size },
    { x: bounds.minX - size / 2, y: cy - size / 2, w: size, h: size },
    { x: bounds.maxX - size / 2, y: cy - size / 2, w: size, h: size },
  ]
}

function buildAutoTabsForFeature(
  feature: SketchFeature,
  project: Project,
  operation: Operation,
  existingTabs: Tab[],
): Tab[] {
  const bounds = getProfileBounds(feature.sketch.profile)
  const width = Math.max(bounds.maxX - bounds.minX, convertLength(0.1, 'mm', project.meta.units))
  const height = Math.max(bounds.maxY - bounds.minY, convertLength(0.1, 'mm', project.meta.units))
  const cx = bounds.minX + width / 2
  const cy = bounds.minY + height / 2
  const toolDiameter = resolveToolDiameterInProjectUnits(project, operation)
  const minSize = Math.max(convertLength(3, 'mm', project.meta.units), (toolDiameter ?? 0) * 1.25)
  const maxSize = Math.max(minSize, Math.min(width, height) * 0.18)
  const size = Math.min(Math.max(minSize, Math.min(width, height) * 0.1), maxSize)
  const zTop = defaultAutoTabZTop(project)
  const zBottom = 0

  // Measure candidate layouts against the real tool-centre path rather than the
  // bounding box. A circle's inside path is pi/4 of the box perimeter and each tab
  // eats arc, not chord, so four tabs that fit a square of the same extents can
  // swallow the circle's final pass whole.
  const toolRadius = (toolDiameter ?? 0) / 2
  const insideCut = operation.kind === 'edge_route_inside'
  const contours = toolCentreContours(
    flattenProfile(feature.sketch.profile).points,
    insideCut ? -toolRadius : toolRadius,
  )
  const widthIsLongest = width >= height

  const candidates: Array<{ count: 2 | 4; size: number }> = [
    { count: 4, size },
    { count: 2, size },
  ]
  if (size > minSize + 1e-9) {
    candidates.push({ count: 4, size: minSize }, { count: 2, size: minSize })
  }

  const fallback = tabRectsAt(2, minSize, bounds, cx, cy, widthIsLongest)
  const entries =
    candidates
      .map((candidate) => tabRectsAt(candidate.count, candidate.size, bounds, cx, cy, widthIsLongest))
      .find((rects) => tabLayoutFreeFraction(contours, rects, toolRadius) >= MIN_FREE_PATH_FRACTION)
    ?? fallback

  const created: Tab[] = []
  for (const entry of entries) {
    created.push({
      id: nextUniqueGeneratedId(
        {
          ...project,
          tabs: [...existingTabs, ...created],
        },
        'tb',
      ),
      name: nextAutoTabName(feature.name, [...existingTabs, ...created]),
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
      z_top: zTop,
      z_bottom: zBottom,
      visible: true,
    })
  }

  return created
}

export function createTabsSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
): TabsSlice {

  return {
    updateTab: (id, patch) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          tabs: s.project.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
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

    updateTabs: (ids, patch) =>
      set((s) => {
        if (ids.length === 0) return {}
        const idSet = new Set(ids)
        // No-op when none of the requested IDs exist.
        if (!s.project.tabs.some((tab) => idSet.has(tab.id))) return {}
        const hasWidth = patch.w !== undefined
        const hasHeight = patch.h !== undefined
        const nextTabs = s.project.tabs.map((tab) => {
          if (!idSet.has(tab.id)) return tab
          const next = { ...tab, ...patch }
          // Center-preserving: shift x/y so the centre stays fixed.
          if (hasWidth && patch.w !== undefined) {
            next.x = tab.x + tab.w / 2 - patch.w / 2
          }
          if (hasHeight && patch.h !== undefined) {
            next.y = tab.y + tab.h / 2 - patch.h / 2
          }
          return next
        })
        // No-op when the patch produces no entity change.
        if (JSON.stringify(nextTabs) === JSON.stringify(s.project.tabs)) return {}
        const nextProject = {
          ...s.project,
          tabs: nextTabs,
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
      }),

    deleteTab: (id) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          tabs: s.project.tabs.filter((tab) => tab.id !== id),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        const nextSelection =
          s.selection.selectedNode?.type === 'tab' && s.selection.selectedNode.tabId === id
            ? emptySelection()
            : sanitizeSelection(nextProject, s.selection)
        return {
          project: nextProject,
          selection: nextSelection,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    deleteTabs: (ids) =>
      set((s) => {
        if (ids.length === 0) return {}
        const idSet = new Set(ids)
        // No-op when none of the requested IDs exist.
        if (!s.project.tabs.some((tab) => idSet.has(tab.id))) return {}
        const nextProject = {
          ...s.project,
          tabs: s.project.tabs.filter((tab) => !idSet.has(tab.id)),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        // Remove deleted IDs from the tab collection.
        const remainingIds = s.selection.selectedTabIds.filter((tabId) => !idSet.has(tabId))
        const nodeType = s.selection.selectedNode?.type
        // If the tab family is active, repair/clear its primary.  If another
        // family or tree node is active, preserve that unrelated selection.
        if (nodeType === 'tab' || nodeType === 'tabs_root') {
          const primaryId =
            s.selection.selectedNode?.type === 'tab' ? s.selection.selectedNode.tabId : null
          const primarySurvived = primaryId !== null && !idSet.has(primaryId)
          const nextPrimaryId = primarySurvived ? primaryId : remainingIds.at(-1) ?? null
          const nextSelection: SelectionState = {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedTabIds: remainingIds,
            selectedClampIds: [],
            selectedNode: nextPrimaryId ? { type: 'tab', tabId: nextPrimaryId } : null,
            mode: 'feature',
            activeControl: null,
            groupFolderId: null,
          }
          return {
            project: nextProject,
            selection: nextSelection,
            history: {
              past: [...s.history.past, cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
          }
        }
        // Another family or tree node is active — sanitize to repair
        // references but preserve the active selection.
        return {
          project: nextProject,
          selection: sanitizeSelection(nextProject, {
            ...s.selection,
            selectedTabIds: remainingIds,
          }),
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    setAllTabsVisible: (visible) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          tabs: s.project.tabs.map((tab) => ({ ...tab, visible })),
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

    moveTabControl: (tabId, control, point) =>
      set((s) => {
        const minSize = convertLength(0.1, 'mm', s.project.meta.units)
        const nextProject = {
          ...s.project,
          tabs: s.project.tabs.map((tab) => {
            if (tab.id !== tabId) {
              return tab
            }

            if (control.kind !== 'anchor') {
              return tab
            }

            const corners = [
              { x: tab.x, y: tab.y },
              { x: tab.x + tab.w, y: tab.y },
              { x: tab.x + tab.w, y: tab.y + tab.h },
              { x: tab.x, y: tab.y + tab.h },
            ]
            const opposite = corners[(control.index + 2) % 4]
            const minX = Math.min(point.x, opposite.x)
            const maxX = Math.max(point.x, opposite.x)
            const minY = Math.min(point.y, opposite.y)
            const maxY = Math.max(point.y, opposite.y)

            return {
              ...tab,
              x: minX,
              y: minY,
              w: Math.max(maxX - minX, minSize),
              h: Math.max(maxY - minY, minSize),
            }
          }),
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

    autoPlaceTabsForOperation: (operationId) =>
      set((s) => {
        const operation = s.project.operations.find((entry) => entry.id === operationId) ?? null
        if (!operation || (operation.kind !== 'edge_route_inside' && operation.kind !== 'edge_route_outside')) {
          return {}
        }

        if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
          return {}
        }

        const expectedOperation = operation.kind === 'edge_route_inside' ? 'subtract' : 'add'
        const targetFeatures = operation.target.featureIds
          .map((featureId) => resolveFeatureInstance(s.project, featureId))
          .filter((feature) => feature !== null)
          .filter((feature) => feature.operation === expectedOperation || feature.operation === 'model' || feature.operation === 'region')

        if (targetFeatures.length === 0) {
          return {}
        }

        const createdTabs: Tab[] = []
        for (const feature of targetFeatures) {
          createdTabs.push(...buildAutoTabsForFeature(feature, s.project, operation, [...s.project.tabs, ...createdTabs]))
        }
        if (createdTabs.length === 0) {
          return {}
        }

        return {
          project: {
            ...s.project,
            tabs: [...s.project.tabs, ...createdTabs],
          },
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedTabIds: [createdTabs[createdTabs.length - 1].id],
            selectedClampIds: [],
            selectedNode: { type: 'tab', tabId: createdTabs[createdTabs.length - 1].id },
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),
  }
}
