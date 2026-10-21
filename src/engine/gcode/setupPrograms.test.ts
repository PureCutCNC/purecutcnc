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
 * One program per setup (issue #946): how an export is split, what each file
 * is called, what its header tells the operator, and what a program may not
 * be — one that runs across a manual turn, or one missing a refused pass.
 *
 * The flat stock is 100 × 80 × 20 at (0, 0); the default origin is its
 * front-left corner on the face that is up: (0, 80, 20). The rotary bar the
 * manual-indexing cases use is a 20 mm round bar 100 mm long, with its origin
 * on the centreline and the top of the bar (#1054 slice 2). Mutations those
 * assertions were checked against: dropping the header for a single setup →
 * the single-setup header assertions fail; flipping a Bottom setup about X on
 * a Y bar → the flip-axis assertion fails; giving a block or an Around program
 * the A lines → the byte-identical baselines fail. For the program's own turn
 * (#1054 slice 2b): writing the turn before the retract → the exact
 * retract-then-turn lines fail; ignoring `reversed` → the bottom-program
 * blocks fail. For #1054 fix 1: writing the opening turn before the first
 * tool change → the LinuxCNC G43-order assertion fails; posting the turn on a
 * mismatched rotary axis → the refusal assertion fails; comparing the closing
 * unwind in machine Z → the `-Z` assertion fails.
 *
 * Run with: npx tsx src/engine/gcode/setupPrograms.test.ts
 */

import { createHash } from 'node:crypto'
import { squareStock } from '../../types/barStock'
import { circleProfile, defaultTool, getStockBounds, newProject, rectProfile, roundStock } from '../../types/project'
import type { MachineOrigin, MachiningSetup, Operation, Project, SketchFeature } from '../../types/project'
import { suggestGcodeFileName } from '../../components/export/exportOperationSelection'
import { BOTTOM_SETUP_ID, projectWithFeatures, withBottomSetup, withoutSetupFields } from '../../test/projectFixtures'
import { syncProjectSetups } from '../../store/helpers/setups'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import { warningSeverity } from '../toolpaths/warningCodes'
import { BUNDLED_DEFINITIONS } from './definitions'
import { planProgramSetup } from './motionPipeline'
import { runPostProcessor } from './postprocessor'
import {
  describeRegistration,
  describeTouchOff,
  planSetupPrograms,
  projectExportsPerSetup,
  setupHeaderLines,
} from './setupPrograms'
import { validateMachineDefinition } from './types'
import { formatGCodeNumber } from './utils'
import type { MachineDefinition, PostProcessorResult, RotaryDefinition } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
}

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  if (!found) throw new Error(`Fixture error: no bundled definition "${id}"`)
  return validateMachineDefinition(structuredClone(found))
}

const GRBL = bundled('grbl')
const LINUXCNC = bundled('linuxcnc')
const SHOPBOT = bundled('shopbot')

function makeOperation(id: string, name: string, overrides: Partial<Operation> = {}): Operation {
  return {
    id,
    name,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'stock' },
    toolRef: 't1',
    stepdown: 1,
    stepover: 0.4,
    feed: 600,
    plungeFeed: 180,
    rpm: 12000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    ...overrides,
  }
}

function feature(id: string, zTop: number, zBottom: number, face: 'top' | 'bottom'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'circle',
    folderId: null,
    sketch: { profile: circleProfile(30, 30, 5), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    authoringFace: face,
    visible: true,
    locked: false,
  }
}

