/**
 * Find cuts near the user's marker circles in the camj file.
 * Run: npx tsx scripts/find-near-markers.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === 'op0008') as Operation
const result = generateVCarveRecursiveToolpath(project, operation)
const moves = result.moves

// Circle centers from camj
const startPt = { x: 2.692129716470091, y: 1.293678497077044 }
const endPt = { x: 2.7799460509985154, y: 1.1981256691554563 }

console.log('start-point center:', startPt)
console.log('end-point center:', endPt)

console.log('\n=== Cuts near start OR end (tol=0.03) ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const dFrom = Math.hypot(m.from.x - startPt.x, m.from.y - startPt.y)
  const dTo = Math.hypot(m.to.x - endPt.x, m.to.y - endPt.y)
  const dFrom2 = Math.hypot(m.from.x - endPt.x, m.from.y - endPt.y)
  const dTo2 = Math.hypot(m.to.x - startPt.x, m.to.y - startPt.y)
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  
  if ((dFrom < 0.03 && dTo < 0.03) || (dFrom2 < 0.03 && dTo2 < 0.03)) {
    console.log(`[${i}] MATCH xy=${xy.toFixed(4)} dz=${dz.toFixed(4)} z=${m.from.z.toFixed(4)}->${m.to.z.toFixed(4)}`)
    console.log(`  from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)})`)
  }
}

console.log('\n=== Cuts starting near start-point (tol=0.02) ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const d = Math.hypot(m.from.x - startPt.x, m.from.y - startPt.y)
  if (d < 0.02) {
    const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    console.log(`[${i}] xy=${xy.toFixed(4)} z=${m.from.z.toFixed(4)}->${m.to.z.toFixed(4)} from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)})`)
  }
}

console.log('\n=== Cuts ending near end-point (tol=0.02) ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const d = Math.hypot(m.to.x - endPt.x, m.to.y - endPt.y)
  if (d < 0.02) {
    const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    console.log(`[${i}] xy=${xy.toFixed(4)} z=${m.from.z.toFixed(4)}->${m.to.z.toFixed(4)} from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)})`)
  }
}

// Also check non-cut moves for proximity
console.log('\n=== Non-cut moves near markers ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind === 'cut') continue
  const dFrom = Math.hypot(m.from.x - startPt.x, m.from.y - startPt.y)
  const dTo = Math.hypot(m.to.x - endPt.x, m.to.y - endPt.y)
  if (dFrom < 0.03 || dTo < 0.03) {
    console.log(`[${i}] ${m.kind} from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)})`)
  }
}
