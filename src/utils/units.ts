import type {
  Clamp,
  DimensionRef,
  GlobalConstraint,
  GridSettings,
  LocalConstraint,
  LocalDimension,
  NamedDimension,
  Operation,
  Point,
  Project,
  ProjectMeta,
  Segment,
  SketchFeature,
  SketchProfile,
  Stock,
  Tool,
} from '../types/project'

export type Units = ProjectMeta['units']

const MM_PER_INCH = 25.4

export function convertLength(value: number, from: Units, to: Units): number {
  if (from === to) {
    return value
  }

  return from === 'mm' ? value / MM_PER_INCH : value * MM_PER_INCH
}

export function parseLengthInput(text: string, _units: Units): number | null {
  void _units
  const normalized = text.trim().replace(/,/g, '')
  if (!normalized) {
    return null
  }

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

export function formatLength(
  value: number,
  units: Units,
  options?: { maximumFractionDigits?: number },
): string {
  const maximumFractionDigits = options?.maximumFractionDigits ?? (units === 'inch' ? 4 : 3)
  const fixed = value.toFixed(maximumFractionDigits)
  return fixed.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '')
}

function convertPoint(point: Point, from: Units, to: Units): Point {
  return {
    x: convertLength(point.x, from, to),
    y: convertLength(point.y, from, to),
  }
}

function convertSegment(segment: Segment, from: Units, to: Units): Segment {
  if (segment.type === 'arc') {
    return {
      ...segment,
      to: convertPoint(segment.to, from, to),
      center: convertPoint(segment.center, from, to),
    }
  }

  if (segment.type === 'bezier') {
    return {
      ...segment,
      to: convertPoint(segment.to, from, to),
      control1: convertPoint(segment.control1, from, to),
      control2: convertPoint(segment.control2, from, to),
    }
  }

  return {
    ...segment,
    to: convertPoint(segment.to, from, to),
  }
}

function convertProfile(profile: SketchProfile, from: Units, to: Units): SketchProfile {
  return {
    ...profile,
    start: convertPoint(profile.start, from, to),
    segments: profile.segments.map((segment) => convertSegment(segment, from, to)),
    closed: profile.closed,
  }
}

function convertDimensionRef(value: DimensionRef, from: Units, to: Units): DimensionRef {
  return typeof value === 'number' ? convertLength(value, from, to) : value
}

function convertNamedDimension(dimension: NamedDimension, from: Units, to: Units): NamedDimension {
  return {
    ...dimension,
    value: convertLength(dimension.value, from, to),
  }
}

function convertLocalDimension(dimension: LocalDimension, from: Units, to: Units): LocalDimension {
  if (dimension.type === 'angle') {
    return dimension
  }

  return {
    ...dimension,
    value: convertLength(dimension.value, from, to),
  }
}

function convertLocalConstraint(constraint: LocalConstraint, from: Units, to: Units): LocalConstraint {
  if (constraint.value === undefined) {
    return constraint
  }

  if (constraint.type === 'fixed_angle') {
    return constraint
  }

  if (constraint.type === 'fixed_distance' || constraint.type === 'fixed_radius') {
    return {
      ...constraint,
      value: convertLength(constraint.value, from, to),
    }
  }

  return constraint
}

function convertGlobalConstraint(constraint: GlobalConstraint, from: Units, to: Units): GlobalConstraint {
  if (constraint.value === undefined) {
    return constraint
  }

  if (constraint.type === 'equal_spacing') {
    return {
      ...constraint,
      value: convertLength(constraint.value, from, to),
    }
  }

  return constraint
}

function convertFeature(feature: SketchFeature, from: Units, to: Units): SketchFeature {
  return {
    ...feature,
    sketch: {
      ...feature.sketch,
      origin: convertPoint(feature.sketch.origin, from, to),
      profile: convertProfile(feature.sketch.profile, from, to),
      dimensions: feature.sketch.dimensions.map((dimension) => convertLocalDimension(dimension, from, to)),
      constraints: feature.sketch.constraints.map((constraint) => convertLocalConstraint(constraint, from, to)),
    },
    z_top: convertDimensionRef(feature.z_top, from, to),
    z_bottom: convertDimensionRef(feature.z_bottom, from, to),
  }
}

