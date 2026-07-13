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
import { propagateConstraintsOnTranslate, validateConstraintsOnFeature } from '../../sketch/constraintSolver'
import {
  cloneProject,
  projectsEqual,
  syncFeatureTreeProject,
  syncFeatureBasedStock,
} from '../helpers/normalize'
import {
  profileVertices,
  type FeatureInstance,
  type Project,
  type Point,
  type SketchFeature,
  type SketchProfile,
} from '../../types/project'
import type { OpenProfileEndpoint } from '../types'
import type { ProjectStore } from '../types'
import { clonePoint, lerpPoint, normalizePoint, pointLength, scalePoint, subtractPoint } from '../helpers/geometry'
import { translatePoint, transformProfile, transformProfileAffine } from '../helpers/transform'
import {
  anchorPointForIndex,
  applyLineCornerChamfer,
  applyLineCornerFillet,
  arcControlPoint,
  buildArcSegmentFromThreePoints,
  cloneSegment,
  closeOpenProfile,
  deleteAnchorFromProfile,
  deleteSegmentFromProfile,
  disconnectProfileAtAnchor,
  insertPointIntoProfile,
  normalizeEditableProfileClosure,
  splitArcSegment,
  type ProfileBreakResult,
} from '../helpers/profileEdit'
import { gcOrphanedDefinitions, makeUnique as makeUniqueHelper } from '../helpers/featureDefinitions'
import { invertMatrix } from '../helpers/instanceTransforms'
import {
  applyMatrixToPoint,
  resolveFeatureInstance,
  resolvedFeatureMap,
  resolvedProjectFeatures,
  resolveProject,
  type ResolvedProject,
  type ResolvedSketchFeature,
} from '../helpers/resolveFeatures'
import { segmentIntersections, type ResolvedSeg, type LineSeg } from '../helpers/segmentIntersection'
import { resolveProfileSegments } from '../helpers/resolveProfileSegments'

export interface FeatureGeometrySliceDependencies {
  joinOpenProfiles: (
    profile: SketchProfile,
    endpoint: OpenProfileEndpoint,
    targetProfile: SketchProfile,
    targetEndpoint: OpenProfileEndpoint,
  ) => SketchProfile | null
  inferFeatureKind: (profile: SketchProfile) => SketchFeature['kind']
  clearStaleConstraints: (features: SketchFeature[], movedIds: Set<string>) => SketchFeature[]
  applyProfileBreak: (
    featureId: string,
    resolveBreak: (profile: SketchProfile) => ProfileBreakResult | null,
  ) => void
}

export type FeatureGeometrySlice = Pick<
  ProjectStore,
  | 'moveFeatureControl'
  | 'insertFeaturePoint'
  | 'joinOpenFeatureEndpoints'
  | 'deleteFeaturePoint'
  | 'deleteFeatureSegment'
  | 'disconnectFeaturePoint'
  | 'filletFeaturePoint'
  | 'chamferFeaturePoint'
  | 'trimFeatureSegment'
  | 'extendFeatureEndpoint'
  | 'makeUnique'
>

