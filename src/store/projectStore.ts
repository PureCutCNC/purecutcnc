import { create } from 'zustand'
import {
  type Segment,
  defaultStock,
  defaultGrid,
  defaultTool,
  getStockBounds,
  newProject,
  rectProfile,
  circleProfile,
  polygonProfile,
  splineProfile,
} from '../types/project'
import type {
  GridSettings,
  Operation,
  OperationKind,
  OperationPass,
  OperationTarget,
  Point,
  Project,
  SketchFeature,
  Stock,
  Tool,
} from '../types/project'
import { convertProjectUnits } from '../utils/units'
import { convertLength } from '../utils/units'

// ============================================================
// Selection state
// ============================================================

export type SelectionMode = 'feature' | 'sketch_edit'

export interface SelectionState {
  mode: SelectionMode
  selectedFeatureId: string | null
  selectedFeatureIds: string[]
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
  | { type: 'project' }
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
  pendingMove: PendingMoveTool | null
  history: ProjectHistory

  // Project ops
  createNewProject: () => void
  setProjectName: (name: string) => void
  loadProject: (p: Project) => void
  saveProject: () => string   // returns JSON string
  undo: () => void
  redo: () => void
  beginHistoryTransaction: () => void
  commitHistoryTransaction: () => void
  cancelHistoryTransaction: () => void

  // Stock
  setStock: (stock: Stock) => void
  setGrid: (grid: GridSettings) => void
  setUnits: (units: Project['meta']['units']) => void

  // Features
  addFeature: (feature: SketchFeature) => void
  updateFeature: (id: string, patch: Partial<SketchFeature>) => void
  deleteFeature: (id: string) => void
  deleteFeatures: (ids: string[]) => void
  reorderFeatures: (ids: string[]) => void

  // Tools
  addTool: () => string
  updateTool: (id: string, patch: Partial<Tool>) => void
  deleteTool: (id: string) => void
  duplicateTool: (id: string) => string | null

  // Operations
  addOperation: (kind: OperationKind, pass: OperationPass, target: OperationTarget) => string | null
  updateOperation: (id: string, patch: Partial<Operation>) => void
  deleteOperation: (id: string) => void
  duplicateOperation: (id: string) => string | null
  reorderOperations: (ids: string[]) => void

  // Selection
  selectFeature: (id: string | null, additive?: boolean) => void
  selectFeatures: (ids: string[]) => void
  selectProject: () => void
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
  startMoveFeature: (featureId: string) => void
  startCopyFeature: (featureId: string) => void
  cancelPendingMove: () => void
  setPendingMoveFrom: (point: Point) => void
  setPendingMoveTo: (point: Point) => void
  completePendingMove: (toPoint: Point, copyCount?: number) => void

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

export interface PendingMoveTool {
  mode: 'move' | 'copy'
  featureIds: string[]
  fromPoint: Point | null
  toPoint: Point | null
  session: number
}

export interface ProjectHistory {
  past: Project[]
  future: Project[]
  transactionStart: Project | null
}

// ============================================================
// ID generator
// ============================================================

let _idCounter = 1
export function genId(prefix = 'f'): string {
  return `${prefix}${String(_idCounter++).padStart(4, '0')}`
}

function idNumericSuffix(id: string): number {
  const match = id.match(/(\d+)$/)
  return match ? Number.parseInt(match[1], 10) : 0
}

function syncIdCounter(project: Project): void {
  const usedIds = [
    ...project.features.map((feature) => feature.id),
    ...project.tools.map((tool) => tool.id),
    ...project.operations.map((operation) => operation.id),
  ]
  const maxSuffix = usedIds.reduce((max, id) => Math.max(max, idNumericSuffix(id)), 0)
  _idCounter = Math.max(_idCounter, maxSuffix + 1)
}

function nextUniqueGeneratedId(project: Project, prefix: string): string {
  const usedIds = new Set([
    ...project.features.map((feature) => feature.id),
    ...project.tools.map((tool) => tool.id),
    ...project.operations.map((operation) => operation.id),
  ])

  let nextId = genId(prefix)
  while (usedIds.has(nextId)) {
    nextId = genId(prefix)
  }
  return nextId
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

function translateProfile(profile: SketchFeature['sketch']['profile'], dx: number, dy: number): SketchFeature['sketch']['profile'] {
  return {
    ...profile,
    start: translatePoint(profile.start, dx, dy),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc') {
        return {
          ...segment,
          to: translatePoint(segment.to, dx, dy),
          center: translatePoint(segment.center, dx, dy),
        }
      }

      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: translatePoint(segment.to, dx, dy),
          control1: translatePoint(segment.control1, dx, dy),
          control2: translatePoint(segment.control2, dx, dy),
        }
      }

