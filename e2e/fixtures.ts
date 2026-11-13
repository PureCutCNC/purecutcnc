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

/** localStorage entries written once, before the application's first load. */
export type PreferenceSeeds = Record<string, string>

export const test = base.extend<{
  app: AppPage
  ui: typeof ui
  /**
   * Machine-local preferences to seed before the app boots, e.g. a stored
   * `canvas` renderer or `inline` backend. The worker and GPU are the shipped
   * defaults (issue #1087), so a spec that wants the fallback lane or an
   * explicit opt-out states it here instead of clicking through the UI — and
   * a later `reload()` keeps whatever the test then chose.
   *
   * One-shot: a sessionStorage marker stops the seed from overwriting a
   * preference the test itself changes and reloads.
   */
  preferences: PreferenceSeeds
}>({
  preferences: [{}, { option: true }],

  page: async ({ page, preferences }, use) => {
    if (Object.keys(preferences).length > 0) {
      await page.addInitScript((entries: PreferenceSeeds) => {
        // about:blank and non-web origins have no usable storage.
        try {
          if (sessionStorage.getItem('__e2ePreferencesSeeded') === '1') return
          for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
          sessionStorage.setItem('__e2ePreferencesSeeded', '1')
        } catch {
          return
        }
      }, preferences)
    }
    await use(page)
  },

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
