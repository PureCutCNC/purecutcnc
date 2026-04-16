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
const SUPPORTED_INSERT_GEOMETRY = new Set(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE', 'POLYLINE', 'SPLINE', 'INSERT'])
const SPLINE_SAMPLES_PER_SPAN = 8

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

  if (block.name === '$MODEL_SPACE' || block.name === '$PAPER_SPACE') {
    return false
  }

  if (block.name.startsWith('_')) {
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
      if (segment.type === 'circle') {
        return {
          ...segment,
          center: convertPoint(segment.center, sourceUnits, sourceUnitScale, targetUnits),
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

function lineStripProfile(points: Point[], closed: boolean): SketchProfile | null {
  if (points.length < 2) {
    return null
  }

  const segments = []
  for (let index = 1; index < points.length; index += 1) {
    segments.push({ type: 'line' as const, to: points[index] })
  }

  if (closed) {
    segments.push({ type: 'line' as const, to: points[0] })
  }

  return {
    start: points[0],
    segments,
    closed,
  }
}

function profileEnd(profile: SketchProfile): Point {
  return profile.segments[profile.segments.length - 1]?.to ?? profile.start
}

function pointsNear(a: Point, b: Point, tolerance: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance
}

function dedupeConsecutivePoints(points: Point[], tolerance = 1e-9): Point[] {
  const deduped: Point[] = []

  for (const point of points) {
    const previous = deduped[deduped.length - 1]
    if (!previous || !pointsNear(previous, point, tolerance)) {
      deduped.push(point)
    }
  }

  return deduped
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
      if (segment.type === 'circle') {
        return {
          ...segment,
          center: translatePoint(segment.center, dx, dy),
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
  if (profile.segments.length === 1 && profile.segments[0].type === 'circle') {
    return { ...profile }
  }

  const reversedSegments = []
  let previous = profile.start
  const vertices = [profile.start, ...profile.segments.map((segment) => (segment as any).to)]

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
  return targetUnits === 'inch' ? 0.02 : 0.5
}

function pointSignature(point: Point): string {
  return `${point.x.toFixed(6)},${point.y.toFixed(6)}`
}

function segmentSignature(start: Point, segment: SketchProfile['segments'][number]): string {
  if (segment.type === 'arc') {
    return `A:${pointSignature(start)}:${pointSignature(segment.to)}:${pointSignature(segment.center)}:${segment.clockwise ? '1' : '0'}`
  }
  if (segment.type === 'bezier') {
    return `B:${pointSignature(start)}:${pointSignature(segment.control1)}:${pointSignature(segment.control2)}:${pointSignature(segment.to)}`
  }
  return `L:${pointSignature(start)}:${pointSignature(segment.to)}`
}

function profileSignature(profile: SketchProfile): string {
  const parts: string[] = [`${profile.closed ? 'C' : 'O'}:${pointSignature(profile.start)}`]
  let current = profile.start
  for (const segment of profile.segments) {
    parts.push(segmentSignature(current, segment))
    current = segment.to
  }
  return parts.join('|')
}

function canonicalProfileSignature(profile: SketchProfile): string {
  const forward = profileSignature(profile)
  if (profile.closed) {
    return forward
  }
  const reversed = profileSignature(reverseProfile(profile))
  return forward < reversed ? forward : reversed
}

function dedupeIdenticalShapes(shapes: ImportedShape[]): ImportedShape[] {
  const seen = new Set<string>()
  const deduped: ImportedShape[] = []

  for (const shape of shapes) {
    const key = `${shape.layerName ?? ''}::${canonicalProfileSignature(shape.profile)}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(shape)
  }

  return deduped
}

interface OpenProfileMergeCandidate {
  candidateIndex: number
  distance: number
  merge: (current: ImportedShape, candidate: ImportedShape) => ImportedShape
}

function bestOpenProfileMergeCandidate(
  current: ImportedShape,
  shapes: ImportedShape[],
  consumed: Set<number>,
  tolerance: number,
  allowCrossLayerJoins: boolean,
): OpenProfileMergeCandidate | null {
  let best: OpenProfileMergeCandidate | null = null

  const currentStart = current.profile.start
  const currentEnd = profileEnd(current.profile)

  for (let candidateIndex = 0; candidateIndex < shapes.length; candidateIndex += 1) {
    if (consumed.has(candidateIndex)) {
      continue
    }

    const candidate = shapes[candidateIndex]
    if (candidate.profile.closed) {
      continue
    }
    if (!allowCrossLayerJoins && (candidate.layerName ?? '') !== (current.layerName ?? '')) {
      continue
    }

    const candidateStart = candidate.profile.start
    const candidateEnd = profileEnd(candidate.profile)

    const options: OpenProfileMergeCandidate[] = [
      {
        candidateIndex,
        distance: Math.hypot(currentEnd.x - candidateStart.x, currentEnd.y - candidateStart.y),
        merge: (active, next) => ({ ...active, profile: mergeOpenProfiles(active.profile, next.profile) }),
      },
      {
        candidateIndex,
        distance: Math.hypot(currentEnd.x - candidateEnd.x, currentEnd.y - candidateEnd.y),
        merge: (active, next) => ({ ...active, profile: mergeOpenProfiles(active.profile, reverseProfile(next.profile)) }),
      },
      {
        candidateIndex,
        distance: Math.hypot(currentStart.x - candidateEnd.x, currentStart.y - candidateEnd.y),
        merge: (active, next) => ({ ...active, profile: mergeOpenProfiles(next.profile, active.profile) }),
      },
      {
        candidateIndex,
        distance: Math.hypot(currentStart.x - candidateStart.x, currentStart.y - candidateStart.y),
        merge: (active, next) => ({ ...active, profile: mergeOpenProfiles(reverseProfile(next.profile), active.profile) }),
      },
    ]

    for (const option of options) {
      if (option.distance > tolerance) {
        continue
      }
      if (!best || option.distance < best.distance) {
        best = option
      }
    }
  }

  return best
}

function pointOnArcSegment(
  center: Point,
  point: Point,
  start: Point,
  end: Point,
  clockwise: boolean,
  tolerance = 1e-9,
): boolean {
  const normalize = (angle: number) => {
    let normalized = angle % (Math.PI * 2)
    if (normalized < 0) {
      normalized += Math.PI * 2
    }
    return normalized
  }

  const startAngle = normalize(Math.atan2(start.y - center.y, start.x - center.x))
  const endAngle = normalize(Math.atan2(end.y - center.y, end.x - center.x))
  let pointAngle = normalize(Math.atan2(point.y - center.y, point.x - center.x))

  if (clockwise) {
    const adjustedStart = startAngle
    let adjustedEnd = endAngle
    if (adjustedEnd > adjustedStart) {
      adjustedEnd -= Math.PI * 2
    }
    if (pointAngle > adjustedStart) {
      pointAngle -= Math.PI * 2
    }
    return pointAngle <= adjustedStart + tolerance && pointAngle >= adjustedEnd - tolerance
  }

  const adjustedStart = startAngle
  let adjustedEnd = endAngle
  if (adjustedEnd < adjustedStart) {
    adjustedEnd += Math.PI * 2
  }
  if (pointAngle < adjustedStart) {
    pointAngle += Math.PI * 2
  }
  return pointAngle >= adjustedStart - tolerance && pointAngle <= adjustedEnd + tolerance
}

interface SegmentInteriorHit {
  candidateIndex: number
  segmentIndex: number
  point: Point
  distance: number
}

function profilePointAtSegmentIndex(profile: SketchProfile, segmentIndex: number): Point {
  if (segmentIndex <= 0) {
    return profile.start
  }
  return profile.segments[segmentIndex - 1]?.to ?? profile.start
}

function splitProfileAtSegment(profile: SketchProfile, segmentIndex: number, point: Point, tolerance: number): [SketchProfile, SketchProfile] | null {
  if (profile.closed || segmentIndex < 0 || segmentIndex >= profile.segments.length) {
    return null
  }

  const segment = profile.segments[segmentIndex]
  const segmentStart = profilePointAtSegmentIndex(profile, segmentIndex)
  if (pointsNear(segmentStart, point, tolerance) || pointsNear(segment.to, point, tolerance)) {
    return null
  }

  const leftSegments = profile.segments.slice(0, segmentIndex)
  const rightSegments = profile.segments.slice(segmentIndex + 1)

  if (segment.type === 'line') {
    return [
      {
        start: profile.start,
        segments: [...leftSegments, { type: 'line', to: point }],
        closed: false,
      },
      {
        start: point,
        segments: [{ type: 'line', to: segment.to }, ...rightSegments],
        closed: false,
      },
    ]
  }

  if (segment.type === 'arc') {
    return [
      {
        start: profile.start,
        segments: [...leftSegments, { ...segment, to: point }],
        closed: false,
      },
      {
        start: point,
        segments: [{ ...segment, to: segment.to }, ...rightSegments],
        closed: false,
      },
    ]
  }

  return null
}

function bestInteriorSegmentHit(
  endpoint: Point,
  currentShapeIndex: number,
  shapes: ImportedShape[],
  tolerance: number,
  allowCrossLayerJoins: boolean,
): SegmentInteriorHit | null {
  let best: SegmentInteriorHit | null = null

  for (let candidateIndex = 0; candidateIndex < shapes.length; candidateIndex += 1) {
    if (candidateIndex === currentShapeIndex) {
      continue
    }

    const candidate = shapes[candidateIndex]
    if (candidate.profile.closed) {
      continue
    }
    if (!allowCrossLayerJoins && (candidate.layerName ?? '') !== (shapes[currentShapeIndex].layerName ?? '')) {
      continue
    }

    for (let segmentIndex = 0; segmentIndex < candidate.profile.segments.length; segmentIndex += 1) {
      const segment = candidate.profile.segments[segmentIndex]
      const start = profilePointAtSegmentIndex(candidate.profile, segmentIndex)
      let hitPoint: Point | null = null
      let distance = Number.POSITIVE_INFINITY

      if (segment.type === 'line') {
        const dx = segment.to.x - start.x
        const dy = segment.to.y - start.y
        const lengthSq = dx * dx + dy * dy
        if (lengthSq <= 1e-12) {
          continue
        }
        const t = ((endpoint.x - start.x) * dx + (endpoint.y - start.y) * dy) / lengthSq
        if (t <= 1e-6 || t >= 1 - 1e-6) {
          continue
        }
        hitPoint = {
          x: start.x + dx * t,
          y: start.y + dy * t,
        }
        distance = Math.hypot(endpoint.x - hitPoint.x, endpoint.y - hitPoint.y)
      } else if (segment.type === 'arc') {
        const radius = Math.hypot(start.x - segment.center.x, start.y - segment.center.y)
        if (radius <= 1e-9) {
          continue
        }
        const angle = Math.atan2(endpoint.y - segment.center.y, endpoint.x - segment.center.x)
        hitPoint = {
          x: segment.center.x + Math.cos(angle) * radius,
          y: segment.center.y + Math.sin(angle) * radius,
        }
        if (!pointOnArcSegment(segment.center, hitPoint, start, segment.to, segment.clockwise)) {
          continue
        }
        if (pointsNear(hitPoint, start, tolerance) || pointsNear(hitPoint, segment.to, tolerance)) {
          continue
        }
        distance = Math.hypot(endpoint.x - hitPoint.x, endpoint.y - hitPoint.y)
      } else {
        continue
      }

      if (distance > tolerance) {
        continue
      }

      if (!best || distance < best.distance) {
        best = { candidateIndex, segmentIndex, point: hitPoint, distance }
      }
    }
  }

  return best
}

function splitShapesAtInteriorHits(shapes: ImportedShape[], tolerance: number, allowCrossLayerJoins: boolean): ImportedShape[] {
  const splitShapes = [...shapes]
  let changed = true

  while (changed) {
    changed = false

    for (let shapeIndex = 0; shapeIndex < splitShapes.length; shapeIndex += 1) {
      const shape = splitShapes[shapeIndex]
      if (shape.profile.closed) {
        continue
      }

      const endpoints = [shape.profile.start, profileEnd(shape.profile)]
      for (const endpoint of endpoints) {
        const hit = bestInteriorSegmentHit(endpoint, shapeIndex, splitShapes, tolerance, allowCrossLayerJoins)
        if (!hit) {
          continue
        }

        const target = splitShapes[hit.candidateIndex]
        const split = splitProfileAtSegment(target.profile, hit.segmentIndex, hit.point, tolerance)
        if (!split) {
          continue
        }

        const [leftProfile, rightProfile] = split
        const replacementShapes: ImportedShape[] = [
          { ...target, profile: leftProfile },
          { ...target, profile: rightProfile },
        ]
        splitShapes.splice(hit.candidateIndex, 1, ...replacementShapes)
        changed = true
        break
      }

      if (changed) {
        break
      }
    }
  }

  return splitShapes
}

function stitchShapes(shapes: ImportedShape[], tolerance: number, allowCrossLayerJoins: boolean): ImportedShape[] {
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
      const nextMerge = bestOpenProfileMergeCandidate(current, shapes, consumed, tolerance, allowCrossLayerJoins)
      if (!nextMerge) {
        changed = false
        continue
      }

      current = nextMerge.merge(current, shapes[nextMerge.candidateIndex])
      consumed.add(nextMerge.candidateIndex)
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

function repeatedPoints(entity: DxfEntity, xCode: number, yCode: number): Point[] {
  const points: Point[] = []

  for (let index = 0; index < entity.pairs.length; index += 1) {
    const pair = entity.pairs[index]
    if (pair.code !== xCode) {
      continue
    }

    const x = Number.parseFloat(pair.value)
    const yPair = entity.pairs.slice(index + 1).find((entry) => entry.code === yCode)
    const y = yPair ? Number.parseFloat(yPair.value) : 0
    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ x, y })
    }
  }

  return points
}

function repeatedNumbers(entity: DxfEntity, code: number): number[] {
  return entity.pairs
    .filter((pair) => pair.code === code)
    .map((pair) => Number.parseFloat(pair.value))
    .filter((value) => Number.isFinite(value))
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

function findKnotSpan(n: number, degree: number, parameter: number, knots: number[]): number {
  if (parameter >= knots[n + 1]) {
    return n
  }
  if (parameter <= knots[degree]) {
    return degree
  }

  let low = degree
  let high = n + 1
  let mid = Math.floor((low + high) / 2)

  while (parameter < knots[mid] || parameter >= knots[mid + 1]) {
    if (parameter < knots[mid]) {
      high = mid
    } else {
      low = mid
    }
    mid = Math.floor((low + high) / 2)
  }

  return mid
}

function evaluateSplinePoint(
  controlPoints: Point[],
  knots: number[],
  degree: number,
  parameter: number,
  weights: number[],
): Point | null {
  const n = controlPoints.length - 1
  if (n < degree || knots.length < controlPoints.length + degree + 1) {
    return null
  }

  const span = findKnotSpan(n, degree, parameter, knots)
  const deBoor = Array.from({ length: degree + 1 }, (_, offset) => {
    const index = span - degree + offset
    const weight = weights[index] ?? 1
    return {
      x: controlPoints[index].x * weight,
      y: controlPoints[index].y * weight,
      w: weight,
    }
  })

  for (let level = 1; level <= degree; level += 1) {
    for (let index = degree; index >= level; index -= 1) {
      const knotIndex = span - degree + index
      const denominator = knots[knotIndex + degree - level + 1] - knots[knotIndex]
      const alpha = Math.abs(denominator) <= 1e-12 ? 0 : (parameter - knots[knotIndex]) / denominator
      deBoor[index] = {
        x: (1 - alpha) * deBoor[index - 1].x + alpha * deBoor[index].x,
        y: (1 - alpha) * deBoor[index - 1].y + alpha * deBoor[index].y,
        w: (1 - alpha) * deBoor[index - 1].w + alpha * deBoor[index].w,
      }
    }
  }

  const result = deBoor[degree]
  if (Math.abs(result.w) <= 1e-12) {
    return null
  }

  return {
    x: result.x / result.w,
    y: result.y / result.w,
  }
}

function sampledSplinePoints(entity: DxfEntity): Point[] | null {
  const controlPoints = repeatedPoints(entity, 10, 20)
  const fitPoints = repeatedPoints(entity, 11, 21)
  const degree = Math.max(1, Math.round(pairNumber(entity, 71, 3)))
  const knots = repeatedNumbers(entity, 40)
  const rawWeights = repeatedNumbers(entity, 41)

  if (controlPoints.length >= 2 && degree < controlPoints.length && knots.length >= controlPoints.length + degree + 1) {
    const normalizedWeights = controlPoints.map((_, index) => rawWeights[index] ?? 1)
    const n = controlPoints.length - 1
    const domainStart = knots[degree]
    const domainEnd = knots[n + 1]
    if (Number.isFinite(domainStart) && Number.isFinite(domainEnd) && domainEnd > domainStart) {
      const points: Point[] = []

      for (let index = degree; index <= n; index += 1) {
        const spanStart = knots[index]
        const spanEnd = knots[index + 1]
        if (!Number.isFinite(spanStart) || !Number.isFinite(spanEnd) || spanEnd - spanStart <= 1e-12) {
          continue
        }

        const stepCount = degree <= 1 ? 1 : SPLINE_SAMPLES_PER_SPAN
        const startStep = points.length === 0 ? 0 : 1
        for (let step = startStep; step <= stepCount; step += 1) {
          const parameter = step === stepCount && index === n
            ? domainEnd
            : spanStart + ((spanEnd - spanStart) * step) / stepCount
          const point = evaluateSplinePoint(controlPoints, knots, degree, parameter, normalizedWeights)
          if (point) {
            points.push(point)
          }
        }
      }

      const deduped = dedupeConsecutivePoints(points)
      if (deduped.length >= 2) {
        return deduped
      }
    }
  }

  const fallbackPoints = fitPoints.length >= 2 ? fitPoints : controlPoints
  const dedupedFallback = dedupeConsecutivePoints(fallbackPoints)
  return dedupedFallback.length >= 2 ? dedupedFallback : null
}

function splineEntityProfile(entity: DxfEntity): SketchProfile | null {
  const flags = Math.round(pairNumber(entity, 70, 0))
  const closed = (flags & 1) === 1
  const points = sampledSplinePoints(entity)
  if (!points) {
    return null
  }

  const normalizedPoints = closed && points.length > 2 && pointsNear(points[0], points[points.length - 1], 1e-9)
    ? points.slice(0, -1)
    : points

  return lineStripProfile(normalizedPoints, closed)
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
    case 'SPLINE': {
      const profile = splineEntityProfile(entity)
      if (!profile) {
        warnings.push('Skipped unsupported or empty DXF SPLINE entity.')
        return []
      }
      return finalize(profile, layerName || 'Spline')
    }
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
  const joinTolerance = Number.isFinite(context.joinTolerance) && (context.joinTolerance ?? 0) >= 0
    ? context.joinTolerance as number
    : defaultJoinTolerance(context.targetUnits)
  const allowCrossLayerJoins = context.allowCrossLayerJoins ?? false
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

  return {
    shapes: stitchShapes(
      splitShapesAtInteriorHits(dedupeIdenticalShapes(shapes), joinTolerance, allowCrossLayerJoins),
      joinTolerance,
      allowCrossLayerJoins,
    ),
    warnings,
  }
}
