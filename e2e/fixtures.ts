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
 * Shared Playwright fixture for PureCutCNC browser smoke tests.
 *
 * Usage (in any e2e/*.spec.ts):
 * ```ts
 * import { test, expect } from './fixtures'
 *
 * test('my smoke', async ({ app, ui }) => {
 *   // app.page — pre-booted page with console-error guard installed
 *   // ui       — selectors module (tree, badge, contextMenu, …)
 * })
 * ```
 *
 * The fixture auto-navigates to the app, waits for the canvas, and fails
 * the test on ANY console.error or uncaught page error.
 */

import { test as base, expect, type Page } from '@playwright/test'
import * as ui from './selectors'

// ── App page with error guard ───────────────────────────────────────

export interface AppPage {
  page: Page
  /** Accumulated console errors since page load. */
  errors: string[]
}

export const test = base.extend<{
  app: AppPage
  ui: typeof ui
}>({
  app: async ({ page }, use) => {
    const errors: string[] = []

    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => {
      errors.push(err.message)
    })

    await page.goto('/')
    await page.waitForSelector('canvas', { timeout: 15000 })

    await use({ page, errors })

    // Fail the test on ANY console error — no production bug should emit one.
    if (errors.length > 0) {
      throw new Error(
        `Console errors during test:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
      )
    }
  },

  ui: async ({}, use) => {
    await use(ui)
  },
})

export { expect }
