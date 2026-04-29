/**
 * Deep-dive into the specific dangerous Z drops in letter A (op0008).
 * Run: npx tsx scripts/analyze-letter-a-drops.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === 'op0008') as Operation
const result = generateVCarveRecursiveToolpath(project, operation)
const moves = result.moves
const stockZ = project.stock.thickness  // 0.75

// Helper: print a window of moves around an index
function window(center: number, radius = 4): void {
  for (let i = Math.max(0, center - radius); i <= Math.min(moves.length - 1, center + radius); i++) {
    const m = moves[i]
    const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    const dz = m.to.z - m.from.z
    const marker = i === center ? ' <<<<' : ''
    console.log(`  [${String(i).padStart(3)}] ${m.kind.padEnd(6)} from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)},${m.from.z.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)},${m.to.z.toFixed(4)}) xy=${xy.toFixed(4)} dz=${dz.toFixed(4)}${marker}`)
  }
}

// -----------------------------------------------------------------------
// DROP 1: move [33] — dz=-0.1328, goes to z=0.3733 (below stock surface!)
// This is the most dangerous: z=0.3733 is 0.3767 below stock top (0.75)
// but stock is only 0.75 thick, so this is 0.3733 above the bottom — valid
// depth-wise, but the Z value is wrong for V-carve geometry.
// -----------------------------------------------------------------------
console.log('=== DROP 1: move [33] — plunges to z=0.3733 ===')
console.log('Context:')
window(33, 5)

// What Z should move [33] have?
// It's a connection move (tryDirectLink fired). pos was at z=0.5061 (move[32].to)
// entry is at z=0.3733. The depth budget = safeZ - min(0.5061, 0.3733) = 0.95 - 0.3733 = 0.5767
// xyDist = 0.0522 < 0.5767, so tryDirectLink approved it as a direct cut.
// But z=0.3733 is the START of a path that immediately rises to z=0.5595 at [34].
// This means a path was sorted/chained so that its entry point is at z=0.3733
// but it "should" be entered from the other end (z=0.5595 end).
const m32 = moves[32], m33 = moves[33], m34 = moves[34]
console.log(`\nAnalysis:`)
console.log(`  [32] ends at z=${m32.to.z.toFixed(4)}`)
console.log(`  [33] direct-link cut: z ${m33.from.z.toFixed(4)} -> ${m33.to.z.toFixed(4)} (dz=${(m33.to.z-m33.from.z).toFixed(4)})`)
console.log(`  [34] immediately rises: z ${m34.from.z.toFixed(4)} -> ${m34.to.z.toFixed(4)} (dz=${(m34.to.z-m34.from.z).toFixed(4)})`)
console.log(`  => [33] is a LINK move that descends to the wrong end of path [34..N]`)
console.log(`  => The path starting at [34] should have been entered from its OTHER end (z=0.5595)`)
console.log(`  => sortPathsNearestNeighbor chose the deep end as entry because it was closer in XY`)
console.log(`  => But tryDirectLink approved the descent because xyDist(${Math.hypot(m33.to.x-m33.from.x,m33.to.y-m33.from.y).toFixed(4)}) < depthBudget(${(0.95-Math.min(m33.from.z,m33.to.z)).toFixed(4)})`)

// -----------------------------------------------------------------------
// DROP 2: move [73] — dz=-0.1834, plunges to z=0.3760 right after a plunge
// This is a path that starts at z=0.5595 (the plunge target) and immediately
// drops further to z=0.3760. This is NOT a link move — it's the first cut
// after a plunge, meaning the path itself starts at the wrong Z.
// -----------------------------------------------------------------------
console.log('\n=== DROP 2: move [73] — first cut after plunge drops to z=0.3760 ===')
console.log('Context:')
window(73, 5)

const m72 = moves[72], m73 = moves[73], m74 = moves[74], m76 = moves[76]
console.log(`\nAnalysis:`)
console.log(`  [72] plunge to z=${m72.to.z.toFixed(4)}`)
console.log(`  [73] first cut: z ${m73.from.z.toFixed(4)} -> ${m73.to.z.toFixed(4)} (dz=${(m73.to.z-m73.from.z).toFixed(4)})`)
console.log(`  [74] flat at z=${m74.to.z.toFixed(4)}`)
console.log(`  [76] rises back to z=${m76.to.z.toFixed(4)}`)
console.log(`  => This path goes: 0.5595 -> 0.3760 (flat) -> rises back to 0.5134 -> 0.5768`)
console.log(`  => z=0.3760 is BELOW the correct V-carve depth for this geometry`)
console.log(`  => This looks like a collapse/bridge contour emitted at the wrong Z`)
console.log(`  => The path visits z=0.3760 which is deeper than maxCarveDepth would allow`)
console.log(`  maxCarveDepth=${operation.maxCarveDepth}, stockThickness=${stockZ}`)
console.log(`  => Expected max depth below surface: z >= ${stockZ - operation.maxCarveDepth}`)
console.log(`  => z=0.3760 means depth=${(stockZ - 0.3760).toFixed(4)} which exceeds maxCarveDepth=${operation.maxCarveDepth}`)

// -----------------------------------------------------------------------
// DROP 3: move [218] — dz=-0.1923, from z=0.7500 to z=0.5577
// This is a direct-link from the end of a rising arm chain to the start
// of a collapse contour. The arm ends at maxZ (0.75), the contour is at 0.5577.
// -----------------------------------------------------------------------
console.log('\n=== DROP 3: move [218] — arm tip to collapse contour, dz=-0.1923 ===')
console.log('Context:')
window(218, 4)

const m217 = moves[217], m218 = moves[218], m219 = moves[219]
console.log(`\nAnalysis:`)
console.log(`  [217] arm tip: z ${m217.from.z.toFixed(4)} -> ${m217.to.z.toFixed(4)} (maxDepth)`)
console.log(`  [218] direct-link: z ${m218.from.z.toFixed(4)} -> ${m218.to.z.toFixed(4)} (dz=${(m218.to.z-m218.from.z).toFixed(4)})`)
console.log(`  [219] continues at z=${m219.to.z.toFixed(4)}`)
const xyDist218 = Math.hypot(m218.to.x-m218.from.x, m218.to.y-m218.from.y)
const budget218 = 0.95 - Math.min(m218.from.z, m218.to.z)
console.log(`  xyDist=${xyDist218.toFixed(4)}, depthBudget=${budget218.toFixed(4)} => tryDirectLink approved`)
console.log(`  => This is a VALID direct link (rising from 0.5577 perspective, descending from 0.75)`)
console.log(`  => The issue is the tool descends 0.1923 while moving 0.1494 XY — steep but inside budget`)
console.log(`  => This may be visually alarming but is geometrically correct IF the path at [219..] is correct`)

// -----------------------------------------------------------------------
// DROP 4: move [29] — dz=-0.0866, from z=0.6634 to z=0.5768
// -----------------------------------------------------------------------
console.log('\n=== DROP 4: move [29] — dz=-0.0866 ===')
console.log('Context:')
window(29, 4)

// -----------------------------------------------------------------------
// Summary: which drops are genuine bugs vs. aggressive-but-valid links?
// -----------------------------------------------------------------------
console.log('\n=== Summary ===')
console.log('Move [33]: BUG — tryDirectLink approved descent to wrong end of a path.')
console.log('  sortPathsNearestNeighbor picked the deep end (z=0.3733) as entry because')
console.log('  it was closer in XY to the previous position. The path should be reversed.')
console.log('  Fix: sortPathsNearestNeighbor should prefer the SHALLOWER end as entry')
console.log('  when both ends are within the direct-link budget, to avoid unnecessary deep plunges.')
console.log('')
console.log('Move [73]: BUG — collapse/bridge contour emitted at z=0.3760 which exceeds maxCarveDepth.')
console.log('  This is an upstream issue in emitCollapseGeometry or bridgeSiblingChildren:')
console.log('  a contour Z is computed incorrectly, going deeper than the V-bit geometry allows.')
console.log('  The path immediately rises back (z=0.3760 -> 0.5134 -> 0.5768), confirming')
console.log('  the deep point is a single wrong vertex, not a sustained wrong depth.')
console.log('')
console.log('Move [218]: MARGINAL — large dz but within tryDirectLink budget. Visually alarming.')
console.log('  Same root cause as [33]: sortPathsNearestNeighbor chose the deep end of a')
console.log('  collapse contour as entry. The contour at z=0.5577 is entered from its deepest')
console.log('  point rather than from the end closest in Z to the previous position (z=0.75).')
console.log('')
console.log('Move [29]: MARGINAL — direct link from arm tip to a different arm chain.')
console.log('  The descent is within budget but crosses a large XY distance while descending.')
