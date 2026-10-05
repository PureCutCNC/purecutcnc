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
 * Application machine library smoke (issue #403): custom machines persist
 * across projects and restarts, selecting embeds exactly one snapshot, the
 * update warning is non-blocking and never auto-applies, and deleting a
 * library machine leaves an existing project untouched.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  e2eMachineDefinition,
  embeddedMachine,
  seedMachineProject,
} from './machineLibrary.helpers'

const CUSTOM_MACHINES_KEY = 'purecutcnc.machines.customMachines'

async function openManager(page: Page, ui: typeof import('./selectors')): Promise<void> {
  const drawerButton = ui.tree.openProjectPanelButton(page)
  if (await drawerButton.isVisible()) await drawerButton.click()
  await ui.tree.projectRow(page).click()
  await ui.properties.manageMachines(page).click()
  await expect(ui.machineManager.dialog(page)).toBeVisible()
}

async function readStorage(page: Page, key: string): Promise<string | null> {
  return page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key)
}

test('custom machines live in My Machines and survive project changes and restarts', async ({ app, ui }) => {
  await seedMachineProject(app.page)
  await openManager(app.page, ui)

  // The library always exposes the current build's bundled machines, even
  // though the project embeds none of them.
  await expect(ui.machineManager.groupLabel(app.page, 'Built-in machines')).toBeVisible()
  await expect(ui.machineManager.item(app.page, 'GRBL 1.1')).toBeVisible()
  expect((await embeddedMachine(app.page)).definitions).toHaveLength(0)

  // Duplicating a built-in creates an editable custom machine.
  await ui.machineManager.item(app.page, 'GRBL 1.1').click()
  await ui.machineManager.duplicateButton(app.page).click()
  await expect(ui.machineEditor.dialog(app.page)).toBeVisible()
  await ui.machineEditor.saveButton(app.page).click()
  await expect(ui.machineEditor.dialog(app.page)).toBeHidden()

  await expect(ui.machineManager.item(app.page, 'GRBL 1.1 (copy)')).toBeVisible()
  expect(await readStorage(app.page, CUSTOM_MACHINES_KEY)).toContain('GRBL 1.1 (copy)')

  // Selecting embeds exactly one complete snapshot in the project.
  await ui.machineManager.useButton(app.page).click()
  const embedded = await embeddedMachine(app.page)
  expect(embedded.definitions).toHaveLength(1)
  expect(embedded.selectedMachineId).toBe(embedded.definitions[0].id)
  expect(embedded.definitions[0].name).toBe('GRBL 1.1 (copy)')
  await ui.machineManager.doneButton(app.page).click()

  // A different project still sees the custom machine in the library, and
  // the library never leaks into the new project's own snapshot.
  await seedMachineProject(app.page, { name: 'Second project' })
  expect((await embeddedMachine(app.page)).definitions).toHaveLength(0)
  await openManager(app.page, ui)
  await expect(ui.machineManager.item(app.page, 'GRBL 1.1 (copy)')).toBeVisible()
  await ui.machineManager.doneButton(app.page).click()

  // And across an application restart.
  await app.page.reload()
  await app.page.waitForSelector('canvas', { timeout: 15000 })
  await openManager(app.page, ui)
  await expect(ui.machineManager.item(app.page, 'GRBL 1.1 (copy)')).toBeVisible()
})

test('a ShopBot duplicate keeps its output format and offers no G-code fields', async ({ app, ui }) => {
  await seedMachineProject(app.page)
  await openManager(app.page, ui)

  // The ShopBot machine does not export G-code (issue #953), so its editor
  // explains that instead of offering command words that would change nothing.
  await ui.machineManager.item(app.page, 'ShopBot (SBP)').click()
  await ui.machineManager.duplicateButton(app.page).click()
  const editor = ui.machineEditor.dialog(app.page)
  await expect(editor).toBeVisible()
  await expect(editor).toContainText('This machine exports ShopBot part files')
  await expect(editor.getByText('File extension', { exact: true })).toBeVisible()
  await expect(editor.getByText('Units — mm command', { exact: true })).toHaveCount(0)
  await expect(editor.getByText('Operation header', { exact: true })).toHaveCount(0)
  await expect(editor.getByText('Flood on', { exact: true })).toHaveCount(0)
  await expect(editor.getByText('Variables reference', { exact: true })).toHaveCount(0)
  await ui.machineEditor.saveButton(app.page).click()
  await expect(editor).toBeHidden()

  // The copy is still a ShopBot machine once it is the project's machine.
  await ui.machineManager.useButton(app.page).click()
  const embedded = await embeddedMachine(app.page)
  expect(embedded.definitions[0].name).toBe('ShopBot (SBP) (copy)')
  expect(embedded.definitions[0].outputDialect).toBe('opensbp')
  expect(embedded.definitions[0].fileExtension).toBe('sbp')

  // A G-code machine keeps every field.
  await ui.machineManager.item(app.page, 'GRBL 1.1').click()
  await ui.machineManager.duplicateButton(app.page).click()
  await expect(editor).toBeVisible()
  await expect(editor).not.toContainText('This machine exports ShopBot part files')
  await expect(editor.getByText('Units — mm command', { exact: true })).toBeVisible()
  await expect(editor.getByText('Operation header', { exact: true })).toBeVisible()
  await expect(editor.getByText('Variables reference', { exact: true })).toBeVisible()
  await ui.machineEditor.cancelButton(app.page).click()
})

