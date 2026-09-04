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

/** Whether glyphs rotate with the baseline tangent or keep world orientation. */
export type TextBaselineOrientation = 'fixed' | 'follow'

/** Which point of the text run sits at the layout's anchor position. */
export type TextBaselineAnchor = 'start' | 'center' | 'end'

/**
 * How the run's natural width, the baseline span, and the glyph size resolve
 * against each other. They are one equation (`width = radius * sweep` on an
 * arc), so exactly one of them has to give way.
 *
 * - `natural` keeps the size the user typed and lets the span follow.
 * - `fill`    keeps the span and scales the whole run *uniformly* to fit it.
 *
 * Uniform is load-bearing, not a detail: a horizontal-only stretch would cut
 * visibly distorted letterforms, and unlike a screen mock-up that cannot be
 * undone in the material.
 */
export type TextBaselineFit = 'natural' | 'fill'

/**
 * Which edge of the run lands on the curve.
 *
 * Derived from the travel direction rather than stored: the run always wants
 * its body on the outside of the curve, and which edge that is flips when the
 * direction does.
 */
export type TextBaselineAttach = 'bottom' | 'top'

/**
 * A curved baseline for a text feature. Absent/null is the historical straight
 * horizontal run, so every project saved before this existed loads unchanged
 * and no format version bump is needed.
 *
 * Geometry here is **template-local**: the arc is centred on the template
 * origin, and a path snapshot is stored in the same space. The template is
 * mapped onto the feature's frame at resolve time, so a `FeatureDefinition`
 * stays self-contained and every instance re-resolves under its own transform.
 */
export type TextLayout =
  | {
      kind: 'arc'
      /** Circle centre, in definition-local space. */
      center: Point
      radius: number
      /** Anchor position on the circle. 0 = 3 o'clock, positive = clockwise on screen. */
      angleDegrees: number
      sweepDegrees: number
      anchor: TextBaselineAnchor
      fit: TextBaselineFit
      /**
       * Travel direction, and with it which half of the circle the run
       * occupies and which edge of the run lands on the curve: `cw` writes
       * across the top with the run sitting on the circle, `ccw` across the
       * bottom with the run hanging below it. Both read left to right and
       * neither ends up inside the ring. (Upright at 12 o'clock and
       * at 6 o'clock). That is the top-arc / bottom-arc choice.
       */
      direction: 'cw' | 'ccw'
      orientation: TextBaselineOrientation
    }
  | {
      kind: 'path'
      /** Snapshot of the guide outline, baked at commit so the definition stays self-contained. */
      path: SketchProfile
      startOffset: number
      endOffset: number
      anchor: TextBaselineAnchor
      fit: TextBaselineFit
      /** Walk the guide backwards. The path analogue of `direction` above. */
      reversed: boolean
      orientation: TextBaselineOrientation
    }

export interface TextFeatureData {
  text: string
  style: TextFontStyle
  fontId: TextFontId
  size: number
}

/**
 * Deep-copy a text layout.
 *
 * Text data is copied with a shallow `{ ...text }` in several places (the
 * project normaliser, the `.camj` importer, definition edits). A shallow copy
 * would leave a definition and its source sharing one nested layout object —
 * and for a path layout, one `SketchProfile` — so every one of those sites has
 * to route through this instead.
 */
export function cloneTextLayout(layout: TextLayout | null | undefined): TextLayout | null {
  if (!layout) return null
  if (layout.kind === 'arc') return { ...layout, center: { ...layout.center } }
  return {
    ...layout,
    path: {
      start: { ...layout.path.start },
      segments: layout.path.segments.map((segment) => (
        segment.type === 'arc' || segment.type === 'circle'
          ? { ...segment, to: { ...segment.to }, center: { ...segment.center } }
          : segment.type === 'bezier'
            ? { ...segment, to: { ...segment.to }, control1: { ...segment.control1 }, control2: { ...segment.control2 } }
            : { ...segment, to: { ...segment.to } }
      )),
      closed: layout.path.closed,
    },
  }
}

