// ============================================================
// Core geometry primitives
// ============================================================

export interface Point {
  x: number
  y: number
}

export type LineSegment = {
  type: 'line'
  to: Point
}

export type ArcSegment = {
  type: 'arc'
  to: Point
  center: Point
  clockwise: boolean
}

export type Segment = LineSegment | ArcSegment

// A closed profile — last segment implicitly closes back to first point
export interface SketchProfile {
  // First point is the implicit start; each segment ends at its 'to'
  start: Point
  segments: Segment[]
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

export type FeatureOperation = 'add' | 'subtract'

export interface SketchFeature {
  id: string
  name: string
  sketch: Sketch
  operation: FeatureOperation
  z_top: DimensionRef         // 0 = stock top surface
  z_bottom: DimensionRef      // positive = deeper into stock
  visible: boolean
  locked: boolean
}

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
  type: ToolType
  diameter: number
  flutes: number
  material: 'hss' | 'carbide'
}

// ============================================================
// Machining operations (POC: schema only, no execution yet)
// ============================================================

export type OperationType =
  | 'profile'
  | 'pocket'
  | 'drill'
  | 'facing'
  | 'engrave'

export type OperationStrategy = '2.5d' | '3d_contour'  // future-proofed

export interface Tab {
  position: number   // 0–1 along perimeter
  width: number
  height: number
}

export interface Operation {
  id: string
  type: OperationType
  feature_ref: string
  tool_ref: string
  depth: DimensionRef
  stepdown: number
  stepover: number
  feed: number
  rpm: number
  strategy: OperationStrategy
  tabs: Tab[]
}

// ============================================================
// Clamps
// ============================================================

export type ClampType = 'step_clamp' | 'toe_clamp' | 'vacuum_zone' | 'vise_jaw'

export interface Clamp {
  id: string
  type: ClampType
  x: number
  y: number
  w: number
  h: number
  height: number   // physical height — used for collision detection
}

// ============================================================
// Project — top-level .camj document
// ============================================================

export interface ProjectMeta {
  name: string
  created: string    // ISO 8601
  modified: string
  units: 'mm' | 'inch'
}

export interface Project {
  version: '1.0'
  meta: ProjectMeta
  grid: GridSettings
  stock: Stock
  dimensions: Record<string, NamedDimension>
  features: SketchFeature[]
  global_constraints: GlobalConstraint[]
  tools: Tool[]
  operations: Operation[]
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
  }
}

export function circleProfile(cx: number, cy: number, r: number): SketchProfile {
  // Approximate circle as 4 arcs
  return {
    start: { x: cx + r, y: cy },
    segments: [
      { type: 'arc', to: { x: cx, y: cy + r }, center: { x: cx, y: cy }, clockwise: false },
      { type: 'arc', to: { x: cx - r, y: cy }, center: { x: cx, y: cy }, clockwise: false },
      { type: 'arc', to: { x: cx, y: cy - r }, center: { x: cx, y: cy }, clockwise: false },
      { type: 'arc', to: { x: cx + r, y: cy }, center: { x: cx, y: cy }, clockwise: false },
    ],
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
  }
}

export function defaultStock(w = 100, h = 80, thickness = 20): Stock {
  return {
    profile: rectProfile(0, 0, w, h),
    thickness,
    material: 'aluminum_6061',
    color: '#8899aa',
    visible: true,
    origin: { x: 0, y: 0 },
  }
}

export function defaultGrid(): GridSettings {
  return {
    extent: 200,
    majorSpacing: 10,
    minorSpacing: 2,
    snapEnabled: true,
    snapIncrement: 1,
    visible: true,
  }
}

export interface Bounds2D {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

// Returns editable vertices (without duplicate closure vertex).
export function profileVertices(profile: SketchProfile): Point[] {
  const points: Point[] = [profile.start, ...profile.segments.map((segment) => segment.to)]
  if (points.length > 1) {
    const first = points[0]
    const last = points[points.length - 1]
    if (first.x === last.x && first.y === last.y) {
      return points.slice(0, -1)
    }
  }
  return points
}

export function getProfileBounds(profile: SketchProfile): Bounds2D {
  const points = profileVertices(profile)
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

export function getStockBounds(stock: Stock): Bounds2D {
  return getProfileBounds(stock.profile)
}

export function newProject(name = 'Untitled'): Project {
  const now = new Date().toISOString()
  return {
    version: '1.0',
    meta: { name, created: now, modified: now, units: 'mm' },
    grid: defaultGrid(),
    stock: defaultStock(),
    dimensions: {},
    features: [],
    global_constraints: [],
    tools: [],
    operations: [],
    clamps: [],
    ai_history: [],
  }
}
