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

import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures'
import { getProject, seedProject } from './helpers'


test('surface slope filter edits, validates, switches pattern and survives save/reload', async ({ app, ui }) => {
  const project = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8'))
  project.operations = [project.operations.find((operation: {kind: string}) => operation.kind === 'finish_surface')]
  project.operations[0].name = 'Slope finish'
  await seedProject(app.page, JSON.stringify(project))
  await ui.operations.rowByName(app.page, 'Slope finish').click()
  await ui.cam.operationGroup(app.page, 'Strategy').click()
  const toggle = app.page.getByRole('checkbox', { name: 'Filter by surface slope', exact: true })
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  const minimum = app.page.getByRole('spinbutton', { name: 'Minimum slope (°)', exact: true })
  const maximum = app.page.getByRole('spinbutton', { name: 'Maximum slope (°)', exact: true })
  await expect(minimum).toHaveValue('0')
  await expect(maximum).toHaveValue('30')
  await minimum.fill('40')
  await minimum.press('Enter')
  await expect(app.page.getByRole('alert')).toContainText('minimum no greater than maximum')
  await minimum.fill('5')
  await minimum.press('Enter')
  await expect(app.page.getByRole('alert')).toHaveCount(0)
  await ui.cam.operationField(app.page, 'Pattern').locator('.ui-select__trigger').click()
  await app.page.getByRole('option', { name: 'Waterline', exact: true }).click()
  await expect(toggle).toBeChecked()
  await expect(minimum).toHaveValue('5')
  const saved = await getProject(app.page)
  await app.page.reload()
  await seedProject(app.page, JSON.stringify(saved))
  await ui.operations.rowByName(app.page, 'Slope finish').click()
  if (!(await toggle.isVisible())) await ui.cam.operationGroup(app.page, 'Strategy').click()
  await expect(toggle).toBeChecked()
  await expect(minimum).toHaveValue('5')
  await expect(maximum).toHaveValue('30')
  await toggle.uncheck()
  await expect(minimum).toHaveCount(0)
  const cleared = (await getProject(app.page)).operations as Array<Record<string, unknown>>
  expect(cleared[0].finishSlopeMin).toBeUndefined()
  expect(cleared[0].finishSlopeMax).toBeUndefined()
})


test('ball-endmill finish uses scallop height with collapsed spacing overrides', async ({ app, ui }) => {
  // #720. Scallop height is the primary finish parameter for a ball endmill;
  // the old spacing controls remain available, but only in the collapsed
  // Advanced overrides group and with their implied cusp visible.
  const project = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8'))
  project.operations = [project.operations.find((operation: {kind: string}) => operation.kind === 'finish_surface')]
  project.operations[0].name = 'Scallop finish'
  project.tools[0].type = 'ball_endmill'
  await seedProject(app.page, JSON.stringify(project))
  await ui.operations.rowByName(app.page, 'Scallop finish').click()
  await ui.cam.operationGroup(app.page, 'Strategy').click()

  const pattern = ui.cam.operationField(app.page, 'Pattern')
  const scallopHeight = app.page.locator('.cam-operation-properties .properties-field')
    .filter({ has: app.page.getByText(/^Scallop height(?: \((?:in|mm)\))?$/) })
  const stepover = ui.cam.operationField(app.page, 'Stepover ratio')
  const adaptive = app.page.getByRole('checkbox', { name: /Adaptive refinement/ })
  const advanced = ui.cam.operationGroup(app.page, 'Advanced overrides')
  const selectPattern = async (name: string): Promise<void> => {
    await pattern.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name, exact: true }).click()
    await expect(pattern.locator('.ui-select__label')).toHaveText(name)
  }

  await expect(pattern.locator('.ui-select__label')).toHaveText('Parallel')
  await expect(scallopHeight).toHaveCount(1)
  await expect(stepover).not.toBeVisible()
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await expect(adaptive).toHaveCount(0)

  await selectPattern('Waterline')
  await expect(adaptive).toBeChecked()
  await expect(app.page.getByText('Waterline uses the assumed 30° steep threshold.', { exact: true })).toBeVisible()
  await expect(ui.cam.operationField(app.page, 'Adaptive spacing')).not.toBeVisible()
  await advanced.click()
  const adaptiveSpacing = ui.cam.operationField(app.page, 'Adaptive spacing')
  await expect(adaptiveSpacing).toBeVisible()
  await expect(ui.cam.operationField(app.page, 'Stepdown')).toBeVisible()
  await expect(ui.cam.operationField(app.page, 'Max rings / band')).toBeVisible()
  const cuspNotes = app.page.getByText(/^Implied cusp/)
  await expect(cuspNotes).toHaveCount(2)
  const before = await cuspNotes.last().textContent()
  await adaptiveSpacing.locator('input').fill('0.02')
  await adaptiveSpacing.locator('input').blur()
  await expect(cuspNotes.last()).not.toHaveText(before ?? '')

  await selectPattern('Constant scallop')
  await expect(stepover).toHaveCount(0)
  await expect(advanced).toHaveCount(0)
  await expect(ui.cam.operationField(app.page, 'Stepdown')).toHaveCount(0)
  await expect(adaptive).toHaveCount(0)
  await expect(ui.cam.operationField(app.page, 'Adaptive spacing')).toHaveCount(0)
  await expect(ui.cam.operationField(app.page, 'Max rings / band')).toHaveCount(0)
  await expect(app.page.getByText(/^Implied cusp/)).toHaveCount(0)
  await scallopHeight.locator('input').fill('0.001')
  await scallopHeight.locator('input').blur()
  const stored = (await getProject(app.page)).operations as Array<Record<string, unknown>>
  expect(stored[0].pocketPattern).toBe('constant_scallop')
  expect(stored[0].finishScallopHeight).toBe(0.001)

  const saved = await getProject(app.page)
  await app.page.reload()
  await seedProject(app.page, JSON.stringify(saved))
  await ui.operations.rowByName(app.page, 'Scallop finish').click()
  if (!(await pattern.isVisible())) await ui.cam.operationGroup(app.page, 'Strategy').click()
  await expect(pattern.locator('.ui-select__label')).toHaveText('Constant scallop')
  await expect(scallopHeight.locator('input')).toHaveValue('0.001')
})

