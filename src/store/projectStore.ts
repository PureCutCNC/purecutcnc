import { create } from 'zustand'
import ClipperLib from 'clipper-lib'
import { copyBundledDefinitions } from '../engine/gcode/definitions'
import { validateMachineDefinition } from '../engine/gcode/types'
import type { MachineDefinition } from '../engine/gcode/types'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  fromClipperPath,
  normalizeWinding,
  toClipperPath,
} from '../engine/toolpaths/geometry'
import { createImportedFeature, isProfileDegenerate, stripFileExtension, uniqueName, type ImportedShape, type ImportSourceType } from '../import'
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
  type TextFeatureData,
} from '../types/project'
import type {
  BackdropImage,
  Clamp,
  FeatureOperation,
  FeatureFolder,
  FeatureTreeEntry,
  GridSettings,
  Operation,
  OperationKind,
  OperationPass,
  OperationTarget,
  Point,
  Project,
  SketchProfile,
  SketchFeature,
  Stock,
  Tab,
  Tool,
} from '../types/project'
import { convertProjectUnits } from '../utils/units'
import { convertLength } from '../utils/units'
import {
  generateTextShapes,
  getTextFrameProfile,
  normalizeTextFontId,
  type TextToolConfig,
} from '../text'

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
  sketchEditTool: SketchEditTool | null
  // sketch edit mode — which anchor/handle is being dragged
  activeControl: SketchControlRef | null
}

export interface SketchControlRef {
  kind: 'anchor' | 'in_handle' | 'out_handle' | 'arc_handle'
  index: number
}

export type SketchEditTool = 'add_point' | 'delete_point' | 'fillet'

export type SketchInsertTarget =
  | { kind: 'segment'; segmentIndex: number; point: Point; t: number }
  | { kind: 'extend_start'; point: Point }
  | { kind: 'extend_end'; point: Point }

export type SelectedNode =
  | { type: 'project' }
  | { type: 'grid' }
  | { type: 'stock' }
  | { type: 'origin' }
  | { type: 'backdrop' }
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
  pendingOffset: PendingOffsetTool | null
  pendingShapeAction: PendingShapeActionTool | null
  backdropImageLoading: boolean
  sketchEditSession: SketchEditSession | null
  history: ProjectHistory

  // Project ops
  createNewProject: (template?: Project, name?: string) => void
  setProjectName: (name: string) => void
  setShowFeatureInfo: (visible: boolean) => void
  setProjectClearances: (patch: Partial<Pick<Project['meta'], 'maxTravelZ' | 'operationClearanceZ' | 'clampClearanceXY' | 'clampClearanceZ'>>) => void
  setOrigin: (origin: Project['origin']) => void
  startPlaceOrigin: () => void
  placeOriginAt: (point: Point) => void
  loadBackdropImage: (input: Pick<BackdropImage, 'name' | 'mimeType' | 'imageDataUrl' | 'intrinsicWidth' | 'intrinsicHeight'>) => void
  setBackdropImageLoading: (loading: boolean) => void
  setBackdrop: (backdrop: BackdropImage | null) => void
  updateBackdrop: (patch: Partial<BackdropImage>) => void
  deleteBackdrop: () => void
  setSelectedMachineId: (id: string | null) => void
  addMachineDefinition: (definition: MachineDefinition) => void
  removeMachineDefinition: (id: string) => void
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
  importShapes: (input: { fileName: string; sourceType: ImportSourceType; shapes: ImportedShape[] }) => string[]
  updateFeature: (id: string, patch: Partial<SketchFeature>) => void
  deleteFeature: (id: string) => void
  deleteFeatures: (ids: string[]) => void
  mergeSelectedFeatures: (keepOriginals?: boolean) => string[]
  cutSelectedFeatures: (keepOriginals?: boolean) => string[]
  offsetSelectedFeatures: (distance: number) => string[]
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
  selectBackdrop: () => void
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
  setSketchEditTool: (tool: SketchEditTool | null) => void
  setActiveControl: (control: SketchControlRef | null) => void
  moveFeatureControl: (featureId: string, control: SketchControlRef, point: Point) => void
  insertFeaturePoint: (featureId: string, target: SketchInsertTarget) => void
  deleteFeaturePoint: (featureId: string, anchorIndex: number) => void
  filletFeaturePoint: (featureId: string, anchorIndex: number, radius: number) => void
  moveClampControl: (clampId: string, control: SketchControlRef, point: Point) => void

  // Feature placement flow
  startAddRectPlacement: () => void
  startAddCirclePlacement: () => void
  startAddPolygonPlacement: () => void
  startAddSplinePlacement: () => void
  startAddCompositePlacement: () => void
  startAddTextPlacement: (config: TextToolConfig) => void
  cancelPendingAdd: () => void
  setPendingAddAnchor: (point: Point) => void
  placePendingAddAt: (point: Point) => void
  placePendingTextAt: (point: Point) => string[]
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
  startMoveBackdrop: () => void
  startResizeBackdrop: () => void
  startRotateBackdrop: () => void
  startJoinSelectedFeatures: () => void
  startCutSelectedFeatures: () => void
  cancelPendingShapeAction: () => void
  setPendingShapeActionKeepOriginals: (keepOriginals: boolean) => void
  completePendingShapeAction: () => string[]
  startOffsetSelectedFeatures: () => void
  cancelPendingOffset: () => void
  completePendingOffset: (distance: number) => string[]
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
  | { shape: 'text'; config: TextToolConfig; session: number }
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
  entityType: 'feature' | 'clamp' | 'tab' | 'backdrop'
  entityIds: string[]
  fromPoint: Point | null
  toPoint: Point | null
  session: number
}

export interface PendingTransformTool {
  mode: 'resize' | 'rotate'
  entityType: 'feature' | 'backdrop'
  entityIds: string[]
  referenceStart: Point | null
  referenceEnd: Point | null
  session: number
}

export interface PendingOffsetTool {
  entityIds: string[]
  session: number
}

