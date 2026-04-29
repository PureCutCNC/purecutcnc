import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Project } from '../src/types/project.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectPath = path.resolve(here, '../../purecutcnc/work/v-carve-skeleton-tests.camj')
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Project

const opIds = ['op0006', 'op0008', 'op0009', 'op0012', 'op0046', 'op0047']
const opNames: Record<string, string> = {
  op0006: 'C', op0008: 'A', op0009: 'T',
  op0012: 'e', op0046: 'o', op0047: 'circle',
}

for (const opId of opIds) {
  const op = project.operations.find((o: any) => o.id === opId)
  if (!op) { console.log(`  ${opId}: NOT FOUND`); continue }
  const result = generateVCarveRecursiveToolpath(project, op)
  const cuts = result.moves.filter((m: any) => m.kind === 'cut').length
  const rapids = result.moves.filter((m: any) => m.kind === 'rapid').length
  console.log(`  ${opNames[opId]} (${opId}): ${cuts} cuts, ${rapids} rapids, ${result.moves.length} total`)
}
