import { create } from 'zustand'
import type { MachineDefinition } from '../engine/gcode/types'
import {
  type Segment,
  defaultStock,
  defaultOrigin,
  defaultGrid,
  defaultTool,
  defaultMaxTravelZ,
  defaultOperationClearanceZ,
  defaultClampClearanceXY,
  defaultClampClearanceZ,
  getStockBounds,
  inferFeatureKind,
  getProfileBounds,
  newProject,
  profileVertices,
  rectProfile,
  circleProfile,
  polygonProfile,
  splineProfile,
} from '../types/project'
import type {
  Clamp,
  FeatureFolder,
  FeatureTreeEntry,
  GridSettings,
  Operation,
  OperationKind,
  OperationPass,
  OperationTarget,
  Point,
  Project,
  SketchFeature,
  Stock,
  Tab,
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
  kind: 'anchor' | 'in_handle' | 'out_handle' | 'arc_handle'
  index: number
}

export type SelectedNode =
  | { type: 'project' }
  | { type: 'grid' }
  | { type: 'stock' }
  | { type: 'origin' }
  | { type: 'features_root' }
  | { type: 'tabs_root' }
  | { type: 'clamps_root' }
  | { type: 'folder'; folderId: string }
  | { type: 'feature'; featureId: string }
  | { type: 'tab'; tabId: string }
  | { type: 'clamp'; clampId: string }
  | null

// ============================================================
// Store shape
// ============================================================

export interface ProjectStore {
  project: Project
  selection: SelectionState
  pendingAdd: PendingAddTool | null
  pendingMove: PendingMoveTool | null
  pendingTransform: PendingTransformTool | null
  sketchEditSession: SketchEditSession | null
  history: ProjectHistory

  // Project ops
  createNewProject: (template?: Project, name?: string) => void
  setProjectName: (name: string) => void
  setProjectClearances: (patch: Partial<Pick<Project['meta'], 'maxTravelZ' | 'operationClearanceZ' | 'clampClearanceXY' | 'clampClearanceZ'>>) => void
  setOrigin: (origin: Project['origin']) => void
  startPlaceOrigin: () => void
  placeOriginAt: (point: Point) => void
  setMachineId: (id: string | null) => void
  setCustomMachineDefinition: (definition: MachineDefinition | null) => void
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
  addFeatureFolder: () => string
  updateFeatureFolder: (id: string, patch: Partial<FeatureFolder>) => void
  deleteFeatureFolder: (id: string) => void
  assignFeaturesToFolder: (featureIds: string[], folderId: string | null) => void
  moveFeatureTreeFeature: (featureId: string, folderId: string | null, beforeFeatureId?: string | null) => void
  reorderFeatureTreeEntries: (entries: FeatureTreeEntry[]) => void
  setAllFeaturesVisible: (visible: boolean) => void
  addFeature: (feature: SketchFeature) => void
  updateFeature: (id: string, patch: Partial<SketchFeature>) => void
  deleteFeature: (id: string) => void
  deleteFeatures: (ids: string[]) => void
  reorderFeatures: (ids: string[]) => void

  // Clamps
  addClamp: () => string
  updateClamp: (id: string, patch: Partial<Clamp>) => void
  deleteClamp: (id: string) => void
  setAllClampsVisible: (visible: boolean) => void
  startAddClampPlacement: () => void
  startMoveClamp: (clampId: string) => void
  startCopyClamp: (clampId: string) => void
  duplicateClamp: (id: string) => string | null

  // Tabs
  enterTabEdit: (id: string) => void
  moveTabControl: (tabId: string, control: SketchControlRef, point: Point) => void
  updateTab: (id: string, patch: Partial<Tab>) => void
  deleteTab: (id: string) => void
  setAllTabsVisible: (visible: boolean) => void
  startAddTabPlacement: () => void
  startMoveTab: (tabId: string) => void
  startCopyTab: (tabId: string) => void
  autoPlaceTabsForOperation: (operationId: string) => void

  // Tools
  addTool: () => string
  importTools: (tools: Array<Omit<Tool, 'id'>>) => string[]
  updateTool: (id: string, patch: Partial<Tool>) => void
  deleteTool: (id: string) => void
  duplicateTool: (id: string) => string | null

  // Operations
  addOperation: (kind: OperationKind, pass: OperationPass, target: OperationTarget) => string | null
  updateOperation: (id: string, patch: Partial<Operation>) => void
  setAllOperationToolpathVisibility: (visible: boolean) => void
  deleteOperation: (id: string) => void
  duplicateOperation: (id: string) => string | null
  reorderOperations: (ids: string[]) => void

  // Selection
  selectFeature: (id: string | null, additive?: boolean) => void
  selectFeatures: (ids: string[]) => void
  selectProject: () => void
  selectGrid: () => void
  selectStock: () => void
  selectOrigin: () => void
  selectFeaturesRoot: () => void
  selectTabsRoot: () => void
  selectClampsRoot: () => void
  selectFeatureFolder: (id: string) => void
  selectTab: (id: string) => void
  selectClamp: (id: string) => void
  hoverFeature: (id: string | null) => void
  enterSketchEdit: (id: string) => void
  enterClampEdit: (id: string) => void
  applySketchEdit: () => void
  cancelSketchEdit: () => void
  setActiveControl: (control: SketchControlRef | null) => void
  moveFeatureControl: (featureId: string, control: SketchControlRef, point: Point) => void
  moveClampControl: (clampId: string, control: SketchControlRef, point: Point) => void

  // Feature placement flow
  startAddRectPlacement: () => void
  startAddCirclePlacement: () => void
  startAddPolygonPlacement: () => void
  startAddSplinePlacement: () => void
  startAddCompositePlacement: () => void
  cancelPendingAdd: () => void
  setPendingAddAnchor: (point: Point) => void
  placePendingAddAt: (point: Point) => void
  addPendingPolygonPoint: (point: Point) => void
  completePendingPolygon: () => void
  completePendingOpenPath: () => void
  setPendingCompositeMode: (mode: CompositeSegmentMode) => void
  addPendingCompositePoint: (point: Point) => void
  undoPendingCompositeStep: () => void
  closePendingCompositeDraft: () => void
  completePendingComposite: () => void
  completePendingOpenComposite: () => void
  startMoveFeature: (featureId: string) => void
  startCopyFeature: (featureId: string) => void
  startResizeFeature: (featureId: string) => void
  startRotateFeature: (featureId: string) => void
  cancelPendingMove: () => void
  setPendingMoveFrom: (point: Point) => void
  setPendingMoveTo: (point: Point) => void
  completePendingMove: (toPoint: Point, copyCount?: number) => void
  cancelPendingTransform: () => void
  setPendingTransformReferenceStart: (point: Point) => void
  setPendingTransformReferenceEnd: (point: Point) => void
  completePendingTransform: (previewPoint: Point) => void

  // Convenience: add primitive features
  addRectFeature: (name: string, x: number, y: number, w: number, h: number, depth: number) => void
  addCircleFeature: (name: string, cx: number, cy: number, r: number, depth: number) => void
  addPolygonFeature: (name: string, points: Point[], depth: number) => void
  addSplineFeature: (name: string, points: Point[], depth: number) => void
}

export type PendingAddTool =
  | { shape: 'origin'; session: number }
  | { shape: 'rect'; anchor: Point | null; session: number }
  | { shape: 'circle'; anchor: Point | null; session: number }
  | { shape: 'tab'; anchor: Point | null; session: number }
  | { shape: 'clamp'; anchor: Point | null; session: number }
  | { shape: 'polygon'; points: Point[]; session: number }
  | { shape: 'spline'; points: Point[]; session: number }
  | {
      shape: 'composite'
      start: Point | null
      lastPoint: Point | null
      segments: Segment[]
      currentMode: CompositeSegmentMode
      pendingArcEnd: Point | null
      closed: boolean
      session: number
    }

export type CompositeSegmentMode = 'line' | 'arc' | 'spline'

export interface PendingMoveTool {
  mode: 'move' | 'copy'
  entityType: 'feature' | 'clamp' | 'tab'
  entityIds: string[]
  fromPoint: Point | null
  toPoint: Point | null
  session: number
}

export interface PendingTransformTool {
  mode: 'resize' | 'rotate'
  entityIds: string[]
  referenceStart: Point | null
  referenceEnd: Point | null
  session: number
}

export interface ProjectHistory {
  past: Project[]
  future: Project[]
  transactionStart: Project | null
}

