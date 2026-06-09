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

import type { ImportedShape, ImportSourceType } from '../import'
import type { MachineDefinition } from '../engine/gcode/types'
import type { SnapMode } from '../sketch/snapping'
import type {
  BackdropImage,
  Clamp,
  DimensionAnchor,
  DimensionAnnotation,
  DimensionType,
  FeatureFolder,
  FeatureTreeEntry,
  GridSettings,
  Operation,
  OperationKind,
  OperationPass,
  OperationTarget,
  Point,
  Project,
  Segment,
  SketchFeature,
  Stock,
  Tab,
  Tool,
} from '../types/project'
import type { TextToolConfig } from '../text'
import type { ToolLibraryEntry } from '../toolLibrary'

export type SelectionMode = 'feature' | 'sketch_edit'

export interface SelectionState {
  mode: SelectionMode
  selectedFeatureId: string | null
  selectedFeatureIds: string[]
  selectedNode: SelectedNode
  hoveredFeatureId: string | null
  sketchEditTool: SketchEditTool | null
  activeControl: SketchControlRef | null
}

export interface SketchControlRef {
  kind: 'anchor' | 'in_handle' | 'out_handle' | 'arc_handle' | 'segment' | 'circle_center'
  index: number
  t?: number
}

export type SketchEditTool = 'add_point' | 'delete_point' | 'delete_segment' | 'disconnect' | 'fillet'
export type OpenProfileEndpoint = 'start' | 'end'

export type FeatureAlignment =
  | 'left'
  | 'center_horizontal'
  | 'right'
  | 'top'
  | 'center_vertical'
  | 'bottom'

export type FeatureDistribution =
  | 'horizontal_gaps'
  | 'horizontal_centers'
  | 'vertical_gaps'
  | 'vertical_centers'

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
  | { type: 'regions_root' }
  | { type: 'tabs_root' }
  | { type: 'clamps_root' }
  | { type: 'folder'; folderId: string }
  | { type: 'feature'; featureId: string }
  | { type: 'tab'; tabId: string }
  | { type: 'clamp'; clampId: string }
  | null

export type PendingAddTool =
  | { shape: 'origin'; session: number }
  | { shape: 'rect'; anchor: Point | null; session: number }
  | { shape: 'circle'; anchor: Point | null; session: number }
  | { shape: 'ellipse'; anchor: Point | null; session: number }
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
export type CreationTarget = 'feature' | 'region'

/**
 * Transient tape-measure state. Not persisted, not in undo history.
 * `first` is the anchored start of an in-progress measurement; `frozen` is the
 * last completed A→B measurement, shown until the next click starts a new one.
 */
export interface TapeMeasureState {
  first: Point | null
  frozen: { a: Point; b: Point } | null
}

/**
 * Transient permanent-dimension placement tool. Anchors accumulate as the user
 * clicks (a, then b, then c for angles); the canvas then enters an offset-pick
 * phase and commits via `addDimensionAnnotation`. Not in undo history.
 */
export interface PendingDimensionTool {
  type: DimensionType
  a: DimensionAnchor | null
  b: DimensionAnchor | null
  c: DimensionAnchor | null
  session: number
}

export interface PendingMoveTool {
  mode: 'move' | 'copy'
  entityType: 'feature' | 'clamp' | 'tab' | 'backdrop'
  entityIds: string[]
  fromPoint: Point | null
  toPoint: Point | null
  session: number
}

export interface PendingTransformTool {
  mode: 'resize' | 'rotate' | 'mirror'
  entityType: 'feature' | 'backdrop'
  entityIds: string[]
  referenceStart: Point | null
  referenceEnd: Point | null
  keepOriginals: boolean
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
      cutterIds: string[]
      targetIds: string[]
      phase: 'cutters' | 'targets'
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

export interface PendingConstraint {
  featureId: string
  anchor: {
    point: Point
    snapMode: SnapMode | null
  } | null
  reference: {
    point: Point
    featureId: string | null
    snapMode: SnapMode | null
    segment?: { a: Point; b: Point }
  } | null
  session: number
}

export interface ProjectStore {
  project: Project
  selection: SelectionState
  creationTarget: CreationTarget
  pendingAdd: PendingAddTool | null
  pendingMove: PendingMoveTool | null
  pendingTransform: PendingTransformTool | null
  pendingOffset: PendingOffsetTool | null
  pendingShapeAction: PendingShapeActionTool | null
  backdropImageLoading: boolean
  sketchEditSession: SketchEditSession | null
  pendingConstraint: PendingConstraint | null
  // ---- Measure & dimensions (transient tool state, not persisted) ----
  tapeMeasure: TapeMeasureState | null
  pendingDimension: PendingDimensionTool | null
  /** When true, the next canvas click on a dimension deletes it. */
  dimensionDeleteArmed: boolean
  /** Currently selected dimension annotation, or null. Not in undo history. */
  selectedAnnotationId: string | null
  history: ProjectHistory

