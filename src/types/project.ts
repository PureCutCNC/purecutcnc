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

import type { MachineDefinition } from '../engine/gcode/types'
import { copyBundledDefinitions } from '../engine/gcode/definitions'
import type { SnapMode } from '../sketch/snapping'

// ============================================================
// Core geometry primitives
// ============================================================

export interface Point {
  x: number
  y: number
}

export interface LineSegment {
  type: 'line'
  to: Point
}

export interface ArcSegment {
  type: 'arc'
  to: Point
  center: Point
  clockwise: boolean
}

export interface BezierSegment {
  type: 'bezier'
  to: Point
  control1: Point
  control2: Point
}

export type CircleSegment = {
  type: 'circle'
  center: Point
  to: Point
  clockwise: boolean
}

export type Segment = LineSegment | ArcSegment | BezierSegment | CircleSegment

export interface SketchProfile {
  start: Point
  segments: Segment[]
  closed: boolean
}

// ============================================================
// Dimensions (parametric)
// ============================================================

// A DimensionRef is either a literal number or a named dimension key
export type DimensionRef = number | string

export interface NamedDimension {
  id: string
  name: string
  value: number
  formula: string | null   // e.g. "stock_thickness - 3"
}

// ============================================================
// Dimension annotations (measure / drawing dimensions)
//
// These are *drawing* annotations (distances, radii, angles) shown on the
// sketch canvas. They are inert: toolpaths, G-code, CSG and simulation ignore
// them. Distinct from `Project.dimensions` (parametric NamedDimension values
// that drive feature Z-depths). A dimension never stores its measured value —
// the value is recomputed live from its anchors so it follows geometry edits.
// ============================================================

// What a non-free anchor points at. v1: features + stock + machine origin.
export type AnchorTarget =
  | { source: 'feature'; featureId: string }
  | { source: 'stock' }

export interface ConstraintSegmentReference {
  target: AnchorTarget
  segmentIndex: number
}

export interface ConstraintIntersectionReference {
  a: ConstraintSegmentReference
  b: ConstraintSegmentReference
}

// A reference to a live point in the scene. Resolves to a world Point each frame.
export type DimensionAnchor =
  | { kind: 'free'; point: Point }                                  // unattached, fixed world point
  | { kind: 'vertex'; target: AnchorTarget; vertexIndex: number }   // profile vertex (profileVertices order)
  | { kind: 'midpoint'; target: AnchorTarget; segmentIndex: number }
  | { kind: 'center'; target: AnchorTarget; segmentIndex: number }  // arc / circle centre
  // Point on an arc/circle boundary identified by an angle (radians) relative
  // to the segment's radius-handle direction. Lets a radius/diameter dimension
  // keep its drawn direction when the feature moves, rotates, or resizes.
  | { kind: 'circleEdge'; target: AnchorTarget; segmentIndex: number; relativeAngle: number }
  // Point along a straight segment at parameter t∈[0,1]. Lets a line-snap edge
  // pick on a line segment follow the feature instead of staying frozen in
  // world space (e.g. angle dimensions whose rays land on a rectangle edge).
  | { kind: 'segmentPoint'; target: AnchorTarget; segmentIndex: number; t: number }
  | { kind: 'origin' }                                              // machine origin

export type DimensionType =
  | 'aligned'     // true distance, dimension line parallel to the two points
  | 'horizontal'  // |Δx| between two points
  | 'vertical'    // |Δy| between two points
  | 'radius'      // R of an arc/circle (anchor a = center, anchor b = edge)
  | 'diameter'    // Ø of an arc/circle
  | 'angle'       // angle at vertex a between rays to b and c

export interface DimensionAnnotation {
  id: string                    // 'dim0001'
  type: DimensionType
  a: DimensionAnchor            // primary anchor (linear start / arc center / angle vertex)
  b?: DimensionAnchor           // second anchor (linear end / arc edge / angle ray-1)
  c?: DimensionAnchor           // third anchor (angle ray-2)
  offset: number                // perpendicular distance of the dimension line from the
                                // measured points (world units); sign chooses the side
  labelOffset?: number          // optional slide of the label along the dimension line (world units)
  textOverride?: string | null  // optional manual label text (value still computed for tooltip)
  precisionOverride?: number | null
  visible: boolean
  locked: boolean
}

// ============================================================
// Constraints
// ============================================================

export type LocalConstraintType =
  | 'horizontal'
  | 'vertical'
  | 'equal_length'
  | 'equal_radius'
  | 'tangent'
  | 'fixed_distance'
  | 'fixed_angle'
  | 'fixed_radius'

export type GlobalConstraintType =
  | 'concentric'
  | 'equal_spacing'
  | 'symmetric'
  | 'coincident_edge'

export interface LocalConstraint {
  id: string
  type: LocalConstraintType
  segment_ids: string[]
  value?: number
  anchor_point?: Point
  reference_point?: Point
  reference_segment?: {
    a: Point
    b: Point
  }