export interface SketchEditSession {
  entityType: 'feature' | 'clamp' | 'tab'
  entityId: string
  snapshot: Project
  pastLength: number
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
    ...project.featureFolders.map((folder) => folder.id),
    ...project.tools.map((tool) => tool.id),
    ...project.operations.map((operation) => operation.id),
    ...project.tabs.map((tab) => tab.id),
    ...project.clamps.map((clamp) => clamp.id),
  ]
  const maxSuffix = usedIds.reduce((max, id) => Math.max(max, idNumericSuffix(id)), 0)
  _idCounter = Math.max(_idCounter, maxSuffix + 1)
}

function nextUniqueGeneratedId(project: Project, prefix: string): string {
  const usedIds = new Set([
    ...project.features.map((feature) => feature.id),
    ...project.featureFolders.map((folder) => folder.id),
    ...project.tools.map((tool) => tool.id),
    ...project.operations.map((operation) => operation.id),
    ...project.tabs.map((tab) => tab.id),
    ...project.clamps.map((clamp) => clamp.id),
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

function pointsEqual(a: Point, b: Point, epsilon = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon
}

function addPoint(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y }
}

function subtractPoint(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

function scalePoint(point: Point, scale: number): Point {
  return { x: point.x * scale, y: point.y * scale }
}

function dotPoint(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y
}

function crossPoint(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x
}

function pointLength(point: Point): number {
  return Math.hypot(point.x, point.y)
}

function normalizePoint(point: Point): Point | null {
  const length = pointLength(point)
  if (length <= 1e-9) {
    return null
  }
  return scalePoint(point, 1 / length)
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

function appendSplineDraftSegment(
  start: Point,
  segments: Segment[],
  to: Point,
): Segment[] {
  const anchors = [start, ...segments.map((segment) => segment.to)]
  const current = anchors[anchors.length - 1]
  const previous = anchors.length >= 2 ? anchors[anchors.length - 2] : current

  const tangent = scalePoint(subtractPoint(to, previous), 1 / 6)
  const nextSegment: Segment = {
    type: 'bezier',
    control1: addPoint(current, tangent),
    control2: subtractPoint(to, scalePoint(subtractPoint(to, current), 1 / 6)),
    to,
  }

  if (segments.length === 0 || segments[segments.length - 1].type !== 'bezier') {
    return [...segments, nextSegment]
  }

  const updatedSegments = [...segments]
  const previousSegment = updatedSegments[updatedSegments.length - 1]
  if (previousSegment.type === 'bezier') {
    updatedSegments[updatedSegments.length - 1] = {
      ...previousSegment,
      control2: subtractPoint(current, tangent),
    }
  }

  updatedSegments.push(nextSegment)
  return updatedSegments
}

function resolveCompositeDraftSegments(draft: Extract<PendingAddTool, { shape: 'composite' }>): Segment[] | null {
  if (!draft.start || !draft.lastPoint || draft.pendingArcEnd) {
    return null
  }

  if (draft.segments.length < 2) {
    return null
  }

  if (pointsEqual(draft.lastPoint, draft.start)) {
    return draft.segments
  }

  if (draft.currentMode === 'spline') {
    return appendSplineDraftSegment(draft.start, draft.segments, draft.start)
  }

  return [...draft.segments, { type: 'line', to: clonePoint(draft.start) }]
}

function resolveOpenCompositeDraftSegments(draft: Extract<PendingAddTool, { shape: 'composite' }>): Segment[] | null {
  if (!draft.start || !draft.lastPoint || draft.pendingArcEnd) {
    return null
  }

  if (draft.segments.length < 1) {
    return null
  }

  return draft.segments
}

function buildArcSegmentFromThreePoints(start: Point, end: Point, through: Point): Segment | null {
  const ax = start.x
  const ay = start.y
  const bx = through.x
  const by = through.y
  const cx = end.x
  const cy = end.y

  const denominator = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(denominator) < 1e-9) {
    return null
  }

  const aSq = ax * ax + ay * ay
  const bSq = bx * bx + by * by
  const cSq = cx * cx + cy * cy
  const center = {
    x: (aSq * (by - cy) + bSq * (cy - ay) + cSq * (ay - by)) / denominator,
    y: (aSq * (cx - bx) + bSq * (ax - cx) + cSq * (bx - ax)) / denominator,
  }

  const cross = (through.x - start.x) * (end.y - start.y) - (through.y - start.y) * (end.x - start.x)
  return {
    type: 'arc',
    to: end,
    center,
    clockwise: cross < 0,
  }
}

function arcControlPoint(start: Point, segment: Extract<Segment, { type: 'arc' }>): Point {
  const startAngle = Math.atan2(start.y - segment.center.y, start.x - segment.center.x)
  const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
  const radius = Math.hypot(start.x - segment.center.x, start.y - segment.center.y)

  let sweep = endAngle - startAngle
  if (segment.clockwise && sweep > 0) {
    sweep -= Math.PI * 2
  } else if (!segment.clockwise && sweep < 0) {
    sweep += Math.PI * 2
  }

  const midAngle = startAngle + sweep / 2
  return {
    x: segment.center.x + Math.cos(midAngle) * radius,
    y: segment.center.y + Math.sin(midAngle) * radius,
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

function transformProfile(
  profile: SketchFeature['sketch']['profile'],
  transformPoint: (point: Point) => Point,
): SketchFeature['sketch']['profile'] {
  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          center: transformPoint(segment.center),
        }
      }

      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          control1: transformPoint(segment.control1),
          control2: transformPoint(segment.control2),
        }
      }

      return {
        ...segment,
        to: transformPoint(segment.to),
      }
    }),
  }
}

function arcToBezierSegments(start: Point, segment: Extract<Segment, { type: 'arc' }>): Array<Extract<Segment, { type: 'bezier' }>> {
  const startAngle = Math.atan2(start.y - segment.center.y, start.x - segment.center.x)
  const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
  const radius = Math.hypot(start.x - segment.center.x, start.y - segment.center.y)

  let sweep = endAngle - startAngle
  if (segment.clockwise && sweep > 0) {
    sweep -= Math.PI * 2
  } else if (!segment.clockwise && sweep < 0) {
    sweep += Math.PI * 2
  }

  const segmentCount = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)))
  const step = sweep / segmentCount
  const result: Array<Extract<Segment, { type: 'bezier' }>> = []

  for (let index = 0; index < segmentCount; index += 1) {
    const angle0 = startAngle + step * index
    const angle1 = angle0 + step
    const p0 = {
      x: segment.center.x + Math.cos(angle0) * radius,
      y: segment.center.y + Math.sin(angle0) * radius,
    }
    const p3 = {
      x: segment.center.x + Math.cos(angle1) * radius,
      y: segment.center.y + Math.sin(angle1) * radius,
    }
    const tangent0 = { x: -Math.sin(angle0), y: Math.cos(angle0) }
    const tangent1 = { x: -Math.sin(angle1), y: Math.cos(angle1) }
    const handleScale = (4 / 3) * Math.tan(step / 4) * radius

    result.push({
      type: 'bezier',
      control1: {
        x: p0.x + tangent0.x * handleScale,
        y: p0.y + tangent0.y * handleScale,
      },
      control2: {
        x: p3.x - tangent1.x * handleScale,
        y: p3.y - tangent1.y * handleScale,
      },
      to: p3,
    })
  }

  return result
}

function transformProfileAffine(
  profile: SketchFeature['sketch']['profile'],
  transformPoint: (point: Point) => Point,
): SketchFeature['sketch']['profile'] {
  const nextSegments: Segment[] = []
  let current = profile.start

  for (const segment of profile.segments) {
    if (segment.type === 'arc') {
      const beziers = arcToBezierSegments(current, segment)
      for (const bezier of beziers) {
        nextSegments.push({
          type: 'bezier',
          control1: transformPoint(bezier.control1),
          control2: transformPoint(bezier.control2),
          to: transformPoint(bezier.to),
        })
      }
    } else if (segment.type === 'bezier') {
      nextSegments.push({
        ...segment,
        control1: transformPoint(segment.control1),
        control2: transformPoint(segment.control2),
        to: transformPoint(segment.to),
      })
    } else {
      nextSegments.push({
        ...segment,
        to: transformPoint(segment.to),
      })
    }

    current = segment.to
  }

  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: nextSegments,
  }
}

function rotatePointAround(point: Point, origin: Point, angle: number): Point {
  const local = subtractPoint(point, origin)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return {
    x: origin.x + local.x * cos - local.y * sin,
    y: origin.y + local.x * sin + local.y * cos,
  }
}

