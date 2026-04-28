/**
 * Identify what generates the flat Z segments in the o path.
 * Run: npx tsx scripts/analyze-flat-segments.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find(o => o.id === 'op0046')!
const result = generateVCarveRecursiveToolpath(project, operation)
const moves = result.moves

// Categorize each cut move
console.log('=== o path: flat vs diagonal segments ===')
console.log('Format: [idx] type z_from->z_to xy_len')
console.log()

let flatCount = 0, diagCount = 0
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const dz = Math.abs(m.to.z - m.from.z)
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  if (dz < 0.001) {
    flatCount++
  } else {
    diagCount++
  }
}

console.log(`Total cuts: ${flatCount + diagCount}`)
console.log(`Flat (dz<0.001): ${flatCount} (${(flatCount/(flatCount+diagCount)*100).toFixed(0)}%)`)
console.log(`Diagonal: ${diagCount} (${(diagCount/(flatCount+diagCount)*100).toFixed(0)}%)`)

// The flat segments are the problem — they should not exist in a smooth V-carve path.
// A smooth V-carve arm should be a single diagonal line from surface to depth.
// The flat segments come from collapse contours emitted by emitCollapseGeometry
// and contourToPath3D — these are horizontal rings at a fixed Z.

// Let's look at the flat segments more carefully:
// Are they all at the same Z? Or at different Z levels?
const flatZValues = new Set<string>()
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const dz = Math.abs(m.to.z - m.from.z)
  if (dz < 0.001) {
    flatZValues.add(m.from.z.toFixed(4))
  }
}
console.log(`\nDistinct Z levels of flat segments: ${flatZValues.size}`)
console.log([...flatZValues].sort().join(', '))

// The flat segments at many different Z levels confirm this is the staircase pattern.
// Each offset level emits a flat contour at its Z, then the arm connects to the next level.

// Now let's understand: where do the flat segments come from?
// In the o (a ring shape), the skeleton is a circle at the center.
// The algorithm:
//   1. Insets the ring inward step by step
//   2. At each step, emits arm segments (diagonal) connecting corners
//   3. At collapse, emits the final contour (flat ring)
// But for a smooth curve like 'o', detectCorners finds NO corners (it's a circle).
// So no arm segments are emitted — only the collapse contour.
// The collapse contour is a flat ring at the deepest Z.
// But we're seeing flat segments at MANY Z levels, not just the deepest.

// This means the flat segments are NOT collapse contours — they are something else.
// Let's look at what's between the diagonal segments:

console.log('\n=== Sequence around first flat run (moves 3-15) ===')
for (let i = 1; i <= 20; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') {
    console.log(`  [${i}] ${m.kind}`)
    continue
  }
  const dz = m.to.z - m.from.z
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const type = Math.abs(dz) < 0.001 ? 'FLAT' : 'DIAG'
  console.log(`  [${i}] ${type} z:${m.from.z.toFixed(4)}->${m.to.z.toFixed(4)} dz=${dz.toFixed(4)} xy=${xy.toFixed(4)}`)
}

// The pattern: DIAG(tiny xy) -> FLAT(larger xy) -> DIAG(tiny xy) -> FLAT -> ...
// The DIAG segments have tiny XY (0.003-0.009") — these are the arm Z-steps
// The FLAT segments have larger XY (0.03-0.05") — these are contour walks
// This is the interleaved arm+contour pattern from chainPaths chaining
// arm segments with collapse/bridge contour segments.

// But wait — for 'o' there should be NO corners detected (it's a circle).
// So where are the arm segments coming from?
// They must be from the rescue path or wall-anchor fallback.

console.log('\n=== XY lengths of diagonal segments ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const dz = Math.abs(m.to.z - m.from.z)
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  if (dz >= 0.001) {
    console.log(`  [${i}] dz=${(m.to.z-m.from.z).toFixed(4)} xy=${xy.toFixed(4)} from=(${m.from.x.toFixed(3)},${m.from.y.toFixed(3)}) to=(${m.to.x.toFixed(3)},${m.to.y.toFixed(3)})`)
  }
}