  // Semantic index references (source of truth when present)
  anchor_index?: number          // vertex index, or -1 for natural center
  anchor_type?: 'anchor' | 'midpoint'
  reference_feature_id?: string  // mirrors segment_ids[0]
  reference_index?: number       // vertex/segment index, or -1 for natural center
  reference_type?: 'anchor' | 'midpoint' | 'segment' | 'point_on_segment' | 'intersection'
  reference_t?: number  // fractional position [0,1] along segment for 'point_on_segment'
  reference_snap_mode?: SnapMode // original picked snap mode for UI display
  reference_intersection?: ConstraintIntersectionReference

  // Validity
  is_invalid?: boolean
  error_message?: string
}

export interface GlobalConstraint {
  id: string
  type: GlobalConstraintType
  feature_ids: string[]
  value?: number
}

// ============================================================
// Sketch — embedded in each feature
// ============================================================

export interface Sketch {
  profile: SketchProfile
  origin: Point               // position on stock
  orientationAngle: number    // local +Y axis angle in degrees, relative to project +X
  dimensions: LocalDimension[]
  constraints: LocalConstraint[]
}

export interface LocalDimension {
  id: string
  type: 'distance' | 'radius' | 'angle'
  value: number
  name?: string
  segment_ids: string[]
}

// ============================================================
// Feature — core building block
// ============================================================

export type FeatureOperation = 'add' | 'subtract' | 'region' | 'model' | 'line' | 'construction'
export type RegionMaskMode = 'include' | 'exclude'
export type TextFontStyle = 'skeleton' | 'outline'
export type TextFontId =
  | 'simple_stroke'
  | 'simple_stroke_italic'
  | 'simple_stroke_condensed'
  | 'simple_stroke_condensed_italic'
  | 'helvetiker_regular'
  | 'helvetiker_bold'
  | 'helvetiker_regular_italic'
  | 'helvetiker_bold_italic'
  | 'helvetiker_regular_condensed'
  | 'helvetiker_bold_condensed'
  | 'helvetiker_regular_condensed_italic'
  | 'helvetiker_bold_condensed_italic'
  | 'optimer_regular'
  | 'optimer_bold'
  | 'optimer_regular_italic'
  | 'optimer_bold_italic'
  | 'gentilis_regular'
  | 'gentilis_bold'
  | 'gentilis_regular_italic'
  | 'gentilis_bold_italic'
  | 'droid_sans_regular'
  | 'droid_sans_bold'
  | 'droid_sans_mono_regular'
  | 'droid_sans_regular_italic'
  | 'droid_sans_bold_italic'
  | 'droid_sans_mono_regular_italic'
  | 'droid_serif_regular'
  | 'droid_serif_bold'
  | 'droid_serif_regular_italic'
  | 'droid_serif_bold_italic'
export type FeatureKind = 'rect' | 'circle' | 'ellipse' | 'polygon' | 'spline' | 'composite' | 'text' | 'stl'

export interface TextFeatureData {
  text: string
  style: TextFontStyle
  fontId: TextFontId
  size: number
}

export type ImportedModelSourceFormat = 'stl' | 'obj'

export interface PersistedImportedMeshBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

export interface PersistedImportedMesh {
  storage: 'mesh-v1'
  sourceFormat?: ImportedModelSourceFormat
  vertexCount: number
  triangleCount: number
  positions: string // base64 Float32Array bytes
  indices: string // base64 Uint32Array bytes
  bounds: PersistedImportedMeshBounds
}

export interface STLFeatureData {
  /** Imported model file format. Missing means legacy STL. */
  format?: ImportedModelSourceFormat
  filePath?: string
  /** Project modelAssets key. Preferred persisted representation for imported models. */
  meshAssetId?: string
  /** Transient/import migration mesh. Normalization moves this into Project.modelAssets. */
  mesh?: PersistedImportedMesh
  /** Legacy embedded source file. New imports should not write this field. */
  fileData?: string // base64
  scale: number
  axisSwap?: 'none' | 'yz' | 'xz' | 'xy'
  /** Legacy imported silhouette PNG. New imports store only topViewDataUrl. */
  silhouetteDataUrl?: string
  /** Project-coordinate projected model silhouette paths. The first/largest path is mirrored in sketch.profile for legacy tools. */
  silhouettePaths?: Point[][]
  topViewDataUrl?: string // pre-rendered top-down model image for sketch view
}


export interface SketchFeature {
  id: string
  name: string
  kind: FeatureKind
  text?: TextFeatureData | null
  stl?: STLFeatureData | null
  folderId: string | null
  sketch: Sketch
  operation: FeatureOperation
  regionMaskMode?: RegionMaskMode
  z_top: DimensionRef
  z_bottom: DimensionRef
  visible: boolean
  locked: boolean
}

// ============================================================
// Feature References — definition / instance split
// ============================================================

/** 2D affine matrix (a,b,c,d,e,f) representing the instance transform. */
export interface Matrix2D {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/** Identity matrix — definition-local geometry maps 1:1 into world space. */
export const IDENTITY_MATRIX: Matrix2D = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
}

