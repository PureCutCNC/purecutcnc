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
  seedCamQuickOperationProjectWithSmallCarveTarget,
} from './camOperations.helpers'

/** The bundled router machine the picker offers, read from the app's own JSON. */
const GRBL = JSON.parse(
  readFileSync(new URL('../src/engine/gcode/definitions/grbl.json', import.meta.url), 'utf8'),
) as { name: string }

const PLASMA_OP = 'Plasma through-cut'
const PLASMA_HINT = 'Needs a plasma project. The type is chosen when the project is created.'
/** The CAM quick-operation fixture as a plasma project with no machine (issue #1034). */
function plasmaProjectJson(): string {
  const project = JSON.parse(camQuickOperationProjectJson) as { meta: Record<string, unknown> }
  project.meta.projectType = 'plasma'
  project.meta.machineDefinitions = []
  project.meta.selectedMachineId = null
  return JSON.stringify(project)
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
