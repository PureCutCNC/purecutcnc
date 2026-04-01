import { circleProfile, type Point, type SketchProfile } from '../types/project'
import { convertLength } from '../utils/units'
import { identityMatrix, isProfileDegenerate, multiplyMatrix, transformProfile, type AffineMatrix2D } from './normalize'
import type { ImportContext, ImportedShape, ImportInspection, ImportParseResult } from './types'

interface DxfPair {
  code: number
  value: string
}

interface DxfEntity {
  type: string
  pairs: DxfPair[]
  children?: DxfEntity[]
}

interface DxfBlock {
  name: string
  base: Point
  entities: DxfEntity[]
}

const IGNORED_INSERT_LAYERS = new Set(['ASHADE', 'HATCH'])
const IGNORED_INSERT_BLOCKS = new Set(['AME_NIL', 'AME_SOL', 'AVE_RENDER'])
const SUPPORTED_INSERT_GEOMETRY = new Set(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE', 'POLYLINE', 'INSERT'])

function parsePairs(text: string): DxfPair[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const pairs: DxfPair[] = []

  for (let index = 0; index < lines.length - 1; index += 2) {
    const code = Number.parseInt(lines[index].trim(), 10)
    if (!Number.isFinite(code)) {
      continue
    }
    pairs.push({
      code,
      value: lines[index + 1].trim(),
    })
  }

  return pairs
}

function dxfUnitsFromInsUnits(code: number | null): { units: ImportContext['targetUnits']; scale: number } | null {
  if (code === 1) {
    return { units: 'inch', scale: 1 }
  }
  if (code === 2) {
    return { units: 'inch', scale: 12 }
  }
  if (code === 3) {
    return { units: 'inch', scale: 63360 }
  }
  if (code === 4) {
    return { units: 'mm', scale: 1 }
  }
  if (code === 5) {
    return { units: 'mm', scale: 10 }
  }
  if (code === 6) {
    return { units: 'mm', scale: 1000 }
  }
  return null
}

function parseDxfSourceUnits(pairs: DxfPair[]): { units: ImportContext['targetUnits']; scale: number; rawCode: number | null } | null {
  for (let index = 0; index < pairs.length - 2; index += 1) {
    if (pairs[index].code === 9 && pairs[index].value === '$INSUNITS') {
      const unitCode = pairs.slice(index + 1).find((pair) => pair.code === 70)
      const rawCode = unitCode ? Number.parseInt(unitCode.value, 10) : null
      const parsed = dxfUnitsFromInsUnits(rawCode)
      return parsed ? { ...parsed, rawCode } : null
    }
  }
  return null
}

function extractEntities(pairs: DxfPair[]): DxfEntity[] {
  const entities: DxfEntity[] = []
  let inEntitiesSection = false
  let current: DxfEntity | null = null
  let activeChild: DxfEntity | null = null

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]
    if (pair.code === 0 && pair.value === 'SECTION') {
      if (activeChild && current?.children) {
        current.children.push(activeChild)
      }
      if (current) {
        entities.push(current)
      }
      inEntitiesSection = pairs[index + 1]?.code === 2 && pairs[index + 1]?.value === 'ENTITIES'
      current = null
      activeChild = null
      continue
    }
    if (pair.code === 0 && pair.value === 'ENDSEC') {
      if (activeChild && current?.children) {
        current.children.push(activeChild)
      }
      if (current) {
        entities.push(current)
      }
      current = null
      activeChild = null
      inEntitiesSection = false
      continue
    }
    if (!inEntitiesSection) {
      continue
    }

    if (pair.code === 0) {
      if (current?.type === 'POLYLINE' && pair.value === 'VERTEX') {
        if (activeChild && current.children) {
          current.children.push(activeChild)
        }
        activeChild = { type: 'VERTEX', pairs: [] }
        continue
      }

      if (current?.type === 'POLYLINE' && pair.value === 'SEQEND') {
        if (activeChild && current.children) {
          current.children.push(activeChild)
        }
        activeChild = null
        entities.push(current)
        current = null
        continue
      }

      if (activeChild && current?.children) {
        current.children.push(activeChild)
        activeChild = null
      }

      if (current) {
        entities.push(current)
      }
      current = { type: pair.value, pairs: [], children: pair.value === 'POLYLINE' ? [] : undefined }
      continue
    }

    if (activeChild) {
      activeChild.pairs.push(pair)
    } else {
      current?.pairs.push(pair)
    }
  }

  if (activeChild && current?.children) {
    current.children.push(activeChild)
  }
  if (current) {
    entities.push(current)
  }

  return entities
}