/**
 * Shared, canonical feature definition.
 * One definition may be referenced by many FeatureInstances.
 */
export interface FeatureDefinition {
  id: string
  kind: FeatureKind
  profile: SketchProfile
  dimensions: LocalDimension[]
  text?: TextFeatureData | null
  stl?: STLFeatureData | null
  operation: FeatureOperation
  regionMaskMode?: RegionMaskMode
}

/**
 * A placed copy of a {@link FeatureDefinition}. Every feature tree row is an instance.
 */
export interface FeatureInstance {
  id: string
  name: string
  definitionId: string
  transform: Matrix2D
  constraints: LocalConstraint[]
  z_top: DimensionRef
  z_bottom: DimensionRef
  folderId: string | null
  visible: boolean
  locked: boolean
}

export interface FeatureFolder {
  id: string
  name: string
  collapsed: boolean
  section?: 'features' | 'regions' | 'construction'
  grouped?: boolean
}

export type FeatureTreeEntry =
  | { type: 'folder'; folderId: string }
  | { type: 'feature'; featureId: string }

// ============================================================
// Stock
// ============================================================

export interface Stock {
  // Stock boundary is also a profile (defaults to rectangle)
  profile: SketchProfile
  thickness: number           // Z height of stock block
  material: string            // e.g. "aluminum_6061"
  color: string
  visible: boolean
  origin: Point               // machine coordinate of stock corner
  /** When set, stock is derived from a feature. Feature is removed from features array and stored here. */
  sourceFeatureId?: string | null
  /** Lightweight source instance retained while the stock source is out of the feature tree. */
  sourceFeature?: FeatureInstance | null
}

export interface GridSettings {
  extent: number
  majorSpacing: number
  minorSpacing: number
  snapEnabled: boolean
  snapIncrement: number
  visible: boolean
}

// ============================================================
// Tools
// ============================================================

export type ToolType = 'flat_endmill' | 'ball_endmill' | 'v_bit' | 'drill'

export interface Tool {
  id: string
  name: string
  units: ProjectMeta['units']
  type: ToolType
  diameter: number
  vBitAngle: number | null
  flutes: number
  material: 'hss' | 'carbide'
  defaultRpm: number
  defaultFeed: number
  defaultPlungeFeed: number
  defaultStepdown: number
  defaultStepover: number
  maxCutDepth: number
}

// ============================================================
// Machining operations (Phase 3: schema and editing only)
// ============================================================

export type OperationKind =
  | 'pocket'
  | 'v_carve'
  | 'v_carve_medial'
  | 'edge_route_inside'
  | 'edge_route_outside'
  | 'surface_clean'
  | 'rough_surface'
  | 'finish_surface'
  | 'finish_surface_cleanup'
  | 'follow_line'
  | 'drilling'

export type OperationPass = 'rough' | 'finish'
export type PocketPattern = 'offset' | 'parallel' | 'waterline'
export type CutDirection = 'conventional' | 'climb'
export type DrillType = 'simple' | 'peck' | 'dwell' | 'chip_breaking'
export type MachiningOrder = 'level_first' | 'feature_first'

export type OperationTarget =
  | { source: 'features'; featureIds: string[] }
  | { source: 'stock' }

export interface Operation {
  id: string
  name: string
  description?: string
  kind: OperationKind
  pass: OperationPass
  enabled: boolean
  showToolpath: boolean
  debugToolpath: boolean
  target: OperationTarget
  toolRef: string | null
  stepdown: number
  stepover: number
  feed: number
  plungeFeed: number
  rpm: number
  pocketPattern: PocketPattern
  pocketAngle: number
  /** Feed percentage (1-100) applied to fully engaged (slotting) pocket cuts:
   *  each section's innermost offset loop, ring segments crossing uncleared
   *  pinch corridors, the parallel boundary pass and first fill line, and the
   *  first finish-floor cut. Undefined or 100 disables the reduction. */
  pocketSlotFeedPercent?: number
  roundOutsideCorners?: boolean
  stockToLeaveRadial: number
  stockToLeaveAxial: number
  finishWalls: boolean
  finishFloor: boolean
  carveDepth: number
  maxCarveDepth: number
  cutDirection?: CutDirection
  machiningOrder?: MachiningOrder
  drillType?: DrillType
  peckDepth?: number
  dwellTime?: number
  retractHeight?: number
  debugShowRejectedCorners?: boolean
  waterlineAdaptiveRefinement?: boolean
  waterlineMicroStepover?: number
  waterlineRefinementThreshold?: number
  waterlineMaxRingsPerBand?: number
  waterlineTipStepdown?: number
  /** When true, the postprocessor may replace nearly-colinear linear moves
   *  with G2/G3 arc moves. This is an export-only preference — it does not
   *  affect the displayed or simulated toolpath. */
  arcFittingEnabled?: boolean
}

// ============================================================
// Clamps
// ============================================================

export type ClampType = 'step_clamp' | 'toe_clamp' | 'vacuum_zone' | 'vise_jaw'

