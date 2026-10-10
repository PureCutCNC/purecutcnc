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
 * #983 feed repair: the drop feed through the real store -> generation -> export
 * path, with no fixture override.
 *
 * The verified finding was that `normalizeToolForProject` zeroed a plasma
 * tool's plunge feed, so configuring the tool after an operation existed still
 * emitted `G1 Z... F0.000`, and nothing blocked the export. The existing plasma
 * fixtures set `defaultPlungeFeed` when they build the operation, which masked
 * it: the operation's own value won before normalization mattered.
 *
 * These cases drive the production actions (`addTool`, `updateTool`,
 * `addOperation`) and the inline generation service, so the values and the
 * normalized tool are exactly what a user produces. They assert the emitted
 * feed, the blocking error codes, and that the QtPlasmaC controller path is
 * unchanged.
 *
 * The example torch carries a drop feed of 300 mm/min, so a first export from
 * a new project is not blocked. The block itself is unchanged and is held here
 * with torches that have none: one the operator cleared, one stored without
 * the field, and one imported from a library entry that lacks it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { newProject, rectProfile } from '../../types/project'
import type { Tool } from '../../types/project'
import { normalizeProject } from '../../store/helpers/projectFormat'
import type { ProjectFormatInput } from '../../store/helpers/projectFormat'
import { projectWithFeatures } from '../../test/projectFixtures'
import { sheetFeature, exportPlasma, PLASMA_EXPORT_SCENARIOS } from '../../test/plasmaExportFixtures'
import { defaultPlasmaTool } from '../../toolPolicy'
import { useProjectStore } from '../../store/projectStore'
import { convertLength } from '../../utils/units'
import { parseToolLibraryFile, type ToolLibraryEntry } from '../../toolLibrary'
import { BUNDLED_DEFINITIONS, getActiveMachineDefinition } from './definitions'
import { runPostProcessor } from './postprocessor'
import { createToolpathGenerationService } from '../../app/toolpathGeneration/service'
import {
  createExportToken,
  exportHasError,
  prepareExport,
  programHasError,
  type ExportPreparation,
} from '../../app/toolpathGeneration/exportPreparation'

/** The shipped example torch an operator gets when Add operation imports one. */
const bundledLibrary = parseToolLibraryFile(
  JSON.parse(readFileSync(fileURLToPath(new URL('../../../public/tool-library.json', import.meta.url)), 'utf8')),
)
const bundledInchTorch: ToolLibraryEntry = (() => {
  const found = bundledLibrary.tools.find((tool) => tool.key === 'plasma_powermax45xp_45a_mild_steel_2mm_in')
  if (!found) throw new Error('public/tool-library.json no longer carries the inch plasma example')
  return found
})()

type Units = 'mm' | 'inch'

interface RunOptions {
  units: Units
  machineId: string
  /** The tool's own units when they differ from the project's. */
  toolUnits?: Units
  /** Set on the tool before the operation is created. */
  feedBefore?: number
  /** Set on the tool after the operation is created (the zero-fallback path). */
  feedAfter?: number
  /** Set on the tool's cut feed before the operation is created. */
  cutFeedBefore?: number
  /** Override the operation's own plunge feed after creation. */
  operationPlungeFeed?: number
  /** Override the operation's own cut feed after creation. */
  operationFeed?: number
  /** QtPlasmaC blocks without a material number; give it one where needed. */
  materialNumber?: number
  /** Start with no torch and let `addOperation` import one from this library,
   *  the way an operator adding their first plasma operation does. */
  importFrom?: ToolLibraryEntry[]
  /** Start from a saved project that already holds this torch, read back
   *  through the project format the way a file is. */
  storedTorch?: Record<string, unknown>
  /** Cut two parts, so a program has more than one drop. */
  twoParts?: boolean
}