/** Deep-copy text feature data. */
export function cloneTextFeatureData(text: TextFeatureData | null | undefined): TextFeatureData | null {
  return text ? { ...text } : null
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

/**
 * Post-import 3D orientation of an imported model, in degrees.
 *
 * Applied to the definition-local mesh **X first, then Y, then Z** about the
 * model's own axes — i.e. the matrix is `Rz · Ry · Rx`. Degrees (not a
 * quaternion) because the dominant case is 90° snaps, which round-trip exactly
 * and stay readable in the `.camj`. Absent means identity, so every project
 * saved before this field existed loads unchanged.
 *
 * Lives on the definition (`FeatureDefinition.stl`) because the derived
 * silhouette, profile, and top-view image are definition-level; see
 * ARCHITECTURE §4.
 */
export interface ModelOrientation {
  /** Rotation about the model X axis, degrees. Applied first. */
  rx: number
  /** Rotation about the model Y axis, degrees. Applied second. */
  ry: number
  /** Rotation about the model Z axis, degrees. Applied last. */
  rz: number
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
  /** Post-import 3D orientation. Absent = identity (import orientation). */
  orientation?: ModelOrientation
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
  /** Curved baseline, in the same space as `sketch.profile`. See {@link FeatureInstance.textLayout}. */
  textLayout?: TextLayout | null
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
  /**
   * Curved baseline for a text run, in definition-local space. Absent/null is
   * the straight horizontal run.
   *
   * This lives on the **instance**, not the shared definition, because laying a
   * run on a circle is a placement act like `transform` rather than a change to
   * the shared shape: two copies of the same text must be able to wrap two
   * different circles, and curving one copy must not curve the others.
   */
  textLayout?: TextLayout | null
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

export type EdgeStrategy = 'contour' | 'trochoidal'
export type CarveStrategy = 'direct' | 'trochoidal'
/**
 * Pocket clearing pattern. `seeded_offset` is `offset` preceded by a run of
 * full circles grown from the region's clearance seed, with the last circle
 * recorded as an island so the ring tree continues from it (issue #554).
 * Every project saved before it has `offset`, so the value is new-only and
 * legacy output is untouched.
 */
export type PocketPattern = 'offset' | 'parallel' | 'waterline' | 'constant_scallop' | 'seeded_offset' | 'trochoidal'
export type CutDirection = 'conventional' | 'climb'
/**
 * Drilling mode (issue #489 added `countersink`).
 *
 * `simple` is the load-bearing default: a saved operation without a `drillType`
 * must normalize to it, or every already-saved drilling operation would change
 * its motion. `countersink` is the one mode that is not a hole-making cycle —
 * it seats a screw head with a single V-bit plunge and deliberately emits no
 * canned cycle (see `generateDrillingToolpath`).
 */
export type DrillType = 'simple' | 'peck' | 'dwell' | 'chip_breaking' | 'helical' | 'countersink'
export type MachiningOrder = 'level_first' | 'feature_first'
export type EntryStrategy = 'plunge' | 'helix' | 'ramp'
/**
 * XY lead-in / lead-out strategy (issue #695).
 *
 * Composes with `EntryStrategy` rather than replacing it: the Z-entry reaches a
 * staging point at final depth and the XY lead carries the cutter from there
 * onto the contour along a tangent arc, so the cutter never reaches a surface
 * that survives into the part by plunging onto it. `'none'` is the
 * load-bearing default — it must be what a saved operation without the field
 * behaves as, or every already-saved operation would change its motion.
 * `'arc'` applies BOTH the entry and the exit lead; a half-configured exit that
 * silently left the surface engagement unchanged is not a state worth offering.
 */
export type XyLeadStrategy = 'none' | 'arc'
/**
 * Corner-relief style for a clearing operation (issue #203).
 *
 * `'none'` is the load-bearing default: it must be what a saved operation
 * without the field normalizes to, or every already-saved pocket would silently
 * change its cut geometry. Because the field is optional with a `'none'`
 * default there is no `.camj` version bump and no migration.
 */
export type CornerReliefStyle = 'none' | 'dogbone' | 't_bone' | 'longest_edge'
/**
 * Pocket feed reduction mode (issue #498).
 *
 * `'slots_only'` is the load-bearing default: it must be what a saved operation
 * without the field normalizes to, or every already-saved pocket would change
 * its motion. `'engagement'` samples cutter engagement along each cut
 * level and interpolates the feed between `pocketSlotFeedPercent` (full slot)
 * and the nominal wrap angle implied by the operation's stepover. Because the
 * field is optional with a `'slots_only'` default there is no `.camj` version bump
 * and no migration.
 */
export type PocketFeedReduction = 'slots_only' | 'engagement'

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
  /** Edge-route roughing strategy. Missing values are legacy contour operations. */
  edgeStrategy?: EdgeStrategy
  /** Engrave (follow_line) strategy. Missing values are legacy direct operations. */
  carveStrategy?: CarveStrategy
  /** Trochoidal channel width in the project's length units. */
  trochoidalCutWidth?: number
  /** Trochoidal guide advance as a ratio of cutter diameter. */
  trochoidalAdvance?: number
  entryStrategy?: EntryStrategy
  entryRampAngle?: number
  entryHelixDiameterPercent?: number
  /** XY lead-in/lead-out (issue #695). Missing or `'none'` keeps today's
   *  direct final-depth entry and retract; only `'arc'` stages the descent off
   *  the contour and leads onto it along a tangent arc. Applies where a pass
   *  leaves a surface that survives into the part; every other operation
   *  ignores it and normalisation strips it there. */
  xyLeadStrategy?: XyLeadStrategy
  /** Feed percentage (1-100) applied to fully engaged (slotting) pocket cuts:
   *  each section's innermost offset loop, ring segments crossing uncleared
   *  pinch corridors, the parallel boundary pass and first fill line, and the
   *  first finish-floor cut. Undefined or 100 disables the reduction. */
  pocketSlotFeedPercent?: number
  /** Feed reduction for slotting pocket cuts (issue #498): 'engagement' replaces
   *  the shipped binary slot-feed rule with a continuous engagement estimate
   *  mapped onto quantized feed scales. Missing or 'slots_only' keeps the
   *  shipped rule — a slots-only operation must produce byte-identical G-code. */
  pocketFeedReduction?: PocketFeedReduction
  roundOutsideCorners?: boolean
  /** Tangential ring-to-ring links in offset pocket clearing (issue #545): the
   *  straight link is replaced by an S-curve that departs ring N along its
   *  travel tangent and arrives on a vertex of ring N+1 along its travel
   *  tangent, bounded by the cleared domain and the length budget; when no S
   *  fits, the straight link stays. Missing keeps today's straight links at
   *  the engine level; operation defaults and load-time normalisation
   *  backfill it on, mirroring roundOutsideCorners. */
  roundLinkCorners?: boolean
  /** Round the wall-adjacent (root) clearing ring too (issue #546). That ring
   *  defines the wall, so rounding it removes coverage the wall needs; each
   *  rounded corner therefore has to be paired with an immediate same-Z
   *  cleanup that returns and traverses the exact sharp source span. The trade
   *  is a large drop in peak corner engagement (177 deg to 124 deg measured on
   *  `pocket-feed-reduction.camj`) for roughly 2% cycle time, so it is opt-in:
   *  missing or false keeps the wall ring sharp. Only meaningful together with
   *  `roundOutsideCorners`, which governs the interior rings on their own. */
  cleanWallCorners?: boolean
  /** Corner-relief style cut as a dedicated stepped pass appended after the
   *  operation's main path. Missing or `'none'` emits no relief at all — a
   *  legacy operation must produce byte-identical G-code. Applies to Pocket and
   *  both Edge Route kinds; the relieved corners are the convex corners of
   *  whatever region that operation clears, so no operation kind is named. */
  cornerRelief?: CornerReliefStyle
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
  /** Finished countersink mouth diameter in project length units, used only by
   *  the `countersink` drill type. It is the primary input because it is the
   *  dimension a fastener needs; the plunge depth is derived from it and the
   *  V-bit's included angle. Missing on every operation saved before issue #489,
   *  which is safe: those are not countersink operations. */
  countersinkDiameter?: number
  /** Distance above the material surface — `max(stock.thickness, highest
   *  feature top)` — where the drill parks between holes (issue #481).
   *  Format 3.1 stores this relative distance; files saved by ≤ 3.0 builds
   *  carry an absolute project-space Z and are migrated on load. Negative
   *  values are clamped back to the surface and warned about (#479). */
  retractHeight?: number
  debugShowRejectedCorners?: boolean
  /** Optional CL-surface slope bounds in degrees from horizontal (finish_surface only). */
  finishSlopeMin?: number
  finishSlopeMax?: number
  waterlineAdaptiveRefinement?: boolean
  waterlineMicroStepover?: number
  waterlineRefinementThreshold?: number
  waterlineMaxRingsPerBand?: number
  waterlineTipStepdown?: number
  /** When true, the postprocessor may replace contiguous linear cut moves
   *  that approximate a circular path with G2/G3 arc moves. This is an
   *  export-only preference — it does not affect the displayed or simulated
   *  toolpath. */
  arcFittingEnabled?: boolean
}

/**
 * True for an Edge Route operation that generates trochoidal orbits rather than
 * a plain offset contour.
 *
 * This is the single definition. The predicate gates generation, the tab pass in
 * `useToolpathGeneration`, the booklet's setting rows, and the CAM panel's field
 * visibility — and those must agree exactly, so none of them may re-spell it.
 * Note the `pass` term: a finish pass is always a contour, even if a stale
 * `edgeStrategy` survives on the operation from an earlier rough pass.
 */
export function isTrochoidalEdgeRoughing(operation: Operation): boolean {
  return operation.pass === 'rough'
    && (operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside')
    && operation.edgeStrategy === 'trochoidal'
}

/**
 * True for an Engrave (follow_line) operation that generates trochoidal orbits
 * rather than a direct centreline trace.
 *
 * This is the single definition. The predicate gates generation, the CAM panel's
 * field visibility, and the channel-width readout — and those must agree exactly,
 * so none of them may re-spell it.
 */
export function isTrochoidalCarve(operation: Operation): boolean {
  return operation.kind === 'follow_line' && operation.carveStrategy === 'trochoidal'
}

/**
 * True for a clearing operation that generates trochoidal orbits on its offset
 * rings rather than tracing them as plain contours.
 *
 * This is the single definition, and it decides the CAM panel's field visibility
 * and the entry-strategy switch. It has to cover the finish pass too: a finish
 * FLOOR is cleared trochoidally by the same ring emitter, so an operation that
 * orbits needs its channel-width and advance fields whichever pass it is on.
 * Gating this on `pass === 'rough'` hid those fields from an operation that was
 * still emitting orbits, leaving a channel width the user could not set.
 *
 * A finish pass's WALLS are always a contour — but that is decided inside the
 * generator, which asks `areaCoverage` per ring, not by this predicate.
 */
export function isTrochoidalPocket(operation: Operation): boolean {
  if (operation.pocketPattern !== 'trochoidal') return false
  if (operation.kind !== 'pocket' && operation.kind !== 'surface_clean' && operation.kind !== 'rough_surface') {
    return false
  }
  return operation.pass === 'rough' || operation.finishFloor
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

export type TabShape = 'rect' | 'smooth'

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
  shape?: TabShape
}

/**
 * Resolved tab shape. Anything not explicitly `'smooth'` — a legacy tab with no
 * field at all, or an unrecognised future value — is rectangular. Defaulting the
 * unknown case to rectangular is the safe direction: a smooth tab of the same
 * nominal size leaves materially less holding cross-section, so a misread value
 * must never silently reduce the material holding the part.
 */
export function tabShape(tab: Tab): TabShape {
  return tab.shape === 'smooth' ? 'smooth' : 'rect'
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
  /**
   * The project's embedded machine snapshot — **zero or one** entry, never a
   * library. The machine library lives in `src/machine/` as an application
   * preference; only the definition selected for this project travels with
   * the `.camj` file, so export stays deterministic for whoever opens it.
   * The array field is retained so older builds can still read the file.
   *
   * Invariant (enforced on decode and by `setProjectMachine`):
   * `selectedMachineId === machineDefinitions[0]?.id ?? null`.
   */
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
  /** Schema version. '3.0' made lightweight definition-backed instances
 *  authoritative; '3.1' reinterpreted drilling `retractHeight` as a distance
 *  above the material surface (issue #481). */
  version: '1.0' | '2.0' | '2.1' | '3.0' | '3.1'
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

/** How far above the material surface a fresh drilling operation retracts by
 *  default, and what an operation without a stored `retractHeight` falls back
 *  to at generation time (issue #481). One definition shared by the creation
 *  seed, the CAM panel's display fallback, and the engine's field fallback so
 *  the three can never disagree on units again. */
export function defaultRetractOffset(units: ProjectMeta['units'] = 'mm'): number {
  // 1 mm / 1/25.4 inch — identical to convertLength(1, 'mm', units).
  return units === 'mm' ? 1 : 1 / 25.4
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
      // Sample density matches the arc path (issue #359): use arcStepRadians
      // so full circles and broken-circle arcs have identical tessellation.
      const segmentCount = Math.max(8, Math.ceil((Math.PI * 2) / arcStepRadians))
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
export const LATEST_PROJECT_VERSION = '3.1'

/**
 * True when a loaded project's `version` is newer than this build supports
 * (the file was saved by a future version). Such files still open best-effort,
 * but newer data may be missing or fail to round-trip. Compares major.minor.
 */
/** Parse a project schema version into comparable major.minor numbers.
 *  Malformed components degrade to 0 so comparisons stay total. */
export function parseProjectVersion(version: string): [number, number] {
  const [maj, min] = version.split('.')
  return [Number.parseInt(maj, 10) || 0, Number.parseInt(min ?? '0', 10) || 0]
}

export function isProjectVersionNewerThanSupported(version: string | null | undefined): boolean {
  if (!version) return false
  const [fileMaj, fileMin] = parseProjectVersion(version)
  const [curMaj, curMin] = parseProjectVersion(LATEST_PROJECT_VERSION)
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
      machineDefinitions: [],
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
