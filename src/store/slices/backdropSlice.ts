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
import type { BackdropImage, Project } from '../../types/project'
import type { ProjectStore } from '../types'
import { getStockBounds } from '../../types/project'
import { convertLength } from '../../utils/units'
import { normalizeAngleDegrees } from '../helpers/normalize'
import { cloneProject, projectsEqual } from '../helpers/normalize'

export type BackdropSlice = Pick<
  ProjectStore,
  | 'loadBackdropImage'
  | 'setBackdropImageLoading'
  | 'setBackdrop'
  | 'updateBackdrop'
  | 'deleteBackdrop'
>

function fitBackdropSize(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const safeSourceWidth = Math.max(sourceWidth, 1)
  const safeSourceHeight = Math.max(sourceHeight, 1)
  const scale = Math.min(maxWidth / safeSourceWidth, maxHeight / safeSourceHeight)
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  return {
    width: safeSourceWidth * safeScale,
    height: safeSourceHeight * safeScale,
  }
}

function createBackdropFromImage(
  project: Project,
  input: Pick<BackdropImage, 'name' | 'mimeType' | 'imageDataUrl' | 'intrinsicWidth' | 'intrinsicHeight'>,
): BackdropImage {
  const stockBounds = getStockBounds(project.stock)
  const maxWidth = Math.max((stockBounds.maxX - stockBounds.minX) * 0.9, convertLength(10, 'mm', project.meta.units))
  const maxHeight = Math.max((stockBounds.maxY - stockBounds.minY) * 0.9, convertLength(10, 'mm', project.meta.units))
  const fitted = fitBackdropSize(input.intrinsicWidth, input.intrinsicHeight, maxWidth, maxHeight)

  return {
    ...input,
    center: {
      x: (stockBounds.minX + stockBounds.maxX) / 2,
      y: (stockBounds.minY + stockBounds.maxY) / 2,
    },
    width: fitted.width,
    height: fitted.height,
    orientationAngle: 90,
    opacity: 0.6,
    visible: true,
  }
}

function replaceBackdropImage(existing: BackdropImage, project: Project, input: Pick<BackdropImage, 'name' | 'mimeType' | 'imageDataUrl' | 'intrinsicWidth' | 'intrinsicHeight'>): BackdropImage {
  const fitted = fitBackdropSize(
    input.intrinsicWidth,
    input.intrinsicHeight,
    Math.max(existing.width, convertLength(10, 'mm', project.meta.units)),
    Math.max(existing.height, convertLength(10, 'mm', project.meta.units)),
  )

  return {
    ...existing,
    ...input,
    width: fitted.width,
    height: fitted.height,
  }
}

export function normalizeBackdrop(backdrop: BackdropImage | null | undefined, project: Project): BackdropImage | null {
  if (!backdrop?.imageDataUrl) {
    return null
  }

  const stockBounds = getStockBounds(project.stock)
  const fallbackWidth = Math.max((stockBounds.maxX - stockBounds.minX) * 0.9, convertLength(10, 'mm', project.meta.units))
  const fallbackHeight = Math.max((stockBounds.maxY - stockBounds.minY) * 0.9, convertLength(10, 'mm', project.meta.units))
  const fitted = fitBackdropSize(
    backdrop.intrinsicWidth ?? 1,
    backdrop.intrinsicHeight ?? 1,
    backdrop.width ?? fallbackWidth,
    backdrop.height ?? fallbackHeight,
  )

  return {
    name: backdrop.name || 'Backdrop',
    mimeType: backdrop.mimeType || 'image/png',
    imageDataUrl: backdrop.imageDataUrl,
    intrinsicWidth: Math.max(backdrop.intrinsicWidth ?? 1, 1),
    intrinsicHeight: Math.max(backdrop.intrinsicHeight ?? 1, 1),
    center: backdrop.center ?? {
      x: (stockBounds.minX + stockBounds.maxX) / 2,
      y: (stockBounds.minY + stockBounds.maxY) / 2,
    },
    width: Math.max(backdrop.width ?? fitted.width, convertLength(1, 'mm', project.meta.units)),
    height: Math.max(backdrop.height ?? fitted.height, convertLength(1, 'mm', project.meta.units)),
    orientationAngle: normalizeAngleDegrees(backdrop.orientationAngle ?? 90),
    opacity: Math.min(Math.max(backdrop.opacity ?? 0.6, 0), 1),
    visible: backdrop.visible ?? true,
  }
}

export function createBackdropSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
): BackdropSlice {

  return {
    loadBackdropImage: (input) =>
      set((s) => {
        const nextBackdrop = s.project.backdrop
          ? replaceBackdropImage(s.project.backdrop, s.project, input)
          : createBackdropFromImage(s.project, input)
        const nextProject = {
          ...s.project,
          backdrop: nextBackdrop,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }
        return {
          project: nextProject,
          pendingShapeAction: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedNode: { type: 'backdrop' },
            mode: 'feature',
            activeControl: null,
          },
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    setBackdropImageLoading: (loading) => set({ backdropImageLoading: loading }),

    setBackdrop: (backdrop) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          backdrop: backdrop ? normalizeBackdrop(backdrop, s.project) : null,
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

    updateBackdrop: (patch) =>
      set((s) => {
        if (!s.project.backdrop) {
          return {}
        }

        const nextBackdrop = normalizeBackdrop({ ...s.project.backdrop, ...patch }, s.project)
        const nextProject = {
          ...s.project,
          backdrop: nextBackdrop,
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

    deleteBackdrop: () =>
      set((s) => {
        if (!s.project.backdrop) {
          return {}
        }

        return {
          project: {
            ...s.project,
            backdrop: null,
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          },
          selection:
            s.selection.selectedNode?.type === 'backdrop'
              ? {
                  ...s.selection,
                  selectedNode: null,
                  selectedFeatureId: null,
                  selectedFeatureIds: [],
                  mode: 'feature',
                  activeControl: null,
                }
              : s.selection,
          pendingMove: s.pendingMove?.entityType === 'backdrop' ? null : s.pendingMove,
          pendingTransform: s.pendingTransform?.entityType === 'backdrop' ? null : s.pendingTransform,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),
  }
}
