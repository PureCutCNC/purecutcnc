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
 * The project type is chosen once, when the project is created (issue #1046).
 *
 * The New project dialog's blank template asks for the stock the chosen type
 * machines: a rotary project asks for its bar — shape (round or square),
 * diameter or side, length and axis — while milling and plasma keep width ×
 * height × thickness. The type is then stored and the Properties panel shows
 * it as read-only text, with no picker to change it.
 *
 * The expected bar is read from the live store after creation, and the panel
 * is checked for the fields the created shape must show.
 */

import { test, expect } from './fixtures'
import { createNewProject, getProject } from './helpers'
import { getStockBounds, type Project, type Stock } from '../src/types/project'

interface BarCase {
  readonly label: string
  readonly template: 'Blank metric' | 'Blank imperial'
  readonly shape: 'Round bar' | 'Square blank'
  readonly size: string
  readonly length: string
  readonly axis: 'X' | 'Y'
  readonly units: 'mm' | 'inch'
  readonly barShape: 'round' | 'square'
}

/**
 * Every bar combination the dialog offers, crossed: both shapes × both axes ×
 * both units, with non-default numbers so a value that ignored its field
 * cannot pass by matching the default.
 */
const ROTARY_CASES: readonly BarCase[] = [
  { label: 'a metric round bar along X', template: 'Blank metric', shape: 'Round bar', size: '25', length: '150', axis: 'X', units: 'mm', barShape: 'round' },
  { label: 'a metric round bar along Y', template: 'Blank metric', shape: 'Round bar', size: '18', length: '90', axis: 'Y', units: 'mm', barShape: 'round' },
  { label: 'a metric square blank along X', template: 'Blank metric', shape: 'Square blank', size: '30', length: '160', axis: 'X', units: 'mm', barShape: 'square' },
  { label: 'a metric square blank along Y', template: 'Blank metric', shape: 'Square blank', size: '22', length: '110', axis: 'Y', units: 'mm', barShape: 'square' },
  { label: 'an imperial round bar along X', template: 'Blank imperial', shape: 'Round bar', size: '1.25', length: '7', axis: 'X', units: 'inch', barShape: 'round' },
  { label: 'an imperial round bar along Y', template: 'Blank imperial', shape: 'Round bar', size: '0.75', length: '5', axis: 'Y', units: 'inch', barShape: 'round' },
  { label: 'an imperial square blank along X', template: 'Blank imperial', shape: 'Square blank', size: '1', length: '9', axis: 'X', units: 'inch', barShape: 'square' },
  { label: 'an imperial square blank along Y', template: 'Blank imperial', shape: 'Square blank', size: '2', length: '4', axis: 'Y', units: 'inch', barShape: 'square' },
]

/** The bar's extent along its axis, from the stock box. */
function lengthAlong(stock: Stock, axis: 'x' | 'y'): number {
  const bounds = getStockBounds(stock)
  return axis === 'x' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY
}

test.describe('the project type is chosen when the project is created (#1046)', () => {
  for (const entry of ROTARY_CASES) {
    test(`Rotary creates ${entry.label} exactly as typed`, async ({ app, ui }) => {
      await createNewProject(app.page, ui, {
        template: entry.template,
        type: 'Rotary',
        shape: entry.shape,
        size: entry.size,
        length: entry.length,
        axis: entry.axis,
      })

      // The stored project: the chosen type, the template's units, and the bar
      // the dialog's own fields described — no block converted afterwards.
      const project = await getProject(app.page) as unknown as Project
      expect(project.meta.projectType).toBe('rotary')
      expect(project.meta.units).toBe(entry.units)
      const stock = project.stock as Stock & { axis: 'x' | 'y' }
      expect(stock.shape).toBe(entry.barShape)
      expect(stock.thickness).toBeCloseTo(Number(entry.size), 6)
      expect(stock.axis).toBe(entry.axis.toLowerCase())
      expect(lengthAlong(stock, entry.axis.toLowerCase() as 'x' | 'y')).toBeCloseTo(Number(entry.length), 6)

      // The status bar reads the bar, with the shape's own symbol.
      const symbol = entry.barShape === 'round' ? 'Ø' : '▢'
      await expect(ui.statusBar.stockDimensions(app.page)).toContainText(`${symbol}${entry.size} × ${entry.length}`)

      // The Properties panel's stock fields follow the created shape and axis.
      await ui.tree.stockRow(app.page).click()
      await expect(ui.properties.stockShape(app.page).locator('.ui-select__label')).toHaveText(entry.shape)
      if (entry.barShape === 'round') {
        await expect(ui.properties.stockDiameter(app.page)).toHaveValue(entry.size)
        await expect(ui.properties.exactText(app.page, 'Side')).toHaveCount(0)
      } else {
        await expect(ui.properties.stockSide(app.page)).toHaveValue(entry.size)
        await expect(ui.properties.exactText(app.page, 'Diameter')).toHaveCount(0)
      }
      await expect(ui.properties.exactText(app.page, 'Length')).toBeVisible()
      await expect(ui.properties.stockAxis(app.page).locator('.ui-select__label')).toHaveText(entry.axis)
      await expect(ui.properties.exactText(app.page, 'Width')).toHaveCount(0)
    })
  }

  test('the dialog defaults to Ø 40 × 200 along X in the metric template', async ({ app, ui }) => {
    await createNewProject(app.page, ui, { type: 'Rotary' })

    const project = await getProject(app.page) as unknown as Project
    expect(project.meta.units).toBe('mm')
    const stock = project.stock as Stock & { axis: 'x' | 'y' }
    expect(stock.shape).toBe('round')
    expect(stock.thickness).toBeCloseTo(40, 6)
    expect(stock.axis).toBe('x')
    expect(lengthAlong(stock, 'x')).toBeCloseTo(200, 6)
    await expect(ui.statusBar.stockDimensions(app.page)).toContainText('Ø40 × 200')
  })

  for (const type of ['Milling / routing', 'Plasma'] as const) {
    test(`${type} blanks keep width × height × thickness`, async ({ app, ui }) => {
      await createNewProject(app.page, ui, { type })

      const project = await getProject(app.page) as unknown as Project
      expect(project.meta.projectType).toBe(type === 'Plasma' ? 'plasma' : 'milling')
      expect('shape' in project.stock).toBe(false)
      await expect(ui.statusBar.stockDimensions(app.page)).toContainText('100 × 80 × 20')

      // The rotary-only bar fields are not offered.
      await ui.tree.stockRow(app.page).click()
      await expect(ui.properties.exactText(app.page, 'Width')).toBeVisible()
      await expect(ui.properties.exactText(app.page, 'Height')).toBeVisible()
      await expect(ui.properties.exactText(app.page, 'Thickness')).toBeVisible()
      await expect(ui.properties.exactText(app.page, 'Length')).toHaveCount(0)
      await expect(ui.properties.exactText(app.page, 'Axis')).toHaveCount(0)
      await expect(ui.properties.exactText(app.page, 'Diameter')).toHaveCount(0)
    })
  }

  test('the Properties panel shows the project type and offers no way to change it', async ({ app, ui }) => {
    await createNewProject(app.page, ui, { type: 'Rotary' })

    await ui.tree.projectRow(app.page).click()
    await expect(ui.properties.projectTypeValue(app.page)).toHaveText('Rotary')
    // Read-only: the type row carries no select at all.
    await expect(ui.properties.projectTypeSelect(app.page)).toHaveCount(0)

    // It is the project's stored type, not a display default, and it survives
    // moving around the panel.
    await ui.tree.stockRow(app.page).click()
    await ui.tree.projectRow(app.page).click()
    await expect(ui.properties.projectTypeValue(app.page)).toHaveText('Rotary')
    expect((await getProject(app.page) as unknown as Project).meta.projectType).toBe('rotary')
  })
})
