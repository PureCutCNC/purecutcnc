import { create } from 'zustand'
import {
  type Segment,
  defaultStock,
  defaultGrid,
  getStockBounds,
  newProject,
  rectProfile,
  circleProfile,
  polygonProfile,
  splineProfile,
} from '../types/project'
import type { GridSettings, Point, Project, SketchFeature, Stock } from '../types/project'

// ============================================================
// Selection state
// ============================================================

export type SelectionMode = 'feature' | 'sketch_edit'

export interface SelectionState {
  mode: SelectionMode
  selectedFeatureId: string | null
  selectedNode: SelectedNode
  hoveredFeatureId: string | null
  // sketch edit mode — which anchor/handle is being dragged
  activeControl: SketchControlRef | null
}

export interface SketchControlRef {
  kind: 'anchor' | 'in_handle' | 'out_handle'
  index: number
}

export type SelectedNode =
  | { type: 'grid' }
  | { type: 'stock' }
  | { type: 'feature'; featureId: string }
  | null

// ============================================================
// Store shape
// ============================================================

export interface ProjectStore {
  project: Project
  selection: SelectionState
  pendingAdd: PendingAddTool | null

  // Project ops
  setProjectName: (name: string) => void
  loadProject: (p: Project) => void
  saveProject: () => string   // returns JSON string

  // Stock
  setStock: (stock: Stock) => void
  setGrid: (grid: GridSettings) => void
  setUnits: (units: Project['meta']['units']) => void

  // Features
  addFeature: (feature: SketchFeature) => void
  updateFeature: (id: string, patch: Partial<SketchFeature>) => void
  deleteFeature: (id: string) => void
  reorderFeatures: (ids: string[]) => void

  // Selection
  selectFeature: (id: string | null) => void
  selectGrid: () => void
  selectStock: () => void
  hoverFeature: (id: string | null) => void
  enterSketchEdit: (id: string) => void
  exitSketchEdit: () => void
  setActiveControl: (control: SketchControlRef | null) => void
  moveFeatureControl: (featureId: string, control: SketchControlRef, point: Point) => void

  // Feature placement flow
  startAddRectPlacement: () => void
  startAddCirclePlacement: () => void
  startAddPolygonPlacement: () => void
  startAddSplinePlacement: () => void
  cancelPendingAdd: () => void
  setPendingAddAnchor: (point: Point) => void
  placePendingAddAt: (point: Point) => void
  addPendingPolygonPoint: (point: Point) => void
  completePendingPolygon: () => void

  // Convenience: add primitive features
  addRectFeature: (name: string, x: number, y: number, w: number, h: number, depth: number) => void
  addCircleFeature: (name: string, cx: number, cy: number, r: number, depth: number) => void
  addPolygonFeature: (name: string, points: Point[], depth: number) => void
  addSplineFeature: (name: string, points: Point[], depth: number) => void
}

export type PendingAddTool =
  | { shape: 'rect'; anchor: Point | null; session: number }
  | { shape: 'circle'; anchor: Point | null; session: number }
  | { shape: 'polygon'; points: Point[]; session: number }
  | { shape: 'spline'; points: Point[]; session: number }

// ============================================================
// ID generator
// ============================================================

let _idCounter = 1
export function genId(prefix = 'f'): string {
  return `${prefix}${String(_idCounter++).padStart(4, '0')}`
}

let _placementSessionCounter = 1
function nextPlacementSession(): number {
  return _placementSessionCounter++
}

function clonePoint(point: Point): Point {
  return { ...point }
}

function cloneSegment(segment: Segment): Segment {
  if (segment.type === 'arc') {
    return {
      ...segment,
      to: clonePoint(segment.to),
      center: clonePoint(segment.center),
    }
  }

  if (segment.type === 'bezier') {
    return {
      ...segment,
      to: clonePoint(segment.to),
      control1: clonePoint(segment.control1),
      control2: clonePoint(segment.control2),
    }
  }

  return {
    ...segment,
    to: clonePoint(segment.to),
  }
}

function translatePoint(point: Point, dx: number, dy: number): Point {
  return { x: point.x + dx, y: point.y + dy }
}

