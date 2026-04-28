/**
 * Trace what traceRegion emits for the 'o' shape at each recursion level.
 * Instrument the path emission to tag each path with its source.
 * Run: npx tsx scripts/trace-o-emission.ts
 */
import fs from 'node:fs'
import ClipperLib from 'clipper-lib'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import type { Operation, Project, Point } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find(o => o.id === 'op0046')!

const toolRecord = project.tools.find(t => t.id === operation.toolRef)!
const slope = Math.tan((toolRecord.vBitAngle! * Math.PI) / 360)
const topZ = project.stock.thickness
const maxDepth = operation.maxCarveDepth
const stepSize = operation.stepover

console.log(`slope=${slope.toFixed(4)} topZ=${topZ} maxDepth=${maxDepth} stepSize=${stepSize}`)

const resolved = resolvePocketRegions(project, operation)
const band = resolved.bands[0]
const region = band.regions[0]

console.log(`\nRegion: outer=${region.outer.length} vertices, islands=${region.islands?.length ?? 0}`)

// Simulate the recursion manually for the first 15 levels
// to see what gets emitted at each level
let currentRegion = region
let totalOffset = 0
let depth = 0

console.log('\n=== Recursion trace (first 20 levels) ===')
console.log('Format: depth | totalOffset | currentZ | nextRegions | emission')

for (let d = 0; d < 20; d++) {
  const currentZ = topZ - Math.min(maxDepth, totalOffset / slope)
  const nextOffset = totalOffset + stepSize
  const nextZ = topZ - Math.min(maxDepth, nextOffset / slope)
  const nextRegions = buildInsetRegions(currentRegion, stepSize, ClipperLib.JoinType.jtRound)

  // Detect corners on current contour
  // (simplified: just count vertices as proxy for corner detection)
  const outerVerts = currentRegion.outer.length

  let emission = ''
  if (nextRegions.length === 0) {
    emission = 'COLLAPSE → contourToPath3D at microZ'
  } else if (nextRegions.length > 1) {
    emission = `SPLIT → ${nextRegions.length} children`
  } else {
    // CONTINUE: stepArms emits arm segments, then contourToPath3D is NOT called
    // But we're seeing flat contours... where do they come from?
    // Check: does buildFreshSeedBootstrapCuts or buildInteriorCornerBridge emit contours?
    emission = `CONTINUE → stepArms (arm segs only, no contour)`
  }

  console.log(`  d=${d} offset=${totalOffset.toFixed(4)} currentZ=${currentZ.toFixed(4)} nextZ=${nextZ.toFixed(4)} outerVerts=${outerVerts} nextRegions=${nextRegions.length} | ${emission}`)

  if (nextRegions.length === 0) break
  if (nextRegions.length > 1) break
  currentRegion = nextRegions[0]
  totalOffset = nextOffset
}

// Key question: in the CONTINUE case, what emits the flat contour segments?
// Looking at traceRegion CONTINUE branch:
//   1. stepArms → emits 2-point arm segments (diagonal)
//   2. buildFreshSeedBootstrapCuts → emits 2-point arm segments (diagonal)
//   3. buildInteriorCornerBridge → emits 2-point flat segments IF corners exist
//   4. traceRegion recurse
// None of these emit flat contour rings.
//
// But the collapse handler DOES:
//   emitCollapseGeometry → contourToPath3D(r.outer, microZ) → flat ring
//
// So the flat rings only come from collapse. But we see flat rings at 10 different Z levels.
// This means the collapse is happening at 10 different Z levels — i.e. the shape
// collapses into multiple sub-regions at different depths.
//
// Wait — for 'o' (a ring with a hole), the outer band collapses from both sides.
// The outer contour shrinks inward AND the inner hole grows outward.
// At some point they meet and the band collapses.
// But this should be a single collapse event, not 10.
//
// Unless... the flat segments are NOT from collapse contours but from the
// COLLAPSE CONTOUR being chained with arm segments by chainPaths.
// The collapse contour is a closed ring (length > 2) so it should be in 'contours'.
// But if it gets simplified to 2 points by simplifyPath3DCollinear, it becomes an 'arm'.

console.log('\n=== Checking if flat segments are from collapse contours ===')
console.log('The 10 distinct Z levels of flat segments match the 10 offset levels')
console.log('from the deepest point (0.5231) up to the maxDepth level (0.6634).')
console.log('This is NOT 10 separate collapses — it is ONE collapse contour')
console.log('being chained with arm segments from 10 different offset levels.')
console.log()
console.log('The collapse contour is a closed ring at the deepest Z (0.5231).')
console.log('But the flat segments appear at Z=0.5248, 0.5422, 0.5595, ... 0.6634.')
console.log('These are NOT the collapse Z — they are the Z levels of the ARM SEGMENTS.')
console.log()
console.log('CONCLUSION: The flat segments are the CONTOUR WALKS between arm segments.')
console.log('Each arm segment connects two offset levels (Z_n → Z_{n+1}).')
console.log('Between arm segments, the tool walks along the offset ring at Z_n.')
console.log('This walk is emitted as flat contour segments by... what?')
console.log()
console.log('Looking at the XY positions of the flat segments:')
console.log('They trace the circumference of the o shape at each Z level.')
console.log('This means they ARE the offset contours — but who emits them?')
console.log()
console.log('In traceRegion CONTINUE, only arm segments are emitted (2-point cuts).')
console.log('The flat contour walks must come from the COLLAPSE CONTOUR being')
console.log('chained with the arm segments via chainPaths.')
console.log()
console.log('But the collapse contour is a closed ring (many points) — it should')
console.log('be in the contours bucket, not the arms bucket.')
console.log()
console.log('UNLESS: the flat segments are the INTERIOR CORNER BRIDGE segments.')
console.log('buildInteriorCornerBridge emits 2-point flat segments connecting')
console.log('two corners at the same Z level.')
console.log('For o (no corners), this should not fire.')
console.log()
console.log('OR: the flat segments come from the rescue path walking along the')
console.log('contour at a fixed Z before finding the next corner.')