test('a stale project copy warns without changing anything until asked', async ({ app, ui }) => {
  // The project embeds an older copy of the bundled GRBL definition.
  const staleGrbl = e2eMachineDefinition({ id: 'grbl', name: 'GRBL 1.1', builtin: true })
  await seedMachineProject(app.page, {
    machineDefinitions: [staleGrbl],
    selectedMachineId: 'grbl',
  })

  const notice = ui.machineUpdateNotice.root(app.page)
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('GRBL 1.1')

  // Keep project copy: the snapshot — and therefore the G-code — is untouched.
  await ui.machineUpdateNotice.keepButton(app.page).click()
  await expect(notice).toBeHidden()
  const kept = await embeddedMachine(app.page)
  expect(kept.definitions).toHaveLength(1)
  expect(kept.definitions[0].fileExtension).toBe('nc')
  expect(kept.definitions[0].description).toBe('Fixture controller')

  // The badge persists after the notice is dismissed.
  await ui.tree.projectRow(app.page).click()
  await expect(ui.properties.machineStatus(app.page)).toContainText('Update available')

  // The manager shows the comparison and only then replaces the copy.
  await ui.properties.manageMachines(app.page).click()
  await ui.machineManager.item(app.page, 'GRBL 1.1').first().click()
  const comparison = ui.machineManager.comparison(app.page)
  await expect(comparison).toBeVisible()
  // GRBL is built-in, so the comparison must name the build — not My Machines,
  // which is empty here — and list differences in words, not schema keys.
  await expect(comparison).toContainText('built-in definition in this version')
  await expect(comparison).not.toContainText('My machines')
  await expect(comparison).toContainText('motion commands')
  await expect(comparison).not.toContainText('cannedCycles')
  await ui.machineManager.updateProjectCopyButton(app.page).click()

  const updated = await embeddedMachine(app.page)
  expect(updated.definitions).toHaveLength(1)
  expect(updated.definitions[0].description).not.toBe('Fixture controller')
  await expect(ui.machineManager.comparison(app.page)).toBeHidden()
  await ui.machineManager.doneButton(app.page).click()
  await expect(ui.properties.machineStatus(app.page)).not.toContainText('Update available')
})

test('a project machine missing from the library stays usable and can be saved back', async ({ app, ui }) => {
  await seedMachineProject(app.page, {
    machineDefinitions: [e2eMachineDefinition({ id: 'shop-router', name: 'Shop Router' })],
    selectedMachineId: 'shop-router',
  })

  // Legacy project libraries migrate their custom machines into My Machines,
  // so this one is adopted on open rather than being lost.
  await openManager(app.page, ui)
  await expect(ui.machineManager.groupLabel(app.page, 'My machines')).toBeVisible()
  await expect(ui.machineManager.item(app.page, 'Shop Router')).toBeVisible()

  // Removing it from the library must not touch the project.
  await ui.machineManager.item(app.page, 'Shop Router').first().click()
  await ui.machineManager.removeButton(app.page).click()
  const afterRemoval = await embeddedMachine(app.page)
  expect(afterRemoval.definitions).toHaveLength(1)
  expect(afterRemoval.selectedMachineId).toBe('shop-router')

  // It is now a project-only machine, still usable and re-savable.
  await expect(ui.machineManager.groupLabel(app.page, 'In this project')).toBeVisible()
  await ui.machineManager.item(app.page, 'Shop Router').first().click()
  await expect(ui.machineManager.badge(app.page, 'Not in my machines')).toBeVisible()
  await ui.machineManager.saveToMyMachinesButton(app.page).click()
  await expect(ui.machineManager.groupLabel(app.page, 'In this project')).toBeHidden()

  await ui.machineManager.doneButton(app.page).click()
  await expect(ui.properties.machineStatus(app.page)).not.toContainText('Not in my machines')
})

