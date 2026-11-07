/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * #1155 rn-a: compare every point a rotary operation emits on this checkout with
 * a baseline checkout's run of the same operation (`compareRotaryDepth`).
 *
 * Usage:
 *   npx tsx scripts/issue-1155-bolt-depth-probe.ts <baseline checkout> <project.camj> <op>[,<op>...]
 *
 * The baseline checkout is a second worktree at the commit to compare with
 * (`428a285e` for rn-a). The project is read from where it is (Frank's files stay
 * in the primary checkout's `work/`). For each operation it prints the move
 * counts, how many points lie on a baseline cut, between two, in the air or
 * uncovered in material, and the deepest point relative to the baseline. The
 * depth tolerance is one height-map cell and the widest along gap one stepover,
 * both derived from the operation and its tool exactly as the generator derives
 * them. Exits non-zero when a point is too deep or uncovered in material.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Operation, Project, Tool } from '../src/types/project'
import type { NormalizedTool, ToolpathMove } from '../src/engine/toolpaths/types'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import { computeOperationToolpath } from '../src/engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import { barMaxRadius, isBarStock } from '../src/types/barStock'
import { compareRotaryDepth } from '../src/test/rotaryDepthCompare'

interface Engine {
  normalizeProject(input: unknown): Project
  computeOperationToolpath(project: Project, operation: Operation): { result: { moves: ToolpathMove[] } } | null
}

async function baselineEngine(root: string): Promise<Engine> {
  const load = async <T>(path: string): Promise<T> => (await import(pathToFileURL(resolve(root, path)).href)) as T
  const format = await load<Pick<Engine, 'normalizeProject'>>('src/store/helpers/projectFormat.ts')
  const generation = await load<Pick<Engine, 'computeOperationToolpath'>>('src/engine/toolpaths/generateOperation.ts')
  return { normalizeProject: format.normalizeProject, computeOperationToolpath: generation.computeOperationToolpath }
}

async function main(): Promise<void> {
  const [baselineRoot, projectPath, ops] = process.argv.slice(2)
  if (!baselineRoot || !projectPath || !ops) {
    console.error('usage: issue-1155-bolt-depth-probe.ts <baseline checkout> <project.camj> <op>[,<op>...]')
    process.exitCode = 2
    return
  }
  const raw: unknown = JSON.parse(readFileSync(projectPath, 'utf8'))
  const base = await baselineEngine(baselineRoot)
  const baseProject = base.normalizeProject(raw)
  const project = normalizeProject(raw as Parameters<typeof normalizeProject>[0])
  if (!isBarStock(project.stock)) throw new Error('the project is not on a bar')
  let failed = false
  for (const id of ops.split(',')) {
    const operation = project.operations.find((candidate) => candidate.id === id)
    const baseOperation = baseProject.operations.find((candidate) => candidate.id === id)
    if (!operation || !baseOperation) throw new Error(`no operation ${id}`)
    const record: Tool | undefined = project.tools.find((tool) => tool.id === operation.toolRef)
    if (!record) throw new Error(`${id} has no tool`)
    const tool: NormalizedTool = normalizeToolForProject(record, project)
    // The generator's own cell and stepover (`rotaryOperation.ts`, `rotaryContext`).
    const stepover = Math.max((operation.stepover ?? 0.5) * tool.diameter, 1e-3)
    const cell = Math.min(tool.radius / 3, stepover * 0.5)
    const baseline = base.computeOperationToolpath(baseProject, baseOperation)?.result.moves ?? []
    const candidate = computeOperationToolpath(project, operation)?.result.moves ?? []
    const result = compareRotaryDepth(baseline, candidate, project.stock, {
      alongTolerance: 1e-6,
      maxAlongGap: stepover + 1e-6,
      depthTolerance: cell,
      airRadius: barMaxRadius(project.stock),
    })
    if (result.tooDeep > 0 || result.uncoveredInMaterial > 0) failed = true
    console.log(`${id}: ${baseline.length} -> ${candidate.length} moves; ${result.points} points: `
      + `${result.covered} on a baseline cut, ${result.bracketed} between two, ${result.uncoveredInAir} in the air, `
      + `${result.uncoveredInMaterial} uncovered in material, ${result.tooDeep} deeper than one ${cell} cell; `
      + `deepest ${result.deepest} (${result.where})`)
  }
  if (failed) process.exitCode = 1
}

void main()
