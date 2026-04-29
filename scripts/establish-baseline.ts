
import fs from 'node:fs'
import { Project } from '../src/types/project.ts'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'

const CAMJ_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const camjRaw = fs.readFileSync(CAMJ_PATH, 'utf-8')
const project: Project = JSON.parse(camjRaw)

const results: Record<string, number> = {}

console.log('Establishing baseline cut counts...\n')

for (const op of project.operations) {
  if (op.kind !== 'v_carve_recursive') continue

  const result = generateVCarveRecursiveToolpath(project, op)
  const cutCount = result.moves.filter(m => m.kind === 'cut').length
  results[op.name || op.id] = cutCount
  console.log(`${(op.name || op.id).padEnd(25)}: ${cutCount} cuts`)
}

fs.writeFileSync('scripts/baseline_cuts.json', JSON.stringify(results, null, 2))
