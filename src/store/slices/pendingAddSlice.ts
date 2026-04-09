import type { StateCreator } from 'zustand'
import { convertLength } from '../../utils/units'
import type { Clamp, Point, Project, Segment, SketchFeature, Tab } from '../../types/project'
import type { TextToolConfig } from '../../text'
import { nextPlacementSession, nextUniqueGeneratedId } from '../helpers/ids'
import { clonePoint, pointsEqual } from '../helpers/geometry'
import type { CompositeSegmentMode, PendingAddTool, ProjectStore } from '../types'

export interface PendingAddSliceDependencies {
  cloneProject: (project: Project) => Project
  syncFeatureTreeProject: (project: Project) => Project
  createTextFeatureAt: (project: Project, config: TextToolConfig, anchor: Point) => SketchFeature | null
  appendSplineDraftSegment: (start: Point, segments: Segment[], to: Point) => Segment[]
  buildArcSegmentFromThreePoints: (start: Point, end: Point, through: Point) => Segment | null
  resolveCompositeDraftSegments: (draft: Extract<PendingAddTool, { shape: 'composite' }>) => Segment[] | null
  resolveOpenCompositeDraftSegments: (draft: Extract<PendingAddTool, { shape: 'composite' }>) => Segment[] | null
  cloneSegment: (segment: Segment) => Segment
}

export type PendingAddSlice = Pick<
  ProjectStore,
  | 'pendingAdd'
  | 'startAddClampPlacement'
  | 'startAddTabPlacement'
  | 'startAddRectPlacement'
  | 'startAddCirclePlacement'
  | 'startAddPolygonPlacement'
  | 'startAddSplinePlacement'
  | 'startAddCompositePlacement'
  | 'startAddTextPlacement'
  | 'cancelPendingAdd'
  | 'setPendingAddAnchor'
  | 'placePendingAddAt'
  | 'placePendingTextAt'
  | 'addPendingPolygonPoint'
  | 'undoPendingPolygonPoint'
  | 'completePendingPolygon'
  | 'completePendingOpenPath'
  | 'setPendingCompositeMode'
  | 'addPendingCompositePoint'
  | 'undoPendingCompositeStep'
  | 'closePendingCompositeDraft'
  | 'completePendingComposite'
  | 'completePendingOpenComposite'
>

function resetFeaturePlacementSelection(selection: ProjectStore['selection']): ProjectStore['selection'] {
  return {
    ...selection,
    mode: 'feature',
    hoveredFeatureId: null,
    activeControl: null,
  }
}

