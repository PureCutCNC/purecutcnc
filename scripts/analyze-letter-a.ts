/**
 * Analyze letter A (op0008) for dangerous Z plunges and wrong Z values.
 * Run: npx tsx scripts/analyze-letter-a.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === 'op0008') as Operation
const result = generateVCarveRecursiveToolpath(project, operation)

const safeZ = 0.95
const stepSize = operation.stepover
const moves = result.moves

console.log(`op0008 letter A: stepSize=${stepSize} totalMoves=${moves.length}`)
console.log(`warnings: ${result.warnings.join(' | ') || 'none'}`)

const cuts = moves.filter(m => m.kind === 'cut')
const plunges = moves.filter(m => m.kind === 'plunge')
console.log(`cuts=${cuts.length} plunges=${plunges.length}`)
console.log(`seq: ${moves.map(m => m.kind[0]).join('')}`)

// --- 1. Full move list ---
console.log('\n=== Full move list ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  const dir = dz > 0.002 ? 'UP' : dz < -0.002 ? 'DN' : '--'
  console.log(`[${String(i).padStart(3)}] ${m.kind.padEnd(6)} ${dir} from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)},${m.from.z.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)},${m.to.z.toFixed(4)}) xy=${xy.toFixed(4)} dz=${dz.toFixed(4)}`)
}

// --- 2. Dangerous Z plunges: cut moves where dz is very negative (deep sudden drop) ---
console.log('\n=== Dangerous Z drops in cut moves (dz < -0.05) ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const dz = m.to.z - m.from.z
  if (dz < -0.05) {
    const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    const prev = moves[i - 1]
    const next = moves[i + 1]
    console.log(`\n[${i}] CUT DROP dz=${dz.toFixed(4)} xy=${xy.toFixed(4)}`)
    console.log(`  from z=${m.from.z.toFixed(4)} to z=${m.to.z.toFixed(4)}`)
    if (prev) console.log(`  prev[${i-1}] ${prev.kind}: z ${prev.from.z.toFixed(4)}->${prev.to.z.toFixed(4)}`)
    if (next) console.log(`  next[${i+1}] ${next.kind}: z ${next.from.z.toFixed(4)}->${next.to.z.toFixed(4)}`)
  }
}

// --- 3. Z continuity violations: gap between consecutive move endpoints ---
console.log('\n=== Z continuity gaps between consecutive moves ===')
for (let i = 0; i < moves.length - 1; i++) {
  const curr = moves[i]
  const next = moves[i + 1]
  const zGap = Math.abs(next.from.z - curr.to.z)
  const xyGap = Math.hypot(next.from.x - curr.to.x, next.from.y - curr.to.y)
  if (zGap > 0.001 && xyGap < 0.001) {
    // Same XY but Z jumps — tool teleports in Z
    console.log(`[${i}]->[${i+1}] Z teleport: ${curr.to.z.toFixed(4)} -> ${next.from.z.toFixed(4)} (gap=${zGap.toFixed(4)}) kind=${curr.kind}->${next.kind}`)
  }
}

// --- 4. Z direction reversals in cut sequences (zig-zag signature) ---
console.log('\n=== Z direction reversals in consecutive cuts ===')
const cutMoves = moves.map((m, i) => ({ ...m, i })).filter(m => m.kind === 'cut')
for (let j = 1; j < cutMoves.length - 1; j++) {
  const prev = cutMoves[j - 1]
  const curr = cutMoves[j]
  const dz1 = curr.to.z - curr.from.z
  const dz2 = (cutMoves[j + 1].to.z - cutMoves[j + 1].from.z)
  if (Math.abs(dz1) > 0.015 && Math.abs(dz2) > 0.015 && Math.sign(dz1) !== Math.sign(dz2)) {
    console.log(`  [${curr.i}] dz=${dz1.toFixed(4)} then [${cutMoves[j+1].i}] dz=${dz2.toFixed(4)} at z=${curr.to.z.toFixed(4)} xy=(${curr.to.x.toFixed(4)},${curr.to.y.toFixed(4)})`)
  }
}

// --- 5. Z values that exceed stock bounds ---
// Stock thickness from project
const stockThickness = project.stock.thickness
console.log(`\n=== Z values outside valid range [0, ${stockThickness}] ===`)
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  for (const pt of [m.from, m.to]) {
    if (pt.z < 0 || pt.z > stockThickness + 0.001) {
      console.log(`[${i}] ${m.kind}: z=${pt.z.toFixed(6)} OUT OF RANGE`)
    }
  }
}

// --- 6. Retract-plunge pairs: show what each plunge is doing ---
console.log('\n=== Each retract->plunge transition ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind === 'rapid' && m.to.z > m.from.z) {
    const fromZ = m.from.z
    let j = i + 1
    while (j < moves.length && moves[j].kind === 'rapid') j++
    if (moves[j]?.kind === 'plunge') {
      const plunge = moves[j]
      const xyGap = Math.hypot(plunge.from.x - m.from.x, plunge.from.y - m.from.y)
      const budget = safeZ - Math.min(fromZ, plunge.to.z)
      console.log(`  retract[${i}] z=${fromZ.toFixed(4)} -> plunge[${j}] z=${plunge.to.z.toFixed(4)}, xyGap=${xyGap.toFixed(4)}, budget=${budget.toFixed(4)}`)
    }
  }
}