function convertStock(stock: Stock, from: Units, to: Units): Stock {
  return {
    ...stock,
    profile: convertProfile(stock.profile, from, to),
    thickness: convertLength(stock.thickness, from, to),
    origin: convertPoint(stock.origin, from, to),
  }
}

function convertGrid(grid: GridSettings, from: Units, to: Units): GridSettings {
  return {
    ...grid,
    extent: convertLength(grid.extent, from, to),
    majorSpacing: convertLength(grid.majorSpacing, from, to),
    minorSpacing: convertLength(grid.minorSpacing, from, to),
    snapIncrement: convertLength(grid.snapIncrement, from, to),
  }
}

function convertTool(tool: Tool, from: Units, to: Units): Tool {
  return {
    ...tool,
    units: to,
    diameter: convertLength(tool.diameter, from, to),
    defaultFeed: convertLength(tool.defaultFeed, from, to),
    defaultPlungeFeed: convertLength(tool.defaultPlungeFeed, from, to),
    defaultStepdown: convertLength(tool.defaultStepdown, from, to),
  }
}

export function convertToolUnits(tool: Tool, toUnits: Units): Tool {
  return convertTool(tool, tool.units, toUnits)
}

function convertOperation(operation: Operation, from: Units, to: Units): Operation {
  return {
    ...operation,
    stepdown: convertLength(operation.stepdown, from, to),
    feed: convertLength(operation.feed, from, to),
    plungeFeed: convertLength(operation.plungeFeed, from, to),
    stockToLeaveRadial: convertLength(operation.stockToLeaveRadial, from, to),
    stockToLeaveAxial: convertLength(operation.stockToLeaveAxial, from, to),
  }
}

function convertClamp(clamp: Clamp, from: Units, to: Units): Clamp {
  return {
    ...clamp,
    x: convertLength(clamp.x, from, to),
    y: convertLength(clamp.y, from, to),
    w: convertLength(clamp.w, from, to),
    h: convertLength(clamp.h, from, to),
    height: convertLength(clamp.height, from, to),
  }
}

function convertOrigin(origin: Project['origin'], from: Units, to: Units): Project['origin'] {
  return {
    ...origin,
    x: convertLength(origin.x, from, to),
    y: convertLength(origin.y, from, to),
    z: convertLength(origin.z, from, to),
  }
}

export function convertProjectUnits(project: Project, toUnits: Units): Project {
  const fromUnits = project.meta.units
  if (fromUnits === toUnits) {
    return project
  }

  return {
    ...project,
    meta: {
      ...project.meta,
      units: toUnits,
      maxTravelZ: convertLength(project.meta.maxTravelZ, fromUnits, toUnits),
      operationClearanceZ: convertLength(project.meta.operationClearanceZ, fromUnits, toUnits),
      clampClearanceXY: convertLength(project.meta.clampClearanceXY, fromUnits, toUnits),
      clampClearanceZ: convertLength(project.meta.clampClearanceZ, fromUnits, toUnits),
    },
    grid: convertGrid(project.grid, fromUnits, toUnits),
    stock: convertStock(project.stock, fromUnits, toUnits),
    origin: convertOrigin(project.origin, fromUnits, toUnits),
    dimensions: Object.fromEntries(
      Object.entries(project.dimensions).map(([key, dimension]) => [
        key,
        convertNamedDimension(dimension, fromUnits, toUnits),
      ]),
    ),
    features: project.features.map((feature) => convertFeature(feature, fromUnits, toUnits)),
    global_constraints: project.global_constraints.map((constraint) => convertGlobalConstraint(constraint, fromUnits, toUnits)),
    tools: project.tools,
    operations: project.operations.map((operation) => convertOperation(operation, fromUnits, toUnits)),
    clamps: project.clamps.map((clamp) => convertClamp(clamp, fromUnits, toUnits)),
  }
}
