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
 * #1173: write an operation (or a run of them) out as a G-code program the way
 * the app posts it, so a fix can be dry-run on the machine before the PR.
 *
 *   npx tsx scripts/issue-1173-export.ts <project.camj> [outDir] [op ids...] [--units mm|inch] [--tag NN]
 *
 * `--tag` names the issue the export is for (default `1173`), so a later fix can
 * produce its own `<stem>-<tag>_<op>.nc` files beside the earlier run's.
 *
 * `--units` converts the project with the app's own conversion
 * (`convertProjectUnits` plus the canned-shape rebuild `setUnits` does, so the
 * models follow their parameters) before generating, which is how Frank's
 * original export is millimetre from an inch project. The post writes the
 * project's units, so this is the only way to get a G21 program out of an inch
 * file without changing the file.
 *
 * With no op ids every enabled operation in the file is exported, and the
 * program carries all of them in file order -- the sequence a dry run needs,
 * since a finish runs on the material its rough left. One file per requested
 * operation is written beside it as `<name>_<opId>.nc`, and the combined one as
 * `<name>_all.nc`, into `work/` unless `outDir` says otherwise.
 *
 * The machine is the project's own when it carries one
 * (`meta.selectedMachineId` in `meta.machineDefinitions`); a file that carries
 * none -- Frank's `bolt-test-02-x.camj` does -- is posted with the bundled GRBL
 * definition plus an X about-the-bar rotary, which is the same fallback
 * `rotary-generation-probe.ts` uses and reproduces the header of his original
 * export. The post stamps the day, so two runs a day apart differ in one line.
 *
 * Two guards: the output may never be the project's own path (a diagnostic that
 * overwrites its input) and its program name is the project's, never a guess.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import { convertProjectUnits } from '../src/utils/units'
import { rebuildCannedShapeModels } from '../src/cannedShapes/model'
import type { Units } from '../src/utils/units'
import { computeOperationToolpath } from '../src/engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import { runPostProcessor } from '../src/engine/gcode/postprocessor'
import { validateMachineDefinition } from '../src/engine/gcode/types'
import { BUNDLED_DEFINITIONS } from '../src/engine/gcode/definitions'
import type { MachineDefinition } from '../src/engine/gcode/types'
import type { Operation, Project } from '../src/types/project'

const FALLBACK_MACHINE = 'grbl'

function postMachine(project: Project): { definition: MachineDefinition; id: string } {
  const selectedId = project.meta.selectedMachineId
  if (selectedId) {
    const stored = project.meta.machineDefinitions.find((definition) => definition.id === selectedId)
    if (!stored) throw new Error(`the project selects machine ${selectedId}, which it does not carry`)
    return { definition: validateMachineDefinition(stored), id: selectedId }
  }
  const base = BUNDLED_DEFINITIONS.find((definition) => definition.id === FALLBACK_MACHINE)
  if (!base) throw new Error(`this checkout bundles no ${FALLBACK_MACHINE} machine definition to post with`)
  const shape = project.stock.shape
  const about = (shape === 'round' || shape === 'square') && project.stock.axis ? project.stock.axis : 'x'
  return {
    definition: validateMachineDefinition({
      ...structuredClone(base),
      rotary: { about, drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
    }),
    id: `${base.id}+${about}-rotary`,
  }
}

function post(project: Project, operations: readonly Operation[], machine: { definition: MachineDefinition }): string {
  const entries = operations.map((operation) => {
    const stored = project.tools.find((tool) => tool.id === operation.toolRef)
    if (!stored) throw new Error(`${operation.id} targets ${operation.toolRef}, which the project does not carry`)
    const enveloped = computeOperationToolpath(project, operation)
    if (!enveloped) throw new Error(`${operation.id} produces no toolpath`)
    return { operation, tool: normalizeToolForProject(stored, project), toolpath: enveloped.result }
  })
  return runPostProcessor({
    project,
    operations: entries,
    definition: machine.definition,
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  }).gcode
}

const projectPath = process.argv[2]
if (!projectPath) {
  console.error('usage: npx tsx scripts/issue-1173-export.ts <project.camj> [outDir] [op ids...]')
  process.exit(2)
}
const flags = process.argv.slice(4)
const unitsFlag = flags.includes('--units') ? flags[flags.indexOf('--units') + 1] : undefined
const tagIndex = flags.indexOf('--tag')
const tag = tagIndex >= 0 ? flags[tagIndex + 1] : '1173'
if (!/^[0-9]+$/.test(tag)) throw new Error(`--tag takes an issue number, not ${tag ?? '(nothing)'}`)
if (unitsFlag !== undefined && unitsFlag !== 'mm' && unitsFlag !== 'inch') {
  throw new Error(`--units takes mm or inch, not ${unitsFlag}`)
}
const requested = flags.filter((value, index) => value !== '--units' && value !== '--tag'
  && flags[index - 1] !== '--units' && flags[index - 1] !== '--tag')
const loaded = normalizeProject(JSON.parse(readFileSync(projectPath, 'utf8')))
const project: Project = unitsFlag === undefined || unitsFlag === loaded.meta.units
  ? loaded
  : rebuildCannedShapeModels(convertProjectUnits(loaded, unitsFlag as Units))
const outDir = resolve(process.argv[3] ?? 'work')
const enabled = project.operations.filter((operation) => operation.enabled !== false)
const wanted = requested.length === 0
  ? enabled
  : requested.map((id) => {
    const found = project.operations.find((operation) => operation.id === id)
    if (!found) throw new Error(`the project has no operation ${id}`)
    return found
  })

mkdirSync(outDir, { recursive: true })
// The units are part of the name: an inch project exported in mm is the file
// Frank's own original is (`bolt-test-02-x-mm_…`), and the two must not
// overwrite each other.
const stem = `${basename(projectPath, extname(projectPath))}-${project.meta.units}`
const machine = postMachine(project)
const guard = (out: string): void => {
  if (resolve(out) === resolve(projectPath)) throw new Error(`${out} is the project itself`)
}
const written: string[] = []
const combinedPath = join(outDir, `${stem}-${tag}_all.nc`)
guard(combinedPath)
writeFileSync(combinedPath, post(project, wanted, machine))
written.push(combinedPath)
for (const operation of wanted) {
  const out = join(outDir, `${stem}-${tag}_${operation.id}.nc`)
  guard(out)
  writeFileSync(out, post(project, [operation], machine))
  written.push(out)
}
const shown = (path: string): string => {
  const inside = relative(process.cwd(), path)
  return inside.startsWith('..') || isAbsolute(inside) ? path : inside
}
for (const path of written) {
  console.log(`${shown(path)}  ${readFileSync(path, 'utf8').split('\n').length} lines`)
}
console.log(`machine ${machine.id}; operations ${wanted.map((operation) => operation.id).join(', ')}`)
