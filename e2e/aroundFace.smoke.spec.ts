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
 * The Around face in the workspace (issue #395, slice D1): the face switch on
 * a round bar, its switch tooltip, the Around tree layer and chip, Top-style Z
 * properties with no face change, the CAM "Around operations" section and an
 * Around operation that generates, the export program card, and Print
 * disabled on Around.
 *
 * Issue #1034 slice B pins the authoring rule on top of that: the **project
 * type and the round bar** decide whether Around can be entered, and the
 * selected machine decides nothing about it. A no-machine, plain-router,
 * plasma, matching and opposite-axis rotary bar all author, select, edit and
 * keep Around work — and the export boundary still refuses a missing or
 * incompatible machine.
 *
 * Deliberately not covered here: the Sketch canvas, the 3D view and the
 * Simulation tab — those are separate slices.
 *
 * NOTE: the #395 part of this spec was added without a browser run (slice D1
 * worker); the #1034 matrix below was added without one too.
 */

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { defaultTool, newProject, roundStock, roundStockCentre, type Project } from '../src/types/project'
import {
  cancelPendingAdd,
  getProject,
  placePendingAddAt,
  seedProject,
  selectFeatures,
  selectMachine,
  setPendingAddAnchor,
  startAddRectPlacement,
} from './helpers'

interface SavedFeature {
  id: string
  authoringFace?: string
  definitionId: string
  operation?: string
  z_top?: number
  z_bottom?: number
}

interface SavedSetup {
  id: string
  kind?: string
}

interface SavedProject {
  features: SavedFeature[]
  featureDefinitions: Record<string, { operation?: string }>
  setups: SavedSetup[]
  activeSetupId: string
  operations: Array<{ id: string; kind: string; setupId?: string }>
}

type FixtureMachine = Project['meta']['machineDefinitions'][number]

// Read as files: importing the machine registry would pull JSON imports into
// the Playwright runner, which Node refuses without an attribute.
const GRBL = JSON.parse(
  readFileSync(new URL('../src/engine/gcode/definitions/grbl.json', import.meta.url), 'utf8'),
) as FixtureMachine

const QTPLASMAC = JSON.parse(
  readFileSync(new URL('../src/engine/gcode/definitions/qtplasmac.json', import.meta.url), 'utf8'),
) as FixtureMachine

/** The fixture bar: 120 long, Ø25 (issue #395). */
const BAR = roundStock(25, 120, 'x')

/** The inch fixture bar: 5 long, Ø1 — the same shape in the other unit. */
const INCH_BAR = roundStock(1, 5, 'x')

/**
 * The frame's zero line for the fixture bar, its centreline across
 * (issue #1026). The rectangles below are placed relative to it, so they keep
 * the angles they were authored at now the sheet is centred on it.
 */
const ZERO = roundStockCentre(BAR)
const INCH_ZERO = roundStockCentre(INCH_BAR)

/** Every machine a rotary bar is authored against (issue #1034). */
type AroundMachine = 'none' | 'plain' | 'plasma' | 'rotary-x' | 'rotary-y'

const AROUND_MACHINES: readonly AroundMachine[] = ['none', 'plain', 'plasma', 'rotary-x', 'rotary-y']

/**
 * One machine snapshot, named distinctly so the machine picker can select a
 * different one by name without colliding with a bundled definition.
 */
function fixtureMachine(machine: AroundMachine): FixtureMachine[] {
  if (machine === 'none') return []
  if (machine === 'plasma') {
    return [{ ...QTPLASMAC, id: 'e2e-around-plasma', name: 'E2E Around Plasma', builtin: false }]
  }
  if (machine === 'plain') {
    return [{ ...GRBL, id: 'e2e-around-router', name: 'E2E Around Router', builtin: false }]
  }
  return [{
    ...GRBL,
    id: `e2e-around-${machine}`,
    name: machine === 'rotary-x' ? 'E2E Around Rotary X' : 'E2E Around Rotary Y',
    builtin: false,
    rotary: {
      about: machine === 'rotary-x' ? 'x' : 'y',
      drive: 'own',
      reversed: false,
      inverseTimeFeed: { on: 'G93', off: 'G94' },
    },
  }]
}

