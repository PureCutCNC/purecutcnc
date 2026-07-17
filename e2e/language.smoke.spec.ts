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

const STORAGE_KEY = 'purecutcnc.i18n.locale'

function withoutModified(snapshot: Record<string, unknown>): Record<string, unknown> {
  const meta = snapshot.meta as Record<string, unknown>
  const { modified: _modified, ...stableMeta } = meta
  return { ...snapshot, meta: stableMeta }
}

test('switches to Simplified Chinese, persists, and never touches the project', async ({ app, ui }) => {
  const before = await getProject(app.page)
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(ui.language.trigger(app.page)).toHaveAttribute('aria-label', 'Language: English')

  await ui.language.trigger(app.page).click()
  await ui.language.option(app.page, '简体中文').click()

  // Document language and visible toolbar copy follow the locale.
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(app.page.getByRole('button', { name: '新建项目' })).toBeVisible()
  await expect(app.page.getByRole('button', { name: '捕捉到网格' })).toBeVisible()
  await expect(ui.language.trigger(app.page)).toHaveAttribute('aria-label', '语言：简体中文')

  // Explicit choice is persisted as the bare locale id; project is untouched.
  expect(await app.page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)).toBe('zh-CN')
  expect(withoutModified(await getProject(app.page))).toEqual(withoutModified(before))

  // Survives a reload.
  await app.page.reload()
  await app.page.waitForSelector('canvas', { timeout: 15000 })
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(ui.language.trigger(app.page)).toHaveAttribute('aria-label', '语言：简体中文')

  // And switches back.
  await ui.language.trigger(app.page).click()
  await ui.language.option(app.page, 'English').click()
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(app.page.getByRole('button', { name: 'New project' })).toBeVisible()
  expect(await app.page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)).toBe('en')
})

test('keeps appearance menu copy translated and the theme selection intact', async ({ app, ui }) => {
  await ui.language.trigger(app.page).click()
  await ui.language.option(app.page, '简体中文').click()

  // The appearance control renders Chinese copy but keeps working.
  await app.page.getByRole('button', { name: /^外观：/ }).click()
  await app.page.getByRole('menu', { name: '外观主题' }).getByRole('menuitemradio', { name: /^浅色/ }).click()
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'light')

  // Switching language does not reset the theme.
  await ui.language.trigger(app.page).click()
  await ui.language.option(app.page, 'English').click()
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test.describe('tablet language selector', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true })

  test('keeps the selector and choices touch-sized', async ({ app, ui }) => {
    const trigger = ui.language.trigger(app.page)
    await expect(trigger).toBeVisible()
    const triggerBox = await trigger.boundingBox()
    expect(triggerBox).not.toBeNull()
    expect(triggerBox!.height).toBeGreaterThanOrEqual(44)
    expect(triggerBox!.width).toBeGreaterThanOrEqual(44)

    await trigger.click()
    const chineseOption = ui.language.option(app.page, '简体中文')
    await expect(chineseOption).toBeVisible()
    const optionBox = await chineseOption.boundingBox()
    expect(optionBox).not.toBeNull()
    expect(optionBox!.height).toBeGreaterThanOrEqual(44)

    await chineseOption.click()
    await expect(app.page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  })
})