  // ---- Session state (not persisted in .camj) ----
  /** True while a project file is being parsed and loaded. */
  projectLoading: boolean
  /** Incremented each time a new project is created or loaded. Used by viewports to reset their view state. */
  projectKey: number
  /** Filesystem path of the currently open file. Null in the browser or when no file is open. */
  filePath: string | null
  /** Path of the most recent G-code export. Null until first export this session. */
  lastExportPath: string | null
  /** Path of the most recent 3D model export. Null until first export this session. */
  lastModelExportPath: string | null
  /** True when the project has unsaved changes. */
  dirty: boolean

  createNewProject: (template?: Project, name?: string) => void
  setProjectName: (name: string) => void
  setShowFeatureInfo: (visible: boolean) => void
  setShowDimensions: (visible: boolean) => void
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
  refreshMachineDefinitions: () => void
  loadProject: (p: Project) => void
  saveProject: () => string
  /** Called after a successful open — records the file path and clears the session. */
  openProjectFromText: (content: string, path: string | null) => void
  /** Called after a successful save — records the path that was written to. */
  markSaved: (path: string | null) => void
  /** Called after a successful G-code export — records the export path. */
  markExported: (path: string) => void
  /** Called after a successful 3D model export — records the export path. */
  markModelExported: (path: string) => void
  undo: () => void
  redo: () => void
  beginHistoryTransaction: () => void
  commitHistoryTransaction: () => void
  cancelHistoryTransaction: () => void

  // ---- Measure & dimensions ----
  /** Persistent dimension annotation actions (history-tracked). */
  addDimensionAnnotation: (annotation: Omit<DimensionAnnotation, 'id'>) => string
  updateDimensionAnnotation: (id: string, patch: Partial<DimensionAnnotation>) => void
  deleteDimensionAnnotation: (id: string) => void
  selectAnnotation: (id: string | null) => void
  /** Transient tape-measure tool. */
  startTapeMeasure: () => void
  tapeMeasureClick: (point: Point) => void
  clearTapeMeasure: () => void
  /** Transient permanent-dimension placement tool. */
  startDimensionTool: (type: DimensionType) => void
  setPendingDimensionType: (type: DimensionType) => void
  pendingDimensionPick: (anchor: DimensionAnchor) => void
  cancelPendingDimension: () => void
  /** Transient "click a dimension to delete it" mode. */
  setDimensionDeleteArmed: (armed: boolean) => void

  setStock: (stock: Stock) => void
  setStockSourceFeature: (featureId: string | null) => void
  enterStockSketchEdit: (featureId: string) => void
  setGrid: (grid: GridSettings) => void
  setUnits: (units: Project['meta']['units']) => void
  setCreationTarget: (target: CreationTarget) => void

  addFeatureFolder: (section?: 'features' | 'regions') => string
  updateFeatureFolder: (id: string, patch: Partial<FeatureFolder>) => void
  deleteFeatureFolder: (id: string) => void
  assignFeaturesToFolder: (featureIds: string[], folderId: string | null) => void
  moveFeatureTreeFeature: (featureId: string, folderId: string | null, beforeFeatureId?: string | null) => void
  reorderFeatureTreeEntries: (entries: FeatureTreeEntry[]) => void
  setAllFeaturesVisible: (visible: boolean) => void
  setAllRegionsVisible: (visible: boolean) => void
  toggleFolderVisible: (folderId: string) => void
  toggleRegionFolderVisible: (folderId: string) => void
  selectFolderFeatures: (folderId: string) => void
  addFeature: (feature: SketchFeature) => void
  importShapes: (input: { fileName: string; sourceType: ImportSourceType; shapes: ImportedShape[] }) => string[]
  importCamjFolders: (input: { fileName: string; sourceProject: Project; selectedFolderIds: string[]; importStock?: boolean }) => string[]
  updateFeature: (id: string, patch: Partial<SketchFeature>) => void
  updateFeatures: (ids: string[], patch: Partial<SketchFeature>) => void
  deleteFeature: (id: string) => void
  deleteFeatures: (ids: string[]) => void
  mergeSelectedFeatures: (keepOriginals?: boolean) => string[]
  cutSelectedFeatures: (keepOriginals?: boolean) => string[]
  offsetSelectedFeatures: (distance: number) => string[]
  reorderFeatures: (ids: string[]) => void
  alignFeatures: (ids: string[], alignment: FeatureAlignment) => void
  distributeFeatures: (ids: string[], distribution: FeatureDistribution) => void

