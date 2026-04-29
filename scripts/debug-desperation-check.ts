/**
 * Debug why the desperation fallback fails for arm (2.6081, 1.5195).
 * Checks containment of the segment from arm to nearest child corner.
 */
import ClipperLib from 'clipper-lib'
import fs from 'node:fs'
import { detectCorners } from '../src/engine/toolpaths/vcarveRecursive.ts'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import type { Operation, Point, Project } from '../src/types/project.ts'
import type { ResolvedPocketRegion } from '../src/engine/toolpaths/types.ts'

const PROJECT_PATH = process.env.CAMJ_PATH ?? '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === 'op0008') as Operation
const stepSize = operation.stepover

const CORNER_SMOOTHING_FRACTION = 0.25
const MIN_CORNER_SMOOTHING_DISTANCE = 1e-4

function cornerSmoothingDistance(s: number): number {
  return Math.max(MIN_CORNER_SMOOTHING_DISTANCE, s * CORNER_SMOOTHING_FRACTION)
}

function simplifyOpenPolyline(points: Point[], distanceTolerance: number): Point[] {
  if (points.length <= 2) return points.slice()
  let maxDist = 0; let maxIdx = 0
  const first = points[0]; const last = points[points.length - 1]
  for (let i = 1; i < points.length - 1; i++) {
    const dx = last.x - first.x; const dy = last.y - first.y
    const span = Math.hypot(dx, dy)
    const area2 = Math.abs(dx * (points[i].y - first.y) - dy * (points[i].x - first.x))
    const dist = span > 1e-12 ? area2 / span : Math.hypot(points[i].x - first.x, points[i].y - first.y)
    if (dist > maxDist) { maxDist = dist; maxIdx = i }
  }
  if (maxDist > distanceTolerance) {
    const left = simplifyOpenPolyline(points.slice(0, maxIdx + 1), distanceTolerance)
    const right = simplifyOpenPolyline(points.slice(maxIdx), distanceTolerance)
    return [...left.slice(0, -1), ...right]
  }
  return [first, last]
}

function sliceWrapped(points: Point[], startIndex: number, endIndex: number): Point[] {
  const result: Point[] = []; let i = startIndex
  while (i !== endIndex) { result.push(points[i]); i = (i + 1) % points.length }
  result.push(points[endIndex]); return result
}

function simplifyClosedContour(points: Point[], distanceTolerance: number): Point[] {
  if (points.length < 4) return points.slice()
  let startIndex = 0, endIndex = 1, bestDistance = -1
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[j].x - points[i].x, points[j].y - points[i].y)
      if (d > bestDistance) { bestDistance = d; startIndex = i; endIndex = j }
    }
  const forward = simplifyOpenPolyline(sliceWrapped(points, startIndex, endIndex), distanceTolerance)
  const backward = simplifyOpenPolyline(sliceWrapped(points, endIndex, startIndex), distanceTolerance)
  const simplified = [...forward.slice(0, -1), ...backward.slice(0, -1)]
  return simplified.length >= 3 ? simplified : points.slice()
}

function simplifyContourForCornerDetection(contour: Point[], distanceTolerance: number): Point[] {
  if (contour.length < 4 || !(distanceTolerance > 0)) return contour
  let simplified = simplifyClosedContour(contour, distanceTolerance)
  for (;;) {
    if (simplified.length <= 3) return simplified
    let changed = false; const next: Point[] = []
    for (let i = 0; i < simplified.length; i++) {
      const prev = simplified[(i - 1 + simplified.length) % simplified.length]
      const curr = simplified[i]
      const after = simplified[(i + 1) % simplified.length]
      const lenPrev = Math.hypot(curr.x - prev.x, curr.y - prev.y)
      const lenNext = Math.hypot(after.x - curr.x, after.y - curr.y)
      const span = Math.hypot(after.x - prev.x, after.y - prev.y)
      const area2 = Math.abs((after.x - prev.x) * (curr.y - prev.y) - (after.y - prev.y) * (curr.x - prev.x))
      const deviation = span > 1e-9 ? area2 / span : 0
      const hasShortEdge = lenPrev <= distanceTolerance || lenNext <= distanceTolerance
      const isTinyKink = deviation <= distanceTolerance * 0.35 && Math.min(lenPrev, lenNext) <= distanceTolerance * 4
      const isNeedle = span <= distanceTolerance && Math.max(lenPrev, lenNext) <= distanceTolerance * 2
      if (simplified.length > 3 && (hasShortEdge || isTinyKink || isNeedle)) { changed = true; continue }
      next.push(curr)
    }
    if (!changed || next.length < 3) return simplified
    simplified = next
  }
}

