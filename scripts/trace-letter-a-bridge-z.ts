/**
 * Trace the Z calculation for the deep bridge point in letter A.
 * Focus on bridgeSiblingChildren — the path [73..77] that hits z=0.3760.
 * Run: npx tsx scripts/trace-letter-a-bridge-z.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === 'op0008') as Operation

// Extract the parameters used for letter A
const toolRecord = project.tools.find((t) => t.id === operation.toolRef)!
const vBitAngle = toolRecord.vBitAngle!
const halfAngleRad = (vBitAngle * Math.PI) / 360
const slope = Math.tan(halfAngleRad)
const stockThickness = project.stock.thickness  // topZ for the band
const maxCarveDepth = operation.maxCarveDepth
const minZ = stockThickness - maxCarveDepth

console.log('=== Tool / operation parameters ===')
console.log(`  vBitAngle=${vBitAngle}°  halfAngle=${(halfAngleRad * 180 / Math.PI).toFixed(2)}°`)
console.log(`  slope=tan(halfAngle)=${slope.toFixed(6)}`)
console.log(`  stockThickness (topZ)=${stockThickness}`)
console.log(`  maxCarveDepth=${maxCarveDepth}  minZ=${minZ.toFixed(4)}`)
console.log(`  stepSize=${operation.stepover}`)

// The deep path [73..77] visits z=0.3760.
// bridgeSiblingChildren computes: targetZ = currentZ - channel.radius / slope
// where currentZ is the pre-split Z passed in.
//
// Let's reverse-engineer: what channel.radius would produce z=0.3760?
//   targetZ = currentZ - radius / slope
//   radius = (currentZ - targetZ) * slope
//
// The bridge walk starts at nextZ (child corner Z). From the moves:
//   [72] plunge to z=0.5595  => this is the path entry, which is the start of the bridge path
//   [73] drops to z=0.3760
//
// In bridgeSiblingChildren the path starts at { z: nextZ } for the child corner.
// nextZ is computed as: topZ - min(maxDepth, nextOffset / slope)
// The plunge target z=0.5595 matches nextZ for some offset level.
// Let's find what offset that corresponds to:
//   nextZ = topZ - nextOffset / slope  (assuming not clamped)
//   nextOffset = (topZ - nextZ) * slope = (0.75 - 0.5595) * slope

const nextZ_bridge = 0.5595
const nextOffset_bridge = (stockThickness - nextZ_bridge) * slope
console.log(`\n=== Bridge path entry ===`)
console.log(`  nextZ=${nextZ_bridge} => nextOffset=${nextOffset_bridge.toFixed(6)}`)

// currentZ (pre-split Z) = topZ - min(maxDepth, totalOffset / slope)
// totalOffset = nextOffset - stepSize
const totalOffset_bridge = nextOffset_bridge - operation.stepover
const currentZ_bridge = stockThickness - Math.min(maxCarveDepth, totalOffset_bridge / slope)
console.log(`  totalOffset (pre-split)=${totalOffset_bridge.toFixed(6)}`)
console.log(`  currentZ (pre-split)=${currentZ_bridge.toFixed(4)}`)

// Now: what radius produces z=0.3760 from currentZ?
const deepZ = 0.3760
const radius_for_deepZ = (currentZ_bridge - deepZ) * slope
console.log(`\n=== Reverse-engineering the deep point z=${deepZ} ===`)
console.log(`  radius = (currentZ - deepZ) * slope = (${currentZ_bridge.toFixed(4)} - ${deepZ}) * ${slope.toFixed(6)}`)
console.log(`  radius = ${radius_for_deepZ.toFixed(6)}`)
console.log(`  This means the channel was measured as ${radius_for_deepZ.toFixed(4)} wide (half-width)`)

// What is the actual geometry of letter A at that location?
// The bridge path is near xy=(2.96, 1.58) based on moves [73..75].
// The A's counter (hole) is roughly centered around (2.8, 1.6).
// A channel radius of ${radius_for_deepZ.toFixed(4)} inches seems very large for a letter A.
// Let's check: what's the maximum possible channel radius inside the A?
// The A is roughly 1.5" wide at its widest. Half-width = 0.75".
// radius=${radius_for_deepZ.toFixed(4)} is plausible for the OUTER shape width,
// but NOT for the local channel between the two split children.

console.log(`\n=== Sanity check ===`)
console.log(`  Letter A is ~1.5" wide. Max half-width ~ 0.75"`)
console.log(`  Measured channel radius: ${radius_for_deepZ.toFixed(4)}"`)
console.log(`  This is ${(radius_for_deepZ / 0.75 * 100).toFixed(0)}% of the max half-width`)
console.log(`  => The channel measurement is finding the OUTER walls of the A, not the local split channel`)

// What SHOULD the radius be at the split point?
// The split happens when the inset contour splits into two children.
// At the split moment, the channel is ~stepSize wide (that's when it pinches off).
// So the correct radius at the split point is approximately stepSize/2.
const expectedRadius = operation.stepover / 2
const expectedZ = currentZ_bridge - expectedRadius / slope
console.log(`\n=== Expected values at split point ===`)
console.log(`  Expected channel radius ~ stepSize/2 = ${expectedRadius.toFixed(4)}`)
console.log(`  Expected bridge midpoint Z = currentZ - radius/slope = ${currentZ_bridge.toFixed(4)} - ${expectedRadius.toFixed(4)}/${slope.toFixed(4)} = ${expectedZ.toFixed(4)}`)
console.log(`  Actual bridge midpoint Z = ${deepZ}`)
console.log(`  Error = ${(deepZ - expectedZ).toFixed(4)} (${((deepZ - expectedZ) / expectedZ * 100).toFixed(1)}% off)`)

// Also check: what does the Z formula give for the flat segment at z=0.3760?
// Moves [74] and [75] are flat at z=0.3760 — this is the "channel midpoint" path
// being walked. The walk advances along the medial axis, and at each step the
// channel radius is re-measured. If the radius stays large, Z stays deep.
console.log(`\n=== The flat segment [74..75] at z=0.3760 ===`)
console.log(`  Moves [74] and [75] are flat at z=0.3760 — the walk is staying at this wrong depth`)
console.log(`  This means findPerpendicularChannelMidpoint is consistently returning`)
console.log(`  a large radius (${radius_for_deepZ.toFixed(4)}) for multiple steps along the walk`)
console.log(`  => The perpendicular intersects the FAR walls of the A shape, not the local split channel`)

// The fix: findPerpendicularChannelMidpoint should use the NARROWEST bracketing pair,
// not just any pair. Let's verify what "narrowest bracketing pair" means:
// It finds the closest negative t and closest positive t intersection.
// If the probe is inside the A's counter region, the perpendicular will hit:
//   - the inner walls of the counter (close, small radius)
//   - the outer walls of the A (far, large radius)
// The "narrowest bracketing pair" should pick the inner walls.
// But if the probe is in the OUTER band of the A (between counter and outer edge),
// the perpendicular hits the outer edge on one side and the counter on the other —
// giving a large radius equal to the band width.

console.log(`\n=== Root cause hypothesis ===`)
console.log(`  The bridge walk probe is in the OUTER BAND of the A (between counter and outer wall).`)
console.log(`  findPerpendicularChannelMidpoint measures the full band width as the channel radius.`)
console.log(`  For a letter A, the band is ~0.3-0.4" wide, giving radius ~0.35".`)
console.log(`  With slope=${slope.toFixed(4)}, Z drop = 0.35 / ${slope.toFixed(4)} = ${(0.35/slope).toFixed(4)}"`)
console.log(`  currentZ=${currentZ_bridge.toFixed(4)} - ${(0.35/slope).toFixed(4)} = ${(currentZ_bridge - 0.35/slope).toFixed(4)}`)
console.log(`  This matches the observed z=0.3760 closely.`)

console.log(`\n=== The real problem ===`)
console.log(`  bridgeSiblingChildren is designed to walk the medial axis of the PARENT contour`)
console.log(`  to connect two split children. But the parent contour of letter A is the full`)
console.log(`  outer shape — a wide band. The perpendicular channel measurement gives the`)
console.log(`  full band width, not the local pinch-point width between the two children.`)
console.log(`  The Z computed from this large radius is far too deep.`)
console.log(``)
console.log(`  The bridge walk is geometrically correct for thin shapes (like the crossbar of T)`)
console.log(`  but wrong for wide shapes (like the legs of A) where the parent contour is wide`)
console.log(`  and the split children are narrow sub-regions within it.`)
console.log(``)
console.log(`  The Z at the bridge midpoint should be derived from the DISTANCE TO THE SPLIT`)
console.log(`  (i.e. how far inward from the parent contour the split occurred), not from`)
console.log(`  the full perpendicular channel width of the parent shape.`)