test('parallel scallop height shows the stored value and a click-through keeps it', async ({ app, ui }) => {
  // #893. A 1/16 in ball at 0.1 stepover defaults to 0.00016 in; the field
  // used to show 0.0002 and write that back on blur, a 28 % taller cusp. An
  // older project can hold an unrounded default, which must survive too.
  for (const [index, [height, shown]] of ([[0.00016, '0.00016'], [0.0006265703616725044, '0.00062657036']] as const).entries()) {
    if (index > 0) await app.page.reload()
    const project = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8'))
    project.operations = [project.operations.find((operation: {kind: string}) => operation.kind === 'finish_surface')]
    project.operations[0].name = 'Scallop finish'
    project.operations[0].finishScallopHeight = height
    project.tools[0].type = 'ball_endmill'
    await seedProject(app.page, JSON.stringify(project))
    await ui.operations.rowByName(app.page, 'Scallop finish').click()
    const strategy = ui.cam.operationGroup(app.page, 'Strategy')
    await expect(strategy).toBeVisible()
    if ((await strategy.getAttribute('aria-expanded')) === 'false') await strategy.click()

    const pattern = ui.cam.operationField(app.page, 'Pattern')
    await expect(pattern.locator('.ui-select__label')).toHaveText('Parallel')
    const input = app.page.locator('.cam-operation-properties .properties-field')
      .filter({ has: app.page.getByText(/^Scallop height$/) })
      .locator('input')
    await expect(input).toHaveValue(shown)
    await input.focus()
    await input.blur()
    const stored = (await getProject(app.page)).operations as Array<Record<string, unknown>>
    expect(stored[0].finishScallopHeight).toBe(height)
  }
})

test('a set scallop height hides the overrides it replaces', async ({ app, ui }) => {
  // #894. A ball-endmill scallop height sets the pass spacing (and the
  // waterline Z step), so those overrides hide; 0 hands control back.
  const project = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8'))
  project.operations = [project.operations.find((operation: {kind: string}) => operation.kind === 'finish_surface')]
  project.operations[0].name = 'Scallop finish'
  project.operations[0].finishScallopHeight = 0.001
  project.tools[0].type = 'ball_endmill'
  await seedProject(app.page, JSON.stringify(project))
  await ui.operations.rowByName(app.page, 'Scallop finish').click()
  await ui.cam.operationGroup(app.page, 'Strategy').click()

  const pattern = ui.cam.operationField(app.page, 'Pattern')
  const scallopHeight = app.page.locator('.cam-operation-properties .properties-field')
    .filter({ has: app.page.getByText(/^Scallop height$/) })
  const advanced = ui.cam.operationGroup(app.page, 'Advanced overrides')
  const stepover = ui.cam.operationField(app.page, 'Stepover ratio')
  const stepdown = ui.cam.operationField(app.page, 'Stepdown')
  const adaptiveSpacing = ui.cam.operationField(app.page, 'Adaptive spacing')
  const maxRings = ui.cam.operationField(app.page, 'Max rings / band')
  const setHeight = async (value: string): Promise<void> => {
    await scallopHeight.locator('input').fill(value)
    await scallopHeight.locator('input').blur()
  }

  await expect(pattern.locator('.ui-select__label')).toHaveText('Parallel')
  await expect(app.page.getByText('Set to 0 to space the passes with the advanced overrides instead.', { exact: true })).toBeVisible()
  await advanced.click()
  await expect(stepdown).toBeVisible()
  await expect(stepover).toHaveCount(0)
  await setHeight('0')
  await expect(stepover).toBeVisible()

  await setHeight('0.001')
  await pattern.locator('.ui-select__trigger').click()
  await app.page.getByRole('option', { name: 'Waterline', exact: true }).click()
  await expect(pattern.locator('.ui-select__label')).toHaveText('Waterline')
  await expect(maxRings).toBeVisible()
  await expect(stepdown).toHaveCount(0)
  await expect(adaptiveSpacing).toHaveCount(0)
  await setHeight('0')
  await expect(stepdown).toBeVisible()
  await expect(adaptiveSpacing).toBeVisible()
  const stored = (await getProject(app.page)).operations as Array<Record<string, unknown>>
  expect(stored[0].finishScallopHeight).toBe(0)
})

