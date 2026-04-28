/**
 * Investigate T letter direction-change cases — the path starts at the arm tip
 * but immediately drops. Is this a reversed chain or a genuine path?
 * Run: npx tsx scripts/analyze-t-direction.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find(o => o.id === 'op0009')!
const result = generateVCarveRecursiveToolpath(project, operation)
const moves = result.moves

// For each direction-change case, find the full chained path that contains it
// and check if reversing it would make more sense
const cases = [
  { label: 'T [37]->[38]', dropIdx: 38 },
  { label: 'T [79]->[80]', dropIdx: 80 },
  { label: 'T [87]->[88]', dropIdx: 88 },
  { label: 'T [151]->[152]', dropIdx: 152 },
]

for (const { label, dropIdx } of cases) {
  const drop = moves[dropIdx]
  console.log(`\n=== ${label} ===`)
  console.log(`Drop move: z=${drop.from.z.toFixed(4)} -> z=${drop.to.z.toFixed(4)} dz=${(drop.to.z-drop.from.z).toFixed(4)} xy=${Math.hypot(drop.to.x-drop.from.x,drop.to.y-drop.from.y).toFixed(4)}`)

  // Find the start of the chained path containing this drop
  // Walk backward from dropIdx to find the path start (after a rapid/plunge)
  let pathStart = dropIdx
  while (pathStart > 0 && moves[pathStart - 1].kind === 'cut') pathStart--

  // Walk forward to find the path end (before a rapid/plunge)
  let pathEnd = dropIdx
  while (pathEnd < moves.length - 1 && moves[pathEnd + 1].kind === 'cut') pathEnd++

  console.log(`Path spans moves [${pathStart}..${pathEnd}] (${pathEnd - pathStart + 1} moves)`)
  console.log(`Path start: z=${moves[pathStart].from.z.toFixed(4)} at (${moves[pathStart].from.x.toFixed(4)},${moves[pathStart].from.y.toFixed(4)})`)
  console.log(`Path end:   z=${moves[pathEnd].to.z.toFixed(4)} at (${moves[pathEnd].to.x.toFixed(4)},${moves[pathEnd].to.y.toFixed(4)})`)

  // Print Z profile of the path
  const zProfile = [moves[pathStart].from.z, ...moves.slice(pathStart, pathEnd + 1).map(m => m.to.z)]
  const zMin = Math.min(...zProfile)
  const zMax = Math.max(...zProfile)
  console.log(`Z range: [${zMin.toFixed(4)}, ${zMax.toFixed(4)}]`)

  // Find where the drop occurs within the path
  const dropOffset = dropIdx - pathStart
  console.log(`Drop occurs at position ${dropOffset} within the path`)

  // Check if the path is monotonically rising before the drop and after
  const beforeDrop = moves.slice(pathStart, dropIdx).map(m => m.to.z - m.from.z)
  const afterDrop = moves.slice(dropIdx + 1, pathEnd + 1).map(m => m.to.z - m.from.z)
  const beforeRising = beforeDrop.every(dz => dz >= -0.001)
  const afterRising = afterDrop.every(dz => dz >= -0.001)
  console.log(`Before drop: all rising? ${beforeRising} (${beforeDrop.slice(0,5).map(d=>d.toFixed(3)).join(',')})`)
  console.log(`After drop:  all rising? ${afterRising} (${afterDrop.slice(0,5).map(d=>d.toFixed(3)).join(',')})`)

  // If before is rising and after is rising, the drop is a single bad segment
  // connecting two rising chains. The path structure is: [rising chain A] -> [drop] -> [rising chain B]
  // This means two separate arm chains were chained together via a shared endpoint,
  // and the drop is the tryDirectLink connection between them.
  // The drop move itself is the tryDirectLink cut, not part of either arm chain.
  if (beforeRising && afterRising) {
    console.log(`=> DIAGNOSIS: Two rising arm chains connected by a direct-link drop.`)
    console.log(`   Chain A ends at z=${moves[dropIdx-1].to.z.toFixed(4)}, Chain B starts at z=${drop.to.z.toFixed(4)}`)
    console.log(`   The drop IS the tryDirectLink connection between them.`)
    console.log(`   sortPathsNearestNeighbor placed Chain B immediately after Chain A.`)
    console.log(`   Chain B's entry (z=${drop.to.z.toFixed(4)}) is the DEEP end of Chain B.`)

    // What is Chain B's other end?
    const chainBEnd = moves[pathEnd].to.z
    console.log(`   Chain B's other end: z=${chainBEnd.toFixed(4)}`)
    console.log(`   If Chain B were reversed, entry would be at z=${chainBEnd.toFixed(4)} (shallower, closer to z=${moves[dropIdx-1].to.z.toFixed(4)})`)
    const currentDrop = Math.abs(moves[dropIdx-1].to.z - drop.to.z)
    const reversedDrop = Math.abs(moves[dropIdx-1].to.z - chainBEnd)
    console.log(`   Current drop: ${currentDrop.toFixed(4)}, Reversed drop: ${reversedDrop.toFixed(4)}`)
    console.log(`   => Reversing Chain B would ${reversedDrop < currentDrop ? 'REDUCE' : 'INCREASE'} the drop`)
  }
}