function extractBlocks(pairs: DxfPair[]): Map<string, DxfBlock> {
  const blocks = new Map<string, DxfBlock>()
  let inBlocksSection = false
  let currentBlock: DxfBlock | null = null
  let currentEntity: DxfEntity | null = null
  let activeChild: DxfEntity | null = null

  function flushChild() {
    if (activeChild && currentEntity?.children) {
      currentEntity.children.push(activeChild)
    }
    activeChild = null
  }

  function flushEntity() {
    flushChild()
    if (currentEntity && currentBlock) {
      currentBlock.entities.push(currentEntity)
    }
    currentEntity = null
  }

  function flushBlock() {
    flushEntity()
    if (currentBlock?.name) {
      blocks.set(currentBlock.name, currentBlock)
    }
    currentBlock = null
  }

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]
    if (pair.code === 0 && pair.value === 'SECTION') {
      flushBlock()
      inBlocksSection = pairs[index + 1]?.code === 2 && pairs[index + 1]?.value === 'BLOCKS'
      continue
    }

    if (!inBlocksSection) {
      continue
    }

    if (pair.code === 0 && pair.value === 'ENDSEC') {
      flushBlock()
      inBlocksSection = false
      continue
    }

    if (pair.code === 0 && pair.value === 'BLOCK') {
      flushBlock()
      currentBlock = { name: '', base: { x: 0, y: 0 }, entities: [] }
      continue
    }

    if (pair.code === 0 && pair.value === 'ENDBLK') {
      flushBlock()
      continue
    }

    if (currentBlock && !currentEntity) {
      if (pair.code === 2 || pair.code === 3) {
        if (!currentBlock.name) {
          currentBlock.name = pair.value
        }
      } else if (pair.code === 10) {
        currentBlock.base.x = Number.parseFloat(pair.value) || 0
      } else if (pair.code === 20) {
        currentBlock.base.y = Number.parseFloat(pair.value) || 0
      } else if (pair.code === 0) {
        currentEntity = { type: pair.value, pairs: [], children: pair.value === 'POLYLINE' ? [] : undefined }
      }
      continue
    }

    if (!currentBlock) {
      continue
    }

    if (pair.code === 0) {
      if (currentEntity?.type === 'POLYLINE' && pair.value === 'VERTEX') {
        flushChild()
        activeChild = { type: 'VERTEX', pairs: [] }
        continue
      }

      if (currentEntity?.type === 'POLYLINE' && pair.value === 'SEQEND') {
        flushEntity()
        continue
      }

      flushEntity()
      currentEntity = { type: pair.value, pairs: [], children: pair.value === 'POLYLINE' ? [] : undefined }
      continue
    }

    if (activeChild) {
      activeChild.pairs.push(pair)
    } else {
      currentEntity?.pairs.push(pair)
    }
  }

  flushBlock()
  return blocks
}

