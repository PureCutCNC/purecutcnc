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
