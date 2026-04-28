import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Project, ToolpathMove } from '../src/types/project.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectPath = path.resolve(here, '../../purecutcnc/work/v-carve-skeleton-tests.camj')
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Project

const op = project.operations.find((o: any) => o.id === 'op0006')!
const result = generateVCarveRecursiveToolpath(project, op)

// Print ALL moves for letter C, grouped
console.log('=== ALL C moves ===')
console.log(`Total moves: ${result.moves.length}`)
console.log('')

for (let i = 0; i < result.moves.length; i++) {
  const m = result.moves[i]
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  if (m.kind === 'rapid') {
    console.log(`[${i}] RAPID xy=${xy.toFixed(4)} dz=${dz.toFixed(4)} (${m.from.x.toFixed(3)},${m.from.y.toFixed(3)},${m.from.z.toFixed(4)})→(${m.to.x.toFixed(3)},${m.to.y.toFixed(3)},${m.to.z.toFixed(4)})`)
  } else {
    console.log(`[${i}] CUT   xy=${xy.toFixed(4)} dz=${dz.toFixed(4)} (${m.from.x.toFixed(3)},${m.from.y.toFixed(3)},${m.from.z.toFixed(4)})→(${m.to.x.toFixed(3)},${m.to.y.toFixed(3)},${m.to.z.toFixed(4)})`)
  }
}

// Also check ALL moves that are suspicious (long flat cuts)
console.log('\n=== SUSPICIOUS CUTS (>0.1" flat or near-flat) ===')
for (let i = 0; i < result.moves.length; i++) {
  const m = result.moves[i]
  if (m.kind !== 'cut') continue
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  if (xy > 0.1 && Math.abs(dz) < 0.001) {
    console.log(`[${i}] FLAT ${xy.toFixed(4)}" (${m.from.x.toFixed(3)},${m.from.y.toFixed(3)})→(${m.to.x.toFixed(3)},${m.to.y.toFixed(3)})`)
  }
}

// Check what the inter-path connections (tryDirectLink) look like
// by looking for consecutive paths where the transition has significant XY
console.log('\n=== PATH TRANSITIONS (potential tryDirectLink issues) ===')
console.log('Looking for where path N ends and path N+1 begins with a significant gap...')

// Find unique Z levels and group moves by Z
const zLevels = new Set<number>()
for (const m of result.moves) {
  if (m.kind === 'cut') {
    zLevels.add(Math.round(m.from.z * 10000))
    zLevels.add(Math.round(m.to.z * 10000))
  }
}
console.log('\nUnique Z levels (scaled by 10000):', [...zLevels].sort((a, b) => b - a).map(z => (z / 10000).toFixed(4)).join(', '))