function pairNumber(entity: DxfEntity, code: number, fallback = 0): number {
  const pair = entity.pairs.find((entry) => entry.code === code)
  if (!pair) {
    return fallback
  }
  const parsed = Number.parseFloat(pair.value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function pairString(entity: DxfEntity, code: number): string | null {
  return entity.pairs.find((entry) => entry.code === code)?.value ?? null
}

function rotationMatrix(angleDegrees: number): AffineMatrix2D {
  const angle = (angleDegrees * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
}

function translationMatrix(x: number, y: number): AffineMatrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y }
}

function scaleMatrix(x: number, y: number): AffineMatrix2D {
  return { a: x, b: 0, c: 0, d: y, e: 0, f: 0 }
}

function isModelSpaceEntity(entity: DxfEntity): boolean {
  const paperSpaceFlag = Math.round(pairNumber(entity, 67, 0))
  if (paperSpaceFlag === 1) {
    return false
  }

  const layoutName = pairString(entity, 410)
  if (layoutName && layoutName.trim().toLowerCase() !== 'model') {
    return false
  }

  return true
}

function shouldExpandInsert(entity: DxfEntity, block: DxfBlock): boolean {
  const layerName = pairString(entity, 8) ?? ''
  if (layerName.startsWith('AME_') || IGNORED_INSERT_LAYERS.has(layerName)) {
    return false
  }

  if (block.name.startsWith('*') || block.name.startsWith('_')) {
    return false
  }

  if (IGNORED_INSERT_BLOCKS.has(block.name)) {
    return false
  }

  const hasSupportedGeometry = block.entities.some((entry) => SUPPORTED_INSERT_GEOMETRY.has(entry.type))
  if (!hasSupportedGeometry) {
    return false
  }

  return true
}

function convertPoint(
  point: Point,
  sourceUnits: ImportContext['targetUnits'],
  sourceUnitScale: number,
  targetUnits: ImportContext['targetUnits'],
): Point {
  return {
    x: convertLength(point.x * sourceUnitScale, sourceUnits, targetUnits),
    y: -convertLength(point.y * sourceUnitScale, sourceUnits, targetUnits),
  }
}

function convertProfileToTarget(
  profile: SketchProfile,
  sourceUnits: ImportContext['targetUnits'],
  sourceUnitScale: number,
  targetUnits: ImportContext['targetUnits'],
): SketchProfile {
  return {
    ...profile,
    start: convertPoint(profile.start, sourceUnits, sourceUnitScale, targetUnits),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc') {
        return {
          ...segment,
          to: convertPoint(segment.to, sourceUnits, sourceUnitScale, targetUnits),
          center: convertPoint(segment.center, sourceUnits, sourceUnitScale, targetUnits),
          clockwise: !segment.clockwise,
        }
      }
      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: convertPoint(segment.to, sourceUnits, sourceUnitScale, targetUnits),
          control1: convertPoint(segment.control1, sourceUnits, sourceUnitScale, targetUnits),
          control2: convertPoint(segment.control2, sourceUnits, sourceUnitScale, targetUnits),
        }
      }
      return {
        ...segment,
        to: convertPoint(segment.to, sourceUnits, sourceUnitScale, targetUnits),
      }
    }),
  }
}

function lineProfile(start: Point, end: Point): SketchProfile {
  return {
    start,
    segments: [{ type: 'line', to: end }],
    closed: false,
  }
}

function profileEnd(profile: SketchProfile): Point {
  return profile.segments[profile.segments.length - 1]?.to ?? profile.start
}

function pointsNear(a: Point, b: Point, tolerance: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance
}

function translatePoint(point: Point, dx: number, dy: number): Point {
  return { x: point.x + dx, y: point.y + dy }
}

