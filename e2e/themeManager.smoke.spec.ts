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
 * Theme manager + guided editor smoke (issue #305): duplicate/edit/apply,
 * preview cancel vs. apply, reload persistence, import/export round-trip,
 * invalid import rejection, contrast blocking with recovery, custom System
 * pairing, and the no-project-changes guarantee.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { getProject } from './helpers'

const SELECTION_KEY = 'purecutcnc.appearance.themeSelection'
const CUSTOM_THEMES_KEY = 'purecutcnc.appearance.customThemes'
const LEGACY_KEY = 'purecutcnc.appearance.theme'

function withoutModified(snapshot: Record<string, unknown>): Record<string, unknown> {
  const meta = snapshot.meta as Record<string, unknown>
  const { modified: _modified, ...stableMeta } = meta
  return { ...snapshot, meta: stableMeta }
}

async function inlineToken(page: Page, token: string): Promise<string> {
  return page.evaluate(
    (name) => document.documentElement.style.getPropertyValue(name),
    token,
  )
}

async function readStorage(page: Page, key: string): Promise<string | null> {
  return page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key)
}

/** Open Appearance → Manage themes. */
async function openManager(page: Page, ui: typeof import('./selectors')): Promise<void> {
  await ui.appearance.trigger(page).click()
  await ui.appearance.manageEntry(page).click()
  await expect(ui.themeManager.dialog(page)).toBeVisible()
}

/** Duplicate the currently selected theme; the editor opens on the copy. */
async function duplicateToEditor(page: Page, ui: typeof import('./selectors')): Promise<void> {
  await ui.themeManager.duplicateButton(page).click()
  await expect(ui.themeEditor.dialog(page)).toBeVisible()
}

test('duplicates a built-in, edits with live preview, applies, and persists', async ({ app, ui }) => {
  const before = await getProject(app.page)
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', 'dark')

  await openManager(app.page, ui)
  await duplicateToEditor(app.page, ui)

  await expect(ui.themeEditor.nameInput(app.page)).toHaveValue('Dark copy')
  await expect(ui.themeEditor.contrastOk(app.page)).toBeVisible()

  // Live preview: the edit lands on the root immediately, without persistence.
  await ui.themeEditor.colorText(app.page, 'Accent / focus').fill('#ff8800')
  await expect.poll(() => inlineToken(app.page, '--accent')).toBe('#ff8800')
  expect(await readStorage(app.page, CUSTOM_THEMES_KEY) ?? '[]').not.toContain('#ff8800')

  await ui.themeEditor.applyButton(app.page).click()
  await expect(ui.themeEditor.dialog(app.page)).toBeHidden()

  // Applied: the copy is active, saved, and the override still applied.
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', /^custom-/)
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await inlineToken(app.page, '--accent')).toBe('#ff8800')
  expect(await readStorage(app.page, CUSTOM_THEMES_KEY)).toContain('#ff8800')
  expect(await readStorage(app.page, LEGACY_KEY)).toBe('dark')

  await ui.themeManager.doneButton(app.page).click()
  await expect(ui.appearance.trigger(app.page)).toHaveAttribute('aria-label', 'Appearance: Dark copy')

  // Theme work never touches the project.
  expect(withoutModified(await getProject(app.page))).toEqual(withoutModified(before))

  // Persists across reload (bootstrap applies it before React renders).
  await app.page.reload()
  await app.page.waitForSelector('canvas', { timeout: 15000 })
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', /^custom-/)
  expect(await inlineToken(app.page, '--accent')).toBe('#ff8800')
  await expect(ui.appearance.trigger(app.page)).toHaveAttribute('aria-label', 'Appearance: Dark copy')
})

test('cancelling the editor restores the active theme without persisting', async ({ app, ui }) => {
  await openManager(app.page, ui)
  await duplicateToEditor(app.page, ui)

  await ui.themeEditor.colorText(app.page, 'Accent / focus').fill('#00ff00')
  await expect.poll(() => inlineToken(app.page, '--accent')).toBe('#00ff00')

  await ui.themeEditor.cancelButton(app.page).click()
  await expect(ui.themeEditor.dialog(app.page)).toBeHidden()
  await expect(ui.themeManager.dialog(app.page)).toBeVisible()

  // Preview fully reverted; the duplicate exists but carries no override.
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', 'dark')
  await expect.poll(() => inlineToken(app.page, '--accent')).toBe('')
  expect(await readStorage(app.page, CUSTOM_THEMES_KEY)).not.toContain('#00ff00')

  // Escape also cancels: reopen the editor, edit, and press Escape.
  await ui.themeManager.editButton(app.page).click()
  await ui.themeEditor.colorText(app.page, 'Accent / focus').fill('#00ff00')
  await expect.poll(() => inlineToken(app.page, '--accent')).toBe('#00ff00')
  await app.page.keyboard.press('Escape')
  await expect(ui.themeEditor.dialog(app.page)).toBeHidden()
  await expect(ui.themeManager.dialog(app.page)).toBeVisible()
  await expect.poll(() => inlineToken(app.page, '--accent')).toBe('')
})

