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
 * Issue #1028 slice A: the project type and the rules that read it.
 *
 * Run with: npx tsx src/store/helpers/projectType.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import {
  defaultOrigin,
  defaultTool,
  newProject,
  rectProfile,
  roundStock,
  type MachiningSetup,
  type Operation,
  type Project,
  type ProjectType,
  type Tool,
} from '../../types/project'
import { defaultPlasmaTool } from '../../toolPolicy'
import { BUNDLED_DEFINITIONS, getActiveMachineDefinition, projectMachineKind } from '../../engine/gcode/definitions'
import { validateMachineDefinition, type MachineDefinition } from '../../engine/gcode/types'
import { runPostProcessor } from '../../engine/gcode/postprocessor'
import { computeOperationToolpath } from '../../engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../../engine/toolpaths/geometry'
import { machineMode } from '../../components/cam/machineMode'
import {
  featureReachableFromFace,
  judgeTargetFromFace,
  setupGenerationBlock,
} from '../../engine/setupTargets'
import { decodeProjectFormat } from './projectFormat'
import {
  barSeedsModel,
  inferProjectType,
  machineMatchesProjectType,
  operationCutsInProject,
  operationHiddenByProjectType,
  projectMachineMismatch,
  projectType,
  stockShapesForProjectType,
} from './projectType'
import { squareStock } from '../../types/barStock'
import { projectWithProjectType } from './projectTypeApply'
import { activeFace, aroundUnavailableReason } from './activeFace'
import { syncProjectSetups } from './setups'
import { projectWithFeatures } from '../../test/projectFixtures'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { exportPlasma, PLASMA_EXPORT_SCENARIOS } from '../../test/plasmaExportFixtures'
import {
  createExportToken,
  exportHasError,
  prepareExport,
  type ExportPostOptions,
} from '../../app/toolpathGeneration/exportPreparation'
import { makeCountingService, makeOperation, projectWith } from '../../app/toolpathGeneration/testSupport'

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(fn).then(
    () => { passed += 1; console.log(`   \u2713 ${name}`) },
    (error: unknown) => {
      failed += 1
      console.log(`   \u2717 ${name}: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert.deepEqual(actual, expected, message)
}

// ── Fixtures ──────────────────────────────────────────────────

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(found, `bundled definition ${id} exists`)
  return validateMachineDefinition(structuredClone(found))
}

const QTPLASMAC = bundled('qtplasmac')

/** The bundled generic router plus a rotary block. */
function rotaryRouter(id = 'rotary-router', name = 'Rotary router'): MachineDefinition {
  return validateMachineDefinition({
    ...bundled('generic'),
    id,
    name,
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

const PLAIN_ROUTER = validateMachineDefinition({ ...bundled('generic'), id: 'plain-router', name: 'Plain router' })

/** The same project without the stored field, as a pre-#1028 file carries it. */
function withoutProjectType(project: Project): Project {
  const clone = structuredClone(project)
  delete (clone.meta as unknown as Record<string, unknown>).projectType
  return clone
}

function projectOfType(type: ProjectType, machine: MachineDefinition | null = null): Project {
  const base = newProject('typed', 'mm')
  return {
    ...base,
    meta: {
      ...base.meta,
      projectType: type,
      machineDefinitions: machine ? [machine] : [],
      selectedMachineId: machine?.id ?? null,
    },
  }
}

// ── 1. Inference reproduces today's rules ─────────────────────

/** `machineMode` before #1028, still exported by the engine: plasma from the machine's kind. */
function legacyMachineMode(project: Project): 'router' | 'plasma' {
  return projectMachineKind(project)
}

/**
 * Around authorability as of #1034 slice A: the project type and the round bar
 * alone. The machine and its axis are output-boundary concerns now, so a
 * legacy round-bar project with no (or a mismatched) rotary machine is
 * authorable exactly when the inference calls it a rotary project.
 */
function aroundAvailableFromType(legacy: Project): boolean {
  return inferProjectType(legacy) === 'rotary'
}

function assertInferenceParity(label: string, legacy: Project): void {
  const inferred = inferProjectType(legacy)
  const typed: Project = { ...legacy, meta: { ...legacy.meta, projectType: inferred } }
  assertEqual(machineMode(typed), legacyMachineMode(legacy), `${label}: machineMode is unchanged`)
  assertEqual(
    aroundUnavailableReason(typed) === null,
    aroundAvailableFromType(legacy),
    `${label}: Around authoring follows the inferred type, not the machine`,
  )
}

/** Every checked-in project file, loaded the way the app loads one. */
function checkedInProjects(): Array<{ name: string; project: Project }> {
  const dirs = [
    new URL('../../engine/test-fixtures/', import.meta.url),
    new URL('../../../public/examples/', import.meta.url),
  ]
  const out: Array<{ name: string; project: Project }> = []
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.camj')).sort()) {
      const raw = JSON.parse(readFileSync(new URL(name, dir), 'utf8'))
      out.push({ name, project: decodeProjectFormat(raw).project })
    }
  }
  return out
}

function inferenceFixtures(): Array<{ name: string; project: Project }> {
  const fixtures = checkedInProjects().map(({ name, project }) => ({ name, project }))
  fixtures.push(
    { name: 'newProject', project: newProject('fresh', 'mm') },
    { name: 'rotary fixture', project: rotaryOperationFixture('x', 'rotary_rough') },
    {
      name: 'hand plasma',
      project: projectOfType('milling', QTPLASMAC),
    },
    {
      name: 'hand rotary',
      project: (() => {
        const base = projectOfType('milling', rotaryRouter())
        return { ...base, stock: roundStock(20, 80, 'x') }
      })(),
    },
    {
      name: 'hand round with no rotary machine',
      project: (() => {
        const base = projectOfType('milling', PLAIN_ROUTER)
        return { ...base, stock: roundStock(20, 80, 'x') }
      })(),
    },
  )
  return fixtures
}

// ── 2. Byte-identical generation and export ───────────────────

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * Every machine header stamps the wall clock — `Generated by PureCutCNC on
 * {date}` is substituted from `new Date().toISOString().split('T')[0]` (the
 * postprocessor's `commonContext.date`). BASE_HASHES were captured at the base
 * commit on 2026-10-14, so that one field is pinned to the capture day before
 * hashing: the split below rewrites that field and nothing else, since the two
 * strings are identical outside it. A changed motion, feed, coordinate or
 * comment byte still moves the hash (the mutation guard in the test checks one).
 */
const BASE_DATE = '2026-10-14'
const GENERATED_DATE_FIELD = 'Generated by PureCutCNC on '

function normalizeGeneratedDate(gcode: string): string {
  const today = new Date().toISOString().split('T')[0]
  const parts = gcode.split(`${GENERATED_DATE_FIELD}${today}`)
  if (parts.length === 1) return gcode
  assertEqual(parts.length, 2, 'the program carries exactly one generated-date field')
  const normalized = `${parts[0]}${GENERATED_DATE_FIELD}${BASE_DATE}${parts[1]}`
  assertEqual(normalized.length, gcode.length, 'pinning the date changes no other byte')
  return normalized
}

function postOperations(
  project: Project,
  definition: MachineDefinition,
  operations: readonly Operation[],
  name: string,
): string {
  const tools = new Map(project.tools.map((tool) => [tool.id, normalizeToolForProject(tool, project)]))
  const rows = operations.flatMap((operation) => {
    const tool = tools.get(operation.toolRef ?? '')
    if (!tool) return []
    const envelope = computeOperationToolpath(project, operation)
    return envelope ? [{ operation, tool, toolpath: envelope.result }] : []
  })
  return runPostProcessor({
    project,
    definition,
    operations: rows,
    options: { emitToolChanges: false, emitCoolant: false, programName: name },
  }).gcode
}

/**
 * Hashes captured from the base commit (`97098461`) with the same script and
 * the generated date pinned to 2026-10-14 (the capture day, see
 * `normalizeGeneratedDate`), so a change that alters any other byte of the
 * generated program of a consistent fixture fails here. The projects are made
 * coherent first: the machine and the stock are what the type implies, exactly
 * as the load migration reads them.
 *
 * `around` and `aroundMoves` were recomputed on the merged #1045 + #1054 code,
 * so they now include both changes. #1045 slice D's C2-F7 cutter-centre
 * pull-in, now applied to a round bar's retained ends too, starts and ends the
 * along grid one cutter radius in because the fixture's band ends inside the
 * bar; that moved `aroundMoves` (and therefore `around`). #1054 fix 3's
 * machine-coordinate closing retract then changed only the program text, so
 * `aroundMoves` is still the #1045 value while `around` carries both. The
 * program's structure is unchanged.
 *
 * `around` was recaptured once more for #1091, which removes the closing
 * unwind: the trailing machine-coordinate retract and the closing `G0 A0` are
 * gone, so the program text loses its last two motion lines. `aroundMoves` is
 * unchanged — #1091 adds and removes no generated move.
 */
const BASE_HASHES = {
  plasma: '434b37ddb9dfaf24',
  'pocket-feed-reduction.camj': 'cbf2417a4be43caf',
  'v-carve-noise-test.camj': '24623f98ba01c484',
  'another-pocket-test.camj': '4f96da538edfabb4',
  around: '5619215fdfe922df',
  aroundMoves: 'e7248422dcef1683',
} as const

// ── 3. The rich project the type changes run on ───────────────

const TOP_SETUP_ID = 'setup-top'
const AROUND_SETUP_ID = 'setup-around'

function baseOperation(id: string, kind: Operation['kind'], setupId: string, toolRef: string): Operation {
  return {
    id,
    name: id,
    description: '',
    kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['top-shape'] },
    toolRef,
    setupId,
    stepdown: 1,
    stepover: 0.4,
    feed: 600,
    plungeFeed: 200,
    rpm: 12000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    entryStrategy: 'plunge',
  }
}

/**
 * A project with one of everything the six type changes touch: a plasma
 * operation and a milling operation in the Top setup, an Around setup with a
 * rotary operation, and an Around feature. Round bar, rotary router.
 */
function richProject(): Project {
  const base = newProject('rich', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(20, 80, 'x')
  base.origin = defaultOrigin(base.stock)
  base.tools = [
    { ...defaultTool('mm', 1), id: 't1', name: 'End mill', diameter: 2, maxCutDepth: 25 },
    { ...defaultPlasmaTool('mm'), id: 'torch', name: 'Torch' },
  ]
  const machine = rotaryRouter()
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  const built = projectWithFeatures(base, [
    {
      id: 'top-shape', name: 'Top shape', kind: 'rect', operation: 'subtract', folderId: null,
      sketch: { profile: rectProfile(0, 0, 10, 10), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
      z_top: 20, z_bottom: 0, visible: true, locked: false, authoringFace: 'top',
    },
    {
      id: 'around-shape', name: 'Around shape', kind: 'rect', operation: 'subtract', folderId: null,
      sketch: { profile: rectProfile(20, 20, 10, 10), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
      z_top: 20, z_bottom: 15, visible: true, locked: false, authoringFace: 'around',
    },
  ])
  const top = built.setups[0]
  const around: MachiningSetup = {
    id: AROUND_SETUP_ID, name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 },
    indexing: 'manual', registration: [], notes: '', operationIds: [],
  }
  const operations: Operation[] = [
    baseOperation('mill-op', 'pocket', top.id, 't1'),
    baseOperation('plasma-op', 'plasma_profile', top.id, 'torch'),
    { ...baseOperation('rotary-op', 'rotary_rough', around.id, 't1'), target: { source: 'features', featureIds: ['around-shape'] } },
  ]
  const synced = syncProjectSetups({
    ...built,
    setups: [{ ...top, id: TOP_SETUP_ID }, around],
    activeSetupId: TOP_SETUP_ID,
    operations: operations.map((operation) => (
      operation.setupId === top.id ? { ...operation, setupId: TOP_SETUP_ID } : operation
    )),
  })
  return synced
}

const CANDIDATES: readonly MachineDefinition[] = [QTPLASMAC, rotaryRouter(), PLAIN_ROUTER]

/** The machine a change to `to` selects, given the one already selected. */
function expectedMachineId(current: MachineDefinition, to: ProjectType): string {
  return machineMatchesProjectType(current, to)
    ? current.id
    : CANDIDATES.find((definition) => machineMatchesProjectType(definition, to))?.id ?? current.id
}

// ── Tests ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\nProject type (issue #1028)')

  await test('inferProjectType reproduces machineMode and Around availability for every fixture', () => {
    const fixtures = inferenceFixtures()
    assert.ok(fixtures.length >= 18, `the corpus is exercised (${fixtures.length} fixtures)`)
    for (const { name, project } of fixtures) {
      assertInferenceParity(name, withoutProjectType(project))
    }
    // The corpus covers all three kinds, or the parity check is vacuous.
    const kinds = new Set(inferenceFixtures().map(({ project }) => inferProjectType(withoutProjectType(project))))
    assertEqual(kinds.has('milling'), true, 'the corpus holds a milling fixture')
    assertEqual(kinds.has('plasma'), true, 'the corpus holds a plasma fixture')
    assertEqual(kinds.has('rotary'), true, 'the corpus holds a rotary fixture')
  })

  await test('newProject defaults to milling and a stored type is kept', () => {
    assertEqual(newProject('fresh', 'mm').meta.projectType, 'milling', 'a new project is a milling project')

    // A file without the field gains the inferred one.
    const legacy = withoutProjectType(projectOfType('milling', QTPLASMAC))
    const loaded = decodeProjectFormat(JSON.parse(JSON.stringify(legacy))).project
    assertEqual(loaded.meta.projectType, 'plasma', 'a plasma file without the field reads as plasma')
    assertEqual(projectType(legacy), 'plasma', 'and projectType infers it')

    // A file with the field keeps it, even when the machine disagrees.
    const milling = projectOfType('milling', QTPLASMAC)
    const stored: Project = { ...milling, meta: { ...milling.meta, projectType: 'rotary' } }
    const reopened = decodeProjectFormat(JSON.parse(JSON.stringify(stored))).project
    assertEqual(reopened.meta.projectType, 'rotary', 'a stored type survives a load')
  })

  await test('stock shapes offered per type', () => {
    assertEqual([...stockShapesForProjectType('milling')], ['block'], 'milling cuts a block')
    assertEqual([...stockShapesForProjectType('plasma')], ['block'], 'plasma cuts a block')
    assertEqual([...stockShapesForProjectType('rotary')], ['round', 'square'], 'rotary turns either bar, round first')
    assertEqual(stockShapesForProjectType('rotary')[0], 'round', 'a new rotary project still starts on a round bar')
  })

  await test('barSeedsModel: a rotary project on either bar, and nothing else (#1054)', () => {
    const milling = projectOfType('milling')
    assertEqual(barSeedsModel(milling), false, 'a milling block is not a bar')
    assertEqual(barSeedsModel(projectOfType('plasma')), false, 'a plasma block is not a bar')

    const round = { ...milling, meta: { ...milling.meta, projectType: 'rotary' as const }, stock: roundStock(40, 200, 'x', { x: 10, y: 30 }) }
    assertEqual(barSeedsModel(round), true, 'a rotary round bar is the material')
    const square = { ...round, stock: squareStock(40, 200, 'x', { x: 10, y: 30 }) }
    assertEqual(barSeedsModel(square), true, 'a rotary square blank is the material')
    assertEqual(barSeedsModel({ ...milling, stock: round.stock }), false, 'a round bar in a milling project keeps the base-add rule')
    assertEqual(barSeedsModel({ ...round, stock: milling.stock }), false, 'a rotary project without a bar has no bar to seed from')
  })

  await test('generated and exported programs are byte-identical to the base commit', () => {
    // Plasma.
    const { input } = exportPlasma(PLASMA_EXPORT_SCENARIOS['part-with-holes']())
    const plasmaProject: Project = {
      ...input.project,
      meta: {
        ...input.project.meta,
        projectType: 'plasma',
        machineDefinitions: [input.definition],
        selectedMachineId: input.definition.id,
      },
    }
    const plasmaProgram = normalizeGeneratedDate(runPostProcessor({ ...input, project: plasmaProject }).gcode)
    assertEqual(hash(plasmaProgram), BASE_HASHES.plasma, 'the plasma program is byte-identical')

    // The pin is narrow: mutating one digit of a real motion coordinate still
    // fails the hash, so no motion, feed or coordinate byte is masked.
    const mutated = plasmaProgram.replace(
      /^(G[0-3]\b[^\n]*?[XYIJ])(\d)/m,
      (_match, head: string, digit: string) => `${head}${(Number(digit) + 1) % 10}`,
    )
    assert.notEqual(mutated, plasmaProgram, 'the mutation probe changes a real motion byte')
    assert.notEqual(hash(mutated), hash(plasmaProgram), 'a mutated motion byte still fails the hash')

    // Plain milling, straight from checked-in files.
    for (const name of ['pocket-feed-reduction.camj', 'v-carve-noise-test.camj', 'another-pocket-test.camj'] as const) {
      const raw = JSON.parse(readFileSync(new URL(`../../engine/test-fixtures/${name}`, import.meta.url), 'utf8'))
      const project = decodeProjectFormat(raw).project
      const embedded = project.meta.machineDefinitions.find((d) => d.id === project.meta.selectedMachineId) ?? null
      const definition = embedded ? validateMachineDefinition(structuredClone(embedded)) : bundled('generic')
      const gcode = normalizeGeneratedDate(
        postOperations(project, definition, project.operations.filter((operation) => operation.enabled), name),
      )
      assertEqual(hash(gcode), BASE_HASHES[name], `${name} is byte-identical`)
    }

    // Round bar: an Around (rotary) operation, generated and posted. This
    // machine is exactly the probe's, so the hash is comparable.
    const bar = rotaryOperationFixture('x', 'rotary_rough')
    const machine = validateMachineDefinition({
      ...bundled('grbl'),
      rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
    })
    const barProject: Project = {
      ...bar,
      meta: { ...bar.meta, projectType: 'rotary', machineDefinitions: [machine], selectedMachineId: machine.id },
    }
    const operation = barProject.operations[0]
    const envelope = computeOperationToolpath(barProject, operation)
    assert.ok(envelope, 'the Around operation generates')
    assertEqual(hash(JSON.stringify(envelope.result.moves)), BASE_HASHES.aroundMoves, 'the Around moves are byte-identical')
    const tool: Tool = barProject.tools[0]
    const aroundProgram = normalizeGeneratedDate(runPostProcessor({
      project: barProject,
      definition: machine,
      operations: [{ operation, tool: normalizeToolForProject(tool, barProject), toolpath: envelope.result }],
      options: { emitToolChanges: false, emitCoolant: false, programName: 'around' },
    }).gcode)
    assertEqual(hash(aroundProgram), BASE_HASHES.around, 'the Around program is byte-identical')
  })

  await test('a non-rotary project generates and targets nothing on Around', () => {
    const rotary = rotaryOperationFixture('x', 'rotary_rough')
    const rotaryOperation = rotary.operations[0]

    // In the rotary project the operation is generated.
    const generated = computeOperationToolpath(rotary, rotaryOperation)
    assert.ok(generated && generated.result.moves.length > 0, 'the rotary project machines the bar')

    // The same project as a milling one: blocked, with no motion.
    const milling: Project = { ...rotary, meta: { ...rotary.meta, projectType: 'milling' } }
    const block = setupGenerationBlock(milling, rotaryOperation)
    assertEqual(block?.reason, 'aroundStockMismatch', 'a non-rotary project refuses the Around operation')
    const blocked = computeOperationToolpath(milling, rotaryOperation)
    assert.ok(blocked, 'the refusal is a result, not a crash')
    assertEqual(blocked.result.moves.length, 0, 'and it emits no motion')

    // The rotary target rules are type-gated too: a rotary kind reaches an
    // imported model only in a rotary project.
    const model = rotary.features.find((feature) => feature.id === 'model')!
    assertEqual(
      featureReachableFromFace(rotary, model, 'around', 'rotary_rough'),
      true,
      'a rotary project reaches the model from Around',
    )
    assertEqual(
      featureReachableFromFace(milling, model, 'around', 'rotary_rough'),
      false,
      'a milling project reaches nothing with a rotary kind',
    )
    assertEqual(
      judgeTargetFromFace(milling, model, 'around', 'rotary_finish').status,
      'rejected',
      'and the verdict agrees',
    )
    assertEqual(
      judgeTargetFromFace(rotary, model, 'around', 'rotary_finish').status,
      'same-face',
      'while the rotary project accepts it',
    )

    // The Around setup itself is where the block is, whatever the operation: a
    // flat pocket targeting the Around feature runs in the rotary project and
    // is refused in the milling one.
    const flatInAround: Operation = {
      ...rotaryOperation,
      id: 'pocket-in-around',
      kind: 'pocket',
      target: { source: 'features', featureIds: ['sketch'] },
    }
    assertEqual(setupGenerationBlock(rotary, flatInAround), null, 'the flat Around pocket runs in the rotary project')
    assertEqual(
      setupGenerationBlock(milling, flatInAround)?.reason,
      'aroundStockMismatch',
      'and is refused in the milling one',
    )
  })

  await test('projectMachineMismatch: a plasma machine on a milling project, and a rotary router', () => {
    const milling = projectOfType('milling', QTPLASMAC)
    assertEqual(
      projectMachineMismatch(milling),
      { expected: 'milling', machineName: QTPLASMAC.name },
      'a plasma machine does not suit a milling project',
    )

    const rotaryCapable = projectOfType('milling', rotaryRouter())
    assertEqual(projectMachineMismatch(rotaryCapable), null, 'a rotary-capable router suits a milling project')
    assertEqual(machineMatchesProjectType(rotaryRouter(), 'milling'), true, 'milling accepts any router')
    assertEqual(machineMatchesProjectType(PLAIN_ROUTER, 'rotary'), false, 'rotary needs a rotary block')
    assertEqual(machineMatchesProjectType(rotaryRouter(), 'rotary'), true, 'a rotary router suits a rotary project')
    assertEqual(machineMatchesProjectType(PLAIN_ROUTER, 'plasma'), false, 'a router never suits a plasma project')

    assertEqual(projectMachineMismatch(projectOfType('milling', null)), null, 'no machine is no mismatch')
  })

  await test('the export refuses a project whose type and machine disagree', async () => {
    const OPTIONS: ExportPostOptions = { emitToolChanges: false, emitCoolant: false, programName: 'refuse', captureMotionTrace: false }
    const tool: Tool = { ...defaultTool('mm', 1), id: 't1' }
    const mismatched: Project = {
      ...projectWith([{ ...makeOperation('a'), toolRef: 't1' }]),
      tools: [tool],
      meta: {
        ...projectWith([]).meta,
        projectType: 'milling',
        machineDefinitions: [QTPLASMAC],
        selectedMachineId: QTPLASMAC.id,
      },
    }
    const h = makeCountingService({ project: mismatched, documentKey: 1 })
    const token = createExportToken(1, h.context(), ['a'], QTPLASMAC, OPTIONS)
    const prepared = await prepareExport(h.service, h.context(), token, QTPLASMAC, OPTIONS)
    assertEqual(prepared.status, 'ready', 'the program still prepares, so the operator sees the reason')
    if (prepared.status !== 'ready') throw new Error('unreachable')
    assertEqual(exportHasError(prepared.programs), true, 'the mismatch blocks the export')
    for (const program of prepared.programs) {
      const mismatch = program.result.warnings.find((warning) => warning.code === 'exportMachineTypeMismatch')
      assert.ok(mismatch, 'every program carries the refusal')
      assertEqual(mismatch.params, { machine: QTPLASMAC.name, expected: 'milling' }, 'naming the machine and the type')
    }

    // The negative: a rotary-capable router on a milling project exports.
    const rotaryCapable: Project = {
      ...mismatched,
      meta: { ...mismatched.meta, machineDefinitions: [rotaryRouter()], selectedMachineId: rotaryRouter().id },
    }
    const ok = makeCountingService({ project: rotaryCapable, documentKey: 1 })
    const okToken = createExportToken(1, ok.context(), ['a'], rotaryRouter(), OPTIONS)
    const okPrepared = await prepareExport(ok.service, ok.context(), okToken, rotaryRouter(), OPTIONS)
    if (okPrepared.status !== 'ready') throw new Error('the rotary-capable router prepares')
    assertEqual(exportHasError(okPrepared.programs), false, 'the rotary-capable router does not refuse')
  })

  await test('projectWithProjectType: all six changes keep every feature and operation and select the type\'s stock and machine', () => {
    const types: ProjectType[] = ['milling', 'plasma', 'rotary']
    const project = richProject()
    for (const from of types) {
      for (const to of types) {
        if (from === to) continue
        const machine = from === 'rotary' ? rotaryRouter() : from === 'plasma' ? QTPLASMAC : PLAIN_ROUTER
        const start: Project = { ...project, meta: { ...project.meta, projectType: from, machineDefinitions: [machine], selectedMachineId: machine.id } }
        const after = projectWithProjectType(start, to, CANDIDATES)

        assertEqual(after.meta.projectType, to, `${from} -> ${to}: the type is stored`)
        assertEqual(after.features, start.features, `${from} -> ${to}: nothing is deleted from the features`)
        assertEqual(after.operations, start.operations, `${from} -> ${to}: nothing is deleted from the operations`)
        assertEqual(after.stock.shape === 'round', to === 'rotary', `${from} -> ${to}: the stock takes the type's shape`)
        assertEqual(
          getActiveMachineDefinition(after)?.id,
          expectedMachineId(machine, to),
          `${from} -> ${to}: the machine follows the type`,
        )
        // Back to where it started: features and operations are untouched.
        const back = projectWithProjectType(after, from, CANDIDATES)
        assertEqual(back.features, start.features, `${from} -> ${to} -> ${from}: features are restored`)
        assertEqual(back.operations, start.operations, `${from} -> ${to} -> ${from}: operations are restored`)
      }
    }
  })

  await test('projectWithProjectType selects the first matching candidate, leaves the machine when none matches, and is a no-op otherwise', () => {
    // A plasma machine on a milling project: the first candidate is the plasma
    // machine (which does not suit milling), so the plain router is picked
    // even though it is second in the list.
    const base = richProject()
    const mismatched: Project = { ...base, meta: { ...base.meta, projectType: 'milling', machineDefinitions: [QTPLASMAC], selectedMachineId: QTPLASMAC.id } }
    assertEqual(
      projectWithProjectType(mismatched, 'milling', [QTPLASMAC, PLAIN_ROUTER]).meta.selectedMachineId,
      PLAIN_ROUTER.id,
      'the first machine that suits the type is selected',
    )

    // No candidate suits: the machine is left alone.
    const rotary = projectOfType('rotary', PLAIN_ROUTER)
    assertEqual(
      projectWithProjectType(rotary, 'rotary', [PLAIN_ROUTER]).meta.selectedMachineId,
      PLAIN_ROUTER.id,
      'with no matching candidate the machine stays',
    )

    // A change that needs nothing moved returns the same project object.
    const milling = projectOfType('milling', PLAIN_ROUTER)
    assert.equal(
      projectWithProjectType(milling, 'milling', CANDIDATES),
      milling,
      'an unchanged type comes back as the same project object',
    )

    // A hand-built project without the field takes the write even when the
    // inference already agrees, so saving always carries the type.
    assertEqual(
      projectWithProjectType(withoutProjectType(milling), 'milling', CANDIDATES).meta.projectType,
      'milling',
      'a project without the field gains it',
    )
  })

  await test('projectWithProjectType moves the workspace off an Around setup when the new type has no Around', () => {
    const rotary = richProject()

    // The workspace is on the project's real Around setup.
    const onAround: Project = { ...rotary, activeSetupId: AROUND_SETUP_ID }
    const milled = projectWithProjectType(onAround, 'milling', CANDIDATES)
    assertEqual(activeFace(milled), 'top', 'leaving rotary moves the workspace to Top')
    assertEqual(milled.activeSetupId, TOP_SETUP_ID, 'onto the project\'s own Top setup')
    assertEqual(milled.features, rotary.features, 'and nothing is deleted')

    // No Top setup to land on: the workspace still leaves Around.
    const aroundOnly: Project = { ...rotary, setups: [rotary.setups[1]], activeSetupId: 'provisional-around' }
    const plasma = projectWithProjectType(aroundOnly, 'plasma', CANDIDATES)
    assertEqual(activeFace(plasma), 'top', 'a plasma project leaves the Around workspace')
    assertEqual(plasma.activeSetupId, 'provisional-top', 'provisionally when the project has no Top setup')

    // A rotary project keeps the Around workspace: the change does not need it.
    assertEqual(activeFace(projectWithProjectType(onAround, 'rotary', CANDIDATES)), 'around', 'a rotary project keeps the Around workspace')
  })

  await test('the export leaves an Around setup\'s operation out of the programs when the project is not rotary', async () => {
    const OPTIONS: ExportPostOptions = { emitToolChanges: false, emitCoolant: false, programName: 'around-left-out', captureMotionTrace: false }
    const tool: Tool = { ...defaultTool('mm', 1), id: 't1' }
    const base = projectWith([])
    const top = base.setups[0]
    const around: MachiningSetup = {
      id: 'su-around', kind: 'around', name: 'Around',
      orientation: { axis: 'x', angleDeg: 0 }, indexing: 'manual', registration: [], notes: '', operationIds: [],
    }
    // A milling project that still holds an Around setup: the top operation is
    // cut, the one in the Around setup is kept but is not.
    const project: Project = syncProjectSetups({
      ...base,
      tools: [tool],
      setups: [top, around],
      meta: { ...base.meta, projectType: 'milling', machineDefinitions: [PLAIN_ROUTER], selectedMachineId: PLAIN_ROUTER.id },
      operations: [
        { ...makeOperation('top-op'), toolRef: 't1', setupId: top.id },
        { ...makeOperation('around-op'), toolRef: 't1', setupId: around.id },
      ],
    })

    const h = makeCountingService({ project, documentKey: 1 })
    const token = createExportToken(1, h.context(), ['top-op', 'around-op'], PLAIN_ROUTER, OPTIONS)
    const prepared = await prepareExport(h.service, h.context(), token, PLAIN_ROUTER, OPTIONS)
    if (prepared.status !== 'ready') throw new Error('the top operation prepares')
    assertEqual(
      prepared.programs.flatMap((program) => program.operations.map((row) => row.operation.id)),
      ['top-op'],
      'the Around operation is in no program',
    )
    assertEqual(h.order, ['top-op'], 'and is never even requested')

    // Only Around operations left: there is nothing to export.
    const only = makeCountingService({ project, documentKey: 2 })
    const onlyToken = createExportToken(1, only.context(), ['around-op'], PLAIN_ROUTER, OPTIONS)
    assertEqual(
      (await prepareExport(only.service, only.context(), onlyToken, PLAIN_ROUTER, OPTIONS)).status,
      'blocked',
      'a project with only Around operations has nothing to export',
    )
  })

  await test('the export keeps the other family\'s operation and the postprocessor skips it', async () => {
    const OPTIONS: ExportPostOptions = { emitToolChanges: false, emitCoolant: false, programName: 'other-family', captureMotionTrace: false }
    const tool: Tool = { ...defaultTool('mm', 1), id: 't1' }
    // A plasma project that still holds a milling operation: the plasma cut is
    // programmed and the milling one is listed, requested and skipped with its
    // warning (issues #1028 correction, #960).
    const project: Project = {
      ...projectWith([]),
      tools: [tool],
      meta: {
        ...projectWith([]).meta,
        projectType: 'plasma',
        machineDefinitions: [QTPLASMAC],
        selectedMachineId: QTPLASMAC.id,
      },
      operations: [
        { ...makeOperation('torch-op'), kind: 'plasma_profile' },
        makeOperation('mill-op'),
      ],
    }

    const h = makeCountingService({ project, documentKey: 1 })
    const token = createExportToken(1, h.context(), ['torch-op', 'mill-op'], QTPLASMAC, OPTIONS)
    const prepared = await prepareExport(h.service, h.context(), token, QTPLASMAC, OPTIONS)
    assertEqual(prepared.status, 'ready', 'the program prepares with the milling operation listed')
    if (prepared.status !== 'ready') throw new Error('unreachable')
    assertEqual(
      prepared.programs.flatMap((program) => program.operations.map((row) => row.operation.id)),
      ['torch-op', 'mill-op'],
      'the milling operation is carried into the program, not filtered out',
    )
    assertEqual(
      h.order,
      ['torch-op', 'mill-op'],
      'and it is generated like any other operation',
    )
    assertEqual(
      prepared.programs.flatMap((program) => program.result.warnings)
        .filter((warning) => warning.code === 'postPlasmaOperationSkipped')
        .map((warning) => warning.params),
      [{ operation: 'mill-op' }],
      'the postprocessor skips it and says so (issue #960)',
    )
    assertEqual(
      prepared.programs.flatMap((program) => program.result.warnings)
        .some((warning) => warning.code === 'exportMachineTypeMismatch'),
      false,
      'the machine suits the plasma project, so nothing is refused',
    )
  })

  await test('operationHiddenByProjectType hides only an Around setup outside rotary', () => {
    const base = newProject('narrow', 'mm')
    const top = base.setups[0]
    const around: MachiningSetup = {
      id: 'su-around', kind: 'around', name: 'Around',
      orientation: { axis: 'x', angleDeg: 0 }, indexing: 'manual', registration: [], notes: '', operationIds: [],
    }
    const setups = [top, around]
    const inProject = (type: ProjectType) => ({
      project: { ...base, setups, meta: { ...base.meta, projectType: type } },
    })
    const milling = inProject('milling')
    const plasma = inProject('plasma')
    const rotary = inProject('rotary')

    assertEqual(
      operationHiddenByProjectType(milling.project, { setupId: around.id }),
      true,
      'an Around setup operation is hidden in a milling project',
    )
    assertEqual(
      operationCutsInProject(milling.project, { kind: 'pocket', setupId: around.id }),
      false,
      'and the wider predicate agrees it is not cut',
    )

    // The correction (issue #1028): the other family's *kind* is not hidden.
    assertEqual(
      operationHiddenByProjectType(milling.project, { setupId: top.id }),
      false,
      'a plasma cut in a milling project is not hidden',
    )
    assertEqual(
      operationCutsInProject(milling.project, { kind: 'plasma_profile', setupId: top.id }),
      false,
      'but it is not cut — the wider predicate is where that lives',
    )
    assertEqual(
      operationHiddenByProjectType(plasma.project, { setupId: top.id }),
      false,
      'a milling cut in a plasma project is not hidden',
    )
    assertEqual(
      operationCutsInProject(plasma.project, { kind: 'pocket', setupId: top.id }),
      false,
      'but it is not cut',
    )

    // An Around setup cuts in a rotary project, and a Top operation always.
    assertEqual(
      operationHiddenByProjectType(rotary.project, { setupId: around.id }),
      false,
      'a rotary project hides nothing',
    )
    assertEqual(
      operationHiddenByProjectType(milling.project, { setupId: top.id }),
      false,
      'a Top operation is never hidden',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

await main()