interface AroundFixtureOptions {
  machine?: AroundMachine
  units?: 'mm' | 'inch'
}

/**
 * A rotary project on a round bar with one of the machine snapshots above.
 * The machine is deliberately allowed to be absent, non-rotary, plasma or
 * across the bar: none of those may take the Around face away (issue #1034).
 */
function aroundProject({ machine = 'rotary-x', units = 'mm' }: AroundFixtureOptions = {}): Project {
  const base = newProject('Around smoke', units)
  const definitions = fixtureMachine(machine)
  base.stock = units === 'mm' ? BAR : INCH_BAR
  base.meta = {
    ...base.meta,
    // The Around face is a rotary project's (issue #1028); the machine below
    // decides nothing about whether the user may design on it (issue #1034).
    projectType: 'rotary',
    machineDefinitions: definitions,
    selectedMachineId: definitions[0]?.id ?? null,
  }
  base.tools = [{
    ...defaultTool(units, 1),
    id: 't1',
    diameter: units === 'mm' ? 3 : 0.125,
    maxCutDepth: units === 'mm' ? 20 : 1,
  }]
  return base
}

/** A cut into the bar's surface, in unrolled sheet coordinates, per unit. */
function fixtureRect(units: 'mm' | 'inch'): [number, number, number, number] {
  return units === 'mm'
    ? [10, ZERO + 5, 100, ZERO + 15]
    : [0.5, INCH_ZERO + 0.2, 4.5, INCH_ZERO + 0.6]
}

function featureRow(page: Page, id: string) {
  return page.locator(`.tree-row--feature[data-feature-id="${id}"]`)
}

/** Draw a rectangle in unrolled stock coordinates (the bar is 120 long, Ø25). */
async function drawRect(page: Page, x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await startAddRectPlacement(page)
  await setPendingAddAnchor(page, x1, y1)
  await placePendingAddAt(page, x2, y2)
  await cancelPendingAdd(page)
}

interface OperationReadout {
  moveCount: number
  warningCount: number
  allHaveAngle: boolean
}

/**
 * Compute one operation in the page, the way the 3D spec reads its paths: the
 * gear reading "up to date" is not proof that the Around operation produced
 * motion (issue #395 review).
 */
async function generatedOperation(page: Page, operationId: string): Promise<OperationReadout> {
  return page.evaluate(async (id) => {
    const storeUrl = '/src/store/projectStore.ts'
    const generateUrl = '/src/engine/toolpaths/generateOperation.ts'
    const { useProjectStore } = await import(storeUrl) as typeof import('../src/store/projectStore')
    const { computeOperationToolpath } = await import(generateUrl) as typeof import('../src/engine/toolpaths/generateOperation')
    const project = useProjectStore.getState().project
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new Error(`e2e: the project has no operation ${id}`)
    const envelope = computeOperationToolpath(project, operation)
    if (!envelope) throw new Error(`e2e: ${id} did not generate`)
    const points = envelope.result.moves.flatMap((move) => [move.from, move.to])
    return {
      moveCount: envelope.result.moves.length,
      warningCount: envelope.result.warnings.length,
      allHaveAngle: points.every((point) => typeof point.a === 'number'),
    }
  }, operationId)
}

