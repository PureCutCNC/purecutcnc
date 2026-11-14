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
 * Issue #1209 P1 bench: generate a project's toolpaths headlessly, turn them
 * into the first setup's frame exactly as the app does, and write the
 * Visible-mode replay as a flat move table.
 *
 *   npx tsx scripts/proto-1209/dumpMoves.ts <file.camj> <outPrefix>
 *
 * Writes `<outPrefix>.moves.bin` (Float64 × 7 per material-removing move:
 * from xyz, to xyz, replay item index) and `<outPrefix>.meta.json`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

import { normalizeProject } from '../../src/store/helpers/projectFormat'
import { computeOperationToolpath } from '../../src/engine/toolpaths/generateOperation'
import { buildSimulationSetupInput, simulationSetups } from '../../src/app/simulationSetup'
import { visibleReplayOperations } from '../../src/app/simulationCompute'
import { findOperationTool } from '../../src/toolPolicy'
import { normalizeToolForProject } from '../../src/engine/toolpaths/geometry'
import { moveIsMaterialRemoving } from '../../src/engine/simulation/replay'
import type { ToolpathResult } from '../../src/engine/toolpaths/types'

const [file, outPrefix] = process.argv.slice(2)
if (!file || !outPrefix) throw new Error('usage: dumpMoves.ts <file.camj> <outPrefix>')

const project = normalizeProject(JSON.parse(readFileSync(file, 'utf8')))
const paths = new Map<string, ToolpathResult>()
for (const operation of project.operations) {
  const start = performance.now()
  const envelope = computeOperationToolpath(project, operation)
  if (envelope) paths.set(operation.id, envelope.result)
  console.log(`${operation.name}: ${envelope?.result.moves.length ?? 0} moves, ${(performance.now() - start).toFixed(0)} ms`)
}

const setup = simulationSetups(project)[0]
const setupInput = buildSimulationSetupInput(project, setup, paths)
if (!setupInput) throw new Error('no simulation for the first setup')
const local = setupInput.project

const items: Array<{ name: string; toolType: string; toolRadius: number; vBitAngle: number | null; start: number; count: number }> = []
const values: number[] = []
for (const operation of visibleReplayOperations(local, setupInput.operations)) {
  const toolpath = setupInput.toolpaths.get(operation.id)
  const toolRecord = findOperationTool(local, operation)
  if (!toolpath || !toolRecord) continue
  const tool = normalizeToolForProject(toolRecord, local)
  const start = values.length / 7
  for (const move of toolpath.moves) {
    if (!moveIsMaterialRemoving(move)) continue
    values.push(move.from.x, move.from.y, move.from.z, move.to.x, move.to.y, move.to.z, items.length)
  }
  items.push({ name: operation.name, toolType: toolRecord.type, toolRadius: tool.radius, vBitAngle: tool.vBitAngle, start, count: values.length / 7 - start })
}

writeFileSync(`${outPrefix}.moves.bin`, Buffer.from(new Float64Array(values).buffer))
writeFileSync(`${outPrefix}.meta.json`, JSON.stringify({ file, units: local.meta?.units ?? null, stock: local.stock, items }, null, 2))
console.log(`wrote ${values.length / 7} material-removing moves in ${items.length} items`)
