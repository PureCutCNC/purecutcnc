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
import type { Page } from '@playwright/test'
import { seedOverlapFeatureProject } from './overlapFeatureSelection.helpers'

async function convertFolderedFeatureToConstruction(page: Page): Promise<void> {
  await seedOverlapFeatureProject(page, 1)
  await page.locator('.tree-row--features').getByRole('button', { name: 'Add folder' }).click()

  let feature = page.locator('.tree-row--feature').filter({ hasText: 'Overlap feature 1' })
  await feature.click()
  await page.locator('.properties-panel').getByRole('button', { name: 'Instance', exact: true }).click()
  const folderField = page.locator('.properties-panel .properties-field').filter({ hasText: 'Folder' })
  await folderField.locator('.ui-select__trigger').click()
  await folderField.getByRole('option', { name: 'Folder 1' }).click()

  feature = page.locator('.tree-row--feature').filter({ hasText: 'Overlap feature 1' })
  await feature.locator('.tree-action-btn--operation').click()
  await page.locator('.tree-operation-menu__item').filter({ hasText: 'Construction' }).click()
}

async function expectConvertedFeatureInConstruction(page: Page): Promise<void> {
  const constructionChildren = page.locator('.tree-row--constructions + .tree-children')
  const converted = constructionChildren.locator('.tree-row--feature').filter({ hasText: 'Overlap feature 1' })
  await expect(converted).toHaveCount(1)
  await expect(converted).toHaveClass(/tree-row--construction/)
}

test('dedicated Line creation target is visible and active on desktop', async ({ app }) => {
  const button = app.page.getByRole('button', { name: 'Create lines', exact: true })
  await expect(button).toBeVisible()
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(app.page.getByRole('status', { name: 'Drawing lines', exact: true })).toBeVisible()
  await expect(app.page.getByRole('button', { name: 'Add line rectangle', exact: true })).toBeVisible()
})

test('dedicated Line creation target remains available on landscape tablet', async ({ app }) => {
  await app.page.setViewportSize({ width: 1024, height: 768 })
  const button = app.page.getByRole('button', { name: 'Create lines', exact: true })
  await expect(button).toBeVisible()
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(app.page.getByRole('status', { name: 'Drawing lines', exact: true })).toBeVisible()
})

test('foldered feature appears under Construction immediately after conversion', async ({ app }) => {
  await convertFolderedFeatureToConstruction(app.page)
  await expectConvertedFeatureInConstruction(app.page)
})

test('foldered construction conversion updates the landscape-tablet tree immediately', async ({ app }) => {
  await app.page.setViewportSize({ width: 1024, height: 768 })
  await convertFolderedFeatureToConstruction(app.page)
  await expectConvertedFeatureInConstruction(app.page)
})