for (const tablet of [false, true]) {
  test.describe(tablet ? 'plasma machine on landscape tablet' : 'plasma machine on desktop', () => {
    test.use({ viewport: tablet ? { width: 1180, height: 820 } : { width: 1440, height: 900 }, hasTouch: tablet })

    test('QtPlasmaC kind and commands survive focused edits, JSON edits, selection and restart', async ({ app, ui }) => {
      await seedMachineProject(app.page)
      await openManager(app.page, ui)
      await expect(ui.machineManager.item(app.page, 'GRBL 1.1')).toContainText('Router')
      const bundled = ui.machineManager.item(app.page, 'QtPlasmaC (experimental)')
      await expect(bundled).toContainText('Plasma')
      await bundled.click()
      await ui.machineManager.duplicateButton(app.page).click()
      const editor = ui.machineEditor.dialog(app.page)
      const field = (label: string) => ui.machineEditor.field(app.page, label)
      await expect(field('Machine kind')).toHaveValue('plasma')
      await expect(field('Pierce mode')).toHaveValue('controller')
      await expect(field('Torch on command')).toHaveValue('M3 $0 S1')
      await expect(field('Torch off command')).toHaveValue('M5 $0')
      await expect(field('Material select command')).toHaveValue('M190 P{materialNumber}')
      await expect(editor).toContainText('plasma output is not yet implemented')
      await expect(ui.machineEditor.saveButton(app.page)).toBeInViewport()
      await editor.screenshot({ path: test.info().outputPath('plasma-machine.png') })
      // A mandatory command cannot be silently omitted.
      await field('Torch on command').fill('')
      await expect(ui.machineEditor.saveButton(app.page)).toBeDisabled()
      await field('Torch on command').fill('M3 $0 S1')
      await field('Torch off command').fill('M5 $-1')
      await field('THC on command (optional)').fill('')
      await field('THC off command (optional)').fill('')
      await ui.machineEditor.advancedToggle(app.page).click()
      const json = ui.machineEditor.advancedJson(app.page)
      const definition = JSON.parse(await json.inputValue())
      expect(definition.plasma.thcOnCommand).toBeUndefined()
      expect(definition.plasma.thcOffCommand).toBeUndefined()
      definition.coordinateSystem.xAxis = '-X'
      definition.plasma.materialSelectCommand = 'M190 P{materialNumber} (selected)'
      await json.fill(JSON.stringify(definition, null, 2))
      await field('Name').fill('My Plasma Table')
      await field('Torch on command').fill('')
      await expect(ui.machineEditor.saveButton(app.page)).toBeDisabled()
      await field('Torch on command').fill('M3 $0 S1')
      // A later form edit must preserve the current advanced fields.
      expect(JSON.parse(await json.inputValue()).coordinateSystem.xAxis).toBe('-X')
      await ui.machineEditor.saveButton(app.page).click()
      await expect(editor).toBeHidden()
      await ui.machineManager.useButton(app.page).click()
      const embedded = (await embeddedMachine(app.page)).definitions[0]
      expect(embedded.machineKind).toBe('plasma')
      expect(embedded.plasma).toEqual({ torchOnCommand: 'M3 $0 S1', torchOffCommand: 'M5 $-1', materialSelectCommand: 'M190 P{materialNumber} (selected)', pierceMode: 'controller' })
      expect(embedded.coordinateSystem).toEqual({ xAxis: '-X', yAxis: 'Y', zAxis: 'Z' })
      await ui.machineManager.doneButton(app.page).click()
      await app.page.reload()
      await app.page.waitForSelector('canvas', { timeout: 15000 })
      await openManager(app.page, ui)
      await ui.machineManager.item(app.page, 'My Plasma Table').click()
      await ui.machineManager.editButton(app.page).click()
      await expect(field('Torch off command')).toHaveValue('M5 $-1')
      await expect(field('Material select command')).toHaveValue('M190 P{materialNumber} (selected)')
      await expect(field('THC on command (optional)')).toHaveValue('')
      await ui.machineEditor.cancelButton(app.page).click()
    })
  })
}

test('machine kind switches create a validated plasma block and remove it on router conversion', async ({ app, ui }) => {
  await seedMachineProject(app.page)
  await openManager(app.page, ui)
  await ui.machineManager.item(app.page, 'GRBL 1.1').click()
  await ui.machineManager.duplicateButton(app.page).click()
  const field = (label: string) => ui.machineEditor.field(app.page, label)
  await expect(field('Machine kind')).toHaveValue('router')
  await field('Machine kind').selectOption('plasma')
  await expect(ui.machineEditor.saveButton(app.page)).toBeDisabled()
  await field('Torch on command').fill('M3 $0 S1')
  await field('Torch off command').fill('M5 $0')
  await field('Material select command').fill('M190 P{materialNumber}')
  await expect(ui.machineEditor.saveButton(app.page)).toBeEnabled()
  await ui.machineEditor.advancedToggle(app.page).click()
  const json = ui.machineEditor.advancedJson(app.page)
  const definition = JSON.parse(await json.inputValue())
  definition.plasma.pierceMode = 'gcode'
  await json.fill(JSON.stringify(definition))
  await expect(ui.machineEditor.saveButton(app.page)).toBeDisabled()
  await expect(ui.machineEditor.dialog(app.page)).toContainText('G-code-owned piercing is not supported')
  definition.plasma.pierceMode = 'controller'
  await json.fill(JSON.stringify(definition))
  await field('Machine kind').selectOption('router')
  await expect(field('Torch on command')).toHaveCount(0)
  expect(JSON.parse(await json.inputValue()).plasma).toBeUndefined()
  await ui.machineEditor.saveButton(app.page).click()
  await ui.machineManager.useButton(app.page).click()
  expect((await embeddedMachine(app.page)).definitions[0].plasma).toBeUndefined()
})
