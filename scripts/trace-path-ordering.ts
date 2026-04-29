/**
 * Trace the actual path ordering to see why the bootstrap path gets
 * placed between the bridgeSplitArms and its natural arm chain.
 * Run: npx tsx scripts/trace-path-ordering.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project, Path3D } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === 'op0008') as Operation

// Patch chainPaths to capture what happens
const origChainPaths = (globalThis as any).__chainPaths
const allPathsBeforeChain: Path3D[] = []

// We'll need to instrument the module. Instead, let's rebuild pathsToMoves logic
// by running the generator and looking at the DIAG output more carefully.

const result = generateVCarveRecursiveToolpath(project, operation)
const moves = result.moves

// Show moves [20] through [40] to see context around [29]
console.log('=== Moves 20-40 with full context ===')
for (let i = 20; i <= 40 && i < moves.length; i++) {
  const m = moves[i]
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  console.log(`[${i}] ${m.kind.padEnd(5)} xy=${xy.toFixed(4)}" dz=${dz.toFixed(4)} z=${m.from.z.toFixed(4)}->${m.to.z.toFixed(4)}`)
  console.log(`     from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)})`)
  console.log('')
}

// Now add logging inside the module to trace path ordering.
// We need to modify the source file temporarily.
// Instead, let's analyze what SHOULD happen.
console.log('=== Analysis ===')
console.log('')
console.log('DIAG[0]: bridgeSplitArms-rescue (4 pts)')
console.log('  [0](2.6908,1.2952,0.6634) → [3](2.7223,1.2370,0.6461)')
console.log('  Reversed by sortPathsNearestNeighbor: entry=(2.7223,1.2370,0.6461) end=(2.6908,1.2952,0.6634)')
console.log('')
console.log('DIAG[17]: buildFreshSeed-rescue (6 pts)')
console.log('  [0](2.7784,1.1978,0.5768) → [5](2.8390,1.2345,0.5595)')
console.log('')
console.log('After reversal, bridge path ends at (2.6908,1.2952,0.6634)')
console.log('Next sorted path should be arm chain starting at (2.7223,1.2370,0.6461)')
console.log('  Distance from bridge end to arm start = hypot(0.0315,-0.0582) = 0.0662"')
console.log('')
console.log('But bootstap entry (2.7784,1.1978,0.5768) has:')
console.log('  Distance from bridge end = hypot(0.0876,-0.0974) = 0.1310"')
console.log('')
console.log('However, sortPathsNearestNeighbor considers BOTH ends:')
console.log('  Arm chain (forward):  entry=(2.7223,1.2370,0.6461) dist=0.0662"  ← closer')
console.log('  Arm chain (reversed): entry=(arm_end) dist=?')
console.log('  Bootstrap (forward):  entry=(2.7784,1.1978,0.5768) dist=0.1310"')
console.log('  Bootstrap (reversed): entry=(2.8390,1.2345,0.5595) dist=?')
console.log('')
console.log('If the arm chain end is far from (2.6908,1.2952), reversed arm entry')
console.log('would have larger dist than bootstrap forward entry.')
console.log('')

// Find all unique Z levels used in the path set
// by looking at unique z values in DIAG tags (already printed)
// Key conclusion: tryDirectLink connects paths at different Z levels

console.log('=== tryDirectLink Z-level check for move [29] ===')
const m29 = moves[29]
if (m29) {
  console.log(`pos.z  = ${m29.from.z.toFixed(4)} (end of reversed bridgeSplitArms)`)
  console.log(`entry.z = ${m29.to.z.toFixed(4)} (start of bootstrap)`)
  console.log(`Z diff  = ${Math.abs(m29.from.z - m29.to.z).toFixed(4)}`)
  console.log(`These paths are at DIFFERENT Z levels — should NEVER be linked!`)
  console.log(``)
  console.log(`The arm chain that starts at (2.7223,1.2370,${(0.6461).toFixed(4)}) has the SAME Z`)
  console.log(`as the bridgeSplitArms end — THAT is the path that should come next.`)
  console.log(`But sortPathsNearestNeighbor placed the bootstrap (z=0.5768) before it.`)
}