      return {
        ...segment,
        to: translatePoint(segment.to, dx, dy),
      }
    }),
  }
}

function duplicateFeatureName(name: string, features: SketchFeature[]): string {
  const baseName = `${name} Copy`
  if (!features.some((feature) => feature.name === baseName)) {
    return baseName
  }

  let index = 2
  while (features.some((feature) => feature.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

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

function operationKindLabel(kind: OperationKind): string {
  switch (kind) {
    case 'pocket':
      return 'Pocket'
    case 'edge_route_inside':
      return 'Edge Route Inside'
    case 'edge_route_outside':
      return 'Edge Route Outside'
    case 'surface_clean':
      return 'Surface Clean'
  }
}

function duplicateOperationName(name: string, operations: Operation[]): string {
  const baseName = `${name} Copy`
  if (!operations.some((operation) => operation.name === baseName)) {
    return baseName
  }

  let index = 2
  while (operations.some((operation) => operation.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

function isOperationTargetValid(project: Project, kind: OperationKind, target: OperationTarget): boolean {
  if (kind === 'surface_clean') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    return features.every((feature) => feature.operation === 'add')
  }

  if (target.source !== 'features' || target.featureIds.length === 0) {
    return false
  }

  const features = target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is SketchFeature => feature !== null)

  if (features.length !== target.featureIds.length) {
    return false
  }

  if (kind === 'pocket' || kind === 'edge_route_inside') {
    return features.every((feature) => feature.operation === 'subtract')
  }

  return features.every((feature) => feature.operation === 'add')
}

function defaultOperationName(kind: OperationKind, pass: OperationPass, operations: Operation[]): string {
  const baseName = `${operationKindLabel(kind)} ${pass === 'rough' ? 'Rough' : 'Finish'}`
  if (!operations.some((operation) => operation.name === baseName)) {
    return baseName
  }

  let index = 2
  while (operations.some((operation) => operation.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

function defaultOperationForTarget(
  project: Project,
  kind: OperationKind,
  pass: OperationPass,
  target: OperationTarget,
  index: number,
): Operation {
  const tool = project.tools[0] ?? defaultTool(project.meta.units, 1)
  const toolRef = project.tools[0]?.id ?? null

  return {
    id: `op${index + 1}`,
    name: defaultOperationName(kind, pass, project.operations),
    kind,
    pass,
    enabled: true,
    target,
    toolRef,
    stepdown: tool.defaultStepdown,
    stepover: tool.defaultStepover,
    feed: tool.defaultFeed,
    plungeFeed: tool.defaultPlungeFeed,
    rpm: tool.defaultRpm,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
  }
}

function fallbackOperationTarget(project: Project, kind: OperationKind): OperationTarget {
  if (kind === 'surface_clean' || kind === 'edge_route_outside') {
    const firstAddFeature = project.features.find((feature) => feature.operation === 'add')
    if (firstAddFeature) {
      return { source: 'features', featureIds: [firstAddFeature.id] }
    }
  }

  if (kind === 'pocket' || kind === 'edge_route_inside') {
    const firstSubtractFeature = project.features.find((feature) => feature.operation === 'subtract')
    if (firstSubtractFeature) {
      return { source: 'features', featureIds: [firstSubtractFeature.id] }
    }
  }

  const firstFeature = project.features[0]
  return firstFeature
    ? { source: 'features', featureIds: [firstFeature.id] }
    : { source: 'stock' }
}

function buildCopiedFeatures(
  sourceFeatures: SketchFeature[],
  existingFeatures: SketchFeature[],
  dx: number,
  dy: number,
  count: number,
): SketchFeature[] {
  const created: SketchFeature[] = []
  const projectLike: Project = {
    ...newProject(),
    features: existingFeatures,
    tools: [],
    operations: [],
  }

  for (let step = 1; step <= count; step += 1) {
    for (const sourceFeature of sourceFeatures) {
      const nextId = nextUniqueGeneratedId(
        {
          ...projectLike,
          features: [...existingFeatures, ...created],
        },
        'f',
      )
      created.push({
        ...sourceFeature,
        id: nextId,
        name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created]),
        sketch: {
          ...sourceFeature.sketch,
          profile: translateProfile(sourceFeature.sketch.profile, dx * step, dy * step),
        },
        locked: false,
      })
    }
  }

  return created
}

function normalizeFeatureZRange(feature: SketchFeature): SketchFeature {
  const { z_top, z_bottom } = feature
  if (typeof z_top === 'number' && typeof z_bottom === 'number' && z_top < z_bottom) {
    return {
      ...feature,
      z_top: z_bottom,
      z_bottom: z_top,
    }
  }

  return feature
}

function normalizeTool(tool: Tool, units: Project['meta']['units'], index: number): Tool {
  const defaults = defaultTool(units, index + 1)
  return {
    ...defaults,
    ...tool,
  }
}

function dedupeProjectIds(project: Project): Project {
  let localCounter = [
    ...project.features.map((feature) => idNumericSuffix(feature.id)),
    ...project.tools.map((tool) => idNumericSuffix(tool.id)),
    ...project.operations.map((operation) => idNumericSuffix(operation.id)),
  ].reduce((max, value) => Math.max(max, value), 0) + 1

  const nextLocalId = (prefix: string) => `${prefix}${String(localCounter++).padStart(4, '0')}`

  const seenFeatureIds = new Set<string>()
  const features = project.features.map((feature) => {
    if (!seenFeatureIds.has(feature.id)) {
      seenFeatureIds.add(feature.id)
      return feature
    }

    const nextId = nextLocalId('f')
    return {
      ...feature,
      id: nextId,
    }
  })

  const seenToolIds = new Set<string>()
  const tools = project.tools.map((tool) => {
    if (!seenToolIds.has(tool.id)) {
      seenToolIds.add(tool.id)
      return tool
    }

    const nextId = nextLocalId('t')
    return {
      ...tool,
      id: nextId,
    }
  })

  const seenOperationIds = new Set<string>()
  const operations = project.operations.map((operation) => {
    if (!seenOperationIds.has(operation.id)) {
      seenOperationIds.add(operation.id)
      return {
        ...operation,
      }
    }

    const nextId = nextLocalId('op')
    return {
      ...operation,
      id: nextId,
    }
  })

  return {
    ...project,
    features,
    tools,
    operations,
  }
}

function normalizeOperation(operation: Operation, project: Project, index: number): Operation {
  const fallbackTarget = fallbackOperationTarget(project, operation.kind)
  const defaults = defaultOperationForTarget(project, operation.kind, 'rough', fallbackTarget, index)
  const normalized = {
    ...defaults,
    ...operation,
  }

  if (!isOperationTargetValid(project, normalized.kind, normalized.target)) {
    return {
      ...normalized,
      target: fallbackTarget,
    }
  }

  return normalized
}

function normalizeProject(project: Project): Project {
  const normalizedBase = dedupeProjectIds({
    ...project,
    features: project.features.map(normalizeFeatureZRange),
    tools: project.tools.map((tool, index) => normalizeTool(tool, project.meta.units, index)),
  })

  const normalizedProject = {
    ...normalizedBase,
    operations: project.operations.map((operation, index) => normalizeOperation(operation, normalizedBase, index)),
  }

  syncIdCounter(normalizedProject)
  return normalizedProject
}

function cloneProject(project: Project): Project {
  return structuredClone(project)
}

function projectsEqual(a: Project, b: Project): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function emptySelection(): SelectionState {
  return {
    mode: 'feature',
    selectedFeatureId: null,
    selectedFeatureIds: [],
    selectedNode: null,
    hoveredFeatureId: null,
    activeControl: null,
  }
}

function sanitizeSelection(project: Project, selection: SelectionState): SelectionState {
  const selectedNode = selection.selectedNode
  const selectedFeatureIds = selection.selectedFeatureIds.filter((featureId) =>
    project.features.some((feature) => feature.id === featureId)
  )
  const selectedFeatureId =
    selection.selectedFeatureId && selectedFeatureIds.includes(selection.selectedFeatureId)
      ? selection.selectedFeatureId
      : selectedFeatureIds.at(-1) ?? null

  if (selectedNode?.type === 'feature') {
    if (selectedFeatureIds.length === 0 || !selectedFeatureId) {
      return {
        ...selection,
        mode: 'feature',
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: null,
        hoveredFeatureId: null,
        activeControl: null,
      }
    }
  }

  const hoveredFeatureId =
    selection.hoveredFeatureId && project.features.some((feature) => feature.id === selection.hoveredFeatureId)
      ? selection.hoveredFeatureId
      : null

  return {
    ...selection,
    mode:
      selectedFeatureIds.length === 1 && selection.selectedNode?.type === 'feature'
        ? selection.mode
        : 'feature',
    selectedFeatureId,
    selectedFeatureIds,
    selectedNode:
      selectedFeatureId
        ? { type: 'feature', featureId: selectedFeatureId }
        : selection.selectedNode?.type === 'feature'
          ? null
          : selection.selectedNode,
    hoveredFeatureId,
    activeControl: null,
  }
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
  project: normalizeProject(newProject()),
  pendingAdd: null,
  pendingMove: null,
  history: {
    past: [],
    future: [],
    transactionStart: null,
  },

  selection: emptySelection(),

  // ── Project ──────────────────────────────────────────────

  createNewProject: () =>
    set((state) => {
      const nextProject = normalizeProject(newProject())
      return {
        project: nextProject,
        pendingAdd: null,
        pendingMove: null,
        selection: emptySelection(),
        history: {
          past: [...state.history.past, cloneProject(state.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setProjectName: (name) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: { ...s.project.meta, name, modified: new Date().toISOString() },
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

  loadProject: (p) =>
    set((state) => {
      const stockDefaults = defaultStock()
      const gridDefaults = defaultGrid()
      const normalizedProject = normalizeProject(p)
      const nextProject = {
        ...normalizedProject,
        grid: {
          ...gridDefaults,
          ...normalizedProject.grid,
        },
        stock: {
          ...stockDefaults,
          ...normalizedProject.stock,
          origin: normalizedProject.stock?.origin ?? stockDefaults.origin,
          profile: normalizedProject.stock?.profile ?? stockDefaults.profile,
        },
      }
      return {
        project: nextProject,
        pendingAdd: null,
        pendingMove: null,
        selection: emptySelection(),
        history: {
          past: [...state.history.past, cloneProject(state.project)].slice(-100),
          future: [],
          transactionStart: null,
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

  undo: () =>
    set((state) => {
      const previous = state.history.past.at(-1)
      if (!previous) {
        return {}
      }
      const restored = normalizeProject(cloneProject(previous))
      return {
        project: restored,
        pendingAdd: null,
        pendingMove: null,
        selection: sanitizeSelection(restored, state.selection),
        history: {
          past: state.history.past.slice(0, -1),
          future: [cloneProject(state.project), ...state.history.future].slice(0, 100),
          transactionStart: null,
        },
      }
    }),

  redo: () =>
    set((state) => {
      const next = state.history.future[0]
      if (!next) {
        return {}
      }
      const restored = normalizeProject(cloneProject(next))
      return {
        project: restored,
        pendingAdd: null,
        pendingMove: null,
        selection: sanitizeSelection(restored, state.selection),
        history: {
          past: [...state.history.past, cloneProject(state.project)].slice(-100),
          future: state.history.future.slice(1),
          transactionStart: null,
        },
      }
    }),

  beginHistoryTransaction: () =>
    set((state) => {
      if (state.history.transactionStart) {
        return {}
      }
      return {
        history: {
          ...state.history,
          transactionStart: cloneProject(state.project),
        },
      }
    }),

  commitHistoryTransaction: () =>
    set((state) => {
      const { transactionStart } = state.history
      if (!transactionStart) {
        return {}
      }
      if (projectsEqual(transactionStart, state.project)) {
        return {
          history: {
            ...state.history,
            transactionStart: null,
          },
        }
      }
      return {
        history: {
          past: [...state.history.past, cloneProject(transactionStart)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  cancelHistoryTransaction: () =>
    set((state) => {
      const { transactionStart } = state.history
      if (!transactionStart) {
        return {}
      }
      const restored = normalizeProject(cloneProject(transactionStart))
      return {
        project: restored,
        pendingAdd: null,
        pendingMove: null,
        selection: sanitizeSelection(restored, state.selection),
        history: {
          ...state.history,
          transactionStart: null,
        },
      }
    }),

  // ── Stock ────────────────────────────────────────────────

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

  addOperation: (kind, pass, target) => {
    const state = get()
    if (!isOperationTargetValid(state.project, kind, target)) {
      return null
    }

    const nextId = nextUniqueGeneratedId(state.project, 'op')
    const template = defaultOperationForTarget(state.project, kind, pass, target, state.project.operations.length)
    const operation: Operation = {
      ...template,
      id: nextId,
    }

    set((s) => ({
      project: {
        ...s.project,
        operations: [...s.project.operations, operation],
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

  updateOperation: (id, patch) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        operations: s.project.operations.map((operation) => {
          if (operation.id !== id) {
            return operation
          }

          const nextOperation = { ...operation, ...patch }
          return isOperationTargetValid(s.project, nextOperation.kind, nextOperation.target)
            ? nextOperation
            : operation
        }),
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

  deleteOperation: (id) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        operations: s.project.operations.filter((operation) => operation.id !== id),
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

  duplicateOperation: (id) => {
    const state = get()
    const sourceOperation = state.project.operations.find((operation) => operation.id === id)
    if (!sourceOperation) {
      return null
    }

    const nextId = nextUniqueGeneratedId(state.project, 'op')
    const duplicate: Operation = {
      ...sourceOperation,
      id: nextId,
      name: duplicateOperationName(sourceOperation.name, state.project.operations),
    }

    set((s) => ({
      project: {
        ...s.project,
        operations: [...s.project.operations, duplicate],
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

  reorderOperations: (ids) =>
    set((s) => {
      const byId = new Map(s.project.operations.map((operation) => [operation.id, operation]))
      const reordered = ids
        .map((id) => byId.get(id))
        .filter((operation): operation is Operation => Boolean(operation))

      const untouched = s.project.operations.filter((operation) => !ids.includes(operation.id))
      const nextOperations = [...reordered, ...untouched]
      const nextProject = {
        ...s.project,
        operations: nextOperations,
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

  // ── Features ─────────────────────────────────────────────

  addFeature: (feature) =>
    set((s) => {
      const safeId = s.project.features.some((existing) => existing.id === feature.id)
        ? nextUniqueGeneratedId(s.project, 'f')
        : feature.id
      // First feature must always be 'add' — it is the base solid of the part model.
      const isFirst = s.project.features.length === 0
      const safeFeature: SketchFeature = isFirst
        ? normalizeFeatureZRange({ ...feature, id: safeId, operation: 'add' })
        : normalizeFeatureZRange({ ...feature, id: safeId })
      return {
        project: {
          ...s.project,
          features: [...s.project.features, safeFeature],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        },
        selection: {
          ...s.selection,
          selectedFeatureId: safeFeature.id,
          selectedFeatureIds: [safeFeature.id],
          selectedNode: { type: 'feature', featureId: safeFeature.id },
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

  updateFeature: (id, patch) =>
    set((s) => {
      const features = s.project.features
      const isFirst = features.length > 0 && features[0].id === id
      // Prevent changing the first feature's operation away from 'add'
      const safePatch: Partial<SketchFeature> =
        isFirst && patch.operation !== undefined && patch.operation !== 'add'
          ? { ...patch, operation: 'add' }
          : patch
      const nextProject = {
        ...s.project,
        features: features.map((f) =>
          f.id === id ? normalizeFeatureZRange({ ...f, ...safePatch }) : f
        ),
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

  deleteFeature: (id) =>
    get().deleteFeatures([id]),

  deleteFeatures: (ids) =>
    set((s) => {
      const idsToDelete = new Set(ids)
      const nextProject = {
        ...s.project,
        features: s.project.features.filter((feature) => !idsToDelete.has(feature.id)),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      const remainingSelectedIds = s.selection.selectedFeatureIds.filter((featureId) => !idsToDelete.has(featureId))
      const nextPrimaryId =
        s.selection.selectedFeatureId && !idsToDelete.has(s.selection.selectedFeatureId)
          ? s.selection.selectedFeatureId
          : remainingSelectedIds.at(-1) ?? null
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: nextPrimaryId,
          selectedFeatureIds: remainingSelectedIds,
          selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
          mode: nextPrimaryId && remainingSelectedIds.length === 1 ? s.selection.mode : 'feature',
          activeControl: nextPrimaryId && remainingSelectedIds.length === 1 ? s.selection.activeControl : null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

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
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  // ── Selection ────────────────────────────────────────────

  selectFeature: (id, additive = false) =>
    set((s) => ({
      selection: {
        ...s.selection,
        ...(id
          ? additive
            ? (() => {
                const nextIds = s.selection.selectedFeatureIds.includes(id)
                  ? s.selection.selectedFeatureIds.filter((featureId) => featureId !== id)
                  : [...s.selection.selectedFeatureIds, id]
                const nextPrimaryId =
                  nextIds.length === 0
                    ? null
                    : s.selection.selectedFeatureId === id && s.selection.selectedFeatureIds.includes(id)
                      ? nextIds.at(-1) ?? null
                      : id
                return {
                  selectedFeatureId: nextPrimaryId,
                  selectedFeatureIds: nextIds,
                  selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
                }
              })()
            : {
                selectedFeatureId: id,
                selectedFeatureIds: [id],
                selectedNode: { type: 'feature', featureId: id },
              }
          : {
              selectedFeatureId: null,
              selectedFeatureIds: [],
              selectedNode: null,
            }),
        mode: 'feature',
        activeControl: null,
      },
    })),

  selectFeatures: (ids) =>
    set((s) => {
      const nextIds = ids.filter((id, index) =>
        s.project.features.some((feature) => feature.id === id) && ids.indexOf(id) === index
      )
      const nextPrimaryId = nextIds.at(-1) ?? null

      return {
        selection: {
          ...s.selection,
          selectedFeatureId: nextPrimaryId,
          selectedFeatureIds: nextIds,
          selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
          mode: 'feature',
          activeControl: null,
        },
      }
    }),

  selectProject: () =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'project' },
        mode: 'feature',
        activeControl: null,
      },
    })),

  selectGrid: () =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'grid' },
        mode: 'feature',
      },
    })),

  selectStock: () =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
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
        selectedFeatureIds: [id],
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
    set((s) => {
      const nextProject = {
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

  startAddRectPlacement: () =>
    set((s) => ({
      pendingAdd: { shape: 'rect', anchor: null, session: nextPlacementSession() },
      pendingMove: null,
      selection: {
        ...s.selection,
        mode: 'feature',
        hoveredFeatureId: null,
        activeControl: null,
      },
    })),

  startAddCirclePlacement: () =>
    set((s) => ({
      pendingAdd: { shape: 'circle', anchor: null, session: nextPlacementSession() },
      pendingMove: null,
      selection: {
        ...s.selection,
        mode: 'feature',
        hoveredFeatureId: null,
        activeControl: null,
      },
    })),

  startAddPolygonPlacement: () =>
    set((s) => ({
      pendingAdd: { shape: 'polygon', points: [], session: nextPlacementSession() },
      pendingMove: null,
      selection: {
        ...s.selection,
        mode: 'feature',
        hoveredFeatureId: null,
        activeControl: null,
      },
    })),

  startAddSplinePlacement: () =>
    set((s) => ({
      pendingAdd: { shape: 'spline', points: [], session: nextPlacementSession() },
      pendingMove: null,
      selection: {
        ...s.selection,
        mode: 'feature',
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
    const minSize = convertLength(0.01, 'mm', state.project.meta.units)
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

  startMoveFeature: (featureId) =>
    set((s) => {
      const featureIds = s.selection.selectedFeatureIds.includes(featureId)
        ? s.selection.selectedFeatureIds
        : [featureId]
      const features = featureIds
        .map((id) => s.project.features.find((entry) => entry.id === id) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)
      if (features.length !== featureIds.length || features.some((feature) => feature.locked)) {
        return {}
      }

      return {
        pendingAdd: null,
        pendingMove: { mode: 'move', featureIds, fromPoint: null, toPoint: null, session: nextPlacementSession() },
        selection: {
          ...s.selection,
          selectedFeatureId: featureId,
          selectedFeatureIds: featureIds,
          selectedNode: { type: 'feature', featureId },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  startCopyFeature: (featureId) =>
    set((s) => {
      const featureIds = s.selection.selectedFeatureIds.includes(featureId)
        ? s.selection.selectedFeatureIds
        : [featureId]
      const features = featureIds
        .map((id) => s.project.features.find((entry) => entry.id === id) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)
      if (features.length !== featureIds.length) {
        return {}
      }

      return {
        pendingAdd: null,
        pendingMove: { mode: 'copy', featureIds, fromPoint: null, toPoint: null, session: nextPlacementSession() },
        selection: {
          ...s.selection,
          selectedFeatureId: featureId,
          selectedFeatureIds: featureIds,
          selectedNode: { type: 'feature', featureId },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  cancelPendingMove: () => set({ pendingMove: null }),

  setPendingMoveFrom: (point) =>
    set((s) => ({
      pendingMove: s.pendingMove ? { ...s.pendingMove, fromPoint: point } : null,
    })),

  setPendingMoveTo: (point) =>
    set((s) => ({
      pendingMove: s.pendingMove ? { ...s.pendingMove, toPoint: point } : null,
    })),

  completePendingMove: (toPoint, copyCount = 1) =>
    set((s) => {
      if (!s.pendingMove?.fromPoint) {
        return {}
      }

      const { featureIds, fromPoint, mode } = s.pendingMove
      const dx = toPoint.x - fromPoint.x
      const dy = toPoint.y - fromPoint.y

      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
        return { pendingMove: null }
      }

      const sourceFeatures = featureIds
        .map((featureId) => s.project.features.find((feature) => feature.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)
      if (sourceFeatures.length !== featureIds.length) {
        return { pendingMove: null }
      }

      const normalizedCopyCount = Math.max(1, Math.floor(copyCount))
      const createdFeatures =
        mode === 'copy'
          ? buildCopiedFeatures(sourceFeatures, s.project.features, dx, dy, normalizedCopyCount)
          : []

      const nextProject = {
        ...s.project,
        features:
          mode === 'copy'
            ? [
                ...s.project.features,
                ...createdFeatures,
              ]
            : s.project.features.map((feature) => {
                if (!featureIds.includes(feature.id) || feature.locked) {
                  return feature
                }

                return {
                  ...feature,
                  sketch: {
                    ...feature.sketch,
                    profile: translateProfile(feature.sketch.profile, dx, dy),
                  },
                }
              }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      if (projectsEqual(nextProject, s.project)) {
        return { pendingMove: null }
      }

      return {
        project: nextProject,
        pendingMove: null,
        selection:
          mode === 'copy'
            ? {
                ...s.selection,
                selectedFeatureId: createdFeatures.at(-1)?.id ?? s.selection.selectedFeatureId,
                selectedFeatureIds: createdFeatures.map((feature) => feature.id),
                selectedNode: createdFeatures.at(-1)
                  ? { type: 'feature', featureId: createdFeatures.at(-1)!.id }
                  : s.selection.selectedNode,
              }
            : s.selection,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  // ── Convenience constructors ─────────────────────────────

  addRectFeature: (name, x, y, w, h, depth) => {
    const id = nextUniqueGeneratedId(get().project, 'f')
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
      z_top: depth,
      z_bottom: 0,
      visible: true,
      locked: false,
    }
    get().addFeature(feature)
  },

  addCircleFeature: (name, cx, cy, r, depth) => {
    const id = nextUniqueGeneratedId(get().project, 'f')
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
      z_top: depth,
      z_bottom: 0,
      visible: true,
      locked: false,
    }
    get().addFeature(feature)
  },

  addPolygonFeature: (name, points, depth) => {
    const id = nextUniqueGeneratedId(get().project, 'f')
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
      z_top: depth,
      z_bottom: 0,
      visible: true,
      locked: false,
    }
    get().addFeature(feature)
  },

  addSplineFeature: (name, points, depth) => {
    const id = nextUniqueGeneratedId(get().project, 'f')
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
      z_top: depth,
      z_bottom: 0,
      visible: true,
      locked: false,
    }
    get().addFeature(feature)
  },
}))

const repairedInitialProject = normalizeProject(useProjectStore.getState().project)
if (!projectsEqual(repairedInitialProject, useProjectStore.getState().project)) {
  useProjectStore.setState((state) => ({
    project: repairedInitialProject,
    selection: sanitizeSelection(repairedInitialProject, state.selection),
  }))
}
