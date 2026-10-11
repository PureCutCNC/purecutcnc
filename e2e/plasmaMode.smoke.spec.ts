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
 * Plasma mode follows the machine (#960): the CAM panel offers only the plasma
 * family with a plasma machine selected, the tool types and tool library follow
 * it, the Auto plan button and face switch go away, and anything the project
 * already has from the other family stays listed, badged and counted.
 */

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  clickMenuItem,
  openRowContextMenu,
  rowByName,
  selectFeatures,
} from './helpers'
import {
  seedCamQuickOperationProject,
  seedCamQuickOperationProjectWithSmallCarveTarget,
} from './camOperations.helpers'

/**
 * The bundled definitions are the machines the picker offers, so the fixture's
 * selected machine is read from the same JSON the app ships.
 */
const QT_PLASMAC = JSON.parse(
  readFileSync(new URL('../src/engine/gcode/definitions/qtplasmac.json', import.meta.url), 'utf8'),
) as { name: string }
const GRBL = JSON.parse(
  readFileSync(new URL('../src/engine/gcode/definitions/grbl.json', import.meta.url), 'utf8'),
) as { name: string }

const PLASMA_OP = 'Plasma through-cut'
const PLASMA_HINT = 'Needs a plasma machine. Select one in the machine field of the project properties.'
const LEFT_OUT_PLASMA = 'Not plasma cuts, left out of the export on this machine: 1'
const LEFT_OUT_ROUTER = 'Plasma cuts, left out of the export on this machine: 1'

/** Select a bundled machine the way a user does: Project → Machine in the properties. */
async function selectMachine(
  page: Page,
  ui: typeof import('./selectors'),
  name: string,
): Promise<void> {
  await ui.tree.projectRow(page).click()
  await ui.properties.machineTrigger(page).click()
  await ui.properties.machineOption(page, name).click()
}

/** The properties field whose label is exactly `label`, in the tool editor. */
function toolField(page: Page, label: string) {
  return page.locator('.cam-tool-properties .properties-field')
    .filter({ has: page.getByText(label, { exact: true }) })
}

test.describe('plasma mode follows the machine (#960)', () => {
  test('a machine-less project offers milling and blocks the plasma cut', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)
    // A closed subtract is a valid target for both families, so the menu below
    // shows what each machine does with the same selection.
    await selectFeatures(app.page, ['f-carve-target'])

    await ui.operations.headerAddButton(app.page).click()
    await expect(ui.operations.addMenu(app.page)).toBeVisible()

    // Milling kinds the selection can take are offered as before.
    await expect(
      ui.operations.addMenuRowLabels(ui.operations.addMenuAvailableRows(app.page)),
    ).toContainText(['Pocket', 'Edge in'])

    // The plasma cut is present but blocked, with the reason as its hint.
    await ui.operations.addMenuUnavailableToggle(app.page).click()
    const plasmaRow = ui.operations.addMenuUnavailableRows(app.page)
      .filter({ hasText: PLASMA_OP })
    await expect(plasmaRow).toHaveCount(1)
    await expect(plasmaRow.locator('.cam-operation-hint__text')).toHaveText(PLASMA_HINT)
    await expect(plasmaRow.getByRole('button', { name: 'Add', exact: true })).toBeDisabled()

    // No machine is a router project, so the face switch stays.
    await expect(ui.face.switchGroup(app.page)).toBeVisible()
  })

  test('a plasma machine leaves only the plasma cut, torch tools and no face switch', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)
    await selectMachine(app.page, ui, QT_PLASMAC.name)
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

    // The face switch follows the machine too.
    await expect(ui.face.switchGroup(app.page)).toHaveCount(0)
  })

  test('a router machine brings the milling menu back and badges the plasma cut', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)
    await selectMachine(app.page, ui, QT_PLASMAC.name)
    await selectFeatures(app.page, ['f-carve-target'])
    await ui.operations.headerAddButton(app.page).click()
    await ui.operations.addMenuAvailableRows(app.page)
      .getByRole('button', { name: 'Add', exact: true }).click()
    await expect(ui.operations.rowByName(app.page, PLASMA_OP)).toBeVisible()

    await selectMachine(app.page, ui, GRBL.name)
    await selectFeatures(app.page, ['f-carve-target'])

    // The milling menu is back.
    await ui.operations.headerAddButton(app.page).click()
    await expect(
      ui.operations.addMenuRowLabels(ui.operations.addMenuAvailableRows(app.page)),
    ).toContainText(['Pocket', 'V-carve offset', 'Edge in', 'Engrave'])

    // The plasma operation is still listed, badged, and counted above the list.
    const row = ui.operations.rowByName(app.page, PLASMA_OP)
    await expect(row).toBeVisible()
    await expect(row.locator('.cam-operation-badge')).toHaveText(['not on this machine'])
    await expect(app.page.locator('.cam-operations-notice')).toHaveText(LEFT_OUT_ROUTER)

    await expect(ui.face.switchGroup(app.page)).toBeVisible()
  })

  test('a milling project switched to plasma keeps its operation and tool', async ({ app, ui }) => {
    // The small carve target keeps a real pocket toolpath quick to generate.
    await seedCamQuickOperationProjectWithSmallCarveTarget(app.page)
    const menu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(menu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create pocket')
    await expect(ui.operations.rows(app.page)).toHaveCount(1)
    const pocket = ui.operations.rowByName(app.page, 'Pocket Rough')
    await expect(pocket).toBeVisible()

    await selectMachine(app.page, ui, QT_PLASMAC.name)

    // Still listed, and now flagged as not on the machine, with the count line.
    await expect(pocket).toBeVisible()
    await expect(pocket.locator('.cam-operation-badge')).toHaveText(['not on this machine'])
    await expect(app.page.locator('.cam-operations-notice')).toHaveText(LEFT_OUT_PLASMA)

    // Its tool is still listed and still reads as the milling tool it is.
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    const toolRow = app.page.locator('.cam-tool-tree .tree-row--feature').first()
    await expect(toolRow).toBeVisible()
    await toolRow.click()
    // Still a milling tool, not forced into a torch by the machine change.
    await expect(toolField(app.page, 'Type').locator('.ui-select__label'))
      .toHaveText(/^(Flat endmill|Ball endmill|V-bit|Drill)$/)

    // And the Add menu is the plasma family alone.
    await app.page.getByRole('tab', { name: 'Operations' }).click()
    await selectFeatures(app.page, ['f-carve-target'])
    await ui.operations.headerAddButton(app.page).click()
    await expect(
      ui.operations.addMenuRowLabels(ui.operations.addMenuAvailableRows(app.page)),
    ).toHaveText([PLASMA_OP])
  })
})