export interface Clamp {
  id: string
  name: string
  type: ClampType
  x: number
  y: number
  w: number
  h: number
  height: number   // physical height — used for collision detection
  visible: boolean
}

// ============================================================
// Tabs
// ============================================================

export interface Tab {
  id: string
  name: string
  x: number
  y: number
  w: number
  h: number
  z_top: number
  z_bottom: number
  visible: boolean
}

// ============================================================
// Backdrop
// ============================================================

export interface BackdropImage {
  name: string
  mimeType: string
  imageDataUrl: string
  intrinsicWidth: number
  intrinsicHeight: number
  center: Point
  width: number
  height: number
  orientationAngle: number
  opacity: number
  visible: boolean
}

// ============================================================
// Project — top-level .camj document
// ============================================================

export interface ProjectMeta {
  name: string
  created: string    // ISO 8601
  modified: string
  units: 'mm' | 'inch'
  showFeatureInfo: boolean
  showDimensions: boolean
  /** Default copy mode for Duplicate gesture and Copy/Paste. */
  copyMode: 'reference' | 'independent'
  maxTravelZ: number
  operationClearanceZ: number
  clampClearanceXY: number
  clampClearanceZ: number
  machineDefinitions: MachineDefinition[]
  selectedMachineId: string | null
}

export interface MachineOrigin {
  name: string
  x: number
  y: number
  z: number
  visible: boolean
}

export interface Project {
  /** Schema version. '3.0' makes lightweight definition-backed instances authoritative. */
  version: '1.0' | '2.0' | '2.1' | '3.0'
  meta: ProjectMeta
  grid: GridSettings
  stock: Stock
  origin: MachineOrigin
  backdrop: BackdropImage | null
  dimensions: Record<string, NamedDimension>
  annotations: DimensionAnnotation[]
  modelAssets: Record<string, PersistedImportedMesh>
  /** Feature definitions — the sole owner of feature shape and machining role data. */
  featureDefinitions: Record<string, FeatureDefinition>
  /** Lightweight feature-tree instances. World geometry is derived through the resolver. */
  features: FeatureInstance[]
  featureFolders: FeatureFolder[]
  featureTree: FeatureTreeEntry[]
  global_constraints: GlobalConstraint[]
  tools: Tool[]
  operations: Operation[]
  tabs: Tab[]
  clamps: Clamp[]
  ai_history: AIMessage[]
}

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string
}

// ============================================================
// Helpers — profile constructors
// ============================================================

export function rectProfile(x: number, y: number, w: number, h: number): SketchProfile {
  return {
    start: { x, y },
    segments: [
      { type: 'line', to: { x: x + w, y } },
      { type: 'line', to: { x: x + w, y: y + h } },
      { type: 'line', to: { x, y: y + h } },
      { type: 'line', to: { x, y } },
    ],
    closed: true,
  }
}

export function circleProfile(cx: number, cy: number, r: number): SketchProfile {
  const start = { x: cx + r, y: cy }
  return {
    start,
    segments: [
      { type: 'circle', center: { x: cx, y: cy }, to: start, clockwise: true },
    ],
    closed: true,
  }
}

// κ ≈ 0.5523 — standard cubic bezier approximation of a quarter-ellipse
const KAPPA = 0.5523

export function ellipseProfile(cx: number, cy: number, rx: number, ry: number): SketchProfile {
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  // Start at rightmost point, go clockwise (screen coords: +Y down)
  const p0 = { x: cx + rx, y: cy }
  const p1 = { x: cx, y: cy + ry }
  const p2 = { x: cx - rx, y: cy }
  const p3 = { x: cx, y: cy - ry }
  return {
    start: p0,
    segments: [
      { type: 'bezier', control1: { x: cx + rx, y: cy + ky }, control2: { x: cx + kx, y: cy + ry }, to: p1 },
      { type: 'bezier', control1: { x: cx - kx, y: cy + ry }, control2: { x: cx - rx, y: cy + ky }, to: p2 },
      { type: 'bezier', control1: { x: cx - rx, y: cy - ky }, control2: { x: cx - kx, y: cy - ry }, to: p3 },
      { type: 'bezier', control1: { x: cx + kx, y: cy - ry }, control2: { x: cx + rx, y: cy - ky }, to: p0 },
    ],
    closed: true,
  }
}

export function polygonProfile(points: Point[]): SketchProfile {
  const vertices = points.length >= 3 ? points : [...points]
  const start = vertices[0] ?? { x: 0, y: 0 }

  return {
    start,
    segments: vertices.slice(1).map((point) => ({
      type: 'line' as const,
      to: point,
    })).concat([
      { type: 'line' as const, to: start },
    ]),
    closed: true,
  }
}