export function createFeatureGeometrySlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  _get: Parameters<StateCreator<ProjectStore>>[1],
  deps: FeatureGeometrySliceDependencies,
): FeatureGeometrySlice {
  const {
    joinOpenProfiles,
    inferFeatureKind,
    clearStaleConstraints,
    applyProfileBreak,
  } = deps

  function instanceFromResolved(feature: ResolvedSketchFeature): FeatureInstance {
    return {
      id: feature.id,
      name: feature.name,
      definitionId: feature.definitionId,
      transform: { ...feature.transform },
      constraints: feature.sketch.constraints.map((constraint) => ({ ...constraint })),
      z_top: feature.z_top,
      z_bottom: feature.z_bottom,
      folderId: feature.folderId,
      visible: feature.visible,
      locked: feature.locked,
    }
  }

  function restoreResolvedMetadata(
    source: ResolvedProject,
    features: SketchFeature[],
  ): ResolvedSketchFeature[] {
    const sourceById = new Map(source.features.map((feature) => [feature.id, feature]))
    return features.flatMap((feature) => {
      const resolved = sourceById.get(feature.id)
      if (!resolved) return []
      return [{
        ...resolved,
        ...feature,
        sketch: feature.sketch,
      }]
    })
  }

  function foldResolvedTranslations(
    project: Project,
    resolvedFeatures: SketchFeature[],
  ): FeatureInstance[] {
    const expected = resolvedFeatureMap(project)
    const actual = new Map(resolvedFeatures.map((feature) => [feature.id, feature]))
    return project.features.map((instance) => {
      const expectedFeature = expected.get(instance.id)
      const actualFeature = actual.get(instance.id)
      if (!expectedFeature || !actualFeature) return instance
      const dx = actualFeature.sketch.profile.start.x - expectedFeature.sketch.profile.start.x
      const dy = actualFeature.sketch.profile.start.y - expectedFeature.sketch.profile.start.y
      return {
        ...instance,
        transform: dx === 0 && dy === 0
          ? instance.transform
          : {
              ...instance.transform,
              e: instance.transform.e + dx,
              f: instance.transform.f + dy,
            },
        constraints: actualFeature.sketch.constraints.map((constraint) => ({ ...constraint })),
      }
    })
  }

  function syncEditedFeatureDefinition(project: ResolvedProject, featureId: string): Project {
    const editedFeature = project.features.find((feature) => feature.id === featureId)
    if (!editedFeature) {
      return { ...project, features: project.features.map(instanceFromResolved) }
    }

    const definitionId = editedFeature.definitionId
    const definition = project.featureDefinitions[definitionId]
    if (!definition) {
      return { ...project, features: project.features.map(instanceFromResolved) }
    }

    // Convert the edited feature's world-space profile back to definition-local
    // using the inverse of its transform so linked instances each re-resolve at
    // their own transform and the edited instance round-trips to the same geometry.
    const inv = invertMatrix(editedFeature.transform)
    const localProfile = transformProfileAffine(editedFeature.sketch.profile, (p) =>
      applyMatrixToPoint(inv, p),
    )

    const nextDefinition = {
      ...definition,
      kind: editedFeature.kind,
      profile: localProfile,
      dimensions: editedFeature.sketch.dimensions.map((dimension) => ({ ...dimension })),
      text: editedFeature.text ? { ...editedFeature.text } : null,
      stl: editedFeature.stl ? { ...editedFeature.stl } : null,
      operation: editedFeature.operation,
    }
    const nextProject: Project = {
      ...project,
      features: project.features.map(instanceFromResolved),
      featureDefinitions: {
        ...project.featureDefinitions,
        [definitionId]: nextDefinition,
      },
    }

    const linkedIds = nextProject.features
      .filter((feature) => feature.definitionId === definitionId)
      .map((feature) => feature.id)
    const resolved = resolvedProjectFeatures(nextProject)
    const offsets = new Map(linkedIds.map((id) => [id, { dx: 0, dy: 0 }] as const))
    let propagated = propagateConstraintsOnTranslate(resolved, offsets, { transformProfile })

    const featureByIdMap = new Map<string, SketchFeature>(propagated.map((f) => [f.id, f]))
    propagated = propagated.map((f) => {
      if (f.sketch.constraints.every((c) => c.type !== 'fixed_distance')) return f
      return validateConstraintsOnFeature(f, featureByIdMap)
    })

    return {
      ...nextProject,
      features: foldResolvedTranslations(nextProject, propagated),
    }
  }

  return {
  moveFeatureControl: (featureId, control, point) =>
    set((s) => {
      const editableProject = resolveProject(s.project)
      const nextProject: ResolvedProject = {
        ...editableProject,
        features: editableProject.features.map((feature) => {
          if (feature.id !== featureId || feature.locked) return feature

          const { profile } = feature.sketch
          const nextProfile = {
            ...profile,
            start: clonePoint(profile.start),
          }

          const anchorCount = profileVertices(nextProfile).length
          const segmentCount = nextProfile.segments.length
          if (anchorCount === 0) {
            return feature
          }

          function moveAnchor(anchorIndex: number, nextPoint: Point): void {
            const currentAnchor = anchorPointForIndex(nextProfile, anchorIndex)
            const incomingIndex = nextProfile.closed
              ? (anchorIndex - 1 + segmentCount) % segmentCount
              : anchorIndex > 0
                ? anchorIndex - 1
                : null
            const outgoingIndex = anchorIndex < segmentCount ? anchorIndex : null
            const originalIncoming = incomingIndex !== null ? nextProfile.segments[incomingIndex] : null
            const originalOutgoing = outgoingIndex !== null ? nextProfile.segments[outgoingIndex] : null
            const originalIncomingStart =
              incomingIndex === null
                ? null
                : incomingIndex === 0
                  ? nextProfile.start
                  : nextProfile.segments[incomingIndex - 1]?.to
            const incomingArcThrough =
              originalIncoming?.type === 'arc' && originalIncomingStart
                ? arcControlPoint(originalIncomingStart, originalIncoming)
                : null
            const outgoingArcThrough =
              originalOutgoing?.type === 'arc'
                ? arcControlPoint(currentAnchor, originalOutgoing)
                : null

            const dx = nextPoint.x - currentAnchor.x
            const dy = nextPoint.y - currentAnchor.y

            if (anchorIndex === 0) {
              nextProfile.start = nextPoint
              const closingSegment = nextProfile.closed ? nextProfile.segments[segmentCount - 1] : null
              if (closingSegment) {
                closingSegment.to = nextPoint
                if (closingSegment.type === 'bezier') {
                  closingSegment.control2 = translatePoint(closingSegment.control2, dx, dy)
                }
              }
            } else if (anchorIndex === anchorCount - 1 && !nextProfile.closed) {
              nextProfile.segments[segmentCount - 1].to = nextPoint
              const incomingSegment = nextProfile.segments[segmentCount - 1]
              if (incomingSegment.type === 'bezier') {
                incomingSegment.control2 = translatePoint(incomingSegment.control2, dx, dy)
              }
            } else if (anchorIndex > 0) {
              nextProfile.segments[anchorIndex - 1].to = nextPoint
              const incomingSegment = nextProfile.segments[anchorIndex - 1]
              if (incomingSegment.type === 'bezier') {
                incomingSegment.control2 = translatePoint(incomingSegment.control2, dx, dy)
              }
            }

            const incomingSegment = incomingIndex !== null ? nextProfile.segments[incomingIndex] : null
            if (incomingSegment?.type === 'arc' && incomingArcThrough) {
              const incomingStart =
                incomingIndex !== null && incomingIndex === 0
                  ? nextProfile.start
                  : incomingIndex !== null
                    ? nextProfile.segments[incomingIndex - 1]?.to
                    : null
              if (incomingStart) {
                const rebuiltIncoming = buildArcSegmentFromThreePoints(incomingStart, incomingSegment.to, incomingArcThrough)
                if (rebuiltIncoming && incomingIndex !== null) {
                  nextProfile.segments[incomingIndex] = rebuiltIncoming
                }
              }
            }

            const outgoingSegment = outgoingIndex !== null ? nextProfile.segments[outgoingIndex] : null
            if (outgoingSegment?.type === 'arc' && outgoingArcThrough) {
              const outgoingStart = anchorIndex === 0 ? nextProfile.start : nextProfile.segments[anchorIndex - 1]?.to
              if (outgoingStart) {
                const rebuiltOutgoing = buildArcSegmentFromThreePoints(outgoingStart, outgoingSegment.to, outgoingArcThrough)
                if (rebuiltOutgoing && outgoingIndex !== null) {
                  nextProfile.segments[outgoingIndex] = rebuiltOutgoing
                }
              }
            }

            if (outgoingSegment?.type === 'bezier') {
              outgoingSegment.control1 = translatePoint(outgoingSegment.control1, dx, dy)
            }
          }

          if (control.kind === 'anchor') {
            moveAnchor(control.index, point)
          } else if (control.kind === 'segment') {
            const segment = nextProfile.segments[control.index]
            if (segment?.type !== 'line') {
              return feature
            }

            const segmentStartIndex = control.index
            const segmentEndIndex = nextProfile.closed ? (control.index + 1) % anchorCount : control.index + 1
            const segmentStart = anchorPointForIndex(nextProfile, segmentStartIndex)
            const hitPoint = lerpPoint(segmentStart, segment.to, Math.max(0, Math.min(1, control.t ?? 0.5)))
            const dx = point.x - hitPoint.x
            const dy = point.y - hitPoint.y
            moveAnchor(segmentStartIndex, translatePoint(segmentStart, dx, dy))
            moveAnchor(segmentEndIndex, translatePoint(segment.to, dx, dy))
          } else if (control.kind === 'out_handle') {
            const outgoingSegment = nextProfile.segments[control.index]
            if (outgoingSegment?.type === 'bezier') {
              outgoingSegment.control1 = point

              const incomingSegment =
                nextProfile.closed
                  ? nextProfile.segments[(control.index - 1 + segmentCount) % segmentCount]
                  : control.index > 0
                    ? nextProfile.segments[control.index - 1]
                    : null
              const anchor = anchorPointForIndex(nextProfile, control.index)

              if (incomingSegment?.type === 'bezier' && anchor) {
                const oppositeLength = pointLength(subtractPoint(incomingSegment.control2, anchor))
                const direction = normalizePoint(subtractPoint(point, anchor))
                if (direction && oppositeLength > 1e-9) {
                  incomingSegment.control2 = subtractPoint(anchor, scalePoint(direction, oppositeLength))
                }
              }
            }
          } else if (control.kind === 'arc_handle') {
            const segmentIndex = control.index
            const arcSegment = nextProfile.segments[segmentIndex]
            if (arcSegment?.type === 'arc') {
              const arcStart =
                segmentIndex === 0 ? nextProfile.start : nextProfile.segments[segmentIndex - 1]?.to
              if (!arcStart) {
                return feature
              }

              const rebuiltSegment = buildArcSegmentFromThreePoints(arcStart, arcSegment.to, point)
              if (rebuiltSegment) {
                nextProfile.segments[segmentIndex] = rebuiltSegment
              }
            }
          } else if (control.kind === 'circle_center') {
            const seg = nextProfile.segments[control.index]
            if (seg?.type === 'circle') {
              const dx = point.x - seg.center.x
              const dy = point.y - seg.center.y
              seg.center = point
              nextProfile.start = translatePoint(nextProfile.start, dx, dy)
              seg.to = nextProfile.start
            }
          } else {
            const incomingSegment =
              nextProfile.closed
                ? nextProfile.segments[(control.index - 1 + segmentCount) % segmentCount]
                : control.index > 0
                  ? nextProfile.segments[control.index - 1]
                  : null
            if (incomingSegment?.type === 'bezier') {
              incomingSegment.control2 = point

              const outgoingSegment = nextProfile.segments[control.index]
              const anchor = anchorPointForIndex(nextProfile, control.index)

              if (outgoingSegment?.type === 'bezier' && anchor) {
                const oppositeLength = pointLength(subtractPoint(outgoingSegment.control1, anchor))
                const direction = normalizePoint(subtractPoint(point, anchor))
                if (direction && oppositeLength > 1e-9) {
                  outgoingSegment.control1 = subtractPoint(anchor, scalePoint(direction, oppositeLength))
                }
              }
            }
          }

          const normalizedProfile = normalizeEditableProfileClosure(nextProfile)
          return {
            ...feature,
            sketch: {
              ...feature.sketch,
              profile: normalizedProfile,
            },
            kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(normalizedProfile),
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      // Update owner constraint values to reflect new geometry (Policy #1: owner edited → update value)
      nextProject.features = restoreResolvedMetadata(
        nextProject,
        clearStaleConstraints(nextProject.features, new Set([featureId])),
      )
      // Propagate to features that depend on the edited feature (Policy #2: reference edited → dependents follow)
      nextProject.features = restoreResolvedMetadata(
        nextProject,
        propagateConstraintsOnTranslate(
          nextProject.features,
          new Map([[featureId, { dx: 0, dy: 0 }]]),
          { transformProfile },
        ),
      )
      // Validate all constraints and mark invalid ones red
      const featureByIdMap = new Map(nextProject.features.map((f) => [f.id, f]))
      nextProject.features = restoreResolvedMetadata(nextProject, nextProject.features.map((f) => {
        if (f.sketch.constraints.every((c) => c.type !== 'fixed_distance')) return f
        return validateConstraintsOnFeature(f, featureByIdMap)
      }))
      let authoritativeProject = syncEditedFeatureDefinition(nextProject, featureId)
      // Sync stock if the edited feature is the stock source
      authoritativeProject = syncFeatureBasedStock(authoritativeProject)
      if (projectsEqual(authoritativeProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: authoritativeProject }
      }
      return {
        project: authoritativeProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  insertFeaturePoint: (featureId, target) =>
    set((s) => {
      let changed = false
      const editableProject = resolveProject(s.project)
      const nextProject: ResolvedProject = {
        ...editableProject,
        features: editableProject.features.map((feature) => {
          if (feature.id !== featureId || feature.locked) {
            return feature
          }

          const nextProfile = normalizeEditableProfileClosure(insertPointIntoProfile(feature.sketch.profile, target))
          if (JSON.stringify(nextProfile) === JSON.stringify(feature.sketch.profile)) {
            return feature
          }

          changed = true
          return {
            ...feature,
            kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(nextProfile),
            sketch: {
              ...feature.sketch,
              profile: nextProfile,
            },
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      if (!changed || projectsEqual(nextProject, s.project)) {
        return {}
      }

      let authoritativeProject = syncEditedFeatureDefinition(nextProject, featureId)
      authoritativeProject = syncFeatureBasedStock(authoritativeProject)

      return {
        project: authoritativeProject,
        selection: {
          ...s.selection,
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  joinOpenFeatureEndpoints: (featureId, endpoint, targetFeatureId, targetEndpoint) => {
    let didJoin = false
    set((s) => {
      const editableProject = resolveProject(s.project)
      const feature = editableProject.features.find((entry) => entry.id === featureId) ?? null
      const targetFeature = editableProject.features.find((entry) => entry.id === targetFeatureId) ?? null
      if (
        !feature
        || !targetFeature
        || feature.locked
        || targetFeature.locked
        || feature.sketch.profile.closed
        || targetFeature.sketch.profile.closed
      ) {
        return {}
      }

      const nextProfile =
        featureId === targetFeatureId
          ? endpoint === targetEndpoint
            ? null
            : closeOpenProfile(feature.sketch.profile)
          : joinOpenProfiles(feature.sketch.profile, endpoint, targetFeature.sketch.profile, targetEndpoint)
      if (!nextProfile) {
        return {}
      }

      const removedFeatureIds = new Set(featureId === targetFeatureId ? [] : [targetFeatureId])
      const nextEditableProject: ResolvedProject = {
        ...editableProject,
        features: editableProject.features
          .filter((entry) => !removedFeatureIds.has(entry.id))
          .map((entry) => {
            if (entry.id === featureId) {
              // If closing an open profile (line), reset operation to 'subtract'
              const updatedOperation = entry.operation === 'line' && nextProfile.closed ? 'subtract' : entry.operation
              return {
                ...entry,
                operation: updatedOperation,
                kind: ['text', 'stl'].includes(entry.kind) ? entry.kind : inferFeatureKind(nextProfile),
                sketch: {
                  ...entry.sketch,
                  profile: nextProfile,
                  constraints: entry.sketch.constraints.map((constraint) => {
                    const refId = constraint.reference_feature_id ?? constraint.segment_ids[0]
                    if (constraint.type === 'fixed_distance' && refId && removedFeatureIds.has(refId)) {
                      return {
                        ...constraint,
                        is_invalid: true,
                        error_message: 'Reference feature was joined into another feature',
                      }
                    }
                    return constraint
                  }),
                },
              }
            }

            if (removedFeatureIds.size === 0 || entry.sketch.constraints.every((constraint) => constraint.type !== 'fixed_distance')) {
              return entry
            }

            const constraints = entry.sketch.constraints.map((constraint) => {
              const refId = constraint.reference_feature_id ?? constraint.segment_ids[0]
              if (constraint.type === 'fixed_distance' && refId && removedFeatureIds.has(refId)) {
                return {
                  ...constraint,
                  is_invalid: true,
                  error_message: 'Reference feature was joined into another feature',
                }
              }
              return constraint
            })

            return {
              ...entry,
              sketch: {
                ...entry.sketch,
                constraints,
              },
            }
          }),
        featureTree: editableProject.featureTree.filter((entry) => !(entry.type === 'feature' && removedFeatureIds.has(entry.featureId))),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      let nextProject = syncEditedFeatureDefinition(nextEditableProject, featureId)
      nextProject = syncFeatureTreeProject({
        ...nextProject,
        featureDefinitions: gcOrphanedDefinitions(
          nextProject.features,
          nextProject.featureDefinitions,
          nextProject.stock.sourceFeature,
        ).definitions,
      })
      nextProject = syncFeatureBasedStock(nextProject)
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }

      didJoin = true
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: featureId,
          selectedFeatureIds: [featureId],
          selectedNode: { type: 'feature', featureId },
          activeControl: null,
        },
        history: s.history.transactionStart
          ? s.history
          : {
              past: [...s.history.past, cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
      }
    })

    return didJoin
  },

  deleteFeaturePoint: (featureId, anchorIndex) =>
    set((s) => {
      let changed = false
      const editableProject = resolveProject(s.project)
      const nextProject: ResolvedProject = {
        ...editableProject,
        features: editableProject.features.map((feature) => {
          if (feature.id !== featureId || feature.locked) {
            return feature
          }

          const nextProfileResult = deleteAnchorFromProfile(feature.sketch.profile, anchorIndex)
          const nextProfile = nextProfileResult ? normalizeEditableProfileClosure(nextProfileResult) : null
          if (!nextProfile) {
            return feature
          }

          changed = true
          return {
            ...feature,
            kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(nextProfile),
            sketch: {
              ...feature.sketch,
              profile: nextProfile,
            },
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      if (!changed || projectsEqual(nextProject, s.project)) {
        return {}
      }

      let authoritativeProject = syncEditedFeatureDefinition(nextProject, featureId)
      authoritativeProject = syncFeatureBasedStock(authoritativeProject)

      return {
        project: authoritativeProject,
        selection: {
          ...s.selection,
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  deleteFeatureSegment: (featureId, segmentIndex) =>
    applyProfileBreak(featureId, (profile) => deleteSegmentFromProfile(profile, segmentIndex)),

  disconnectFeaturePoint: (featureId, anchorIndex) =>
    applyProfileBreak(featureId, (profile) => disconnectProfileAtAnchor(profile, anchorIndex)),

  filletFeaturePoint: (featureId, anchorIndex, radius) =>
    set((s) => {
      let changed = false
      const editableProject = resolveProject(s.project)
      const nextProject: ResolvedProject = {
        ...editableProject,
        features: editableProject.features.map((feature) => {
          if (feature.id !== featureId || feature.locked) {
            return feature
          }

          const nextProfile = applyLineCornerFillet(feature.sketch.profile, anchorIndex, radius)
          if (!nextProfile || JSON.stringify(nextProfile) === JSON.stringify(feature.sketch.profile)) {
            return feature
          }

          changed = true
          return {
            ...feature,
            kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(nextProfile),
            sketch: {
              ...feature.sketch,
              profile: nextProfile,
            },
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      if (!changed || projectsEqual(nextProject, s.project)) {
        return {}
      }

      let authoritativeProject = syncEditedFeatureDefinition(nextProject, featureId)
      authoritativeProject = syncFeatureBasedStock(authoritativeProject)

      return {
        project: authoritativeProject,
        selection: {
          ...s.selection,
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  chamferFeaturePoint: (featureId, anchorIndex, distance) =>
    set((s) => {
      let changed = false
      const editableProject = resolveProject(s.project)
      const nextProject: ResolvedProject = {
        ...editableProject,
        features: editableProject.features.map((feature) => {
          if (feature.id !== featureId || feature.locked) {
            return feature
          }

          const nextProfile = applyLineCornerChamfer(feature.sketch.profile, anchorIndex, distance)
          if (!nextProfile || JSON.stringify(nextProfile) === JSON.stringify(feature.sketch.profile)) {
            return feature
          }

          changed = true
          return {
            ...feature,
            kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(nextProfile),
            sketch: {
              ...feature.sketch,
              profile: nextProfile,
            },
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      if (!changed || projectsEqual(nextProject, s.project)) {
        return {}
      }

      let authoritativeProject = syncEditedFeatureDefinition(nextProject, featureId)
      authoritativeProject = syncFeatureBasedStock(authoritativeProject)

      return {
        project: authoritativeProject,
        selection: {
          ...s.selection,
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  trimFeatureSegment: (subjectRef, cutterRef) => {
    const hints: string[] = []
    set((s) => {
      const subjectFeature = resolveFeatureInstance(s.project, subjectRef.featureId)
      if (!subjectFeature || subjectFeature.locked) {
        hints.push('Subject feature not found or locked')
        return {}
      }

      const profile = subjectFeature.sketch.profile
      if (profile.closed) {
        hints.push('Subject profile is closed — MVP trim only works on open profiles')
        return {}
      }

      const segCount = profile.segments.length
      if (segCount === 0) {
        hints.push('Subject profile has no segments')
        return {}
      }

      // Resolve all subject segments (1:1 with profile.segments)
      const subjectResolved = resolveProfileSegments(profile)
      const clickedIdx = subjectRef.segmentIndex
      const clickedSeg = subjectResolved[clickedIdx]
      if (!clickedSeg) {
        hints.push('Subject segment is a bezier — cannot trim')
        return {}
      }

      // Guard degenerate clicked segment (zero-length line)
      if (clickedSeg.kind === 'line') {
        const sdx = clickedSeg.p1.x - clickedSeg.p0.x
        const sdy = clickedSeg.p1.y - clickedSeg.p0.y
        if (Math.hypot(sdx, sdy) < 1e-9) {
          hints.push('Subject segment has zero length')
          return {}
        }
      }

      // Resolve cutter segment
      const cutterFeature = resolveFeatureInstance(s.project, cutterRef.featureId)
      if (!cutterFeature) {
        hints.push('Cutter feature not found')
        return {}
      }
      const cutterResolved = resolveProfileSegments(cutterFeature.sketch.profile)
      const cutterSeg = cutterResolved[cutterRef.segmentIndex]
      if (!cutterSeg) {
        hints.push('Cutter segment is a bezier — cannot use as reference')
        return {}
      }

      const clickT = subjectRef.t ?? 0.5

      // ── Walk from each open end to find boundary segments ──────────────

      interface EndCandidate {
        end: 'start' | 'end'
        boundaryIdx: number
        hitT: number
        hitPoint: Point
        /** Whole segments to drop (not including the boundary) */
        wholeSegmentsDropped: number[]
      }

      const candidates: EndCandidate[] = []

      // Walk from the start end (forward through segments 0..N-1)
      for (let i = 0; i < segCount; i++) {
        const seg = subjectResolved[i]
        if (!seg) continue
        const hits = segmentIntersections(seg, cutterSeg)
        if (hits.length > 0) {
          // Pick the hit closest to the free start (smallest tA),
          // skipping endpoint hits (adjacent segments touching the cutter)
          hits.sort((a, b) => a.tA - b.tA)
          const hit = hits.find((h) => h.tA > 1e-9 && h.tA < 1 - 1e-9)
          if (!hit) continue

          candidates.push({
            end: 'start',
            boundaryIdx: i,
            hitT: hit.tA,
            hitPoint: hit.point,
            wholeSegmentsDropped: Array.from({ length: i }, (_, j) => j),
          })
          break
        }
      }

      // Walk from the end end (backward through segments N-1..0)
      for (let i = segCount - 1; i >= 0; i--) {
        const seg = subjectResolved[i]
        if (!seg) continue
        const hits = segmentIntersections(seg, cutterSeg)
        if (hits.length > 0) {
          // Pick the hit closest to the free end (largest tA),
          // skipping endpoint hits (adjacent segments touching the cutter)
          hits.sort((a, b) => b.tA - a.tA)
          const hit = hits.find((h) => h.tA > 1e-9 && h.tA < 1 - 1e-9)
          if (!hit) continue

          candidates.push({
            end: 'end',
            boundaryIdx: i,
            hitT: hit.tA,
            hitPoint: hit.point,
            wholeSegmentsDropped: Array.from(
              { length: segCount - 1 - i },
              (_, j) => i + 1 + j,
            ),
          })
          break
        }
      }

      if (candidates.length === 0) {
        hints.push("Cutting edge doesn't cross any segment of this profile")
        return {}
      }

      // ── Pick the candidate whose removal region contains the click ──────

      function candidateContainsClick(c: EndCandidate): boolean {
        if (c.end === 'start') {
          // Removal region: segments 0..boundaryIdx-1 (whole) +
          // boundary segment t ∈ [0, hitT]
          if (clickedIdx < c.boundaryIdx) return true
          if (clickedIdx === c.boundaryIdx && clickT <= c.hitT + 1e-9) return true
          return false
        } else {
          // end === 'end'
          // Removal region: boundary segment t ∈ [hitT, 1] +
          // segments boundaryIdx+1..N-1 (whole)
          if (clickedIdx > c.boundaryIdx) return true
          if (clickedIdx === c.boundaryIdx && clickT >= c.hitT - 1e-9) return true
          return false
        }
      }

      const chosen = candidates.find(candidateContainsClick)

      if (!chosen) {
        hints.push('Interior trim (break) not yet implemented for MVP')
        return {}
      }

      // ── Apply the multi-segment trim ────────────────────────────────────
      let changed = false
      const editableProject = resolveProject(s.project)
      const nextProject: ResolvedProject = {
        ...editableProject,
        features: editableProject.features.map((feature) => {
          if (feature.id !== subjectRef.featureId) return feature

          const nextProfile: SketchProfile = {
            start: clonePoint(feature.sketch.profile.start),
            segments: feature.sketch.profile.segments.map((seg) =>
              cloneSegment(seg),
            ),
            closed: false,
          }

          const { boundaryIdx, hitPoint, end, wholeSegmentsDropped } = chosen

          // Sort dropped indices descending so splice indices stay valid
          const sortedDropped = [...wholeSegmentsDropped].sort((a, b) => b - a)

          if (end === 'start') {
            // Trim the boundary segment from its start side
            const boundarySeg = nextProfile.segments[boundaryIdx]
            if (boundarySeg.type === 'arc') {
              const [, kept] = splitArcSegment(boundarySeg, hitPoint)
              nextProfile.segments[boundaryIdx] = kept
            } else if (boundarySeg.type === 'line') {
              nextProfile.segments[boundaryIdx] = {
                type: 'line',
                to: clonePoint(boundarySeg.to),
              }
            }

            // Drop whole segments before the boundary
            for (const idx of sortedDropped) {
              nextProfile.segments.splice(idx, 1)
            }

            nextProfile.start = hitPoint
          } else {
            // end === 'end' — trim the boundary segment from its end side
            const boundarySeg = nextProfile.segments[boundaryIdx]
            if (boundarySeg.type === 'arc') {
              const [kept] = splitArcSegment(boundarySeg, hitPoint)
              nextProfile.segments[boundaryIdx] = kept
            } else if (boundarySeg.type === 'line') {
              nextProfile.segments[boundaryIdx] = {
                type: 'line',
                to: hitPoint,
              }
            }

            // Drop whole segments after the boundary
            for (const idx of sortedDropped) {
              nextProfile.segments.splice(idx, 1)
            }
          }

          const normalized = normalizeEditableProfileClosure(nextProfile)
          changed = true

          return {
            ...feature,
            kind: ['text', 'stl'].includes(feature.kind)
              ? feature.kind
              : inferFeatureKind(normalized),
            sketch: {
              ...feature.sketch,
              profile: normalized,
            },
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      if (!changed || projectsEqual(nextProject, s.project)) return {}

      let authoritativeProject = syncEditedFeatureDefinition(nextProject, subjectRef.featureId)
      authoritativeProject = syncFeatureBasedStock(authoritativeProject)

      return {
        project: authoritativeProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    })
    return hints
  },

  extendFeatureEndpoint: (subjectRef, targetRef) => {
    const hints: string[] = []
    set((s) => {
      const subjectFeature = resolveFeatureInstance(s.project, subjectRef.featureId)
      if (!subjectFeature || subjectFeature.locked) {
        hints.push('Subject feature not found or locked')
        return {}
      }

      const profile = subjectFeature.sketch.profile
      if (profile.closed) {
        hints.push('Subject profile is closed — cannot extend a closed profile')
        return {}
      }

      const segCount = profile.segments.length
      if (segCount === 0) {
        hints.push('Subject profile has no segments')
        return {}
      }

      const segIndex = subjectRef.segmentIndex
      const isFirst = segIndex === 0
      const isLast = segIndex === segCount - 1
      if (!isFirst && !isLast) {
        hints.push('Picked segment is not an end segment — MVP only extends free ends')
        return {}
      }

      // Determine the growing end: for an end segment, the free profile endpoint
      // is at t=0 for the first segment's start, or t=1 for the last segment's to.
      const t = subjectRef.t ?? 0.5
      let growingEnd: 'start' | 'end'
      if (isFirst && isLast) {
        // Single-segment: both ends are free — the click decides which grows.
        growingEnd = t < 0.5 ? 'start' : 'end'
      } else if (isFirst) {
        // First of 2+ segments: only profile.start is free — always grow it,
        // regardless of where on the segment the user clicked.
        growingEnd = 'start'
      } else {
        // Last of 2+ segments: only the last segment's `to` is free.
        growingEnd = 'end'
      }

      // Resolve segments
      const subjectResolved = resolveProfileSegments(profile)
      const subjectSeg = subjectResolved[segIndex]
      if (!subjectSeg) {
        hints.push('Subject segment is a bezier — cannot extend')
        return {}
      }

      const targetFeature = resolveFeatureInstance(s.project, targetRef.featureId)
      if (!targetFeature) {
        hints.push('Target feature not found')
        return {}
      }
      const targetResolved = resolveProfileSegments(targetFeature.sketch.profile)
      const targetSeg = targetResolved[targetRef.segmentIndex]
      if (!targetSeg) {
        hints.push('Target segment is a bezier — cannot use as reference')
        return {}
      }

      // Build the forward extension ray from the growing end.
      // tA=0 is always at the growing endpoint; tA>0 is forward.
      const growingPoint =
        growingEnd === 'start'
          ? profile.start
          : profile.segments[segCount - 1].to
      let extension: ResolvedSeg

      if (subjectSeg.kind === 'line') {
        const dx = subjectSeg.p1.x - subjectSeg.p0.x
        const dy = subjectSeg.p1.y - subjectSeg.p0.y
        const len = Math.hypot(dx, dy)
        if (len < 1e-9) {
          hints.push('Subject segment has zero length')
          return {}
        }
        const ux = dx / len
        const uy = dy / len
        if (growingEnd === 'start') {
          // Extend backward from profile.start
          extension = {
            kind: 'line',
            p0: { x: growingPoint.x, y: growingPoint.y },
            p1: { x: growingPoint.x - ux * 1e5, y: growingPoint.y - uy * 1e5 },
          }
        } else {
          // Extend forward from last-segment endpoint
          extension = {
            kind: 'line',
            p0: { x: growingPoint.x, y: growingPoint.y },
            p1: { x: growingPoint.x + ux * 1e5, y: growingPoint.y + uy * 1e5 },
          }
        }
      } else {
        // Arc: extend along the circle from the growing end
        const FULL = 2 * Math.PI
        if (growingEnd === 'start') {
          // Extend backward from a0 — go full circle in reverse direction
          extension = {
            ...subjectSeg,
            a0: subjectSeg.a0,
            a1: subjectSeg.ccw ? subjectSeg.a0 - FULL : subjectSeg.a0 + FULL,
            ccw: !subjectSeg.ccw,
          }
        } else {
          // Extend forward from a1 — go full circle in same sweep direction
          extension = {
            ...subjectSeg,
            a0: subjectSeg.a1,
            a1: subjectSeg.ccw ? subjectSeg.a1 + FULL : subjectSeg.a1 - FULL,
          }
        }
      }

      // Primary intersection: extension ray × target segment extent
      let hits = segmentIntersections(extension, targetSeg, { rayA: true })
      // Keep only forward hits (tA > 0, i.e., beyond the current endpoint)
      hits = hits.filter((h) => h.tA > 1e-9)

      // Apparent-intersection fallback: retry against the target's supporting
      // infinite line (through its two endpoints).
      if (hits.length === 0) {
        let fallbackLine: LineSeg
        if (targetSeg.kind === 'line') {
          const tdx = targetSeg.p1.x - targetSeg.p0.x
          const tdy = targetSeg.p1.y - targetSeg.p0.y
          fallbackLine = {
            kind: 'line',
            p0: { x: targetSeg.p0.x - tdx * 1e5, y: targetSeg.p0.y - tdy * 1e5 },
            p1: { x: targetSeg.p1.x + tdx * 1e5, y: targetSeg.p1.y + tdy * 1e5 },
          }
        } else {
          // Arc target: build line through arc endpoints
          const a0x = targetSeg.center.x + targetSeg.radius * Math.cos(targetSeg.a0)
          const a0y = targetSeg.center.y + targetSeg.radius * Math.sin(targetSeg.a0)
          const a1x = targetSeg.center.x + targetSeg.radius * Math.cos(targetSeg.a1)
          const a1y = targetSeg.center.y + targetSeg.radius * Math.sin(targetSeg.a1)
          const tdx = a1x - a0x
          const tdy = a1y - a0y
          fallbackLine = {
            kind: 'line',
            p0: { x: a0x - tdx * 1e5, y: a0y - tdy * 1e5 },
            p1: { x: a1x + tdx * 1e5, y: a1y + tdy * 1e5 },
          }
        }
        const fallbackHits = segmentIntersections(extension, fallbackLine, { rayA: true })
        hits = fallbackHits.filter((h) => h.tA > 1e-9)
      }

      if (hits.length === 0) {
        hints.push('No intersection found — target is parallel or out of reach')
        return {}
      }

      // Nearest forward hit
      hits.sort((a, b) => a.tA - b.tA)
      const hit = hits[0].point

      // Apply the extension: move the growing endpoint to the hit point
      let changed = false
      const editableProject = resolveProject(s.project)
      const nextProject: ResolvedProject = {
        ...editableProject,
        features: editableProject.features.map((feature) => {
          if (feature.id !== subjectRef.featureId) return feature

          const nextProfile = {
            ...feature.sketch.profile,
            start: clonePoint(feature.sketch.profile.start),
            segments: feature.sketch.profile.segments.map((seg) => ({
              ...seg,
              to: clonePoint(seg.to),
            })),
          }

          if (growingEnd === 'start') {
            nextProfile.start = hit
          } else {
            nextProfile.segments[segCount - 1].to = hit
          }

          const normalized = normalizeEditableProfileClosure(nextProfile)
          changed = true

          return {
            ...feature,
            kind: ['text', 'stl'].includes(feature.kind)
              ? feature.kind
              : inferFeatureKind(normalized),
            sketch: {
              ...feature.sketch,
              profile: normalized,
            },
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      if (!changed || projectsEqual(nextProject, s.project)) return {}

      let authoritativeProject = syncEditedFeatureDefinition(nextProject, subjectRef.featureId)
      authoritativeProject = syncFeatureBasedStock(authoritativeProject)

      return {
        project: authoritativeProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    })
    return hints
  },

  makeUnique: (instanceId) =>
    set((s) => {
      const result = makeUniqueHelper(s.project, instanceId)
      if (!result) return {}

      const nextProject = {
        ...s.project,
        featureDefinitions: {
          ...s.project.featureDefinitions,
          [result.newDefinitionId]: result.clonedDefinition,
        },
        features: result.features,
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
