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

export type BezierSegment = {
  type: 'bezier'
  to: Point
  control1: Point
  control2: Point
}

export type Segment = LineSegment | ArcSegment | BezierSegment

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
  z_top: DimensionRef
  z_bottom: DimensionRef
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
  units: ProjectMeta['units']
  type: ToolType
  diameter: number
  flutes: number
  material: 'hss' | 'carbide'
  defaultRpm: number
  defaultFeed: number
  defaultPlungeFeed: number
  defaultStepdown: number
  defaultStepover: number
}

// ============================================================
// Machining operations (Phase 3: schema and editing only)
// ============================================================

export type OperationKind =
  | 'pocket'
  | 'edge_route_inside'
  | 'edge_route_outside'
  | 'surface_clean'

export type OperationPass = 'rough' | 'finish'

export type OperationTarget =
  | { source: 'features'; featureIds: string[] }
  | { source: 'stock' }

export interface Operation {
  id: string
  name: string
  kind: OperationKind
  pass: OperationPass
  enabled: boolean
  showToolpath: boolean
  target: OperationTarget
  toolRef: string | null
  stepdown: number
  stepover: number
  feed: number
  plungeFeed: number
  rpm: number
  stockToLeaveRadial: number
  stockToLeaveAxial: number
  finishWalls: boolean
  finishFloor: boolean
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

export function defaultTool(units: ProjectMeta['units'] = 'mm', index = 1): Tool {
  if (units === 'inch') {
    return {
      id: `t${index}`,
      name: `1/4" Endmill ${index}`,
      units,
      type: 'flat_endmill',
      diameter: 0.25,
      flutes: 2,
      material: 'carbide',
      defaultRpm: 18000,
      defaultFeed: 30,
      defaultPlungeFeed: 12,
      defaultStepdown: 0.1,
      defaultStepover: 0.4,
    }
  }

  return {
    id: `t${index}`,
    name: `6 mm Endmill ${index}`,
    units,
    type: 'flat_endmill',
    diameter: 6,
    flutes: 2,
    material: 'carbide',
    defaultRpm: 18000,
    defaultFeed: 800,
    defaultPlungeFeed: 300,
    defaultStepdown: 2,
    defaultStepover: 0.4,
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
  if (first && last && first.x === last.x && first.y === last.y) {
    points.pop()
  }

  return points
}

export function getProfileBounds(profile: SketchProfile): Bounds2D {
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