export function slotProfile(p1: Point, p2: Point, width: number): SketchProfile {
  const r = width / 2
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
  const px = -Math.sin(angle)
  const py = Math.cos(angle)

  const A: Point = { x: p1.x + r * px, y: p1.y + r * py }
  const B: Point = { x: p2.x + r * px, y: p2.y + r * py }
  const C: Point = { x: p2.x - r * px, y: p2.y - r * py }
  const D: Point = { x: p1.x - r * px, y: p1.y - r * py }

  return {
    start: A,
    segments: [
      { type: 'line', to: B },
      { type: 'arc', center: p2, to: C, clockwise: true },
      { type: 'line', to: D },
      { type: 'arc', center: p1, to: A, clockwise: true },
    ],
    closed: true,
  }
}

export function ngonProfile(
  cx: number,
  cy: number,
  n: number,
  circumradius: number,
  firstVertexAngle: number,
): SketchProfile {
  const vertices = Array.from({ length: n }, (_, i) => ({
    x: cx + circumradius * Math.cos(firstVertexAngle + (i * 2 * Math.PI) / n),
    y: cy + circumradius * Math.sin(firstVertexAngle + (i * 2 * Math.PI) / n),
  }))
  return polygonProfile(vertices)
}

function pointsEqual(a: Point, b: Point, epsilon = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon
}

function distanceSquared(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function isAxisAlignedLine(from: Point, to: Point, epsilon = 1e-9): boolean {
  const horizontal = Math.abs(from.y - to.y) <= epsilon && Math.abs(from.x - to.x) > epsilon
  const vertical = Math.abs(from.x - to.x) <= epsilon && Math.abs(from.y - to.y) > epsilon
  return horizontal || vertical
}

export function inferFeatureKind(profile: SketchProfile): FeatureKind {
  const { start, segments } = profile

  if (segments.length === 1 && segments[0].type === 'circle') {
    return 'circle'
  }

  if (segments.length === 4 && segments.every((segment) => segment.type === 'arc')) {
    const firstCenter = segments[0].type === 'arc' ? segments[0].center : null
    const closed = pointsEqual(segments[segments.length - 1].to, start)
    if (firstCenter && closed) {
      const startRadiusSq = distanceSquared(start, firstCenter)
      const isCircle = segments.every((segment) => (
        segment.type === 'arc' &&
        pointsEqual(segment.center, firstCenter) &&
        Math.abs(distanceSquared(segment.to, firstCenter) - startRadiusSq) <= 1e-6
      ))
      if (isCircle) {
        return 'circle'
      }
    }
  }

  if (segments.every((segment) => segment.type === 'line')) {
    const allPoints = [start, ...segments.map((segment) => segment.to)]
    const closed = pointsEqual(allPoints[allPoints.length - 1], start)
    if (
      closed &&
      segments.length === 4 &&
      allPoints.slice(0, -1).every((point, index, array) => array.findIndex((candidate) => pointsEqual(candidate, point)) === index) &&
      allPoints.slice(0, -1).every((point, index) => {
        const nextPoint = allPoints[index + 1]
        return nextPoint ? isAxisAlignedLine(point, nextPoint) : true
      })
    ) {
      return 'rect'
    }

    return 'polygon'
  }

  if (segments.length === 4 && segments.every((segment) => segment.type === 'bezier')) {
    // Detect ellipse: 4 bezier segments whose anchors are axis-aligned quadrant points
    // and whose control points follow the κ pattern.
    const anchors = [start, ...segments.map((s) => s.to)]
    // anchors[4] should equal anchors[0] (closed)
    if (pointsEqual(anchors[4] ?? anchors[0], anchors[0])) {
      const cx = (anchors[0].x + anchors[2].x) / 2
      const cy = (anchors[1].y + anchors[3].y) / 2
      const rx = Math.abs(anchors[0].x - cx)
      const ry = Math.abs(anchors[1].y - cy)
      if (rx > 1e-9 && ry > 1e-9) {
        const expected = ellipseProfile(cx, cy, rx, ry)
        const isEllipse = segments.every((seg, i) => {
          const exp = expected.segments[i] as BezierSegment
          return (
            seg.type === 'bezier' &&
            pointsEqual(seg.control1, exp.control1, 1e-4) &&
            pointsEqual(seg.control2, exp.control2, 1e-4)
          )
        })
        if (isEllipse) return 'ellipse'
      }
    }
    return 'spline'
  }

  return 'composite'
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  }
}

export function bezierPoint(
  start: Point,
  control1: Point,
  control2: Point,
  end: Point,
  t: number,
): Point {
  const ab = lerpPoint(start, control1, t)
  const bc = lerpPoint(control1, control2, t)
  const cd = lerpPoint(control2, end, t)
  const abbc = lerpPoint(ab, bc, t)
  const bccd = lerpPoint(bc, cd, t)
  return lerpPoint(abbc, bccd, t)
}

