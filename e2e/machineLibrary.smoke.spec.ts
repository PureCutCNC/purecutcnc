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
 *
 * #1119 adds the load-time machine report, a template-invalid project copy
 * that is repairable in place even when the library has the same id, and the
 * write-blocked library banner with its reason.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  e2eMachineDefinition,
  embeddedMachine,
  openMachineManager as openManager,
  seedMachineProject,
} from './machineLibrary.helpers'

const CUSTOM_MACHINES_KEY = 'purecutcnc.machines.customMachines'

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

  // A selected machine is retained by the project, never copied into My
  // Machines on open: it is project-only until the user saves it there.
  await openManager(app.page, ui)
  await expect(ui.machineManager.groupLabel(app.page, 'In this project')).toBeVisible()
  await ui.machineManager.item(app.page, 'Shop Router').first().click()
  await expect(ui.machineManager.badge(app.page, 'Not in my machines')).toBeVisible()

  // Saving it to My Machines is the explicit, user-requested copy.
  await ui.machineManager.saveToMyMachinesButton(app.page).click()
  await expect(ui.machineManager.groupLabel(app.page, 'In this project')).toBeHidden()
  await expect(ui.machineManager.item(app.page, 'Shop Router')).toHaveCount(1)

  // Removing it from the library must not touch the project, and a later save
  // must not rescue it back: the user's delete wins.
  await ui.machineManager.item(app.page, 'Shop Router').first().click()
  await ui.machineManager.removeButton(app.page).click()
  const afterRemoval = await embeddedMachine(app.page)
  expect(afterRemoval.definitions).toHaveLength(1)
  expect(afterRemoval.selectedMachineId).toBe('shop-router')

  // It is project-only again, still usable and re-savable.
  await expect(ui.machineManager.groupLabel(app.page, 'In this project')).toBeVisible()
  await ui.machineManager.item(app.page, 'Shop Router').first().click()
  await expect(ui.machineManager.badge(app.page, 'Not in my machines')).toBeVisible()
  await ui.machineManager.saveToMyMachinesButton(app.page).click()
  await expect(ui.machineManager.groupLabel(app.page, 'In this project')).toBeHidden()

  await ui.machineManager.doneButton(app.page).click()
  await expect(ui.properties.machineStatus(app.page)).not.toContainText('Not in my machines')
})

test('a template-invalid project copy is repaired in place without touching the library', async ({ app, ui }) => {
  // The project embeds a GRBL copy whose header breaks the program-header rule
  // (#1119). The library has a valid GRBL entry with the same id, so the
  // project's own row is the only thing that can be repaired.
  const base = e2eMachineDefinition({ id: 'grbl', name: 'GRBL 1.1', builtin: true })
  const invalid = {
    ...base,
    program: { ...(base.program as Record<string, unknown>), header: ['G90', 'G90.1'] },
  }

  let alertMessage = ''
  app.page.on('dialog', async (dialog) => {
    alertMessage = dialog.message()
    await dialog.accept()
  })
  await seedMachineProject(app.page, {
    machineDefinitions: [invalid],
    selectedMachineId: 'grbl',
  })
  await expect.poll(() => alertMessage).toContain('export is blocked')
  expect(alertMessage).toContain('GRBL 1.1')

  // The update notice points at the library copy; keep the project's copy.
  const notice = ui.machineUpdateNotice.root(app.page)
  await expect(notice).toBeVisible()
  await ui.machineUpdateNotice.keepButton(app.page).click()

  await openManager(app.page, ui)
  await expect(ui.machineManager.groupLabel(app.page, 'In this project')).toBeVisible()
  // Both rows share the name; the project copy is the second row.
  await ui.machineManager.item(app.page, 'GRBL 1.1').last().click()
  await expect(ui.machineManager.badge(app.page, 'Project copy')).toBeVisible()

  const diagnostics = ui.machineManager.diagnostics(app.page)
  await expect(diagnostics).toContainText('program.header')
  await expect(diagnostics).toContainText('G90.1')
  await expect(diagnostics).toContainText('program header')

  // Editing the project copy is allowed even though the library has the id.
  await ui.machineManager.editButton(app.page).click()
  const editor = ui.machineEditor.dialog(app.page)
  await expect(editor).toBeVisible()
  await expect(ui.machineEditor.diagnostics(app.page)).toContainText('G90.1')
  await ui.machineEditor.field(app.page, 'Header').fill('G90')
  await expect(ui.machineEditor.diagnostics(app.page)).toHaveCount(0)
  await ui.machineEditor.saveButton(app.page).click()
  await expect(editor).toBeHidden()

  // The project's snapshot is the repaired one; the library entry was never
  // written (it is the bundled definition and stays byte-identical).
  const repaired = await embeddedMachine(app.page)
  expect(repaired.definitions[0].program).toMatchObject({ header: ['G90'] })
  const removedNotice = await readStorage(app.page, CUSTOM_MACHINES_KEY)
  expect(removedNotice ?? '').not.toContain('G90.1')
  await expect(ui.machineManager.groupLabel(app.page, 'In this project')).toBeHidden()
  await ui.machineManager.doneButton(app.page).click()
})

