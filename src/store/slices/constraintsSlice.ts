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
  inferSemanticIndices,
  propagateConstraintsOnTranslate,
  rederiveConstraintGeometry,
  solveFeatureTranslation,
  validateConstraintsOnFeature,
  type ConstraintInput,
} from '../../sketch/constraintSolver'
import type { LocalConstraint, Point, Project, SketchFeature } from '../../types/project'
import type { ProjectStore } from '../types'
import { nextPlacementSession, nextUniqueGeneratedId } from '../helpers/ids'

export interface ConstraintsSliceDependencies {
  cloneProject: (project: Project) => Project
  translateProfile: (profile: SketchFeature['sketch']['profile'], dx: number, dy: number) => SketchFeature['sketch']['profile']
  transformProfile: (
    profile: SketchFeature['sketch']['profile'],
    transformPoint: (point: Point) => Point,
  ) => SketchFeature['sketch']['profile']
}

export type ConstraintsSlice = Pick<
  ProjectStore,
  | 'beginConstraint'
  | 'setConstraintAnchor'
  | 'setConstraintReference'
  | 'commitConstraintDistance'
  | 'cancelPendingConstraint'
  | 'deleteConstraint'
  | 'updateConstraintValue'
>

export function createConstraintsSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  _get: Parameters<StateCreator<ProjectStore>>[1],
  deps: ConstraintsSliceDependencies,
): ConstraintsSlice {
  const {
    cloneProject,
    translateProfile,
    transformProfile,
  } = deps

  return {
  beginConstraint: (featureId) =>
    set((s) => {
      const feature = s.project.features.find((f) => f.id === featureId)
      if (!feature || feature.locked) {
        return {}
      }
      return {
        pendingConstraint: {
          featureId,
          anchor: null,
          reference: null,
          session: nextPlacementSession(),
        },
      }
    }),

  setConstraintAnchor: (anchor) =>
    set((s) => {
      if (!s.pendingConstraint) {
        return {}
      }
      return {
        pendingConstraint: { ...s.pendingConstraint, anchor },
      }
    }),

  setConstraintReference: (reference) =>
    set((s) => {
      if (!s.pendingConstraint || !s.pendingConstraint.anchor) {
        return {}
      }
      if (s.pendingConstraint.featureId === reference.featureId) {
        return {}
      }
      return {
        pendingConstraint: { ...s.pendingConstraint, reference },
      }
    }),

  commitConstraintDistance: (distance) =>
    set((s) => {
      const pending = s.pendingConstraint
      if (!pending || !pending.anchor || !pending.reference || !Number.isFinite(distance) || distance < 0) {
        return {}
      }
      const feature = s.project.features.find((f) => f.id === pending.featureId)
      if (!feature || feature.locked) {
        return { pendingConstraint: null }
      }

      const anchor = pending.anchor.point
      const ref = pending.reference.point
      const segment = pending.reference.segment
      let storedValue = distance
      if (segment) {
        const sx = segment.b.x - segment.a.x
        const sy = segment.b.y - segment.a.y
        const segLen = Math.hypot(sx, sy)
        let nx = 0
        let ny = 1
        if (segLen > 1e-9) {
          nx = -sy / segLen
          ny = sx / segLen
        }
        const signedDist = (anchor.x - segment.a.x) * nx + (anchor.y - segment.a.y) * ny
        const side = signedDist >= 0 ? 1 : -1
        storedValue = side * distance
      }

      const constraintId = nextUniqueGeneratedId(s.project, 'c')
      const referenceIds = pending.reference.featureId
        ? [pending.reference.featureId]
        : []

      // Infer semantic indices from snap modes
      const refFeature = pending.reference.featureId
        ? s.project.features.find((f) => f.id === pending.reference!.featureId) ?? null
        : null
      const semanticIndices = inferSemanticIndices(
        feature.sketch.profile,
        refFeature?.sketch.profile ?? null,
        anchor,
        ref,
        pending.anchor.snapMode,
        pending.reference.snapMode,
        segment,
      )

      const newConstraint: LocalConstraint = {
        id: constraintId,
        type: 'fixed_distance',
        segment_ids: referenceIds,
        value: storedValue,
        anchor_point: anchor, // placeholder — updated after multi-constraint solve
        reference_point: segment
          ? (() => {
              const sx = segment.b.x - segment.a.x
              const sy = segment.b.y - segment.a.y
              const segLen = Math.hypot(sx, sy)
              if (segLen < 1e-12) return ref
              const nx = -sy / segLen
              const ny = sx / segLen
              const signedDist = (anchor.x - segment.a.x) * nx + (anchor.y - segment.a.y) * ny
              return { x: anchor.x - signedDist * nx, y: anchor.y - signedDist * ny }
            })()
          : ref,
        reference_segment: segment,
        anchor_index: semanticIndices.anchor_index,
        anchor_type: semanticIndices.anchor_type,
        reference_feature_id: pending.reference.featureId ?? undefined,
        reference_index: semanticIndices.reference_index,
        reference_type: semanticIndices.reference_type,
        reference_t: semanticIndices.reference_t,
      }

      // Solve ALL constraints simultaneously (existing + new) to find the position
      // that satisfies all of them without modifying any stored values.
      const allConstraints = [...feature.sketch.constraints, newConstraint]
      const featureByIdSolve = new Map(s.project.features.map((f) => [f.id, f]))
      const solverInputs: ConstraintInput[] = []
      for (const c of allConstraints) {
        if (c.type !== 'fixed_distance') continue
        const cRefId = c.reference_feature_id ?? c.segment_ids[0]
        const cRefFeature = cRefId ? featureByIdSolve.get(cRefId) : null
        const rederived = rederiveConstraintGeometry(
          feature.sketch.profile,
          cRefFeature?.sketch.profile ?? null,
          c,
        )
        if (rederived && rederived.isValid) {
          if (rederived.referenceSegment) {
            solverInputs.push({
              kind: 'segment',
              anchor: rederived.anchorPoint,
              segmentA: rederived.referenceSegment.a,
              segmentB: rederived.referenceSegment.b,
              signedDistance: c.value ?? 0,
            })
          } else if (rederived.referencePoint) {
            solverInputs.push({
              kind: 'point',
              anchor: rederived.anchorPoint,
              reference: rederived.referencePoint,
              distance: Math.abs(c.value ?? 0),
            })
          }
        } else if (c.anchor_point) {
          if (c.reference_segment) {
            solverInputs.push({
              kind: 'segment',
              anchor: c.anchor_point,
              segmentA: c.reference_segment.a,
              segmentB: c.reference_segment.b,
              signedDistance: c.value ?? 0,
            })
          } else if (c.reference_point) {
            solverInputs.push({
              kind: 'point',
              anchor: c.anchor_point,
              reference: c.reference_point,
              distance: Math.abs(c.value ?? 0),
            })
          }
        }
      }
      const { dx: translateDx, dy: translateDy } = solveFeatureTranslation(solverInputs)

      const nextFeatures = s.project.features.map((f) => {
        if (f.id !== pending.featureId) return f
        const nextProfile =
          Math.abs(translateDx) < 1e-9 && Math.abs(translateDy) < 1e-9
            ? f.sketch.profile
            : translateProfile(f.sketch.profile, translateDx, translateDy)
        // Refresh all constraint caches from the solved position — values are never touched
        const featureByIdNext = new Map([...featureByIdSolve, [f.id, { ...f, sketch: { ...f.sketch, profile: nextProfile } }]])
        const refreshedConstraints = allConstraints.map((c) => {
          if (c.type !== 'fixed_distance') return c
          const cRefId = c.reference_feature_id ?? c.segment_ids[0]
          const cRefFeature = cRefId ? featureByIdNext.get(cRefId) : null
          const result = rederiveConstraintGeometry(nextProfile, cRefFeature?.sketch.profile ?? null, c)
          if (!result || !result.isValid) return c
          return {
            ...c,
            anchor_point: result.anchorPoint,
            reference_point: result.referencePoint,
            reference_segment: result.referenceSegment,
            is_invalid: false,
            error_message: undefined,
          }
        })
        return { ...f, sketch: { ...f.sketch, profile: nextProfile, constraints: refreshedConstraints } }
      })
      const refreshedFeatures = nextFeatures

      const nextProject = {
        ...s.project,
        features: refreshedFeatures,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      return {
        project: nextProject,
        pendingConstraint: null,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  cancelPendingConstraint: () =>
    set((s) => (s.pendingConstraint ? { pendingConstraint: null } : {})),

  deleteConstraint: (featureId, constraintId) =>
    set((s) => {
      const feature = s.project.features.find((f) => f.id === featureId)
      if (!feature) return {}
      const nextConstraints = feature.sketch.constraints.filter((c) => c.id !== constraintId)
      if (nextConstraints.length === feature.sketch.constraints.length) return {}
      const nextProject = {
        ...s.project,
        features: s.project.features.map((f) =>
          f.id === featureId
            ? { ...f, sketch: { ...f.sketch, constraints: nextConstraints } }
            : f
        ),
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

  updateConstraintValue: (featureId, constraintId, newValue) =>
    set((s) => {
      if (!Number.isFinite(newValue)) return {}
      const feature = s.project.features.find((f) => f.id === featureId)
      if (!feature || feature.locked) return {}
      const constraint = feature.sketch.constraints.find((c) => c.id === constraintId)
      if (!constraint || constraint.type !== 'fixed_distance') return {}

      const refFeatureId = constraint.reference_feature_id ?? constraint.segment_ids[0]
      const refFeature = refFeatureId ? s.project.features.find((f) => f.id === refFeatureId) : null

      // Re-derive current geometry for the edited constraint
      const rederived = rederiveConstraintGeometry(
        feature.sketch.profile,
        refFeature?.sketch.profile ?? null,
        constraint,
      )

      let translateDx = 0
      let translateDy = 0
      let storedValue = newValue

      if (rederived && rederived.isValid) {
        const anchor = rederived.anchorPoint
        if (rederived.referenceSegment) {
          const { a, b } = rederived.referenceSegment
          const sx = b.x - a.x; const sy = b.y - a.y
          const segLen = Math.hypot(sx, sy)
          if (segLen > 1e-12) {
            const nx = -sy / segLen; const ny = sx / segLen
            const signedDist = (anchor.x - a.x) * nx + (anchor.y - a.y) * ny
            // Preserve the current side; user types positive magnitude
            const side = signedDist >= 0 ? 1 : -1
            const foot = { x: anchor.x - signedDist * nx, y: anchor.y - signedDist * ny }
            const newAnchor = { x: foot.x + side * Math.abs(newValue) * nx, y: foot.y + side * Math.abs(newValue) * ny }
            translateDx = newAnchor.x - anchor.x; translateDy = newAnchor.y - anchor.y
            storedValue = side * Math.abs(newValue)
          }
        } else if (rederived.referencePoint) {
          const ref = rederived.referencePoint
          const dx = anchor.x - ref.x; const dy = anchor.y - ref.y
          const currentLen = Math.hypot(dx, dy)
          let ux = 1, uy = 0
          if (currentLen > 1e-9) { ux = dx / currentLen; uy = dy / currentLen }
          const newAnchor = { x: ref.x + ux * newValue, y: ref.y + uy * newValue }
          translateDx = newAnchor.x - anchor.x; translateDy = newAnchor.y - anchor.y
        }
      } else if (constraint.anchor_point) {
        const anchor = constraint.anchor_point
        if (constraint.reference_segment) {
          const { a, b } = constraint.reference_segment
          const sx = b.x - a.x; const sy = b.y - a.y
          const segLen = Math.hypot(sx, sy)
          if (segLen > 1e-12) {
            const nx = -sy / segLen; const ny = sx / segLen
            const signedDist = (anchor.x - a.x) * nx + (anchor.y - a.y) * ny
            const side = signedDist >= 0 ? 1 : -1
            const foot = { x: anchor.x - signedDist * nx, y: anchor.y - signedDist * ny }
            const newAnchor = { x: foot.x + side * newValue * nx, y: foot.y + side * newValue * ny }
            translateDx = newAnchor.x - anchor.x; translateDy = newAnchor.y - anchor.y
          }
        } else if (constraint.reference_point) {
          const ref = constraint.reference_point
          const dx = anchor.x - ref.x; const dy = anchor.y - ref.y
          const currentLen = Math.hypot(dx, dy)
          let ux = 1, uy = 0
          if (currentLen > 1e-9) { ux = dx / currentLen; uy = dy / currentLen }
          const newAnchor = { x: ref.x + ux * newValue, y: ref.y + uy * newValue }
          translateDx = newAnchor.x - anchor.x; translateDy = newAnchor.y - anchor.y
        }
      }

      // 1. Translate the feature and update the edited constraint's value
      const updatedConstraint = { ...constraint, value: storedValue, is_invalid: false, error_message: undefined }
      let nextFeatures = s.project.features.map((f) => {
        if (f.id !== featureId) return f
        const nextProfile = Math.abs(translateDx) < 1e-9 && Math.abs(translateDy) < 1e-9
          ? f.sketch.profile
          : translateProfile(f.sketch.profile, translateDx, translateDy)
        return {
          ...f,
          sketch: {
            ...f.sketch,
            profile: nextProfile,
            constraints: f.sketch.constraints.map((c) => c.id === constraintId ? updatedConstraint : c),
          },
        }
      })

      // 2. Refresh all constraint caches on the moved feature and validate other constraints
      //    (do NOT update their values — they should be marked invalid if unsatisfied)
      const featureById = new Map(nextFeatures.map((f) => [f.id, f]))
      nextFeatures = nextFeatures.map((f) => {
        if (f.id !== featureId) return f
        return validateConstraintsOnFeature(f, featureById)
      })

      // 3. Propagate only to features that depend on the moved feature (not the moved feature itself)
      //    Use dx:0,dy:0 seed so propagation re-derives reference geometry without treating it as a manual move
      nextFeatures = propagateConstraintsOnTranslate(
        nextFeatures,
        new Map([[featureId, { dx: 0, dy: 0 }]]),
        { transformProfile },
      )

      // 4. Validate all features that have constraints (catch any that became invalid after propagation)
      const featureById2 = new Map(nextFeatures.map((f) => [f.id, f]))
      nextFeatures = nextFeatures.map((f) => {
        if (f.sketch.constraints.every((c) => c.type !== 'fixed_distance')) return f
        return validateConstraintsOnFeature(f, featureById2)
      })

      const nextProject = {
        ...s.project,
        features: nextFeatures,
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
  }
}