export function createPendingAddSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
  deps: PendingAddSliceDependencies,
): PendingAddSlice {
  return {
    pendingAdd: null,

    startAddRectPlacement: () =>
      set((s) => ({
        pendingAdd: { shape: 'rect', anchor: null, session: nextPlacementSession() },
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        sketchEditSession: null,
        selection: resetFeaturePlacementSelection(s.selection),
      })),

    startAddTabPlacement: () =>
      set((s) => ({
        pendingAdd: { shape: 'tab', anchor: null, session: nextPlacementSession() },
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        sketchEditSession: null,
        selection: {
          ...resetFeaturePlacementSelection(s.selection),
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'tabs_root' },
        },
      })),

    startAddClampPlacement: () =>
      set((s) => ({
        pendingAdd: { shape: 'clamp', anchor: null, session: nextPlacementSession() },
        pendingMove: null,
        sketchEditSession: null,
        selection: {
          ...resetFeaturePlacementSelection(s.selection),
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'clamps_root' },
        },
      })),

    startAddCirclePlacement: () =>
      set((s) => ({
        pendingAdd: { shape: 'circle', anchor: null, session: nextPlacementSession() },
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        sketchEditSession: null,
        selection: resetFeaturePlacementSelection(s.selection),
      })),

    startAddPolygonPlacement: () =>
      set((s) => ({
        pendingAdd: { shape: 'polygon', points: [], session: nextPlacementSession() },
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        sketchEditSession: null,
        selection: resetFeaturePlacementSelection(s.selection),
      })),

    startAddSplinePlacement: () =>
      set((s) => ({
        pendingAdd: { shape: 'spline', points: [], session: nextPlacementSession() },
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        sketchEditSession: null,
        selection: resetFeaturePlacementSelection(s.selection),
      })),

    startAddCompositePlacement: () =>
      set((s) => ({
        pendingAdd: {
          shape: 'composite',
          start: null,
          lastPoint: null,
          segments: [],
          currentMode: 'line',
          pendingArcEnd: null,
          closed: false,
          session: nextPlacementSession(),
        },
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        sketchEditSession: null,
        selection: resetFeaturePlacementSelection(s.selection),
      })),

    startAddTextPlacement: (config) =>
      set((s) => ({
        pendingAdd: { shape: 'text', config, session: nextPlacementSession() },
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        sketchEditSession: null,
        selection: resetFeaturePlacementSelection(s.selection),
      })),

    cancelPendingAdd: () => set({ pendingAdd: null }),

    setPendingAddAnchor: (point) =>
      set((s) => ({
        pendingAdd:
          s.pendingAdd && 'anchor' in s.pendingAdd
            ? { ...s.pendingAdd, anchor: point }
            : s.pendingAdd,
      })),

    placePendingAddAt: (point) => {
      const state = get()
      if (!state.pendingAdd || !('anchor' in state.pendingAdd) || !state.pendingAdd.anchor) return

      const anchor = state.pendingAdd.anchor
      const depth = Math.min(state.project.stock.thickness, 10)
      const minSize = convertLength(0.01, 'mm', state.project.meta.units)

      if (state.pendingAdd.shape === 'rect' || state.pendingAdd.shape === 'tab' || state.pendingAdd.shape === 'clamp') {
        const x1 = anchor.x
        const y1 = anchor.y
        const x2 = point.x
        const y2 = point.y
        const x = Math.min(x1, x2)
        const y = Math.min(y1, y2)
        const width = Math.max(Math.abs(x2 - x1), minSize)
        const height = Math.max(Math.abs(y2 - y1), minSize)

        if (state.pendingAdd.shape === 'tab') {
          const id = nextUniqueGeneratedId(state.project, 'tb')
          const tabEntry: Tab = {
            id,
            name: `Tab ${state.project.tabs.length + 1}`,
            x,
            y,
            w: width,
            h: height,
            z_bottom: 0,
            z_top: Math.min(
              Math.max(convertLength(3, 'mm', state.project.meta.units), minSize),
              state.project.stock.thickness,
            ),
            visible: true,
          }

          set((s) => ({
            project: {
              ...s.project,
              tabs: [...s.project.tabs, tabEntry],
              meta: { ...s.project.meta, modified: new Date().toISOString() },
            },
            pendingAdd: null,
            selection: {
              ...s.selection,
              selectedFeatureId: null,
              selectedFeatureIds: [],
              selectedNode: { type: 'tab', tabId: id },
              mode: 'feature',
              activeControl: null,
            },
            history: {
              past: [...s.history.past, deps.cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
          }))
          return
        }

        if (state.pendingAdd.shape === 'clamp') {
          const id = nextUniqueGeneratedId(state.project, 'cl')
          const clampEntry: Clamp = {
            id,
            name: `Clamp ${state.project.clamps.length + 1}`,
            type: 'step_clamp',
            x,
            y,
            w: width,
            h: height,
            height: Math.min(
              Math.max(convertLength(8, 'mm', state.project.meta.units), minSize),
              state.project.stock.thickness,
            ),
            visible: true,
          }

          set((s) => ({
            project: {
              ...s.project,
              clamps: [...s.project.clamps, clampEntry],
              meta: { ...s.project.meta, modified: new Date().toISOString() },
            },
            pendingAdd: null,
            selection: {
              ...s.selection,
              selectedFeatureId: null,
              selectedFeatureIds: [],
              selectedNode: { type: 'clamp', clampId: id },
              mode: 'feature',
              activeControl: null,
            },
            history: {
              past: [...s.history.past, deps.cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
          }))
          return
        }

        state.addRectFeature(`Rect ${state.project.features.length + 1}`, x, y, width, height, depth)
      } else {
        const radius = Math.max(minSize, Math.hypot(point.x - anchor.x, point.y - anchor.y))
        state.addCircleFeature(`Circle ${state.project.features.length + 1}`, anchor.x, anchor.y, radius, depth)
      }

      set({ pendingAdd: null })
    },

    placePendingTextAt: (point) => {
      const state = get()
      if (state.pendingAdd?.shape !== 'text') {
        return []
      }

      const createdFeature = deps.createTextFeatureAt(state.project, state.pendingAdd.config, point)
      if (!createdFeature) {
        return []
      }

      set((s) => {
        const nextProject = deps.syncFeatureTreeProject({
          ...s.project,
          features: [...s.project.features, createdFeature],
          featureTree: [...s.project.featureTree, { type: 'feature', featureId: createdFeature.id }],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        const createdIds = [createdFeature.id]
        const primaryId = createdFeature.id
        return {
          project: nextProject,
          pendingAdd: null,
          selection: {
            ...s.selection,
            selectedFeatureId: primaryId,
            selectedFeatureIds: createdIds,
            selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
            mode: 'feature',
            activeControl: null,
          },
          history: {
            past: [...s.history.past, deps.cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })

      return [createdFeature.id]
    },

    addPendingPolygonPoint: (point) =>
      set((s) => ({
        pendingAdd:
          s.pendingAdd && 'points' in s.pendingAdd
            ? { ...s.pendingAdd, points: [...s.pendingAdd.points, point] }
            : s.pendingAdd,
      })),

    undoPendingPolygonPoint: () =>
      set((s) => {
        if (!s.pendingAdd || !('points' in s.pendingAdd)) {
          return {}
        }
        return {
          pendingAdd: {
            ...s.pendingAdd,
            points: s.pendingAdd.points.slice(0, -1),
          },
        }
      }),

    completePendingPolygon: () => {
      const state = get()
      if (!state.pendingAdd || !('points' in state.pendingAdd) || state.pendingAdd.points.length < 3) return

      const depth = Math.min(state.project.stock.thickness, 10)
      if (state.pendingAdd.shape === 'spline') {
        state.addSplineFeature(
          `Spline ${state.project.features.length + 1}`,
          state.pendingAdd.points,
          depth,
        )
      } else {
        state.addPolygonFeature(
          `Polygon ${state.project.features.length + 1}`,
          state.pendingAdd.points,
          depth,
        )
      }
      set({ pendingAdd: null })
    },

    completePendingOpenPath: () => {
      const state = get()
      if (!state.pendingAdd || !('points' in state.pendingAdd)) return

      const depth = Math.min(state.project.stock.thickness, 10)
      if (state.pendingAdd.shape === 'spline') {
        if (state.pendingAdd.points.length < 2) return
        const id = nextUniqueGeneratedId(state.project, 'f')
        const points = state.pendingAdd.points
        let segments: Segment[] = []
        for (let index = 1; index < points.length; index += 1) {
          segments = deps.appendSplineDraftSegment(points[0], segments, points[index])
        }

        const feature: SketchFeature = {
          id,
          name: `Spline ${state.project.features.length + 1}`,
          kind: 'spline',
          folderId: null,
          sketch: {
            profile: {
              start: points[0],
              segments,
              closed: false,
            },
            origin: { x: 0, y: 0 },
            orientationAngle: 90,
            dimensions: [],
            constraints: [],
          },
          operation: 'subtract',
          z_top: depth,
          z_bottom: 0,
          visible: true,
          locked: false,
        }
        state.addFeature(feature)
      } else {
        if (state.pendingAdd.points.length < 2) return
        const id = nextUniqueGeneratedId(state.project, 'f')
        const start = state.pendingAdd.points[0]
        const segments = state.pendingAdd.points.slice(1).map((point) => ({
          type: 'line' as const,
          to: point,
        }))
        const feature: SketchFeature = {
          id,
          name: `Polyline ${state.project.features.length + 1}`,
          kind: 'polygon',
          folderId: null,
          sketch: {
            profile: {
              start,
              segments,
              closed: false,
            },
            origin: { x: 0, y: 0 },
            orientationAngle: 90,
            dimensions: [],
            constraints: [],
          },
          operation: 'subtract',
          z_top: depth,
          z_bottom: 0,
          visible: true,
          locked: false,
        }
        state.addFeature(feature)
      }
      set({ pendingAdd: null })
    },

    setPendingCompositeMode: (mode: CompositeSegmentMode) =>
      set((s) => ({
        pendingAdd:
          s.pendingAdd?.shape === 'composite'
            ? {
                ...s.pendingAdd,
                currentMode: mode,
                pendingArcEnd: mode === 'arc' ? s.pendingAdd.pendingArcEnd : null,
              }
            : s.pendingAdd,
      })),

    addPendingCompositePoint: (point) =>
      set((s) => {
        if (s.pendingAdd?.shape !== 'composite' || s.pendingAdd.closed) {
          return {}
        }

        if (!s.pendingAdd.start) {
          return {
            pendingAdd: {
              ...s.pendingAdd,
              start: point,
              lastPoint: point,
              pendingArcEnd: null,
            },
          }
        }

        if (!s.pendingAdd.lastPoint) {
          return {
            pendingAdd: {
              ...s.pendingAdd,
              lastPoint: point,
            },
          }
        }

        if (s.pendingAdd.currentMode === 'arc') {
          if (!s.pendingAdd.pendingArcEnd) {
            if (pointsEqual(point, s.pendingAdd.lastPoint)) {
              return {}
            }
            return {
              pendingAdd: {
                ...s.pendingAdd,
                pendingArcEnd: point,
              },
            }
          }

          const arcSegment = deps.buildArcSegmentFromThreePoints(
            s.pendingAdd.lastPoint,
            s.pendingAdd.pendingArcEnd,
            point,
          )
          if (!arcSegment) {
            return {}
          }

          return {
            pendingAdd: {
              ...s.pendingAdd,
              segments: [...s.pendingAdd.segments, arcSegment],
              lastPoint: s.pendingAdd.pendingArcEnd,
              pendingArcEnd: null,
              closed: pointsEqual(s.pendingAdd.pendingArcEnd, s.pendingAdd.start),
            },
          }
        }

        if (pointsEqual(point, s.pendingAdd.lastPoint)) {
          return {}
        }

        return {
          pendingAdd: {
            ...s.pendingAdd,
            segments:
              s.pendingAdd.currentMode === 'spline'
                ? deps.appendSplineDraftSegment(s.pendingAdd.start, s.pendingAdd.segments, point)
                : [...s.pendingAdd.segments, { type: 'line', to: point }],
            lastPoint: point,
          },
        }
      }),

    undoPendingCompositeStep: () =>
      set((s) => {
        if (s.pendingAdd?.shape !== 'composite') {
          return {}
        }

        if (s.pendingAdd.pendingArcEnd) {
          return {
            pendingAdd: {
              ...s.pendingAdd,
              pendingArcEnd: null,
            },
          }
        }

        if (s.pendingAdd.segments.length === 0) {
          return {
            pendingAdd: {
              ...s.pendingAdd,
              start: null,
              lastPoint: null,
              closed: false,
            },
          }
        }

        const nextSegments = s.pendingAdd.segments.slice(0, -1)
        const previousPoint =
          nextSegments.length > 0
            ? nextSegments[nextSegments.length - 1].to
            : s.pendingAdd.start

        return {
          pendingAdd: {
            ...s.pendingAdd,
            segments: nextSegments,
            lastPoint: previousPoint ? clonePoint(previousPoint) : null,
            pendingArcEnd: null,
            closed: false,
          },
        }
      }),

    closePendingCompositeDraft: () =>
      set((s) => {
        if (s.pendingAdd?.shape !== 'composite' || !s.pendingAdd.start || !s.pendingAdd.lastPoint) {
          return {}
        }
        const closedSegments = deps.resolveCompositeDraftSegments(s.pendingAdd)
        if (!closedSegments) {
          return {}
        }

        return {
          pendingAdd: {
            ...s.pendingAdd,
            segments: closedSegments,
            lastPoint: clonePoint(s.pendingAdd.start),
            pendingArcEnd: null,
            closed: true,
          },
        }
      }),

    completePendingComposite: () => {
      const state = get()
      if (state.pendingAdd?.shape !== 'composite' || !state.pendingAdd.start) {
        return
      }

      const closedSegments = deps.resolveCompositeDraftSegments(state.pendingAdd)
      if (!closedSegments) {
        return
      }

      const depth = Math.min(state.project.stock.thickness, 10)
      const id = nextUniqueGeneratedId(state.project, 'f')
      const feature: SketchFeature = {
        id,
        name: `Composite ${state.project.features.length + 1}`,
        kind: 'composite',
        folderId: null,
        sketch: {
          profile: {
            start: clonePoint(state.pendingAdd.start),
            segments: closedSegments.map(deps.cloneSegment),
            closed: true,
          },
          origin: { x: 0, y: 0 },
          orientationAngle: 90,
          dimensions: [],
          constraints: [],
        },
        operation: 'subtract',
        z_top: depth,
        z_bottom: 0,
        visible: true,
        locked: false,
      }

      state.addFeature(feature)
      set({ pendingAdd: null })
    },

    completePendingOpenComposite: () => {
      const state = get()
      if (state.pendingAdd?.shape !== 'composite' || !state.pendingAdd.start) {
        return
      }

      const openSegments = deps.resolveOpenCompositeDraftSegments(state.pendingAdd)
      if (!openSegments) {
        return
      }

      const depth = Math.min(state.project.stock.thickness, 10)
      const id = nextUniqueGeneratedId(state.project, 'f')
      const feature: SketchFeature = {
        id,
        name: `Composite ${state.project.features.length + 1}`,
        kind: 'composite',
        folderId: null,
        sketch: {
          profile: {
            start: clonePoint(state.pendingAdd.start),
            segments: openSegments.map(deps.cloneSegment),
            closed: false,
          },
          origin: { x: 0, y: 0 },
          orientationAngle: 90,
          dimensions: [],
          constraints: [],
        },
        operation: 'subtract',
        z_top: depth,
        z_bottom: 0,
        visible: true,
        locked: false,
      }

      state.addFeature(feature)
      set({ pendingAdd: null })
    },
  }
}
