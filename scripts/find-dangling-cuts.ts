/**
 * Find suspiciously short cut segments whose endpoints don't chain to other
 * cuts — i.e. "dangling" tiny lines that appear in the toolpath visualization
 * but don't actually connect anything.
 *
 * Run: CAMJ_PATH=... OP_ID=... npx tsx scripts/find-dangling-cuts.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = process.env.CAMJ_PATH ?? '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const OPERATION_ID = process.env.OP_ID ?? 'op0006'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project

const operations = OPERATION_ID === 'all'
  ? project.operations.filter((o) => o.kind === 'v_carve_recursive' && o.enabled !== false)
  : [project.operations.find((o) => o.id === OPERATION_ID)].filter(Boolean) as Operation[]

for (const operation of operations) {
  console.log(`\n=== ${operation.id} ${operation.name} ===`)
  const result = generateVCarveRecursiveToolpath(project, operation)
  const stepSize = operation.stepover

  // Index XY cut endpoints. Two cuts "chain" if start of one ≈ end of another.
  const cuts = result.moves.filter((m) => m.kind === 'cut')
  const key = (p: { x: number, y: number }): string => `${p.x.toFixed(6)},${p.y.toFixed(6)}`
  const startCount = new Map<string, number>()
  const endCount = new Map<string, number>()
  for (const m of cuts) {
    startCount.set(key(m.from), (startCount.get(key(m.from)) ?? 0) + 1)
    endCount.set(key(m.to), (endCount.get(key(m.to)) ?? 0) + 1)
  }

  // Suspicious cut: short (<2× stepSize) AND neither endpoint matches any
  // other cut endpoint (so it's a stranded segment with no neighbours).
  const suspicious = cuts.filter((m) => {
    const lenXY = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    if (lenXY > stepSize * 2) return false
    const fromHasNeighbour = (startCount.get(key(m.from)) ?? 0) + (endCount.get(key(m.from)) ?? 0) > 1
    const toHasNeighbour = (startCount.get(key(m.to)) ?? 0) + (endCount.get(key(m.to)) ?? 0) > 1
    return !fromHasNeighbour || !toHasNeighbour
  })

  console.log(`stepSize=${stepSize} cuts=${cuts.length} suspicious=${suspicious.length}`)
  for (const m of suspicious.slice(0, 30)) {
    const lenXY = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    const dz = m.to.z - m.from.z
    const fromN = (startCount.get(key(m.from)) ?? 0) + (endCount.get(key(m.from)) ?? 0)
    const toN = (startCount.get(key(m.to)) ?? 0) + (endCount.get(key(m.to)) ?? 0)
    console.log(
      `  from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)},${m.from.z.toFixed(4)}) `
      + `to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)},${m.to.z.toFixed(4)}) `
      + `lenXY=${lenXY.toFixed(4)} dz=${dz.toFixed(4)} fromNeighbours=${fromN} toNeighbours=${toN}`,
    )
  }
}
