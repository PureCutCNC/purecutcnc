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
 * Issue #1112, item 24: a new project takes the template's project type.
 *
 * Frank: "if I choose a rotary project as a template, then the new project
 * should be also rotary and import the chuck and stock definition". The same
 * for plasma and milling: a template brings its own type, its stock, its chuck
 * and the machine setup the template has. Only the blank template takes the
 * dialog's type tiles.
 *
 * Every creation goes through the store (`createNewProject`), because that is
 * the path the dialog takes — a project is not "the chosen template" until the
 * store has instantiated and normalized it. The dialog's default type choice is
 * milling, and that is what the failing cases pass, so a template whose type
 * was overwritten cannot pass by accident.
 *
 * Run with: NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/project/newProjectTemplate.test.ts
 */

import assert from 'node:assert/strict'
import { BUNDLED_DEFINITIONS } from '../../engine/gcode/definitions'
import { validateMachineDefinition } from '../../engine/gcode/types'
import type { MachineDefinition } from '../../engine/gcode/types'
import { useProjectStore } from '../../store/projectStore'
import { barCentre, barPivotZ, normalizeSquareStock, squareStock } from '../../types/barStock'
import type { BarStock } from '../../types/project'
import {
  defaultOrigin,
  defaultStock,
  newProject,
  normalizeRoundStock,
  roundStock,
  type Clamp,
  type Project,
  type Stock,
} from '../../types/project'
import { blankTemplateProject } from './newProjectStock'
import {
  isBlankTemplateKind,
  newProjectType,
  setupOnlyTemplate,
  templateChosenProject,
} from './newProjectTemplate'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   \u2713 ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   \u2717 ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── Fixtures ──────────────────────────────────────────────────

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(found, `bundled definition ${id} exists`)
  return validateMachineDefinition(structuredClone(found))
}

