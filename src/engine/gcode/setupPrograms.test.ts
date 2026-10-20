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
 * the A lines → the byte-identical baselines fail.
 *
 * Run with: npx tsx src/engine/gcode/setupPrograms.test.ts
 */

import { createHash } from 'node:crypto'
import { circleProfile, defaultTool, getStockBounds, newProject, rectProfile, roundStock } from '../../types/project'
import type { MachineOrigin, MachiningSetup, Operation, Project, SketchFeature } from '../../types/project'
import { suggestGcodeFileName } from '../../components/export/exportOperationSelection'
import { BOTTOM_SETUP_ID, projectWithFeatures, withBottomSetup, withoutSetupFields } from '../../test/projectFixtures'
import { syncProjectSetups } from '../../store/helpers/setups'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathMove, ToolpathResult } from '../toolpaths/types'
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
import type { MachineDefinition, PostProcessorResult } from './types'

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

function post(project: Project, operationIds: string[], definition: MachineDefinition): PostProcessorResult {
  const tool = normalizeToolForProject(project.tools[0], project)
  return runPostProcessor({
    project,
    definition,
    operations: operationIds.map((id) => {
      const operation = project.operations.find((entry) => entry.id === id)!
      const toolpath: ToolpathResult = { operationId: id, warnings: [], bounds: null, moves: MOVES }
      return { operation, tool, toolpath }
    }),
    options: { emitToolChanges: true, emitCoolant: false },
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
  assertEqual(planProgramSetup({ project, operations: [], definition: GRBL }), { headerComments: [], warnings: [] }, 'and plans nothing')
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

/** A rotary project on a 20 mm round bar along `axis`, with the flat fixture's operations. */
function rotaryBarProject(axis: 'x' | 'y' = 'x'): Project {
  const project = singleSetupProject()
  const bar = roundStock(20, 100, axis)
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

/**
 * The posted text of the work these changes must not touch, captured from the
 * base commit before #1054 slice 2. Only the generated-date line is
 * normalised; geometry, feeds, wording and comments are exact.
 */
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
testFlatAndAroundProgramsAreUnchanged()

console.log('setup program tests passed')
