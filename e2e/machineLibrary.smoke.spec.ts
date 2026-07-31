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
  await expect(comparison).not.toContainText('My Machines')
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
  await expect(ui.machineManager.groupLabel(app.page, 'My Machines')).toBeVisible()
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
  await expect(ui.machineManager.badge(app.page, 'Not in My Machines')).toBeVisible()
  await ui.machineManager.saveToMyMachinesButton(app.page).click()
  await expect(ui.machineManager.groupLabel(app.page, 'In this project')).toBeHidden()

  await ui.machineManager.doneButton(app.page).click()
  await expect(ui.properties.machineStatus(app.page)).not.toContainText('Not in My Machines')
})