function normalizeAngleDegrees(angle: number): number {
  const normalized = angle % 360
  return normalized < 0 ? normalized + 360 : normalized
}

function angleToPoint(angleDegrees: number): Point {
  const radians = (angleDegrees * Math.PI) / 180
  return {
    x: Math.cos(radians),
    y: Math.sin(radians),
  }
}

function inferProfileOrientationAngle(profile: SketchFeature['sketch']['profile']): number {
  const vertices = profileVertices(profile)
  let bestDirection: Point | null = null
  let bestLength = 0

  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index]
    const end = vertices[(index + 1) % vertices.length]
    if (!end || (index === vertices.length - 1 && !profile.closed)) {
      continue
    }

    const direction = subtractPoint(end, start)
    const length = pointLength(direction)
    if (length > bestLength + 1e-9) {
      bestDirection = direction
      bestLength = length
    }
  }

  const u = bestDirection ? normalizePoint(bestDirection) : null
  if (!u) {
    return 90
  }

  const xAxisAngle = Math.atan2(u.y, u.x) * (180 / Math.PI)
  return normalizeAngleDegrees(xAxisAngle + 90)
}

function featureResizeBasis(feature: SketchFeature): { u: Point; v: Point } {
  const orientationAngle = normalizeAngleDegrees(
    feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
  )
  const v = angleToPoint(orientationAngle)
  const u = angleToPoint(orientationAngle - 90)
  return { u, v }
}

function snappedResizeScales(
  referenceVector: Point,
  previewVector: Point,
  u: Point,
  v: Point,
): { scaleU: number; scaleV: number } | null {
  const refU = dotPoint(referenceVector, u)
  const refV = dotPoint(referenceVector, v)
  const previewU = dotPoint(previewVector, u)
  const previewV = dotPoint(previewVector, v)

  const scaleU = Math.abs(refU) <= 1e-9 ? 1 : previewU / refU
  const scaleV = Math.abs(refV) <= 1e-9 ? 1 : previewV / refV

  const unit = normalizePoint(referenceVector)
  if (!unit) {
    return null
  }

  const axisSnapTolerance = Math.cos((12 * Math.PI) / 180)
  const alignU = Math.abs(dotPoint(unit, u))
  const alignV = Math.abs(dotPoint(unit, v))

  if (alignU >= axisSnapTolerance && alignU >= alignV) {
    return { scaleU, scaleV: 1 }
  }

  if (alignV >= axisSnapTolerance && alignV >= alignU) {
    return { scaleU: 1, scaleV }
  }

  return { scaleU, scaleV }
}

export function resizeFeatureFromReference(
  feature: SketchFeature,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): SketchFeature | null {
  const referenceVector = subtractPoint(referenceEnd, referenceStart)
  const referenceLength = pointLength(referenceVector)
  if (referenceLength <= 1e-9) {
    return null
  }

  const unit = scalePoint(referenceVector, 1 / referenceLength)
  const projectedLength = dotPoint(subtractPoint(previewPoint, referenceStart), unit)
  const constrainedPreview = addPoint(referenceStart, scalePoint(unit, projectedLength))
  const { u, v } = featureResizeBasis(feature)
  const previewVector = subtractPoint(constrainedPreview, referenceStart)
  const snappedScales = snappedResizeScales(referenceVector, previewVector, u, v)
  if (!snappedScales) {
    return null
  }

  const { scaleU, scaleV } = snappedScales
  if (
    !Number.isFinite(scaleU)
    || !Number.isFinite(scaleV)
    || scaleU <= 1e-6
    || scaleV <= 1e-6
  ) {
    return null
  }

  const transformPoint = (point: Point): Point => {
    const local = subtractPoint(point, referenceStart)
    const localU = dotPoint(local, u)
    const localV = dotPoint(local, v)
    return {
      x: referenceStart.x + u.x * localU * scaleU + v.x * localV * scaleV,
      y: referenceStart.y + u.y * localU * scaleU + v.y * localV * scaleV,
    }
  }

  const profile = transformProfileAffine(feature.sketch.profile, transformPoint)
  return {
    ...feature,
    kind: inferFeatureKind(profile),
    sketch: {
      ...feature.sketch,
      origin: transformPoint(feature.sketch.origin),
      orientationAngle: normalizeAngleDegrees(
        feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
      ),
      profile,
    },
  }
}

export function rotateFeatureFromReference(
  feature: SketchFeature,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): SketchFeature | null {
  const startVector = subtractPoint(referenceEnd, referenceStart)
  const endVector = subtractPoint(previewPoint, referenceStart)
  const startLength = pointLength(startVector)
  const endLength = pointLength(endVector)
  if (startLength <= 1e-9 || endLength <= 1e-9) {
    return null
  }

  const angle = Math.atan2(crossPoint(startVector, endVector), dotPoint(startVector, endVector))
  if (!Number.isFinite(angle)) {
    return null
  }

  const profile = transformProfile(feature.sketch.profile, (point) => rotatePointAround(point, referenceStart, angle))
  return {
    ...feature,
    kind: inferFeatureKind(profile),
    sketch: {
      ...feature.sketch,
      origin: rotatePointAround(feature.sketch.origin, referenceStart, angle),
      orientationAngle: normalizeAngleDegrees(
        (feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile)) + angle * (180 / Math.PI),
      ),
      profile,
    },
  }
}

function translateClamp(clamp: Clamp, dx: number, dy: number): Clamp {
  return {
    ...clamp,
    x: clamp.x + dx,
    y: clamp.y + dy,
  }
}