test('blocks applying an unreadable theme and recovers via the safety action', async ({ app, ui }) => {
  await openManager(app.page, ui)
  await duplicateToEditor(app.page, ui)

  // Make primary text nearly invisible on panels.
  await ui.themeEditor.colorText(app.page, 'Primary text').fill('#101821')

  await expect(ui.themeEditor.blockers(app.page).first()).toBeVisible()
  await expect(ui.themeEditor.blockers(app.page).first()).toContainText('Primary text on panels')
  await expect(ui.themeEditor.applyButton(app.page)).toBeDisabled()

  // The always-readable recovery action restores the saved colors.
  await ui.themeEditor.restoreButton(app.page).click()
  await expect(ui.themeEditor.blockers(app.page)).toHaveCount(0)
  await expect(ui.themeEditor.applyButton(app.page)).toBeEnabled()
  await expect(ui.themeEditor.contrastOk(app.page)).toBeVisible()
  await expect.poll(() => inlineToken(app.page, '--text')).toBe('')

  await ui.themeEditor.cancelButton(app.page).click()
})

test('exports a custom theme and re-imports it after deletion', async ({ app, ui }) => {
  await openManager(app.page, ui)
  await duplicateToEditor(app.page, ui)
  await ui.themeEditor.colorText(app.page, 'Accent / focus').fill('#ff8800')
  await ui.themeEditor.applyButton(app.page).click()

  // Capture the exported JSON by stubbing the save picker.
  await app.page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    w.__exportedTheme = null
    w.showSaveFilePicker = async () => ({
      name: 'theme.json',
      createWritable: async () => ({
        write: async (content: string) => { w.__exportedTheme = content },
        close: async () => {},
      }),
    })
  })
  await ui.themeManager.exportButton(app.page).click()
  const exported = await app.page.evaluate(() => (window as unknown as Record<string, unknown>).__exportedTheme as string | null)
  expect(exported).not.toBeNull()
  const envelope = JSON.parse(exported!) as { format: string; schemaVersion: number; theme: { name: string } }
  expect(envelope.format).toBe('purecutcnc-theme')
  expect(envelope.schemaVersion).toBe(1)
  expect(envelope.theme.name).toBe('Dark copy')

  // Delete the active custom theme — it falls back to its base explicitly.
  await ui.themeManager.deleteButton(app.page).click()
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', 'dark')
  expect(await inlineToken(app.page, '--accent')).toBe('')
  await expect(ui.themeManager.detailName(app.page)).toHaveText('Dark')

  // Round-trip: import the exported file back and activate it.
  const chooser = app.page.waitForEvent('filechooser')
  await ui.themeManager.importButton(app.page).click()
  await (await chooser).setFiles({
    name: 'Dark copy.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exported!, 'utf8'),
  })
  await expect(ui.themeManager.notice(app.page)).toContainText('Imported')
  await expect(ui.themeManager.detailName(app.page)).toHaveText('Dark copy')
  await ui.themeManager.useButton(app.page).click()
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', /^custom-/)
  expect(await inlineToken(app.page, '--accent')).toBe('#ff8800')
})

test('rejects invalid theme imports with a readable error', async ({ app, ui }) => {
  await openManager(app.page, ui)

  const notJson = app.page.waitForEvent('filechooser')
  await ui.themeManager.importButton(app.page).click()
  await (await notJson).setFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('this is not json', 'utf8'),
  })
  await expect(ui.themeManager.notice(app.page)).toContainText('Import failed: Not a valid JSON file.')

  const badToken = app.page.waitForEvent('filechooser')
  await ui.themeManager.importButton(app.page).click()
  await (await badToken).setFiles({
    name: 'sneaky.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      format: 'purecutcnc-theme',
      schemaVersion: 1,
      theme: {
        schemaVersion: 1,
        id: 'custom-sneaky',
        name: 'Sneaky',
        family: 'dark',
        baseThemeId: 'dark',
        overrides: { accent: 'url(javascript:alert(1))' },
      },
    }), 'utf8'),
  })
  await expect(ui.themeManager.notice(app.page)).toContainText('invalid color value')

  const wrongVersion = app.page.waitForEvent('filechooser')
  await ui.themeManager.importButton(app.page).click()
  await (await wrongVersion).setFiles({
    name: 'future.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'purecutcnc-theme', schemaVersion: 99, theme: {} }), 'utf8'),
  })
  await expect(ui.themeManager.notice(app.page)).toContainText('Unsupported theme schema version')
})