export function splineProfile(points: Point[]): SketchProfile {
  if (points.length < 3) {
    return polygonProfile(points)
  }

  const start = points[0]
  const segments: BezierSegment[] = []

  for (let index = 0; index < points.length; index += 1) {
    const p0 = points[(index - 1 + points.length) % points.length]
    const p1 = points[index]
    const p2 = points[(index + 1) % points.length]
    const p3 = points[(index + 2) % points.length]

    segments.push({
      type: 'bezier',
      control1: {
        x: p1.x + (p2.x - p0.x) / 6,
        y: p1.y + (p2.y - p0.y) / 6,
      },
      control2: {
        x: p2.x - (p3.x - p1.x) / 6,
        y: p2.y - (p3.y - p1.y) / 6,
      },
      to: p2,
    })
  }

  return {
    start,
    segments,
    closed: true,
  }
}

export function defaultStock(
  w = 100,
  h = 80,
  thickness = 20,
  units: ProjectMeta['units'] = 'mm',
): Stock {
  const width = units === 'inch' ? 4 : w
  const height = units === 'inch' ? 3 : h
  const stockThickness = units === 'inch' ? 0.75 : thickness

  return {
    profile: rectProfile(0, 0, width, height),
    thickness: stockThickness,
    material: 'aluminum_6061',
    color: '#b9a83c', // theme-exempt: default stock colour is project data, not UI chrome
    visible: true,
    origin: { x: 0, y: 0 },
  }
}

/**
 * Build a Stock object from a SketchFeature's geometry.
 * The feature's profile (transformed by sketch.origin/orientationAngle) becomes the stock profile.
 * The feature's z_top becomes the stock thickness (z_bottom is assumed 0).
 */
export function stockFromFeature(feature: SketchFeature): Stock {
  // Use the feature's profile directly — it's already in project (world) coordinates.
  // The sketch.origin and orientationAngle describe the feature's local axis alignment,
  // not a rotation/translation to apply to the profile itself.
  const profile = feature.sketch.profile
  const zTop = typeof feature.z_top === 'number' ? feature.z_top : 20
  return {
    profile,
    thickness: zTop,
    material: 'aluminum_6061',
    color: '#b9a83c', // theme-exempt: default stock colour is project data, not UI chrome
    visible: true,
    origin: { x: 0, y: 0 },
    sourceFeatureId: feature.id,
  }
}

/**
 * Transform a feature's sketch profile by applying sketch.origin translation and
 * orientationAngle rotation, producing a profile in project coordinates.
 */
export function transformFeatureProfile(feature: SketchFeature): SketchProfile {
  const { profile, origin, orientationAngle } = feature.sketch
  if ((origin.x === 0 && origin.y === 0 && orientationAngle === 0)) {
    return profile
  }

  const angleRad = (orientationAngle * Math.PI) / 180
  const cosA = Math.cos(angleRad)
  const sinA = Math.sin(angleRad)

  function transformPoint(p: Point): Point {
    const x = p.x * cosA - p.y * sinA + origin.x
    const y = p.x * sinA + p.y * cosA + origin.y
    return { x, y }
  }

  const newSegments = profile.segments.map((seg) => {
    const transformedTo = transformPoint(seg.to)
    if (seg.type === 'line') {
      return { ...seg, to: transformedTo }
    }
    if (seg.type === 'arc') {
      return { ...seg, to: transformedTo, center: transformPoint(seg.center) }
    }
    if (seg.type === 'bezier') {
      return { ...seg, to: transformedTo, control1: transformPoint(seg.control1), control2: transformPoint(seg.control2) }
    }
    if (seg.type === 'circle') {
      return { ...seg, to: transformedTo, center: transformPoint(seg.center) }
    }
    return seg
  })

  return {
    start: transformPoint(profile.start),
    segments: newSegments,
    closed: profile.closed,
  }
}

/**
 * Returns the effective stock profile. When stock has a sourceFeatureId set,
 * returns the profile derived from the source feature. Otherwise returns
 * stock.profile directly (e.g. rectangle).
 */
export function getEffectiveStockProfile(stock: Stock): SketchProfile {
  return stock.profile
}

export function defaultGrid(units: ProjectMeta['units'] = 'mm'): GridSettings {
  if (units === 'inch') {
    return {
      extent: 8,
      majorSpacing: 1,
      minorSpacing: 0.25,
      snapEnabled: true,
      snapIncrement: 0.125,
      visible: true,
    }
  }

  return {
    extent: 200,
    majorSpacing: 10,
    minorSpacing: 2,
    snapEnabled: true,
    snapIncrement: 1,
    visible: true,
  }
}

export function defaultTool(units: ProjectMeta['units'] = 'mm', index = 1): Tool {
  if (units === 'inch') {
    return {
      id: `t${index}`,
      name: `1/4" Endmill ${index}`,
      units,
      type: 'flat_endmill',
      diameter: 0.25,
      vBitAngle: null,
      flutes: 2,
      material: 'carbide',
      defaultRpm: 18000,
      defaultFeed: 30,
      defaultPlungeFeed: 12,
      defaultStepdown: 0.1,
      defaultStepover: 0.4,
      maxCutDepth: 0,
    }
  }

  return {
    id: `t${index}`,
    name: `6 mm Endmill ${index}`,
    units,
    type: 'flat_endmill',
    diameter: 6,
    vBitAngle: null,
    flutes: 2,
    material: 'carbide',
    defaultRpm: 18000,
    defaultFeed: 800,
    defaultPlungeFeed: 300,
    defaultStepdown: 2,
    defaultStepover: 0.4,
    maxCutDepth: 0,
  }
}