test('a block stock shows exactly the switch it always had: no Around entry', async ({ app, ui }) => {
  const { page } = app
  // The default project is a block.
  await expect(ui.face.current(page)).toBeVisible()
  await ui.face.current(page).click()
  await expect(ui.face.item(page, 'Top')).toBeVisible()
  await expect(ui.face.item(page, 'Bottom')).toBeVisible()
  await expect(ui.face.item(page, 'Around')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

/**
 * Add the first Around pocket through the CAM Add menu and return its id: the
 * real authoring path the export tests need a program from.
 */
async function addAroundPocket(page: Page, ui: typeof import('./selectors')): Promise<string> {
  await ui.setupCam.add(page).click()
  await expect(ui.setupCam.addMenu(page)).toBeVisible()
  const pocketRow = ui.setupCam.addMenu(page)
    .locator('.cam-operation-item')
    .filter({ has: page.getByRole('button', { name: 'Pocket', exact: true }) })
  await pocketRow.getByRole('button', { name: 'Rough', exact: true }).click()
  await expect(ui.operations.rowByName(page, 'Pocket Rough')).toBeVisible()
  const project = await getProject(page) as unknown as SavedProject
  return project.operations[0].id
}

/** The authoring matrix: every machine, both units on the axis/unit edges. */
const AUTHORING_MATRIX: ReadonlyArray<{ machine: AroundMachine; units: 'mm' | 'inch' }> = [
  ...AROUND_MACHINES.map((machine) => ({ machine, units: 'mm' as const })),
  { machine: 'none', units: 'inch' },
  { machine: 'rotary-y', units: 'inch' },
]

test.describe('Around is authored by the project type and bar, never the machine (#1034)', () => {
  for (const { machine, units } of AUTHORING_MATRIX) {
    test(`a ${units} rotary bar with ${machine} authors, edits and keeps Around`, async ({ app, ui }) => {
      const { page } = app
      await seedProject(page, JSON.stringify(aroundProject({ machine, units })))

      // ── The Around entry is present and usable, whatever the machine is ──
      await ui.face.current(page).click()
      const around = ui.face.item(page, 'Around')
      await expect(around).toBeVisible()
      await expect(around).toBeEnabled()
      await expect(around).toHaveAttribute('title', /^The bar turns in the rotary\./)
      await around.click()
      await expect(ui.face.current(page)).toHaveAttribute('data-face', 'around')

      // ── Draw a cut: it lands on Around and its provisional setup becomes real ──
      await drawRect(page, ...fixtureRect(units))
      const drawn = await getProject(page) as unknown as SavedProject
      expect(drawn.features).toHaveLength(1)
      const feature = drawn.features[0]
      expect(feature.authoringFace).toBe('around')
      expect(drawn.featureDefinitions[feature.definitionId]?.operation).toBe('subtract')
      await expect(ui.face.layer(page, 'around')).toHaveAttribute('data-face-state', 'active')
      const aroundSetup = drawn.setups.find((setup) => setup.kind === 'around')
      expect(aroundSetup).toBeDefined()
      expect(drawn.activeSetupId).toBe(aroundSetup!.id)
      expect(drawn.features[0].z_top).toBe(units === 'mm' ? 25 : 1)

      // ── Select and edit it: the Top-style Z range, with no change-face row ──
      await featureRow(page, feature.id).click()
      await page.locator('.properties-panel').getByRole('button', { name: 'Instance', exact: true }).click()
      await expect(page.locator('.properties-panel .z-range-slider')).toBeVisible()
      await expect(page.locator('.properties-panel .face-z-range')).toHaveCount(0)
      const editedTop = Number(feature.z_top) - (units === 'mm' ? 1 : 0.05)
      const zTop = page.locator('.properties-panel .z-range-slider__field--top')
      await zTop.fill(String(editedTop))
      await zTop.press('Enter')
      const edited = (await getProject(page) as unknown as SavedProject).features[0]
      expect(edited.z_top).toBeCloseTo(editedTop, 6)

      // ── Changing the machine alone moves neither the face nor the work ──
      await selectMachine(page, ui, 'GRBL 1.1')
      // The control names Around. The menu is closed here, so the entry only
      // exists once it is opened — and it is a radio, checked rather than
      // aria-pressed (issue #1112's one compact control).
      await expect(ui.face.current(page)).toHaveAttribute('data-face', 'around')
      await ui.face.current(page).click()
      await expect(ui.face.item(page, 'Around')).toHaveAttribute('aria-checked', 'true')
      await page.keyboard.press('Escape')
      await expect(ui.face.layer(page, 'around')).toHaveAttribute('data-face-state', 'active')
      const after = await getProject(page) as unknown as SavedProject
      expect(after.features.map((entry) => entry.id)).toEqual([feature.id])
      expect(after.features[0].z_top).toBeCloseTo(editedTop, 6)
      expect(after.activeSetupId).toBe(drawn.activeSetupId)
      expect(after.setups.filter((setup) => setup.kind === 'around')).toHaveLength(1)
    })
  }
})

test.describe('the export boundary still refuses a rotary job (#1034)', () => {
  test('a rotary project with no machine authors and previews Around but cannot post it', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(aroundProject({ machine: 'none' })))
    await ui.face.switchTo(page, 'Around')
    await drawRect(page, ...fixtureRect('mm'))
    const operationId = await addAroundPocket(page, ui)

    // The design preview is real with no machine anywhere in the project:
    // generation settles and the Around operation produces wrapped motion.
    await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })
    const generated = await generatedOperation(page, operationId)
    expect(generated.moveCount).toBeGreaterThan(0)
    expect(generated.warningCount).toBe(0)
    expect(generated.allHaveAngle).toBe(true)

    // Only the output is refused — authoring and preview are not.
    await ui.operations.headerExportButton(page).click()
    await expect(ui.exportDialog.root(page)).toBeVisible()
    await expect(ui.exportDialog.errors(page).filter({ hasText: 'No machine selected' })).toBeVisible()
    await expect(ui.exportDialog.exportButton(page)).toBeDisabled()
  })

  test('a plain router on a rotary project blocks the export in the dialog', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(aroundProject({ machine: 'plain' })))
    await ui.face.switchTo(page, 'Around')
    await drawRect(page, ...fixtureRect('mm'))
    await addAroundPocket(page, ui)

    await ui.operations.headerExportButton(page).click()
    await expect(ui.exportDialog.root(page)).toBeVisible()
    await expect(
      ui.exportDialog.errors(page).filter({ hasText: 'does not match this rotary project' }),
    ).toContainText('E2E Around Router')
    await expect(ui.exportDialog.exportButton(page)).toBeDisabled()
  })

  test('an opposite-axis rotary machine leaves the turn out and blocks the save', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(aroundProject({ machine: 'rotary-y' })))
    await ui.face.switchTo(page, 'Around')
    await drawRect(page, ...fixtureRect('mm'))
    await addAroundPocket(page, ui)

    await ui.operations.headerExportButton(page).click()
    await expect(ui.exportDialog.root(page)).toBeVisible()
    await expect(
      ui.exportDialog.errors(page).filter({ hasText: 'was not exported: the machine' }),
    ).toContainText('rotary axis lies along Y but the bar lies along X')
    await expect(ui.exportDialog.exportButton(page)).toBeDisabled()
  })
})