test('flat-endmill finish keeps legacy spacing controls', async ({ app, ui }) => {
  const project = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8'))
  project.operations = [project.operations.find((operation: {kind: string}) => operation.kind === 'finish_surface')]
  project.operations[0].name = 'Flat finish'
  await seedProject(app.page, JSON.stringify(project))
  await ui.operations.rowByName(app.page, 'Flat finish').click()
  await ui.cam.operationGroup(app.page, 'Strategy').click()

  await expect(ui.cam.operationField(app.page, 'Scallop height')).toHaveCount(0)
  const advanced = ui.cam.operationGroup(app.page, 'Advanced overrides')
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await advanced.click()
  await expect(ui.cam.operationField(app.page, 'Stepover ratio')).toBeVisible()
})

test.describe('Constant scallop single quality control on tablet', () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true })

  for (const units of ['mm', 'inch'] as const) {
    for (const legacyHeight of [undefined, 0]) {
      test(`preserves legacy ${String(legacyHeight)} height in ${units} until a valid edit`, async ({ app, ui }) => {
        const project = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8'))
        project.meta.units = units
        project.operations = [project.operations.find((operation: { kind: string }) => operation.kind === 'finish_surface')]
        Object.assign(project.operations[0], {
          name: 'Legacy scallop', pocketPattern: 'constant_scallop', stepover: 0.1,
          finishScallopHeight: legacyHeight,
        })
        Object.assign(project.tools[0], { type: 'ball_endmill', units, diameter: 4 })
        await seedProject(app.page, JSON.stringify(project))
        const before = await getProject(app.page)
        await app.page.getByRole('button', { name: 'Open operations panel' }).click()
        await ui.operations.rowByName(app.page, 'Legacy scallop').click()
        await app.page.getByRole('button', { name: 'Expand operation properties' }).click()
        const dialog = app.page.locator('.dialog--panel-expand')
        const field = dialog.locator('.properties-field').filter({
          has: app.page.getByText(`Scallop height (${units === 'inch' ? 'in' : 'mm'})`, { exact: true }),
        })
        if (!(await field.isVisible())) await dialog.getByRole('button', { name: 'Strategy', exact: true }).click()
        const input = field.locator('input')
        const expectedHeight = 2 - Math.sqrt(4 - 0.4 ** 2 / 4)
        expect(Number(await input.inputValue())).toBeCloseTo(expectedHeight, 8)
        await expect(dialog.getByText('Height of the ridges between passes. Smaller values give a finer finish and longer machining time.', { exact: true })).toBeVisible()
        await expect(ui.cam.operationGroup(app.page, 'Advanced overrides')).toHaveCount(0)
        await expect(ui.cam.operationField(app.page, 'Stepdown')).toHaveCount(0)
        await expect(ui.cam.operationField(app.page, 'Stepover ratio')).toHaveCount(0)
        await app.page.screenshot({ path: test.info().outputPath('constant-scallop.png') })
        await input.focus()
        await input.blur()
        expect((await getProject(app.page)).operations).toEqual(before.operations)

        for (const value of ['0', '-0.1', '', '2', 'abc']) {
          await input.fill(value)
          await input.blur()
          await expect(input).toHaveAttribute('aria-invalid', 'true')
          await expect(app.page.getByRole('alert')).toContainText('Enter a height greater than zero')
          expect((await getProject(app.page)).operations).toEqual(before.operations)
        }
        await input.focus()
        await input.press('Escape')
        // Escape also closes the expanded dialog; reopening must not commit
        // either an invalid draft or the rounded legacy display value.
        if (!(await dialog.isVisible())) {
          await app.page.getByRole('button', { name: 'Expand operation properties' }).click()
        }
        await expect(input).toHaveAttribute('aria-invalid', 'false')
        expect((await getProject(app.page)).operations).toEqual(before.operations)

        await input.fill('0.00001234')
        await input.press('Enter')
        const edited = await getProject(app.page)
        const operation = (edited.operations as Array<Record<string, unknown>>)[0]
        expect(operation.finishScallopHeight).toBe(0.00001234)
        expect(operation.stepover).toBe(0.1)
        await expect(input).toHaveValue('0.00001234')
        await app.page.reload()
        await seedProject(app.page, JSON.stringify(edited))
        await app.page.getByRole('button', { name: 'Open operations panel' }).click()
        await ui.operations.rowByName(app.page, 'Legacy scallop').click()
        await app.page.getByRole('button', { name: 'Expand operation properties' }).click()
        if (!(await field.isVisible())) await dialog.getByRole('button', { name: 'Strategy', exact: true }).click()
        await expect(input).toHaveValue('0.00001234')
        await input.focus()
        await input.blur()
        expect((await getProject(app.page)).operations).toEqual(edited.operations)
      })
    }
  }
})