export function defaultClampClearanceXY(units: ProjectMeta['units'] = 'mm'): number {
  return units === 'mm' ? 2 : 0.08
}

export function defaultOperationClearanceZ(units: ProjectMeta['units'] = 'mm'): number {
  return units === 'mm' ? 5 : 0.2
}

export function defaultMaxTravelZ(units: ProjectMeta['units'] = 'mm'): number {
  return units === 'mm' ? 50 : 2
}

export function defaultClampClearanceZ(units: ProjectMeta['units'] = 'mm'): number {
  return units === 'mm' ? 5 : 0.2
}

export function defaultOrigin(stock: Stock): MachineOrigin {
  const bounds = getStockBounds(stock)
  return {
    name: 'Origin',
    x: bounds.minX,
    y: bounds.maxY,
    z: stock.thickness,
    visible: true,
  }
}

export interface Bounds2D {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

// Endpoint of a segment when walking a profile from `profileStart`. A closed
// circle has no distinct end vertex — its traversal endpoint is the profile
// start; every other segment kind ends at `to`. Narrows the discriminated union
// so callers don't reach for `(seg as any).to`.
export function segmentEndPoint(seg: Segment, profileStart: Point): Point {
  return seg.type === 'circle' ? profileStart : seg.to
}

// Returns editable vertices (without duplicate closure vertex).
export function profileVertices(profile: SketchProfile): Point[] {
  if (profile.segments.length === 1 && profile.segments[0].type === 'circle') {
    // Circle has one vertex: the radius handle at profile.start
    return [profile.start]
  }

  const points: Point[] = [profile.start, ...profile.segments.map((segment) => segment.to)]
  if (profile.closed && points.length > 1) {
    const first = points[0]
    const last = points[points.length - 1]
    if (first.x === last.x && first.y === last.y) {
      return points.slice(0, -1)
    }
  }
  return points
}

export function sampleProfilePoints(
  profile: SketchProfile,
  curveSamples = 16,
  arcStepRadians = Math.PI / 18,
): Point[] {
  const points: Point[] = [profile.start]
  let current = profile.start

  for (const segment of profile.segments) {
    if (segment.type === 'line') {
      points.push(segment.to)
      current = segment.to
      continue
    }

    if (segment.type === 'bezier') {
      for (let sample = 1; sample <= curveSamples; sample += 1) {
        points.push(
          bezierPoint(current, segment.control1, segment.control2, segment.to, sample / curveSamples),
        )
      }
      current = segment.to
      continue
    }

    if (segment.type === 'circle') {
      const radius = Math.hypot(current.x - segment.center.x, current.y - segment.center.y)
      const startAngle = Math.atan2(current.y - segment.center.y, current.x - segment.center.x)
      const segmentCount = 64 // Smooth sampling for a full circle
      for (let index = 1; index <= segmentCount; index += 1) {
        const angle = startAngle + (segment.clockwise ? -1 : 1) * (Math.PI * 2 * index) / segmentCount
        points.push({
          x: segment.center.x + Math.cos(angle) * radius,
          y: segment.center.y + Math.sin(angle) * radius,
        })
      }
      current = profile.start
      continue
    }

    const startAngle = Math.atan2(current.y - segment.center.y, current.x - segment.center.x)
    const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
    const radius = Math.hypot(current.x - segment.center.x, current.y - segment.center.y)

    let sweep = endAngle - startAngle
    if (segment.clockwise && sweep > 0) {
      sweep -= Math.PI * 2
    } else if (!segment.clockwise && sweep < 0) {
      sweep += Math.PI * 2
    }

    const segmentCount = Math.max(8, Math.ceil(Math.abs(sweep) / arcStepRadians))
    for (let index = 1; index <= segmentCount; index += 1) {
      const angle = startAngle + (sweep * index) / segmentCount
      points.push({
        x: segment.center.x + Math.cos(angle) * radius,
        y: segment.center.y + Math.sin(angle) * radius,
      })
    }
    current = segment.to
  }

  const first = points[0]
  const last = points[points.length - 1]
  if (profile.closed && first && last && Math.hypot(last.x - first.x, last.y - first.y) < 1e-6) {
    points.pop()
  }

  return points
}

export function getProfileBounds(profile: SketchProfile): Bounds2D {
  if (inferFeatureKind(profile) === 'ellipse') {
    const anchors = [profile.start, ...profile.segments.map((s) => s.to)]
    const cx = (anchors[0].x + anchors[2].x) / 2
    const cy = (anchors[1].y + anchors[3].y) / 2
    const rx = Math.abs(anchors[0].x - cx)
    const ry = Math.abs(anchors[1].y - cy)
    return { minX: cx - rx, maxX: cx + rx, minY: cy - ry, maxY: cy + ry }
  }

  if (profile.segments.length === 1 && profile.segments[0].type === 'circle') {
    const seg = profile.segments[0]
    const r = Math.hypot(profile.start.x - seg.center.x, profile.start.y - seg.center.y)
    return {
      minX: seg.center.x - r,
      maxX: seg.center.x + r,
      minY: seg.center.y - r,
      maxY: seg.center.y + r,
    }
  }

  const points = sampleProfilePoints(profile)
  let minX = points[0]?.x ?? 0
  let maxX = points[0]?.x ?? 0
  let minY = points[0]?.y ?? 0
  let maxY = points[0]?.y ?? 0

  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }

