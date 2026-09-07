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
 * The worker execution backend, in a real browser (issue #675, slice 4).
 *
 * Everything else about the worker is verified without one: the parity corpus
 * in Node, cross-thread execution under `worker_threads`. What only a browser
 * can answer is whether the thing actually *starts* — whether the bundler's
 * `new URL(..., import.meta.url)` asset resolves, whether the chunk loads, and
 * whether a program produced on that thread is the same program.
 *
 * The parity assertion here is deliberately end-to-end rather than internal: it
 * opens the export dialog on each backend and compares the emitted G-code
 * preview and its move/line counts. That is the artifact a machine runs, so it
 * is the one worth comparing.
 */

import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { exportDialog, exportPreview, generation } from './selectors'

const WORKER_OPTION = /Background thread/
const MAIN_THREAD_OPTION = /Main thread/

async function chooseBackend(page: Parameters<typeof generation.backendTrigger>[0], option: RegExp): Promise<void> {
  await generation.backendTrigger(page).click()
  await generation.backendOption(page, option).click()
}

/** Open the export dialog for everything visible and read back what it would write. */
async function readExportedProgram(
  page: Parameters<typeof exportDialog.root>[0],
  ui: { operations: { headerExportButton: (p: typeof page) => ReturnType<typeof exportDialog.root> } },
): Promise<{ preview: string; summary: string }> {
  await ui.operations.headerExportButton(page).click()
  await expect(exportDialog.root(page)).toBeVisible()
  await expect(exportDialog.exportButton(page)).toBeEnabled()
  const preview = (await exportPreview.body(page).textContent()) ?? ''
  const summary = (await exportPreview.summary(page).textContent()) ?? ''
  await exportDialog.root(page).locator('.dialog-close').click()
  await expect(exportDialog.root(page)).toBeHidden()
  return { preview, summary }
}

test.describe('Generation execution backend smoke', () => {
  test('defaults to the main thread and says Stop cannot interrupt it', async ({ app }) => {
    await expect(generation.summary(app.page)).toBeVisible()
    // The shipped default, and what a user who never opens the menu gets.
    const stored = await app.page.evaluate(() => localStorage.getItem('purecut.generation.executor'))
    expect(stored === null || stored === 'inline').toBe(true)

    await generation.backendTrigger(app.page).click()
    await expect(generation.backendOption(app.page, MAIN_THREAD_OPTION)).toHaveAttribute('aria-checked', 'true')
    await expect(generation.backendOption(app.page, WORKER_OPTION)).toHaveAttribute('aria-checked', 'false')
    await app.page.keyboard.press('Escape')

    // Offered but honest: it is disabled here rather than quietly ineffective.
    await expect(generation.stopButton(app.page)).toHaveAttribute(
      'title',
      /cannot interrupt an operation already running on the main thread/,
    )
  })

  test('choosing the background thread starts a real worker and persists', async ({ app }) => {
    const workerUrls: string[] = []
    app.page.on('worker', (worker) => workerUrls.push(worker.url()))
    const pageErrors: string[] = []
    app.page.on('pageerror', (error) => pageErrors.push(error.message))

    await chooseBackend(app.page, WORKER_OPTION)
    await seedGcodeExportProject(app.page)
    await expect(generation.summary(app.page)).toHaveText(/up to date/, { timeout: 30_000 })

    // The bundler-resolved worker asset actually loaded and ran.
    expect(workerUrls.some((url) => /toolpath\.worker/.test(url))).toBe(true)
    expect(pageErrors).toEqual([])

    const stored = await app.page.evaluate(() => localStorage.getItem('purecut.generation.executor'))
    expect(stored).toBe('worker')
  })

  test('the program a worker produces is the program the main thread produces', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)
    await expect(generation.summary(app.page)).toHaveText(/up to date/, { timeout: 30_000 })
    const inline = await readExportedProgram(app.page, ui)

    await chooseBackend(app.page, WORKER_OPTION)
    await expect(generation.summary(app.page)).toHaveText(/up to date/, { timeout: 30_000 })
    const worker = await readExportedProgram(app.page, ui)

    // Byte-for-byte on what the dialog shows, and identical move and line
    // counts. A backend that changed the program would move one of these.
    expect(worker.preview).toBe(inline.preview)
    expect(worker.summary).toBe(inline.summary)
    expect(inline.preview.length).toBeGreaterThan(0)
  })

  test('switching back to the main thread keeps generating', async ({ app }) => {
    await chooseBackend(app.page, WORKER_OPTION)
    await seedGcodeExportProject(app.page)
    await expect(generation.summary(app.page)).toHaveText(/up to date/, { timeout: 30_000 })

    // A backend switch clears the cache, so this is a fresh generation, not a
    // cached result being re-read.
    await chooseBackend(app.page, MAIN_THREAD_OPTION)
    await expect(generation.summary(app.page)).toHaveText(/up to date/, { timeout: 30_000 })
    const stored = await app.page.evaluate(() => localStorage.getItem('purecut.generation.executor'))
    expect(stored).toBe('inline')
  })
})
