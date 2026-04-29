/**
 * Deep analysis of zig-zag types — trace back to raw Path3D before chaining.
 * Instruments chainPaths to capture the raw segments and identify which ones
 * produce back-and-forth and direction-change reversals.
 * Run: npx tsx scripts/analyze-zigzag-types.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project

// Analyse each letter
for (const opId of ['op0012', 'op0006', 'op0009', 'op0008']) {
  const operation = project.operations.find(o => o.id === opId) as Operation
  const result = generateVCarveRecursiveToolpath(project, operation)
  const moves = result.moves
  const cuts = moves.map((m, i) => ({ ...m, i })).filter(m => m.kind === 'cut')

  const THRESHOLD = 0.01
  console.log(`\n${'='.repeat(60)}`)
  console.log(`${opId} (${operation.name})`)
  console.log('='.repeat(60))

  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k]
    const b = cuts[k + 1]
    if (b.i !== a.i + 1) continue
    const dz1 = a.to.z - a.from.z
    const dz2 = b.to.z - b.from.z
    if (Math.abs(dz1) <= THRESHOLD || Math.abs(dz2) <= THRESHOLD) continue
    if (Math.sign(dz1) === Math.sign(dz2)) continue

    const isBackAndForth = Math.abs(dz1 + dz2) < 0.005
    const kind = isBackAndForth ? 'BACK-AND-FORTH' : 'DIRECTION-CHANGE'

    console.log(`\n[${kind}] moves [${a.i}]->[b.i}]`)
    // Print a window of 6 moves around the reversal
    const start = Math.max(0, a.i - 3)
    const end = Math.min(moves.length - 1, b.i + 3)
    for (let i = start; i <= end; i++) {
      const m = moves[i]
      const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
      const dz = m.to.z - m.from.z
      const marker = (i === a.i || i === b.i) ? ' <<<' : ''
      console.log(`  [${String(i).padStart(3)}] ${m.kind.padEnd(6)} from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)},${m.from.z.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)},${m.to.z.toFixed(4)}) xy=${xy.toFixed(4)} dz=${dz.toFixed(4)}${marker}`)
    }

    if (isBackAndForth) {
      // Back-and-forth: two segments A->B and B->A (or A->B->C where B is a pivot)
      // Check if this is the "two arms converging to same vertex" case
      const sameEndpoint = Math.hypot(a.from.x - b.to.x, a.from.y - b.to.y) < 1e-6
        && Math.abs(a.from.z - b.to.z) < 1e-6
      const sharedMidpoint = Math.hypot(a.to.x - b.from.x, a.to.y - b.from.y) < 1e-6
        && Math.abs(a.to.z - b.from.z) < 1e-6
      console.log(`  => sameEndpoint(A.from==B.to): ${sameEndpoint}`)
      console.log(`  => sharedMidpoint(A.to==B.from): ${sharedMidpoint}`)
      if (sameEndpoint) {
        console.log(`  => TYPE: Two arms share start/end — classic pivot (A->B->A)`)
      } else {
        console.log(`  => TYPE: Interleaved chains — two separate arms chained through shared XYZ point`)
      }
    } else {
      // Direction-change: arm tip at maxZ jumping to a different path
      // Check if the jump is a tryDirectLink (no rapid between them)
      console.log(`  => TYPE: Arm tip at z=${a.to.z.toFixed(4)} jumps to z=${b.from.z.toFixed(4)} via direct link`)
      console.log(`  => xyDist=${Math.hypot(b.from.x-a.to.x, b.from.y-a.to.y).toFixed(4)} dz=${(b.from.z-a.to.z).toFixed(4)}`)
      // The next path starts at b.from — is it the deep end of a chain?
      // Look ahead to see if the path rises after b
      const nextCuts = cuts.slice(k + 1, k + 6)
      const dzValues = nextCuts.map(c => (c.to.z - c.from.z).toFixed(4)).join(', ')
      console.log(`  => Next 5 dz values: ${dzValues}`)
      const risesImmediately = nextCuts.length > 0 && (nextCuts[0].to.z - nextCuts[0].from.z) > 0.01
      console.log(`  => Rises immediately after: ${risesImmediately} (wrong-end entry: ${risesImmediately})`)
    }
  }
}
