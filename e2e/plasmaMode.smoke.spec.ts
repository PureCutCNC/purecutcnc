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
 * The project type decides the CAM mode (#1028): a plasma project offers only
 * the plasma family, the tool types and tool library follow the type, the Auto
 * plan button and face switch go away, and anything the project already has
 * from the other family stays listed, badged and counted. Selecting a machine
 * no longer changes the mode (#960 is retired).
 */

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  clickMenuItem,
  getProject,
  openRowContextMenu,
  rowByName,
  seedProject,
  selectFeatures,
  selectMachine,
} from './helpers'
import {
  camQuickOperationProjectJson,
  seedCamQuickOperationProject,
} from './camOperations.helpers'

/** The bundled router machine the picker offers, read from the app's own JSON. */
const GRBL = JSON.parse(
  readFileSync(new URL('../src/engine/gcode/definitions/grbl.json', import.meta.url), 'utf8'),
) as { name: string }

const PLASMA_OP = 'Plasma through-cut'
const PLASMA_HINT = 'Needs a plasma project. The type is chosen when the project is created.'
const LEFT_OUT_PLASMA = 'Not plasma cuts, left out of the export for this project type: 1'
const LEFT_OUT_ROUTER = 'Plasma cuts, left out of the export for this project type: 1'

/** A milling cutter and a plasma torch, in the quick-operation fixture's units. */
const MILLING_TOOL = {
  id: 'tool-1',
  name: 'Quarter Inch Endmill',
  units: 'inch',
  type: 'flat_endmill',
  diameter: 0.25,
  vBitAngle: null,
  flutes: 2,
  material: 'carbide',
  defaultRpm: 18000,
  defaultFeed: 60,
  defaultPlungeFeed: 30,
  defaultStepdown: 0.1,
  defaultStepover: 0.125,
  maxCutDepth: 1,
}

const PLASMA_TORCH = {
  id: 'torch',
  name: 'Plasma Torch',
  units: 'inch',
  type: 'plasma',
  diameter: 0.055,
  pierceHeight: 0.15,
  cutHeight: 0.06,
  pierceDelay: 0.2,
  vBitAngle: null,
  flutes: 0,
  material: 'carbide',
  defaultRpm: 0,
  defaultFeed: 200,
  defaultPlungeFeed: 0,
  defaultStepdown: 0,
  defaultStepover: 0,
  maxCutDepth: 0,
}

/** The CAM quick-operation fixture as a plasma project with no machine (issue #1034). */
function plasmaProjectJson(): string {
  const project = JSON.parse(camQuickOperationProjectJson) as { meta: Record<string, unknown> }
  project.meta.projectType = 'plasma'
  project.meta.machineDefinitions = []
  project.meta.selectedMachineId = null
  return JSON.stringify(project)
}

/** A rectangular sketch profile, matching the quick-operation fixture's shape. */
function rectProfile(cx: number, cy: number, w: number, h: number) {
  return {
    start: { x: cx, y: cy },
    segments: [
      { type: 'line' as const, to: { x: cx + w, y: cy } },
      { type: 'line' as const, to: { x: cx + w, y: cy + h } },
      { type: 'line' as const, to: { x: cx, y: cy + h } },
      { type: 'line' as const, to: { x: cx, y: cy } },
    ],
    closed: true,
  }
}

interface CamFixtureProject {
  meta: Record<string, unknown>
  featureDefinitions: Record<string, { profile: unknown }>
  features: { id: string }[]
  tools: Record<string, unknown>[]
  operations: Record<string, unknown>[]
}

interface MixedContentFixture {
  json: string
  operationIds: string[]
  featureIds: string[]
}

/**
 * The CAM quick-operation fixture as a project of `type` that already carries
 * the other family's operations and tools. Since #1046 a project's type is
 * fixed when it is created, so a mixed project arrives in the file instead of
 * being switched into it. Carve Target is shrunk so a pocket generates in
 * about a second (as in `seedCamQuickOperationProjectWithSmallCarveTarget`).
 */
function mixedContentProject(
  type: 'milling' | 'plasma',
  tools: Record<string, unknown>[],
  operations: Record<string, unknown>[],
): MixedContentFixture {
  const project = JSON.parse(camQuickOperationProjectJson) as CamFixtureProject
  project.featureDefinitions['def-carve-target'].profile = rectProfile(0, 0, 4, 2)
  project.meta.projectType = type
  project.meta.machineDefinitions = []
  project.meta.selectedMachineId = null
  project.tools = tools
  project.operations = operations
  return {
    json: JSON.stringify(project),
    operationIds: operations.map((operation) => operation.id as string),
    featureIds: project.features.map((feature) => feature.id),
  }
}

/** The plasma through-cut a plasma project would author on Carve Target. */
function plasmaCutOperation(): Record<string, unknown> {
  return {
    id: 'op-plasma-cut',
    name: PLASMA_OP,
    kind: 'plasma_profile',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f-carve-target'] },
    toolRef: PLASMA_TORCH.id,
    stepdown: 0.1,
    stepover: 0.125,
    feed: 200,
    plungeFeed: 0,
    rpm: 0,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
  }
}

/** The milling pocket a router project would author on Carve Target. */
function pocketOperation(): Record<string, unknown> {
  return {
    id: 'op-pocket',
    name: 'Pocket Rough',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f-carve-target'] },
    toolRef: MILLING_TOOL.id,
    stepdown: 0.1,
    stepover: 0.125,
    feed: 60,
    plungeFeed: 30,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
  }
}

/** The properties field whose label is exactly `label`, in the tool editor. */
function toolField(page: Page, label: string) {
  return page.locator('.cam-tool-properties .properties-field')
    .filter({ has: page.getByText(label, { exact: true }) })
}

test.describe('the project type decides plasma mode (#1028)', () => {
  test('a milling project offers milling and blocks the plasma cut', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)
    // A closed subtract is a valid target for both families, so the menu below
    // shows what each project type does with the same selection.
    await selectFeatures(app.page, ['f-carve-target'])

    await ui.operations.headerAddButton(app.page).click()
    await expect(ui.operations.addMenu(app.page)).toBeVisible()

    // Milling kinds the selection can take are offered as before.
    await expect(
      ui.operations.addMenuRowLabels(ui.operations.addMenuAvailableRows(app.page)),
    ).toContainText(['Pocket', 'Edge in'])

    // The plasma cut is present but blocked. The hint names the project type,
    // which is the root cause: only a plasma project offers the cut (#1028,
    // wording corrected in #1034 and #1046).
    await ui.operations.addMenuUnavailableToggle(app.page).click()
    const plasmaRow = ui.operations.addMenuUnavailableRows(app.page)
      .filter({ hasText: PLASMA_OP })
    await expect(plasmaRow).toHaveCount(1)
    await expect(plasmaRow.locator('.cam-operation-hint__text')).toHaveText(PLASMA_HINT)
    await expect(plasmaRow.getByRole('button', { name: 'Add', exact: true })).toBeDisabled()

    // A milling project keeps the face switch, machine or not.
    await expect(ui.face.switchGroup(app.page)).toBeVisible()
  })

  test('a plasma project leaves only the plasma cut, torch tools and no face switch', async ({ app, ui }) => {
    // The type is chosen when a project is created (issue #1046), so a plasma
    // project with this fixture's geometry is seeded with the stored field.
    await seedProject(app.page, plasmaProjectJson())
    await selectFeatures(app.page, ['f-carve-target'])

    await ui.operations.headerAddButton(app.page).click()
    const available = ui.operations.addMenuAvailableRows(app.page)
    await expect(ui.operations.addMenuRowLabels(available)).toHaveText([PLASMA_OP])
    await expect(available.getByRole('button', { name: 'Add', exact: true })).toBeEnabled()
    // Nothing is merely blocked: the menu is the plasma family alone.
    await expect(ui.operations.addMenuUnavailableToggle(app.page)).toHaveCount(0)

    // Auto plan authors milling work, so it is gone in plasma mode.
    await expect(app.page.locator('.cam-header-action--plan')).toHaveCount(0)

    await available.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(ui.operations.rowByName(app.page, PLASMA_OP)).toBeVisible()

    // A new tool is a torch.
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: 'Add tool', exact: true }).click()
    await expect(toolField(app.page, 'Type').locator('.ui-select__label')).toHaveText('Plasma')

    // The library lists torches only, and offers only the torch type.
    await app.page.getByRole('button', { name: /Import from library/ }).click()
    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()
    const typeSelect = dialog.locator('.tl-filter-selects .ui-select').first()
    await typeSelect.locator('.ui-select__trigger').click()
    await expect(typeSelect.locator('.ui-select__option-label')).toHaveText(['All types', 'Plasma'])
    await typeSelect.getByRole('option', { name: 'Plasma', exact: true }).click()
    // The bundled torches are metric; the fixture is inch, so widen the filter.
    const unitsSelect = dialog.locator('.tl-filter-selects .ui-select').nth(1)
    await unitsSelect.locator('.ui-select__trigger').click()
    await unitsSelect.getByRole('option', { name: 'mm', exact: true }).click()
    await expect(dialog.locator('.tl-row').first()).toBeVisible()
    await expect(dialog.locator('.tl-row__meta').filter({ hasText: 'Flat endmill' })).toHaveCount(0)
    await app.page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // The face switch follows the type too.
    await expect(ui.face.switchGroup(app.page)).toHaveCount(0)
  })

  test('a milling project with a plasma cut keeps the milling menu and badges the cut', async ({ app, ui }) => {
    // The type is fixed at creation (#1046), so a router project that already
    // carries a plasma cut is loaded that way instead of switched back to
    // milling. This is the loaded-mixed-content half of the deleted
    // plasma → milling test.
    const fixture = mixedContentProject('milling', [PLASMA_TORCH], [plasmaCutOperation()])
    await seedProject(app.page, fixture.json)
    await selectFeatures(app.page, ['f-carve-target'])

    // The milling family the type offers is what the Add menu presents.
    await ui.operations.headerAddButton(app.page).click()
    await expect(
      ui.operations.addMenuRowLabels(ui.operations.addMenuAvailableRows(app.page)),
    ).toContainText(['Pocket', 'V-carve offset', 'Edge in', 'Engrave'])

    // The plasma operation is still listed, badged as one this project type
    // does not cut, and counted above the list — loaded, not dropped. The row
    // may also transiently carry the generating badge, so the project-type
    // badge is matched by its text.
    const row = ui.operations.rowByName(app.page, PLASMA_OP)
    await expect(row).toBeVisible()
    await expect(row.locator('.cam-operation-badge').filter({ hasText: 'not for this project type' }))
      .toHaveText(['not for this project type'])
    await expect(app.page.locator('.cam-operations-notice')).toHaveText(LEFT_OUT_ROUTER)

    await expect(ui.face.switchGroup(app.page)).toBeVisible()

    // Nothing was deleted by the load: the stored type, every operation and
    // every feature the file carried are still there (the deleted trip's
    // opening and final legs).
    const loaded = await getProject(app.page)
    expect((loaded.meta as { projectType?: string }).projectType).toBe('milling')
    expect((loaded.operations as { id: string; kind: string }[]).map((operation) => operation.kind))
      .toEqual(['plasma_profile'])
    expect((loaded.operations as { id: string }[]).map((operation) => operation.id)).toEqual(fixture.operationIds)
    expect((loaded.features as { id: string }[]).map((feature) => feature.id)).toEqual(fixture.featureIds)
  })

  test('a plasma project with a pocket and a milling tool keeps both', async ({ app, ui }) => {
    // A plasma project that already carries router work is loaded that way; it
    // is not created as milling and switched. This is the loaded-mixed-content
    // half of the deleted milling → plasma test.
    const fixture = mixedContentProject('plasma', [MILLING_TOOL], [pocketOperation()])
    await seedProject(app.page, fixture.json)

    // Still listed, and flagged as not for this project type, with the count line.
    await expect(ui.operations.rows(app.page)).toHaveCount(1)
    const pocket = ui.operations.rowByName(app.page, 'Pocket Rough')
    await expect(pocket).toBeVisible()
    await expect(pocket.locator('.cam-operation-badge').filter({ hasText: 'not for this project type' }))
      .toHaveText(['not for this project type'])
    await expect(app.page.locator('.cam-operations-notice')).toHaveText(LEFT_OUT_PLASMA)

    // Its tool is still listed and still reads as the milling tool it is.
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    const toolRow = app.page.locator('.cam-tool-tree .tree-row--feature')
      .filter({ hasText: MILLING_TOOL.name })
    await expect(toolRow).toBeVisible()
    await toolRow.click()
    // Still a milling tool, not forced into a torch by the project type.
    await expect(toolField(app.page, 'Type').locator('.ui-select__label'))
      .toHaveText(/^(Flat endmill|Ball endmill|V-bit|Drill)$/)

    // And the Add menu is the plasma family alone.
    await app.page.getByRole('tab', { name: 'Operations' }).click()
    await selectFeatures(app.page, ['f-carve-target'])
    await ui.operations.headerAddButton(app.page).click()
    await expect(
      ui.operations.addMenuRowLabels(ui.operations.addMenuAvailableRows(app.page)),
    ).toHaveText([PLASMA_OP])

    // The load kept the stored type, the operation and its tool, and every
    // feature the mixed file carried (the deleted trip's opening and final
    // legs, applied to content that arrives in the file).
    const loaded = await getProject(app.page)
    expect((loaded.meta as { projectType?: string }).projectType).toBe('plasma')
    expect((loaded.operations as { id: string; kind: string }[]).map((operation) => operation.kind))
      .toEqual(['pocket'])
    expect((loaded.operations as { id: string }[]).map((operation) => operation.id)).toEqual(fixture.operationIds)
    expect((loaded.tools as { type: string }[]).map((tool) => tool.type)).toEqual(['flat_endmill'])
    expect((loaded.features as { id: string }[]).map((feature) => feature.id)).toEqual(fixture.featureIds)
  })

  test('the feature context menu offers the plasma cut in a plasma project', async ({ app, ui }) => {
    await seedProject(app.page, plasmaProjectJson())

    // A closed subtract is a valid target for both families, so the same
    // feature shows what each project type does with it.
    const menu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(menu, 'Create operation').hover()

    const submenu = ui.contextMenu.submenu(app.page)
    await expect(ui.contextMenu.item(submenu, PLASMA_OP)).toBeVisible()
    await expect(ui.contextMenu.item(submenu, 'Create pocket')).toHaveCount(0)

    await clickMenuItem(submenu, 'Create plasma through-cut')

    // The operation is added and selected in the CAM panel.
    const operation = ui.operations.rowByName(app.page, PLASMA_OP)
    await expect(operation).toBeVisible()
    await expect(operation).toHaveClass(/tree-row--selected/)
  })

  test('the feature context menu offers the milling kinds on a router machine', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)
    await selectMachine(app.page, ui, GRBL.name)

    const menu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(menu, 'Create operation').hover()

    const submenu = ui.contextMenu.submenu(app.page)
    await expect(ui.contextMenu.item(submenu, 'Create pocket')).toBeVisible()
    await expect(ui.contextMenu.item(submenu, PLASMA_OP)).toHaveCount(0)
  })
})

