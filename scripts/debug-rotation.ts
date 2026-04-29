import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Project } from '../src/types/project.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectPath = path.resolve(here, '../../purecutcnc/work/v-carve-skeleton-tests.camj')
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Project

const op = project.operations.find((o: any) => o.id === 'op0006')!
const result = generateVCarveRecursiveToolpath(project, op)

// Find move 161 and 162
for (let i = 155; i < Math.min(result.moves.length, 200); i++) {
  const m = result.moves[i]
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  console.log(`[${i}] ${m.kind} xy=${xy.toFixed(4)} dz=${dz.toFixed(4)} (${m.from.x.toFixed(3)},${m.from.y.toFixed(3)},${m.from.z.toFixed(4)})→(${m.to.x.toFixed(3)},${m.to.y.toFixed(3)},${m.to.z.toFixed(4)})`)
}

// Also check what the ORIGINAL code produces
console.log('\n=== Now checking if this exists in ORIGINAL code ===')
console.log('\n=== A moves 30-45 ===')
const opA = project.operations.find((o: any) => o.id === 'op0008')!
const resultA = generateVCarveRecursiveToolpath(project, opA)
for (let i = 30; i < 45 && i < resultA.moves.length; i++) {
  const m = resultA.moves[i]
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  console.log(`[${i}] ${m.kind} xy=${xy.toFixed(4)} dz=${dz.toFixed(4)} (${m.from.x.toFixed(3)},${m.from.y.toFixed(3)},${m.from.z.toFixed(4)})→(${m.to.x.toFixed(3)},${m.to.y.toFixed(3)},${m.to.z.toFixed(4)})`)
}

console.log('\n=== A moves 80-100 ===')
for (let i = 80; i < 100 && i < resultA.moves.length; i++) {
  const m = resultA.moves[i]
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  console.log(`[${i}] ${m.kind} xy=${xy.toFixed(4)} dz=${dz.toFixed(4)} (${m.from.x.toFixed(3)},${m.from.y.toFixed(3)},${m.from.z.toFixed(4)})→(${m.to.x.toFixed(3)},${m.to.y.toFixed(3)},${m.to.z.toFixed(4)})`)
}
