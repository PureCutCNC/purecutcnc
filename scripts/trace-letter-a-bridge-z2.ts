/**
 * Verify that using min-distance-to-wall instead of channel half-width
 * gives the correct Z for the bridge midpoint in letter A.
 * Run: npx tsx scripts/trace-letter-a-bridge-z2.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project, Point } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === 'op0008') as Operation

const toolRecord = project.tools.find((t) => t.id === operation.toolRef)!
const slope = Math.tan((toolRecord.vBitAngle! * Math.PI) / 360)
const topZ = project.stock.thickness
const maxCarveDepth = operation.maxCarveDepth
const minZ = topZ - maxCarveDepth

console.log(`slope=${slope.toFixed(6)} topZ=${topZ} minZ=${minZ}`)

// Minimum distance from a point to any segment of a set of contours
function minDistToWalls(point: Point, contours: Point[][]): number {
  let best = Infinity
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i]
      const b = contour[(i + 1) % contour.length]
      const abx = b.x - a.x
      const aby = b.y - a.y
      const lenSq = abx * abx + aby * aby
      if (lenSq < 1e-18) continue
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / lenSq))
      const px = a.x + abx * t
      const py = a.y + aby * t
      const d = Math.hypot(point.x - px, point.y - py)
      if (d < best) best = d
    }
  }
  return best
}

// The deep bridge path visits xy around (2.96, 1.58) based on moves [73..75].
// Let's compute what Z SHOULD be at those points using min-dist-to-wall.
// We need the parent contour at the split moment.
// The parent contour is the outer shape of letter A at the offset level just before split.
// We can approximate it from the move data: the split bridge path starts at
// the plunge point (2.9599, 1.5791) which is on the parent contour.

// From the project, find the letter A feature contour
const result = generateVCarveRecursiveToolpath(project, operation)
const moves = result.moves

// The bridge path is moves [73..77]. The probe points are:
const bridgePoints: Point[] = [
  { x: moves[73].to.x, y: moves[73].to.y },  // z=0.3760 (wrong)
  { x: moves[74].to.x, y: moves[74].to.y },  // z=0.3760 (wrong)
  { x: moves[75].to.x, y: moves[75].to.y },  // z=0.3760 (wrong)
  { x: moves[76].to.x, y: moves[76].to.y },  // z=0.5134 (rising back)
]

console.log('\n=== Bridge path points and their actual Z vs expected Z ===')
console.log('(Expected Z = topZ - minDistToWall / slope, clamped to [minZ, topZ])')
console.log('Using the letter A outer contour from the project features...\n')

// Get the letter A feature sketch profile
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
const resolved = resolvePocketRegions(project, operation)

console.log(`Resolved bands: ${resolved.bands.length}`)
for (const band of resolved.bands) {
  console.log(`  band topZ=${band.topZ} bottomZ=${band.bottomZ} regions=${band.regions.length}`)
  for (const region of band.regions) {
    console.log(`  region outer vertices=${region.outer.length} islands=${region.islands?.length ?? 0}`)

    const contours = [region.outer, ...(region.islands ?? [])]

    for (const pt of bridgePoints) {
      const minDist = minDistToWalls(pt, contours)
      const expectedZ = Math.max(minZ, Math.min(topZ, topZ - minDist / slope))
      const actualZ = moves.find(m => Math.hypot(m.to.x - pt.x, m.to.y - pt.y) < 0.001)?.to.z ?? NaN
      console.log(`  pt=(${pt.x.toFixed(4)},${pt.y.toFixed(4)}): minDist=${minDist.toFixed(4)} expectedZ=${expectedZ.toFixed(4)} actualZ=${actualZ.toFixed(4)} error=${(actualZ - expectedZ).toFixed(4)}`)
    }
  }
}

// Now check: what does the channel half-width give vs min-dist for these points?
console.log('\n=== Channel half-width vs min-dist-to-wall comparison ===')
console.log('The channel half-width (used by bridgeSiblingChildren) measures the')
console.log('perpendicular distance to the nearest wall PAIR, which for a wide shape')
console.log('gives the full band width. Min-dist-to-wall gives the correct inscribed')
console.log('circle radius — the actual V-carve depth at that XY point.')
console.log('')
console.log('The Z formula should be:')
console.log('  correctZ = topZ - minDistToWall(probe, parentContours) / slope')
console.log('NOT:')
console.log('  wrongZ = currentZ - channelHalfWidth / slope')
console.log('')
console.log('The currentZ reference is wrong because it is the Z of the parent contour')
console.log('EDGE, not the Z of the material surface (topZ). The V-carve depth formula')
console.log('always measures from the material surface (topZ), not from the current')
console.log('offset level.')
