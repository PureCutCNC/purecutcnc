/**
 * Check if letter-e corners (op0012) are connected by bridgeSiblingChildren.
 * Run: npx tsx scripts/check-letter-e.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === 'op0012') as Operation
const result = generateVCarveRecursiveToolpath(project, operation)
const moves = result.moves

// Marker centers from camj: letter-e-point1 (f0071) and letter-e-point2 (f0072)
const pt1 = { x: 4.851095503430294, y: 1.0589458724045988 }
const pt2 = { x: 5.0255711334190405, y: 1.0539698946079412 }

console.log('letter-e-point1 center:', pt1)
console.log('letter-e-point2 center:', pt2)

// Check for cuts starting near pt1
console.log('\n=== Cuts starting near pt1 (tol=0.02) ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const d = Math.hypot(m.from.x - pt1.x, m.from.y - pt1.y)
  if (d < 0.02) {
    const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    console.log(`[${i}] xy=${xy.toFixed(4)} z=${m.from.z.toFixed(4)}->${m.to.z.toFixed(4)} from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)})`)
  }
}

// Check for cuts starting near pt2
console.log('\n=== Cuts starting near pt2 (tol=0.02) ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const d = Math.hypot(m.from.x - pt2.x, m.from.y - pt2.y)
  if (d < 0.02) {
    const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    console.log(`[${i}] xy=${xy.toFixed(4)} z=${m.from.z.toFixed(4)}->${m.to.z.toFixed(4)} from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)})`)
  }
}

// Check for single cut bridging both points
console.log('\n=== Single cut bridging pt1<->pt2 (tol=0.03) ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const d1 = Math.hypot(m.from.x - pt1.x, m.from.y - pt1.y)
  const d2 = Math.hypot(m.to.x - pt2.x, m.to.y - pt2.y)
  const r1 = Math.hypot(m.from.x - pt2.x, m.from.y - pt2.y)
  const r2 = Math.hypot(m.to.x - pt1.x, m.to.y - pt1.y)
  if ((d1 < 0.03 && d2 < 0.03) || (r1 < 0.03 && r2 < 0.03)) {
    console.log(`[${i}] MATCH from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)})`)
  }
}

// Check for cut chains: find paths that go from near pt1 to near pt2
console.log('\n=== Cuts ending near pt1 (tol=0.02) ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const d = Math.hypot(m.to.x - pt1.x, m.to.y - pt1.y)
  if (d < 0.02) {
    const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    console.log(`[${i}] xy=${xy.toFixed(4)} z=${m.from.z.toFixed(4)}->${m.to.z.toFixed(4)} from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)})`)
  }
}

console.log('\n=== Cuts ending near pt2 (tol=0.02) ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const d = Math.hypot(m.to.x - pt2.x, m.to.y - pt2.y)
  if (d < 0.02) {
    const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    console.log(`[${i}] xy=${xy.toFixed(4)} z=${m.from.z.toFixed(4)}->${m.to.z.toFixed(4)} from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)})`)
  }
}