  return { minX, maxX, minY, maxY }
}

function cross2d(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function onSegment(a: Point, b: Point, p: Point, epsilon = 1e-9): boolean {
  return (
    Math.min(a.x, b.x) - epsilon <= p.x &&
    p.x <= Math.max(a.x, b.x) + epsilon &&
    Math.min(a.y, b.y) - epsilon <= p.y &&
    p.y <= Math.max(a.y, b.y) + epsilon
  )
}

function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point, epsilon = 1e-9): boolean {
  const d1 = cross2d(a1, a2, b1)
  const d2 = cross2d(a1, a2, b2)
  const d3 = cross2d(b1, b2, a1)
  const d4 = cross2d(b1, b2, a2)

  if ((d1 > epsilon && d2 < -epsilon || d1 < -epsilon && d2 > epsilon) &&
      (d3 > epsilon && d4 < -epsilon || d3 < -epsilon && d4 > epsilon)) {
    return true
  }

  if (Math.abs(d1) <= epsilon && onSegment(a1, a2, b1, epsilon)) return true
  if (Math.abs(d2) <= epsilon && onSegment(a1, a2, b2, epsilon)) return true
  if (Math.abs(d3) <= epsilon && onSegment(b1, b2, a1, epsilon)) return true
  if (Math.abs(d4) <= epsilon && onSegment(b1, b2, a2, epsilon)) return true

  return false
}

export function profileHasSelfIntersection(profile: SketchProfile): boolean {
  if (!profile.closed) {
    return false
  }

  const points = sampleProfilePoints(profile, 24)
  const count = points.length
  if (count < 4) {
    return false
  }

  for (let i = 0; i < count; i += 1) {
    const a1 = points[i]
    const a2 = points[(i + 1) % count]

    for (let j = i + 1; j < count; j += 1) {
      if (j === i) continue
      if (j === i + 1) continue
      if (i === 0 && j === count - 1) continue

      const b1 = points[j]
      const b2 = points[(j + 1) % count]
      if (segmentsIntersect(a1, a2, b1, b2)) {
        return true
      }
    }
  }

  return false
}

export function getStockBounds(stock: Stock): Bounds2D {
  return getProfileBounds(stock.profile)
}

export function profileExceedsStock(profile: SketchProfile, stock: Stock): boolean {
  const profileBounds = getProfileBounds(profile)
  const stockBounds = getStockBounds(stock)
  return (
    profileBounds.minX < stockBounds.minX
    || profileBounds.maxX > stockBounds.maxX
    || profileBounds.minY < stockBounds.minY
    || profileBounds.maxY > stockBounds.maxY
  )
}

/** The newest project schema version this build understands. */
export const LATEST_PROJECT_VERSION = '3.0'

/**
 * True when a loaded project's `version` is newer than this build supports
 * (the file was saved by a future version). Such files still open best-effort,
 * but newer data may be missing or fail to round-trip. Compares major.minor.
 */
export function isProjectVersionNewerThanSupported(version: string | null | undefined): boolean {
  if (!version) return false
  const parse = (v: string): [number, number] => {
    const [maj, min] = v.split('.')
    return [Number.parseInt(maj, 10) || 0, Number.parseInt(min ?? '0', 10) || 0]
  }
  const [fileMaj, fileMin] = parse(version)
  const [curMaj, curMin] = parse(LATEST_PROJECT_VERSION)
  return fileMaj > curMaj || (fileMaj === curMaj && fileMin > curMin)
}

export function newProject(name = 'Untitled', units: ProjectMeta['units'] = 'inch'): Project {
  const now = new Date().toISOString()
  const stock = defaultStock(undefined, undefined, undefined, units)
  return {
    version: LATEST_PROJECT_VERSION,
    meta: {
      name,
      created: now,
      modified: now,
      units,
      showFeatureInfo: true,
      showDimensions: true,
      copyMode: 'reference' as const,
      maxTravelZ: defaultMaxTravelZ(units),
      operationClearanceZ: defaultOperationClearanceZ(units),
      clampClearanceXY: defaultClampClearanceXY(units),
      clampClearanceZ: defaultClampClearanceZ(units),
      machineDefinitions: copyBundledDefinitions(),
      selectedMachineId: null,
    },
    grid: defaultGrid(units),
    stock,
    origin: defaultOrigin(stock),
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {},
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
