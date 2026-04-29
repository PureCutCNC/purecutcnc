import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Project } from '../src/types/project.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectPath = path.resolve(here, '../../purecutcnc/work/v-carve-skeleton-tests.camj')
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Project

function analyze(project: Project, opId: string, label: string) {
  const op = project.operations.find((o: any) => o.id === opId)!
  const result = generateVCarveRecursiveToolpath(project, op)
  
  console.log(`\n=== ${label} (${opId}): ${result.moves.length} moves ===`)
  
  // Print ALL cuts sorted by XY length (descending)
  const allCuts = result.moves
    .map((m, i) => ({ 
      index: i, 
      move: m, 
      xy: Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y), 
      dz: m.to.z - m.from.z,
      kind: m.kind
    }))
    .filter(m => m.kind === 'cut')
    .sort((a, b) => b.xy - a.xy)
  
  console.log(`Top 30 longest cuts (all types):`)
  for (const m of allCuts.slice(0, 30)) {
    const f = m.move.from, t = m.move.to
    const slope = Math.abs(m.dz) > 0.001 ? 'sloped' : 'flat'
    console.log(`  [${m.index}] ${m.xy.toFixed(4)}" ${slope} dz=${m.dz.toFixed(4)}: (${f.x.toFixed(3)},${f.y.toFixed(3)},${f.z.toFixed(4)})→(${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(4)})`)
  }
}

analyze(project, 'op0006', 'C')
analyze(project, 'op0008', 'A')