/**
 * Issue #1034 slice B: a plasma project authors plasma work whatever machine
 * is selected — none, or a router that does not suit the type. The machine is
 * an output concern; the project type is what offers the torch.
 */
test.describe('plasma authoring does not wait for a machine (#1034)', () => {
  for (const machine of ['none', 'router'] as const) {
    test(`a plasma project with ${machine} offers and creates the plasma family`, async ({ app, ui }) => {
      await seedProject(app.page, plasmaProjectJson())
      if (machine === 'router') {
        // A router on a plasma project: genuinely incompatible, and only the
        // export may care about that.
        await selectMachine(app.page, ui, GRBL.name)
        await expect(ui.properties.machineTypeMismatch(app.page)).toBeVisible()
      }

      await selectFeatures(app.page, ['f-carve-target'])
      await ui.operations.headerAddButton(app.page).click()

      // The Add menu is the plasma family alone; nothing is merely blocked.
      const available = ui.operations.addMenuAvailableRows(app.page)
      await expect(ui.operations.addMenuRowLabels(available)).toHaveText([PLASMA_OP])
      await expect(available.getByRole('button', { name: 'Add', exact: true })).toBeEnabled()
      await expect(ui.operations.addMenuUnavailableToggle(app.page)).toHaveCount(0)

      // No flat-face switch and no rotary expansion: the type decides both.
      await expect(ui.face.switchGroup(app.page)).toHaveCount(0)
      await expect(app.page.locator('.cam-operation-label').filter({ hasText: /^Rotary/ })).toHaveCount(0)

      // The cut is created for real, and its tool is a torch.
      await available.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(ui.operations.rowByName(app.page, PLASMA_OP)).toBeVisible()
      await app.page.getByRole('tab', { name: 'Tools' }).click()
      await app.page.getByRole('button', { name: 'Add tool', exact: true }).click()
      await expect(toolField(app.page, 'Type').locator('.ui-select__label')).toHaveText('Plasma')

      // Changing the selection switches neither the mode nor the geometry.
      const before = await getProject(app.page)
      await app.page.getByRole('tab', { name: 'Operations' }).click()
      await selectFeatures(app.page, ['f-machinable-add'])
      await ui.operations.headerAddButton(app.page).click()
      await expect(
        ui.operations.addMenuRowLabels(ui.operations.addMenuAvailableRows(app.page)),
      ).toHaveText([PLASMA_OP])
      const after = await getProject(app.page)
      expect((after.meta as Record<string, unknown>).projectType).toBe('plasma')
      expect(after.features).toEqual(before.features)
    })
  }
})
