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
 * Choosing and sizing round stock in the Properties panel (#392 slice B): the
 * Shape field turns a block into a bar and swaps Width/Height/Thickness for
 * Diameter/Length/Axis, a diameter edit reaches the status bar, an axis change
 * is one undo step, and plasma mode hides the Shape field (#960).
 */

import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures'
import { selectMachine } from './helpers'

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control'

/** The bundled plasma machine, read from the JSON the app ships (as #960 does). */
const QT_PLASMAC = JSON.parse(
  readFileSync(new URL('../src/engine/gcode/definitions/qtplasmac.json', import.meta.url), 'utf8'),
) as { name: string }

test('the stock switches to a round bar, is sized, and switches back', async ({ app, ui }) => {
  const page = app.page
  await ui.tree.stockRow(page).click()

  // The default project is a block: the block fields are the ones on show.
  await expect(ui.properties.exactText(page, 'Width')).toBeVisible()
  await expect(ui.properties.stockShape(page)).toBeVisible()

  await ui.properties.stockShape(page).locator('.ui-select__trigger').click()
  await ui.properties.stockShapeOption(page, 'Round bar').click()

  // Diameter / Length / Axis replace Width / Height / Thickness.
  await expect(ui.properties.exactText(page, 'Diameter')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Length')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Axis')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Width')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Height')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Thickness')).toHaveCount(0)

  // The default stock is 4 × 3 × 0.75 in: the long side (4) becomes the length
  // along X and the thickness (0.75) the diameter.
  await expect(ui.statusBar.stockDimensions(page)).toContainText('Ø0.75 × 4')

  // A diameter edit reaches the status bar.
  const diameter = ui.properties.stockDiameter(page)
  await diameter.fill('1.5')
  await diameter.press('Enter')
  await expect(ui.statusBar.stockDimensions(page)).toContainText('Ø1.5 × 4')

  // The axis change is one undo step.
  await expect(ui.properties.stockAxis(page).locator('.ui-select__label')).toHaveText('X')
  await ui.properties.stockAxis(page).locator('.ui-select__trigger').click()
  await ui.properties.stockAxisOption(page, 'Y').click()
  await expect(ui.properties.stockAxis(page).locator('.ui-select__label')).toHaveText('Y')

  await page.keyboard.press(`${modKey}+z`)
  await expect(ui.properties.stockAxis(page).locator('.ui-select__label')).toHaveText('X')

  // Back to a block: the block fields return.
  await ui.properties.stockShape(page).locator('.ui-select__trigger').click()
  await ui.properties.stockShapeOption(page, 'Block').click()
  await expect(ui.properties.exactText(page, 'Width')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Height')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Thickness')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Diameter')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Axis')).toHaveCount(0)
})

test('plasma mode hides the Shape field', async ({ app, ui }) => {
  await selectMachine(app.page, ui, QT_PLASMAC.name)
  await ui.tree.stockRow(app.page).click()

  await expect(ui.properties.exactText(app.page, 'Width')).toBeVisible()
  await expect(ui.properties.stockShape(app.page)).toHaveCount(0)
})
