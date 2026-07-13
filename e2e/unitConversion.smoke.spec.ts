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

import { test, expect } from './fixtures'
import { getProject, seedProject } from './helpers'

interface UnitProjectSnapshot {
  meta: { units: 'mm' | 'inch' }
  stock: { thickness: number }
  annotations: Array<{
    a: { kind: string; target?: { source: string }; vertexIndex?: number }
    b?: { kind: string; point?: { x: number; y: number } }
    offset: number
  }>
}

async function seedInchProject(page: Parameters<typeof getProject>[0]): Promise<void> {
  const project = await getProject(page)
  const metadata = project.meta as Record<string, unknown>
  const stock = project.stock as Record<string, unknown>
  const annotations = [{
    id: 'dim-unit-1',
    type: 'aligned',
    a: { kind: 'vertex', target: { source: 'stock' }, vertexIndex: 0 },
    b: { kind: 'free', point: { x: 1, y: 2 } },
    offset: 0.5,
    labelOffset: 0.25,
    textOverride: null,
    precisionOverride: null,
    visible: true,
    locked: false,
  }]
  await seedProject(page, JSON.stringify({
    ...project,
    meta: { ...metadata, name: 'Unit conversion fixture', units: 'inch' },
    stock: { ...stock, thickness: 1 },
    annotations,
  }))
}

async function snapshot(page: Parameters<typeof getProject>[0]): Promise<UnitProjectSnapshot> {
  return await getProject(page) as unknown as UnitProjectSnapshot
}

async function chooseUnits(
  page: Parameters<typeof getProject>[0],
  ui: typeof import('./selectors'),
  label: 'Millimeters' | 'Inches',
): Promise<void> {
  await ui.properties.unitsTrigger(page).click()
  await ui.properties.unitsOption(page, label).click()
}

test('unit change waits for Convert, Keep numeric values, or Cancel', async ({ app, ui }) => {
  await seedInchProject(app.page)
  await ui.tree.projectRow(app.page).click()

  const unitsTrigger = ui.properties.unitsTrigger(app.page)
  await expect(unitsTrigger).toContainText('Inches')
  await chooseUnits(app.page, ui, 'Millimeters')

  const dialog = ui.unitConversionDialog.root(app.page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('1 in becomes 25.4 mm')
  expect((await snapshot(app.page)).meta.units).toBe('inch')

  await ui.unitConversionDialog.cancelButton(app.page).click()
  await expect(dialog).not.toBeVisible()
  await expect(unitsTrigger).toContainText('Inches')
  expect((await snapshot(app.page)).meta.units).toBe('inch')

  await chooseUnits(app.page, ui, 'Millimeters')
  await ui.unitConversionDialog.reinterpretButton(app.page).click()
  const reinterpreted = await snapshot(app.page)
  expect(reinterpreted.meta.units).toBe('mm')
  expect(reinterpreted.stock.thickness).toBe(1)
  expect(reinterpreted.annotations[0].b?.point).toEqual({ x: 1, y: 2 })
  expect(reinterpreted.annotations[0].offset).toBe(0.5)

  await seedInchProject(app.page)
  await ui.tree.projectRow(app.page).click()
  await chooseUnits(app.page, ui, 'Millimeters')
  await ui.unitConversionDialog.convertButton(app.page).click()

  const converted = await snapshot(app.page)
  expect(converted.meta.units).toBe('mm')
  expect(converted.stock.thickness).toBeCloseTo(25.4)
  expect(converted.annotations[0].a).toMatchObject({
    kind: 'vertex',
    target: { source: 'stock' },
    vertexIndex: 0,
  })
  expect(converted.annotations[0].b?.point?.x).toBeCloseTo(25.4)
  expect(converted.annotations[0].b?.point?.y).toBeCloseTo(50.8)
  expect(converted.annotations[0].offset).toBeCloseTo(12.7)
})

test.describe('tablet unit conversion dialog', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true })

  test('fits the viewport with touch-sized decisions', async ({ app, ui }) => {
    await seedInchProject(app.page)
    await ui.tree.openProjectPanelButton(app.page).click()
    await ui.tree.projectRow(app.page).click()
    await chooseUnits(app.page, ui, 'Millimeters')

    const dialog = ui.unitConversionDialog.root(app.page)
    await expect(dialog).toBeVisible()
    const dialogBox = await dialog.boundingBox()
    expect(dialogBox).not.toBeNull()
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0)
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(1024)
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(768)

    for (const button of [
      ui.unitConversionDialog.convertButton(app.page),
      ui.unitConversionDialog.reinterpretButton(app.page),
      ui.unitConversionDialog.cancelButton(app.page),
    ]) {
      const buttonBox = await button.boundingBox()
      expect(buttonBox).not.toBeNull()
      expect(buttonBox!.height).toBeGreaterThanOrEqual(44)
    }
  })
})