test('Around on a rotary bar: banner, tree layer, Z properties, CAM, export and Print', async ({ app, ui }) => {
  const { page } = app
  await seedProject(page, JSON.stringify(aroundProject({ machine: 'rotary-x' })))

  // ── The switch, the banner and the empty Around layer ──
  await ui.face.switchTo(page, 'Around')
  await expect(ui.face.current(page)).toHaveAttribute('data-face', 'around')
  // The explanation is the Around entry's tooltip, and the control lives at the
  // right end of the centre panel's tab bar (issue #1112 F3).
  await expect(ui.face.tabBarControl(page)).toHaveCount(1)
  // A flat face and Around share no plane: the other-side entry is gone.
  await ui.face.current(page).click()
  await expect(ui.face.item(page, 'Around')).toHaveAttribute('title', /^The bar turns in the rotary\./)
  await expect(ui.face.otherSideItem(page)).toHaveCount(0)
  await page.keyboard.press('Escape')

  // ── Two cuts side by side, both Around ──
  // Side by side, not nested: a shape drawn inside an Around cut is an add
  // island now (issue #1108), and the second one is the pocket target below.
  await drawRect(page, 10, ZERO + 5, 100, ZERO + 15)
  await drawRect(page, 104, ZERO + 8, 116, ZERO + 12)
  const drawn = await getProject(page)
  const features = drawn.features as SavedFeature[]
  // A feature's operation lives on its shared definition, not on the instance.
  const definitions = drawn.featureDefinitions as Record<string, { operation?: string }>
  expect(features).toHaveLength(2)
  for (const feature of features) {
    expect(feature.authoringFace).toBe('around')
    // The bar is already solid, so a lone shape drawn on it is a cut, never a base.
    expect(definitions[(feature as unknown as { definitionId: string }).definitionId]?.operation).toBe('subtract')
  }
  // The tree shows its face layers once the project has a feature; before that
  // it shows its empty message.
  await expect(ui.face.layer(page, 'around')).toHaveAttribute('data-face-state', 'active')
  await expect(ui.face.layer(page, 'around')).toContainText('Around')
  // An Around subtract takes no part in the solid: no "first feature must be Add".
  await expect(ui.tree.warning(page)).toHaveCount(0)
  await expect(featureRow(page, features[1].id)).toBeVisible()

  // ── Properties: ordinary Top-style Z controls, and no Change face row ──
  await featureRow(page, features[1].id).click()
  await page.locator('.properties-panel').getByRole('button', { name: 'Instance', exact: true }).click()
  await expect(page.locator('.properties-panel .z-range-slider')).toBeVisible()
  await expect(page.locator('.properties-panel .face-z-range')).toHaveCount(0)
  await expect(page.locator('.properties-panel .face-row .face-chip--around')).toBeVisible()
  await expect(page.locator('.properties-panel .face-row').getByRole('button', { name: 'Change…' })).toHaveCount(0)

  // ── CAM: "Around operations" and "Add to Around" adds a pocket that generates ──
  // An empty Around setup is one slim row; the toggle keeps the full name (issue #1102).
  await expect(ui.setupCam.section(page, 'around').getByRole('button', { name: /^Around operations 0 / })).toBeVisible()
  await expect(ui.setupCam.section(page, 'around')).toContainText('No operations')
  await ui.setupCam.add(page).click()
  await expect(ui.setupCam.addMenu(page)).toBeVisible()
  // An Around setup gets no cross-face target checklist, and the Add menu
  // carries no per-operation Cuts list (that lives on the operation).
  await expect(ui.setupCam.addMenu(page).locator('[data-operation-cuts]')).toHaveCount(0)
  const pocketRow = ui.setupCam.addMenu(page)
    .locator('.cam-operation-item')
    .filter({ has: page.getByRole('button', { name: 'Pocket', exact: true }) })
  // A pocket offers its passes rather than a single Add.
  await pocketRow.getByRole('button', { name: 'Rough', exact: true }).click()
  await expect(ui.operations.rowByName(page, 'Pocket Rough')).toBeVisible()
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })
  const withOperation = await getProject(page)
  const aroundSetupId = (withOperation.setups as Array<{ id: string; kind?: string }>).find((setup) => setup.kind === 'around')!.id
  expect((withOperation.operations as Array<{ kind: string; setupId?: string }>)[0]).toMatchObject({ kind: 'pocket', setupId: aroundSetupId })
  // "Up to date" is not proof of motion (issue #395 review): the shape is a cut
  // into the bar, so the operation really generates wrapped, warned moves.
  const operationId = (withOperation.operations as Array<{ id: string }>)[0].id
  const generated = await generatedOperation(page, operationId)
  expect(generated.moveCount).toBeGreaterThan(0)
  expect(generated.warningCount).toBe(0)
  expect(generated.allHaveAngle).toBe(true)

  // ── Export: the Around setup is its own group and program card ──
  await ui.operations.headerExportButton(page).click()
  await expect(ui.exportDialog.setupHeading(page, 'around')).toContainText('Around')
  await expect(ui.exportDialog.programCard(page, 'around')).toBeVisible()
  // The card's program is the wrapped one: a turning cut is a G1 block with the
  // rotary word (A on this own-axis machine).
  await ui.exportDialog.programCard(page, 'around').click()
  await expect(ui.exportPreview.body(page)).toContainText(/^(?:G[01]\s+)?[XYZ][-\d.]+.*\bA-?\d+\.\d+/m)
  // Escape does not close this dialog; its header button does.
  await ui.exportDialog.root(page).locator('.dialog-header').getByRole('button').last().click()
  await expect(ui.exportDialog.root(page)).toBeHidden()

  // ── Print is disabled on Around, saying why; Export model says its own line ──
  await expect(ui.toolbar.printButton(page)).toBeDisabled()
  await expect(ui.toolbar.printButton(page)).toHaveAttribute('aria-label', 'Printing shows the flat faces. Switch to the top or bottom face to print.')
  // One shared sentence used to serve both commands, so Export model was
  // disabled with the printing text (issue #395).
  await expect(ui.toolbar.exportModelButton(page)).toBeDisabled()
  await expect(ui.toolbar.exportModelButton(page)).toHaveAttribute('aria-label', 'The design export shows the flat faces. Switch to the top or bottom face to export.')

  // ── A flat face sees the Around features as ghosts that name their face ──
  await ui.face.switchTo(page, 'Top')
  await expect(ui.face.ghostRows(page)).toHaveCount(2)
  await expect(ui.face.ghostRows(page).first()).toHaveAttribute('title', 'On the around face. Switch to it to edit.')
  await ui.face.ghostRows(page).first().click({ button: 'right' })
  await expect(page.getByRole('button', { name: 'Switch to around face to edit' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change authoring face…' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // From a flat face Print works as it did.
  await expect(ui.toolbar.printButton(page)).toBeEnabled()
})

test.describe('Around on a tablet with no rotary machine (#1034)', () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true })

  test('the around switch is usable by focus, the Around menu is wrapped work only, and undo is one step', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(aroundProject({ machine: 'none' })))

    // The tablet shell carries the control in its workspace header row, still
    // enabled (issue #1112 F3).
    const control = ui.face.current(page)
    await expect(control).toBeVisible()

    // Keyboard: focus the control, open the menu and walk to the Around entry.
    await control.focus()
    await expect(control).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(ui.face.item(page, 'Top')).toBeFocused()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    const around = ui.face.item(page, 'Around')
    await expect(around).toBeFocused()
    await expect(around).toBeEnabled()
    await expect(around).toHaveAttribute('title', /^The bar turns in the rotary\./)
    await page.keyboard.press('Enter')
    await expect(control).toHaveAttribute('data-face', 'around')

    // A cut authored here is undone in one step, face and all.
    await drawRect(page, ...fixtureRect('mm'))
    expect((await getProject(page) as unknown as SavedProject).features).toHaveLength(1)
    await page.keyboard.press('ControlOrMeta+z')
    expect((await getProject(page) as unknown as SavedProject).features).toHaveLength(0)

    // The corrected Add menu: Around shows only what Around can do, so the
    // flat plasma cut is not offered there at all (issue #1112 K, decision 5).
    // It stays on the flat faces, blocked by the project type (#960/#1034).
    await drawRect(page, 20, ZERO + 8, 40, ZERO + 12)
    const redrawn = await getProject(page) as unknown as SavedProject
    await selectFeatures(page, [redrawn.features[0].id])
    await ui.operations.openPanelButton(page).click()
    await ui.setupCam.add(page).click()
    await expect(ui.setupCam.addMenu(page)).toBeVisible()
    const aroundMenu = ui.setupCam.addMenu(page)
    await expect(aroundMenu.locator('.cam-operation-item').filter({ hasText: 'Plasma through-cut' })).toHaveCount(0)
    // The wrapped rows Around can do are still there.
    await expect(
      aroundMenu.locator('.cam-operation-item').filter({ has: page.getByRole('button', { name: 'Pocket', exact: true }) }),
    ).toHaveCount(1)
  })
})