/** The bundled generic router plus a rotary block — the machine a rotary template carries. */
function rotaryRouter(): MachineDefinition {
  return validateMachineDefinition({
    ...bundled('generic'),
    id: 'template-rotary-router',
    name: 'Template rotary router',
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

const PLAIN_ROUTER = validateMachineDefinition({ ...bundled('generic'), id: 'template-router', name: 'Template router' })
const QTPLASMAC = bundled('qtplasmac')

/**
 * The chuck a rotary template carries: hand-set equipment (the 8 inch preset,
 * four jaws, an explicit clamping range) at a placement the new project must
 * keep. Nothing here is what `newChuck` would mint for these bars.
 *
 * The placement is the one the project's own workholding sync settles on — the
 * body centred on the bar's centreline with its height off the bar's pivot
 * (`syncRoundWorkholding`), the body width along the axis left where it was put
 * — so a chuck that is carried verbatim stays exactly these numbers instead of
 * being re-derived into them.
 */
function templateChuck(stock: BarStock): Clamp {
  const across = 34
  const along = 30
  const acrossStart = barCentre(stock) - across / 2
  const height = barPivotZ(stock) + across / 2
  return {
    id: 'cl-template-chuck',
    name: 'Bison 8 in four-jaw',
    type: 'chuck',
    chuck: {
      size: 'bison-3204-8',
      jawCount: 4,
      clampingRangeMm: { min: 62, max: 200 },
      manual: true,
    },
    ...(stock.axis === 'x'
      ? { x: 2, y: acrossStart, w: along, h: across }
      : { x: acrossStart, y: 2, w: across, h: along }),
    height,
    visible: true,
  }
}

/** A rotary template: the type, a bar, its origin, its chuck and a rotary machine. */
function rotaryTemplate(units: 'mm' | 'inch', shape: 'round' | 'square', axis: 'x' | 'y' = 'x'): Project {
  const base = newProject('Rotary template', units)
  const size = units === 'mm' ? 30 : 1.25
  const length = units === 'mm' ? 160 : 6
  const stock: Stock = shape === 'square'
    ? normalizeSquareStock(squareStock(size, length, axis))
    : normalizeRoundStock(roundStock(size, length, axis))
  const machine = rotaryRouter()
  return {
    ...base,
    meta: { ...base.meta, projectType: 'rotary', machineDefinitions: [machine], selectedMachineId: machine.id },
    stock,
    origin: defaultOrigin(stock),
    clamps: [templateChuck(stock)],
  }
}

/** A plasma template: the type, a sheet and the plasma machine it comes with. */
function plasmaTemplate(): Project {
  const base = newProject('Plasma template', 'mm')
  const stock = defaultStock(600, 400, 3)
  return {
    ...base,
    meta: { ...base.meta, projectType: 'plasma', machineDefinitions: [QTPLASMAC], selectedMachineId: QTPLASMAC.id },
    stock,
    origin: defaultOrigin(stock),
  }
}

/** A milling template: the type, a block and a plain router. */
function millingTemplate(): Project {
  const base = newProject('Milling template', 'inch')
  const stock = defaultStock(undefined, undefined, undefined, 'inch')
  return {
    ...base,
    meta: { ...base.meta, projectType: 'milling', machineDefinitions: [PLAIN_ROUTER], selectedMachineId: PLAIN_ROUTER.id },
    stock,
    origin: defaultOrigin(stock),
  }
}

/** The template without the stored type, as a file that predates the field carries it. */
function withoutStoredType(template: Project): Project {
  const clone = structuredClone(template)
  delete (clone.meta as unknown as Record<string, unknown>).projectType
  return clone
}

/** The project the store ends up with, created from `template` — the dialog's own path. */
function createdFrom(template: Project, kind: 'current' | 'file', choice: 'milling' | 'plasma' | 'rotary'): Project {
  useProjectStore.getState().createNewProject(templateChosenProject(kind, template, choice, []), 'From template')
  return useProjectStore.getState().project
}

/** The stock a created project carries, without the load-time `sourceFeature` placeholder. */
function storedStock(stock: Stock): Stock {
  const { sourceFeature: _source, ...rest } = stock
  return rest as Stock
}

/** A clamp without its id, which a store round-trip may regenerate. */
function withoutId(clamp: Clamp): Omit<Clamp, 'id'> {
  const { id: _id, ...rest } = clamp
  return rest
}

const BLOCK_DRAFT = { width: '100', height: '80', thickness: '20' }
const BAR_DRAFT = { shape: 'round' as const, size: '40', length: '200', axis: 'x' as const }

// ── The rotary template ───────────────────────────────────────

test('a rotary template — round and square, mm and inch — creates a rotary project with its stock', () => {
  for (const units of ['mm', 'inch'] as const) {
    for (const shape of ['round', 'square'] as const) {
      const template = rotaryTemplate(units, shape)
      // The dialog's default choice is milling; the template's type has to win.
      const project = createdFrom(template, 'file', 'milling')
      const label = `${units} ${shape}`
      assert.equal(project.meta.projectType, 'rotary', `${label}: the template's type, not the dialog's`)
      assert.equal(project.meta.units, units, `${label}: the template's units`)
      assert.deepEqual(storedStock(project.stock), template.stock, `${label}: the template's stock, shape and axis included`)
      assert.deepEqual(project.origin, template.origin, `${label}: the bar's own origin`)
      assert.equal(project.meta.selectedMachineId, 'template-rotary-router', `${label}: the template's rotary machine`)
    }
  }
})

test('a rotary template brings its chuck — size, jaw count, clamping range and placement', () => {
  for (const units of ['mm', 'inch'] as const) {
    for (const shape of ['round', 'square'] as const) {
      for (const axis of ['x', 'y'] as const) {
        const template = rotaryTemplate(units, shape, axis)
        const project = createdFrom(template, 'current', 'milling')
        const label = `${units} ${shape} ${axis}`
        assert.equal(project.clamps.length, 1, `${label}: the template's one chuck, not a minted starter and not none`)
        assert.deepEqual(withoutId(project.clamps[0]), withoutId(template.clamps[0]), `${label}: the template's chuck exactly`)
        assert.equal(project.clamps[0].chuck?.manual, true, `${label}: still marked as hand-set equipment`)
        assert.equal(project.clamps[0].chuck?.jawCount, 4, `${label}: the template's four jaws, not the shape's default`)
        assert.deepEqual(project.clamps[0].chuck?.clampingRangeMm, { min: 62, max: 200 }, `${label}: the typed clamping range`)
      }
    }
  }
})

test('the current project and a template file take the same route', () => {
  const template = rotaryTemplate('inch', 'square')
  const fromCurrent = createdFrom(template, 'current', 'plasma')
  const fromFile = createdFrom(template, 'file', 'plasma')
  assert.equal(fromCurrent.meta.projectType, 'rotary', 'the open rotary project keeps its type')
  assert.equal(fromFile.meta.projectType, 'rotary', 'the same project as a file keeps its type')
  assert.deepEqual(storedStock(fromCurrent.stock), template.stock, 'the current project route keeps the bar')
  assert.deepEqual(storedStock(fromFile.stock), template.stock, 'the file route keeps the bar')
  assert.deepEqual(withoutId(fromCurrent.clamps[0]), withoutId(template.clamps[0]), 'the current project route keeps the chuck')
  assert.deepEqual(withoutId(fromFile.clamps[0]), withoutId(template.clamps[0]), 'the file route keeps the chuck')
})

// ── Every other type takes its own ────────────────────────────

test('a plasma template creates a plasma project with its sheet and plasma machine', () => {
  const template = plasmaTemplate()
  const project = createdFrom(template, 'file', 'milling')
  assert.equal(project.meta.projectType, 'plasma', 'the template type, not the dialog default')
  assert.deepEqual(storedStock(project.stock), template.stock, 'the template sheet, not a converted one')
  assert.equal(project.meta.selectedMachineId, QTPLASMAC.id, 'the template plasma machine, not a router')
  assert.deepEqual(project.meta.machineDefinitions, template.meta.machineDefinitions, 'the plasma settings as the template has them')
  assert.equal(project.clamps.length, 0, 'a sheet has no workholding')
})

test('a milling template creates a milling project with its block and router', () => {
  const template = millingTemplate()
  const project = createdFrom(template, 'current', 'plasma')
  assert.equal(project.meta.projectType, 'milling', 'the template type, not the dialog tiles')
  assert.deepEqual(storedStock(project.stock), template.stock, 'the template block')
  assert.equal(project.meta.units, 'inch', 'the template units')
  assert.equal(project.meta.selectedMachineId, PLAIN_ROUTER.id, 'the template router')
})

test('only the blank template takes the dialog type', () => {
  for (const kind of ['blank_metric', 'blank_imperial'] as const) {
    assert.equal(isBlankTemplateKind(kind), true, `${kind} is a blank template`)
    for (const choice of ['milling', 'plasma', 'rotary'] as const) {
      assert.equal(newProjectType(kind, choice, rotaryTemplate('mm', 'round')), choice,
        `${kind}: the tiles' ${choice} wins even with a rotary template-like project in hand`)
    }
  }
  for (const kind of ['current', 'file'] as const) {
    assert.equal(isBlankTemplateKind(kind), false, `${kind} is not a blank template`)
  }

  // End to end, on the blank path the dialog uses: a rotary blank is rotary,
  // and a plasma blank is plasma, whatever the project in hand is.
  const rotaryBlank = blankTemplateProject(newProject('Untitled', 'mm'), 'rotary', [], BLOCK_DRAFT, BAR_DRAFT)
  assert.ok(rotaryBlank, 'the rotary blank is valid')
  useProjectStore.getState().createNewProject(rotaryBlank, 'Blank rotary')
  assert.equal(useProjectStore.getState().project.meta.projectType, 'rotary', 'the blank rotary project is rotary')

  const plasmaBlank = blankTemplateProject(newProject('Untitled', 'mm'), 'plasma', [], BLOCK_DRAFT, BAR_DRAFT)
  assert.ok(plasmaBlank, 'the plasma blank is valid')
  useProjectStore.getState().createNewProject(plasmaBlank, 'Blank plasma')
  assert.equal(useProjectStore.getState().project.meta.projectType, 'plasma', 'the blank plasma project is plasma')
})

test('a template file with no stored type takes the type its machine and stock imply', () => {
  const legacyRotary = withoutStoredType(rotaryTemplate('mm', 'round'))
  assert.equal(newProjectType('file', 'milling', legacyRotary), 'rotary', 'a bar plus a rotary router reads as rotary')
  assert.equal(createdFrom(legacyRotary, 'file', 'milling').meta.projectType, 'rotary', 'and the created project stores it')

  const legacyPlasma = withoutStoredType(plasmaTemplate())
  assert.equal(newProjectType('file', 'milling', legacyPlasma), 'plasma', 'a plasma machine reads as plasma')
  assert.equal(createdFrom(legacyPlasma, 'file', 'milling').meta.projectType, 'plasma', 'and the created project stores it')
})

// ── The template stripped to its setup ────────────────────────

test('a template keeps its setup and its chuck and drops everything else', () => {
  const template = rotaryTemplate('mm', 'round')
  const withOrdinaryClamp: Project = {
    ...template,
    clamps: [template.clamps[0], { id: 'cl-step', name: 'Step clamp', type: 'step_clamp', x: 0, y: 0, w: 20, h: 10, height: 12, visible: true }],
  }
  const setup = setupOnlyTemplate(withOrdinaryClamp)
  assert.deepEqual(storedStock(setup.stock), template.stock, 'the stock is part of the setup')
  assert.deepEqual(setup.origin, template.origin, 'so is the origin')
  assert.equal(setup.meta.projectType, 'rotary', 'and the stored type')
  assert.equal(setup.meta.selectedMachineId, 'template-rotary-router', 'and the machine snapshot')
  assert.equal(setup.clamps.length, 1, 'the chuck comes along')
  assert.equal(setup.clamps[0].type, 'chuck', 'and it is the chuck, not the ordinary clamp')
  assert.deepEqual(setup.features, [], 'geometry is not part of a template')
  assert.deepEqual(setup.operations, [], 'nor are operations')
})

test('a chuck on a block template is not carried, and a bar template without one still gets one', () => {
  const blockWithChuck = { ...millingTemplate(), clamps: [rotaryTemplate('mm', 'round').clamps[0]] }
  const fromBlock = createdFrom(blockWithChuck, 'file', 'milling')
  assert.equal(fromBlock.clamps.length, 0, 'a block has no workholding, so a stale chuck is dropped')

  const bareBar = { ...rotaryTemplate('mm', 'square'), clamps: [] }
  const fromBar = createdFrom(bareBar, 'file', 'milling')
  assert.equal(fromBar.clamps.length, 1, 'a bar cannot start without its chuck')
  assert.equal(fromBar.clamps[0].type, 'chuck', 'the minted clamp is a chuck')
})

console.log(`\nNew project template: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  throw new Error(`${failed} new project template test(s) failed`)
}
