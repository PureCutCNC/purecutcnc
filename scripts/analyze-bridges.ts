
import fs from 'node:fs'
import { Project } from '../src/types/project.ts'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'

const CAMJ_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project: Project = JSON.parse(fs.readFileSync(CAMJ_PATH, 'utf-8'))

const testOps = [
  { id: 'op0008', name: 'Letter A' },
  { id: 'op0012', name: 'Letter e' }
]

for (const testOp of testOps) {
  const op = project.operations.find(o => o.id === testOp.id)
  if (!op) continue

  console.log(`Analyzing ${testOp.name} (${testOp.id})...`)
  const result = generateVCarveRecursiveToolpath(project, op)
  const scBridges = result.moves.filter(m => m.source === 'sameChildBridge')
  console.log(`  Total sameChildBridge moves: ${scBridges.length}`)
  
  // Find depth 0 bridges (highest Z)
  const zMax = Math.max(...scBridges.map(m => m.from.z), -Infinity)
  const topBridges = scBridges.filter(m => Math.abs(m.from.z - zMax) < 1e-6)
  
  console.log(`  Top-level bridges (Z=${zMax.toFixed(4)}): ${topBridges.length}`)
  for (const m of topBridges) {
    console.log(`    (${m.from.x.toFixed(4)}, ${m.from.y.toFixed(4)}) -> (${m.to.x.toFixed(4)}, ${m.to.y.toFixed(4)})`)
  }
}