/** Build the project with the production actions and post it, as the export does. */
async function runExport(options: RunOptions): Promise<ExportPreparation> {
  const base = newProject('Plasma feed regression', options.units)
  base.stock.thickness = 5
  base.origin = { ...base.origin, x: 0, y: 100, z: 5 }
  const featureIds = options.twoParts ? ['part', 'part-2'] : ['part']
  const built = projectWithFeatures(base, [
    sheetFeature('part', 'add', rectProfile(10, 10, 40, 30), 5),
    ...(options.twoParts ? [sheetFeature('part-2', 'add', rectProfile(70, 10, 40, 30), 5)] : []),
  ])
  const project = options.storedTorch
    ? normalizeProject(JSON.parse(JSON.stringify({ ...built, tools: [options.storedTorch] })) as ProjectFormatInput)
    : built
  const store = () => useProjectStore.getState()
  store().loadProject(project)

  let toolId: string | null = null
  if (!options.importFrom && !options.storedTorch) {
    toolId = store().addTool()
    // Exactly the tool-type change the CAM panel performs.
    store().updateTool(toolId, {
      ...defaultPlasmaTool(options.toolUnits ?? options.units),
      type: 'plasma',
      ...(options.materialNumber === undefined ? {} : { qtplasmacMaterialNumber: options.materialNumber }),
    })
    if (options.feedBefore !== undefined) store().updateTool(toolId, { defaultPlungeFeed: options.feedBefore })
    if (options.cutFeedBefore !== undefined) store().updateTool(toolId, { defaultFeed: options.cutFeedBefore })
  }

  const machine = BUNDLED_DEFINITIONS.find((candidate) => candidate.id === options.machineId)
  assert.ok(machine, `bundled machine ${options.machineId}`)
  store().setProjectMachine(machine)

  const operationId = store().addOperation(
    'plasma_profile', 'rough', { source: 'features', featureIds },
    options.importFrom ?? [],
  )
  assert.ok(operationId, 'the plasma operation is accepted')
  if (options.operationPlungeFeed !== undefined || options.operationFeed !== undefined) {
    store().updateOperation(operationId, {
      ...(options.operationPlungeFeed === undefined ? {} : { plungeFeed: options.operationPlungeFeed }),
      ...(options.operationFeed === undefined ? {} : { feed: options.operationFeed }),
    })
  }
  if (options.feedAfter !== undefined && toolId !== null) store().updateTool(toolId, { defaultPlungeFeed: options.feedAfter })

  const context = { project: store().project, documentKey: store().projectKey }
  const definition = getActiveMachineDefinition(context.project)
  assert.ok(definition)
  const postOptions = { emitToolChanges: false, emitCoolant: false, programName: 'feed983', captureMotionTrace: false }
  const service = createToolpathGenerationService({ getCurrentContext: () => context, executor: 'inline' })
  try {
    return await prepareExport(service, context, createExportToken(1, context, [operationId], definition, postOptions), definition, postOptions)
  } finally {
    service.dispose()
  }
}

function ready(prepared: ExportPreparation): Extract<ExportPreparation, { status: 'ready' }> {
  assert.equal(prepared.status, 'ready')
  if (prepared.status !== 'ready') throw new Error('unreachable')
  return prepared
}

function warningCodes(prepared: ExportPreparation): string[] {
  return ready(prepared).programs.flatMap((program) => program.result.warnings.map((warning) => warning.code))
}

function gcode(prepared: ExportPreparation): string {
  const programs = ready(prepared).programs
  assert.equal(programs.length, 1, 'one program')
  return programs[0].result.gcode
}

function codeLines(program: string): string[] {
  return program.split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith(';') && !line.startsWith('('))
}

/** The `G1 Z...` drop line after the first torch-on. */
function dropLine(program: string): string {
  const lines = codeLines(program)
  const torchOn = lines.indexOf('M3 S1000')
  assert.ok(torchOn >= 0, 'the program turns the torch on')
  const drop = lines.slice(torchOn + 1).find((line) => /^G1\s.*Z/.test(line))
  assert.ok(drop, 'a drop line follows torch-on')
  return drop
}

/** The `G1 Z...` drop line after every torch-on, in program order. */
function dropLines(program: string): string[] {
  const lines = codeLines(program)
  return lines.flatMap((line, index) => {
    if (line !== 'M3 S1000') return []
    const drop = lines.slice(index + 1).find((candidate) => /^G1\s.*Z/.test(candidate))
    assert.ok(drop, 'a drop line follows every torch-on')
    return [drop]
  })
}

/** The numeric F word of a line, or null when it carries none. */
function feedOf(line: string): number | null {
  const match = /F(-?[\d.]+)/.exec(line)
  return match ? Number(match[1]) : null
}

/** The numeric Z word of a line, or null when it carries none. */
function zOf(line: string): number | null {
  const match = /Z(-?[\d.]+)/.exec(line)
  return match ? Number(match[1]) : null
}

/** The numeric P word of a dwell line, or null when it carries none. */
function pOf(line: string): number | null {
  const match = /P(-?[\d.]+)/.exec(line)
  return match ? Number(match[1]) : null
}

