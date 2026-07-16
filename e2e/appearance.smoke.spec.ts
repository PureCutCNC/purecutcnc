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
import { getProject } from './helpers'

const STORAGE_KEY = 'purecutcnc.appearance.theme'

function withoutModified(snapshot: Record<string, unknown>): Record<string, unknown> {
  const meta = snapshot.meta as Record<string, unknown>
  const { modified: _modified, ...stableMeta } = meta
  return { ...snapshot, meta: stableMeta }
}

test('switches and restores appearance without changing the project', async ({ app, ui }) => {
  const before = await getProject(app.page)
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'dark')

  await ui.appearance.trigger(app.page).click()
  await ui.appearance.option(app.page, 'Light').click()

  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(ui.appearance.trigger(app.page)).toHaveAttribute('aria-label', 'Appearance: Light')
  expect(await app.page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)).toBe('light')
  expect(withoutModified(await getProject(app.page))).toEqual(withoutModified(before))

  await app.page.reload()
  await app.page.waitForSelector('canvas', { timeout: 15000 })
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(ui.appearance.trigger(app.page)).toHaveAttribute('aria-label', 'Appearance: Light')
})

test('system appearance follows prefers-color-scheme changes', async ({ app, ui }) => {
  await app.page.emulateMedia({ colorScheme: 'dark' })
  await ui.appearance.trigger(app.page).click()
  await ui.appearance.option(app.page, 'System').click()

  await expect(app.page.locator('html')).toHaveAttribute('data-theme-preference', 'system')
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'dark')

  await app.page.emulateMedia({ colorScheme: 'light' })
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await app.page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)).toBe('system')
})

test.describe('tablet appearance', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true })

  test('keeps the selector and choices touch-sized', async ({ app, ui }) => {
    const trigger = ui.appearance.trigger(app.page)
    await expect(trigger).toBeVisible()
    const triggerBox = await trigger.boundingBox()
    expect(triggerBox).not.toBeNull()
    expect(triggerBox!.height).toBeGreaterThanOrEqual(44)
    expect(triggerBox!.width).toBeGreaterThanOrEqual(44)

    await trigger.click()
    const lightOption = ui.appearance.option(app.page, 'Light')
    await expect(lightOption).toBeVisible()
    const optionBox = await lightOption.boundingBox()
    expect(optionBox).not.toBeNull()
    expect(optionBox!.height).toBeGreaterThanOrEqual(44)

    await lightOption.click()
    await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'light')
  })
})
