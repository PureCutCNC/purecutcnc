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
import type { Project } from '../../types/project'
import {
  createDefaultFeatureDistributionSpec,
  featureDistributionPivot,
  planFeatureDistribution,
  profilePathLength,
  type FeatureDistributionSpec,
} from '../../sketch/featureDistribution'
import { buildTransformedCopiedFeatures, extractClonedDefinitions } from '../helpers/copyFeatures'
import { createFeatureInstance } from '../helpers/featureDefinitions'
import { nextPlacementSession } from '../helpers/ids'
import { multiplyMatrix } from '../helpers/instanceTransforms'
import { cloneProject, syncFeatureTreeProject } from '../helpers/normalize'
import { resolveFeatureInstance, type ResolvedSketchFeature } from '../helpers/resolveFeatures'
import type { ProjectStore } from '../types'

export type FeatureDistributionSlice = Pick<
  ProjectStore,
  | 'pendingFeatureDistribution'
  | 'startFeatureDistribution'
  | 'updateFeatureDistribution'
  | 'setFeatureDistributionPickTarget'
  | 'setFeatureDistributionGuide'
  | 'setFeatureDistributionRadialCenter'
  | 'cancelFeatureDistribution'
  | 'completeFeatureDistribution'
>

function resolvedFeatures(project: Project, ids: string[]): ResolvedSketchFeature[] | null {
  const features = ids.map((id) => resolveFeatureInstance(project, id))
  return features.every((feature): feature is ResolvedSketchFeature => feature !== null) ? features : null
}

export function createFeatureDistributionSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  _get: Parameters<StateCreator<ProjectStore>>[1],
): FeatureDistributionSlice {
  void _get
  return {
    pendingFeatureDistribution: null,

    startFeatureDistribution: () => set((s) => {
      const sourceIds = s.selection.selectedFeatureIds
      const sources = resolvedFeatures(s.project, sourceIds)
      if (!sources || sources.length === 0 || sources.some((feature) => feature.locked || feature.kind === 'stl')) {
        return {}
      }
      return {
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        pendingShapeAction: null,
        sketchEditSession: null,
        pendingFeatureDistribution: {
          sourceIds,
          guideId: null,
          pickTarget: null,
          radialCenterPicked: false,
          spec: createDefaultFeatureDistributionSpec(s.project.meta.units),
          session: nextPlacementSession(),
        },
        selection: {
          ...s.selection,
          selectedFeatureId: sourceIds.at(-1) ?? null,
          selectedFeatureIds: sourceIds,
          selectedNode: sourceIds.at(-1) ? { type: 'feature', featureId: sourceIds.at(-1)! } : null,
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

    updateFeatureDistribution: (spec: FeatureDistributionSpec) => set((s) => {
      const pending = s.pendingFeatureDistribution
      if (!pending) return { pendingFeatureDistribution: null }
      const modeChanged = pending.spec.mode !== spec.mode
      const pickTarget = pending.pickTarget === 'guide' && spec.mode !== 'path'
        ? null
        : pending.pickTarget === 'radial-center' && spec.mode !== 'radial'
          ? null
          : pending.pickTarget
      return {
        pendingFeatureDistribution: {
          ...pending,
          spec,
          pickTarget,
          radialCenterPicked: spec.mode === 'radial' && !modeChanged
            ? pending.radialCenterPicked
            : false,
        },
      }
    }),

    setFeatureDistributionPickTarget: (pickTarget) => set((s) => {
      const pending = s.pendingFeatureDistribution
      if (!pending) return { pendingFeatureDistribution: null }
      if (pickTarget === 'guide' && pending.spec.mode !== 'path') return {}
      if (pickTarget === 'radial-center' && pending.spec.mode !== 'radial') return {}
      return { pendingFeatureDistribution: { ...pending, pickTarget } }
    }),

    setFeatureDistributionGuide: (featureId) => set((s) => {
      const pending = s.pendingFeatureDistribution
      if (!pending || pending.spec.mode !== 'path' || pending.sourceIds.includes(featureId)) return {}
      const guide = resolveFeatureInstance(s.project, featureId)
      if (!guide || guide.kind === 'stl' || guide.sketch.profile.segments.length === 0) return {}
      const guideLength = profilePathLength(guide.sketch.profile)
      if (guideLength <= 0) return {}
      return {
        pendingFeatureDistribution: {
          ...pending,
          guideId: featureId,
          pickTarget: null,
          spec: {
            ...pending.spec,
            // A newly chosen guide defaults to its full length. This keeps the
            // first path preview usable without turning an open-path endpoint
            // into a special persisted value.
            endOffset: pending.guideId === featureId ? pending.spec.endOffset : guideLength,
          },
        },
      }
    }),

    setFeatureDistributionRadialCenter: (center) => set((s) => {
      const pending = s.pendingFeatureDistribution
      if (!pending || pending.spec.mode !== 'radial') return {}
      return {
        pendingFeatureDistribution: {
          ...pending,
          pickTarget: null,
          radialCenterPicked: true,
          spec: { ...pending.spec, center },
        },
      }
    }),

    cancelFeatureDistribution: () => set({ pendingFeatureDistribution: null }),

    completeFeatureDistribution: () => {
      let createdIds: string[] = []
      set((s) => {
        const pending = s.pendingFeatureDistribution
        if (!pending) return {}
        if (pending.spec.mode === 'radial' && !pending.radialCenterPicked) return {}
        const sources = resolvedFeatures(s.project, pending.sourceIds)
        if (!sources) return { pendingFeatureDistribution: null }
        const guide = pending.guideId ? resolveFeatureInstance(s.project, pending.guideId) : null
        const plan = planFeatureDistribution({
          spec: pending.spec,
          sourcePivot: featureDistributionPivot(sources.map((source) => source.sketch.profile)),
          sourceOrientationRadians: Math.atan2(sources[0]!.transform.b, sources[0]!.transform.a),
          guideProfile: guide?.sketch.profile,
        })
        if (!plan.ok || plan.placements.length === 0) return {}

        const created = buildTransformedCopiedFeatures(
          sources,
          s.project.features,
          plan.placements.map((placement) => placement.transform),
          s.project.featureDefinitions,
          s.project.meta.copyMode,
        ).map((feature) => ({ ...feature, folderId: null }))
        const definitions = extractClonedDefinitions(created)
        const instances = created.map((feature) => createFeatureInstance(feature, feature.definitionId, feature.transform))
        createdIds = created.map((feature) => feature.id)
        const sourceIds = new Set(pending.sourceIds)
        const sourcePlacement = plan.sourcePlacement
        const features = sourcePlacement
          ? s.project.features.map((feature) => (
            sourceIds.has(feature.id)
              ? { ...feature, transform: multiplyMatrix(sourcePlacement.transform, feature.transform) }
              : feature
          ))
          : s.project.features
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          features: [...features, ...instances],
          featureDefinitions: { ...s.project.featureDefinitions, ...definitions },
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        const primaryId = createdIds.at(-1) ?? null
        return {
          project: nextProject,
          pendingFeatureDistribution: null,
          selection: {
            ...s.selection,
            selectedFeatureId: primaryId,
            selectedFeatureIds: createdIds,
            selectedNode: primaryId ? { type: 'feature' as const, featureId: primaryId } : null,
            mode: 'feature' as const,
            activeControl: null,
          },
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })
      return createdIds
    },
  }
}
