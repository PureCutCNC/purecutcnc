/**
 * Instrument traceRegion to tag each emitted path with its source.
 * Run: npx tsx scripts/trace-o-paths.ts
 */
import fs from 'node:fs'
import ClipperLib from 'clipper-lib'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import { detectCorners } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project, Point } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find(o => o.id === 'op0046')!

const toolRecord = project.tools.find(t => t.id === operation.toolRef)!
const slope = Math.tan((toolRecord.vBitAngle! * Math.PI) / 360)
const topZ = project.stock.thickness
const maxDepth = operation.maxCarveDepth
const stepSize = operation.stepover

const resolved = resolvePocketRegions(project, operation)
const band = resolved.bands[0]
const region = band.regions[0]

// Walk to the split point (depth 4, offset 0.04)
let currentRegion = region
for (let d = 0; d < 4; d++) {
  const nextRegions = buildInsetRegions(currentRegion, stepSize, ClipperLib.JoinType.jtRound)
  currentRegion = nextRegions[0]
}
const splitOffset = 0.04
const splitRegions = buildInsetRegions(currentRegion, stepSize, ClipperLib.JoinType.jtRound)
console.log(`At split: ${splitRegions.length} children`)
console.log(`Child 0: outer=${splitRegions[0].outer.length} verts`)
console.log(`Child 1: outer=${splitRegions[1].outer.length} verts`)

// Now trace each child independently for 15 more levels
for (let ci = 0; ci < splitRegions.length; ci++) {
  console.log(`\n=== Child ${ci} recursion ===`)
  let childRegion = splitRegions[ci]
  let childOffset = splitOffset + stepSize

  for (let d = 0; d < 20; d++) {
    const currentZ = topZ - Math.min(maxDepth, childOffset / slope)
    const nextOffset = childOffset + stepSize
    const nextZ = topZ - Math.min(maxDepth, nextOffset / slope)
    const nextRegions = buildInsetRegions(childRegion, stepSize, ClipperLib.JoinType.jtRound)

    const corners = detectCorners(childRegion.outer, stepSize * 0.25)

    let emission = ''
    if (nextRegions.length === 0) {
      emission = `COLLAPSE at z=${currentZ.toFixed(4)} → flat ring emitted`
    } else if (nextRegions.length > 1) {
      emission = `SPLIT → ${nextRegions.length} children`
    } else {
      emission = `CONTINUE corners=${corners.length}`
    }

    console.log(`  d=${d} offset=${childOffset.toFixed(4)} z=${currentZ.toFixed(4)}->${nextZ.toFixed(4)} verts=${childRegion.outer.length} | ${emission}`)

    if (nextRegions.length === 0) break
    if (nextRegions.length > 1) break
    childRegion = nextRegions[0]
    childOffset = nextOffset
  }
}

// The key insight we're looking for:
// If the children CONTINUE for many levels with corners=0, then stepArms emits nothing
// and the only output is the final collapse contour.
// But we see flat segments at many Z levels — so either:
// 1. The rescue path emits flat segments (it walks along the contour)
// 2. The buildInteriorCornerBridge emits flat segments
// 3. The collapse contour is being chained with arm segments

// Let's check: what does buildCenterlineRescuePath emit for a smooth curve?
// It walks along the medial axis, emitting points at each step.
// For a circle, the medial axis IS the center — a single point.
// The rescue path would walk toward the center, emitting points at decreasing radius.
// These points would have DECREASING Z (going deeper) as they approach center.
// So rescue paths should be DIAGONAL, not flat.

// The flat segments must come from the COLLAPSE CONTOUR being chained.
// Let's verify: the collapse contour for 'o' child is a small ring.
// After simplifyPath3DCollinear, if it's nearly circular it stays multi-point.
// But chainPaths puts it in 'contours' (length > 2) so it shouldn't be chained.

// WAIT — looking at the o path again:
// The flat segments trace the FULL circumference of the o shape.
// They are NOT small collapse rings — they are the OUTER CONTOUR of the o.
// This means they come from the SPLIT BRIDGE (bridgeSiblingChildren).
// bridgeSiblingChildren emits paths connecting the two children through the parent.
// For 'o', the parent is the full ring, and the bridge walks along the outer wall.
// The bridge path visits points on the outer contour at a fixed Z (currentZ).
// After simplification, if the bridge is nearly straight, it becomes 2 points.
// But if it's curved (like the o), it stays multi-point.

// Actually — let me re-read the flat segment XY positions:
// [5] FLAT z:0.5422 xy=0.0300 from=(5.908,1.282) area
// [6] FLAT z:0.5422 xy=0.0500
// These are small moves (0.03-0.05") tracing the contour locally.
// They are NOT the full circumference — they are LOCAL contour walks.
// This matches the RESCUE PATH behavior: walking along the medial axis
// in small steps, each step being ~stepSize in XY.

console.log('\n=== Rescue path hypothesis ===')
console.log('The flat segments are ~0.03-0.05" long at fixed Z.')
console.log('This matches buildCenterlineRescuePath walking along the contour.')
console.log('The rescue path emits points at each step along the medial axis.')
console.log('For a smooth curve, the medial axis walk produces many small steps.')
console.log('Each step: probe → channel midpoint → next probe.')
console.log('The channel midpoint Z = topZ - minDistToWall / slope.')
console.log('If the walk stays at the same distance from the wall, Z stays flat.')
console.log('This happens when the rescue path walks ALONG the contour (tangentially)')
console.log('rather than INWARD (radially).')
