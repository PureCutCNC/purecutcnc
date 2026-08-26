import fs from 'node:fs'
import type { Project } from '../src/types/project.ts'

const PROJECT_PATH = process.argv[2] ?? 'work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project

console.log('Available operations:')
for (const op of project.operations) {
  console.log(`  ${op.id}: ${op.kind} (${op.name || 'unnamed'})`)
}
