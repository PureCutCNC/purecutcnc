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

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * WebGL context-loss smoke test (issue #786).
 *
 * Both 3D views explain a lost context the same way: an overlay while the
 * browser holds the context back, gone once it is restored. The loss is
 * simulated with WEBGL_lose_context on the view's own canvas.
 */

async function loseContext(page: Page, canvasSelector: string): Promise<void> {
  await page.evaluate((selector) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector)!
    const extension = canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!
    Object.assign(window, { restoreLostContext: () => extension.restoreContext() })
    extension.loseContext()
  }, canvasSelector)
}

async function restoreContext(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { restoreLostContext: () => void }).restoreLostContext())
}

test('3D view shows the context-lost message until the context is restored', async ({ app, ui }) => {
  const page = app.page
  await ui.viewMenu.tab3d(page).click()
  const view = page.locator('#workspace-panel-preview3d')
  const message = view.getByRole('status').filter({ hasText: '3D graphics context lost' })
  await expect(view.locator('canvas')).toBeVisible()
  await expect(message).toHaveCount(0)

  await loseContext(page, '#workspace-panel-preview3d canvas')
  await expect(message).toBeVisible()
  await expect(message).toContainText('Waiting for the browser to restore it. If this message persists, reload the app.')

  await restoreContext(page)
  await expect(message).toHaveCount(0)
})

test('simulation view shows the context-lost message until the context is restored', async ({ app, ui }) => {
  const page = app.page
  await ui.viewMenu.tabSimulation(page).click()
  const view = page.locator('#workspace-panel-simulation')
  const message = view.getByRole('status').filter({ hasText: '3D graphics context lost' })
  await expect(view.locator('.simulation-viewport__canvas canvas')).toBeVisible()
  await expect(message).toHaveCount(0)

  await loseContext(page, '#workspace-panel-simulation .simulation-viewport__canvas canvas')
  await expect(message).toBeVisible()
  await expect(message).toContainText('playback has been paused')

  await restoreContext(page)
  await expect(message).toHaveCount(0)
})
