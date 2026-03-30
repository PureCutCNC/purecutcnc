import type {
  DimensionRef,
  Operation,
  Point,
  Project,
  SketchFeature,
  SketchProfile,
  Tool,
} from '../../types/project'
import { sampleProfilePoints } from '../../types/project'
import { convertToolUnits } from '../../utils/units'
import type {
  ClipperPath,
  FlattenedPath,
  NormalizedTool,
  ResolvedFeatureZSpan,
  ResolvedToolpathOperation,
} from './types'

export const DEFAULT_CLIPPER_SCALE = 10_000

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y }
}

export function resolveDimensionRef(project: Project, value: DimensionRef): number {
  if (typeof value === 'number') {
    return value
  }

  const named = project.dimensions[value]
  if (!named) {
    throw new Error(`Unknown dimension reference: ${value}`)
  }

  return named.value
}

export function resolveFeatureZSpan(project: Project, feature: SketchFeature): ResolvedFeatureZSpan {
  const top = resolveDimensionRef(project, feature.z_top)
  const bottom = resolveDimensionRef(project, feature.z_bottom)
  const min = Math.min(top, bottom)
  const max = Math.max(top, bottom)

  return {
    top,
    bottom,
    min,
    max,
    height: max - min,
  }
}

export function normalizeToolForProject(tool: Tool, project: Project): NormalizedTool {
  const normalizedTool = tool.units === project.meta.units
    ? tool
    : convertToolUnits(tool, project.meta.units)

  return {
    id: tool.id,
    name: tool.name,
    sourceUnits: tool.units,
    units: project.meta.units,
    type: normalizedTool.type,
    diameter: normalizedTool.diameter,
    radius: normalizedTool.diameter / 2,
    vBitAngle: normalizedTool.type === 'v_bit' ? normalizedTool.vBitAngle ?? 60 : null,
    flutes: normalizedTool.flutes,
    material: normalizedTool.material,
    defaultRpm: normalizedTool.defaultRpm,
    defaultFeed: normalizedTool.defaultFeed,
    defaultPlungeFeed: normalizedTool.defaultPlungeFeed,
    defaultStepdown: normalizedTool.defaultStepdown,
    defaultStepover: normalizedTool.defaultStepover,
  }
}

export function resolveOperationTool(project: Project, operation: Operation): ResolvedToolpathOperation {
  const tool = operation.toolRef
    ? project.tools.find((candidate) => candidate.id === operation.toolRef) ?? null
    : null

  return {
    operation,
    tool: tool ? normalizeToolForProject(tool, project) : null,
    units: project.meta.units,
  }
}

export function flattenProfile(profile: SketchProfile, curveSamples = 24, arcStepRadians = Math.PI / 36): FlattenedPath {
  const sampled = sampleProfilePoints(profile, curveSamples, arcStepRadians)

  return {
    points: sampled.map(clonePoint),
    closed: profile.closed,
  }
}

export function ensureClosedPath(points: Point[]): Point[] {
  if (points.length === 0) {
    return []
  }

  const first = points[0]
  const last = points[points.length - 1]
  if (first.x === last.x && first.y === last.y) {
    return points.map(clonePoint)
  }

  return [...points.map(clonePoint), clonePoint(first)]
}

export function signedArea(points: Point[]): number {
  if (points.length < 3) {
    return 0
  }

  let area = 0
  const closed = ensureClosedPath(points)
  for (let index = 0; index < closed.length - 1; index += 1) {
    const a = closed[index]
    const b = closed[index + 1]
    area += a.x * b.y - b.x * a.y
  }

  return area / 2
}

export function isClockwise(points: Point[]): boolean {
  return signedArea(points) < 0
}

export function normalizeWinding(points: Point[], clockwise: boolean): Point[] {
  const closed = ensureClosedPath(points)
  const currentlyClockwise = isClockwise(closed)
  if (currentlyClockwise === clockwise) {
    return closed
  }

  return [...closed].reverse()
}

export function toClipperPath(points: Point[], scale = DEFAULT_CLIPPER_SCALE): ClipperPath {
  return ensureClosedPath(points).map((point) => ({
    X: Math.round(point.x * scale),
    Y: Math.round(point.y * scale),
  }))
}

export function fromClipperPath(path: ClipperPath, scale = DEFAULT_CLIPPER_SCALE): Point[] {
  return path.map((point) => ({
    x: point.X / scale,
    y: point.Y / scale,
  }))
}

export function getOperationClearance(project: Project): number {
  return Math.max(0, project.meta.operationClearanceZ)
}

export function getOperationSafeZ(project: Project, featureSpans: ResolvedFeatureZSpan[] = []): number {
  const highestFeatureZ = featureSpans.reduce((highest, span) => Math.max(highest, span.max), 0)
  const stockTop = project.stock.thickness
  return Math.max(stockTop, highestFeatureZ) + getOperationClearance(project)
}
