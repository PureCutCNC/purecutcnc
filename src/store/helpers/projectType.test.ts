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
  inferProjectType,
  machineMatchesProjectType,
  projectMachineMismatch,
  projectType,
  projectTypeChangeSummary,
  stockShapesForProjectType,
} from './projectType'
import { aroundUnavailableReason } from './activeFace'
import { syncProjectSetups } from './setups'
import { useProjectStore } from '../projectStore'
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

/** `aroundUnavailableReason` before #1028: round bar plus a matching rotary block. */
function legacyAroundAvailable(project: Project): boolean {
  if (project.stock.shape !== 'round') return false
  const rotary = project.meta.machineDefinitions?.[0]?.rotary
  return rotary !== undefined && rotary.about === project.stock.axis
}

function assertInferenceParity(label: string, legacy: Project): void {
  const inferred = inferProjectType(legacy)
  const typed: Project = { ...legacy, meta: { ...legacy.meta, projectType: inferred } }
  assertEqual(machineMode(typed), legacyMachineMode(legacy), `${label}: machineMode is unchanged`)
  assertEqual(
    aroundUnavailableReason(typed) === null,
    legacyAroundAvailable(legacy),
    `${label}: Around availability is unchanged`,
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
 * Hashes captured from the base commit (`97098461`) with the same script, so
 * a change that alters the generated program of a consistent fixture fails
 * here. The projects are made coherent first: the machine and the stock are
 * what the type implies, exactly as the load migration reads them.
 */
const BASE_HASHES = {
  plasma: '434b37ddb9dfaf24',
  'pocket-feed-reduction.camj': 'cbf2417a4be43caf',
  'v-carve-noise-test.camj': '24623f98ba01c484',
  'another-pocket-test.camj': '4f96da538edfabb4',
  around: 'ea243dcd26bac24e',
  aroundMoves: '1ae454fc6597c367',
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

function seed(project: Project): void {
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } })
}

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
    assertEqual([...stockShapesForProjectType('rotary')], ['round'], 'rotary turns a round bar')
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
    const plasmaProgram = runPostProcessor({ ...input, project: plasmaProject }).gcode
    assertEqual(hash(plasmaProgram), BASE_HASHES.plasma, 'the plasma program is byte-identical')

    // Plain milling, straight from checked-in files.
    for (const name of ['pocket-feed-reduction.camj', 'v-carve-noise-test.camj', 'another-pocket-test.camj'] as const) {
      const raw = JSON.parse(readFileSync(new URL(`../../engine/test-fixtures/${name}`, import.meta.url), 'utf8'))
      const project = decodeProjectFormat(raw).project
      const embedded = project.meta.machineDefinitions.find((d) => d.id === project.meta.selectedMachineId) ?? null
      const definition = embedded ? validateMachineDefinition(structuredClone(embedded)) : bundled('generic')
      const gcode = postOperations(project, definition, project.operations.filter((operation) => operation.enabled), name)
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
    const aroundProgram = runPostProcessor({
      project: barProject,
      definition: machine,
      operations: [{ operation, tool: normalizeToolForProject(tool, barProject), toolpath: envelope.result }],
      options: { emitToolChanges: false, emitCoolant: false, programName: 'around' },
    }).gcode
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

  await test('projectTypeChangeSummary counts what each change would do', () => {
    const project = richProject()
    const aroundFeatures = project.features.filter((feature) => feature.authoringFace === 'around').length
    const enabled = project.operations.filter((operation) => operation.enabled)

    const toPlasma = projectTypeChangeSummary(project, 'plasma', CANDIDATES)
    assertEqual(toPlasma.from, 'rotary', 'from is the stored type')
    assertEqual(toPlasma.to, 'plasma', 'to is the requested type')
    assertEqual(
      toPlasma.inactiveOperations,
      enabled.filter((operation) => operation.kind !== 'plasma_profile').length,
      'plasma leaves the milling and rotary operations uncut',
    )
    assertEqual(toPlasma.hiddenAroundFeatures, aroundFeatures, 'leaving rotary hides the Around features')
    assertEqual(toPlasma.stockConversion, 'toBlock', 'a plasma project takes a block')
    assertEqual(toPlasma.machineChange, { id: QTPLASMAC.id, name: QTPLASMAC.name }, 'and selects a plasma machine')

    const toMilling = projectTypeChangeSummary(project, 'milling', CANDIDATES)
    assertEqual(
      toMilling.inactiveOperations,
      enabled.filter((operation) => operation.kind !== 'pocket').length,
      'milling leaves the plasma and rotary operations uncut',
    )
    assertEqual(toMilling.stockConversion, 'toBlock', 'a milling project takes a block')
    assertEqual(toMilling.machineChange, null, 'the rotary router already suits milling')

    const toRotary = projectTypeChangeSummary(project, 'rotary', CANDIDATES)
    assertEqual(
      toRotary.inactiveOperations,
      enabled.filter((operation) => operation.kind === 'plasma_profile').length,
      'rotary leaves only the plasma operation uncut',
    )
    assertEqual(toRotary.hiddenAroundFeatures, 0, 'a rotary project hides nothing')
    const alreadyOffRotary: Project = { ...project, meta: { ...project.meta, projectType: 'milling' } }
    assertEqual(
      projectTypeChangeSummary(alreadyOffRotary, 'plasma', CANDIDATES).hiddenAroundFeatures,
      0,
      'a project already off rotary hides nothing new',
    )
    assertEqual(toRotary.stockConversion, null, 'the bar already is round')
    assertEqual(toRotary.machineChange, null, 'the rotary router suits rotary')
  })

  await test('setProjectType: all six changes keep every feature and operation, one undo step each', () => {
    const types: ProjectType[] = ['milling', 'plasma', 'rotary']
    for (const from of types) {
      for (const to of types) {
        if (from === to) continue
        const machine = from === 'rotary' ? rotaryRouter() : from === 'plasma' ? QTPLASMAC : PLAIN_ROUTER
        const start: Project = { ...richProject(), meta: { ...richProject().meta, projectType: from, machineDefinitions: [machine], selectedMachineId: machine.id } }
        seed(start)
        const before = useProjectStore.getState().project
        useProjectStore.getState().setProjectType(to, CANDIDATES)
        const after = useProjectStore.getState().project

        assertEqual(after.meta.projectType, to, `${from} -> ${to}: the type is stored`)
        assertEqual(after.features, before.features, `${from} -> ${to}: nothing is deleted from the features`)
        assertEqual(after.operations, before.operations, `${from} -> ${to}: nothing is deleted from the operations`)
        assertEqual(after.stock.shape === 'round', to === 'rotary', `${from} -> ${to}: the stock takes the type's shape`)
        assertEqual(
          getActiveMachineDefinition(after)?.id,
          expectedMachineId(machine, to),
          `${from} -> ${to}: the machine follows the type`,
        )
        assertEqual(useProjectStore.getState().history.past.length, 1, `${from} -> ${to}: one undo step`)

        // Back to where it started: features and operations are untouched.
        useProjectStore.getState().setProjectType(from, CANDIDATES)
        const back = useProjectStore.getState().project
        assertEqual(back.features, before.features, `${from} -> ${to} -> ${from}: features are restored`)
        assertEqual(back.operations, before.operations, `${from} -> ${to} -> ${from}: operations are restored`)
      }
    }
  })

  await test('setProjectType selects the first matching candidate and leaves the machine when none matches', () => {
    // A plasma machine on a milling project: the first candidate is the plasma
    // machine (which does not suit milling), so the plain router is picked
    // even though it is second in the list.
    const base = richProject()
    seed({ ...base, meta: { ...base.meta, projectType: 'milling', machineDefinitions: [QTPLASMAC], selectedMachineId: QTPLASMAC.id } })
    useProjectStore.getState().setProjectType('milling', [QTPLASMAC, PLAIN_ROUTER])
    assertEqual(
      useProjectStore.getState().project.meta.selectedMachineId,
      PLAIN_ROUTER.id,
      'the first machine that suits the type is selected',
    )

    // No candidate suits: the machine is left alone.
    seed(projectOfType('rotary', PLAIN_ROUTER))
    useProjectStore.getState().setProjectType('rotary', [PLAIN_ROUTER])
    assertEqual(
      useProjectStore.getState().project.meta.selectedMachineId,
      PLAIN_ROUTER.id,
      'with no matching candidate the machine stays',
    )

    // A change that needs nothing moved is a no-op, not a fresh undo step.
    seed(projectOfType('milling', PLAIN_ROUTER))
    useProjectStore.getState().setProjectType('milling', CANDIDATES)
    assertEqual(useProjectStore.getState().history.past.length, 0, 'an unchanged type is a no-op')

    // A hand-built project without the field takes the write even when the
    // inference already agrees, so saving always carries the type.
    seed(withoutProjectType(projectOfType('milling', PLAIN_ROUTER)))
    useProjectStore.getState().setProjectType('milling', CANDIDATES)
    assertEqual(
      useProjectStore.getState().project.meta.projectType,
      'milling',
      'a project without the field gains it',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

await main()