/** A single-setup project with four operations: Rough, Drill, Finish, Under. */
function singleSetupProject(name = 'Pin Plate'): Project {
  const base = newProject(name, 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  base.origin = { name: 'Origin', x: 0, y: 80, z: 20, visible: true }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Tool 1' }]
  const project = projectWithFeatures(base, [feature('Pin A', 20, 0, 'top'), feature('Tray', 20, 14, 'top')])
  return syncProjectSetups({
    ...project,
    operations: [
      makeOperation('rough', 'Rough'),
      makeOperation('drill', 'Drill'),
      makeOperation('under', 'Under'),
      makeOperation('finish', 'Finish'),
    ],
  })
}

/** The same project with `under` moved to a Bottom setup. */
function twoSetupProject(setup: Partial<MachiningSetup> = {}, axis: 'x' | 'y' = 'x'): Project {
  return withBottomSetup(singleSetupProject(), { axis, operationIds: ['under'], setup })
}

const MOVES: ToolpathMove[] = [
  { kind: 'rapid', from: { x: 0, y: 0, z: 25 }, to: { x: 10, y: 70, z: 25 } },
  { kind: 'plunge', from: { x: 10, y: 70, z: 25 }, to: { x: 10, y: 70, z: 15 } },
  { kind: 'cut', from: { x: 10, y: 70, z: 15 }, to: { x: 30, y: 70, z: 15 } },
]

function post(
  project: Project,
  operationIds: string[],
  definition: MachineDefinition,
  moves: ToolpathMove[] = MOVES,
  emitToolChanges = true,
): PostProcessorResult {
  const tool = normalizeToolForProject(project.tools[0], project)
  return runPostProcessor({
    project,
    definition,
    operations: operationIds.map((id) => {
      const operation = project.operations.find((entry) => entry.id === id)!
      const toolpath: ToolpathResult = { operationId: id, warnings: [], bounds: null, moves }
      return { operation, tool, toolpath }
    }),
    options: { emitToolChanges, emitCoolant: false },
  })
}

// ── Splitting ─────────────────────────────────────────────────

function testSingleSetupIsNotSplit(): void {
  console.log('Testing a single-setup project exports one program under today\'s name...')
  const project = singleSetupProject()
  assert(!projectExportsPerSetup(project), 'one setup: not per-setup')
  const all = ['rough', 'drill', 'under', 'finish']
  const [program, ...rest] = planSetupPrograms(project, all)
  assertEqual(rest.length, 0, 'one program')
  assertEqual(program.operationIds, all, 'holding every operation')
  assertEqual([program.programNumber, program.face, program.setup?.id], [1, 'top', 'setup-top'], 'for the Top setup')

  // The file name is exactly what the dialog suggested before setups existed.
  for (const name of ['Pin Plate', 'two  spaces', ' padded ', 'x']) {
    const named = singleSetupProject(name)
    assertEqual(planSetupPrograms(named, all)[0].fileStem, suggestGcodeFileName(name, ['Rough', 'Drill', 'Under', 'Finish']), `"${name}": every operation`)
    assertEqual(planSetupPrograms(named, ['drill'])[0].fileStem, suggestGcodeFileName(name, ['Drill']), `"${name}": one operation`)
  }
  assertEqual(planSetupPrograms(project, all)[0].fileStem, 'Pin_Plate', 'in words: the project name')
  assertEqual(planSetupPrograms(project, ['drill'])[0].fileStem, 'Pin_Plate_Drill', 'in words: plus the one operation')

  assertEqual(planSetupPrograms(project, []), [], 'nothing selected: no program')
  assertEqual(planSetupPrograms(project, ['gone']), [], 'an unknown id selects nothing')
  // The selection's order does not reorder the cut.
  assertEqual(planSetupPrograms(project, ['finish', 'rough'])[0].operationIds, ['rough', 'finish'], 'operations are in project order')

  // A project as a pre-setup build held it.
  const legacy = withoutSetupFields(project) as unknown as Project
  const [legacyProgram] = planSetupPrograms(legacy, all)
  assertEqual([legacyProgram.setup, legacyProgram.fileStem, legacyProgram.operationIds], [null, 'Pin_Plate', all], 'a project without setups is one program')
}

function testTwoSetupsAreSplit(): void {
  console.log('Testing two setups export two programs...')
  const project = twoSetupProject()
  assert(projectExportsPerSetup(project), 'two setups: per-setup')
  const programs = planSetupPrograms(project, ['rough', 'drill', 'under', 'finish'])
  assertEqual(programs.map((program) => [program.programNumber, program.face, program.setup?.id, program.operationIds, program.fileStem]), [
    [1, 'top', 'setup-top', ['rough', 'drill', 'finish'], 'Pin_Plate_01_top'],
    [2, 'bottom', BOTTOM_SETUP_ID, ['under'], 'Pin_Plate_02_bottom'],
  ], 'one program per setup, named for it, each with its own operations in project order')

  // Only what was selected, and no program for a setup with nothing selected.
  assertEqual(planSetupPrograms(project, ['rough', 'finish']).map((program) => program.fileStem), ['Pin_Plate_01_top'], 'a setup with nothing selected has no program')
  assertEqual(planSetupPrograms(project, ['under']).map((program) => program.fileStem), ['Pin_Plate_02_bottom_Under'], 'one operation: the setup stays in the name')
  // Empty Bottom setup: Top is still named and numbered as a setup's program.
  const emptyBottom = withBottomSetup(singleSetupProject())
  assertEqual(planSetupPrograms(emptyBottom, ['rough', 'drill']).map((program) => program.fileStem), ['Pin_Plate_01_top'], 'the Top program is named per setup as soon as a second setup exists')

  // The name in the file is the setup's own, so two Bottoms do not collide.
  const renamed = twoSetupProject({ name: 'Under Side #2' })
  assertEqual(planSetupPrograms(renamed, ['under'])[0].fileStem.replace(/_Under$/, ''), 'Pin_Plate_02_under_side_2', 'the setup name is made file-safe')
  const unnamed = twoSetupProject({ name: '***' })
  assertEqual(planSetupPrograms(unnamed, ['rough', 'under'])[1].fileStem, 'Pin_Plate_02_bottom', 'a name with nothing usable falls back to the face')

  // An operation must land in a program, or stop the export.
  const dangling: Project = { ...project, operations: project.operations.map((op) => (op.id === 'drill' ? { ...op, setupId: 'gone' } : op)) }
  let threw = false
  try { planSetupPrograms(dangling, ['rough', 'drill']) } catch { threw = true }
  assert(threw, 'an operation in a setup that does not exist stops the export')
  const noSetup: Project = { ...project, operations: project.operations.map((op) => (op.id === 'drill' ? { ...op, setupId: undefined } : op)) }
  assertEqual(planSetupPrograms(noSetup, ['rough', 'drill'])[0].operationIds, ['rough', 'drill'], 'an operation without a setup reads as Top and is not dropped')
}

// ── Header ────────────────────────────────────────────────────

function testTouchOff(): void {
  console.log('Testing the touch-off description...')
  const project = singleSetupProject()
  const at = (x: number, y: number, z = 20): Pick<Project, 'origin' | 'stock' | 'meta'> => ({
    stock: project.stock,
    meta: project.meta,
    origin: { name: 'Origin', x, y, z, visible: true } satisfies MachineOrigin,
  })
  // Project Y runs toward the operator: y = 80 is the front edge.
  assertEqual(describeTouchOff(at(0, 80), 'top'), 'FRONT-LEFT CORNER OF THE TOP FACE AS MOUNTED, Z0 ON THAT FACE', 'front-left')
  assertEqual(describeTouchOff(at(100, 0), 'bottom'), 'BACK-RIGHT CORNER OF THE BOTTOM FACE AS MOUNTED, Z0 ON THAT FACE', 'back-right, Bottom')
  assertEqual(describeTouchOff(at(50, 40), 'top'), 'CENTRE OF THE TOP FACE AS MOUNTED, Z0 ON THAT FACE', 'centre')
  assertEqual(describeTouchOff(at(0, 40), 'top'), 'CENTRE OF THE LEFT EDGE OF THE TOP FACE AS MOUNTED, Z0 ON THAT FACE', 'left edge centre')
  assertEqual(describeTouchOff(at(50, 80), 'top'), 'CENTRE OF THE FRONT EDGE OF THE TOP FACE AS MOUNTED, Z0 ON THAT FACE', 'front edge centre')
  // Anywhere else: measured from the front-left corner, in machine directions.
  assertEqual(describeTouchOff(at(12.5, 70), 'bottom'), 'X12.5 Y10 MM FROM THE FRONT-LEFT CORNER OF THE BOTTOM FACE AS MOUNTED, Z0 ON THAT FACE', 'off-corner')
  assertEqual(describeTouchOff(at(0, 80, 0), 'top'), 'FRONT-LEFT CORNER OF THE TOP FACE AS MOUNTED, Z0 20 MM BELOW THAT FACE', 'Z0 on the bed')
  assertEqual(describeTouchOff(at(0, 80, 22.5), 'top'), 'FRONT-LEFT CORNER OF THE TOP FACE AS MOUNTED, Z0 2.5 MM ABOVE THAT FACE', 'Z0 above the face')
}

function testHeaderLines(): void {
  console.log('Testing the setup header...')
  const bare = twoSetupProject()
  const [top, bottom] = bare.setups
  // The machine a program is for; no bundled definition borrows a motor, so
  // these headers are the same whatever the definition (issue #395).
  const machine = bundled('grbl')
  assertEqual(setupHeaderLines(bare, top, machine), [
    'SETUP 01: Top - TOP FACE UP',
    'REGISTRATION: NONE DECLARED',
    'TOUCH OFF: FRONT-LEFT CORNER OF THE TOP FACE AS MOUNTED, Z0 ON THAT FACE',
  ], 'Top')
  assertEqual(setupHeaderLines(bare, bottom, machine), [
    'SETUP 02: Bottom - BOTTOM FACE UP - FLIP STOCK ABOUT X',
    'REGISTRATION: NONE DECLARED',
    'TOUCH OFF: FRONT-LEFT CORNER OF THE BOTTOM FACE AS MOUNTED, Z0 ON THAT FACE',
  ], 'Bottom')
  assertEqual(setupHeaderLines(twoSetupProject({}, 'y'), twoSetupProject({}, 'y').setups[1], machine)[0], 'SETUP 02: Bottom - BOTTOM FACE UP - FLIP STOCK ABOUT Y', 'the flip axis is named')

  const full = twoSetupProject({
    name: 'Underside',
    notes: 'Flip toward you.\n\n  Seat on the   spoilboard dowels. \r\nClamp the long edges.',
    registration: [
      { id: 'r1', kind: 'dowel', target: { type: 'feature', featureId: bareFeatureId(bare, 'Pin A') } },
      { id: 'r2', kind: 'corner', target: { type: 'point', point: { x: 0, y: 80 } } },
      { id: 'r3', kind: 'fence', target: { type: 'edge', start: { x: 0, y: 80 }, end: { x: 100, y: 80 } } },
    ],
  })
  assertEqual(setupHeaderLines(full, full.setups[1], machine), [
    'SETUP 02: Underside - BOTTOM FACE UP - FLIP STOCK ABOUT X',
    'REGISTRATION: DOWEL Pin A, CORNER AT X0 Y80, FENCE FROM X0 Y80 TO X100 Y80',
    'TOUCH OFF: FRONT-LEFT CORNER OF THE BOTTOM FACE AS MOUNTED, Z0 ON THAT FACE',
    'NOTE: Flip toward you.',
    'NOTE: Seat on the spoilboard dowels.',
    'NOTE: Clamp the long edges.',
  ], 'registration and notes, one line each')
  assertEqual(describeRegistration(full, { registration: [] }), 'NONE DECLARED', 'no references is said plainly')
}

function bareFeatureId(project: Project, name: string): string {
  const found = project.features.find((entry) => entry.name === name)
  if (!found) throw new Error(`Fixture error: no feature "${name}"`)
  return found.id
}

// ── The program ───────────────────────────────────────────────

function testProgramHeaderInBothDialects(): void {
  console.log('Testing the header is written by every dialect...')
  const project = twoSetupProject({ notes: 'Flip toward you (carefully).' })

  const gcode = post(project, ['under'], GRBL).gcode.split('\n')
  const first = gcode.findIndex((line) => line.includes('SETUP 02'))
  assertEqual(gcode.slice(first, first + 4), [
    '; SETUP 02: Bottom - BOTTOM FACE UP - FLIP STOCK ABOUT X',
    '; REGISTRATION: NONE DECLARED',
    '; TOUCH OFF: FRONT-LEFT CORNER OF THE BOTTOM FACE AS MOUNTED, Z0 ON THAT FACE',
    // Parentheses would end a (…) comment early on other controllers.
    '; NOTE: Flip toward you carefully .',
  ], 'GRBL: comment lines in the machine\'s own syntax')
  assert(first > 0 && gcode[first + 4].includes('Operation'), 'GRBL: after the program header, before the first operation')

  const paren = post(project, ['under'], LINUXCNC).gcode.split('\n').filter((line) => /SETUP|REGISTRATION|TOUCH OFF|NOTE/.test(line))
  assertEqual(paren.length, 4, 'LinuxCNC: four header lines')
  assert(paren.every((line) => /^\(.*\)$/.test(line) && !/[()].*[()].*[()]/.test(line)), `LinuxCNC: each is one well-formed (…) comment: ${JSON.stringify(paren)}`)

  const sbp = post(project, ['under'], SHOPBOT).gcode.split('\r\n')
  const sbpFirst = sbp.findIndex((line) => line.includes('SETUP 02'))
  assertEqual(sbp.slice(sbpFirst, sbpFirst + 4), [
    '\' SETUP 02: Bottom - BOTTOM FACE UP - FLIP STOCK ABOUT X',
    '\' REGISTRATION: NONE DECLARED',
    '\' TOUCH OFF: FRONT-LEFT CORNER OF THE BOTTOM FACE AS MOUNTED, Z0 ON THAT FACE',
    '\' NOTE: Flip toward you (carefully).',
  ], 'ShopBot: the same lines as part-file comments')
  assert(sbp.findIndex((line) => line.startsWith('IF %(25)')) > sbpFirst, 'ShopBot: in the header comment block, before the units guard')

  // The Top program of the same project is headed as setup 01.
  const top = post(project, ['rough', 'drill'], GRBL).gcode
  assert(top.includes('; SETUP 01: Top - TOP FACE UP') && !top.includes('SETUP 02'), 'the Top program is headed for Top')
}

function testSingleSetupProgramIsUnchanged(): void {
  console.log('Testing a single-setup program carries no setup header...')
  const project = singleSetupProject()
  const legacy = withoutSetupFields(project) as unknown as Project
  for (const definition of [GRBL, LINUXCNC, SHOPBOT]) {
    const now = post(project, ['rough', 'drill', 'under', 'finish'], definition)
    const before = post(legacy, ['rough', 'drill', 'under', 'finish'], definition)
    assertEqual(now.gcode, before.gcode, `${definition.id}: byte-identical to the pre-setup program`)
    assert(!/SETUP \d\d|REGISTRATION|TOUCH OFF/.test(now.gcode), `${definition.id}: no setup header`)
    assertEqual(now.warnings, before.warnings, `${definition.id}: same warnings`)
  }
  // Notes and registration on the only setup do not change that.
  const annotated: Project = {
    ...project,
    setups: [{ ...project.setups[0], notes: 'Mind the clamp.', registration: [{ id: 'r', kind: 'corner', target: { type: 'point', point: { x: 0, y: 0 } } }] }],
  }
  assertEqual(post(annotated, ['rough'], GRBL).gcode, post(project, ['rough'], GRBL).gcode, 'a single annotated setup still exports the legacy program')
  assertEqual(planProgramSetup({ project, operations: [], definition: GRBL }), { headerComments: [], manualIndexAngle: null, warnings: [] }, 'and plans nothing')
}

function testWhatAProgramMayNotBe(): void {
  console.log('Testing a program never runs across a manual turn...')
  const project = twoSetupProject()
  const mixed = post(project, ['rough', 'under'], GRBL)
  const codes = mixed.warnings.map((warning) => warning.code)
  assert(codes.includes('postMixedSetups'), 'operations of two setups in one program are reported')
  assertEqual(warningSeverity('postMixedSetups'), 'error', 'as an error, which blocks the save')
  assertEqual(mixed.warnings.find((warning) => warning.code === 'postMixedSetups')?.params, { setups: 'Top, Bottom' }, 'naming the setups')
  assert(!/SETUP \d\d/.test(mixed.gcode), 'and no setup header is written for one of them')
  for (const definition of [LINUXCNC, SHOPBOT]) {
    assert(post(project, ['rough', 'under'], definition).warnings.some((warning) => warning.code === 'postMixedSetups'), `${definition.id}: the same refusal`)
  }
  assert(!post(project, ['rough', 'drill', 'finish'], GRBL).warnings.some((warning) => warning.code === 'postMixedSetups'), 'one setup\'s operations are not mixed')

  console.log('Testing a second setup without registration is warned about...')
  const bottom = post(project, ['under'], GRBL).warnings
  assertEqual(bottom, [{ code: 'postSetupNoRegistration', params: { setup: 'Bottom' } }], 'the Bottom program warns')
  assertEqual(warningSeverity('postSetupNoRegistration'), 'warning', 'as a warning: the program is still the user\'s to run')
  assertEqual(post(project, ['rough'], GRBL).warnings, [], 'the first setup does not')
  const registered = twoSetupProject({ registration: [{ id: 'r', kind: 'corner', target: { type: 'point', point: { x: 0, y: 0 } } }] })
  assertEqual(post(registered, ['under'], GRBL).warnings, [], 'a declared reference clears it')

  console.log('Testing a refused operation blocks the program...')
  // `under` is in Bottom and targets a blind Top pocket: it generates nothing.
  const tray = bareFeatureId(project, 'Tray')
  const refused: Project = {
    ...project,
    operations: project.operations.map((op) => (op.id === 'under' ? { ...op, target: { source: 'features', featureIds: [tray] } } : op)),
  }
  const blocked = post(refused, ['under'], GRBL).warnings
  assert(blocked.some((warning) => warning.code === 'postSetupOperationRefused' && warning.params?.operation === 'Under'), 'the program names the refused operation')
  assertEqual(warningSeverity('postSetupOperationRefused'), 'error', 'as an error')
  // A through pin from Bottom is not refused.
  const pin = bareFeatureId(project, 'Pin A')
  const allowed: Project = {
    ...project,
    operations: project.operations.map((op) => (op.id === 'under' ? { ...op, target: { source: 'features', featureIds: [pin] } } : op)),
  }
  assert(!post(allowed, ['under'], GRBL).warnings.some((warning) => warning.code === 'postSetupOperationRefused'), 'a cross-face through target is not refused')
}

// ── Manual indexing on a rotary bar (#1054 slice 2) ───────────

/** A rotary project on a 20 mm round or square bar along `axis`, with the flat fixture's operations. */
function rotaryBarProjectOf(shape: 'round' | 'square', axis: 'x' | 'y' = 'x'): Project {
  const project = singleSetupProject()
  const bar = shape === 'round' ? roundStock(20, 100, axis) : squareStock(20, 100, axis)
  const bounds = getStockBounds(bar)
  const centre = axis === 'x' ? (bounds.minY + bounds.maxY) / 2 : (bounds.minX + bounds.maxX) / 2
  return syncProjectSetups({
    ...project,
    meta: { ...project.meta, projectType: 'rotary' },
    stock: bar,
    origin: {
      name: 'Origin',
      x: axis === 'x' ? bounds.minX : centre,
      y: axis === 'x' ? centre : bounds.maxY,
      z: bar.thickness,
      visible: true,
    },
  })
}

/** The slice-2 fixture: a 20 mm round bar along `axis`. */
function rotaryBarProject(axis: 'x' | 'y' = 'x'): Project {
  return rotaryBarProjectOf('round', axis)
}

/** The program's lines with every comment removed, so an A search sees motion only. */
function programWithoutComments(program: string, dialect: 'gcode' | 'sbp'): string {
  return program
    .split(dialect === 'sbp' ? '\r\n' : '\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return false
      return dialect === 'sbp' ? !trimmed.startsWith("'") : !/^[;(%]/.test(trimmed)
    })
    .join('\n')
}

function testManualIndexingOnARotaryBar(): void {
  console.log('Testing the manual A angle in a rotary bar program...')
  const A0 = 'ROTARY: SET A TO 0° BEFORE RUNNING'
  const A180 = 'ROTARY: SET A TO 180° - TURN THE BAR ABOUT ITS AXIS - BEFORE RUNNING'
  const RETRACT = 'ROTARY: RETRACT THE SPINDLE CLEAR OF THE BAR BEFORE TURNING A'
  const touch = {
    x: 'CENTRE OF THE LEFT EDGE OF THE TOP FACE AS MOUNTED, Z0 ON THAT FACE',
    y: 'CENTRE OF THE FRONT EDGE OF THE TOP FACE AS MOUNTED, Z0 ON THAT FACE',
  } as const

  for (const axis of ['x', 'y'] as const) {
    const project = rotaryBarProject(axis)
    // One Top setup: still not a per-setup export, and the file name is the
    // legacy one — only the header is added.
    assert(!projectExportsPerSetup(project), `${axis}: one Top setup is not a per-setup export`)
    assertEqual(planSetupPrograms(project, ['rough'])[0].fileStem, 'Pin_Plate_Rough', `${axis}: the single-setup file name is unchanged`)
    assertEqual(setupHeaderLines(project, project.setups[0], GRBL), [
      'SETUP 01: Top - TOP FACE UP',
      'REGISTRATION: NONE DECLARED',
      `TOUCH OFF: ${touch[axis]}`,
      A0,
      RETRACT,
    ], `${axis}: the Top lines, even with one setup`)

    const gcode = post(project, ['rough'], GRBL).gcode.split('\n')
    const at = gcode.findIndex((line) => line.includes('SETUP 01'))
    assert(at > 0, `${axis}: the header is in the program`)
    assertEqual(gcode.slice(at, at + 5), [
      '; SETUP 01: Top - TOP FACE UP',
      '; REGISTRATION: NONE DECLARED',
      `; TOUCH OFF: ${touch[axis]}`,
      `; ${A0}`,
      `; ${RETRACT}`,
    ], `${axis}: G-code writes the exact lines`)

    const sbp = post(project, ['rough'], SHOPBOT).gcode.split('\r\n')
    const sbpAt = sbp.findIndex((line) => line.includes('SETUP 01'))
    assertEqual(sbp.slice(sbpAt, sbpAt + 5), [
      "' SETUP 01: Top - TOP FACE UP",
      "' REGISTRATION: NONE DECLARED",
      `' TOUCH OFF: ${touch[axis]}`,
      `' ${A0}`,
      `' ${RETRACT}`,
    ], `${axis}: SBP writes the same lines as part-file comments`)

    // The program says which A to set but never moves it (#394 owns that).
    for (const [dialect, program] of [
      ['gcode', post(project, ['rough'], GRBL).gcode],
      ['sbp', post(project, ['rough'], SHOPBOT).gcode],
    ] as const) {
      const motion = programWithoutComments(program, dialect)
      assert(!/(^|\s)A[-+]?\d/.test(motion), `${axis}: ${dialect} emits no A word:\n${motion}`)
    }

    // A project whose only setup is Bottom is headed as program 01 too.
    const top = project.setups[0]
    const onlyBottom: MachiningSetup = { ...top, id: 'only-bottom', name: 'Bottom', orientation: { axis, angleDeg: 180 } }
    const bottomOnly = syncProjectSetups({
      ...project,
      setups: [onlyBottom],
      activeSetupId: onlyBottom.id,
      operations: project.operations.map((operation) => ({ ...operation, setupId: onlyBottom.id })),
    })
    assert(!projectExportsPerSetup(bottomOnly), `${axis}: one Bottom setup is not a per-setup export`)
    assertEqual(setupHeaderLines(bottomOnly, bottomOnly.setups[0], GRBL), [
      `SETUP 01: Bottom - BOTTOM FACE UP - FLIP STOCK ABOUT ${axis.toUpperCase()}`,
      'REGISTRATION: NONE DECLARED',
      `TOUCH OFF: ${touch[axis].replace('TOP', 'BOTTOM')}`,
      A180,
      RETRACT,
    ], `${axis}: the single Bottom setup is headed too`)

    // Two setups: each program is numbered and headed as before, plus A.
    const two = withBottomSetup(project, { axis, operationIds: ['under'] })
    assertEqual(setupHeaderLines(two, two.setups[1], GRBL), [
      `SETUP 02: Bottom - BOTTOM FACE UP - FLIP STOCK ABOUT ${axis.toUpperCase()}`,
      'REGISTRATION: NONE DECLARED',
      `TOUCH OFF: ${touch[axis].replace('TOP', 'BOTTOM')}`,
      A180,
      RETRACT,
    ], `${axis}: the Bottom program's lines`)
    const postedBottom = post(two, ['under'], GRBL).gcode
    assert(postedBottom.includes(`\n; ${A180}\n`), `${axis}: the posted Bottom program carries A180`)
    assert(postedBottom.includes(`\n; ${RETRACT}\n`), `${axis}: and the retract before turning`)
  }
}

function testBottomFlipAxisWarning(): void {
  console.log('Testing a Bottom setup whose flip axis is not the bar\'s warns...')
  const yBar = rotaryBarProject('y')
  const mismatched = withBottomSetup(yBar, { axis: 'x', operationIds: ['under'] })
  const program = post(mismatched, ['under'], GRBL)
  assertEqual(
    program.warnings.find((warning) => warning.code === 'setupFlipAxisMismatch'),
    { code: 'setupFlipAxisMismatch', params: { setup: 'Bottom', axis: 'X', barAxis: 'Y' } },
    'the warning names the setup and both axes',
  )
  assertEqual(warningSeverity('setupFlipAxisMismatch'), 'warning', 'as a warning: the stored setup is not rewritten')
  assert(program.gcode.includes('FLIP STOCK ABOUT X'), 'the program still describes the flip the setup stores')
  assert(program.gcode.includes('ROTARY: SET A TO 180°'), 'and still states A180 about the bar')

  const matching = withBottomSetup(yBar, { axis: 'y', operationIds: ['under'] })
  assert(
    !post(matching, ['under'], GRBL).warnings.some((warning) => warning.code === 'setupFlipAxisMismatch'),
    'a Y bar with a Y flip is not warned about',
  )

  // A block is not a bar: no A line, no flip-axis warning.
  const flatProgram = post(twoSetupProject({}, 'x'), ['under'], GRBL)
  assert(
    !flatProgram.warnings.some((warning) => warning.code === 'setupFlipAxisMismatch'),
    'a block project is not warned about',
  )
  assert(!flatProgram.gcode.includes('ROTARY: SET A'), 'and gets no A line')
}

// ── The program turns the bar itself (#1054 slice 2b) ─────────

/** The bundled grbl definition plus a rotary block the program can turn. */
function rotaryMachine(
  about: 'x' | 'y',
  drive: 'own' | 'borrowed',
  reversed = false,
): MachineDefinition {
  const rotary: RotaryDefinition = {
    about,
    drive,
    reversed,
    inverseTimeFeed: { on: 'G93', off: 'G94' },
  }
  return validateMachineDefinition({ ...structuredClone(GRBL), rotary })
}

/**
 * A pass that travels only along the bar, so a borrowed across motor never
 * moves as a linear axis (which the planner refuses). `clearance` is above the
 * top face for Top and under the bottom face for Bottom, as the toolpaths are
 * stored in stock space.
 */
function barMoves(axis: 'x' | 'y', face: 'top' | 'bottom'): ToolpathMove[] {
  const clearance = face === 'top' ? 25 : -5
  const cut = face === 'top' ? 15 : 5
  const at = (along: number, z: number): ToolpathPoint => (
    axis === 'x' ? { x: along, y: 10, z } : { x: 10, y: along, z }
  )
  return [
    { kind: 'rapid', from: at(0, clearance), to: at(10, clearance) },
    { kind: 'plunge', from: at(10, clearance), to: at(10, cut) },
    { kind: 'cut', from: at(10, cut), to: at(30, cut) },
    { kind: 'rapid', from: at(30, cut), to: at(30, clearance) },
  ]
}

function testManualIndexTurnsTheBarItself(): void {
  console.log('Testing the program turns the bar itself when the machine can...')
  // The travel height is the blank's largest radius above the pivot plus 1 mm:
  // 21 mm on a Ø20 round bar, 11 + 10√2 on a 20 mm square blank. The origin is
  // the top of the bar, 20 mm above the pivot. These fixtures apply no
  // tool-length compensation, so the retract is the machine definition's own
  // Safe Z (default 0 = the top of travel after homing), never a project
  // height and never the project's 50 mm Safe Z (#1054 fix 3).
  const safeWord = '0.000'
  const turnComment = (word: string, angle: number): string =>
    `ROTARY: RETRACTS TO MACHINE Z TOP WITH G53 BEFORE TURNING ${word} TO ${angle}° - CHECK THE BAR IS CLAMPED`

  for (const shape of ['round', 'square'] as const) {
    for (const axis of ['x', 'y'] as const) {
      const bar = rotaryBarProjectOf(shape, axis)
      const two = withBottomSetup(bar, { axis, operationIds: ['under'] })
      const letters = { own: 'A', borrowed: axis === 'x' ? 'Y' : 'X' } as const
      const shapeName = `${shape} bar along ${axis.toUpperCase()}`

      for (const reversed of [false, true]) {
        for (const drive of ['own', 'borrowed'] as const) {
          const definition = rotaryMachine(axis, drive, reversed)
          const letter = letters[drive]
          const label = `${shapeName}, ${drive} ${letter}${reversed ? ', reversed' : ''}`

          for (const face of ['top', 'bottom'] as const) {
            const angle = face === 'bottom' ? 180 : 0
            // The same sign handling the Around output uses: a reversed axis
            // (or a mirrored borrowed motor) writes the negative angle.
            const angleWord = `${letter}${(angle * (reversed ? -1 : 1)).toFixed(3)}`
            const program = post(two, [face === 'top' ? 'rough' : 'under'], definition, barMoves(axis, face)).gcode
            const lines = program.split('\n')
            const at = lines.findIndex((line) => /SETUP \d\d:/.test(line))
            const turn = `SETUP ${face === 'top' ? '01' : '02'}: ${face === 'top'
              ? 'Top - TOP FACE UP'
              : `Bottom - BOTTOM FACE UP - FLIP STOCK ABOUT ${axis.toUpperCase()}`}`
            assert(at > 0, `${label}, ${face}: the header is in the program`)
            assertEqual(lines.slice(at, at + 4), [
              `; ${turn}`,
              '; REGISTRATION: NONE DECLARED',
              `; TOUCH OFF: ${describeTouchOff(two, face)}`,
              `; ${turnComment(letter, angle)}`,
            ], `${label}, ${face}: the header comments, including what the program does`)
            assert(lines[at + 4].startsWith('; Operation'), `${label}, ${face}: before the first operation's header`)
            // The opening retract and turn follow the first operation's tool
            // change (#1054 fix 1, finding 1), then the operation's own motion.
            // GRBL's tool change is `M5` plus its `M0` tool-change line and
            // pause, and it applies no tool-length compensation, so the retract
            // is in machine coordinates to the definition's Safe Z, default 0
            // (#1054 fix 3).
            const retractAt = lines.indexOf(`G53 G0 Z${safeWord}`)
            assert(retractAt > at, `${label}, ${face}: the opening retract is in the program`)
            assertEqual(lines.slice(retractAt, retractAt + 2), [
              `G53 G0 Z${safeWord}`,
              `G0 ${angleWord}`,
            ], `${label}, ${face}: the retract, then the turn`)
            const changeAt = lines.findIndex((line) => line.startsWith('M0 ; Tool change'))
            assert(changeAt > at && changeAt < retractAt, `${label}, ${face}: after the tool change`)
            assert(!lines.slice(0, retractAt).includes('G93'), `${label}, ${face}: the turn is a rapid, still in G94`)
            const firstMotionAt = lines.findIndex((line, index) => index > retractAt + 1 && /^(G0|G1|G2|G3|X|Y|Z)/.test(line))
            assert(firstMotionAt > retractAt + 1, `${label}, ${face}: the turn is before the first operation's motion`)

            const motion = programWithoutComments(program, 'gcode').split('\n')
            const turnBlocks = motion.filter((line) => line.startsWith(`G0 ${letter}`))
            const endsAt = lines.lastIndexOf('M30')
            if (face === 'top') {
              assertEqual(turnBlocks, [`G0 ${angleWord}`], `${label}: Top turns once and never unwinds`)
              assertEqual(lines[endsAt - 1], 'M5', `${label}: nothing is posted after the last operation but the spindle stop`)
            } else {
              assertEqual(turnBlocks, [`G0 ${angleWord}`, `G0 ${letter}0.000`], `${label}: Bottom turns to 180, then unwinds to 0`)
              assertEqual(lines[endsAt - 1], `G0 ${letter}0.000`, `${label}: the unwind is the last motion block`)
              // No compensation is active, so the closing retract is the
              // definition's machine Safe Z too, whatever the bar's shape
              // (#1054 fix 3).
              assertEqual(lines[endsAt - 2], `G53 G0 Z${safeWord}`, `${label}: after retracting to the machine Safe Z`)
              assertEqual(lines[endsAt - 3], 'M5', `${label}: after the spindle stop`)
            }
          }
        }
      }

      // The project's only setup is a Top one, and it is not a per-setup
      // export: the header and the opening turn are still posted (#1054
      // slice 2b does not depend on a second setup existing).
      const single = post(bar, ['rough'], rotaryMachine(axis, 'own'), barMoves(axis, 'top')).gcode
      assert(single.includes(`; ${turnComment('A', 0)}`), `${shapeName}, one Top setup: the turn comment`)
      assert(single.includes(`\nG53 G0 Z${safeWord}\nG0 A0.000\n`), `${shapeName}, one Top setup: the retract and the turn`)

      // A machine without a rotary axis keeps slice 2 exactly: the operator
      // comment, no turn word, and no motion added.
      const plain = post(two, ['under'], GRBL, barMoves(axis, 'bottom')).gcode
      assert(plain.includes('; ROTARY: SET A TO 180° - TURN THE BAR ABOUT ITS AXIS - BEFORE RUNNING'), `${shapeName}, no rotary axis: slice 2's instruction`)
      assert(plain.includes('; ROTARY: RETRACT THE SPINDLE CLEAR OF THE BAR BEFORE TURNING A'), `${shapeName}, no rotary axis: slice 2's retract line`)
      assert(!plain.includes('RETRACTS TO MACHINE Z TOP'), `${shapeName}, no rotary axis: no program-turn comment`)
      assert(!/(^|\s)A[-+]?\d/.test(programWithoutComments(plain, 'gcode')), `${shapeName}, no rotary axis: no A word`)
    }
  }

  // The machine Safe Z is a machine coordinate: 0 is the top of travel in
  // either unit, and the angle still uses the program's own precision.
  const inchBase = newProject('Inch Bar', 'inch')
  inchBase.stock = roundStock(2, 8, 'x')
  const inchBounds = getStockBounds(inchBase.stock)
  inchBase.origin = {
    name: 'Origin',
    x: inchBounds.minX,
    y: (inchBounds.minY + inchBounds.maxY) / 2,
    z: inchBase.stock.thickness,
    visible: true,
  }
  inchBase.tools = [{ ...defaultTool('inch', 1), id: 't1', name: 'Tool 1' }]
  const inchProject = syncProjectSetups({
    ...inchBase,
    meta: { ...inchBase.meta, projectType: 'rotary' },
    operations: [makeOperation('rough', 'Rough')],
  })
  const inchMoves: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 0, y: 1, z: 2.5 }, to: { x: 1, y: 1, z: 2.5 } },
    { kind: 'plunge', from: { x: 1, y: 1, z: 2.5 }, to: { x: 1, y: 1, z: 1.5 } },
    { kind: 'cut', from: { x: 1, y: 1, z: 1.5 }, to: { x: 3, y: 1, z: 1.5 } },
    { kind: 'rapid', from: { x: 3, y: 1, z: 1.5 }, to: { x: 3, y: 1, z: 2.5 } },
  ]
  const inchProgram = post(inchProject, ['rough'], rotaryMachine('x', 'own'), inchMoves).gcode
  assert(inchProgram.includes('\nG53 G0 Z0.0000\nG0 A0.0000\n'), 'inch: machine Z top is 0 in either unit; the angle keeps the program precision')
}