test('kept Around sheet work warns on its tree row and operation after the bar turns square (#1112 K)', async ({ app, ui }) => {
  const { page } = app
  await seedProject(page, JSON.stringify(aroundProject()))
  await ui.face.switchTo(page, 'Around')
  await expect(ui.face.current(page)).toHaveAttribute('data-face', 'around')

  // Draw the sheet cut and add its pocket through the real menu.
  await drawRect(page, ...fixtureRect('mm'))
  const drawn = await getProject(page) as unknown as SavedProject
  const featureId = drawn.features[0].id
  expect(drawn.features[0].authoringFace).toBe('around')
  await selectFeatures(page, [featureId])
  await ui.setupCam.add(page).click()
  await expect(ui.setupCam.addMenu(page)).toBeVisible()
  await ui.setupCam.addMenu(page)
    .locator('.cam-operation-item')
    .filter({ has: page.getByRole('button', { name: 'Pocket', exact: true }) })
    .getByRole('button', { name: 'Rough', exact: true })
    .click()
  const pocketOp = ui.operations.rowByName(page, 'Pocket Rough')
  await expect(pocketOp).toBeVisible()

  // While the stock is a round bar both still cut: nothing is flagged.
  await expect(featureRow(page, featureId).locator('[data-uncut-work]')).toHaveCount(0)
  await expect(pocketOp.locator('[data-uncut-work]')).toHaveCount(0)

  // Turn the bar into a square blank: the wrapped sheet work is kept, and both
  // the feature row and the operation say why they can no longer cut. Neither
  // is dropped or hidden.
  await page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    useProjectStore.getState().setStockShape('square')
  })
  const featureWarning = featureRow(page, featureId).locator('[data-uncut-work]')
  await expect(featureWarning).toBeVisible()
  await expect(featureWarning).toHaveAttribute(
    'title',
    /^Kept, but it cannot be cut: a square blank cannot machine around sheet work/,
  )
  const operationWarning = pocketOp.locator('[data-uncut-work]')
  await expect(operationWarning).toBeVisible()
  await expect(operationWarning).toHaveAttribute(
    'title',
    /^Kept, but it cannot be cut: a square blank only machines a rotary rough or finish/,
  )

  // The stock-blocked rows are in the menu itself, disabled with the reason:
  // "Needs a round bar" must not live behind an expand step (review of K).
  await ui.setupCam.add(page).click()
  await expect(ui.setupCam.addMenu(page)).toBeVisible()
  const squarePocketRow = ui.setupCam.addMenu(page)
    .locator('.cam-operation-item')
    .filter({ has: page.getByRole('button', { name: 'Pocket', exact: true }) })
  await expect(squarePocketRow).toBeVisible()
  await expect(squarePocketRow.locator('.cam-operation-hint__text')).toHaveText('Needs a round bar')
  await expect(squarePocketRow.getByRole('button', { name: 'Rough', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(ui.setupCam.addMenu(page)).toBeHidden()

  // The selected operation's panel repeats the reason in a sentence.
  if (!(await pocketOp.evaluate((element) => element.classList.contains('tree-row--selected')))) {
    await pocketOp.click()
  }
  await expect(pocketOp).toHaveClass(/tree-row--selected/)
  await expect(page.locator('.cam-operation-properties [data-uncut-work]')).toContainText(
    'Kept, but it cannot be cut: a square blank only machines a rotary rough or finish against a model.',
  )

  // A ghost operation keeps its warning: switching to Top hides the row's
  // editing, not the reason it cannot cut (review of K).
  await ui.face.switchTo(page, 'Top')
  const ghostPocket = ui.operations.rowByName(page, 'Pocket Rough')
  await expect(ghostPocket).toHaveAttribute('data-ghost', 'true')
  await expect(ghostPocket.locator('[data-uncut-work]')).toBeVisible()
})
