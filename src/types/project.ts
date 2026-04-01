import type { MachineDefinition } from '../engine/gcode/types'

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
export type FeatureKind = 'rect' | 'circle' | 'polygon' | 'spline' | 'composite'

export interface SketchFeature {
  id: string
  name: string
  kind: FeatureKind
  folderId: string | null
  sketch: Sketch
  operation: FeatureOperation
  z_top: DimensionRef
  z_bottom: DimensionRef
  visible: boolean
  locked: boolean
}

export interface FeatureFolder {
  id: string
  name: string
  collapsed: boolean
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
}

// ============================================================
// Machining operations (Phase 3: schema and editing only)
// ============================================================

export type OperationKind =
  | 'pocket'
  | 'edge_route_inside'
  | 'edge_route_outside'
  | 'surface_clean'
  | 'follow_line'

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
  carveDepth: number
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
// Project — top-level .camj document
// ============================================================

export interface ProjectMeta {
  name: string
  created: string    // ISO 8601
  modified: string
  units: 'mm' | 'inch'
  maxTravelZ: number
  operationClearanceZ: number
  clampClearanceXY: number
  clampClearanceZ: number
  machineId: string | null
  customMachineDefinition: MachineDefinition | null
}

export interface MachineOrigin {
  name: string
  x: number
  y: number
  z: number
  visible: boolean
}

export interface Project {
  version: '1.0'
  meta: ProjectMeta
  grid: GridSettings
  stock: Stock
  origin: MachineOrigin
  dimensions: Record<string, NamedDimension>
  features: SketchFeature[]
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
  // Approximate circle as 4 arcs
  return {
    start: { x: cx + r, y: cy },
    segments: [
      { type: 'arc', to: { x: cx, y: cy + r }, center: { x: cx, y: cy }, clockwise: false },
      { type: 'arc', to: { x: cx - r, y: cy }, center: { x: cx, y: cy }, clockwise: false },
      { type: 'arc', to: { x: cx, y: cy - r }, center: { x: cx, y: cy }, clockwise: false },
      { type: 'arc', to: { x: cx + r, y: cy }, center: { x: cx, y: cy }, clockwise: false },
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

  if (segments.every((segment) => segment.type === 'bezier')) {
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
      vBitAngle: null,
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
    vBitAngle: null,
    flutes: 2,
    material: 'carbide',
    defaultRpm: 18000,
    defaultFeed: 800,
    defaultPlungeFeed: 300,
    defaultStepdown: 2,
    defaultStepover: 0.4,
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

// Returns editable vertices (without duplicate closure vertex).
export function profileVertices(profile: SketchProfile): Point[] {
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
  if (profile.closed && first && last && first.x === last.x && first.y === last.y) {
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

export function newProject(name = 'Untitled'): Project {
  const now = new Date().toISOString()
  const stock = defaultStock()
  return {
    version: '1.0',
    meta: {
      name,
      created: now,
      modified: now,
      units: 'mm',
      maxTravelZ: defaultMaxTravelZ('mm'),
      operationClearanceZ: defaultOperationClearanceZ('mm'),
      clampClearanceXY: defaultClampClearanceXY('mm'),
      clampClearanceZ: defaultClampClearanceZ('mm'),
      machineId: null,
      customMachineDefinition: null,
    },
    grid: defaultGrid(),
    stock,
    origin: defaultOrigin(stock),
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
