/**
 * Understand why sortPathsNearestNeighbor still picks the wrong path for T [53].
 * Run: npx tsx scripts/analyze-sort-cost.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project

// T letter: the 0.5" back-and-forth at [53]->[54]
const operation = project.operations.find(o => o.id === 'op0009')!
const result = generateVCarveRecursiveToolpath(project, operation)
const moves = result.moves

// The path containing [53]->[54] spans [39..68].
// [52] ends at (3.7995, 1.1474, 0.5248) — this is the "current position" when
// sortPathsNearestNeighbor picks the next path.
// The next path starts at [53].from = (3.7995, 1.1474, 0.5248) — same point!
// So the path was NOT picked by sortPathsNearestNeighbor — it was chained by chainPaths.
// The [53]->[54] segment is INSIDE a single chained path, meaning chainPaths
// joined two 2-point segments that share the endpoint (3.7995, 1.1474, 0.5248).

// Let's verify: what are the raw 2-point segments around this area?
// The chained path [39..68] was built from multiple 2-point arm segments.
// The reversal at [53]->[54] means:
//   segment A: ends at (3.8004, 1.6629, 0.5075)
//   segment B: starts at (3.8004, 1.6629, 0.5075) — same point
// So chainPaths chained A->B where B goes back toward the start of A.
// The cycle guard should have caught this... unless B's endpoint is NOT
// already in the visitedKeys set.

// Let's check: what is the endpoint of segment B?
const m53 = moves[53]
const m54 = moves[54]
console.log('T letter [53]->[54] analysis:')
console.log(`  [53] from=(${m53.from.x.toFixed(6)},${m53.from.y.toFixed(6)},${m53.from.z.toFixed(6)})`)
console.log(`       to  =(${m53.to.x.toFixed(6)},${m53.to.y.toFixed(6)},${m53.to.z.toFixed(6)})`)
console.log(`  [54] from=(${m54.from.x.toFixed(6)},${m54.from.y.toFixed(6)},${m54.from.z.toFixed(6)})`)
console.log(`       to  =(${m54.to.x.toFixed(6)},${m54.to.y.toFixed(6)},${m54.to.z.toFixed(6)})`)

// The cycle guard checks: is arms[next][1] (the endpoint of the next segment)
// already in visitedKeys? For the T case:
//   current chain tail = (3.7995, 1.1474, 0.5248)  [= m53.from]
//   next segment: (3.7995, 1.1474, 0.5248) -> (3.8004, 1.6629, 0.5075)  [= m53]
//   next segment endpoint = (3.8004, 1.6629, 0.5075)
//   Is (3.8004, 1.6629, 0.5075) in visitedKeys? Only if it appeared earlier in the chain.
// The chain before [53] goes from [39] to [52]. Does (3.8004, 1.6629, 0.5075) appear there?
console.log('\nChecking if (3.8004, 1.6629, 0.5075) appears in path [39..52]:')
for (let i = 39; i <= 52; i++) {
  const m = moves[i]
  const matchFrom = Math.abs(m.from.x - 3.8004) < 1e-4 && Math.abs(m.from.y - 1.6629) < 1e-4
  const matchTo = Math.abs(m.to.x - 3.8004) < 1e-4 && Math.abs(m.to.y - 1.6629) < 1e-4
  if (matchFrom || matchTo) {
    console.log(`  [${i}] MATCH: from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)},${m.from.z.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)},${m.to.z.toFixed(4)})`)
  }
}
console.log('  (no output = point not in earlier chain)')

// So the cycle guard doesn't fire because (3.8004, 1.6629, 0.5075) is a NEW point.
// The issue is different: the chain goes:
//   ... -> (3.7995, 1.1474, 0.5248) -> (3.8004, 1.6629, 0.5075) -> (3.8007, 1.1473, 0.5248)
// The endpoint (3.8007, 1.1473, 0.5248) is NOT the same as any earlier point
// (it's at y=1.1473, not y=1.1474 — slightly different due to float arithmetic).
// So the cycle guard doesn't fire.
// This is NOT a cycle — it's two separate arm segments that happen to share
// a midpoint at (3.8004, 1.6629, 0.5075) which is far from the rest of the path.

// The real issue: these are two arm segments from DIFFERENT skeleton arms
// that both happen to track to the same intermediate point (3.8004, 1.6629, 0.5075).
// One arm goes from bottom to that point, the other goes from that point back to bottom.
// They form a V-shape: bottom -> far-point -> bottom.
// This is the "interior corner bridge" or a collapse contour being chained with arm segments.

// Let's check what kind of path segment [53] is:
// It goes from (3.7995, 1.1474, 0.5248) to (3.8004, 1.6629, 0.5075)
// XY distance = 0.5155" — this is a LONG segment, not a ~stepSize arm segment.
// This is likely a collapse contour or bridge path, not a 2-point arm segment.
// But chainPaths only chains 2-point segments... so this must be part of a longer path.

// Let's look at what the raw paths look like before chaining by checking
// if [53] and [54] are consecutive in the original path or joined by chainPaths.
// Since the path spans [39..68], and [53]->[54] are consecutive cuts with no rapid,
// they were chained together. The question is: were they originally separate 2-point
// segments, or part of a longer raw path?

// A 2-point segment chained into a longer path would have its endpoints as
// exact float matches. Let's check:
console.log('\nChecking exact float equality at chain join points around [53]:')
for (let i = 39; i <= 67; i++) {
  const curr = moves[i]
  const next = moves[i + 1]
  if (next.kind !== 'cut') break
  const xyGap = Math.hypot(next.from.x - curr.to.x, next.from.y - curr.to.y)
  const zGap = Math.abs(next.from.z - curr.to.z)
  if (xyGap > 1e-10 || zGap > 1e-10) {
    console.log(`  [${i}]->[${i+1}] GAP: xy=${xyGap.toFixed(10)} z=${zGap.toFixed(10)}`)
  }
}
console.log('  (no output = all consecutive moves share exact endpoints)')

// Now let's understand the geometry: (3.8004, 1.6629) is near the TOP of letter T
// (the crossbar), while (3.7995, 1.1474) is near the BOTTOM (the stem).
// The segment [53] traverses the entire height of the T stem in one move.
// This is a collapse contour or bridge path connecting the stem bottom to the crossbar.
console.log('\nGeometric context:')
console.log(`  T letter spans roughly y=[1.0, 2.0]`)
console.log(`  [53] goes from y=1.1474 (stem bottom area) to y=1.6629 (crossbar area)`)
console.log(`  [54] goes from y=1.6629 back to y=1.1473 (stem bottom area)`)
console.log(`  => This is a collapse contour (closed loop) that was chained with arm segments`)
console.log(`  => The collapse contour visits the crossbar area and returns`)
console.log(`  => chainPaths should NOT chain arm segments with collapse contours`)
console.log(`  => But collapse contours have length > 2, so they should be in 'contours' not 'arms'`)
console.log(`  => Unless the collapse contour was simplified to exactly 2 points...`)

// Check: what is the length of the raw path that contains [53]->[54]?
// If it's a 2-point segment that got chained, it would appear as a single arm.
// The path [39..68] has 30 moves — it's a long chained path.
// The segment [53] has xy=0.5155 which is much larger than stepSize=0.01.
// This suggests it's a collapse contour or bridge that was emitted as a multi-point path
// but got simplified to 2 points by simplifyPath3DCollinear.
console.log('\nChecking if [53] could be a simplified collapse/bridge path:')
console.log(`  [53] xy=0.5155 >> stepSize=0.01`)
console.log(`  This is 51.5x stepSize — far too long to be a normal arm segment`)
console.log(`  It must be a collapse contour or bridge path simplified to 2 points`)
console.log(`  simplifyPath3DCollinear reduces collinear points — a straight line becomes 2 points`)
console.log(`  A collapse contour that happens to be nearly straight would be simplified to 2 points`)
console.log(`  Then chainPaths treats it as an arm segment and chains it with adjacent arms`)
