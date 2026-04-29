import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Project, ToolpathMove } from '../src/types/project.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectPath = path.resolve(here, '../../purecutcnc/work/v-carve-skeleton-tests.camj')
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Project

function analyze(project: Project, opId: string) {
  const op = project.operations.find((o: any) => o.id === opId)!
  const result = generateVCarveRecursiveToolpath(project, op)
  
  // Find long flat cuts that look suspicious (straight lines that should be curved)
  console.log(`\n=== ${opId} ===`)
  console.log(`Total moves: ${result.moves.length}`)
  
  // Print ALL flat cuts sorted by XY length
  const flatCuts = result.moves
    .map((m, i) => ({ index: i, move: m, xy: Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y), dz: m.to.z - m.from.z }))
    .filter(m => m.move.kind === 'cut' && Math.abs(m.dz) < 0.001 && m.xy > 0.01)
    .sort((a, b) => b.xy - a.xy)
  
  console.log(`\nLong flat cuts (>0.01"):`)
  for (const m of flatCuts.slice(0, 30)) {
    const from = m.move.from, to = m.move.to
    console.log(`  [${m.index}] ${m.xy.toFixed(4)}" flat: (${from.x.toFixed(3)},${from.y.toFixed(3)})→(${to.x.toFixed(3)},${to.y.toFixed(3)})`)
  }

  // Look for suspicious patterns: two consecutive cuts where one is curved (dz != 0)
  // and the next is a long flat cut
  console.log(`\nSuspicious patterns (sloped cut followed by long flat cut):`)
  for (let i = 1; i < result.moves.length - 1; i++) {
    const prev = result.moves[i-1]
    const curr = result.moves[i]
    const next = result.moves[i+1]
    if (curr.kind !== 'cut' || next.kind !== 'cut') continue
    const currDz = curr.to.z - curr.from.z
    const nextXy = Math.hypot(next.to.x - next.from.x, next.to.y - next.from.y)
    const nextDz = next.to.z - next.from.z
    // Sloped cut followed by long flat cut
    if (Math.abs(currDz) > 0.001 && Math.abs(nextDz) < 0.001 && nextXy > 0.05) {
      console.log(`  [${i-1}]→[${i}]→[${i+1}]: prev_dz=${(prev.to.z-prev.from.z).toFixed(4)} curr_dz=${currDz.toFixed(4)} next_xy=${nextXy.toFixed(4)} next_dz=${nextDz.toFixed(4)}`)
    }
  }
}

analyze(project, 'op0006')
analyze(project, 'op0008')
