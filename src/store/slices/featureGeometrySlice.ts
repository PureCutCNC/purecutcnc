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
  syncStockFromSourceFeature,
} from '../helpers/normalize'
import {
  profileVertices,
  type Project,
  type Point,
  type SketchFeature,
  type SketchProfile,
} from '../../types/project'
import type { OpenProfileEndpoint } from '../types'
import type { ProjectStore } from '../types'
import { clonePoint, lerpPoint, normalizePoint, pointLength, scalePoint, subtractPoint } from '../helpers/geometry'
import { translatePoint, transformProfile } from '../helpers/transform'
import {
  anchorPointForIndex,
  applyLineCornerFillet,
  arcControlPoint,
  buildArcSegmentFromThreePoints,
  closeOpenProfile,
  deleteAnchorFromProfile,
  deleteSegmentFromProfile,
  disconnectProfileAtAnchor,
  insertPointIntoProfile,
  normalizeEditableProfileClosure,
  type ProfileBreakResult,
} from '../helpers/profileEdit'
import { getDefinitionId, makeUnique as makeUniqueHelper, rebakeAllInstances } from '../helpers/featureDefinitions'

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

  function syncEditedFeatureDefinition(project: Project, featureId: string, editingFeatureId?: string): Project {
    const editedFeature = project.features.find((feature) => feature.id === featureId)
    if (!editedFeature) return project

    const definitionId = getDefinitionId(editedFeature)
    const definition = project.featureDefinitions[definitionId]
    if (!definition) return project

    const nextDefinition = {
      ...definition,
      kind: editedFeature.kind,
      profile: editedFeature.sketch.profile,
      dimensions: editedFeature.sketch.dimensions.map((dimension) => ({ ...dimension })),
      text: editedFeature.text ? { ...editedFeature.text } : null,
      stl: editedFeature.stl ? { ...editedFeature.stl } : null,
      operation: editedFeature.operation,
    }
    const nextProject = {
      ...project,
      featureDefinitions: {
        ...project.featureDefinitions,
        [definitionId]: nextDefinition,
      },
    }
    return {
      ...nextProject,
      features: rebakeAllInstances(nextProject, definitionId, { editingFeatureId }),
    }
  }

  return {
  moveFeatureControl: (featureId, control, point) =>
    set((s) => {
      let nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => {
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
      nextProject.features = clearStaleConstraints(nextProject.features, new Set([featureId]))
      // Propagate to features that depend on the edited feature (Policy #2: reference edited → dependents follow)
      nextProject.features = propagateConstraintsOnTranslate(
        nextProject.features,
        new Map([[featureId, { dx: 0, dy: 0 }]]),
        { transformProfile },
      )
      // Validate all constraints and mark invalid ones red
      const featureByIdMap = new Map(nextProject.features.map((f) => [f.id, f]))
      nextProject.features = nextProject.features.map((f) => {
        if (f.sketch.constraints.every((c) => c.type !== 'fixed_distance')) return f
        return validateConstraintsOnFeature(f, featureByIdMap)
      })
      nextProject = syncEditedFeatureDefinition(
        nextProject,
        featureId,
        s.selection.mode === 'sketch_edit' ? featureId : undefined,
      )
      // Sync stock if the edited feature is the stock source
      nextProject = syncStockFromSourceFeature(nextProject, featureId)
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

  insertFeaturePoint: (featureId, target) =>
    set((s) => {
      let changed = false
      let nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => {
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

      nextProject = syncEditedFeatureDefinition(
        nextProject,
        featureId,
        s.selection.mode === 'sketch_edit' ? featureId : undefined,
      )
      nextProject = syncStockFromSourceFeature(nextProject, featureId)

      return {
        project: nextProject,
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
      const feature = s.project.features.find((entry) => entry.id === featureId) ?? null
      const targetFeature = s.project.features.find((entry) => entry.id === targetFeatureId) ?? null
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
      let nextProject = syncFeatureTreeProject({
        ...s.project,
        features: s.project.features
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
        featureTree: s.project.featureTree.filter((entry) => !(entry.type === 'feature' && removedFeatureIds.has(entry.featureId))),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })

      nextProject = syncEditedFeatureDefinition(
        nextProject,
        featureId,
        s.selection.mode === 'sketch_edit' ? featureId : undefined,
      )
      nextProject = syncStockFromSourceFeature(nextProject, featureId)
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
      let nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => {
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

      nextProject = syncEditedFeatureDefinition(
        nextProject,
        featureId,
        s.selection.mode === 'sketch_edit' ? featureId : undefined,
      )
      nextProject = syncStockFromSourceFeature(nextProject, featureId)

      return {
        project: nextProject,
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
      let nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => {
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

      nextProject = syncEditedFeatureDefinition(
        nextProject,
        featureId,
        s.selection.mode === 'sketch_edit' ? featureId : undefined,
      )
      nextProject = syncStockFromSourceFeature(nextProject, featureId)

      return {
        project: nextProject,
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