// ============================================================
// Rule: first feature must always be 'add'
// The part model is built from the first 'add' solid — subsequent
// features add or subtract from it. Stock is a separate concept
// used only during CAM operation generation.
// ============================================================

export function isFirstFeatureValid(features: SketchFeature[]): boolean {
  if (features.length === 0) return true
  return features[0].operation === 'add'
}

// ============================================================
// Store implementation
// ============================================================

export const useProjectStore = create<ProjectStore>((set, get) => ({
  project: newProject(),
  pendingAdd: null,

  selection: {
    mode: 'feature',
    selectedFeatureId: null,
    selectedNode: null,
    hoveredFeatureId: null,
    activeControl: null,
  },

  // ── Project ──────────────────────────────────────────────

  setProjectName: (name) =>
    set((s) => ({
      project: {
        ...s.project,
        meta: { ...s.project.meta, name, modified: new Date().toISOString() },
      },
    })),

  loadProject: (p) =>
    set(() => {
      const stockDefaults = defaultStock()
      const gridDefaults = defaultGrid()
      return {
        project: {
          ...p,
          grid: {
            ...gridDefaults,
            ...p.grid,
          },
          stock: {
            ...stockDefaults,
            ...p.stock,
            origin: p.stock?.origin ?? stockDefaults.origin,
            profile: p.stock?.profile ?? stockDefaults.profile,
          },
        },
        pendingAdd: null,
        selection: {
          mode: 'feature',
          selectedFeatureId: null,
          selectedNode: null,
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  saveProject: () => {
    const p = get().project
    const updated = {
      ...p,
      meta: { ...p.meta, modified: new Date().toISOString() },
    }
    return JSON.stringify(updated, null, 2)
  },

  // ── Stock ────────────────────────────────────────────────

  setStock: (stock) =>
    set((s) => ({
      project: {
        ...s.project,
        stock,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      },
    })),

  setGrid: (grid) =>
    set((s) => ({
      project: {
        ...s.project,
        grid,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      },
    })),

  setUnits: (units) =>
    set((s) => ({
      project: {
        ...s.project,
        meta: { ...s.project.meta, units, modified: new Date().toISOString() },
      },
    })),

  // ── Features ─────────────────────────────────────────────

  addFeature: (feature) =>
    set((s) => {
      // First feature must always be 'add' — it is the base solid of the part model.
      const isFirst = s.project.features.length === 0
      const safeFeature: SketchFeature = isFirst
        ? { ...feature, operation: 'add' }
        : feature
      return {
        project: {
          ...s.project,
          features: [...s.project.features, safeFeature],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        },
        selection: {
          ...s.selection,
          selectedFeatureId: safeFeature.id,
          selectedNode: { type: 'feature', featureId: safeFeature.id },
          mode: 'feature',
          activeControl: null,
        },
      }
    }),

  updateFeature: (id, patch) =>
    set((s) => {
      const features = s.project.features
      const isFirst = features.length > 0 && features[0].id === id
      // Prevent changing the first feature's operation away from 'add'
      const safePatch: Partial<SketchFeature> =
        isFirst && patch.operation !== undefined && patch.operation !== 'add'
          ? { ...patch, operation: 'add' }
          : patch
      return {
        project: {
          ...s.project,
          features: features.map((f) =>
            f.id === id ? { ...f, ...safePatch } : f
          ),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        },
      }
    }),

  deleteFeature: (id) =>
    set((s) => ({
      project: {
        ...s.project,
        features: s.project.features.filter((f) => f.id !== id),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      },
      selection: {
        ...s.selection,
        selectedFeatureId:
          s.selection.selectedFeatureId === id
            ? null
            : s.selection.selectedFeatureId,
        selectedNode:
          s.selection.selectedNode?.type === 'feature' && s.selection.selectedNode.featureId === id
            ? null
            : s.selection.selectedNode,
      },
    })),

  reorderFeatures: (ids) =>
    set((s) => {
      const map = new Map(s.project.features.map((f) => [f.id, f]))
      const reordered = ids.map((id) => map.get(id)!).filter(Boolean)
      // If reorder would put a subtract feature first, silently promote it to add.
      // This is safer than blocking the reorder or showing an error mid-drag.
      if (reordered.length > 0 && reordered[0].operation !== 'add') {
        reordered[0] = { ...reordered[0], operation: 'add' }
      }
      return {
        project: {
          ...s.project,
          features: reordered,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        },
      }
    }),

  // ── Selection ────────────────────────────────────────────

  selectFeature: (id) =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: id,
        selectedNode: id ? { type: 'feature', featureId: id } : null,
        mode: 'feature',
      },
    })),

  selectGrid: () =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedNode: { type: 'grid' },
        mode: 'feature',
      },
    })),

  selectStock: () =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedNode: { type: 'stock' },
        mode: 'feature',
      },
    })),

  hoverFeature: (id) =>
    set((s) => ({
      selection: { ...s.selection, hoveredFeatureId: id },
    })),

  enterSketchEdit: (id) =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: id,
        selectedNode: { type: 'feature', featureId: id },
        mode: 'sketch_edit',
        activeControl: null,
      },
    })),

  exitSketchEdit: () =>
    set((s) => ({
      selection: { ...s.selection, mode: 'feature', activeControl: null },
    })),

  setActiveControl: (control) =>
    set((s) => ({
      selection: { ...s.selection, activeControl: control },
    })),

  moveFeatureControl: (featureId, control, point) =>
    set((s) => ({
      project: {
        ...s.project,
        features: s.project.features.map((feature) => {
          if (feature.id !== featureId || feature.locked) return feature

          const { profile } = feature.sketch
          const nextProfile = {
            ...profile,
            start: clonePoint(profile.start),
            segments: profile.segments.map(cloneSegment),
          }

          const anchorCount = nextProfile.segments.length
          if (anchorCount === 0) {
            return feature
          }

          if (control.kind === 'anchor') {
            const currentAnchor =
              control.index === 0
                ? nextProfile.start
                : nextProfile.segments[control.index - 1]?.to

            if (!currentAnchor) {
              return feature
            }

            const dx = point.x - currentAnchor.x
            const dy = point.y - currentAnchor.y

            if (control.index === 0) {
              nextProfile.start = point
              const closingSegment = nextProfile.segments[anchorCount - 1]
              if (closingSegment) {
                closingSegment.to = point
                if (closingSegment.type === 'bezier') {
                  closingSegment.control2 = translatePoint(closingSegment.control2, dx, dy)
                }
              }
            } else {
              nextProfile.segments[control.index - 1].to = point
              const incomingSegment = nextProfile.segments[control.index - 1]
              if (incomingSegment.type === 'bezier') {
                incomingSegment.control2 = translatePoint(incomingSegment.control2, dx, dy)
              }
            }

            const outgoingSegment = nextProfile.segments[control.index % anchorCount]
            if (outgoingSegment?.type === 'bezier') {
              outgoingSegment.control1 = translatePoint(outgoingSegment.control1, dx, dy)
            }
          } else if (control.kind === 'out_handle') {
            const outgoingSegment = nextProfile.segments[control.index % anchorCount]
            if (outgoingSegment?.type === 'bezier') {
              outgoingSegment.control1 = point
            }
          } else {
            const incomingSegment = nextProfile.segments[(control.index - 1 + anchorCount) % anchorCount]
            if (incomingSegment?.type === 'bezier') {
              incomingSegment.control2 = point
            }
          }

          return {
            ...feature,
            sketch: {
              ...feature.sketch,
              profile: nextProfile,
            },
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      },
    })),

  startAddRectPlacement: () =>
    set(() => ({
      pendingAdd: { shape: 'rect', anchor: null, session: nextPlacementSession() },
      selection: {
        mode: 'feature',
        selectedFeatureId: null,
        selectedNode: null,
        hoveredFeatureId: null,
        activeControl: null,
      },
    })),

  startAddCirclePlacement: () =>
    set(() => ({
      pendingAdd: { shape: 'circle', anchor: null, session: nextPlacementSession() },
      selection: {
        mode: 'feature',
        selectedFeatureId: null,
        selectedNode: null,
        hoveredFeatureId: null,
        activeControl: null,
      },
    })),

  startAddPolygonPlacement: () =>
    set(() => ({
      pendingAdd: { shape: 'polygon', points: [], session: nextPlacementSession() },
      selection: {
        mode: 'feature',
        selectedFeatureId: null,
        selectedNode: null,
        hoveredFeatureId: null,
        activeControl: null,
      },
    })),

  startAddSplinePlacement: () =>
    set(() => ({
      pendingAdd: { shape: 'spline', points: [], session: nextPlacementSession() },
      selection: {
        mode: 'feature',
        selectedFeatureId: null,
        selectedNode: null,
        hoveredFeatureId: null,
        activeControl: null,
      },
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

    const bounds = getStockBounds(state.project.stock)
    const anchor = state.pendingAdd.anchor
    const depth = Math.min(state.project.stock.thickness, 10)
    const minSize = 1
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

    if (state.pendingAdd.shape === 'rect') {
      const x1 = clamp(anchor.x, bounds.minX, bounds.maxX)
      const y1 = clamp(anchor.y, bounds.minY, bounds.maxY)
      const x2 = clamp(point.x, bounds.minX, bounds.maxX)
      const y2 = clamp(point.y, bounds.minY, bounds.maxY)
      const x = Math.min(x1, x2)
      const y = Math.min(y1, y2)
      const width = Math.max(Math.abs(x2 - x1), minSize)
      const height = Math.max(Math.abs(y2 - y1), minSize)
      state.addRectFeature(`Rect ${state.project.features.length + 1}`, x, y, width, height, depth)
    } else {
      const maxRadius = Math.min(
        Math.abs(bounds.minX - anchor.x),
        Math.abs(bounds.maxX - anchor.x),
        Math.abs(bounds.minY - anchor.y),
        Math.abs(bounds.maxY - anchor.y),
      )
      const radius = Math.max(
        minSize,
        Math.min(Math.hypot(point.x - anchor.x, point.y - anchor.y), maxRadius),
      )
      const cx = clamp(anchor.x, bounds.minX + radius, bounds.maxX - radius)
      const cy = clamp(anchor.y, bounds.minY + radius, bounds.maxY - radius)
      state.addCircleFeature(`Circle ${state.project.features.length + 1}`, cx, cy, radius, depth)
    }

    set({ pendingAdd: null })
  },

  addPendingPolygonPoint: (point) =>
    set((s) => ({
      pendingAdd:
        s.pendingAdd && ('points' in s.pendingAdd)
          ? { ...s.pendingAdd, points: [...s.pendingAdd.points, point] }
          : s.pendingAdd,
    })),

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

  // ── Convenience constructors ─────────────────────────────

  addRectFeature: (name, x, y, w, h, depth) => {
    const id = genId('f')
    const feature: SketchFeature = {
      id,
      name,
      sketch: {
        profile: rectProfile(x, y, w, h),
        origin: { x: 0, y: 0 },
        dimensions: [],
        constraints: [],
      },
      operation: 'subtract',
      z_top: 0,
      z_bottom: depth,
      visible: true,
      locked: false,
    }
    get().addFeature(feature)
  },

  addCircleFeature: (name, cx, cy, r, depth) => {
    const id = genId('f')
    const feature: SketchFeature = {
      id,
      name,
      sketch: {
        profile: circleProfile(cx, cy, r),
        origin: { x: 0, y: 0 },
        dimensions: [],
        constraints: [],
      },
      operation: 'subtract',
      z_top: 0,
      z_bottom: depth,
      visible: true,
      locked: false,
    }
    get().addFeature(feature)
  },

  addPolygonFeature: (name, points, depth) => {
    const id = genId('f')
    const feature: SketchFeature = {
      id,
      name,
      sketch: {
        profile: polygonProfile(points),
        origin: { x: 0, y: 0 },
        dimensions: [],
        constraints: [],
      },
      operation: 'subtract',
      z_top: 0,
      z_bottom: depth,
      visible: true,
      locked: false,
    }
    get().addFeature(feature)
  },

  addSplineFeature: (name, points, depth) => {
    const id = genId('f')
    const feature: SketchFeature = {
      id,
      name,
      sketch: {
        profile: splineProfile(points),
        origin: { x: 0, y: 0 },
        dimensions: [],
        constraints: [],
      },
      operation: 'subtract',
      z_top: 0,
      z_bottom: depth,
      visible: true,
      locked: false,
    }
    get().addFeature(feature)
  },
}))