test('renames, resets, and lists custom themes in the appearance menu', async ({ app, ui }) => {
  await openManager(app.page, ui)
  await duplicateToEditor(app.page, ui)
  await ui.themeEditor.colorText(app.page, 'Accent / focus').fill('#ff8800')
  await ui.themeEditor.applyButton(app.page).click()

  await ui.themeManager.renameButton(app.page).click()
  await ui.themeManager.renameInput(app.page).fill('Workshop Amber')
  await ui.themeManager.saveNameButton(app.page).click()
  await expect(ui.themeManager.detailName(app.page)).toHaveText('Workshop Amber')

  await ui.themeManager.resetButton(app.page).click()
  await expect.poll(() => inlineToken(app.page, '--accent')).toBe('')
  await expect(ui.themeManager.notice(app.page)).toContainText('Reset')

  await ui.themeManager.doneButton(app.page).click()

  // The custom theme is selectable from the quick appearance menu.
  await ui.appearance.trigger(app.page).click()
  await expect(ui.appearance.customOption(app.page, 'Workshop Amber')).toHaveAttribute('aria-checked', 'true')
  await ui.appearance.option(app.page, 'Dark').click()
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', 'dark')
  await ui.appearance.trigger(app.page).click()
  await ui.appearance.customOption(app.page, 'Workshop Amber').click()
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', /^custom-/)
})

test('supports a custom theme in the System pair and follows the OS scheme', async ({ app, ui }) => {
  await app.page.emulateMedia({ colorScheme: 'dark' })
  await openManager(app.page, ui)
  await duplicateToEditor(app.page, ui)
  await ui.themeEditor.colorText(app.page, 'Accent / focus').fill('#ff8800')
  await ui.themeEditor.applyButton(app.page).click()

  await ui.themeManager.systemModeRadio(app.page).check()
  await ui.themeManager.systemDarkSelect(app.page).selectOption({ label: 'Dark copy' })

  await expect(app.page.locator('html')).toHaveAttribute('data-theme-preference', 'system')
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', /^custom-/)
  expect(await inlineToken(app.page, '--accent')).toBe('#ff8800')

  // Following the OS to light uses the light slot (built-in Light).
  await app.page.emulateMedia({ colorScheme: 'light' })
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', 'light')
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await inlineToken(app.page, '--accent')).toBe('')

  // And back to dark re-activates the custom member of the pair.
  await app.page.emulateMedia({ colorScheme: 'dark' })
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', /^custom-/)

  await ui.themeManager.doneButton(app.page).click()

  // The pair persists across reload.
  await app.page.reload()
  await app.page.waitForSelector('canvas', { timeout: 15000 })
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-preference', 'system')
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', /^custom-/)
  expect(await readStorage(app.page, LEGACY_KEY)).toBe('system')
})

test('migrates a legacy light preference into the selection model', async ({ app }) => {
  await app.page.evaluate(([legacyKey, selectionKey]) => {
    window.localStorage.clear()
    window.localStorage.setItem(legacyKey, 'light')
    window.localStorage.removeItem(selectionKey)
  }, [LEGACY_KEY, SELECTION_KEY])

  await app.page.reload()
  await app.page.waitForSelector('canvas', { timeout: 15000 })

  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(app.page.locator('html')).toHaveAttribute('data-theme-id', 'light')
  const migrated = JSON.parse((await readStorage(app.page, SELECTION_KEY))!) as { mode: string; fixedThemeId: string }
  expect(migrated.mode).toBe('fixed')
  expect(migrated.fixedThemeId).toBe('light')
})

test.describe('tablet theme management', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true })

  test('keeps the manager and editor touch-sized', async ({ app, ui }) => {
    await ui.appearance.trigger(app.page).click()
    const manageEntry = ui.appearance.manageEntry(app.page)
    await expect(manageEntry).toBeVisible()
    const manageBox = await manageEntry.boundingBox()
    expect(manageBox).not.toBeNull()
    expect(manageBox!.height).toBeGreaterThanOrEqual(44)

    await manageEntry.click()
    await expect(ui.themeManager.dialog(app.page)).toBeVisible()

    const item = ui.themeManager.themeItem(app.page, 'Dark')
    const itemBox = await item.boundingBox()
    expect(itemBox).not.toBeNull()
    expect(itemBox!.height).toBeGreaterThanOrEqual(44)

    const duplicate = ui.themeManager.duplicateButton(app.page)
    const duplicateBox = await duplicate.boundingBox()
    expect(duplicateBox).not.toBeNull()
    expect(duplicateBox!.height).toBeGreaterThanOrEqual(44)

    await duplicate.click()
    await expect(ui.themeEditor.dialog(app.page)).toBeVisible()
    const picker = ui.themeEditor.dialog(app.page).getByLabel('Accent / focus color picker')
    await picker.scrollIntoViewIfNeeded()
    const pickerBox = await picker.boundingBox()
    expect(pickerBox).not.toBeNull()
    expect(pickerBox!.width).toBeGreaterThanOrEqual(40)
  })
})
