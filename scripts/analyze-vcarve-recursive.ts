import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project, SketchFeature, Tool, ToolpathMove } from '../src/types/project.ts'

function summarizeMoves(label: string, moves: ToolpathMove[]) {
  const longCuts = moves
    .map((move, index) => ({
      index,
      kind: move.kind,
      lengthXY: Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y),
      dz: move.to.z - move.from.z,
      from: move.from,
      to: move.to,
    }))
    .filter((move) => move.kind === 'cut')
    .sort((a, b) => b.lengthXY - a.lengthXY)

  console.log(`\n=== ${label} ===`)
  console.log(`cut count: ${moves.filter((move) => move.kind === 'cut').length}`)
  console.log(`rapid count: ${moves.filter((move) => move.kind === 'rapid').length}`)
  console.log('top 20 longest cuts:')
  for (const move of longCuts.slice(0, 20)) {
    console.log(JSON.stringify(move))
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const projectPath = path.resolve(here, '../../purecutcnc/work/purecutcnc.camj')
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Project

const feature = project.features.find((entry) => entry.id === 'f0003') as SketchFeature | undefined
const tool = project.tools.find((entry) => entry.id === 't0012') as Tool | undefined
const baseOperation = project.operations.find((entry) => entry.id === 'op0018') as Operation | undefined

if (!feature || !tool || !baseOperation) {
  throw new Error('Expected feature f0003, tool t0012, and operation op0018 in project file')
}

for (const stepover of [0.01, 0.04, 0.08]) {
  const operation: Operation = {
    ...baseOperation,
    stepover,
    showToolpath: true,
    debugToolpath: true,
  }
  const result = generateVCarveRecursiveToolpath(project, operation)
  console.log(`warnings(${stepover}): ${result.warnings.join(' | ')}`)
  summarizeMoves(`stepover ${stepover}`, result.moves)
}
