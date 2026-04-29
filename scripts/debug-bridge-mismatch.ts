/**
 * Debug why bridgeSplitArms emits 0 bridges at the depth-5 split for letter A.
 * Exactly mimics the bridgeSplitArms logic:
 *   - Uses simplified (logic) parent contour for containment check
 *   - Detects child corners on simplified child contours
 *   - Checks what activeArms (from splitSourceArms) would be
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

console.log('=== BridgeSplitArms Mismatch Debug ===')
console.log('stepSize:', stepSize)

// ---- Constants matching vcarveRecursive.ts ----
const CORNER_SMOOTHING_FRACTION = 0.25
const MIN_CORNER_SMOOTHING_DISTANCE = 1e-4
const CORNER_SMOOTHING = Math.max(MIN_CORNER_SMOOTHING_DISTANCE, stepSize * CORNER_SMOOTHING_FRACTION)

function cornerSmoothingDistance(s: number): number {
  return Math.max(MIN_CORNER_SMOOTHING_DISTANCE, s * CORNER_SMOOTHING_FRACTION)
}

// ---- Inline simplifyOpenPolyline (used by simplifyClosedContour) ----
function simplifyOpenPolyline(points: Point[], distanceTolerance: number): Point[] {
  if (points.length <= 2) return points.slice()
  let maxDist = 0
  let maxIdx = 0
  const first = points[0]
  const last = points[points.length - 1]
  for (let i = 1; i < points.length - 1; i++) {
    const dx = last.x - first.x
    const dy = last.y - first.y
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
  const result: Point[] = []
  let i = startIndex
  while (i !== endIndex) {
    result.push(points[i])
    i = (i + 1) % points.length
  }
  result.push(points[endIndex])
  return result
}

function simplifyClosedContour(points: Point[], distanceTolerance: number): Point[] {
  if (points.length < 4) return points.slice()
  let startIndex = 0, endIndex = 1, bestDistance = -1
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[j].x - points[i].x, points[j].y - points[i].y)
      if (d > bestDistance) { bestDistance = d; startIndex = i; endIndex = j }
    }
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
    let changed = false
    const next: Point[] = []
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
      if (simplified.length > 3 && (hasShortEdge || isTinyKink || isNeedle)) {
        changed = true
        continue
      }
      next.push(curr)
    }
    if (!changed || next.length < 3) return simplified
    simplified = next
  }
}

function recursiveLogicContour(contour: Point[], stepSize: number): Point[] {
  return simplifyContourForCornerDetection(contour, cornerSmoothingDistance(stepSize))
}

// ---- Helpers ----
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
    if (!pointInPolygon(sx, sy, contour)) return false
  }
  return true
}

function rawCornerTurnRadians(contour: Point[], target: Point): number {
  const n = contour.length
  if (n < 3) return 0
  let bestIdx = 0; let bestDistSq = Infinity
  for (let i = 0; i < n; i++) {
    const dx = contour[i].x - target.x; const dy = contour[i].y - target.y
    const distSq = dx * dx + dy * dy
    if (distSq < bestDistSq) { bestDistSq = distSq; bestIdx = i }
  }
  const prev = contour[(bestIdx - 1 + n) % n]
  const curr = contour[bestIdx]
  const next = contour[(bestIdx + 1) % n]
  const dx1 = curr.x - prev.x; const dy1 = curr.y - prev.y
  const dx2 = next.x - curr.x; const dy2 = next.y - curr.y
  const len1 = Math.hypot(dx1, dy1); const len2 = Math.hypot(dx2, dy2)
  if (len1 < 1e-12 || len2 < 1e-12) return 0
  const cos = (dx1 * dx2 + dy1 * dy2) / (len1 * len2)
  return Math.acos(Math.max(-1, Math.min(1, cos)))
}

const CORNER_ANGLE_THRESHOLD_RAD = (15 * Math.PI) / 180

// ---- Find split ----
function findSplit(region: ResolvedPocketRegion, depth: number): { depth: number; parent: ResolvedPocketRegion; children: ResolvedPocketRegion[] } | null {
  if (depth > 80) return null
  const next = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)
  if (next.length > 1) return { depth, parent: region, children: next }
  if (next.length === 1) return findSplit(next[0], depth + 1)
  return null
}

const resolved = resolvePocketRegions(project, operation)

for (let bi = 0; bi < resolved.bands.length; bi++) {
  const band = resolved.bands[bi]
  band.regions.forEach((region, idx) => {
    const split = findSplit(region, 0)
    if (!split) return

    const parentRaw = split.parent.outer
    const childRawList = split.children.map((c) => c.outer)

    // === STEP 1: What bridgeSplitArms actually does ===
    const logicParentContour = recursiveLogicContour(parentRaw, stepSize)
    const logicChildContours = childRawList.map((c) => recursiveLogicContour(c, stepSize))

    console.log(`\n========== Split at depth=${split.depth} ==========`)
    console.log(`Parent raw vertices: ${parentRaw.length}`)
    console.log(`Parent logic (simplified) vertices: ${logicParentContour.length}`)
    console.log(`Children: ${split.children.length}`)

    // Child corners detected ON SIMPLIFIED child contours (as bridgeSplitArms does)
    const childCornersOnLogic = logicChildContours.map((logicChild, ci) => {
      const corners = detectCorners(logicChild, cornerSmoothingDistance(stepSize))
      return corners
    })
    console.log('\nChild corners detected ON SIMPLIFIED (logic) child contours:')
    childCornersOnLogic.forEach((set, ci) => {
      console.log(`  child${ci}: ${set.length} corners`)
      set.forEach((c, i) => {
        const rawAngle = rawCornerTurnRadians(childRawList[ci], c)
        console.log(`    [${i}] (${c.x.toFixed(4)}, ${c.y.toFixed(4)}) raw=${(rawAngle*180/Math.PI).toFixed(2)}°`)
      })
    })

    // For comparison: child corners detected ON RAW child contours
    const childCornersOnRaw = childRawList.map((raw, ci) => detectCorners(raw, cornerSmoothingDistance(stepSize)))
    console.log('\nChild corners detected ON RAW child contours (for comparison):')
    childCornersOnRaw.forEach((set, ci) => {
      console.log(`  child${ci}: ${set.length} corners`)
      set.forEach((c, i) => {
        console.log(`    [${i}] (${c.x.toFixed(4)}, ${c.y.toFixed(4)})`)
      })
    })

    // === STEP 2: Pool child corners exactly as bridgeSplitArms does ===
    const pooledCorners: Point[] = []
    const cornerSource = new Map<string, number>()
    const ckey = (p: Point) => `${p.x.toFixed(8)},${p.y.toFixed(8)}`
    childCornersOnLogic.forEach((set, ci) => {
      for (const c of set) {
        pooledCorners.push(c)
        cornerSource.set(ckey(c), ci)
      }
    })
    console.log(`\nPooled child corners (on logic contours): ${pooledCorners.length}`)

    // === STEP 3: Parent arms (what splitSourceArms produces) ===
    const parentCornersOnRaw = detectCorners(parentRaw, cornerSmoothingDistance(stepSize))
    console.log(`\nParent corners on RAW contour: ${parentCornersOnRaw.length}`)
    parentCornersOnRaw.forEach((p, i) => {
      const rawAngle = rawCornerTurnRadians(parentRaw, p)
      console.log(`  [${i}] (${p.x.toFixed(4)}, ${p.y.toFixed(4)}) raw=${(rawAngle*180/Math.PI).toFixed(2)}°`)
    })

    // === STEP 4: Direct-connect check EXACTLY as bridgeSplitArms does ===
    const directBudget = stepSize * 4
    console.log(`\nDirect-connect budget: ${directBudget.toFixed(4)}`)
    console.log(`Containment check uses: logicParentContour (${logicParentContour.length} vertices)`)

    let armConnectCount = 0
    for (const parentCorner of parentCornersOnRaw) {
      const candidates = pooledCorners
        .map((point) => ({ point, dist: Math.hypot(point.x - parentCorner.x, point.y - parentCorner.y) }))
        .filter((c) => c.dist > 1e-9 && c.dist <= directBudget)
        .filter((c) => segmentSamplesStayInsideContour(parentCorner, c.point, logicParentContour))
        .sort((a, b) => a.dist - b.dist)

      if (candidates.length > 0) {
        armConnectCount++
        console.log(`  PARENT (${parentCorner.x.toFixed(4)},${parentCorner.y.toFixed(4)}) -> child${cornerSource.get(ckey(candidates[0].point))} (${candidates[0].point.x.toFixed(4)},${candidates[0].point.y.toFixed(4)}) dist=${candidates[0].dist.toFixed(4)} ✓`)
      } else {
        // Check WHY it failed
        const rawCandidates = pooledCorners
          .map((point) => ({ point, dist: Math.hypot(point.x - parentCorner.x, point.y - parentCorner.y) }))
          .filter((c) => c.dist > 1e-9 && c.dist <= directBudget)

        if (rawCandidates.length === 0) {
          const nearest = pooledCorners.reduce((acc, p) => {
            const d = Math.hypot(p.x - parentCorner.x, p.y - parentCorner.y)
            return d < acc.dist ? { pt: p, dist: d } : acc
          }, { pt: null as Point | null, dist: Infinity })
          console.log(`  PARENT (${parentCorner.x.toFixed(4)},${parentCorner.y.toFixed(4)}) ✗ NO candidates within budget (nearest=${nearest.dist.toFixed(4)})`)
        } else {
          // Within budget but containment check fails
          console.log(`  PARENT (${parentCorner.x.toFixed(4)},${parentCorner.y.toFixed(4)}) ✗ ${rawCandidates.length} candidates within budget but ALL FAIL containment check on logicParentContour:`)
          for (const rc of rawCandidates) {
            // Check on raw contour too for comparison
            const insideRaw = segmentSamplesStayInsideContour(parentCorner, rc.point, parentRaw)
            const insideLogic = segmentSamplesStayInsideContour(parentCorner, rc.point, logicParentContour)
            console.log(`      child${cornerSource.get(ckey(rc.point))} (${rc.point.x.toFixed(4)},${rc.point.y.toFixed(4)}) dist=${rc.dist.toFixed(4)} insideRaw=${insideRaw} insideLogic=${insideLogic}`)
          }
        }
      }
    }
    console.log(`\nArms that WOULD connect in bridgeSplitArms: ${armConnectCount} / ${parentCornersOnRaw.length}`)
  })
}
