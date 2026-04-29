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

// Classify ALL moves
console.log('=== ALL MOVES ===')
for (let i = 0; i < result.moves.length; i++) {
  const m = result.moves[i]
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  const atDepth = m.from.z < 0.94  // below safeZ
  const rapidAtDepth = m.kind === 'rapid' && atDepth
  const flag = rapidAtDepth ? ' *** RAPID-AT-DEPTH ***' : ''
  console.log(`[${i}] ${m.kind} xy=${xy.toFixed(4)} dz=${dz.toFixed(4)} z=${m.from.z.toFixed(4)}→${m.to.z.toFixed(4)}${flag}`)
}

// Identify retract→rapid→plunge sequences
console.log('\n=== RETRACT → RAPID → PLUNGE sequences ===')
for (let i = 1; i < result.moves.length - 1; i++) {
  const prev = result.moves[i - 1]
  const curr = result.moves[i]
  const next = result.moves[i + 1]
  if (
    prev.kind === 'rapid' && prev.to.z >= 0.94 &&  // retract to safeZ
    curr.kind === 'rapid' && curr.from.z >= 0.94 && curr.to.z >= 0.94 &&  // rapid at safeZ
    next.kind === 'rapid' && next.from.z >= 0.94 && next.to.z < 0.94  // plunge from safeZ
  ) {
    console.log(`  Sequence at move [${i-1}]→[${i}]→[${i+1}]`)
  }
}

// Show all rapids that are NOT part of retract→rapid→plunge sequences
console.log('\n=== RAPIDS AT DEPTH (non-retract) ===')
for (let i = 0; i < result.moves.length; i++) {
  const m = result.moves[i]
  if (m.kind !== 'rapid') continue
  const atDepth = m.from.z < 0.94 || m.to.z < 0.94
  if (!atDepth) continue
  // Check if part of retract→rapid→plunge
  const isRetract = m.to.z >= 0.94 && m.from.z < 0.94
  const isPlunge = m.from.z >= 0.94 && m.to.z < 0.94
  const isSafeRapid = m.from.z >= 0.94 && m.to.z >= 0.94
  if (isRetract || isPlunge || isSafeRapid) continue
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  console.log(`  [${i}] ${m.kind} xy=${xy.toFixed(4)} dz=${dz.toFixed(4)} (${m.from.x.toFixed(3)},${m.from.y.toFixed(3)},${m.from.z.toFixed(4)})→(${m.to.x.toFixed(3)},${m.to.y.toFixed(3)},${m.to.z.toFixed(4)})`)
}

console.log(`\nTotal moves: ${result.moves.length}`)
console.log(`Total cuts: ${result.moves.filter(m => m.kind === 'cut').length}`)
console.log(`Total rapids: ${result.moves.filter(m => m.kind === 'rapid').length}`)
