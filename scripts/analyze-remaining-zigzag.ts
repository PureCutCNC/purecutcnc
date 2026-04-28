import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project

const cases: Array<[string, number]> = [
  ['op0012', 20],
  ['op0012', 76],
  ['op0009', 53],
  ['op0047', 6],
]

for (const [opId, idx] of cases) {
  const operation = project.operations.find(o => o.id === opId)!
  const result = generateVCarveRecursiveToolpath(project, operation)
  const moves = result.moves
  const i = idx

  console.log(`\n${opId} around [${i}]:`)
  for (let j = i - 3; j <= i + 4; j++) {
    if (j < 0 || j >= moves.length) continue
    const m = moves[j]
    const dz = m.to.z - m.from.z
    const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    const marker = (j === i || j === i + 1) ? ' <<<' : ''
    console.log(`  [${String(j).padStart(3)}] ${m.kind.padEnd(6)} from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)},${m.from.z.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)},${m.to.z.toFixed(4)}) xy=${xy.toFixed(4)} dz=${dz.toFixed(4)}${marker}`)
  }

  const a = moves[i]
  const b = moves[i + 1]
  const sharedMid = a.to.x === b.from.x && a.to.y === b.from.y && a.to.z === b.from.z
  const pivot = a.from.x === b.to.x && a.from.y === b.to.y && a.from.z === b.to.z
  console.log(`  sharedMid(A.to==B.from): ${sharedMid}`)
  console.log(`  pivot(A.from==B.to): ${pivot}`)

  // Walk backward to find path start
  let pathStart = i
  while (pathStart > 0 && moves[pathStart - 1].kind === 'cut') pathStart--
  let pathEnd = i + 1
  while (pathEnd < moves.length - 1 && moves[pathEnd + 1].kind === 'cut') pathEnd++
  console.log(`  Path spans [${pathStart}..${pathEnd}] — reversal is at offset ${i - pathStart} within path of length ${pathEnd - pathStart + 1}`)
  console.log(`  => These are NOT 2-point segments — they are inside a longer chained path`)
  console.log(`  => The cycle guard in chainPaths only prevents cycles at chain-join points`)
  console.log(`  => These reversals are WITHIN a single chained path, not at join boundaries`)
}
