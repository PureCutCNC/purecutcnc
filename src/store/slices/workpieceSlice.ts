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
import { convertProjectUnits } from '../../utils/units'
import {
  getStockBounds,
  rectProfile,
  stockFromFeature,
  type FeatureInstance,
} from '../../types/project'
import type { ProjectStore } from '../types'
import { nextPlacementSession } from '../helpers/ids'
import { cloneProject, projectsEqual, syncFeatureTreeProject } from '../helpers/normalize'
import { resolveFeatureInstance } from '../helpers/resolveFeatures'

export type WorkpieceSlice = Pick<
  ProjectStore,
  | 'setCreationTarget'
  | 'setStock'
  | 'setStockSourceFeature'
  | 'enterStockSketchEdit'
  | 'setRectStockDimension'
  | 'setGrid'
  | 'setUnits'
  | 'setOrigin'
  | 'startPlaceOrigin'
  | 'placeOriginAt'
>

export function createWorkpieceSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
): WorkpieceSlice {

  return {
    setCreationTarget: (target) =>
      set(() => ({
        creationTarget: target,
        pendingAdd: null,
      })),

    setOrigin: (origin) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          origin,
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

    startPlaceOrigin: () =>
      set((s) => ({
        pendingAdd: { shape: 'origin', session: nextPlacementSession() },
        pendingMove: null,
        pendingTransform: null,
        sketchEditSession: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'origin' },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      })),

    placeOriginAt: (point) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          origin: {
            ...s.project.origin,
            x: point.x,
            y: point.y,
          },
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }
        return {
          project: nextProject,
          pendingAdd: null,
          pendingTransform: null,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    setStock: (stock) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          stock,
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

    /**
     * Set a feature as the stock source. The feature is removed from project.features
     * and its geometry is used as the stock profile/thickness.
     * Pass null to reset to rectangle stock (restores the feature to the tree).
     *
     * This is a single undo-able action that captures full before/after state.
     */
    setStockSourceFeature: (featureId: string | null) =>
      set((s) => {
        if (featureId === null) {
          // Reset to rectangle stock
          if (!s.project.stock.sourceFeatureId && !s.project.stock.sourceFeature) {
            return {} // Already rectangle stock, no-op
          }

          const restoredFeature = s.project.stock.sourceFeature
          if (!restoredFeature) return {}

          const stockBounds = getStockBounds(s.project.stock)
          const width = stockBounds.maxX - stockBounds.minX
          const height = stockBounds.maxY - stockBounds.minY
          const rectW = Math.max(width, 1)
          const rectH = Math.max(height, 1)

          const nextStock = {
            ...s.project.stock,
            profile: rectProfile(stockBounds.minX, stockBounds.minY, rectW, rectH),
            sourceFeatureId: null as string | null | undefined,
            sourceFeature: null as FeatureInstance | null | undefined,
          }

          const nextProject = syncFeatureTreeProject({
            ...s.project,
            stock: nextStock,
            features: [...s.project.features, restoredFeature],
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          })

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
        }

        // Set a feature as stock source
        const featureInstance = s.project.features.find((f) => f.id === featureId)
        const feature = resolveFeatureInstance(s.project, featureId)
        if (!featureInstance || !feature) return {}
        if (!feature.sketch.profile.closed) return {} // Only closed profiles can be stock

        // If another feature is already the stock source, restore it first
        let features = s.project.features
        let stock = { ...s.project.stock }

        if (stock.sourceFeature && stock.sourceFeatureId) {
          // Restore old source feature to features array
          features = [...features, stock.sourceFeature]
        }

        // Remove the new source feature from features and tree
        features = features.filter((f) => f.id !== featureId)
        const featureTree = s.project.featureTree.filter(
          (entry) => !(entry.type === 'feature' && entry.featureId === featureId)
        )

        // Build stock from feature
        const newStock = stockFromFeature(feature)
        stock = {
          ...stock,
          profile: newStock.profile,
          thickness: newStock.thickness,
          sourceFeatureId: feature.id,
          sourceFeature: featureInstance,
        }

        const nextProject = syncFeatureTreeProject({
          ...s.project,
          stock,
          features,
          featureTree,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })

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

    /**
     * Enter sketch edit mode for the stock source feature.
     * Temporarily adds the source feature back to project.features and project.featureTree
     * so that mutation actions (moveFeatureControl, insertFeaturePoint, etc.) can find and edit it.
     * The feature is removed from features/tree on applySketchEdit (handled in selectionSlice).
     */
    enterStockSketchEdit: (featureId: string) =>
      set((s) => {
        const stock = s.project.stock
        if (stock.sourceFeatureId !== featureId || !stock.sourceFeature) {
          return {}
        }

        const feature = stock.sourceFeature

        // Temporarily add the feature to features array and feature tree for editing
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          features: [...s.project.features, feature],
          featureTree: [...s.project.featureTree, { type: 'feature' as const, featureId: feature.id }],
        })

        return {
          project: nextProject,
          pendingTransform: null,
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: featureId,
            selectedFeatureIds: [featureId],
            selectedNode: { type: 'feature', featureId },
            mode: 'sketch_edit',
            sketchEditTool: null,
            activeControl: null,
          },
          sketchEditSession: {
            entityType: 'feature',
            entityId: featureId,
            snapshot: cloneProject(s.project),
            pastLength: s.history.past.length,
          },
          pendingConstraint: null,
        }
      }),

    /**
     * Resize rectangular stock by changing one dimension while holding the
     * opposite side fixed. Only valid when the stock has no sourceFeatureId
     * and its profile is a simple axis-aligned rectangle (4 line segments).
     * Non-positive values are rejected.
     */
    setRectStockDimension: (axis, value, heldSide) =>
      set((s) => {
        // Only rectangular stock without a source feature
        if (s.project.stock.sourceFeatureId) return {}

        const segs = s.project.stock.profile.segments
        if (segs.length !== 4 || !segs.every((seg) => seg.type === 'line')) return {}

        if (value <= 0) return {}

        const bounds = getStockBounds(s.project.stock)
        const currentWidth = bounds.maxX - bounds.minX
        const currentHeight = bounds.maxY - bounds.minY

        let newMinX = bounds.minX
        let newMinY = bounds.minY
        let newW = currentWidth
        let newH = currentHeight

        if (axis === 'width') {
          newW = value
          if (heldSide === 'left') {
            // Keep left (minX) fixed, adjust maxX
          } else {
            // Hold right: keep maxX fixed, adjust minX
            newMinX = bounds.maxX - value
          }
        } else {
          newH = value
          if (heldSide === 'top') {
            // Keep top (minY) fixed, adjust maxY
          } else {
            // Hold bottom: keep maxY fixed, adjust minY
            newMinY = bounds.maxY - value
          }
        }

        const nextStock = {
          ...s.project.stock,
          profile: rectProfile(newMinX, newMinY, newW, newH),
        }

        const nextProject = {
          ...s.project,
          stock: nextStock,
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

    setGrid: (grid) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          grid,
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

    setUnits: (units) =>
      set((s) => {
        if (s.project.meta.units === units) {
          return {}
        }

        const convertedProject = convertProjectUnits(s.project, units)
        const nextProject = {
          ...convertedProject,
          meta: { ...convertedProject.meta, modified: new Date().toISOString() },
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
  }
}