  addClamp: () => string
  updateClamp: (id: string, patch: Partial<Clamp>) => void
  deleteClamp: (id: string) => void
  setAllClampsVisible: (visible: boolean) => void
  startAddClampPlacement: () => void
  startMoveClamp: (clampId: string) => void
  startCopyClamp: (clampId: string) => void
  duplicateClamp: (id: string) => string | null

  enterTabEdit: (id: string) => void
  moveTabControl: (tabId: string, control: SketchControlRef, point: Point) => void
  updateTab: (id: string, patch: Partial<Tab>) => void
  deleteTab: (id: string) => void
  setAllTabsVisible: (visible: boolean) => void
  startAddTabPlacement: () => void
  startMoveTab: (tabId: string) => void
  startCopyTab: (tabId: string) => void
  autoPlaceTabsForOperation: (operationId: string) => void

  addTool: () => string
  importTools: (tools: Array<Omit<Tool, 'id'>>) => string[]
  updateTool: (id: string, patch: Partial<Tool>) => void
  deleteTool: (id: string) => void
  duplicateTool: (id: string) => string | null

  addOperation: (
    kind: OperationKind,
    pass: OperationPass,
    target: OperationTarget,
    libraryTools?: ToolLibraryEntry[],
  ) => string | null
  updateOperation: (id: string, patch: Partial<Operation>) => void
  createRestOperation: (operationId: string) => { operationId: string | null; regionIds: string[]; warnings: string[] }
  setAllOperationToolpathVisibility: (visible: boolean) => void
  deleteOperation: (id: string) => void
  duplicateOperation: (id: string) => string | null
  reorderOperations: (ids: string[]) => void

  selectFeature: (id: string | null, additive?: boolean) => void
  selectFeatures: (ids: string[]) => void
  selectProject: () => void
  selectGrid: () => void
  selectStock: () => void
  selectOrigin: () => void
  selectBackdrop: () => void
  selectFeaturesRoot: () => void
  selectRegionsRoot: () => void
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
  joinOpenFeatureEndpoints: (
    featureId: string,
    endpoint: OpenProfileEndpoint,
    targetFeatureId: string,
    targetEndpoint: OpenProfileEndpoint,
  ) => boolean
  deleteFeaturePoint: (featureId: string, anchorIndex: number) => void
  deleteFeatureSegment: (featureId: string, segmentIndex: number) => void
  disconnectFeaturePoint: (featureId: string, anchorIndex: number) => void
  filletFeaturePoint: (featureId: string, anchorIndex: number, radius: number) => void
  moveClampControl: (clampId: string, control: SketchControlRef, point: Point) => void

  startAddRectPlacement: () => void
  startAddCirclePlacement: () => void
  startAddEllipsePlacement: () => void
  startAddPolygonPlacement: () => void
  startAddSplinePlacement: () => void
  startAddCompositePlacement: () => void
  startAddTextPlacement: (config: TextToolConfig) => void
  cancelPendingAdd: () => void
  setPendingAddAnchor: (point: Point) => void
  placePendingAddAt: (point: Point) => void
  placePendingTextAt: (point: Point) => string[]
  addPendingPolygonPoint: (point: Point) => void
  undoPendingPolygonPoint: () => void
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
  startMirrorFeature: (featureId: string) => void
  startMoveBackdrop: () => void
  startResizeBackdrop: () => void
  startRotateBackdrop: () => void
  startJoinSelectedFeatures: () => void
  startCutSelectedFeatures: () => void
  cancelPendingShapeAction: () => void
  confirmCutCutters: () => void
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
  setPendingTransformKeepOriginals: (keepOriginals: boolean) => void
  completePendingTransform: (previewPoint: Point, copyCount?: number) => void

  addRectFeature: (name: string, x: number, y: number, w: number, h: number, depth: number) => void
  addCircleFeature: (name: string, cx: number, cy: number, r: number, depth: number) => void
  addEllipseFeature: (name: string, cx: number, cy: number, rx: number, ry: number, depth: number) => void
  addPolygonFeature: (name: string, points: Point[], depth: number) => void
  addSplineFeature: (name: string, points: Point[], depth: number) => void

  beginConstraint: (featureId: string) => void
  setConstraintAnchor: (anchor: { point: Point; snapMode: SnapMode | null }) => void
  setConstraintReference: (reference: { point: Point; featureId: string | null; snapMode: SnapMode | null; segment?: { a: Point; b: Point } }) => void
  commitConstraintDistance: (distance: number) => void
  cancelPendingConstraint: () => void
  deleteConstraint: (featureId: string, constraintId: string) => void
  updateConstraintValue: (featureId: string, constraintId: string, newValue: number) => void
}