async function main(): Promise<void> {
  // 1. Unconfigured: a torch with no drop feed is missing one, and the export
  //    is blocked instead of writing F0 (the verified finding). The cut feed is
  //    configured in every case, so only the plunge feed is missing. The
  //    example torch has a drop feed of its own (case 2), so these are the
  //    torches that still have none: one the operator cleared, one saved in a
  //    project without the field or with 0, and one imported from a library
  //    entry that does not carry it.
  {
    const { defaultPlungeFeed: _exampleFeed, ...withoutFeed } = defaultPlasmaTool('mm')
    const stored = { ...withoutFeed, id: 'stored-torch', name: 'Stored torch' }
    const libraryWithoutFeed = parseToolLibraryFile({
      tools: [{ key: 'no-drop-feed', name: 'Torch with no drop feed', units: 'mm', type: 'plasma', diameter: 1.4, defaultFeed: 5560, pierceHeight: 3.8, cutHeight: 1.5, pierceDelay: 0.2 }],
    }).tools
    assert.equal(libraryWithoutFeed.length, 1, 'the library entry without a plunge feed still parses')
    const unconfigured: Array<[string, RunOptions]> = [
      ['a cleared drop feed', { units: 'mm', machineId: 'grbl-plasma', feedBefore: 0 }],
      ['a stored torch without the field', { units: 'mm', machineId: 'grbl-plasma', storedTorch: stored }],
      ['a stored torch with a zero drop feed', { units: 'mm', machineId: 'grbl-plasma', storedTorch: { ...stored, defaultPlungeFeed: 0 } }],
      ['a library entry without the field', { units: 'mm', machineId: 'grbl-plasma', importFrom: libraryWithoutFeed }],
    ]
    for (const [label, options] of unconfigured) {
      const prepared = await runExport(options)
      const torch = useProjectStore.getState().project.tools.find((tool: Tool) => tool.type === 'plasma')
      assert.equal(torch?.defaultPlungeFeed, 0, `${label}: the torch has no drop feed`)
      assert.deepEqual(warningCodes(prepared), ['postPlasmaPlungeFeedMissing'], `${label} blocks the export`)
      assert.equal(exportHasError(ready(prepared).programs), true, `${label}: the block reaches exportHasError`)
      assert.equal(feedOf(dropLine(gcode(prepared))), 0, `${label}: the unblocked bytes would have carried F0`)
    }
  }

  // 2. The example torch as the tool panel creates it: its own drop feed, 300
  //    mm/min, seeds the operation and nothing blocks. A value the operator
  //    sets before creating the operation replaces it.
  {
    const example = await runExport({ units: 'mm', machineId: 'grbl-plasma' })
    assert.deepEqual(warningCodes(example), [], 'the example torch raises nothing')
    assert.equal(exportHasError(ready(example).programs), false)
    assert.equal(dropLine(gcode(example)), 'G1 Z1.500 F300.000', 'the drop runs at the example drop feed')
    const exampleInch = await runExport({ units: 'inch', machineId: 'grbl-plasma' })
    assert.deepEqual(warningCodes(exampleInch), [], 'the inch example torch raises nothing')
    assert.equal(dropLine(gcode(exampleInch)), 'G1 Z0.0591 F11.8110', 'the same 300 mm/min in an inch project')

    const prepared = await runExport({ units: 'mm', machineId: 'grbl-plasma', feedBefore: 450 })
    assert.deepEqual(warningCodes(prepared), [], 'a configured drop feed raises nothing')
    assert.equal(exportHasError(ready(prepared).programs), false)
    assert.equal(feedOf(dropLine(gcode(prepared))), 450, 'the drop runs at the configured feed')
  }

  // 3. Configured after a zero-feed operation was created: the operation's own
  //    zero falls back to the normalized tool, which now keeps the configured
  //    value instead of zeroing it.
  {
    const prepared = await runExport({ units: 'mm', machineId: 'grbl-plasma', feedBefore: 0, feedAfter: 450 })
    assert.deepEqual(warningCodes(prepared), [], 'the tool fallback is not zeroed by normalization')
    assert.equal(feedOf(dropLine(gcode(prepared))), 450, 'the fallback reaches the emitted drop')
  }

  // 4. Units. A tool in the project's units emits its value unchanged; a tool
  //    in another unit is converted, both when the operation is created and when
  //    the tool is configured afterwards.
  {
    const inchValue = 300
    const sameUnits = await runExport({ units: 'inch', machineId: 'grbl-plasma', feedBefore: inchValue })
    assert.equal(feedOf(dropLine(gcode(sameUnits))), inchValue, 'an inch tool emits the stored inch feed')

    const converted = convertLength(2000, 'mm', 'inch')
    const before = await runExport({ units: 'inch', machineId: 'grbl-plasma', toolUnits: 'mm', feedBefore: 2000 })
    assert.ok(Math.abs(feedOf(dropLine(gcode(before)))! - converted) < 1e-3, 'a millimetre tool seeds an inch operation converted')

    const after = await runExport({ units: 'inch', machineId: 'grbl-plasma', toolUnits: 'mm', feedBefore: 0, feedAfter: 2000 })
    assert.ok(Math.abs(feedOf(dropLine(gcode(after)))! - converted) < 1e-3, 'the after-create fallback is converted too')
  }

  // 5. Invalid feeds are blocked: missing (case 1), non-finite, non-positive,
  //    and a positive value that rounds to zero at the emitted precision.
  {
    const invalidPlunge: Array<[string, RunOptions]> = [
      ['NaN', { units: 'mm', machineId: 'grbl-plasma', feedBefore: NaN }],
      ['Infinity', { units: 'mm', machineId: 'grbl-plasma', feedBefore: Infinity }],
      ['negative', { units: 'mm', machineId: 'grbl-plasma', operationPlungeFeed: -300 }],
      ['rounds to zero', { units: 'mm', machineId: 'grbl-plasma', operationPlungeFeed: 0.0004 }],
    ]
    for (const [label, options] of invalidPlunge) {
      const prepared = await runExport(options)
      assert.deepEqual(warningCodes(prepared), ['postPlasmaPlungeFeedMissing'], `plunge ${label} blocks`)
      assert.equal(exportHasError(ready(prepared).programs), true, `plunge ${label} reaches exportHasError`)
    }

    const invalidCut: Array<[string, RunOptions]> = [
      ['missing', { units: 'mm', machineId: 'grbl-plasma', feedBefore: 300, cutFeedBefore: 0 }],
      ['negative', { units: 'mm', machineId: 'grbl-plasma', feedBefore: 300, operationFeed: -300 }],
      ['rounds to zero', { units: 'mm', machineId: 'grbl-plasma', feedBefore: 300, operationFeed: 0.0004 }],
    ]
    for (const [label, options] of invalidCut) {
      const prepared = await runExport(options)
      assert.deepEqual(warningCodes(prepared), ['postPlasmaCutFeedMissing'], `cut ${label} blocks`)
      assert.equal(exportHasError(ready(prepared).programs), true, `cut ${label} reaches exportHasError`)
    }

    // A non-finite cut feed is refused at the store boundary
    // (`normalizePlasmaTool` throws), so it can only reach the emitter through a
    // malformed file or a future caller. The emitter guard still blocks it,
    // which is the property defence-in-depth needs; mutate a valid render to
    // drive the post-processor directly.
    const nonFiniteCut = (value: number) => {
      const { input } = exportPlasma({ ...PLASMA_EXPORT_SCENARIOS['single-outline'](), machineId: 'grbl-plasma' })
      input.operations[0].operation.feed = value
      input.operations[0].tool.defaultFeed = value
      const { warnings } = runPostProcessor(input)
      assert.deepEqual(warnings.map((warning) => warning.code), ['postPlasmaCutFeedMissing'], `cut ${value} blocks`)
      assert.equal(programHasError(warnings), true, `cut ${value} reaches exportHasError`)
    }
    nonFiniteCut(NaN)
    nonFiniteCut(Infinity)
  }

  // 6. A valid configured feed alongside an invalid one still blocks, and the
  //    error names a plasma code rather than surfacing only through the
  //    conformance judge.
  {
    const prepared = await runExport({ units: 'mm', machineId: 'grbl-plasma', feedBefore: 300, operationFeed: 0.0004 })
    assert.deepEqual(warningCodes(prepared), ['postPlasmaCutFeedMissing'], 'the cut feed blocks even with a good drop feed')
  }

  // 7. QtPlasmaC is unchanged: controller piercing takes its feed from the
  //    material table, so a torch plots no Z and no numeric F whether it has a
  //    drop feed or not, the feed validation never runs for it, and the
  //    program is the same either way.
  {
    const prepared = await runExport({ units: 'mm', machineId: 'qtplasmac', materialNumber: 12 })
    assert.deepEqual(warningCodes(prepared), [], 'the controller path raises no feed error')
    assert.equal(exportHasError(ready(prepared).programs), false)
    const lines = codeLines(gcode(prepared))
    assert.ok(lines.includes('M3 $0 S1') && lines.includes('M5 $0'), 'the torch path is written')
    assert.ok(lines.includes('M190 P12'), 'the material handshake is written')
    assert.ok(!lines.some((line) => /\bF-?\d/.test(line)), 'no numeric F')
    assert.ok(!lines.some((line) => /\bZ-?\d/.test(line)), 'no Z word')

    const unconfigured = await runExport({ units: 'mm', machineId: 'qtplasmac', materialNumber: 12, feedBefore: 0 })
    assert.deepEqual(warningCodes(unconfigured), [], 'a torch with no drop feed is fine on the controller path')
    assert.equal(gcode(unconfigured), gcode(prepared), 'the drop feed does not reach a QtPlasmaC program')
  }

  // 8. The first-use path: a project with no torch lets Add operation import
  //    one. The emitted pierce height, cut height and dwell must be the
  //    library example's, not a missing field normalized to 0 — the previous
  //    behaviour fired the torch at the sheet surface with no standoff and no
  //    dwell, and nothing blocked it. The example's drop feed comes with it.
  {
    const prepared = await runExport({ units: 'inch', machineId: 'grbl-plasma', importFrom: [bundledInchTorch] })
    assert.deepEqual(warningCodes(prepared), [], 'the imported example torch raises nothing')
    const lines = codeLines(gcode(prepared))
    const torchOn = lines.indexOf('M3 S1000')
    assert.ok(torchOn > 0, 'the program turns the torch on')
    const pierceZ = zOf(lines[torchOn - 1])
    assert.ok(
      pierceZ !== null && Math.abs(pierceZ - bundledInchTorch.pierceHeight!) < 1e-4,
      `the pierce rapid uses the library pierce height, got ${lines[torchOn - 1]}`,
    )
    const dwell = pOf(lines[torchOn + 1])
    assert.ok(
      dwell !== null && Math.abs(dwell - bundledInchTorch.pierceDelay!) < 1e-6,
      `the dwell uses the library pierce delay, got ${lines[torchOn + 1]}`,
    )
    const dropZ = zOf(dropLine(gcode(prepared)))
    assert.ok(
      dropZ !== null && Math.abs(dropZ - bundledInchTorch.cutHeight!) < 1e-4,
      `the drop uses the library cut height, got ${dropLine(gcode(prepared))}`,
    )
  }

  // 9. A new project end to end: no torch, the Grbl plasma machine, Add
  //    operation with the whole bundled library, export. Nothing is blocked,
  //    and every drop spells the example's 300 mm/min — as F300.000 in a
  //    millimetre project and F11.8110 in an inch one, in the definition's own
  //    number format — with the cut after it at the example's cut feed.
  {
    for (const [units, drop, cutFeed] of [['mm', 'G1 Z1.500 F300.000', 'F5560.000'], ['inch', 'G1 Z0.0591 F11.8110', 'F218.8976']] as const) {
      const prepared = await runExport({ units, machineId: 'grbl-plasma', importFrom: bundledLibrary.tools, twoParts: true })
      assert.deepEqual(warningCodes(prepared), [], `${units}: a first export from a new project raises nothing`)
      assert.equal(exportHasError(ready(prepared).programs), false, `${units}: and is not blocked`)
      assert.deepEqual(dropLines(gcode(prepared)), [drop, drop], `${units}: every drop spells the example drop feed`)
      assert.equal(codeLines(gcode(prepared)).filter((line) => line.endsWith(` ${cutFeed}`)).length, 2,
        `${units}: each contour then cuts at the example cut feed`)

      const { tools, operations } = useProjectStore.getState().project
      const torches = tools.filter((tool: Tool) => tool.type === 'plasma')
      assert.equal(torches.length, 1, `${units}: one torch was imported`)
      assert.ok(Math.abs(torches[0].defaultPlungeFeed - convertLength(300, 'mm', units)) < 1e-9,
        `${units}: the imported torch carries 300 mm/min, got ${torches[0].defaultPlungeFeed}`)
      assert.equal(operations[0].plungeFeed, torches[0].defaultPlungeFeed, `${units}: the operation is seeded from it`)
    }
  }

  console.log('plasmaGcodeFeedRegression.test.ts: store -> generation -> export drop feed, the example torch, unconfigured torches, units, invalid feeds, imported-torch consumables, a first export from a new project and QtPlasmaC parity passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