/**
 * Finding 1 (#1054 fix 1): the opening retract and turn must follow the first
 * operation's tool change and its length compensation. LinuxCNC's header
 * cancels tool length with `G49`, so a retract written before `M6`/`G43` is
 * measured with no compensation and cannot establish tip clearance. The
 * alternative — a `G53` machine-coordinate retract — cannot be written: the
 * emitter works in the work coordinate system and knows no machine zero.
 */
function testManualIndexTurnFollowsToolLengthCompensation(): void {
  console.log('Testing the opening turn follows the tool change and G43...')
  const project = rotaryBarProject('x')
  const two = withBottomSetup(project, { axis: 'x', operationIds: ['under'] })
  const definition = validateMachineDefinition({
    ...structuredClone(LINUXCNC),
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  // The 20 mm round bar's travel height is 21 mm; the origin is its top at 20,
  // so the emitted retract is 1.000.
  for (const face of ['top', 'bottom'] as const) {
    const angle = face === 'bottom' ? 180 : 0
    const program = post(two, [face === 'top' ? 'rough' : 'under'], definition, barMoves('x', face)).gcode
    const lines = program.split('\n')
    const g49 = lines.findIndex((line) => /\bG49\b/.test(line))
    const m6 = lines.findIndex((line) => line.startsWith('M6 T1'))
    const g43 = lines.findIndex((line) => line.startsWith('G43 H1'))
    const retractAt = lines.indexOf('G0 Z1.000')
    const turnAt = lines.indexOf(`G0 A${angle.toFixed(3)}`)
    assert(g49 > 0 && g49 < m6, `${face}: the header cancels tool length before the change`)
    assert(m6 > 0 && g43 > m6, `${face}: the tool change applies its length compensation`)
    assert(g43 < retractAt, `${face}: the retract is written after G43, with the length applied`)
    assertEqual([lines[retractAt], lines[retractAt + 1]], ['G0 Z1.000', `G0 A${angle.toFixed(3)}`], `${face}: retract, then turn`)
    assert(
      !lines.slice(0, retractAt).some((line) => /(^|\s)A[-+]?\d/.test(line)),
      `${face}: no A word is written before the length compensation`,
    )
    assert(/^Z|^X|^G[0-3]/.test(lines[turnAt + 2]), `${face}: the operation's own motion follows the turn`)
  }
}

/**
 * Finding 4 (#1054 fix 1): an automatic header turn about the bar's axis is
 * refused with `postRotaryAxisMismatch` when the machine's rotary is about the
 * other horizontal axis. Falling back to the comment-only header would post a
 * program that silently never turns the bar.
 */
function testManualIndexAxisMismatchIsRefused(): void {
  console.log('Testing a header turn on the wrong rotary axis is refused...')
  const xBar = rotaryBarProject('x')
  const refused = post(xBar, ['rough'], rotaryMachine('y', 'own'), barMoves('x', 'top'))
  assertEqual(refused.gcode, '', 'no program text: a comment-only header is not an acceptable fallback')
  assertEqual(refused.warnings, [{
    code: 'postRotaryAxisMismatch',
    params: { operation: 'Rough', machineAxis: 'Y', stockAxis: 'X' },
  }], 'the refusal names both axes')
  assertEqual(warningSeverity('postRotaryAxisMismatch'), 'error', 'as an error, which blocks the save')

  // The matching machine still posts the turn, and the same mismatch on a
  // machine whose operation carries its own angle is refused by the planner
  // (its own code path, unchanged).
  assert(post(xBar, ['rough'], rotaryMachine('x', 'own'), barMoves('x', 'top')).gcode.includes('G0 A0.000'), 'the matching axis still turns')
}

/**
 * Finding 3 (#1054 fix 1): the closing unwind judges clearance in project
 * space, not machine-signed coordinates. With `zAxis: '-Z'` a cut height is a
 * large positive machine Z, so comparing it raw against the negative travel
 * coordinate called it clear and unwound without retracting.
 */
function testInvertedZAxisUnwindRetracts(): void {
  console.log('Testing the closing unwind retracts on an inverted Z machine...')
  const project = rotaryBarProjectOf('square', 'x')
  const two = withBottomSetup(project, { axis: 'x', operationIds: ['under'] })
  const base = rotaryMachine('x', 'own')
  const inverted = validateMachineDefinition({
    ...base,
    coordinateSystem: { ...base.coordinateSystem, zAxis: '-Z' },
  })
  // The path ends at the cut height: no operation retract, so only the closing
  // unwind can establish clearance. GRBL applies no tool-length compensation,
  // so the retract is the definition's machine Safe Z (#1054 fix 3): a machine
  // coordinate, untouched by the inverted `-Z` transform and by the project's
  // origin (the default is 0, the top of travel).
  const moves = barMoves('x', 'bottom').slice(0, -1)
  const lines = post(two, ['under'], inverted, moves).gcode.split('\n')
  const safeZ = inverted.motion.machineSafeZ
  const unwindAt = lines.lastIndexOf('G0 A0.000')
  assert(unwindAt > 0, 'the program still unwinds the bar')
  assertEqual(lines[unwindAt - 1], `G53 G0 Z${safeZ.toFixed(3)}`, 'the unwind retracts to the machine Safe Z first')
  assertEqual(lines[unwindAt - 2], 'M5', 'after the spindle stop, before the turn')
}

/**
 * #1054 fix 2/fix 3: a single-tool Top or Bottom program with tool changes
 * disabled has no tool-length compensation, so the opening and closing
 * bar-clearance retract cannot be a work-coordinate `G0 Z<travel>`: that Z no
 * longer describes the tip. Every bundled rotary-capable dialect must retract
 * in machine coordinates to the definition's own Safe Z instead, and a machine
 * with no machine-coordinate move must refuse the turn.
 */
function testManualIndexTurnWithoutCompensation(): void {
  console.log('Testing the bar turn without tool-length compensation...')
  const project = rotaryBarProject('x')
  const two = withBottomSetup(project, { axis: 'x', operationIds: ['under'] })
  const rotary: RotaryDefinition = {
    about: 'x',
    drive: 'own',
    reversed: false,
    inverseTimeFeed: { on: 'G93', off: 'G94' },
  }
  const rotaryMachineOf = (
    base: MachineDefinition,
    overrides: Partial<MachineDefinition['motion']> = {},
  ): MachineDefinition => validateMachineDefinition({
    ...structuredClone(base),
    rotary,
    motion: { ...structuredClone(base.motion), ...overrides },
  })

  for (const id of ['linuxcnc', 'grbl', 'grblhal', 'mach3', 'uccnc', 'generic']) {
    const definition = rotaryMachineOf(bundled(id))
    const label = `${definition.name} without tool changes`
    for (const face of ['top', 'bottom'] as const) {
      const operation = face === 'top' ? 'rough' : 'under'
      const result = post(two, [operation], definition, barMoves('x', face), false)
      assertEqual(
        result.warnings.filter((warning) => warningSeverity(warning.code) === 'error'),
        [],
        `${label}, ${face}: no refusal`,
      )
      const lines = result.gcode.split('\n').map((line) => line.replace(/^N\d+\s+/, ''))
      const angle = formatGCodeNumber(face === 'bottom' ? 180 : 0, definition, two.meta.units)
      const turnAt = lines.indexOf(`G0 A${angle}`)
      const safeLine = `G53 G0 Z${formatGCodeNumber(definition.motion.machineSafeZ, definition, two.meta.units)}`
      assert(turnAt > 0, `${label}, ${face}: the turn is posted\n${result.gcode}`)
      assertEqual(lines[turnAt - 1], safeLine, `${label}, ${face}: machine-coordinate Safe Z before the turn`)
      assert(
        !lines.slice(0, turnAt).some((line) => /^G43\b/.test(line)),
        `${label}, ${face}: no compensation is claimed`,
      )
      if (face === 'bottom') {
        const unwindAt = lines.findLastIndex((line) => line === `G0 A${formatGCodeNumber(0, definition, two.meta.units)}`)
        assert(unwindAt > turnAt, `${label}, ${face}: the closing unwind is posted`)
        assertEqual(
          lines[unwindAt - 1],
          safeLine,
          `${label}, ${face}: machine-coordinate Safe Z before the closing unwind`,
        )
      }
    }
  }

  // With tool changes enabled, LinuxCNC/Mach3/UCCNC apply G43 and keep the
  // historical work-coordinate retract: the compensated path is unchanged.
  for (const id of ['linuxcnc', 'mach3', 'uccnc']) {
    const definition = rotaryMachineOf(bundled(id))
    const lines = post(two, ['under'], definition, barMoves('x', 'bottom')).gcode.split('\n').map((line) => line.replace(/^N\d+\s+/, ''))
    const turnAt = lines.indexOf(`G0 A${formatGCodeNumber(180, definition, two.meta.units)}`)
    assert(turnAt > 0, `${definition.name}: the turn is posted with tool changes on`)
    assert(lines.slice(0, turnAt).some((line) => /^G43\b/.test(line)), `${definition.name}: G43 is applied`)
    assertEqual(
      lines[turnAt - 1],
      `G0 Z${formatGCodeNumber(1, definition, two.meta.units)}`,
      `${definition.name}: the work-coordinate retract is unchanged`,
    )
  }

  // A tool change that applies and then cancels compensation is the same as no
  // compensation: the retract must not trust the cancelled work-coordinate Z.
  const cancellingBase = bundled('linuxcnc')
  const cancelling = validateMachineDefinition({
    ...structuredClone(cancellingBase),
    rotary,
    toolChange: {
      ...structuredClone(cancellingBase.toolChange),
      commands: ['M5', 'M6 T{toolNumber}', 'G43 H{toolNumber}', 'G49'],
    },
  })
  const cancelled = post(two, ['under'], cancelling, barMoves('x', 'bottom')).gcode.split('\n').map((line) => line.replace(/^N\d+\s+/, ''))
  const cancelledTurn = cancelled.indexOf(`G0 A${formatGCodeNumber(180, cancelling, two.meta.units)}`)
  assert(cancelledTurn > 0, 'a cancelled compensation still turns')
  assertEqual(
    cancelled[cancelledTurn - 1],
    `G53 G0 Z${formatGCodeNumber(cancelling.motion.machineSafeZ, cancelling, two.meta.units)}`,
    'the retract follows the cancellation, not G43',
  )

  // A machine with no machine-coordinate move and no compensation is refused
  // rather than turned. `machineCoordinateCommand: null` declares no G53.
  const noMachineMove = rotaryMachineOf(bundled('grbl'), { machineCoordinateCommand: null })
  const refused = post(two, ['under'], noMachineMove, barMoves('x', 'bottom'), false)
  assertEqual(refused.gcode, '', 'no program text is posted')
  assertEqual(refused.warnings, [{ code: 'postRotaryTurnWithoutClearance', params: { operation: 'Under' } }], 'the refusal names the operation')
  assertEqual(warningSeverity('postRotaryTurnWithoutClearance'), 'error', 'as an error, which blocks the save')

  // The same machine with compensation active needs no machine move: the
  // work-coordinate retract is still valid.
  const compensated = validateMachineDefinition({
    ...structuredClone(cancelling),
    motion: { ...structuredClone(cancelling.motion), machineCoordinateCommand: null },
    toolChange: {
      ...structuredClone(cancelling.toolChange),
      commands: ['M5', 'M6 T{toolNumber}', 'G43 H{toolNumber}'],
    },
  })
  const compensatedLines = post(two, ['under'], compensated, barMoves('x', 'bottom')).gcode.split('\n').map((line) => line.replace(/^N\d+\s+/, ''))
  const compensatedTurn = compensatedLines.indexOf(`G0 A${formatGCodeNumber(180, compensated, two.meta.units)}`)
  assert(compensatedTurn > 0, 'compensation alone is enough to turn')
  assertEqual(
    compensatedLines[compensatedTurn - 1],
    `G0 Z${formatGCodeNumber(1, compensated, two.meta.units)}`,
    'the work-coordinate retract is used',
  )

  // ShopBot part files are not G-code and cannot carry a rotary axis, so no
  // bundled ShopBot definition reaches this turn. The schema says so.
  let shopbotRefused = false
  try {
    validateMachineDefinition({ ...structuredClone(SHOPBOT), rotary })
  } catch {
    shopbotRefused = true
  }
  assert(shopbotRefused, 'ShopBot SBP cannot be given a rotary axis')
}

/**
 * #1054 fix 3: the G53 retract height is a machine coordinate the definition
 * states, never one derived from the project. The default 0 is the top of
 * travel after homing; a project's origin, units and Safe Z do not change it.
 * Mutation checked: deriving the height from the project's Safe Z again (the
 * fix-2 behaviour) makes the custom-height assertions fail.
 */
function testMachineSafeZIsAMachineCoordinate(): void {
  console.log("Testing the G53 retract height is the definition's machine Safe Z...")
  const base = withBottomSetup(rotaryBarProject('x'), { axis: 'x', operationIds: ['under'] })
  const grbl = rotaryMachine('x', 'own')
  assertEqual(grbl.motion.machineSafeZ, 0, 'a definition that states nothing defaults to 0, the top of travel')
  const retractLine = (
    project: Project,
    definition: MachineDefinition,
    operationIds: string[] = ['under'],
    moves: ToolpathMove[] = barMoves('x', 'bottom'),
  ): string => {
    const line = post(project, operationIds, definition, moves).gcode
      .split('\n')
      .find((entry) => entry.startsWith('G53 G0 Z'))
    assert(line !== undefined, 'the program carries the machine-coordinate retract')
    return line
  }
  const custom = validateMachineDefinition({
    ...structuredClone(grbl),
    motion: { ...structuredClone(grbl.motion), machineSafeZ: -12.5 },
  })
  const movedOrigin: Project = { ...base, origin: { ...base.origin, z: base.origin.z + 100 } }
  const highCeiling: Project = { ...base, meta: { ...base.meta, maxTravelZ: 500 } }
  for (const [label, project] of [
    ['the fixture', base],
    ['an origin 100 mm higher', movedOrigin],
    ['a 500 mm project Safe Z', highCeiling],
  ] as const) {
    assertEqual(
      retractLine(project, custom),
      'G53 G0 Z-12.500',
      `${label}: the definition's height, not a project value`,
    )
  }

  // Inch projects read the same machine coordinate: the top is 0 in either
  // unit, and a stated height is written in the program's own precision.
  const inchBase = newProject('Inch Bar', 'inch')
  inchBase.stock = roundStock(2, 8, 'x')
  const inchBounds = getStockBounds(inchBase.stock)
  inchBase.origin = {
    name: 'Origin',
    x: inchBounds.minX,
    y: (inchBounds.minY + inchBounds.maxY) / 2,
    z: inchBase.stock.thickness,
    visible: true,
  }
  inchBase.tools = [{ ...defaultTool('inch', 1), id: 't1', name: 'Tool 1' }]
  const inchProject = syncProjectSetups({
    ...inchBase,
    meta: { ...inchBase.meta, projectType: 'rotary' },
    operations: [makeOperation('rough', 'Rough')],
  })
  assertEqual(
    retractLine(inchProject, grbl, ['rough'], barMoves('x', 'top')),
    'G53 G0 Z0.0000',
    'inch: the machine Z top is 0, in the program precision',
  )
  assertEqual(
    retractLine(inchProject, custom, ['rough'], barMoves('x', 'top')),
    'G53 G0 Z-12.5000',
    'inch: a stated machine height is read in the program units',
  )
}

function normalizedProgram(program: string): string {
  return program.replace(/Generated by PureCutCNC on \d{4}-\d{2}-\d{2}/g, 'Generated by PureCutCNC on <date>')
}

function programHash(project: Project, operationIds: string[], definition: MachineDefinition): string {
  return createHash('sha256').update(normalizedProgram(post(project, operationIds, definition).gcode)).digest('hex')
}

function testFlatAndAroundProgramsAreUnchanged(): void {
  console.log('Testing flat and Around programs are byte-identical to the base...')
  // A milling project with a Top and a Bottom setup: no bar, so no A lines
  // and no flip-axis warning may appear.
  const mill = withBottomSetup(singleSetupProject(), { axis: 'x', operationIds: ['under'] })
  assertEqual(programHash(mill, ['rough', 'drill', 'finish'], GRBL), '3179263c634d8ec1e764a3faf8eefe2c9a444838ca729170cf728c1f775a0f1f', 'milling Top program, G-code')
  assertEqual(programHash(mill, ['under'], GRBL), '2b99f3defc62a11888f6ecfea359a152968c8c443848a388e75da4ba2c29f6be', 'milling Bottom program, G-code')
  assertEqual(programHash(mill, ['rough', 'drill', 'finish'], SHOPBOT), '5c83729c6b52fb60dad0c95a903cdaa6bf41a6a1f30f89a81c89b167e6f31c14', 'milling Top program, SBP')
  assertEqual(programHash(mill, ['under'], SHOPBOT), '4e7a863ac3499b84d95a6c6502537582dc11908575d29e75ca2da2f49bb8eca4', 'milling Bottom program, SBP')

  // An Around program keeps its own header, and is not given the Top/Bottom
  // A lines.
  const base = newProject('Around Bar', 'mm')
  base.stock = roundStock(20, 100, 'x')
  base.meta.projectType = 'rotary'
  base.origin = { name: 'Origin', x: 0, y: 10, z: 20, visible: true }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Tool 1' }]
  const aroundSetup: MachiningSetup = {
    ...base.setups[0],
    id: 'around',
    name: 'Around',
    kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  }
  const aroundProject = syncProjectSetups({
    ...base,
    setups: [aroundSetup],
    activeSetupId: aroundSetup.id,
    operations: [makeOperation('pocket', 'Pocket', { setupId: aroundSetup.id })],
  })
  const aroundPosted = post(aroundProject, ['pocket'], GRBL).gcode
  assertEqual(
    createHash('sha256').update(normalizedProgram(aroundPosted)).digest('hex'),
    '3ad70b17d2b26498020109b5cb8c04657a756202ad9af8fd30e544905dd8a84e',
    'Around program, G-code',
  )
  assert(!aroundPosted.includes('ROTARY: SET A'), 'an Around program is not given a Top/Bottom A line')
  assert(aroundPosted.includes('; SETUP 01: Around - AROUND THE BAR, BAR ALONG X'), 'and keeps its own header')
}

testSingleSetupIsNotSplit()
testTwoSetupsAreSplit()
testTouchOff()
testHeaderLines()
testProgramHeaderInBothDialects()
testSingleSetupProgramIsUnchanged()
testWhatAProgramMayNotBe()
testManualIndexingOnARotaryBar()
testBottomFlipAxisWarning()
testManualIndexTurnsTheBarItself()
testManualIndexTurnFollowsToolLengthCompensation()
testManualIndexTurnWithoutCompensation()
testMachineSafeZIsAMachineCoordinate()
testManualIndexAxisMismatchIsRefused()
testInvertedZAxisUnwindRetracts()
testFlatAndAroundProgramsAreUnchanged()

console.log('setup program tests passed')