export type PendingShapeActionTool =
  | {
      kind: 'join'
      entityIds: string[]
      keepOriginals: boolean
      session: number
    }
  | {
      kind: 'cut'
      cutterId: string | null
      targetIds: string[]
      keepOriginals: boolean
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

interface ClipperPolyNode {
  IsHole(): boolean
  Contour(): Array<{ X: number; Y: number }>
  Childs?: () => ClipperPolyNode[]
  m_Childs?: ClipperPolyNode[]
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

function normalizeEditableProfileClosure(profile: SketchProfile): SketchProfile {
  if (profile.segments.length === 0) {
    return {
      ...profile,
      closed: false,
    }
  }

  const endAnchor = anchorPointForIndex(profile, profile.segments.length)
  const shouldClose = pointsEqual(profile.start, endAnchor)
  return {
    ...profile,
    closed: shouldClose,
  }
}

function getClipperChildren(node: ClipperPolyNode): ClipperPolyNode[] {
  return node.Childs ? node.Childs() : (node.m_Childs ?? [])
}

function flattenFeatureToClipperPath(feature: SketchFeature, scale = DEFAULT_CLIPPER_SCALE) {
  const flattened = flattenProfile(feature.sketch.profile)
  return toClipperPath(normalizeWinding(flattened.points, false), scale)
}

function executeClipPaths(subjectPaths: ReturnType<typeof flattenFeatureToClipperPath>[], clipPaths: ReturnType<typeof flattenFeatureToClipperPath>[], clipType: number) {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const solution = new ClipperLib.Paths()
  clipper.Execute(
    clipType,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution as ReturnType<typeof flattenFeatureToClipperPath>[]
}

function executeClipTree(subjectPaths: ReturnType<typeof flattenFeatureToClipperPath>[], clipPaths: ReturnType<typeof flattenFeatureToClipperPath>[], clipType: number): ClipperPolyNode {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const polyTree = new ClipperLib.PolyTree()
  clipper.Execute(
    clipType,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return polyTree as ClipperPolyNode
}

function unionClipperPaths(paths: ReturnType<typeof flattenFeatureToClipperPath>[]) {
  if (paths.length === 0) {
    return []
  }
  return executeClipPaths(paths, [], ClipperLib.ClipType.ctUnion)
}

function rangesOverlap(minA: number, maxA: number, minB: number, maxB: number): boolean {
  return maxA >= minB && maxB >= minA
}

function featuresOverlap(a: SketchFeature, b: SketchFeature): boolean {
  if (!a.sketch.profile.closed || !b.sketch.profile.closed) {
    return false
  }

  const boundsA = getProfileBounds(a.sketch.profile)
  const boundsB = getProfileBounds(b.sketch.profile)
  if (
    !rangesOverlap(boundsA.minX, boundsA.maxX, boundsB.minX, boundsB.maxX)
    || !rangesOverlap(boundsA.minY, boundsA.maxY, boundsB.minY, boundsB.maxY)
  ) {
    return false
  }

  const intersections = executeClipPaths(
    [flattenFeatureToClipperPath(a)],
    [flattenFeatureToClipperPath(b)],
    0, // ctIntersection is available at runtime but omitted from the local Clipper typings.
  )

  return intersections.length > 0
}

function featuresFormConnectedOverlapGroup(features: SketchFeature[]): boolean {
  if (features.length <= 1) {
    return true
  }

  const visited = new Set<number>([0])
  const stack = [0]

  while (stack.length > 0) {
    const currentIndex = stack.pop()!
    for (let index = 0; index < features.length; index += 1) {
      if (visited.has(index)) {
        continue
      }
      if (featuresOverlap(features[currentIndex], features[index])) {
        visited.add(index)
        stack.push(index)
      }
    }
  }

  return visited.size === features.length
}

interface DerivedFeatureGroup {
  sourceId: string
  features: SketchFeature[]
}

function normalizeDerivedFeatureNameStem(name: string) {
  return name
    .replace(/(?: Join(?: \d+)?)$/u, '')
    .replace(/(?: Offset(?: \d+)?)$/u, '')
    .replace(/(?: Cut(?: Hole)?(?: \d+)?)$/u, '')
    .trim()
}

function cutFeaturesByCutterGrouped(
  project: Project,
  cutter: SketchFeature,
  targets: SketchFeature[],
): DerivedFeatureGroup[] {
  const clipPaths = [flattenFeatureToClipperPath(cutter)]
  const existingNames = [...project.features.map((feature) => feature.name)]
  const groups: DerivedFeatureGroup[] = []

  for (const target of targets) {
    const subjectPaths = [flattenFeatureToClipperPath(target)]
    const polyTree = executeClipTree(subjectPaths, clipPaths, ClipperLib.ClipType.ctDifference)
    const cutNameStem = normalizeDerivedFeatureNameStem(target.name)
    const nextFeatures = collectDerivedFeaturesFromPolyTree(
      project,
      polyTree,
      target,
      target.operation,
      `${cutNameStem} Cut`,
    )

    const groupedFeatures: SketchFeature[] = []
    for (const feature of nextFeatures) {
      const uniqueFeature = {
        ...feature,
        name: uniqueName(feature.name, [...existingNames, ...groupedFeatures.map((entry) => entry.name)]),
      }
      groupedFeatures.push(uniqueFeature)
      existingNames.push(uniqueFeature.name)
    }
    groups.push({ sourceId: target.id, features: groupedFeatures })
  }

  return groups
}

function insertDerivedFeaturesAfterSources(
  features: SketchFeature[],
  groups: DerivedFeatureGroup[],
  removeIds: Set<string>,
): SketchFeature[] {
  const groupMap = new Map(groups.map((group) => [group.sourceId, group.features]))
  const nextFeatures: SketchFeature[] = []

  for (const feature of features) {
    if (!removeIds.has(feature.id)) {
      nextFeatures.push(feature)
    }
    const derived = groupMap.get(feature.id)
    if (derived?.length) {
      nextFeatures.push(...derived)
    }
  }

  return nextFeatures
}

function insertDerivedFeatureTreeEntries(
  featureTree: FeatureTreeEntry[],
  features: SketchFeature[],
  groups: DerivedFeatureGroup[],
  removeIds: Set<string>,
): FeatureTreeEntry[] {
  const featureMap = new Map(features.map((feature) => [feature.id, feature]))
  const rootGroupMap = new Map(
    groups
      .filter((group) => {
        const source = featureMap.get(group.sourceId)
        return source?.folderId === null
      })
      .map((group) => [
        group.sourceId,
        group.features
          .filter((feature) => feature.folderId === null)
          .map((feature) => ({ type: 'feature', featureId: feature.id } as FeatureTreeEntry)),
      ]),
  )

  return featureTree.flatMap((entry) => {
    if (entry.type !== 'feature') {
      return [entry]
    }

    const appended = rootGroupMap.get(entry.featureId) ?? []
    if (removeIds.has(entry.featureId)) {
      return appended
    }

    return [entry, ...appended]
  })
}

function offsetClipperPaths(paths: ReturnType<typeof flattenFeatureToClipperPath>[], delta: number) {
  if (paths.length === 0) {
    return []
  }
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  return solution as ReturnType<typeof flattenFeatureToClipperPath>[]
}

function clipperContourToProfile(contour: ReturnType<typeof flattenFeatureToClipperPath>, scale = DEFAULT_CLIPPER_SCALE): SketchProfile | null {
  const points = fromClipperPath(contour, scale)
  if (points.length < 3) {
    return null
  }

  const first = points[0]
  const last = points[points.length - 1]
  const vertices = pointsEqual(first, last) ? points.slice(0, -1) : points
  if (vertices.length < 3) {
    return null
  }

  return polygonProfile(vertices)
}

function createDerivedFeature(
  project: Project,
  baseFeature: SketchFeature,
  profile: SketchProfile,
  operation: FeatureOperation,
  name: string,
): SketchFeature {
  return normalizeFeatureZRange({
    id: nextUniqueGeneratedId(project, 'f'),
    name,
    kind: inferFeatureKind(profile),
    folderId: baseFeature.folderId,
    sketch: {
      profile,
      origin: clonePoint(baseFeature.sketch.origin),
      orientationAngle: baseFeature.sketch.orientationAngle,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: baseFeature.z_top,
    z_bottom: baseFeature.z_bottom,
    visible: true,
    locked: false,
  })
}

function collectDerivedFeaturesFromPolyTree(
  project: Project,
  node: ClipperPolyNode,
  baseFeature: SketchFeature,
  baseOperation: FeatureOperation,
  baseName: string,
  contourDepth = 0,
): SketchFeature[] {
  const created: SketchFeature[] = []
  const contour = node.Contour()
  const nextContourDepth = contour.length > 0 ? contourDepth + 1 : contourDepth

  if (contour.length > 0) {
    const profile = clipperContourToProfile(contour)
    if (profile) {
      const logicalDepth = nextContourDepth - 1
      const operation = logicalDepth % 2 === 0 ? baseOperation : (baseOperation === 'add' ? 'subtract' : 'add')
      const name = uniqueName(
        logicalDepth === 0 ? baseName : `${baseName} Hole`,
        [...project.features.map((feature) => feature.name), ...created.map((feature) => feature.name)],
      )
      const nextProject = { ...project, features: [...project.features, ...created] }
      created.push(createDerivedFeature(nextProject, baseFeature, profile, operation, name))
    }
  }

  for (const child of getClipperChildren(node)) {
    created.push(...collectDerivedFeaturesFromPolyTree(
      { ...project, features: [...project.features, ...created] },
      child,
      baseFeature,
      baseOperation,
      baseName,
      nextContourDepth,
    ))
  }

  return created
}

function selectedClosedFeaturesFromIds(project: Project, featureIds: string[]): SketchFeature[] {
  return featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is SketchFeature => feature !== null)
    .filter((feature) => feature.sketch.profile.closed)
}

export function previewOffsetFeatures(project: Project, featureIds: string[], distance: number): SketchFeature[] {
  const selectedFeatures = selectedClosedFeaturesFromIds(project, featureIds)
  if (selectedFeatures.length === 0 || Math.abs(distance) <= 1e-9) {
    return []
  }

  const baseFeature = selectedFeatures[selectedFeatures.length - 1]
  const unionPaths = unionClipperPaths(selectedFeatures.map((feature) => flattenFeatureToClipperPath(feature)))
  const offsetPaths = offsetClipperPaths(unionPaths, distance * DEFAULT_CLIPPER_SCALE)
  const createdFeatures: SketchFeature[] = []

  for (const [index, path] of offsetPaths.entries()) {
    const profile = clipperContourToProfile(path)
    if (!profile) {
      continue
    }

    const nextProject = { ...project, features: [...project.features, ...createdFeatures] }
    createdFeatures.push(createDerivedFeature(
      nextProject,
      baseFeature,
      profile,
      baseFeature.operation,
      uniqueName(index === 0 ? `${baseFeature.name} Offset` : `${baseFeature.name} Offset ${index + 1}`, [
        ...project.features.map((feature) => feature.name),
        ...createdFeatures.map((feature) => feature.name),
      ]),
    ))
  }

  return createdFeatures
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  }
}

function anchorPointForIndex(profile: SketchProfile, index: number): Point {
  if (index <= 0) {
    return profile.start
  }
  return profile.segments[index - 1]?.to ?? profile.start
}

function splitBezierSegment(start: Point, segment: Extract<Segment, { type: 'bezier' }>, t: number): [Segment, Segment] {
  const p01 = lerpPoint(start, segment.control1, t)
  const p12 = lerpPoint(segment.control1, segment.control2, t)
  const p23 = lerpPoint(segment.control2, segment.to, t)
  const p012 = lerpPoint(p01, p12, t)
  const p123 = lerpPoint(p12, p23, t)
  const splitPoint = lerpPoint(p012, p123, t)

  return [
    {
      type: 'bezier',
      control1: p01,
      control2: p012,
      to: splitPoint,
    },
    {
      type: 'bezier',
      control1: p123,
      control2: p23,
      to: clonePoint(segment.to),
    },
  ]
}

function splitArcSegment(segment: Extract<Segment, { type: 'arc' }>, point: Point): [Segment, Segment] {
  return [
    {
      type: 'arc',
      center: clonePoint(segment.center),
      clockwise: segment.clockwise,
      to: clonePoint(point),
    },
    {
      type: 'arc',
      center: clonePoint(segment.center),
      clockwise: segment.clockwise,
      to: clonePoint(segment.to),
    },
  ]
}

function extendOpenProfileAtStart(profile: SketchProfile, point: Point): SketchProfile {
  const nextPoint = clonePoint(profile.start)
  const firstSegment = profile.segments[0]
  const insertedSegment: Segment =
    firstSegment?.type === 'bezier'
      ? {
          type: 'bezier',
          control1: lerpPoint(point, nextPoint, 1 / 3),
          control2: {
            x: nextPoint.x + (nextPoint.x - firstSegment.control1.x),
            y: nextPoint.y + (nextPoint.y - firstSegment.control1.y),
          },
          to: nextPoint,
        }
      : {
          type: 'line',
          to: nextPoint,
        }

  return {
    ...profile,
    start: clonePoint(point),
    segments: [insertedSegment, ...profile.segments.map(cloneSegment)],
  }
}

function extendOpenProfileAtEnd(profile: SketchProfile, point: Point): SketchProfile {
  const nextSegments = profile.segments.map(cloneSegment)
  const lastAnchor = anchorPointForIndex(profile, profile.segments.length)
  const lastSegment = profile.segments[profile.segments.length - 1]
  const insertedSegment: Segment =
    lastSegment?.type === 'bezier'
      ? {
          type: 'bezier',
          control1: {
            x: lastAnchor.x + (lastAnchor.x - lastSegment.control2.x),
            y: lastAnchor.y + (lastAnchor.y - lastSegment.control2.y),
          },
          control2: lerpPoint(point, lastAnchor, 1 / 3),
          to: clonePoint(point),
        }
      : {
          type: 'line',
          to: clonePoint(point),
        }

  nextSegments.push(insertedSegment)
  return {
    ...profile,
    segments: nextSegments,
  }
}

function buildBridgeSegment(
  previousAnchor: Point,
  nextAnchor: Point,
  incomingSegment: Segment,
  outgoingSegment: Segment,
): Segment {
  if (incomingSegment.type === 'bezier' || outgoingSegment.type === 'bezier') {
    return {
      type: 'bezier',
      control1:
        incomingSegment.type === 'bezier'
          ? clonePoint(incomingSegment.control1)
          : lerpPoint(previousAnchor, nextAnchor, 1 / 3),
      control2:
        outgoingSegment.type === 'bezier'
          ? clonePoint(outgoingSegment.control2)
          : lerpPoint(nextAnchor, previousAnchor, 1 / 3),
      to: clonePoint(nextAnchor),
    }
  }

  return {
    type: 'line',
    to: clonePoint(nextAnchor),
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function createFilletArcSegment(start: Point, end: Point, center: Point): Segment {
  const startVector = subtractPoint(start, center)
  const endVector = subtractPoint(end, center)
  return {
    type: 'arc',
    center: clonePoint(center),
    clockwise: crossPoint(startVector, endVector) < 0,
    to: clonePoint(end),
  }
}

function applyLineCornerFillet(profile: SketchProfile, anchorIndex: number, radius: number): SketchProfile | null {
  const anchors = profileVertices(profile)
  const anchorCount = anchors.length
  if (radius <= 1e-9 || anchorIndex < 0 || anchorIndex >= anchorCount) {
    return null
  }

  const hasIncoming = profile.closed || anchorIndex > 0
  const hasOutgoing = profile.closed || anchorIndex < anchorCount - 1
  if (!hasIncoming || !hasOutgoing) {
    return null
  }

  const incomingIndex = profile.closed ? (anchorIndex - 1 + profile.segments.length) % profile.segments.length : anchorIndex - 1
  const outgoingIndex = anchorIndex
  const incomingSegment = profile.segments[incomingIndex]
  const outgoingSegment = profile.segments[outgoingIndex]
  if (!incomingSegment || !outgoingSegment || incomingSegment.type !== 'line' || outgoingSegment.type !== 'line') {
    return null
  }

  const previousAnchor = anchors[(anchorIndex - 1 + anchorCount) % anchorCount]
  const corner = anchors[anchorIndex]
  const nextAnchor = anchors[(anchorIndex + 1) % anchorCount]
  const incomingDirection = normalizePoint(subtractPoint(previousAnchor, corner))
  const outgoingDirection = normalizePoint(subtractPoint(nextAnchor, corner))
  if (!incomingDirection || !outgoingDirection) {
    return null
  }

  const turnDot = clampNumber(dotPoint(incomingDirection, outgoingDirection), -1, 1)
  const interiorAngle = Math.acos(turnDot)
  if (!Number.isFinite(interiorAngle) || interiorAngle <= 1e-3 || Math.abs(Math.PI - interiorAngle) <= 1e-3) {
    return null
  }

  const trim = radius / Math.tan(interiorAngle / 2)
  const incomingLength = pointLength(subtractPoint(previousAnchor, corner))
  const outgoingLength = pointLength(subtractPoint(nextAnchor, corner))
  if (!(trim > 0) || trim >= incomingLength || trim >= outgoingLength) {
    return null
  }

  const tangentStart = addPoint(corner, scalePoint(incomingDirection, trim))
  const tangentEnd = addPoint(corner, scalePoint(outgoingDirection, trim))
  const bisector = normalizePoint(addPoint(incomingDirection, outgoingDirection))
  if (!bisector) {
    return null
  }

  const centerDistance = radius / Math.sin(interiorAngle / 2)
  const center = addPoint(corner, scalePoint(bisector, centerDistance))
  const nextSegments = profile.segments.map(cloneSegment)
  nextSegments[incomingIndex] = { type: 'line', to: clonePoint(tangentStart) }
  nextSegments.splice(outgoingIndex, 1, createFilletArcSegment(tangentStart, tangentEnd, center), { type: 'line', to: clonePoint(nextAnchor) })

  if (profile.closed && anchorIndex === 0) {
    return normalizeEditableProfileClosure({
      ...profile,
      start: clonePoint(tangentStart),
      segments: nextSegments,
    })
  }

  if (!profile.closed && anchorIndex === 0) {
    return normalizeEditableProfileClosure({
      ...profile,
      start: clonePoint(tangentStart),
      segments: nextSegments.slice(1),
    })
  }

  return normalizeEditableProfileClosure({
    ...profile,
    segments: nextSegments,
  })
}

function insertPointIntoProfile(profile: SketchProfile, target: SketchInsertTarget): SketchProfile {
  if (!profile.closed && target.kind === 'extend_start') {
    return extendOpenProfileAtStart(profile, target.point)
  }

  if (!profile.closed && target.kind === 'extend_end') {
    return extendOpenProfileAtEnd(profile, target.point)
  }

  if (target.kind !== 'segment') {
    return profile
  }

  const segmentIndex = target.segmentIndex
  const segment = profile.segments[segmentIndex]
  const start = anchorPointForIndex(profile, segmentIndex)

  if (!segment || pointsEqual(start, target.point) || pointsEqual(segment.to, target.point)) {
    return profile
  }

  const nextSegments = profile.segments.map(cloneSegment)
  const replacements =
    segment.type === 'line'
      ? [
          { type: 'line' as const, to: clonePoint(target.point) },
          { type: 'line' as const, to: clonePoint(segment.to) },
        ]
      : segment.type === 'bezier'
        ? splitBezierSegment(start, segment, Math.min(0.999, Math.max(0.001, target.t)))
        : splitArcSegment(segment, target.point)

  nextSegments.splice(segmentIndex, 1, ...replacements)
  return {
    ...profile,
    segments: nextSegments,
  }
}

function deleteAnchorFromProfile(profile: SketchProfile, anchorIndex: number): SketchProfile | null {
  const anchors = profileVertices(profile)
  const anchorCount = anchors.length

  if (profile.closed) {
    if (anchorCount <= 3 || anchorIndex < 0 || anchorIndex >= anchorCount) {
      return null
    }

    const nextSegments = profile.segments.map(cloneSegment)
    if (anchorIndex === 0) {
      const nextStart = anchors[1]
      const removedOutgoing = nextSegments[0]
      nextSegments.shift()
      if (nextSegments.length === 0) {
        return null
      }
      const closingStart = anchors[anchorCount - 1]
      const previousClosing = nextSegments[nextSegments.length - 1]
      nextSegments[nextSegments.length - 1] = buildBridgeSegment(closingStart, nextStart, previousClosing, removedOutgoing)
      return {
        ...profile,
        start: clonePoint(nextStart),
        segments: nextSegments,
      }
    }

    const incomingIndex = anchorIndex - 1
    const outgoingIndex = anchorIndex
    const nextAnchor = anchors[(anchorIndex + 1) % anchorCount]
    const previousAnchor = anchors[(anchorIndex - 1 + anchorCount) % anchorCount]
    nextSegments[incomingIndex] = buildBridgeSegment(
      previousAnchor,
      nextAnchor,
      nextSegments[incomingIndex],
      nextSegments[outgoingIndex],
    )
    nextSegments.splice(outgoingIndex, 1)
    return {
      ...profile,
      segments: nextSegments,
    }
  }

  if (anchorCount <= 2 || anchorIndex < 0 || anchorIndex >= anchorCount) {
    return null
  }

  const nextSegments = profile.segments.map(cloneSegment)

  if (anchorIndex === 0) {
    const nextStart = anchors[1]
    nextSegments.shift()
    return {
      ...profile,
      start: clonePoint(nextStart),
      segments: nextSegments,
      closed: false,
    }
  }

  if (anchorIndex === anchorCount - 1) {
    nextSegments.pop()
    return {
      ...profile,
      segments: nextSegments,
      closed: false,
    }
  }

  const incomingIndex = anchorIndex - 1
  const outgoingIndex = anchorIndex
  const nextAnchor = anchors[anchorIndex + 1]
  const previousAnchor = anchors[anchorIndex - 1]
  nextSegments[incomingIndex] = buildBridgeSegment(
    previousAnchor,
    nextAnchor,
    nextSegments[incomingIndex],
    nextSegments[outgoingIndex],
  )
  nextSegments.splice(outgoingIndex, 1)
  return {
    ...profile,
    segments: nextSegments,
    closed: false,
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
    kind: feature.kind === 'text' ? 'text' : inferFeatureKind(profile),
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
    kind: feature.kind === 'text' ? 'text' : inferFeatureKind(profile),
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

function backdropResizeBasis(backdrop: BackdropImage): { u: Point; v: Point } {
  const orientationAngle = normalizeAngleDegrees(backdrop.orientationAngle ?? 90)
  return {
    u: angleToPoint(orientationAngle - 90),
    v: angleToPoint(orientationAngle),
  }
}

export function resizeBackdropFromReference(
  backdrop: BackdropImage,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): BackdropImage | null {
  const referenceVector = subtractPoint(referenceEnd, referenceStart)
  const referenceLength = pointLength(referenceVector)
  if (referenceLength <= 1e-9) {
    return null
  }

  const unit = scalePoint(referenceVector, 1 / referenceLength)
  const projectedLength = dotPoint(subtractPoint(previewPoint, referenceStart), unit)
  const constrainedPreview = addPoint(referenceStart, scalePoint(unit, projectedLength))
  const { u, v } = backdropResizeBasis(backdrop)
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

  const local = subtractPoint(backdrop.center, referenceStart)
  const localU = dotPoint(local, u)
  const localV = dotPoint(local, v)

  return {
    ...backdrop,
    center: {
      x: referenceStart.x + u.x * localU * scaleU + v.x * localV * scaleV,
      y: referenceStart.y + u.y * localU * scaleU + v.y * localV * scaleV,
    },
    width: backdrop.width * scaleU,
    height: backdrop.height * scaleV,
  }
}

export function rotateBackdropFromReference(
  backdrop: BackdropImage,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): BackdropImage | null {
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

  return {
    ...backdrop,
    center: rotatePointAround(backdrop.center, referenceStart, angle),
    orientationAngle: normalizeAngleDegrees(backdrop.orientationAngle + angle * (180 / Math.PI)),
  }
}

export function filletRadiusFromPoint(
  feature: SketchFeature,
  anchorIndex: number,
  previewPoint: Point,
): number | null {
  const profile = feature.sketch.profile
  const anchors = profileVertices(profile)
  const anchorCount = anchors.length
  const hasIncoming = profile.closed || anchorIndex > 0
  const hasOutgoing = profile.closed || anchorIndex < anchorCount - 1
  if (!hasIncoming || !hasOutgoing || anchorIndex < 0 || anchorIndex >= anchorCount) {
    return null
  }

  const corner = anchors[anchorIndex]
  const previousAnchor = anchors[(anchorIndex - 1 + anchorCount) % anchorCount]
  const nextAnchor = anchors[(anchorIndex + 1) % anchorCount]
  const incomingDirection = normalizePoint(subtractPoint(previousAnchor, corner))
  const outgoingDirection = normalizePoint(subtractPoint(nextAnchor, corner))
  if (!incomingDirection || !outgoingDirection) {
    return null
  }

  const incomingIndex = profile.closed ? (anchorIndex - 1 + profile.segments.length) % profile.segments.length : anchorIndex - 1
  const outgoingIndex = anchorIndex
  const incomingSegment = profile.segments[incomingIndex]
  const outgoingSegment = profile.segments[outgoingIndex]
  if (!incomingSegment || !outgoingSegment || incomingSegment.type !== 'line' || outgoingSegment.type !== 'line') {
    return null
  }

  const previewVector = subtractPoint(previewPoint, corner)
  const trim = Math.max(0, dotPoint(previewVector, incomingDirection), dotPoint(previewVector, outgoingDirection))
  if (!(trim > 1e-9)) {
    return null
  }

  const turnDot = clampNumber(dotPoint(incomingDirection, outgoingDirection), -1, 1)
  const interiorAngle = Math.acos(turnDot)
  if (!Number.isFinite(interiorAngle) || interiorAngle <= 1e-3 || Math.abs(Math.PI - interiorAngle) <= 1e-3) {
    return null
  }

  return trim * Math.tan(interiorAngle / 2)
}

export function filletFeatureFromPoint(
  feature: SketchFeature,
  anchorIndex: number,
  previewPoint: Point,
): SketchFeature | null {
  const radius = filletRadiusFromPoint(feature, anchorIndex, previewPoint)
  if (!radius) {
    return null
  }

  const profile = applyLineCornerFillet(feature.sketch.profile, anchorIndex, radius)
  if (!profile) {
    return null
  }

  return {
    ...feature,
    kind: inferFeatureKind(profile),
    sketch: {
      ...feature.sketch,
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

function uniqueFolderName(preferred: string, folders: FeatureFolder[]): string {
  return uniqueName(preferred, folders.map((folder) => folder.name))
}

function textFolderBaseName(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return 'Text'
  }
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized
}

function createTextFeatureAt(project: Project, config: TextToolConfig, anchor: Point): SketchFeature | null {
  const generatedShapes = generateTextShapes(config, { x: 0, y: 0 }).filter((shape) => !isProfileDegenerate(shape.profile))
  if (generatedShapes.length === 0) {
    return null
  }

  const featureName = uniqueName(textFolderBaseName(config.text), project.features.map((feature) => feature.name))
  const isFirstFeature = project.features.length === 0
  const textData: TextFeatureData = {
    text: config.text,
    style: config.style,
    fontId: config.fontId,
    size: config.size,
  }

  return normalizeFeatureZRange({
    id: nextUniqueGeneratedId(project, 'f'),
    name: featureName,
    kind: 'text',
    text: textData,
    folderId: null,
    sketch: {
      profile: getTextFrameProfile(config, anchor),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: isFirstFeature ? 'add' : config.operation,
    z_top: project.stock.thickness,
    z_bottom: 0,
    visible: true,
    locked: false,
  })
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
    text: feature.kind === 'text' && feature.text
      ? {
        ...feature.text,
        text: feature.text.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s*\n+\s*/g, ' ').trim() || 'TEXT',
        fontId: normalizeTextFontId(feature.text.fontId, feature.text.style),
      }
      : null,
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

function normalizeBackdrop(backdrop: BackdropImage | null | undefined, project: Project): BackdropImage | null {
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

function normalizeMachineDefinitions(project: Project): {
  machineDefinitions: MachineDefinition[]
  selectedMachineId: string | null
} {
  const legacyMeta = project.meta as Project['meta'] & {
    machineId?: string | null
    customMachineDefinition?: MachineDefinition | null
  }

  const rawDefinitions = Array.isArray(project.meta.machineDefinitions)
    ? project.meta.machineDefinitions
    : null

  if (!rawDefinitions) {
    const machineDefinitions = copyBundledDefinitions()
    let selectedMachineId: string | null = legacyMeta.machineId ?? null

    if (legacyMeta.customMachineDefinition) {
      const customDefinition = validateMachineDefinition({
        ...legacyMeta.customMachineDefinition,
        builtin: false,
      })
      machineDefinitions.push(customDefinition)
      selectedMachineId = customDefinition.id
    }

    return {
      machineDefinitions,
      selectedMachineId: machineDefinitions.some((definition) => definition.id === selectedMachineId)
        ? selectedMachineId
        : null,
    }
  }

  const definitions: MachineDefinition[] = []
  const seenIds = new Set<string>()
  for (const rawDefinition of rawDefinitions) {
    try {
      const definition = validateMachineDefinition(rawDefinition)
      if (seenIds.has(definition.id)) {
        continue
      }
      seenIds.add(definition.id)
      definitions.push(definition)
    } catch {
      continue
    }
  }

  const selectedMachineId = project.meta.selectedMachineId ?? null

  return {
    machineDefinitions: definitions,
    selectedMachineId: definitions.some((definition) => definition.id === selectedMachineId)
      ? selectedMachineId
      : null,
  }
}

function normalizeProject(project: Project): Project {
  const normalizedMachines = normalizeMachineDefinitions(project)
  const meta = {
    ...project.meta,
    showFeatureInfo: project.meta.showFeatureInfo ?? true,
    maxTravelZ: project.meta.maxTravelZ ?? defaultMaxTravelZ(project.meta.units),
    operationClearanceZ: project.meta.operationClearanceZ ?? defaultOperationClearanceZ(project.meta.units),
    clampClearanceXY: project.meta.clampClearanceXY ?? defaultClampClearanceXY(project.meta.units),
    clampClearanceZ: project.meta.clampClearanceZ ?? defaultClampClearanceZ(project.meta.units),
    machineDefinitions: normalizedMachines.machineDefinitions,
    selectedMachineId: normalizedMachines.selectedMachineId,
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
    backdrop: normalizeBackdrop(project.backdrop, normalizedBase),
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
    backdrop: null,
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
    sketchEditTool: null,
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
        sketchEditTool: null,
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
      : selectedNode?.type === 'backdrop'
        ? project.backdrop
          ? selectedNode
          : null
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
    sketchEditTool: selection.mode === 'sketch_edit' ? selection.sketchEditTool : null,
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
  pendingOffset: null,
  pendingShapeAction: null,
  backdropImageLoading: false,
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
        pendingOffset: null,
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

  setShowFeatureInfo: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          showFeatureInfo: visible,
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

  setSelectedMachineId: (id) =>
    set((s) => {
      const nextId = id && s.project.meta.machineDefinitions.some((definition) => definition.id === id)
        ? id
        : null
      const nextProject = {
        ...s.project,
        meta: { ...s.project.meta, selectedMachineId: nextId, modified: new Date().toISOString() },
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

  addMachineDefinition: (definition) =>
    set((s) => {
      const normalizedDefinition = validateMachineDefinition({
        ...definition,
        builtin: false,
      })
      const machineDefinitions = [
        ...s.project.meta.machineDefinitions.filter((entry) => entry.id !== normalizedDefinition.id),
        normalizedDefinition,
      ]
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          machineDefinitions,
          selectedMachineId: normalizedDefinition.id,
          modified: new Date().toISOString(),
        },
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

  removeMachineDefinition: (id) =>
    set((s) => {
      const definition = s.project.meta.machineDefinitions.find((entry) => entry.id === id)
      if (!definition || definition.builtin) {
        return {}
      }

      const machineDefinitions = s.project.meta.machineDefinitions.filter((entry) => entry.id !== id)
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          machineDefinitions,
          selectedMachineId: s.project.meta.selectedMachineId === id ? null : s.project.meta.selectedMachineId,
          modified: new Date().toISOString(),
        },
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
        pendingOffset: null,
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
        pendingOffset: null,
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
        pendingOffset: null,
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
        pendingOffset: null,
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
        pendingShapeAction: null,
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

  importShapes: (input) => {
    const state = get()
    const sourceShapes = input.shapes.filter((shape) => !isProfileDegenerate(shape.profile))
    if (sourceShapes.length === 0) {
      return []
    }

    const folderId = nextUniqueGeneratedId(state.project, 'fd')
    const folderName = uniqueFolderName(stripFileExtension(input.fileName), state.project.featureFolders)
    const folder: FeatureFolder = {
      id: folderId,
      name: folderName,
      collapsed: false,
    }

    const existingNames = state.project.features.map((feature) => feature.name)
    const createdFeatures: SketchFeature[] = []
    let nextProjectLike: Project = {
      ...state.project,
      features: [...state.project.features],
      featureFolders: [...state.project.featureFolders, folder],
    }

    sourceShapes.forEach((shape, index) => {
      const featureName = uniqueName(
        shape.name || `${input.sourceType.toUpperCase()} ${index + 1}`,
        [...existingNames, ...createdFeatures.map((feature) => feature.name)],
      )
      const isFirstFeature = state.project.features.length === 0 && createdFeatures.length === 0

      const nextId = nextUniqueGeneratedId(nextProjectLike, 'f')
      const feature = normalizeFeatureZRange({
        ...createImportedFeature(shape, state.project, folderId, featureName, isFirstFeature ? 'add' : 'subtract'),
        id: nextId,
      })

      createdFeatures.push(feature)
      nextProjectLike = {
        ...nextProjectLike,
        features: [...nextProjectLike.features, feature],
      }
    })

    if (createdFeatures.length === 0) {
      return []
    }

    set((s) => {
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        featureFolders: [...s.project.featureFolders, folder],
        featureTree: [...s.project.featureTree, { type: 'folder', folderId }],
        features: [...s.project.features, ...createdFeatures],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const primaryId = createdIds.at(-1) ?? null

      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: createdIds,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : { type: 'folder', folderId },
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

    return createdFeatures.map((feature) => feature.id)
  },

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

  mergeSelectedFeatures: (keepOriginals = false) => {
    const state = get()
    const selectedIdSet = new Set(state.selection.selectedFeatureIds)
    const selectedFeatures = state.project.features
      .filter((feature) => selectedIdSet.has(feature.id))
      .filter((feature) => feature.sketch.profile.closed)

    if (selectedFeatures.length < 2) {
      return []
    }

    const anchorFeature = selectedFeatures[0]
    const baseFeature = anchorFeature
    const joinNameStem = normalizeDerivedFeatureNameStem(baseFeature.name)
    const unionPaths = unionClipperPaths(selectedFeatures.map((feature) => flattenFeatureToClipperPath(feature)))
    const createdFeatures = unionPaths
      .map((path, index) => {
        const profile = clipperContourToProfile(path)
        if (!profile) {
          return null
        }
        const nextProject = { ...state.project, features: [...state.project.features] }
        return createDerivedFeature(
          nextProject,
          baseFeature,
          profile,
          baseFeature.operation,
          uniqueName(index === 0 ? `${joinNameStem} Join` : `${joinNameStem} Join ${index + 1}`, [
            ...state.project.features.map((feature) => feature.name),
          ]),
        )
      })
      .filter((feature): feature is SketchFeature => feature !== null)

    if (createdFeatures.length === 0) {
      return []
    }

    set((s) => {
      const idsToReplace = new Set(keepOriginals ? [] : selectedFeatures.map((feature) => feature.id))
      const createdGroups: DerivedFeatureGroup[] = [{ sourceId: anchorFeature.id, features: createdFeatures }]
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: insertDerivedFeaturesAfterSources(s.project.features, createdGroups, idsToReplace),
        featureTree: insertDerivedFeatureTreeEntries(s.project.featureTree, s.project.features, createdGroups, idsToReplace),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const primaryId = createdIds.at(-1) ?? null
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: createdIds,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
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

    return createdFeatures.map((feature) => feature.id)
  },

  cutSelectedFeatures: (keepOriginals = false) => {
    const state = get()
    const selectedFeatures = state.selection.selectedFeatureIds
      .map((featureId) => state.project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)
      .filter((feature) => feature.sketch.profile.closed)

    if (selectedFeatures.length < 2) {
      return []
    }

    const cutter = selectedFeatures[selectedFeatures.length - 1]
    const targets = selectedFeatures.filter((feature) => feature.id !== cutter.id)
    const createdGroups = cutFeaturesByCutterGrouped(state.project, cutter, targets)
    const createdFeatures = createdGroups.flatMap((group) => group.features)

    if (createdFeatures.length === 0) {
      return []
    }

    set((s) => {
      const idsToReplace = new Set(keepOriginals ? [] : targets.map((feature) => feature.id))
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: insertDerivedFeaturesAfterSources(s.project.features, createdGroups, idsToReplace),
        featureTree: insertDerivedFeatureTreeEntries(s.project.featureTree, s.project.features, createdGroups, idsToReplace),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const primaryId = createdIds.at(-1) ?? null
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: createdIds,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
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

    return createdFeatures.map((feature) => feature.id)
  },

  offsetSelectedFeatures: (distance) => {
    const state = get()
    const createdFeatures = previewOffsetFeatures(state.project, state.selection.selectedFeatureIds, distance)

    if (createdFeatures.length === 0) {
      return []
    }

    set((s) => {
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: [...s.project.features, ...createdFeatures],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const primaryId = createdIds.at(-1) ?? null
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: createdIds,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
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

    return createdFeatures.map((feature) => feature.id)
  },

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
    set((s) => {
      const joinMode = s.pendingShapeAction?.kind === 'join'
      const cutMode = s.pendingShapeAction?.kind === 'cut'
      const selectedFeature = id ? s.project.features.find((feature) => feature.id === id) ?? null : null

      if (joinMode) {
        if (selectedFeature && (!selectedFeature.sketch.profile.closed || selectedFeature.locked)) {
          return {}
        }

        const proposedIds =
          !id
            ? []
            : additive
              ? s.selection.selectedFeatureIds.includes(id)
                ? s.selection.selectedFeatureIds.filter((featureId) => featureId !== id)
                : [...s.selection.selectedFeatureIds, id]
              : [id]
        const proposedFeatures = proposedIds
          .map((featureId) => s.project.features.find((feature) => feature.id === featureId) ?? null)
          .filter((feature): feature is SketchFeature => feature !== null)
        const nextIds = featuresFormConnectedOverlapGroup(proposedFeatures)
          ? proposedIds
          : s.selection.selectedFeatureIds
        const nextPrimaryId = nextIds.at(-1) ?? null

        return {
          pendingOffset: null,
          pendingShapeAction: s.pendingShapeAction ? { ...s.pendingShapeAction, entityIds: nextIds } : null,
          selection: {
            ...s.selection,
            selectedFeatureId: nextPrimaryId,
            selectedFeatureIds: nextIds,
            selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
            mode: 'feature',
            activeControl: null,
          },
        }
      }

      if (cutMode) {
        const pendingShapeAction = s.pendingShapeAction
        if (!pendingShapeAction || pendingShapeAction.kind !== 'cut') {
          return {}
        }

        if (selectedFeature && (!selectedFeature.sketch.profile.closed || selectedFeature.locked)) {
          return {}
        }

        if (!id) {
          return {
            pendingOffset: null,
            pendingShapeAction: { ...pendingShapeAction, cutterId: null, targetIds: [] },
            selection: {
              ...s.selection,
              selectedFeatureId: null,
              selectedFeatureIds: [],
              selectedNode: null,
              mode: 'feature',
              activeControl: null,
            },
          }
        }

        if (!pendingShapeAction.cutterId) {
          return {
            pendingOffset: null,
            pendingShapeAction: { ...pendingShapeAction, cutterId: id, targetIds: [] },
            selection: {
              ...s.selection,
              selectedFeatureId: id,
              selectedFeatureIds: [id],
              selectedNode: { type: 'feature', featureId: id },
              mode: 'feature',
              activeControl: null,
            },
          }
        }

        if (id === pendingShapeAction.cutterId) {
          if (additive) {
            return {}
          }
          return {
            pendingOffset: null,
            pendingShapeAction: { ...pendingShapeAction, cutterId: id, targetIds: [] },
            selection: {
              ...s.selection,
              selectedFeatureId: id,
              selectedFeatureIds: [id],
              selectedNode: { type: 'feature', featureId: id },
              mode: 'feature',
              activeControl: null,
            },
          }
        }

        const cutter = s.project.features.find((feature) => feature.id === pendingShapeAction.cutterId) ?? null
        if (!cutter || !selectedFeature || !featuresOverlap(cutter, selectedFeature)) {
          return {}
        }

        const nextTargetIds = additive
          ? pendingShapeAction.targetIds.includes(id)
            ? pendingShapeAction.targetIds.filter((featureId) => featureId !== id)
            : [...pendingShapeAction.targetIds, id]
          : [id]
        const nextSelectedIds = [pendingShapeAction.cutterId, ...nextTargetIds]
        const nextPrimaryId = nextTargetIds.at(-1) ?? pendingShapeAction.cutterId

        return {
          pendingOffset: null,
          pendingShapeAction: { ...pendingShapeAction, targetIds: nextTargetIds },
          selection: {
            ...s.selection,
            selectedFeatureId: nextPrimaryId,
            selectedFeatureIds: nextSelectedIds,
            selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
            mode: 'feature',
            activeControl: null,
          },
        }
      }

      return {
        pendingOffset: null,
        pendingShapeAction: null,
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
      }
    }),

  selectFeatures: (ids) =>
    set((s) => {
      const joinMode = s.pendingShapeAction?.kind === 'join'
      const nextIds = ids.filter((id, index) => {
        const feature = s.project.features.find((entry) => entry.id === id)
        if (!feature || ids.indexOf(id) !== index) {
          return false
        }
        return joinMode ? feature.sketch.profile.closed && !feature.locked : true
      })
      const validJoinIds =
        joinMode
          ? (() => {
              const nextFeatures = nextIds
                .map((id) => s.project.features.find((feature) => feature.id === id) ?? null)
                .filter((feature): feature is SketchFeature => feature !== null)
              return featuresFormConnectedOverlapGroup(nextFeatures)
                ? nextIds
                : s.selection.selectedFeatureIds
            })()
          : nextIds
      const nextPrimaryId = validJoinIds.at(-1) ?? null

      return {
        pendingOffset: null,
        pendingShapeAction: joinMode && s.pendingShapeAction ? { ...s.pendingShapeAction, entityIds: validJoinIds } : null,
        selection: {
          ...s.selection,
          selectedFeatureId: nextPrimaryId,
          selectedFeatureIds: validJoinIds,
          selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
          mode: 'feature',
          activeControl: null,
        },
      }
    }),

  selectProject: () =>
    set((s) => ({
      pendingOffset: null,
      pendingShapeAction: null,
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
      pendingOffset: null,
      pendingShapeAction: null,
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
      pendingOffset: null,
      pendingShapeAction: null,
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
      pendingOffset: null,
      pendingShapeAction: null,
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

  selectBackdrop: () =>
    set((s) => ({
      pendingOffset: null,
      pendingShapeAction: null,
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'backdrop' },
        mode: 'feature',
        activeControl: null,
      },
      sketchEditSession: null,
    })),

  selectFeaturesRoot: () =>
    set((s) => ({
      pendingOffset: null,
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
      pendingOffset: null,
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
      pendingOffset: null,
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
      pendingOffset: null,
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
      pendingOffset: null,
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
      pendingOffset: null,
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
    set((s) => {
      if (s.selection.hoveredFeatureId === id) {
        return {}
      }

      return {
        selection: { ...s.selection, hoveredFeatureId: id },
      }
    }),

  enterSketchEdit: (id) =>
    set((s) => ({
      pendingTransform: null,
      pendingOffset: null,
      selection: {
        ...s.selection,
        selectedFeatureId: id,
        selectedFeatureIds: [id],
        selectedNode: { type: 'feature', featureId: id },
        mode: 'sketch_edit',
        sketchEditTool: null,
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
      pendingOffset: null,
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'clamp', clampId: id },
        mode: 'sketch_edit',
        sketchEditTool: null,
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
      pendingOffset: null,
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'tab', tabId: id },
        mode: 'sketch_edit',
        sketchEditTool: null,
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
      selection: { ...s.selection, mode: 'feature', sketchEditTool: null, activeControl: null },
      sketchEditSession: null,
    })),

  cancelSketchEdit: () =>
    set((s) => {
      if (!s.sketchEditSession) {
        return {
          selection: { ...s.selection, mode: 'feature', sketchEditTool: null, activeControl: null },
          sketchEditSession: null,
        }
      }

      const restored = normalizeProject(cloneProject(s.sketchEditSession.snapshot))
      return {
        project: restored,
        selection: {
          ...sanitizeSelection(restored, s.selection),
          mode: 'feature',
          sketchEditTool: null,
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

  setSketchEditTool: (tool) =>
    set((s) => ({
      selection: {
        ...s.selection,
        sketchEditTool: s.selection.mode === 'sketch_edit' ? tool : null,
        activeControl: null,
      },
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

          const anchorCount = profileVertices(nextProfile).length
          const segmentCount = nextProfile.segments.length
          if (anchorCount === 0) {
            return feature
          }

          if (control.kind === 'anchor') {
            const currentAnchor = anchorPointForIndex(nextProfile, control.index)

            if (!currentAnchor) {
              return feature
            }

            const incomingIndex = nextProfile.closed
              ? (control.index - 1 + segmentCount) % segmentCount
              : control.index > 0
                ? control.index - 1
                : null
            const outgoingIndex = control.index < segmentCount ? control.index : null
            const originalIncoming = incomingIndex !== null ? nextProfile.segments[incomingIndex] : null
            const originalOutgoing = outgoingIndex !== null ? nextProfile.segments[outgoingIndex] : null
            const originalIncomingStart =
              incomingIndex === null
                ? null
                : incomingIndex === 0
                  ? nextProfile.start
                  : nextProfile.segments[incomingIndex - 1]?.to
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
              const closingSegment = nextProfile.closed ? nextProfile.segments[segmentCount - 1] : null
              if (closingSegment) {
                closingSegment.to = point
                if (closingSegment.type === 'bezier') {
                  closingSegment.control2 = translatePoint(closingSegment.control2, dx, dy)
                }
              }
            } else if (control.index === anchorCount - 1 && !nextProfile.closed) {
              nextProfile.segments[segmentCount - 1].to = point
              const incomingSegment = nextProfile.segments[segmentCount - 1]
              if (incomingSegment.type === 'bezier') {
                incomingSegment.control2 = translatePoint(incomingSegment.control2, dx, dy)
              }
            } else if (control.index > 0) {
              nextProfile.segments[control.index - 1].to = point
              const incomingSegment = nextProfile.segments[control.index - 1]
              if (incomingSegment.type === 'bezier') {
                incomingSegment.control2 = translatePoint(incomingSegment.control2, dx, dy)
              }
            }

            const incomingSegment = incomingIndex !== null ? nextProfile.segments[incomingIndex] : null
            if (incomingSegment?.type === 'arc' && incomingArcThrough) {
              const incomingStart =
                incomingIndex === 0
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
              const outgoingStart =
                control.index === 0 ? nextProfile.start : nextProfile.segments[control.index - 1]?.to
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
            kind: inferFeatureKind(normalizedProfile),
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

  insertFeaturePoint: (featureId, target) =>
    set((s) => {
      let changed = false
      const nextProject = {
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
            kind: inferFeatureKind(nextProfile),
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

  deleteFeaturePoint: (featureId, anchorIndex) =>
    set((s) => {
      let changed = false
      const nextProject = {
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
            kind: inferFeatureKind(nextProfile),
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

  filletFeaturePoint: (featureId, anchorIndex, radius) =>
    set((s) => {
      let changed = false
      const nextProject = {
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
            kind: inferFeatureKind(nextProfile),
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
      pendingOffset: null,
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
      pendingOffset: null,
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
      pendingOffset: null,
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
      pendingOffset: null,
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
      pendingOffset: null,
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
      pendingOffset: null,
      sketchEditSession: null,
      selection: {
        ...s.selection,
        mode: 'feature',
        hoveredFeatureId: null,
        activeControl: null,
      },
    })),

  startAddTextPlacement: (config) =>
    set((s) => ({
      pendingAdd: { shape: 'text', config, session: nextPlacementSession() },
      pendingMove: null,
      pendingTransform: null,
      pendingOffset: null,
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

  placePendingTextAt: (point) => {
    const state = get()
    if (state.pendingAdd?.shape !== 'text') {
      return []
    }

    const createdFeature = createTextFeatureAt(state.project, state.pendingAdd.config, point)
    if (!createdFeature) {
      return []
    }

    set((s) => {
      const nextProject = syncFeatureTreeProject({
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
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
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
        pendingOffset: null,
        pendingShapeAction: null,
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
        pendingOffset: null,
        pendingShapeAction: null,
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
        pendingTransform: { mode: 'resize', entityType: 'feature', entityIds: featureIds, referenceStart: null, referenceEnd: null, session: nextPlacementSession() },
        pendingOffset: null,
        pendingShapeAction: null,
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
        pendingTransform: { mode: 'rotate', entityType: 'feature', entityIds: featureIds, referenceStart: null, referenceEnd: null, session: nextPlacementSession() },
        pendingOffset: null,
        pendingShapeAction: null,
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

  startMoveBackdrop: () =>
    set((s) => {
      if (!s.project.backdrop) {
        return {}
      }

      return {
        pendingAdd: null,
        sketchEditSession: null,
        pendingMove: { mode: 'move', entityType: 'backdrop', entityIds: ['backdrop'], fromPoint: null, toPoint: null, session: nextPlacementSession() },
        pendingTransform: null,
        pendingOffset: null,
        pendingShapeAction: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'backdrop' },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  startResizeBackdrop: () =>
    set((s) => {
      if (!s.project.backdrop) {
        return {}
      }

      return {
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: { mode: 'resize', entityType: 'backdrop', entityIds: [], referenceStart: null, referenceEnd: null, session: nextPlacementSession() },
        pendingOffset: null,
        pendingShapeAction: null,
        sketchEditSession: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'backdrop' },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  startRotateBackdrop: () =>
    set((s) => {
      if (!s.project.backdrop) {
        return {}
      }

      return {
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: { mode: 'rotate', entityType: 'backdrop', entityIds: [], referenceStart: null, referenceEnd: null, session: nextPlacementSession() },
        pendingOffset: null,
        pendingShapeAction: null,
        sketchEditSession: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'backdrop' },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  startJoinSelectedFeatures: () =>
    set((s) => {
      const featureIds = selectedClosedFeaturesFromIds(s.project, s.selection.selectedFeatureIds).map((feature) => feature.id)

      return {
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        pendingShapeAction: { kind: 'join', entityIds: featureIds, keepOriginals: false, session: nextPlacementSession() },
        sketchEditSession: null,
        selection: {
          ...s.selection,
          selectedFeatureId: featureIds.at(-1) ?? null,
          selectedFeatureIds: featureIds,
          selectedNode: featureIds.at(-1) ? { type: 'feature', featureId: featureIds.at(-1)! } : null,
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  startCutSelectedFeatures: () =>
    set((s) => {
      return {
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        pendingShapeAction: { kind: 'cut', cutterId: null, targetIds: [], keepOriginals: false, session: nextPlacementSession() },
        sketchEditSession: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: null,
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  startOffsetSelectedFeatures: () =>
    set((s) => {
      const featureIds = s.selection.selectedFeatureIds
      const features = selectedClosedFeaturesFromIds(s.project, featureIds)
      if (features.length === 0 || features.some((feature) => feature.locked || feature.kind === 'text')) {
        return {}
      }

      return {
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingShapeAction: null,
        pendingOffset: { entityIds: featureIds, session: nextPlacementSession() },
        sketchEditSession: null,
        selection: {
          ...s.selection,
          selectedFeatureId: featureIds.at(-1) ?? null,
          selectedFeatureIds: featureIds,
          selectedNode: featureIds.at(-1) ? { type: 'feature', featureId: featureIds.at(-1)! } : null,
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
        pendingOffset: null,
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
        pendingOffset: null,
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
        pendingOffset: null,
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
        pendingOffset: null,
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

  cancelPendingShapeAction: () => set({ pendingShapeAction: null }),

  setPendingShapeActionKeepOriginals: (keepOriginals) =>
    set((s) => ({
      pendingShapeAction: s.pendingShapeAction ? { ...s.pendingShapeAction, keepOriginals } : null,
    })),

  cancelPendingOffset: () => set({ pendingOffset: null }),

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
      if (entityType === 'backdrop') {
        if (!s.project.backdrop || mode !== 'move') {
          return { pendingMove: null }
        }

        const nextProject = {
          ...s.project,
          backdrop: {
            ...s.project.backdrop,
            center: {
              x: s.project.backdrop.center.x + dx,
              y: s.project.backdrop.center.y + dy,
            },
          },
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }

        if (projectsEqual(nextProject, s.project)) {
          return { pendingMove: null }
        }

        return {
          project: nextProject,
          pendingMove: null,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }

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

      if (pendingTransform.entityType === 'backdrop') {
        if (!s.project.backdrop) {
          return { pendingTransform: null }
        }

        const nextBackdrop =
          pendingTransform.mode === 'resize'
            ? resizeBackdropFromReference(s.project.backdrop, pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
            : rotateBackdropFromReference(s.project.backdrop, pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)

        if (!nextBackdrop) {
          return { pendingTransform: null }
        }

        const nextProject = {
          ...s.project,
          backdrop: nextBackdrop,
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

  completePendingOffset: (distance) => {
    const state = get()
    if (!state.pendingOffset) {
      return []
    }

    const createdFeatures = previewOffsetFeatures(state.project, state.pendingOffset.entityIds, distance)
    if (createdFeatures.length === 0) {
      set({ pendingOffset: null })
      return []
    }

    set((s) => {
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: [...s.project.features, ...createdFeatures],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const primaryId = createdIds.at(-1) ?? null
      return {
        project: nextProject,
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: createdIds,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
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

    return createdFeatures.map((feature) => feature.id)
  },

  completePendingShapeAction: () => {
    const state = get()
    const pendingShapeAction = state.pendingShapeAction
    if (!pendingShapeAction) {
      return []
    }

    if (pendingShapeAction.kind === 'join') {
      if (pendingShapeAction.entityIds.length < 2) {
        return []
      }

      state.selectFeatures(pendingShapeAction.entityIds)
      const result = get().mergeSelectedFeatures(pendingShapeAction.keepOriginals)
      set({ pendingShapeAction: null })
      return result
    }

    if (!pendingShapeAction.cutterId || pendingShapeAction.targetIds.length === 0) {
      return []
    }

    const cutter = state.project.features.find((feature) => feature.id === pendingShapeAction.cutterId) ?? null
    const targets = pendingShapeAction.targetIds
      .map((featureId) => state.project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)
      .filter((feature) => feature.sketch.profile.closed)
    if (!cutter || !cutter.sketch.profile.closed || targets.length !== pendingShapeAction.targetIds.length) {
      return []
    }

    const createdGroups = cutFeaturesByCutterGrouped(state.project, cutter, targets)
    const createdFeatures = createdGroups.flatMap((group) => group.features)
    if (createdFeatures.length === 0) {
      set({ pendingShapeAction: null })
      return []
    }

    set((s) => {
      const idsToReplace = new Set(
        pendingShapeAction.keepOriginals
          ? []
          : pendingShapeAction.targetIds,
      )
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: insertDerivedFeaturesAfterSources(s.project.features, createdGroups, idsToReplace),
        featureTree: insertDerivedFeatureTreeEntries(s.project.featureTree, s.project.features, createdGroups, idsToReplace),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const primaryId = createdIds.at(-1) ?? null
      return {
        project: nextProject,
        pendingShapeAction: null,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: createdIds,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
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

    return createdFeatures.map((feature) => feature.id)
  },

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