function translateTab(tab: Tab, dx: number, dy: number): Tab {
  return {
    ...tab,
    x: tab.x + dx,
    y: tab.y + dy,
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

function duplicateClampName(name: string, clamps: Clamp[]): string {
  const baseName = `${name} Copy`
  if (!clamps.some((clamp) => clamp.name === baseName)) {
    return baseName
  }

  let index = 2
  while (clamps.some((clamp) => clamp.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

function duplicateTabName(name: string, tabs: Tab[]): string {
  const baseName = `${name} Copy`
  if (!tabs.some((tab) => tab.name === baseName)) {
    return baseName
  }

  let index = 2
  while (tabs.some((tab) => tab.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

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

  const entries: Array<Pick<Tab, 'x' | 'y' | 'w' | 'h'>> =
    Math.min(width, height) < size * 3
      ? (
          width >= height
            ? [
                { x: cx - size / 2, y: bounds.minY - size / 2, w: size, h: size },
                { x: cx - size / 2, y: bounds.maxY - size / 2, w: size, h: size },
              ]
            : [
                { x: bounds.minX - size / 2, y: cy - size / 2, w: size, h: size },
                { x: bounds.maxX - size / 2, y: cy - size / 2, w: size, h: size },
              ]
        )
      : [
          { x: cx - size / 2, y: bounds.minY - size / 2, w: size, h: size },
          { x: cx - size / 2, y: bounds.maxY - size / 2, w: size, h: size },
          { x: bounds.minX - size / 2, y: cy - size / 2, w: size, h: size },
          { x: bounds.maxX - size / 2, y: cy - size / 2, w: size, h: size },
        ]

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

function toolMatchesTemplate(existingTool: Tool, candidate: Omit<Tool, 'id'>): boolean {
  return (
    existingTool.name === candidate.name
    && existingTool.units === candidate.units
    && existingTool.type === candidate.type
    && existingTool.diameter === candidate.diameter
    && existingTool.vBitAngle === candidate.vBitAngle
    && existingTool.flutes === candidate.flutes
    && existingTool.material === candidate.material
    && existingTool.defaultRpm === candidate.defaultRpm
    && existingTool.defaultFeed === candidate.defaultFeed
    && existingTool.defaultPlungeFeed === candidate.defaultPlungeFeed
    && existingTool.defaultStepdown === candidate.defaultStepdown
    && existingTool.defaultStepover === candidate.defaultStepover
  )
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
    case 'follow_line':
      return 'Follow Line'
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
  if (kind === 'follow_line') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    return features.length === target.featureIds.length
  }

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

    return features.every((feature) => feature.operation === 'add' && feature.sketch.profile.closed)
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
    return features.every((feature) => feature.operation === 'subtract' && feature.sketch.profile.closed)
  }

  return features.every((feature) => feature.operation === 'add' && feature.sketch.profile.closed)
}

function defaultOperationName(kind: OperationKind, pass: OperationPass, operations: Operation[]): string {
  const baseName = kind === 'follow_line'
    ? operationKindLabel(kind)
    : `${operationKindLabel(kind)} ${pass === 'rough' ? 'Rough' : 'Finish'}`
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
    showToolpath: true,
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
    carveDepth: convertLength(1, 'mm', project.meta.units),
  }
}

function fallbackOperationTarget(project: Project, kind: OperationKind): OperationTarget {
  if (kind === 'follow_line') {
    const firstFeature = project.features[0]
    return firstFeature
      ? { source: 'features', featureIds: [firstFeature.id] }
      : { source: 'stock' }
  }

  if (kind === 'surface_clean' || kind === 'edge_route_outside') {
    const firstAddFeature = project.features.find((feature) => feature.operation === 'add' && feature.sketch.profile.closed)
    if (firstAddFeature) {
      return { source: 'features', featureIds: [firstAddFeature.id] }
    }
  }

  if (kind === 'pocket' || kind === 'edge_route_inside') {
    const firstSubtractFeature = project.features.find((feature) => feature.operation === 'subtract' && feature.sketch.profile.closed)
    if (firstSubtractFeature) {
      return { source: 'features', featureIds: [firstSubtractFeature.id] }
    }
  }

  const firstFeature = project.features.find((feature) => feature.sketch.profile.closed)
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
        folderId: sourceFeature.folderId,
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

function buildCopiedClamps(
  sourceClamps: Clamp[],
  existingClamps: Clamp[],
  project: Project,
  dx: number,
  dy: number,
  count: number,
): Clamp[] {
  const created: Clamp[] = []

  for (let step = 1; step <= count; step += 1) {
    for (const sourceClamp of sourceClamps) {
      created.push({
        ...sourceClamp,
        id: nextUniqueGeneratedId(
          {
            ...project,
            clamps: [...existingClamps, ...created],
          },
          'cl',
        ),
        name: duplicateClampName(sourceClamp.name, [...existingClamps, ...created]),
        x: sourceClamp.x + dx * step,
        y: sourceClamp.y + dy * step,
      })
    }
  }

  return created
}

function buildCopiedTabs(
  sourceTabs: Tab[],
  existingTabs: Tab[],
  project: Project,
  dx: number,
  dy: number,
  count: number,
): Tab[] {
  const created: Tab[] = []

  for (let step = 1; step <= count; step += 1) {
    for (const sourceTab of sourceTabs) {
      created.push({
        ...sourceTab,
        id: nextUniqueGeneratedId(
          {
            ...project,
            tabs: [...existingTabs, ...created],
          },
          'tb',
        ),
        name: duplicateTabName(sourceTab.name, [...existingTabs, ...created]),
        x: sourceTab.x + dx * step,
        y: sourceTab.y + dy * step,
      })
    }
  }

  return created
}

function normalizeFeatureZRange(feature: SketchFeature): SketchFeature {
  const safeFeature = {
    ...feature,
    sketch: {
      ...feature.sketch,
      orientationAngle: normalizeAngleDegrees(
        feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
      ),
      profile: {
        ...feature.sketch.profile,
        closed: feature.sketch.profile.closed ?? true,
      },
    },
    kind: feature.kind ?? inferFeatureKind(feature.sketch.profile),
    folderId: feature.folderId ?? null,
  }
  const { z_top, z_bottom } = safeFeature
  if (typeof z_top === 'number' && typeof z_bottom === 'number' && z_top < z_bottom) {
    return {
      ...safeFeature,
      z_top: z_bottom,
      z_bottom: z_top,
    }
  }

  return safeFeature
}

function normalizeTool(tool: Tool, units: Project['meta']['units'], index: number): Tool {
  const defaults = defaultTool(units, index + 1)
  return {
    ...defaults,
    ...tool,
    vBitAngle: (tool.type ?? defaults.type) === 'v_bit' ? (tool.vBitAngle ?? 60) : null,
  }
}

function syncFeatureTreeProject(project: Project): Project {
  const featureFolders = project.featureFolders ?? []
  const folderIdSet = new Set(featureFolders.map((folder) => folder.id))
  const features = project.features.map((feature) => (
    feature.folderId && !folderIdSet.has(feature.folderId)
      ? { ...feature, folderId: null }
      : feature
  ))

  const featureMap = new Map(features.map((feature) => [feature.id, feature]))
  const usedRootFeatures = new Set<string>()
  const usedFolders = new Set<string>()
  const normalizedTree: FeatureTreeEntry[] = []

  for (const entry of project.featureTree ?? []) {
    if (entry.type === 'folder') {
      if (folderIdSet.has(entry.folderId) && !usedFolders.has(entry.folderId)) {
        normalizedTree.push(entry)
        usedFolders.add(entry.folderId)
      }
      continue
    }

    const feature = featureMap.get(entry.featureId)
    if (!feature || feature.folderId !== null || usedRootFeatures.has(entry.featureId)) {
      continue
    }

    normalizedTree.push(entry)
    usedRootFeatures.add(entry.featureId)
  }

  for (const folder of featureFolders) {
    if (!usedFolders.has(folder.id)) {
      normalizedTree.push({ type: 'folder', folderId: folder.id })
      usedFolders.add(folder.id)
    }
  }

  for (const feature of features) {
    if (feature.folderId === null && !usedRootFeatures.has(feature.id)) {
      normalizedTree.push({ type: 'feature', featureId: feature.id })
      usedRootFeatures.add(feature.id)
    }
  }

  const orderedFeatures: SketchFeature[] = []
  const pushedFeatureIds = new Set<string>()

  for (const entry of normalizedTree) {
    if (entry.type === 'folder') {
      for (const feature of features) {
        if (feature.folderId === entry.folderId && !pushedFeatureIds.has(feature.id)) {
          orderedFeatures.push(feature)
          pushedFeatureIds.add(feature.id)
        }
      }
      continue
    }

    const feature = featureMap.get(entry.featureId)
    if (feature && !pushedFeatureIds.has(feature.id)) {
      orderedFeatures.push(feature)
      pushedFeatureIds.add(feature.id)
    }
  }

  for (const feature of features) {
    if (!pushedFeatureIds.has(feature.id)) {
      orderedFeatures.push({ ...feature, folderId: null })
    }
  }

  return {
    ...project,
    features: orderedFeatures,
    featureFolders,
    featureTree: normalizedTree,
  }
}

function dedupeProjectIds(project: Project): Project {
  let localCounter = [
    ...project.features.map((feature) => idNumericSuffix(feature.id)),
    ...project.tools.map((tool) => idNumericSuffix(tool.id)),
    ...project.operations.map((operation) => idNumericSuffix(operation.id)),
    ...project.tabs.map((tab) => idNumericSuffix(tab.id)),
    ...project.clamps.map((clamp) => idNumericSuffix(clamp.id)),
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

  const seenClampIds = new Set<string>()
  const clamps = project.clamps.map((clamp) => {
    if (!seenClampIds.has(clamp.id)) {
      seenClampIds.add(clamp.id)
      return { ...clamp }
    }

    const nextId = nextLocalId('cl')
    return {
      ...clamp,
      id: nextId,
    }
  })

  const seenTabIds = new Set<string>()
  const tabs = project.tabs.map((tab) => {
    if (!seenTabIds.has(tab.id)) {
      seenTabIds.add(tab.id)
      return { ...tab }
    }

    const nextId = nextLocalId('tb')
    return {
      ...tab,
      id: nextId,
    }
  })

  return {
    ...project,
    features,
    tools,
    operations,
    tabs,
    clamps,
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

function normalizeClamp(clamp: Clamp, units: Project['meta']['units'], index: number): Clamp {
  const defaultSize = convertLength(12, 'mm', units)
  const defaultHeight = convertLength(8, 'mm', units)
  return {
    id: clamp.id || `cl${index + 1}`,
    name: clamp.name || `Clamp ${index + 1}`,
    type: clamp.type ?? 'step_clamp',
    x: clamp.x ?? 0,
    y: clamp.y ?? 0,
    w: Math.max(clamp.w ?? defaultSize, convertLength(0.1, 'mm', units)),
    h: Math.max(clamp.h ?? defaultSize, convertLength(0.1, 'mm', units)),
    height: Math.max(clamp.height ?? defaultHeight, convertLength(0.1, 'mm', units)),
    visible: clamp.visible ?? true,
  }
}

function normalizeTab(tab: Tab, units: Project['meta']['units'], index: number): Tab {
  const defaultSize = convertLength(6, 'mm', units)
  const defaultBottom = 0
  const defaultTop = convertLength(3, 'mm', units)
  const zBottom = tab.z_bottom ?? defaultBottom
  const zTop = tab.z_top ?? defaultTop
  return {
    id: tab.id || `tb${index + 1}`,
    name: tab.name || `Tab ${index + 1}`,
    x: tab.x ?? 0,
    y: tab.y ?? 0,
    w: Math.max(tab.w ?? defaultSize, convertLength(0.1, 'mm', units)),
    h: Math.max(tab.h ?? defaultSize, convertLength(0.1, 'mm', units)),
    z_top: Math.max(zTop, zBottom),
    z_bottom: Math.min(zTop, zBottom),
    visible: tab.visible ?? true,
  }
}

function normalizeProject(project: Project): Project {
  const meta = {
    ...project.meta,
    maxTravelZ: project.meta.maxTravelZ ?? defaultMaxTravelZ(project.meta.units),
    operationClearanceZ: project.meta.operationClearanceZ ?? defaultOperationClearanceZ(project.meta.units),
    clampClearanceXY: project.meta.clampClearanceXY ?? defaultClampClearanceXY(project.meta.units),
    clampClearanceZ: project.meta.clampClearanceZ ?? defaultClampClearanceZ(project.meta.units),
  }

  const stockBounds = getStockBounds(project.stock)
  const legacyDefaultOrigin =
    project.origin
    && project.origin.name === 'Origin'
    && project.origin.x === stockBounds.minX
    && project.origin.y === stockBounds.minY
    && project.origin.z === project.stock.thickness

  const normalizedBase = syncFeatureTreeProject(dedupeProjectIds({
    ...project,
    meta,
    stock: {
      ...project.stock,
      profile: {
        ...project.stock.profile,
        closed: project.stock.profile.closed ?? true,
      },
    },
    features: project.features.map(normalizeFeatureZRange),
    featureFolders: project.featureFolders ?? [],
    featureTree: project.featureTree ?? [],
    tools: project.tools.map((tool, index) => normalizeTool(tool, project.meta.units, index)),
    tabs: (project.tabs ?? []).map((tab, index) => normalizeTab(tab, project.meta.units, index)),
    clamps: (project.clamps ?? []).map((clamp, index) => normalizeClamp(clamp, project.meta.units, index)),
    origin: project.origin
      ? (legacyDefaultOrigin ? defaultOrigin(project.stock) : project.origin)
      : defaultOrigin(project.stock),
  }))

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

function instantiateProjectTemplate(template?: Project, name?: string): Project {
  const now = new Date().toISOString()

  if (!template) {
    return newProject(name)
  }

  const cloned = cloneProject(template)
  return {
    ...cloned,
    meta: {
      ...cloned.meta,
      name: name?.trim() || 'Untitled',
      created: now,
      modified: now,
    },
    dimensions: {},
    features: [],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  }
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

  const safeSelectedNode =
    selectedNode?.type === 'folder'
      ? project.featureFolders.some((folder) => folder.id === selectedNode.folderId)
        ? selectedNode
        : null
      : selectedNode?.type === 'tab'
        ? project.tabs.some((tab) => tab.id === selectedNode.tabId)
          ? selectedNode
          : null
      : selectedNode?.type === 'tabs_root'
        ? selectedNode
      : selectedNode?.type === 'clamp'
        ? project.clamps.some((clamp) => clamp.id === selectedNode.clampId)
          ? selectedNode
          : null
      : selectedNode?.type === 'clamps_root'
        ? selectedNode
      : selectedNode?.type === 'origin'
        ? selectedNode
      : selectedNode?.type === 'features_root'
        ? selectedNode
        : selectedNode

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
          : safeSelectedNode,
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
  pendingTransform: null,
  sketchEditSession: null,
  history: {
    past: [],
    future: [],
    transactionStart: null,
  },

  selection: emptySelection(),

  // ── Project ──────────────────────────────────────────────

  createNewProject: (template, name) =>
    set((state) => {
      const nextProject = normalizeProject(instantiateProjectTemplate(template, name))
      return {
        project: nextProject,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
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

  setProjectClearances: (patch) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          ...patch,
          modified: new Date().toISOString(),
        },
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

  setMachineId: (id) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: { ...s.project.meta, machineId: id, modified: new Date().toISOString() },
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

  setCustomMachineDefinition: (definition) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: { ...s.project.meta, customMachineDefinition: definition, modified: new Date().toISOString() },
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

  loadProject: (p) =>
    set((state) => {
      const normalizedProject = normalizeProject(p)
      const stockDefaults = defaultStock(undefined, undefined, undefined, normalizedProject.meta.units)
      const gridDefaults = defaultGrid(normalizedProject.meta.units)
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
        origin: normalizedProject.origin ?? defaultOrigin(normalizedProject.stock ?? stockDefaults),
      }
      return {
        project: nextProject,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
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
        pendingTransform: null,
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
        pendingTransform: null,
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
        pendingTransform: null,
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

  importTools: (tools) => {
    const state = get()
    const imported: Tool[] = []
    let nextProject = state.project

    for (const sourceTool of tools) {
      if (nextProject.tools.some((tool) => toolMatchesTemplate(tool, sourceTool))) {
        continue
      }

      const nextId = nextUniqueGeneratedId(nextProject, 't')
      const tool = normalizeTool(
        {
          ...sourceTool,
          id: nextId,
        },
        sourceTool.units,
        nextProject.tools.length,
      )

      imported.push(tool)
      nextProject = {
        ...nextProject,
        tools: [...nextProject.tools, tool],
      }
    }

    if (imported.length === 0) {
      return []
    }

    set((s) => ({
      project: {
        ...nextProject,
        meta: { ...nextProject.meta, modified: new Date().toISOString() },
      },
      history: {
        past: [...s.history.past, cloneProject(s.project)].slice(-100),
        future: [],
        transactionStart: null,
      },
    }))

    return imported.map((tool) => tool.id)
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
      showToolpath: true,
      pass,
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

  setAllOperationToolpathVisibility: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        operations: s.project.operations.map((operation) => ({
          ...operation,
          showToolpath: visible,
        })),
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
      showToolpath: true,
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

  addFeatureFolder: () => {
    const state = get()
    const nextId = nextUniqueGeneratedId(state.project, 'fd')
    const folder: FeatureFolder = {
      id: nextId,
      name: `Folder ${state.project.featureFolders.length + 1}`,
      collapsed: false,
    }

    set((s) => {
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        featureFolders: [...s.project.featureFolders, folder],
        featureTree: [...s.project.featureTree, { type: 'folder', folderId: nextId }],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'folder', folderId: nextId },
          mode: 'feature',
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    })

    return nextId
  },

  updateFeatureFolder: (id, patch) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        featureFolders: s.project.featureFolders.map((folder) => (
          folder.id === id ? { ...folder, ...patch } : folder
        )),
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

  deleteFeatureFolder: (id) =>
    set((s) => {
      const folderFeatures = s.project.features.filter((feature) => feature.folderId === id)
      const nextFeatureTree = s.project.featureTree.flatMap((entry) => (
        entry.type === 'folder' && entry.folderId === id
          ? folderFeatures.map((feature) => ({ type: 'feature', featureId: feature.id } as FeatureTreeEntry))
          : [entry]
      ))
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        featureFolders: s.project.featureFolders.filter((folder) => folder.id !== id),
        featureTree: nextFeatureTree,
        features: s.project.features.map((feature) => (
          feature.folderId === id ? { ...feature, folderId: null } : feature
        )),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedNode: s.selection.selectedNode?.type === 'folder' && s.selection.selectedNode.folderId === id
            ? { type: 'features_root' }
            : s.selection.selectedNode,
          selectedFeatureId: s.selection.selectedFeatureId,
          selectedFeatureIds: s.selection.selectedFeatureIds,
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

  assignFeaturesToFolder: (featureIds, folderId) =>
    set((s) => {
      const ids = featureIds.filter((id, index) => featureIds.indexOf(id) === index)
      if (ids.length === 0) {
        return {}
      }
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: s.project.features.map((feature) => (
          ids.includes(feature.id) ? { ...feature, folderId } : feature
        )),
        featureTree: [
          ...s.project.featureTree.filter((entry) => !(entry.type === 'feature' && ids.includes(entry.featureId))),
          ...(folderId === null ? ids.map((featureId) => ({ type: 'feature', featureId } as FeatureTreeEntry)) : []),
        ],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  moveFeatureTreeFeature: (featureId, folderId, beforeFeatureId = null) =>
    set((s) => {
      const sourceFeature = s.project.features.find((feature) => feature.id === featureId)
      if (!sourceFeature) {
        return {}
      }
      if (folderId !== null && !s.project.featureFolders.some((folder) => folder.id === folderId)) {
        return {}
      }

      const remainingFeatures = s.project.features.filter((feature) => feature.id !== featureId)
      const nextSourceFeature = { ...sourceFeature, folderId }
      let insertIndex = remainingFeatures.length

      if (beforeFeatureId) {
        const beforeIndex = remainingFeatures.findIndex((feature) => feature.id === beforeFeatureId)
        const beforeFeature = remainingFeatures.find((feature) => feature.id === beforeFeatureId)
        if (beforeIndex !== -1 && beforeFeature && beforeFeature.folderId === folderId) {
          insertIndex = beforeIndex
        }
      } else if (folderId !== null) {
        const folderIndexes = remainingFeatures
          .map((feature, index) => (feature.folderId === folderId ? index : -1))
          .filter((index) => index !== -1)
        if (folderIndexes.length > 0) {
          insertIndex = folderIndexes[folderIndexes.length - 1] + 1
        }
      }

      const nextFeatures = [...remainingFeatures]
      nextFeatures.splice(insertIndex, 0, nextSourceFeature)

      const rootEntries = s.project.featureTree.filter((entry) => (
        entry.type === 'folder' ||
        (entry.type === 'feature' && entry.featureId !== featureId)
      ))

      let nextFeatureTree = rootEntries
      if (folderId === null) {
        const nextEntry: FeatureTreeEntry = { type: 'feature', featureId }
        if (beforeFeatureId) {
          const targetRootIndex = rootEntries.findIndex((entry) => entry.type === 'feature' && entry.featureId === beforeFeatureId)
          if (targetRootIndex !== -1) {
            nextFeatureTree = [...rootEntries]
            nextFeatureTree.splice(targetRootIndex, 0, nextEntry)
          } else {
            nextFeatureTree = [...rootEntries, nextEntry]
          }
        } else {
          nextFeatureTree = [...rootEntries, nextEntry]
        }
      }

      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: nextFeatures,
        featureTree: nextFeatureTree,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })

      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  reorderFeatureTreeEntries: (entries) =>
    set((s) => {
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        featureTree: entries,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
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

  setAllFeaturesVisible: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => ({ ...feature, visible })),
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

  addFeature: (feature) =>
    set((s) => {
      const safeId = s.project.features.some((existing) => existing.id === feature.id)
        ? nextUniqueGeneratedId(s.project, 'f')
        : feature.id
      // First feature must always be 'add' — it is the base solid of the part model.
      const isFirst = s.project.features.length === 0
      const safeFeature: SketchFeature = isFirst
        ? normalizeFeatureZRange({ ...feature, id: safeId, folderId: null, operation: 'add' })
        : normalizeFeatureZRange({ ...feature, id: safeId, folderId: feature.folderId ?? null })
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: [...s.project.features, safeFeature],
        featureTree: [...s.project.featureTree, { type: 'feature', featureId: safeFeature.id }],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      return {
        project: nextProject,
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
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: s.project.features.filter((feature) => !idsToDelete.has(feature.id)),
        featureTree: s.project.featureTree.filter((entry) => !(entry.type === 'feature' && idsToDelete.has(entry.featureId))),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
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
        project: syncFeatureTreeProject({
          ...s.project,
          features: reordered,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }),
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  addClamp: () => {
    const state = get()
    const bounds = getStockBounds(state.project.stock)
    const units = state.project.meta.units
    const width = convertLength(12, 'mm', units)
    const depth = convertLength(12, 'mm', units)
    const clampHeight = Math.min(
      Math.max(convertLength(8, 'mm', units), convertLength(0.1, 'mm', units)),
      state.project.stock.thickness,
    )
    const id = nextUniqueGeneratedId(state.project, 'cl')
    const clamp: Clamp = {
      id,
      name: `Clamp ${state.project.clamps.length + 1}`,
      type: 'step_clamp',
      x: bounds.minX + convertLength(4, 'mm', units),
      y: bounds.minY + convertLength(4, 'mm', units),
      w: width,
      h: depth,
      height: clampHeight,
      visible: true,
    }

    set((s) => ({
      project: {
        ...s.project,
        clamps: [...s.project.clamps, clamp],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      },
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'clamp', clampId: id },
        mode: 'feature',
        activeControl: null,
      },
      sketchEditSession: null,
      history: {
        past: [...s.history.past, cloneProject(s.project)].slice(-100),
        future: [],
        transactionStart: null,
      },
    }))

    return id
  },

  updateClamp: (id, patch) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        clamps: s.project.clamps.map((clamp) => (clamp.id === id ? { ...clamp, ...patch } : clamp)),
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

  deleteClamp: (id) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        clamps: s.project.clamps.filter((clamp) => clamp.id !== id),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      const nextSelection =
        s.selection.selectedNode?.type === 'clamp' && s.selection.selectedNode.clampId === id
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

  duplicateClamp: (id) => {
    const state = get()
    const sourceClamp = state.project.clamps.find((clamp) => clamp.id === id)
    if (!sourceClamp) {
      return null
    }

    const nextId = nextUniqueGeneratedId(state.project, 'cl')
    const duplicate: Clamp = {
      ...sourceClamp,
      id: nextId,
      name: duplicateClampName(sourceClamp.name, state.project.clamps),
      x: sourceClamp.x + convertLength(4, 'mm', state.project.meta.units),
      y: sourceClamp.y + convertLength(4, 'mm', state.project.meta.units),
    }

    set((s) => ({
      project: {
        ...s.project,
        clamps: [...s.project.clamps, duplicate],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      },
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'clamp', clampId: nextId },
        mode: 'feature',
        hoveredFeatureId: null,
        activeControl: null,
      },
      history: {
        past: [...s.history.past, cloneProject(s.project)].slice(-100),
        future: [],
        transactionStart: null,
      },
    }))

    return nextId
  },

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

  setAllClampsVisible: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        clamps: s.project.clamps.map((clamp) => ({ ...clamp, visible })),
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

  startAddClampPlacement: () =>
    set((s) => ({
      pendingAdd: { shape: 'clamp', anchor: null, session: nextPlacementSession() },
      pendingMove: null,
      sketchEditSession: null,
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'clamps_root' },
        mode: 'feature',
        hoveredFeatureId: null,
        activeControl: null,
      },
    })),

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
      sketchEditSession: null,
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
      sketchEditSession: null,
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
      sketchEditSession: null,
    })),

  selectOrigin: () =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'origin' },
        mode: 'feature',
        activeControl: null,
      },
      sketchEditSession: null,
    })),

  selectFeaturesRoot: () =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'features_root' },
        mode: 'feature',
        activeControl: null,
      },
      sketchEditSession: null,
    })),

  selectTabsRoot: () =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'tabs_root' },
        mode: 'feature',
        activeControl: null,
      },
      sketchEditSession: null,
    })),

  selectClampsRoot: () =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'clamps_root' },
        mode: 'feature',
        activeControl: null,
      },
      sketchEditSession: null,
    })),

  selectFeatureFolder: (id) =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'folder', folderId: id },
        mode: 'feature',
        activeControl: null,
      },
      sketchEditSession: null,
    })),

  selectTab: (id) =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'tab', tabId: id },
        mode: 'feature',
        activeControl: null,
      },
      sketchEditSession: null,
    })),

  selectClamp: (id) =>
    set((s) => ({
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'clamp', clampId: id },
        mode: 'feature',
        activeControl: null,
      },
      sketchEditSession: null,
    })),

  hoverFeature: (id) =>
    set((s) => ({
      selection: { ...s.selection, hoveredFeatureId: id },
    })),

  enterSketchEdit: (id) =>
    set((s) => ({
      pendingTransform: null,
      selection: {
        ...s.selection,
        selectedFeatureId: id,
        selectedFeatureIds: [id],
        selectedNode: { type: 'feature', featureId: id },
        mode: 'sketch_edit',
        activeControl: null,
      },
      sketchEditSession: {
        entityType: 'feature',
        entityId: id,
        snapshot: cloneProject(s.project),
        pastLength: s.history.past.length,
      },
    })),

  enterClampEdit: (id) =>
    set((s) => ({
      pendingTransform: null,
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'clamp', clampId: id },
        mode: 'sketch_edit',
        activeControl: null,
      },
      sketchEditSession: {
        entityType: 'clamp',
        entityId: id,
        snapshot: cloneProject(s.project),
        pastLength: s.history.past.length,
      },
    })),

  enterTabEdit: (id) =>
    set((s) => ({
      pendingTransform: null,
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'tab', tabId: id },
        mode: 'sketch_edit',
        activeControl: null,
      },
      sketchEditSession: {
        entityType: 'tab',
        entityId: id,
        snapshot: cloneProject(s.project),
        pastLength: s.history.past.length,
      },
    })),

  applySketchEdit: () =>
    set((s) => ({
      selection: { ...s.selection, mode: 'feature', activeControl: null },
      sketchEditSession: null,
    })),

  cancelSketchEdit: () =>
    set((s) => {
      if (!s.sketchEditSession) {
        return {
          selection: { ...s.selection, mode: 'feature', activeControl: null },
          sketchEditSession: null,
        }
      }

      const restored = normalizeProject(cloneProject(s.sketchEditSession.snapshot))
      return {
        project: restored,
        selection: {
          ...sanitizeSelection(restored, s.selection),
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
        history: {
          past: s.history.past.slice(0, s.sketchEditSession.pastLength),
          future: [],
          transactionStart: null,
        },
      }
    }),

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

            const incomingIndex = (control.index - 1 + anchorCount) % anchorCount
            const outgoingIndex = control.index % anchorCount
            const originalIncoming = nextProfile.segments[incomingIndex]
            const originalOutgoing = nextProfile.segments[outgoingIndex]
            const originalIncomingStart =
              incomingIndex === 0 ? nextProfile.start : nextProfile.segments[incomingIndex - 1]?.to
            const originalOutgoingStart = currentAnchor
            const incomingArcThrough =
              originalIncoming?.type === 'arc' && originalIncomingStart
                ? arcControlPoint(originalIncomingStart, originalIncoming)
                : null
            const outgoingArcThrough =
              originalOutgoing?.type === 'arc' && originalOutgoingStart
                ? arcControlPoint(originalOutgoingStart, originalOutgoing)
                : null

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

            const incomingSegment = nextProfile.segments[incomingIndex]
            if (incomingSegment?.type === 'arc' && incomingArcThrough) {
              const incomingStart =
                incomingIndex === 0 ? nextProfile.start : nextProfile.segments[incomingIndex - 1]?.to
              if (incomingStart) {
                const rebuiltIncoming = buildArcSegmentFromThreePoints(incomingStart, incomingSegment.to, incomingArcThrough)
                if (rebuiltIncoming) {
                  nextProfile.segments[incomingIndex] = rebuiltIncoming
                }
              }
            }

            const outgoingSegment = nextProfile.segments[outgoingIndex]
            if (outgoingSegment?.type === 'arc' && outgoingArcThrough) {
              const outgoingStart =
                control.index === 0 ? nextProfile.start : nextProfile.segments[control.index - 1]?.to
              if (outgoingStart) {
                const rebuiltOutgoing = buildArcSegmentFromThreePoints(outgoingStart, outgoingSegment.to, outgoingArcThrough)
                if (rebuiltOutgoing) {
                  nextProfile.segments[outgoingIndex] = rebuiltOutgoing
                }
              }
            }

            if (outgoingSegment?.type === 'bezier') {
              outgoingSegment.control1 = translatePoint(outgoingSegment.control1, dx, dy)
            }
          } else if (control.kind === 'out_handle') {
            const outgoingSegment = nextProfile.segments[control.index % anchorCount]
            if (outgoingSegment?.type === 'bezier') {
              outgoingSegment.control1 = point

              const incomingSegment = nextProfile.segments[(control.index - 1 + anchorCount) % anchorCount]
              const anchor =
                control.index === 0
                  ? nextProfile.start
                  : nextProfile.segments[control.index - 1]?.to

              if (incomingSegment?.type === 'bezier' && anchor) {
                const oppositeLength = pointLength(subtractPoint(incomingSegment.control2, anchor))
                const direction = normalizePoint(subtractPoint(point, anchor))
                if (direction && oppositeLength > 1e-9) {
                  incomingSegment.control2 = subtractPoint(anchor, scalePoint(direction, oppositeLength))
                }
              }
            }
          } else if (control.kind === 'arc_handle') {
            const segmentIndex = control.index % anchorCount
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
          } else {
            const incomingSegment = nextProfile.segments[(control.index - 1 + anchorCount) % anchorCount]
            if (incomingSegment?.type === 'bezier') {
              incomingSegment.control2 = point

              const outgoingSegment = nextProfile.segments[control.index % anchorCount]
              const anchor =
                control.index === 0
                  ? nextProfile.start
                  : nextProfile.segments[control.index - 1]?.to

              if (outgoingSegment?.type === 'bezier' && anchor) {
                const oppositeLength = pointLength(subtractPoint(outgoingSegment.control1, anchor))
                const direction = normalizePoint(subtractPoint(point, anchor))
                if (direction && oppositeLength > 1e-9) {
                  outgoingSegment.control1 = subtractPoint(anchor, scalePoint(direction, oppositeLength))
                }
              }
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

  moveClampControl: (clampId, control, point) =>
    set((s) => {
      const minSize = convertLength(0.1, 'mm', s.project.meta.units)
      const nextProject = {
        ...s.project,
        clamps: s.project.clamps.map((clamp) => {
          if (clamp.id !== clampId) {
            return clamp
          }

          if (control.kind !== 'anchor') {
            return clamp
          }

          const corners = [
            { x: clamp.x, y: clamp.y },
            { x: clamp.x + clamp.w, y: clamp.y },
            { x: clamp.x + clamp.w, y: clamp.y + clamp.h },
            { x: clamp.x, y: clamp.y + clamp.h },
          ]
          const opposite = corners[(control.index + 2) % 4]
          const minX = Math.min(point.x, opposite.x)
          const maxX = Math.max(point.x, opposite.x)
          const minY = Math.min(point.y, opposite.y)
          const maxY = Math.max(point.y, opposite.y)

          return {
            ...clamp,
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

  startAddRectPlacement: () =>
    set((s) => ({
      pendingAdd: { shape: 'rect', anchor: null, session: nextPlacementSession() },
      pendingMove: null,
      pendingTransform: null,
      sketchEditSession: null,
      selection: {
        ...s.selection,
        mode: 'feature',
        hoveredFeatureId: null,
        activeControl: null,
      },
    })),

  startAddTabPlacement: () =>
    set((s) => ({
      pendingAdd: { shape: 'tab', anchor: null, session: nextPlacementSession() },
      pendingMove: null,
      pendingTransform: null,
      sketchEditSession: null,
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'tabs_root' },
        mode: 'feature',
        hoveredFeatureId: null,
        activeControl: null,
      },
    })),

  startAddCirclePlacement: () =>
    set((s) => ({
      pendingAdd: { shape: 'circle', anchor: null, session: nextPlacementSession() },
      pendingMove: null,
      pendingTransform: null,
      sketchEditSession: null,
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
      pendingTransform: null,
      sketchEditSession: null,
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
      pendingTransform: null,
      sketchEditSession: null,
      selection: {
        ...s.selection,
        mode: 'feature',
        hoveredFeatureId: null,
        activeControl: null,
      },
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
      sketchEditSession: null,
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
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
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
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
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
        segments = appendSplineDraftSegment(points[0], segments, points[index])
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

  setPendingCompositeMode: (mode) =>
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

        const arcSegment = buildArcSegmentFromThreePoints(
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
              ? appendSplineDraftSegment(s.pendingAdd.start, s.pendingAdd.segments, point)
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
      const closedSegments = resolveCompositeDraftSegments(s.pendingAdd)
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

    const closedSegments = resolveCompositeDraftSegments(state.pendingAdd)
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
          segments: closedSegments.map(cloneSegment),
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

    const openSegments = resolveOpenCompositeDraftSegments(state.pendingAdd)
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
          segments: openSegments.map(cloneSegment),
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
        sketchEditSession: null,
        pendingMove: { mode: 'move', entityType: 'feature', entityIds: featureIds, fromPoint: null, toPoint: null, session: nextPlacementSession() },
        pendingTransform: null,
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
        sketchEditSession: null,
        pendingMove: { mode: 'copy', entityType: 'feature', entityIds: featureIds, fromPoint: null, toPoint: null, session: nextPlacementSession() },
        pendingTransform: null,
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

  startResizeFeature: (featureId) =>
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
        pendingMove: null,
        pendingTransform: { mode: 'resize', entityIds: featureIds, referenceStart: null, referenceEnd: null, session: nextPlacementSession() },
        sketchEditSession: null,
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

  startRotateFeature: (featureId) =>
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
        pendingMove: null,
        pendingTransform: { mode: 'rotate', entityIds: featureIds, referenceStart: null, referenceEnd: null, session: nextPlacementSession() },
        sketchEditSession: null,
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

  startMoveClamp: (clampId) =>
    set((s) => {
      const clamp = s.project.clamps.find((entry) => entry.id === clampId)
      if (!clamp) {
        return {}
      }

      return {
        pendingAdd: null,
        sketchEditSession: null,
        pendingMove: { mode: 'move', entityType: 'clamp', entityIds: [clampId], fromPoint: null, toPoint: null, session: nextPlacementSession() },
        pendingTransform: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'clamp', clampId },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  startCopyClamp: (clampId) =>
    set((s) => {
      const clamp = s.project.clamps.find((entry) => entry.id === clampId)
      if (!clamp) {
        return {}
      }

      return {
        pendingAdd: null,
        sketchEditSession: null,
        pendingMove: { mode: 'copy', entityType: 'clamp', entityIds: [clampId], fromPoint: null, toPoint: null, session: nextPlacementSession() },
        pendingTransform: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'clamp', clampId },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  startMoveTab: (tabId) =>
    set((s) => {
      const tab = s.project.tabs.find((entry) => entry.id === tabId)
      if (!tab) {
        return {}
      }

      return {
        pendingAdd: null,
        sketchEditSession: null,
        pendingMove: { mode: 'move', entityType: 'tab', entityIds: [tabId], fromPoint: null, toPoint: null, session: nextPlacementSession() },
        pendingTransform: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'tab', tabId },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  startCopyTab: (tabId) =>
    set((s) => {
      const tab = s.project.tabs.find((entry) => entry.id === tabId)
      if (!tab) {
        return {}
      }

      return {
        pendingAdd: null,
        sketchEditSession: null,
        pendingMove: { mode: 'copy', entityType: 'tab', entityIds: [tabId], fromPoint: null, toPoint: null, session: nextPlacementSession() },
        pendingTransform: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'tab', tabId },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
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
        .map((featureId) => s.project.features.find((feature) => feature.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)
        .filter((feature) => feature.operation === expectedOperation)

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
          selectedNode: { type: 'tab', tabId: createdTabs[createdTabs.length - 1].id },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  cancelPendingMove: () => set({ pendingMove: null }),

  cancelPendingTransform: () => set({ pendingTransform: null }),

  setPendingMoveFrom: (point) =>
    set((s) => ({
      pendingMove: s.pendingMove ? { ...s.pendingMove, fromPoint: point } : null,
    })),

  setPendingMoveTo: (point) =>
    set((s) => ({
      pendingMove: s.pendingMove ? { ...s.pendingMove, toPoint: point } : null,
    })),

  setPendingTransformReferenceStart: (point) =>
    set((s) => ({
      pendingTransform: s.pendingTransform ? { ...s.pendingTransform, referenceStart: point } : null,
    })),

  setPendingTransformReferenceEnd: (point) =>
    set((s) => ({
      pendingTransform: s.pendingTransform ? { ...s.pendingTransform, referenceEnd: point } : null,
    })),

  completePendingMove: (toPoint, copyCount = 1) =>
    set((s) => {
      if (!s.pendingMove?.fromPoint) {
        return {}
      }

      const { entityIds, entityType, fromPoint, mode } = s.pendingMove
      const dx = toPoint.x - fromPoint.x
      const dy = toPoint.y - fromPoint.y

      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
        return { pendingMove: null }
      }

      const normalizedCopyCount = Math.max(1, Math.floor(copyCount))
      if (entityType === 'feature') {
        const sourceFeatures = entityIds
          .map((featureId) => s.project.features.find((feature) => feature.id === featureId) ?? null)
          .filter((feature): feature is SketchFeature => feature !== null)
        if (sourceFeatures.length !== entityIds.length) {
          return { pendingMove: null }
        }

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
                  if (!entityIds.includes(feature.id) || feature.locked) {
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
      }

      if (entityType === 'tab') {
        const sourceTabs = entityIds
          .map((tabId) => s.project.tabs.find((tab) => tab.id === tabId) ?? null)
          .filter((tab): tab is Tab => tab !== null)
        if (sourceTabs.length !== entityIds.length) {
          return { pendingMove: null }
        }

        const createdTabs =
          mode === 'copy'
            ? buildCopiedTabs(sourceTabs, s.project.tabs, s.project, dx, dy, normalizedCopyCount)
            : []

        const nextProject = {
          ...s.project,
          tabs:
            mode === 'copy'
              ? [...s.project.tabs, ...createdTabs]
              : s.project.tabs.map((tab) => (
                  entityIds.includes(tab.id) ? translateTab(tab, dx, dy) : tab
                )),
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
                  selectedFeatureId: null,
                  selectedFeatureIds: [],
                  selectedNode: createdTabs.at(-1)
                    ? { type: 'tab', tabId: createdTabs.at(-1)!.id }
                    : s.selection.selectedNode,
                }
              : s.selection,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }

      const sourceClamps = entityIds
        .map((clampId) => s.project.clamps.find((clamp) => clamp.id === clampId) ?? null)
        .filter((clamp): clamp is Clamp => clamp !== null)
      if (sourceClamps.length !== entityIds.length) {
        return { pendingMove: null }
      }

      const createdClamps =
        mode === 'copy'
          ? buildCopiedClamps(sourceClamps, s.project.clamps, s.project, dx, dy, normalizedCopyCount)
          : []

      const nextProject = {
        ...s.project,
        clamps:
          mode === 'copy'
            ? [...s.project.clamps, ...createdClamps]
            : s.project.clamps.map((clamp) => (
                entityIds.includes(clamp.id) ? translateClamp(clamp, dx, dy) : clamp
              )),
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
                selectedFeatureId: null,
                selectedFeatureIds: [],
                selectedNode: createdClamps.at(-1)
                  ? { type: 'clamp', clampId: createdClamps.at(-1)!.id }
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

  completePendingTransform: (previewPoint) =>
    set((s) => {
      const pendingTransform = s.pendingTransform
      if (!pendingTransform?.referenceStart || !pendingTransform.referenceEnd) {
        return {}
      }

      const sourceFeatures = pendingTransform.entityIds
        .map((featureId) => s.project.features.find((feature) => feature.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)
      if (sourceFeatures.length !== pendingTransform.entityIds.length) {
        return { pendingTransform: null }
      }

      const transformedFeatures = new Map<string, SketchFeature>()
      for (const feature of sourceFeatures) {
        const transformed =
          pendingTransform.mode === 'resize'
            ? resizeFeatureFromReference(feature, pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
            : rotateFeatureFromReference(feature, pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
        if (!transformed) {
          return { pendingTransform: null }
        }
        transformedFeatures.set(feature.id, transformed)
      }

      const nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => transformedFeatures.get(feature.id) ?? feature),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      if (projectsEqual(nextProject, s.project)) {
        return { pendingTransform: null }
      }

      return {
        project: nextProject,
        pendingTransform: null,
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
        kind: 'rect',
        folderId: null,
        sketch: {
        profile: rectProfile(x, y, w, h),
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
    get().addFeature(feature)
  },

  addCircleFeature: (name, cx, cy, r, depth) => {
    const id = nextUniqueGeneratedId(get().project, 'f')
      const feature: SketchFeature = {
        id,
        name,
        kind: 'circle',
        folderId: null,
        sketch: {
        profile: circleProfile(cx, cy, r),
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
    get().addFeature(feature)
  },

  addPolygonFeature: (name, points, depth) => {
    const id = nextUniqueGeneratedId(get().project, 'f')
      const feature: SketchFeature = {
        id,
        name,
        kind: 'polygon',
        folderId: null,
        sketch: {
        profile: polygonProfile(points),
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
    get().addFeature(feature)
  },

  addSplineFeature: (name, points, depth) => {
    const id = nextUniqueGeneratedId(get().project, 'f')
      const feature: SketchFeature = {
        id,
        name,
        kind: 'spline',
        folderId: null,
        sketch: {
        profile: splineProfile(points),
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
