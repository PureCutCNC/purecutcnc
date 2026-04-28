import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Project } from '../src/types/project.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectPath = path.resolve(here, '../../purecutcnc/work/v-carve-skeleton-tests.camj')
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Project

// Compare C (op0006) output with detailed breakdown
const op = project.operations.find((o: any) => o.id === 'op0006')!
const result = generateVCarveRecursiveToolpath(project, op)

const cuts = result.moves.filter((m: any) => m.kind === 'cut')
const rapids = result.moves.filter((m: any) => m.kind === 'rapid')

console.log(`C (op0006):`)
console.log(`  total moves: ${result.moves.length}`)
console.log(`  cuts: ${cuts.length}`)
console.log(`  rapids: ${rapids.length}`)

// Count moves by Z direction
const descending = cuts.filter((m: any) => m.to.z < m.from.z)
const rising = cuts.filter((m: any) => m.to.z > m.from.z)
const flat = cuts.filter((m: any) => m.to.z === m.from.z)
console.log(`  descending cuts: ${descending.length}`)
console.log(`  rising cuts: ${rising.length}`)
console.log(`  flat cuts: ${flat.length}`)

// Print all moves
console.log('\nAll moves:')
for (let i = 0; i < result.moves.length; i++) {
  const m = result.moves[i]
  const dz = m.to.z - m.from.z
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  if (m.kind === 'cut' && Math.abs(dz) > 0.001) {
    console.log(`  [${i}] CUT dz=${dz.toFixed(4)} xy=${xy.toFixed(4)} (${m.from.x.toFixed(2)},${m.from.y.toFixed(2)},${m.from.z.toFixed(4)})→(${m.to.x.toFixed(2)},${m.to.y.toFixed(2)},${m.to.z.toFixed(4)})`)
  }
}
