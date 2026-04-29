
import fs from 'node:fs'
import { Project } from '../src/types/project.ts'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'

const CAMJ_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const camjRaw = fs.readFileSync(CAMJ_PATH, 'utf-8')
const project: Project = JSON.parse(camjRaw)

const baselineRaw = fs.readFileSync('scripts/baseline_cuts.json', 'utf-8')
const baseline: Record<string, number> = JSON.parse(baselineRaw)

console.log('Comparing current cut counts with baseline...\n')
console.log(`${'Operation'.padEnd(25)} | Baseline | Current | Diff`)
console.log(`${'-'.repeat(25)}-|----------|---------|------`)

for (const op of project.operations) {
  if (op.kind !== 'v_carve_recursive') continue

  const result = generateVCarveRecursiveToolpath(project, op)
  const cutCount = result.moves.filter(m => m.kind === 'cut').length
  const name = op.name || op.id
  const baseCount = baseline[name] || 0
  const diff = cutCount - baseCount
  
  console.log(`${name.padEnd(25)} | ${String(baseCount).padStart(8)} | ${String(cutCount).padStart(7)} | ${diff > 0 ? '+' : ''}${diff}`)
}