test('a machine library that cannot be read is shown with its reason', async ({ app, ui }) => {
  await seedMachineProject(app.page)
  await app.page.evaluate((key) => window.localStorage.setItem(key, '{ not json'), CUSTOM_MACHINES_KEY)
  await app.page.reload()
  await app.page.waitForSelector('canvas', { timeout: 15000 })

  await openManager(app.page, ui)
  const notices = ui.machineManager.libraryNotices(app.page)
  await expect(notices).toContainText('could not be read')
  await expect(notices).toContainText('preserved unchanged')
  await ui.machineManager.doneButton(app.page).click()
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
      const kindBadge = bundled.locator('.machine-manager-badge--kind')
      await expect(kindBadge).toHaveText('Plasma')
      expect(await kindBadge.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
      await bundled.click()
      await ui.machineManager.dialog(app.page).screenshot({ path: test.info().outputPath('plasma-library.png') })
      await ui.machineManager.duplicateButton(app.page).click()
      const editor = ui.machineEditor.dialog(app.page)
      const field = (label: string) => ui.machineEditor.field(app.page, label)
      await expect(field('Machine kind')).toHaveValue('plasma')
      await expect(field('Pierce mode')).toHaveValue('controller')
      await expect(field('Torch on command')).toHaveValue('M3 $0 S1')
      await expect(field('Torch off command')).toHaveValue('M5 $0')
      await expect(field('Material select command')).toHaveValue('M190 P{materialNumber}')
      await expect(field('Material wait command')).toHaveValue('M66 P3 L3 Q1')
      await expect(field('Material feed command')).toHaveValue('F#<_hal[plasmac.cut-feed-rate]>')
      await expect(editor).toContainText('plasma output is not yet implemented')
      await expect(ui.machineEditor.saveButton(app.page)).toBeInViewport()
      await editor.screenshot({ path: test.info().outputPath('plasma-machine.png') })
      // A mandatory command cannot be silently omitted.
      await field('Torch on command').fill('')
      await expect(ui.machineEditor.saveButton(app.page)).toBeDisabled()
      await field('Torch on command').fill('M3 $0 S1')
      await field('Torch off command').fill('M5 $-1')
      await field('THC on command (optional)').fill('  ')
      await field('THC off command (optional)').fill('')
      await ui.machineEditor.advancedToggle(app.page).click()
      const json = ui.machineEditor.advancedJson(app.page)
      const definition = JSON.parse(await json.inputValue())
      expect(definition.plasma.thcOnCommand).toBeUndefined()
      expect(definition.plasma.thcOffCommand).toBeUndefined()
      definition.coordinateSystem.xAxis = '-X'
      definition.plasma.materialWaitCommand = 'M66 P3 L3 Q2'
      definition.plasma.materialFeedCommand = 'F#<_hal[plasmac.cut-feed-rate]> (loaded)'
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
      expect(embedded.plasma).toEqual({ torchOnCommand: 'M3 $0 S1', torchOffCommand: 'M5 $-1', materialSelectCommand: 'M190 P{materialNumber} (selected)', materialWaitCommand: 'M66 P3 L3 Q2', materialFeedCommand: 'F#<_hal[plasmac.cut-feed-rate]> (loaded)', pierceMode: 'controller' })
      expect(embedded.coordinateSystem).toEqual({ xAxis: '-X', yAxis: 'Y', zAxis: 'Z' })
      await ui.machineManager.doneButton(app.page).click()
      await app.page.reload()
      await app.page.waitForSelector('canvas', { timeout: 15000 })
      await openManager(app.page, ui)
      await ui.machineManager.item(app.page, 'My Plasma Table').click()
      await ui.machineManager.editButton(app.page).click()
      await expect(field('Torch off command')).toHaveValue('M5 $-1')
      await expect(field('Material select command')).toHaveValue('M190 P{materialNumber} (selected)')
      await expect(field('Material wait command')).toHaveValue('M66 P3 L3 Q2')
      await expect(field('Material feed command')).toHaveValue('F#<_hal[plasmac.cut-feed-rate]> (loaded)')
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
  await field('Material wait command').fill('M66 P3 L3 Q1')
  await field('Material feed command').fill('F#<_hal[plasmac.cut-feed-rate]>')
  await expect(ui.machineEditor.saveButton(app.page)).toBeEnabled()
  await ui.machineEditor.advancedToggle(app.page).click()
  const json = ui.machineEditor.advancedJson(app.page)
  const definition = JSON.parse(await json.inputValue())
  definition.plasma.pierceMode = 'gcode'
  await json.fill(JSON.stringify(definition))
  await expect(ui.machineEditor.saveButton(app.page)).toBeDisabled()
  await expect(ui.machineEditor.dialog(app.page)).toContainText('G-code piercing has no material sequence. (at plasma.materialSelectCommand)')
  await expect(ui.machineEditor.dialog(app.page)).not.toContainText('"code"')
  definition.plasma.pierceMode = 'controller'
  await json.fill(JSON.stringify(definition))
  await expect(ui.machineEditor.saveButton(app.page)).toBeEnabled()
  await field('Machine kind').selectOption('router')
  await expect(field('Torch on command')).toHaveCount(0)
  expect(JSON.parse(await json.inputValue()).plasma).toBeUndefined()
  await ui.machineEditor.saveButton(app.page).click()
  await ui.machineManager.useButton(app.page).click()
  expect((await embeddedMachine(app.page)).definitions[0].plasma).toBeUndefined()
})

test('G-code piercing swaps the material sequence for touch-off settings', async ({ app, ui }) => {
  await seedMachineProject(app.page)
  await openManager(app.page, ui)
  await ui.machineManager.item(app.page, 'Grbl plasma (OpenBuilds CONTROL) (experimental)').click()
  await ui.machineManager.duplicateButton(app.page).click()
  const field = (label: string) => ui.machineEditor.field(app.page, label)
  await expect(field('Pierce mode')).toHaveValue('gcode')
  await expect(field('Material select command')).toHaveCount(0)
  await expect(field('Probe command')).toHaveValue('G38.2')
  await expect(field('Probe depth below Z zero (mm)')).toHaveValue('30')
  await expect(field('Touch-off switch offset (mm)')).toHaveValue('0')
  await expect(field('Probe depth below Z zero (mm)')).toHaveAttribute('min', '0.001')
  await expect(field('Probe feed (mm/min)')).toHaveAttribute('min', '0.001')
  await expect(field('Touch-off switch offset (mm)')).toHaveAttribute('min', '0')
  await field('Touch-off switch offset (mm)').fill('1.5')
  await ui.machineEditor.advancedToggle(app.page).click()
  const json = ui.machineEditor.advancedJson(app.page)
  expect(JSON.parse(await json.inputValue()).plasma.touchOff.switchOffset).toBe(1.5)
  await field('Probe depth below Z zero (mm)').fill('')
  await expect(ui.machineEditor.saveButton(app.page)).toBeDisabled()
  await field('Probe depth below Z zero (mm)').fill('40')
  await expect(ui.machineEditor.saveButton(app.page)).toBeEnabled()
  await field('Pierce mode').selectOption('controller')
  await expect(field('Probe command')).toHaveCount(0)
  await expect(field('Material select command')).toHaveValue('')
  await expect(ui.machineEditor.saveButton(app.page)).toBeDisabled()
  await field('Pierce mode').selectOption('gcode')
  await expect(ui.machineEditor.saveButton(app.page)).toBeEnabled()
  await ui.machineEditor.saveButton(app.page).click()
  await ui.machineManager.useButton(app.page).click()
  expect((await embeddedMachine(app.page)).definitions[0].plasma.touchOff).toEqual({
    probeCommand: 'G38.2', probeDepth: 40, probeFeed: 100, setZeroCommand: 'G10 L20 P0', switchOffset: 1.5,
  })
})

test('invalid Advanced plasma metadata stays invalid across focused edits until corrected', async ({ app, ui }) => {
  await seedMachineProject(app.page)
  await openManager(app.page, ui)
  await ui.machineManager.item(app.page, 'QtPlasmaC (experimental)').click()
  await ui.machineManager.duplicateButton(app.page).click()
  await ui.machineEditor.advancedToggle(app.page).click()
  const json = ui.machineEditor.advancedJson(app.page)
  const definition = JSON.parse(await json.inputValue())
  delete definition.machineKind
  await json.fill(JSON.stringify(definition))
  await expect(ui.machineEditor.saveButton(app.page)).toBeDisabled()
  await expect(ui.machineEditor.dialog(app.page)).toContainText('A plasma block requires machineKind: plasma')
  await ui.machineEditor.field(app.page, 'Name').fill('Focused edit while invalid')
  await expect(ui.machineEditor.saveButton(app.page)).toBeDisabled()
  expect(JSON.parse(await json.inputValue()).plasma).toEqual(definition.plasma)
  expect(JSON.parse(await json.inputValue()).machineKind).toBeUndefined()
  definition.machineKind = 'plasma'
  await json.fill(JSON.stringify(definition))
  await expect(ui.machineEditor.saveButton(app.page)).toBeEnabled()
  await ui.machineEditor.field(app.page, 'Torch on command').fill('  M3 $0 S1  ')
  expect(JSON.parse(await json.inputValue()).plasma.torchOnCommand).toBe('  M3 $0 S1  ')
  await ui.machineEditor.saveButton(app.page).click()
})

test('OpenSBP machines hide plasma controls and reject Advanced plasma kind', async ({ app, ui }) => {
  await seedMachineProject(app.page)
  await openManager(app.page, ui)
  await ui.machineManager.item(app.page, 'ShopBot (SBP)').click()
  await ui.machineManager.duplicateButton(app.page).click()
  await expect(ui.machineEditor.field(app.page, 'Machine kind')).toHaveCount(0)
  await expect(ui.machineEditor.field(app.page, 'Torch on command')).toHaveCount(0)
  await ui.machineEditor.advancedToggle(app.page).click()
  const json = ui.machineEditor.advancedJson(app.page)
  const definition = JSON.parse(await json.inputValue())
  definition.machineKind = 'plasma'
  await json.fill(JSON.stringify(definition))
  await expect(ui.machineEditor.saveButton(app.page)).toBeDisabled()
  await expect(ui.machineEditor.dialog(app.page)).toContainText('Plasma machines require the G-code output dialect')
})

test('the rotary axis group writes, persists and clears a rotary block (#393)', async ({ app, ui }) => {
  await seedMachineProject(app.page)
  await openManager(app.page, ui)
  await ui.machineManager.item(app.page, 'GRBL 1.1').click()
  await ui.machineManager.duplicateButton(app.page).click()

  const editor = ui.machineEditor.dialog(app.page)
  const axis = ui.machineEditor.rotaryAxis(app.page)
  const drive = ui.machineEditor.rotaryDrive(app.page)
  const reversed = ui.machineEditor.rotaryReversed(app.page)
  const word = ui.machineEditor.rotaryWord(app.page)
  await expect(editor).toBeVisible()
  await expect(axis).toHaveValue('none')
  await expect(drive).toHaveCount(0)
  await expect(reversed).toHaveCount(0)

  // The drive and reverse controls appear with the axis, and the word is A.
  await axis.selectOption('x')
  await expect(drive).toBeVisible()
  await expect(reversed).toBeVisible()
  await expect(word).toHaveText('Program word: A')

  // Borrowing the Y motor names the project axis across the bar and shows the
  // word the program will use.
  await expect(drive.locator('option[value="borrowed"]')).toHaveText('The Y motor')
  await drive.selectOption('borrowed')
  await expect(word).toHaveText('Program word: Y')
  await reversed.check()

  await ui.machineEditor.saveButton(app.page).click()
  await expect(editor).toBeHidden()

  // The manager's preview summarizes the axis.
  await expect(ui.machineManager.rotarySummary(app.page))
    .toHaveText('Bar along X, on the Y motor (word Y)')

  // Reopening keeps every choice, and the raw JSON carries the block.
  await ui.machineManager.editButton(app.page).click()
  await expect(editor).toBeVisible()
  await expect(ui.machineEditor.rotaryAxis(app.page)).toHaveValue('x')
  await expect(ui.machineEditor.rotaryDrive(app.page)).toHaveValue('borrowed')
  await expect(ui.machineEditor.rotaryReversed(app.page)).toBeChecked()
  await expect(ui.machineEditor.rotaryWord(app.page)).toHaveText('Program word: Y')
  await ui.machineEditor.advancedToggle(app.page).click()
  const json = ui.machineEditor.advancedJson(app.page)
  expect(JSON.parse(await json.inputValue()).rotary).toEqual({
    about: 'x', drive: 'borrowed', reversed: true, inverseTimeFeed: { on: 'G93', off: 'G94' },
  })

  // The word follows the definition's coordinate system, not a hard-coded
  // letter: mapping project Y to machine X makes the borrowed word X.
  const mapped = JSON.parse(await json.inputValue())
  mapped.coordinateSystem.yAxis = 'X'
  await json.fill(JSON.stringify(mapped, null, 2))
  await expect(ui.machineEditor.rotaryWord(app.page)).toHaveText('Program word: X')

  // None removes the block, from the form and from the saved definition.
  await ui.machineEditor.rotaryAxis(app.page).selectOption('none')
  await expect(ui.machineEditor.rotaryDrive(app.page)).toHaveCount(0)
  expect(JSON.parse(await json.inputValue()).rotary).toBeUndefined()
  await ui.machineEditor.saveButton(app.page).click()
  await expect(editor).toBeHidden()
  await expect(ui.machineManager.rotarySummary(app.page)).toHaveCount(0)
  await ui.machineManager.editButton(app.page).click()
  // The Advanced section remembers that it was opened above.
  const reopened = ui.machineEditor.advancedJson(app.page)
  expect(JSON.parse(await reopened.inputValue()).rotary).toBeUndefined()
  await ui.machineEditor.cancelButton(app.page).click()

  // A plasma machine cannot have a rotary axis, so the group is absent.
  await ui.machineManager.item(app.page, 'QtPlasmaC (experimental)').click()
  await ui.machineManager.duplicateButton(app.page).click()
  await expect(editor).toBeVisible()
  await expect(ui.machineEditor.rotaryAxis(app.page)).toHaveCount(0)
  await expect(ui.machineEditor.rotaryDrive(app.page)).toHaveCount(0)
  await ui.machineEditor.cancelButton(app.page).click()
})
