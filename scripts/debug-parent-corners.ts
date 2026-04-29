/**
 * Debug parent corner detection and bridge logic for letter A split sites.
 * Checks angles at each parent corner and traces why bridges fail.
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
const tol = Math.max(1e-4, stepSize * 0.25)
console.log('stepSize:', stepSize, 'tol:', tol)

// Constants matching vcarveRecursive.ts
const CORNER_SMOOTHING_FRACTION = 0.25
const MIN_CORNER_SMOOTHING_DISTANCE = 1e-4
const CORNER_ANGLE_THRESHOLD_RAD = (15 * Math.PI) / 180
const CORNER_ANGLE_THRESHOLD_DEG = 15

function cornerSmoothingDistance(s: number): number {
  return Math.max(MIN_CORNER_SMOOTHING_DISTANCE, s * CORNER_SMOOTHING_FRACTION)
}

function findSplit(region: ResolvedPocketRegion, depth: number): { depth: number; parent: ResolvedPocketRegion; children: ResolvedPocketRegion[] } | null {
  if (depth > 80) return null
  const next = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)
  if (next.length > 1) return { depth, parent: region, children: next }
  if (next.length === 1) return findSplit(next[0], depth + 1)
  return null
}

function rawCornerTurnRadians(contour: Point[], target: Point): number {
  const n = contour.length
  if (n < 3) return 0
  let bestIdx = 0
  let bestDistSq = Infinity
  for (let i = 0; i < n; i += 1) {
    const dx = contour[i].x - target.x
    const dy = contour[i].y - target.y
    const distSq = dx * dx + dy * dy
    if (distSq < bestDistSq) { bestDistSq = distSq; bestIdx = i }
  }
  const prev = contour[(bestIdx - 1 + n) % n]
  const curr = contour[bestIdx]
  const next = contour[(bestIdx + 1) % n]
  const dx1 = curr.x - prev.x
  const dy1 = curr.y - prev.y
  const dx2 = next.x - curr.x
  const dy2 = next.y - curr.y
  const len1 = Math.hypot(dx1, dy1)
  const len2 = Math.hypot(dx2, dy2)
  if (len1 < 1e-12 || len2 < 1e-12) return 0
  const cos = (dx1 * dx2 + dy1 * dy2) / (len1 * len2)
  return Math.acos(Math.max(-1, Math.min(1, cos)))
}

function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i]
    const pj = polygon[j]
    const intersects = ((pi.y > y) !== (pj.y > y))
      && (x < (((pj.x - pi.x) * (y - pi.y)) / ((pj.y - pi.y) || 1e-12)) + pi.x)
    if (intersects) inside = !inside
  }
  return inside
}

function segmentSamplesStayInsideContour(a: Point, b: Point, contour: Point[]): boolean {
  for (const t of [0.25, 0.5, 0.75]) {
    const sampleX = a.x + ((b.x - a.x) * t)
    const sampleY = a.y + ((b.y - a.y) * t)
    if (!pointInPolygon(sampleX, sampleY, contour)) return false
  }
  return true
}

const resolved = resolvePocketRegions(project, operation)
console.log(`Bands: ${resolved.bands.length}`)

for (let bi = 0; bi < resolved.bands.length; bi++) {
  const band = resolved.bands[bi]
  console.log(`\n=== Band ${bi}: topZ=${band.topZ}, bottomZ=${band.bottomZ}, regions=${band.regions.length} ===`)
  
  band.regions.forEach((region, idx) => {
    const split = findSplit(region, 0)
    if (!split) {
      console.log(`  region=${idx}: no split found`)
      return
    }
    
    // Use detectCorners with smoothing = 0 to find corners on RAW contour
    // This bypasses the internal raw-angle validation
    const parentCorners = detectCorners(split.parent.outer, tol)
    const parentCornersNoSmooth = detectCorners(split.parent.outer, 0)
    const childCornerSets = split.children.map((c) => detectCorners(c.outer, tol))
    
    console.log(`  region=${idx} split at depth=${split.depth} parentPolyLen=${split.parent.outer.length}`)
    console.log(`  parentCorners (with smoothing): ${parentCorners.length}`)
    console.log(`  parentCorners (no smoothing): ${parentCornersNoSmooth.length}`)
    
    // For each corner found with smoothing, check raw angle validation
    console.log('  Parent corners (with smoothing) - angle analysis:')
    parentCorners.forEach((p, i) => {
      const rawAngle = rawCornerTurnRadians(split.parent.outer, p)
      const rawDeg = rawAngle * 180 / Math.PI
      const passesRawCheck = rawDeg > CORNER_ANGLE_THRESHOLD_DEG
      
      console.log(`    [${i}] (${p.x.toFixed(4)}, ${p.y.toFixed(4)}) raw=${rawDeg.toFixed(2)}° ${passesRawCheck ? '' : '**FAILS raw-angle validation - would be filtered by detectCorners**'}`)
    })
    
    // Show corners found WITHOUT smoothing (raw contour)
    console.log('  Parent corners (no smoothing) - includes all convex corners:')
    parentCornersNoSmooth.forEach((p, i) => {
      const rawAngle = rawCornerTurnRadians(split.parent.outer, p)
      const rawDeg = rawAngle * 180 / Math.PI
      const passesRawCheck = rawDeg > CORNER_ANGLE_THRESHOLD_DEG
      console.log(`    [${i}] (${p.x.toFixed(4)}, ${p.y.toFixed(4)}) raw=${rawDeg.toFixed(2)}° ${passesRawCheck ? '' : 'FILTERED_BY_RAW_CHECK'}`)
    })
    
    childCornerSets.forEach((set, ci) => {
      console.log(`  child${ci} corners=${set.length}`)
      set.forEach((c) => {
        const rawAngle = rawCornerTurnRadians(split.children[ci].outer, c)
        const rawDeg = rawAngle * 180 / Math.PI
        console.log(`    (${c.x.toFixed(4)}, ${c.y.toFixed(4)}) raw=${rawDeg.toFixed(2)}°`)
      })
    })
    
    // Direct-connect check using RAW parent contour for containment
    console.log(`  Direct-connect check (budget=${(stepSize * 4).toFixed(4)}):`)
    let bridgeCount = 0
    for (const p of parentCorners) {
      for (let ci = 0; ci < split.children.length; ci++) {
        for (const c of childCornerSets[ci]) {
          const dist = Math.hypot(c.x - p.x, c.y - p.y)
          if (dist > stepSize * 4 || dist < 1e-9) continue
          // Use RAW parent contour for containment (like bridgeSplitArms does with logicCurrentContour)
          const inside = segmentSamplesStayInsideContour(p, c, split.parent.outer)
          bridgeCount++
          console.log(`    parent(${p.x.toFixed(4)},${p.y.toFixed(4)}) -> child${ci}(${c.x.toFixed(4)},${c.y.toFixed(4)}) dist=${dist.toFixed(4)} inside=${inside} ${inside ? 'WOULD_CONNECT' : 'OUTSIDE_PARENT'}`)
        }
      }
    }
    console.log(`  Matching parent→child pairs within budget: ${bridgeCount}`)
  })
}
