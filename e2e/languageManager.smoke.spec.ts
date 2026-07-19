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
 * Language manager + custom-language editor smoke (issue #314 phase 6):
 * duplicate English into a new pack, translate a key, apply and activate,
 * reload persistence, the placeholder-parity Apply gate, and preview with
 * Cancel rollback. Import/export envelope logic is unit-covered in
 * `src/i18n/registry.test.ts`.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { getProject } from './helpers'

function withoutModified(snapshot: Record<string, unknown>): Record<string, unknown> {
  const meta = snapshot.meta as Record<string, unknown>
  const { modified: _modified, ...stableMeta } = meta
  return { ...snapshot, meta: stableMeta }
}

/** Open Language → Manage languages. */
async function openManager(page: Page, ui: typeof import('./selectors')): Promise<void> {
  await ui.language.trigger(page).click()
  await ui.language.manageEntry(page).click()
  await expect(ui.languageManager.dialog(page)).toBeVisible()
}

/** Duplicate the currently selected locale; the editor opens on the copy. */
async function duplicateToEditor(page: Page, ui: typeof import('./selectors')): Promise<void> {
  await ui.languageManager.duplicateButton(page).click()
  await expect(ui.languageEditor.dialog(page)).toBeVisible()
}

test('duplicates English, translates a key, applies, activates, and persists', async ({ app, ui }) => {
  const before = await getProject(app.page)
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'en')

  await openManager(app.page, ui)
  await duplicateToEditor(app.page, ui)

  await expect(ui.languageEditor.nameInput(app.page)).toHaveValue('English copy')
  await ui.languageEditor.nameInput(app.page).fill('Deutsch (Test)')
  await ui.languageEditor.tagInput(app.page).fill('de')

  // Search opens the matching section and narrows to the key's row.
  await ui.languageEditor.searchInput(app.page).fill('file.saveProject')
  await ui.languageEditor.keyInput(app.page, 'file.saveProject').fill('Projekt speichern')

  await ui.languageEditor.applyButton(app.page).click()
  await expect(ui.languageEditor.dialog(app.page)).toBeHidden()

  // Applied but not yet active: the manager shows the pack, English still on.
  await expect(ui.languageManager.detailName(app.page)).toHaveText('Deutsch (Test)')
  await expect(ui.languageManager.progress(app.page)).toContainText('1 of')
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'en')

  await ui.languageManager.useButton(app.page).click()
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'de')
  await ui.languageManager.doneButton(app.page).click()

  // The translated key shows in the toolbar; everything else falls back.
  await expect(app.page.getByRole('button', { name: 'Projekt speichern' })).toBeVisible()
  await expect(app.page.getByRole('button', { name: 'New project' })).toBeVisible()
  await expect(ui.language.trigger(app.page)).toHaveAttribute('aria-label', 'Language: Deutsch (Test)')

  // Language work never touches the project.
  expect(withoutModified(await getProject(app.page))).toEqual(withoutModified(before))

  // Persists across reload.
  await app.page.reload()
  await app.page.waitForSelector('canvas', { timeout: 15000 })
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'de')
  await expect(app.page.getByRole('button', { name: 'Projekt speichern' })).toBeVisible()

  // The custom pack is selectable from the language menu.
  await ui.language.trigger(app.page).click()
  await expect(ui.language.option(app.page, 'Deutsch \\(Test\\)')).toHaveAttribute('aria-checked', 'true')
  await ui.language.option(app.page, 'English').click()
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'en')
})

test('flags placeholder mismatches per row and blocks Apply until fixed', async ({ app, ui }) => {
  await openManager(app.page, ui)
  await duplicateToEditor(app.page, ui)

  // "Language: {name}" translated without its placeholder → row flag + gate.
  await ui.languageEditor.searchInput(app.page).fill('language.current')
  await ui.languageEditor.keyInput(app.page, 'language.current').fill('Sprache')

  await expect(ui.languageEditor.rowIssue(app.page)).toBeVisible()
  await expect(ui.languageEditor.rowIssue(app.page)).toContainText('{name}')
  await expect(ui.languageEditor.footerBlocked(app.page)).toContainText('placeholder mismatch')
  await expect(ui.languageEditor.applyButton(app.page)).toBeDisabled()

  // Restoring the placeholder clears the flag and unblocks Apply.
  await ui.languageEditor.keyInput(app.page, 'language.current').fill('Sprache: {name}')
  await expect(ui.languageEditor.rowIssue(app.page)).toHaveCount(0)
  await expect(ui.languageEditor.applyButton(app.page)).toBeEnabled()

  await ui.languageEditor.cancelButton(app.page).click()
  await expect(ui.languageEditor.dialog(app.page)).toBeHidden()
})

test('preview persists the draft live and Cancel restores the saved state', async ({ app, ui }) => {
  await openManager(app.page, ui)
  await duplicateToEditor(app.page, ui)

  await ui.languageEditor.searchInput(app.page).fill('file.saveProject')
  await ui.languageEditor.keyInput(app.page, 'file.saveProject').fill('Projekt speichern')

  await ui.languageEditor.previewButton(app.page).click()
  await expect(ui.languageEditor.previewingNote(app.page)).toBeVisible()

  // The pack is active app-wide while previewing (dialogs overlay the shell,
  // so assert on the language trigger's accessible name).
  await expect(ui.language.trigger(app.page)).toHaveAttribute('aria-label', 'Language: English copy')
  await expect(app.page.getByRole('button', { name: 'Projekt speichern' })).toBeVisible()

  // Cancel rolls back the draft and the previously active language.
  await ui.languageEditor.cancelButton(app.page).click()
  await expect(ui.languageEditor.dialog(app.page)).toBeHidden()
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(ui.language.trigger(app.page)).toHaveAttribute('aria-label', 'Language: English')
  await expect(app.page.getByRole('button', { name: 'Save project' })).toBeVisible()

  // The duplicate survives Cancel, but without the previewed translation.
  await expect(ui.languageManager.detailName(app.page)).toHaveText('English copy')
  await expect(ui.languageManager.progress(app.page)).toContainText('0 of')
})