function translateProfile(profile: SketchProfile, dx: number, dy: number): SketchProfile {
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

function reverseProfile(profile: SketchProfile): SketchProfile {
  const reversedSegments = []
  let previous = profile.start
  const vertices = [profile.start, ...profile.segments.map((segment) => segment.to)]

  for (let index = profile.segments.length - 1; index >= 0; index -= 1) {
    const segment = profile.segments[index]
    previous = vertices[index]

    if (segment.type === 'arc') {
      reversedSegments.push({
        type: 'arc' as const,
        to: previous,
        center: segment.center,
        clockwise: !segment.clockwise,
      })
      continue
    }

    if (segment.type === 'bezier') {
      reversedSegments.push({
        type: 'bezier' as const,
        to: previous,
        control1: segment.control2,
        control2: segment.control1,
      })
      continue
    }

    reversedSegments.push({
      type: 'line' as const,
      to: previous,
    })
  }

  return {
    start: profileEnd(profile),
    segments: reversedSegments,
    closed: profile.closed,
  }
}

function mergeOpenProfiles(left: SketchProfile, right: SketchProfile): SketchProfile {
  const leftEnd = profileEnd(left)
  const dx = leftEnd.x - right.start.x
  const dy = leftEnd.y - right.start.y
  const shiftedRight = Math.abs(dx) <= 1e-12 && Math.abs(dy) <= 1e-12 ? right : translateProfile(right, dx, dy)

  return {
    start: left.start,
    segments: [...left.segments, ...shiftedRight.segments],
    closed: false,
  }
}

function snapProfileClosed(profile: SketchProfile): SketchProfile {
  if (profile.segments.length === 0) {
    return profile
  }

  const segments = [...profile.segments]
  const last = segments[segments.length - 1]
  if (last.type === 'arc') {
    segments[segments.length - 1] = { ...last, to: profile.start }
  } else if (last.type === 'bezier') {
    segments[segments.length - 1] = { ...last, to: profile.start }
  } else {
    segments[segments.length - 1] = { ...last, to: profile.start }
  }

  return {
    start: profile.start,
    segments,
    closed: true,
  }
}

function defaultJoinTolerance(targetUnits: ImportContext['targetUnits']): number {
  return targetUnits === 'inch' ? 0.001 : 0.01
}

function stitchShapes(shapes: ImportedShape[], targetUnits: ImportContext['targetUnits']): ImportedShape[] {
  const tolerance = defaultJoinTolerance(targetUnits)
  const consumed = new Set<number>()
  const stitched: ImportedShape[] = []

  for (let index = 0; index < shapes.length; index += 1) {
    if (consumed.has(index)) {
      continue
    }

    let current = shapes[index]
    consumed.add(index)

    if (current.profile.closed) {
      stitched.push(current)
      continue
    }

    let changed = true
    while (changed) {
      changed = false

      for (let candidateIndex = 0; candidateIndex < shapes.length; candidateIndex += 1) {
        if (consumed.has(candidateIndex)) {
          continue
        }

        const candidate = shapes[candidateIndex]
        if (candidate.profile.closed) {
          continue
        }
        if ((candidate.layerName ?? '') !== (current.layerName ?? '')) {
          continue
        }

        const currentStart = current.profile.start
        const currentEnd = profileEnd(current.profile)
        const candidateStart = candidate.profile.start
        const candidateEnd = profileEnd(candidate.profile)

        if (pointsNear(currentEnd, candidateStart, tolerance)) {
          current = { ...current, profile: mergeOpenProfiles(current.profile, candidate.profile) }
        } else if (pointsNear(currentEnd, candidateEnd, tolerance)) {
          current = { ...current, profile: mergeOpenProfiles(current.profile, reverseProfile(candidate.profile)) }
        } else if (pointsNear(currentStart, candidateEnd, tolerance)) {
          current = { ...current, profile: mergeOpenProfiles(candidate.profile, current.profile) }
        } else if (pointsNear(currentStart, candidateStart, tolerance)) {
          current = { ...current, profile: mergeOpenProfiles(reverseProfile(candidate.profile), current.profile) }
        } else {
          continue
        }

        consumed.add(candidateIndex)
        changed = true
        break
      }
    }

    if (!current.profile.closed && pointsNear(current.profile.start, profileEnd(current.profile), tolerance)) {
      current = { ...current, profile: snapProfileClosed(current.profile) }
    }

    stitched.push(current)
  }

  return stitched
}

function buildBulgeSourceSegment(start: Point, end: Point, bulge: number) {
  if (Math.abs(bulge) <= 1e-9) {
    return { type: 'line' as const, to: end }
  }

  const dx = end.x - start.x
  const dy = end.y - start.y
  const chord = Math.hypot(dx, dy)
  if (chord <= 1e-9) {
    return { type: 'line' as const, to: end }
  }

  const offset = (chord * (1 - bulge * bulge)) / (4 * bulge)
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const leftNormal = { x: -dy / chord, y: dx / chord }
  const center = {
    x: midpoint.x + leftNormal.x * offset,
    y: midpoint.y + leftNormal.y * offset,
  }

  return {
    type: 'arc' as const,
    to: end,
    center,
    clockwise: bulge < 0,
  }
}

function bulgeSegment(start: Point, end: Point, bulge: number) {
  return buildBulgeSourceSegment(start, end, bulge)
}

function lwPolylineProfile(entity: DxfEntity): SketchProfile | null {
  const vertices: Array<{ point: Point; bulge: number }> = []
  const flags = Math.round(pairNumber(entity, 70, 0))
  let currentBulge = 0

  for (let index = 0; index < entity.pairs.length; index += 1) {
    const pair = entity.pairs[index]
    if (pair.code === 10) {
      const x = Number.parseFloat(pair.value)
      const yPair = entity.pairs.slice(index + 1).find((entry) => entry.code === 20)
      const y = yPair ? Number.parseFloat(yPair.value) : 0
      vertices.push({
        point: { x, y },
        bulge: currentBulge,
      })
      currentBulge = 0
      continue
    }
    if (pair.code === 42 && vertices.length > 0) {
      vertices[vertices.length - 1].bulge = Number.parseFloat(pair.value) || 0
    }
  }

  if (vertices.length < 2) {
    return null
  }

  const closed = (flags & 1) === 1
  const segments = []
  for (let index = 0; index < vertices.length - 1; index += 1) {
    segments.push(bulgeSegment(vertices[index].point, vertices[index + 1].point, vertices[index].bulge))
  }
  if (closed) {
    segments.push(bulgeSegment(vertices[vertices.length - 1].point, vertices[0].point, vertices[vertices.length - 1].bulge))
  }

  return {
    start: vertices[0].point,
    segments,
    closed,
  }
}

function polylineProfile(entity: DxfEntity): SketchProfile | null {
  const flags = Math.round(pairNumber(entity, 70, 0))
  const isMeshLike = (flags & 16) !== 0 || (flags & 64) !== 0
  if (isMeshLike) {
    return null
  }
  const closed = (flags & 1) === 1
  const vertices = (entity.children ?? [])
    .filter((child) => child.type === 'VERTEX')
    .map((vertex) => ({
      point: { x: pairNumber(vertex, 10), y: pairNumber(vertex, 20) },
      bulge: pairNumber(vertex, 42, 0),
    }))

  if (vertices.length < 2) {
    return null
  }

  const segments = []
  for (let index = 0; index < vertices.length - 1; index += 1) {
    segments.push(bulgeSegment(vertices[index].point, vertices[index + 1].point, vertices[index].bulge))
  }
  if (closed) {
    segments.push(bulgeSegment(vertices[vertices.length - 1].point, vertices[0].point, vertices[vertices.length - 1].bulge))
  }

  return {
    start: vertices[0].point,
    segments,
    closed,
  }
}

function arcProfile(
  entity: DxfEntity,
): SketchProfile {
  const center = { x: pairNumber(entity, 10), y: pairNumber(entity, 20) }
  const startAngle = (pairNumber(entity, 50) * Math.PI) / 180
  const endAngle = (pairNumber(entity, 51) * Math.PI) / 180

  const sourceStart = {
    x: pairNumber(entity, 10) + Math.cos(startAngle) * pairNumber(entity, 40),
    y: pairNumber(entity, 20) + Math.sin(startAngle) * pairNumber(entity, 40),
  }
  const sourceEnd = {
    x: pairNumber(entity, 10) + Math.cos(endAngle) * pairNumber(entity, 40),
    y: pairNumber(entity, 20) + Math.sin(endAngle) * pairNumber(entity, 40),
  }

  return {
    start: sourceStart,
    segments: [{
      type: 'arc',
      to: sourceEnd,
      center,
      clockwise: false,
    }],
    closed: false,
  }
}

function lineEntityProfile(entity: DxfEntity): SketchProfile {
  return lineProfile(
    { x: pairNumber(entity, 10), y: pairNumber(entity, 20) },
    { x: pairNumber(entity, 11), y: pairNumber(entity, 21) },
  )
}

function circleEntityProfile(entity: DxfEntity): SketchProfile {
  return circleProfile(pairNumber(entity, 10), pairNumber(entity, 20), pairNumber(entity, 40))
}

function resolveEntityLayer(entity: DxfEntity, inheritedLayerName: string | null): string | null {
  const ownLayer = pairString(entity, 8)
  if (!ownLayer || ownLayer === '0') {
    return inheritedLayerName
  }
  return ownLayer
}

function insertTransform(entity: DxfEntity, block: DxfBlock): AffineMatrix2D {
  const sx = pairNumber(entity, 41, 1) || 1
  const sy = pairNumber(entity, 42, 1) || 1
  const rotation = pairNumber(entity, 50, 0)
  const x = pairNumber(entity, 10, 0)
  const y = pairNumber(entity, 20, 0)

  return multiplyMatrix(
    translationMatrix(x, y),
    multiplyMatrix(
      rotationMatrix(rotation),
      multiplyMatrix(scaleMatrix(sx, sy), translationMatrix(-block.base.x, -block.base.y)),
    ),
  )
}

function instantiateEntity(
  entity: DxfEntity,
  matrix: AffineMatrix2D,
  inheritedLayerName: string | null,
  blocks: Map<string, DxfBlock>,
  sourceUnits: ImportContext['targetUnits'],
  sourceUnitScale: number,
  targetUnits: ImportContext['targetUnits'],
  warnings: string[],
  depth = 0,
): ImportedShape[] {
  if (depth > 12) {
    warnings.push('Skipped deeply nested DXF INSERT hierarchy.')
    return []
  }

  const layerName = resolveEntityLayer(entity, inheritedLayerName)

  function finalize(profile: SketchProfile | null, name: string): ImportedShape[] {
    if (!profile) {
      return []
    }
    const transformed = transformProfile(profile, matrix)
    const converted = convertProfileToTarget(transformed, sourceUnits, sourceUnitScale, targetUnits)
    if (isProfileDegenerate(converted)) {
      return []
    }
    return [{ name, sourceType: 'dxf', layerName, profile: converted }]
  }

  switch (entity.type) {
    case 'LINE':
      return finalize(lineEntityProfile(entity), layerName || 'Line')
    case 'CIRCLE':
      return finalize(circleEntityProfile(entity), layerName || 'Circle')
    case 'ARC':
      return finalize(arcProfile(entity), layerName || 'Arc')
    case 'LWPOLYLINE':
      return finalize(lwPolylineProfile(entity), layerName || 'Polyline')
    case 'POLYLINE': {
      const profile = polylineProfile(entity)
      if (!profile) {
        warnings.push('Skipped unsupported or empty DXF POLYLINE entity.')
        return []
      }
      return finalize(profile, layerName || 'Polyline')
    }
    case 'INSERT': {
      const blockName = pairString(entity, 2)
      if (!blockName) {
        warnings.push('Skipped DXF INSERT without block name.')
        return []
      }

      const block = blocks.get(blockName)
      if (!block) {
        warnings.push(`Skipped DXF INSERT for missing block ${blockName}.`)
        return []
      }

      if (!shouldExpandInsert(entity, block)) {
        return []
      }

      const nextMatrix = multiplyMatrix(matrix, insertTransform(entity, block))
      return block.entities.flatMap((child) =>
        instantiateEntity(
          child,
          nextMatrix,
          layerName,
          blocks,
          sourceUnits,
          sourceUnitScale,
          targetUnits,
          warnings,
          depth + 1,
        ),
      )
    }
    case 'ATTRIB':
    case 'ATTDEF':
    case 'TEXT':
    case 'MTEXT':
    case 'SEQEND':
      return []
    case 'SPLINE':
      warnings.push(`Skipped unsupported DXF entity ${entity.type}.`)
      return []
    default:
      return []
  }
}

export function inspectDxfString(text: string): ImportInspection {
  const pairs = parsePairs(text)
  const detected = parseDxfSourceUnits(pairs)

  if (!detected) {
    return {
      detectedUnits: null,
      sourceUnitScale: 1,
      unitsReliable: false,
      summary: 'No supported DXF $INSUNITS value found.',
      warnings: ['Could not detect DXF source units from $INSUNITS. Choose the source units before importing.'],
    }
  }

  return {
    detectedUnits: detected.units,
    sourceUnitScale: detected.scale,
    unitsReliable: true,
    summary: 'Detected source units from DXF $INSUNITS.',
    warnings: [],
  }
}

export function importDxfString(text: string, context: ImportContext): ImportParseResult {
  const pairs = parsePairs(text)
  const detected = parseDxfSourceUnits(pairs)
  const sourceUnits = context.sourceUnits ?? detected?.units ?? context.targetUnits
  const sourceUnitScale = context.sourceUnitScale ?? detected?.scale ?? 1
  const entities = extractEntities(pairs)
  const blocks = extractBlocks(pairs)
  const shapes: ImportedShape[] = []
  const warnings: string[] = []

  for (const entity of entities) {
    if (!isModelSpaceEntity(entity)) {
      continue
    }
    shapes.push(
      ...instantiateEntity(
        entity,
        identityMatrix(),
        null,
        blocks,
        sourceUnits,
        sourceUnitScale,
        context.targetUnits,
        warnings,
      ),
    )
  }

  return { shapes: stitchShapes(shapes, context.targetUnits), warnings }
}
