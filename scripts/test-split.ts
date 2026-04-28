import ClipperLib from 'clipper-lib'
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const OPERATION_ID = 'op0006'

const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((entry) => entry.id === OPERATION_ID) as Operation | undefined
if (!operation) throw new Error(`${OPERATION_ID} not found`)

const result = generateVCarveRecursiveToolpath(project, operation)

console.log(`Operation: ${OPERATION_ID}`)
console.log(`Total moves: ${result.moves.length}`)
console.log(`Cut moves: ${result.moves.filter(m => m.kind === 'cut').length}`)
console.log(`Warnings: ${result.warnings.length}`)
if (result.warnings.length > 0) {
  console.log('Warnings:', result.warnings)
}

// Count unique cut endpoints
const cutPoints = new Set<string>()
for (const m of result.moves) {
  if (m.kind === 'cut') {
    cutPoints.add(`${m.from.x.toFixed(6)},${m.from.y.toFixed(6)}`)
    cutPoints.add(`${m.to.x.toFixed(6)},${m.to.y.toFixed(6)}`)
  }
}
console.log(`Unique cut points: ${cutPoints.size}`)
