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

import { test as base, expect, type Page } from '@playwright/test'
import * as ui from './selectors'
import { seedToolpathVisProject } from './toolpathVisibility.helpers'

/**
 * WebGL-unavailable smoke test (issue #786).
 *
 * Chrome turns GL off entirely after repeated GPU-process crashes, and the app
 * used to fall to its error screen at startup because the 3D preview built its
 * renderer unguarded. Every test here runs in a browser with WebGL switched
 * off: the app must open into a usable Sketch, both 3D views must say they are
 * unavailable, and an opted-in GPU toolpath renderer must fall back to Canvas
 * where the user can see it.
 */

// The views that need WebGL report their failed context creation, and three
// logs both the browser's reason and its own error. Any other error — the app
// error boundary's included — fails the test.
const EXPECTED_WEBGL_ERRORS = [
  /WebGL2 context creation failed/,
  /A WebGL context could not be created/,
  /Error creating WebGL context/,
]

const test = base.extend<{ unexpectedErrors: string[] }>({
  unexpectedErrors: [async ({ page }, use) => {
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' && !EXPECTED_WEBGL_ERRORS.some((pattern) => pattern.test(message.text()))) {
        errors.push(message.text())
      }
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await use(errors)
    expect(errors, 'unexpected console or page errors').toEqual([])
  }, { auto: true }],
})

// launchOptions is worker-scoped, so it can only be set for the whole file.
test.use({ launchOptions: { args: ['--disable-webgl'] } })

async function openApp(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await expect(page.locator('canvas.sketch-canvas')).toBeVisible({ timeout: 15000 })
  // The premise, checked: if a browser update ever ignored the flag, these
  // tests would pass without exercising anything.
  expect(await page.evaluate(() => document.createElement('canvas').getContext('webgl2') === null)).toBe(true)
}

test('opens into a usable Sketch and says each 3D view is unavailable', async ({ page }) => {
  await openApp(page, '/')
  const sketchTab = page.getByRole('tab', { name: 'Sketch', exact: true })
  await expect(sketchTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText("PureCutCNC couldn't start on this device")).toHaveCount(0)

  // Sketch does real work without WebGL: a project loads and its toolpaths draw with Canvas.
  await seedToolpathVisProject(page)
  await expect(ui.toolpathVis.sketchPanel(page)).toBeVisible()
  await expect(page.locator('canvas.sketch-canvas')).toHaveAttribute('data-toolpath-renderer', 'canvas')

  await ui.viewMenu.tab3d(page).click()
  await expect(page.locator('#workspace-panel-preview3d').getByRole('status')
    .filter({ hasText: "3D view isn't available" })).toBeVisible()
  await ui.viewMenu.tabSimulation(page).click()
  await expect(page.locator('#workspace-panel-simulation').getByRole('status')
    .filter({ hasText: "3D simulation isn't available" })).toBeVisible()

  await sketchTab.click()
  await expect(page.locator('canvas.sketch-canvas')).toBeVisible()
})

test('a GPU toolpath renderer falls back to Canvas and says so with the panel collapsed', async ({ page }) => {
  await openApp(page, '/?toolpathRenderer=gpu')
  await seedToolpathVisProject(page)
  await expect(page.locator('canvas.sketch-canvas')).toHaveAttribute('data-toolpath-renderer', 'canvas-fallback')

  const notice = page.getByRole('status').filter({ hasText: 'GPU unavailable; using Canvas.' })
  const toggle = ui.toolpathVis.toggle(page)
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(notice).toHaveCount(1)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(notice).toBeVisible()
  await expect(notice.getByRole('button', { name: 'Retry GPU', exact: true })).toBeVisible()
})
