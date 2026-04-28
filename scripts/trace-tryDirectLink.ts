/**
 * Trace the exact path-sorting and tryDirectLink behavior around move [29].
 * Run: npx tsx scripts/trace-tryDirectLink.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project, ToolpathMove } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === 'op0008') as Operation

// Patch tryDirectLink at runtime via prototype or module-level. Instead, let's
// use the diag info already available and examine moves around [29].

const result = generateVCarveRecursiveToolpath(project, operation)
const moves = result.moves

// Show moves [26] through [35] with full detail, including:
// - kind, from, to
// - xy distance, dz, dz/xy slope ratio
// - whether it's a tryDirectLink-like connection (cut that connects non-adjacent paths)
const start = 26
const end = 35

console.log('=== Moves 26-35 with slope analysis ===')
console.log('V-bit slope = tan(30°) = 0.5774')
console.log('')
for (let i = start; i <= end && i < moves.length; i++) {
  const m = moves[i]
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  const slope = xy > 1e-9 ? Math.abs(dz) / xy : 0
  
  console.log(`[${i}] ${m.kind.padEnd(5)} xy=${xy.toFixed(4)}" dz=${dz.toFixed(4)}" slope=${slope.toFixed(4)} ${slope > 0.5774 ? '*** EXCEEDS V-BIT ***' : ''}`)
  console.log(`     from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)},${m.from.z.toFixed(4)})`)
  console.log(`     to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)},${m.to.z.toFixed(4)})`)
  console.log('')
}

// Find all descending cut moves that exceed V-bit slope
console.log('=== ALL descending cuts exceeding V-bit slope ===')
let exceedCount = 0
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  if (dz >= 0) continue // not descending
  const slope = xy > 1e-9 ? Math.abs(dz) / xy : 0
  if (slope > 0.5774) {
    exceedCount++
    if (exceedCount <= 15) {
      console.log(`[${i}] xy=${xy.toFixed(4)}" dz=${dz.toFixed(4)} slope=${slope.toFixed(4)}`)
      console.log(`     from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)},${m.from.z.toFixed(4)})`)
      console.log(`     to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)},${m.to.z.toFixed(4)})`)
      console.log('')
    }
  }
}
console.log(`Total descending cuts exceeding V-bit slope: ${exceedCount}`)

// Check tryDirectLink V-cone radius formula
console.log('\n=== tryDirectLink check for move [29] ===')
const m29 = moves[29] as ToolpathMove
if (m29) {
  const safeZ = 0.95 // from stock thickness + clearance
  const xy = Math.hypot(m29.to.x - m29.from.x, m29.to.y - m29.from.y)
  const minZ = Math.min(m29.from.z, m29.to.z)
  const depthBudget = safeZ - minZ
  const slope = 0.5774
  const vConeRadius = depthBudget * slope
  
  console.log(`safeZ = ${safeZ}`)
  console.log(`minZ  = ${minZ}`)
  console.log(`depthBudget = safeZ - minZ = ${depthBudget.toFixed(4)}`)
  console.log(`V-cone radius at minZ = depthBudget * slope = ${vConeRadius.toFixed(4)}`)
  console.log(`xyDist = ${xy.toFixed(4)}`)
  console.log('')
  console.log(`Current check: xyDist <= depthBudget?  ${xy.toFixed(4)} <= ${depthBudget.toFixed(4)}? ${xy <= depthBudget ? 'PASSES ✓' : 'FAILS ✗'}`)
  console.log(`Correct V-cone check: xyDist <= depthBudget * slope?  ${xy.toFixed(4)} <= ${vConeRadius.toFixed(4)}? ${xy <= vConeRadius ? 'PASSES ✓' : 'FAILS ✗'}`)
  console.log(`Slope check: |dz|/xyDist <= slope?  ${(Math.abs(m29.to.z - m29.from.z) / xy).toFixed(4)} <= ${slope.toFixed(4)}? ${Math.abs(m29.to.z - m29.from.z) / xy <= slope ? 'PASSES ✓' : 'FAILS ✗ ← THIS WOULD FIX IT'}`)
}
