import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === 'op0012') as Operation
const result = generateVCarveRecursiveToolpath(project, operation)

// Cluster A: moves 160-165
console.log('=== Cluster A (moves 160-165) ===')
for (let i = 160; i <= 165; i++) {
  const m = result.moves[i]
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  console.log(`[${i}] from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)},${m.from.z.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)},${m.to.z.toFixed(4)}) xy=${xy.toFixed(4)} dz=${dz.toFixed(4)}`)
}

// Is [162].from === [163].to? (back-and-forth to same point)
const m162 = result.moves[162]
const m163 = result.moves[163]
console.log(`\n[162].from == [163].to: x=${m162.from.x === m163.to.x} y=${m162.from.y === m163.to.y} z=${m162.from.z === m163.to.z}`)
console.log(`[162] goes to (${m162.to.x.toFixed(4)},${m162.to.y.toFixed(4)},${m162.to.z.toFixed(4)})`)
console.log(`[163] goes to (${m163.to.x.toFixed(4)},${m163.to.y.toFixed(4)},${m163.to.z.toFixed(4)}) -- same as [162].from`)

// Cluster B: moves 176-185
console.log('\n=== Cluster B (moves 176-185) ===')
for (let i = 176; i <= 185; i++) {
  const m = result.moves[i]
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  console.log(`[${i}] from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)},${m.from.z.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)},${m.to.z.toFixed(4)}) xy=${xy.toFixed(4)} dz=${dz.toFixed(4)}`)
}

// The tiny "down" connector segments in cluster B
console.log('\nTiny down-segments in cluster B (the zig part):')
for (const i of [178, 180, 182, 184]) {
  const m = result.moves[i]
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  console.log(`  [${i}] xy=${xy.toFixed(6)} dz=${(m.to.z - m.from.z).toFixed(4)}`)
}

// What are the two interleaved chains in cluster B?
// Chain 1 (the "up" arm): 176,177, then 179,181,183,185 -- going deeper
// Chain 2 (the "down" connector): 178,180,182,184 -- tiny XY, going shallower
// These look like two separate arm chains that were chained together by chainPaths
// because their endpoints happen to be within float tolerance of each other.
// Let's check endpoint matching:
console.log('\nEndpoint chain in cluster B:')
for (let i = 176; i <= 184; i++) {
  const curr = result.moves[i]
  const next = result.moves[i + 1]
  const gap = Math.hypot(next.from.x - curr.to.x, next.from.y - curr.to.y)
  const dzGap = Math.abs(next.from.z - curr.to.z)
  console.log(`  [${i}].to -> [${i+1}].from: xyGap=${gap.toFixed(6)} zGap=${dzGap.toFixed(6)}`)
}
