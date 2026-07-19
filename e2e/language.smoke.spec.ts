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
import { clickMenuItem, getProject, openRowContextMenu, seedProject } from './helpers'
import { buildLinkedProjectJson } from './featureReferences.helpers'

const STORAGE_KEY = 'purecutcnc.i18n.locale'

function withoutModified(snapshot: Record<string, unknown>): Record<string, unknown> {
  const meta = snapshot.meta as Record<string, unknown>
  const { modified: _modified, ...stableMeta } = meta
  return { ...snapshot, meta: stableMeta }
}

interface PropertiesFixtureFeature {
  id: string
  name: string
  definitionId: string
  transform: { a: number; b: number; c: number; d: number; e: number; f: number }
  constraints: unknown[]
  folderId: string | null
  z_top: number
  z_bottom: number
  visible: boolean
  locked: boolean
}

interface PropertiesFixtureProject {
  featureDefinitions: Record<string, unknown>
  features: PropertiesFixtureFeature[]
}

function buildPropertiesLocalizationProject(): string {
  const project = JSON.parse(buildLinkedProjectJson()) as PropertiesFixtureProject
  const linkedB = project.features.find((feature) => feature.id === 'f-linked-b')
  if (!linkedB) throw new Error('linked fixture must include f-linked-b')
  linkedB.z_top = 4

  project.featureDefinitions['def-imported-model'] = {
    id: 'def-imported-model',
    kind: 'stl',
    profile: {
      start: { x: 0, y: 0 },
      segments: [
        { type: 'line', to: { x: 40, y: 0 } },
        { type: 'line', to: { x: 40, y: 20 } },
        { type: 'line', to: { x: 0, y: 20 } },
        { type: 'line', to: { x: 0, y: 0 } },
      ],
      closed: true,
    },
    dimensions: [],
    text: null,
    stl: {
      format: 'stl',
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 20 },
        { x: 0, y: 20 },
      ]],
    },
    operation: 'model',
  }
  project.features.push({
    id: 'f-imported-model',
    name: 'Imported Model',
    definitionId: 'def-imported-model',
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    constraints: [],
    folderId: null,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  })

  return JSON.stringify(project)
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

test('switches to Spanish, persists, and never touches the project', async ({ app, ui }) => {
  const before = await getProject(app.page)

  await ui.language.trigger(app.page).click()
  await ui.language.option(app.page, 'Español').click()

  await expect(app.page.locator('html')).toHaveAttribute('lang', 'es')
  await expect(app.page.getByRole('button', { name: 'Nuevo proyecto' })).toBeVisible()
  await expect(app.page.getByRole('button', { name: 'Ajustar a la cuadrícula' })).toBeVisible()
  await expect(ui.language.trigger(app.page)).toHaveAttribute('aria-label', 'Idioma: Español')
  expect(await app.page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)).toBe('es')
  expect(withoutModified(await getProject(app.page))).toEqual(withoutModified(before))

  await app.page.reload()
  await app.page.waitForSelector('canvas', { timeout: 15000 })
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'es')
  await expect(ui.language.trigger(app.page)).toHaveAttribute('aria-label', 'Idioma: Español')

  await ui.language.trigger(app.page).click()
  await ui.language.option(app.page, 'English').click()
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'en')
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

test('updates selected feature properties when the interface language changes', async ({ app, ui }) => {
  await seedProject(app.page, buildPropertiesLocalizationProject())
  const before = await getProject(app.page)

  const linkedA = ui.tree.rowByName(app.page, 'Linked A')
  await linkedA.click()
  await expect(linkedA).toHaveClass(/tree-row--selected/)
  const menu = await openRowContextMenu(app.page, linkedA)
  await clickMenuItem(menu, 'Select Linked Instances')
  await expect(ui.properties.panel(app.page).getByPlaceholder('Mixed values')).toHaveCount(2)
  await expect(ui.properties.exactText(app.page, 'Operation')).toBeVisible()

  await ui.language.trigger(app.page).click()
  await ui.language.option(app.page, '简体中文').click()

  const disabledTextInputs = ui.properties.panel(app.page).locator('input[type="text"]:disabled')
  await expect(disabledTextInputs).toHaveCount(2)
  await expect(disabledTextInputs.nth(0)).toHaveValue('2 个特征')
  await expect(disabledTextInputs.nth(1)).toHaveValue('多选时禁用')
  await expect(ui.properties.panel(app.page).getByPlaceholder('混合值')).toHaveCount(2)
  await expect(ui.properties.exactText(app.page, '操作')).toBeVisible()

  await ui.language.trigger(app.page).click()
  await ui.language.option(app.page, 'English').click()

  await expect(disabledTextInputs.nth(0)).toHaveValue('2 Features')
  await expect(disabledTextInputs.nth(1)).toHaveValue('Disabled for multi-select')
  await expect(ui.properties.panel(app.page).getByPlaceholder('Mixed values')).toHaveCount(2)
  await expect(ui.properties.exactText(app.page, 'Operation')).toBeVisible()
  expect(withoutModified(await getProject(app.page))).toEqual(withoutModified(before))

  await ui.tree.rowByName(app.page, 'Imported Model').click()
  await ui.properties.panel(app.page).getByRole('button', { name: 'Shape', exact: true }).click()
  await expect(ui.properties.exactText(app.page, 'Model')).toBeVisible()
  await expect(ui.properties.panel(app.page).locator('.properties-locked-field')).toHaveAttribute(
    'title',
    'Model features are imported 3D objects and cannot change operation type',
  )
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
    const spanishOption = ui.language.option(app.page, 'Español')
    await expect(spanishOption).toBeVisible()
    const optionBox = await spanishOption.boundingBox()
    expect(optionBox).not.toBeNull()
    expect(optionBox!.height).toBeGreaterThanOrEqual(44)

    await spanishOption.click()
    await expect(app.page.locator('html')).toHaveAttribute('lang', 'es')
    await expect(app.page.getByRole('button', { name: 'Nuevo proyecto' })).toBeVisible()
  })
})