function recursiveLogicContour(contour: Point[], stepSize: number): Point[] {
  return simplifyContourForCornerDetection(contour, cornerSmoothingDistance(stepSize))
}

function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i++) {
    const pi = polygon[i]; const pj = polygon[j]
    const intersects = ((pi.y > y) !== (pj.y > y))
      && (x < (((pj.x - pi.x) * (y - pi.y)) / ((pj.y - pi.y) || 1e-12)) + pi.x)
    if (intersects) inside = !inside
  }
  return inside
}

function segmentSamplesStayInsideContour(a: Point, b: Point, contour: Point[]): boolean {
  for (const t of [0.25, 0.5, 0.75]) {
    const sx = a.x + ((b.x - a.x) * t)
    const sy = a.y + ((b.y - a.y) * t)
    const inside = pointInPolygon(sx, sy, contour)
    console.log(`  t=${t} pt=(${sx.toFixed(4)},${sy.toFixed(4)}) inside=${inside}`)
    if (!inside) return false
  }
  return true
}

function findSplit(region: ResolvedPocketRegion, depth: number): { depth: number; parent: ResolvedPocketRegion; children: ResolvedPocketRegion[] } | null {
  if (depth > 80) return null
  const next = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)
  if (next.length > 1) return { depth, parent: region, children: next }
  if (next.length === 1) return findSplit(next[0], depth + 1)
  return null
}

const resolved = resolvePocketRegions(project, operation)
for (const band of resolved.bands) {
  band.regions.forEach((region, idx) => {
    const split = findSplit(region, 0)
    if (!split) return
    
    const parentRaw = split.parent.outer
    const childRawList = split.children.map(c => c.outer)
    const logicParentContour = recursiveLogicContour(parentRaw, stepSize)
    
    const armPt: Point = { x: 2.6081, y: 1.5195 }
    
    console.log(`=== depth=${split.depth} children=${split.children.length} ===`)
    console.log(`parentRaw vertices: ${parentRaw.length}`)
    console.log(`parentLogic vertices: ${logicParentContour.length}`)
    
    // Check child2 corners
    if (split.children.length >= 3) {
      const child2 = childRawList[2]
      const logicChild2 = recursiveLogicContour(child2, stepSize)
      const child2Corners = detectCorners(logicChild2, cornerSmoothingDistance(stepSize))
      
      console.log(`\nchild2 corners (${child2Corners.length}):`)
      for (let i = 0; i < child2Corners.length; i++) {
        const c = child2Corners[i]
        const dx = c.x - armPt.x; const dy = c.y - armPt.y
        const dist = Math.hypot(dx, dy)
        const insideRaw = pointInPolygon(c.x, c.y, parentRaw)
        const insideLogic = pointInPolygon(c.x, c.y, logicParentContour)
        console.log(`  [${i}] (${c.x.toFixed(4)},${c.y.toFixed(4)}) dist=${dist.toFixed(4)} insideRaw=${insideRaw} insideLogic=${insideLogic}`)
        console.log(`  segment from arm (raw contour):`)
        segmentSamplesStayInsideContour(armPt, c, parentRaw)
        console.log(`  segment from arm (logic contour):`)
        segmentSamplesStayInsideContour(armPt, c, logicParentContour)
      }
    }
    
    // Also check all pooled corners
    console.log(`\nAll child corners inside parent logic contour:`)
    for (let ci = 0; ci < split.children.length; ci++) {
      const logicChild = recursiveLogicContour(childRawList[ci], stepSize)
      const corners = detectCorners(logicChild, cornerSmoothingDistance(stepSize))
      for (const c of corners) {
        const inside = pointInPolygon(c.x, c.y, logicParentContour)
        if (!inside) {
          console.log(`  child${ci} corner (${c.x.toFixed(4)},${c.y.toFixed(4)}) is OUTSIDE parent logic contour!`)
        }
      }
    }
    
    // Check the arm point itself
    console.log(`\narmPt (${armPt.x.toFixed(4)},${armPt.y.toFixed(4)}):`)
    console.log(`  inside raw: ${pointInPolygon(armPt.x, armPt.y, parentRaw)}`)
    console.log(`  inside logic: ${pointInPolygon(armPt.x, armPt.y, logicParentContour)}`)
  })
}
