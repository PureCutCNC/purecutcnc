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

import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { seedProject } from './helpers'
import { exportDialog, exportPreview, generation } from './selectors'

const WORKER_OPTION = /Background thread/
const MAIN_THREAD_OPTION = /Main thread/
const EXECUTOR_STORAGE_KEY = 'purecut.generation.executor'

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
  test('a fresh profile runs on the background thread and the GPU layer', async ({ app }) => {
    // The gear is always present; the status it carries is readable without
    // opening it.
    await expect(generation.root(app.page)).toBeVisible()
    // The shipped defaults (issue #1087): what a user who never opens a menu
    // gets. The preference is written on first load, so it is `worker`, not
    // an absent key.
    const stored = await app.page.evaluate((key) => localStorage.getItem(key), EXECUTOR_STORAGE_KEY)
    expect(stored).toBe('worker')
    await expect(app.page.locator('canvas.sketch-canvas'))
      .toHaveAttribute('data-toolpath-renderer', 'gpu')

    await generation.backendTrigger(app.page).click()
    await expect(generation.backendOption(app.page, MAIN_THREAD_OPTION)).toHaveAttribute('aria-checked', 'false')
    await expect(generation.backendOption(app.page, WORKER_OPTION)).toHaveAttribute('aria-checked', 'true')
    // Stop is not refused for the main thread's reason: this backend can
    // interrupt work already running, so it is only disabled while idle.
    await expect(generation.stopButton(app.page)).not.toHaveAttribute('title', /cannot interrupt/)
    await expect(generation.stopButton(app.page)).toBeDisabled()
    await app.page.keyboard.press('Escape')
  })

  test('the backend menu opens on screen', async ({ app }) => {
    // The control sits in the status bar at the bottom of the window, and the
    // shared menu styling drops downward — which put the whole menu below the
    // fold, so the trigger looked dead. Asserting *visibility* is not enough to
    // catch that: Playwright scrolls a target into view before acting, so an
    // off-screen menu still passes a click. Only the geometry catches it.
    const viewport = app.page.viewportSize()
    expect(viewport).not.toBeNull()

    await generation.backendTrigger(app.page).click()
    const menu = generation.backendMenu(app.page)
    await expect(menu).toBeVisible()

    const box = await menu.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height)
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width)
  })

  test('a fresh profile starts a real worker and persists the default', async ({ app }) => {
    const workerUrls: string[] = []
    app.page.on('worker', (worker) => workerUrls.push(worker.url()))
    const pageErrors: string[] = []
    app.page.on('pageerror', (error) => pageErrors.push(error.message))

    await seedGcodeExportProject(app.page)
    await expect(generation.gearStatus(app.page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })

    // The bundler-resolved worker asset actually loaded and ran.
    expect(workerUrls.some((url) => /toolpath\.worker/.test(url))).toBe(true)
    expect(pageErrors).toEqual([])

    const stored = await app.page.evaluate((key) => localStorage.getItem(key), EXECUTOR_STORAGE_KEY)
    expect(stored).toBe('worker')
  })

  test.describe('with a stored main-thread preference', () => {
    // The explicit opt-out is a user preference, not an absence of one. It must
    // survive the new default, and it is the baseline the parity comparison
    // needs — comparing two worker runs would prove nothing (issue #1087).
    test.use({ preferences: { [EXECUTOR_STORAGE_KEY]: 'inline' } })

    test('is kept on load, across a reload, and still generates', async ({ app }) => {
      const page = app.page
      expect(await page.evaluate((key) => localStorage.getItem(key), EXECUTOR_STORAGE_KEY)).toBe('inline')
      await generation.backendTrigger(page).click()
      await expect(generation.backendOption(page, MAIN_THREAD_OPTION)).toHaveAttribute('aria-checked', 'true')
      await expect(generation.backendOption(page, WORKER_OPTION)).toHaveAttribute('aria-checked', 'false')
      await page.keyboard.press('Escape')

      await seedGcodeExportProject(page)
      await expect(generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })

      // A reload must not rewrite the stored choice to the new default.
      await page.reload()
      expect(await page.evaluate((key) => localStorage.getItem(key), EXECUTOR_STORAGE_KEY)).toBe('inline')
      await generation.backendTrigger(page).click()
      await expect(generation.backendOption(page, MAIN_THREAD_OPTION)).toHaveAttribute('aria-checked', 'true')
      await expect(generation.backendOption(page, WORKER_OPTION)).toHaveAttribute('aria-checked', 'false')
    })

    test('the program a worker produces is the program the main thread produces', async ({ app, ui }) => {
      await seedGcodeExportProject(app.page)
      await expect(generation.gearStatus(app.page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })
      const inline = await readExportedProgram(app.page, ui)

      await chooseBackend(app.page, WORKER_OPTION)
      await expect(generation.gearStatus(app.page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })
      const worker = await readExportedProgram(app.page, ui)

      // Byte-for-byte on what the dialog shows, and identical move and line
      // counts. A backend that changed the program would move one of these.
      expect(worker.preview).toBe(inline.preview)
      expect(worker.summary).toBe(inline.summary)
      expect(inline.preview.length).toBeGreaterThan(0)
    })

    test('switching backends leaves real toolpaths, in both directions', async ({ app, ui }) => {
      // Asserted on the **exported program**, not on the status line. The status
      // line is what let an earlier version of this test pass while the feature
      // was broken: a backend switch cleared the cache and the demand, nothing
      // re-queued, so the queue was empty and the summary happily read "up to
      // date" while every operation still showed a spinner. A program can only be
      // produced from toolpaths that actually exist.
      await seedGcodeExportProject(app.page)
      await expect(generation.gearStatus(app.page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })
      const before = await readExportedProgram(app.page, ui)
      expect(before.preview.length).toBeGreaterThan(0)

      for (const option of [WORKER_OPTION, MAIN_THREAD_OPTION, WORKER_OPTION]) {
        await generation.backendTrigger(app.page).click()
        await generation.backendOption(app.page, option).click()
        await expect(generation.gearStatus(app.page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })

        // The load-bearing assertion. Opening the export dialog issues an
        // *explicit* request, which bypasses automatic demand entirely — so an
        // export can succeed while preview generation is dead, which is precisely
        // the state the bug produced. These badges come from cache validity, so
        // they only clear when the preview really regenerated.
        await expect(generation.pendingOperationBadges(app.page)).toHaveCount(0, { timeout: 30_000 })

        const after = await readExportedProgram(app.page, ui)
        expect(after.preview).toBe(before.preview)
        expect(after.summary).toBe(before.summary)
      }

      const stored = await app.page.evaluate((key) => localStorage.getItem(key), EXECUTOR_STORAGE_KEY)
      expect(stored).toBe('worker')
    })
  })

  test('a worker that cannot start falls back to the main thread with a visible status', async ({ app }) => {
    const page = app.page
    const workerUrls: string[] = []
    page.on('worker', (worker) => workerUrls.push(worker.url()))
    // A runtime where a worker exists but cannot start — a locked-down webview,
    // a blocked script. Only the generation worker is refused, so nothing else
    // in the app is affected. Registered before the reload that actually boots
    // with it in place.
    await page.addInitScript(() => {
      const Original = window.Worker
      class GuardedWorker extends Original {
        constructor(url: string | URL, options?: WorkerOptions) {
          if (/toolpath\.worker/.test(String(url))) throw new Error('worker start blocked by the test')
          super(url, options)
        }
      }
      Object.defineProperty(window, 'Worker', { configurable: true, value: GuardedWorker })
    })
    await page.reload()

    await seedGcodeExportProject(page)
    // The fallback runs the same job inline, so the work still completes.
    await expect(generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })
    expect(workerUrls.some((url) => /toolpath\.worker/.test(url))).toBe(false)
    // The user's stored choice is kept: the next session may have a worker.
    expect(await page.evaluate((key) => localStorage.getItem(key), EXECUTOR_STORAGE_KEY)).toBe('worker')

    // Visible without opening the menu, and stated in the menu with its reason.
    await expect(generation.gearStatus(page)).toHaveAttribute('aria-label', /Background thread unavailable/)
    await generation.backendTrigger(page).click()
    await expect(generation.summary(page)).toContainText(/Background thread unavailable/)
    await expect(generation.summary(page)).toContainText(/could not be created/)
    // Not a failure: the work is done, so the status never says it failed.
    await expect(generation.summary(page)).not.toContainText(/Generation failed/)
  })

  test('Resume brings the preview back after Stop', async ({ app }) => {
    // Asserted on the per-operation badges, not the status line: the summary
    // reads from the queue and says "up to date" whenever the queue is empty —
    // including when it is empty because nothing was ever re-queued.
    await generation.backendTrigger(app.page).click()
    await generation.backendOption(app.page, WORKER_OPTION).click()

    const heavy = readFileSync(new URL('../src/engine/test-fixtures/trochoidal-249k.camj', import.meta.url), 'utf8')
    void seedProject(app.page, heavy).catch(() => {})

    await expect(generation.gearStatus(app.page)).toHaveAttribute('aria-label', /Generating/, { timeout: 20_000 })
    await generation.backendTrigger(app.page).click()
    await generation.stopButton(app.page).click()
    await expect(generation.gearStatus(app.page)).toHaveAttribute('aria-label', /paused/, { timeout: 20_000 })

    // Paused work is still outstanding, but nothing is working on it — a
    // spinner there claims progress that is not happening.
    await expect(generation.operationSpinners(app.page)).toHaveCount(0)
    await expect(generation.pausedOperationBadges(app.page)).not.toHaveCount(0)

    await generation.backendTrigger(app.page).click()
    await generation.resumeButton(app.page).click()
    await expect(generation.resumeButton(app.page)).toHaveCount(0)
    await expect(generation.pausedOperationBadges(app.page)).toHaveCount(0)

    // The real check: the work Stop cancelled actually gets done again.
    await expect(generation.pendingOperationBadges(app.page)).toHaveCount(0, { timeout: 60_000 })
    await expect(generation.gearStatus(app.page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })
  })

  test('Stop interrupts a running worker generation', async ({ app }) => {
    // The claim this pins is the one the whole issue exists for, and the one
    // the main-thread backend cannot make at all: work already in flight can be
    // abandoned. Asserted by **event ordering** — reach "Generating", press
    // Stop, leave "Generating" — rather than a time budget, because a budget
    // would be measuring this machine rather than the behaviour.
    await generation.backendTrigger(app.page).click()
    await generation.backendOption(app.page, WORKER_OPTION).click()

    const workerEvents: string[] = []
    app.page.on('worker', (worker) => {
      workerEvents.push('created')
      worker.on('close', () => workerEvents.push('closed'))
    })

    // A deliberately heavy fixture, so generation is still running when Stop is
    // pressed. Seeding is not awaited: under the worker backend the seed call
    // returns while generation continues, which is the point.
    const heavy = readFileSync(new URL('../src/engine/test-fixtures/trochoidal-249k.camj', import.meta.url), 'utf8')
    void seedProject(app.page, heavy).catch(() => {})

    await expect(generation.gearStatus(app.page)).toHaveAttribute('aria-label', /Generating/, { timeout: 20_000 })
    await generation.backendTrigger(app.page).click()
    await generation.stopButton(app.page).click()
    await expect(generation.gearStatus(app.page)).toHaveAttribute('aria-label', /paused/, { timeout: 20_000 })

    // Stop is a real termination, not a flag that lets the work finish quietly.
    // Polled rather than read once: the close notification is delivered out of
    // band and can land just after the status has already flipped.
    await expect.poll(() => workerEvents, { timeout: 20_000 }).toContain('closed')

    // And it is recoverable: Resume puts automatic generation back.
    await generation.backendTrigger(app.page).click()
    await generation.resumeButton(app.page).click()
    await expect(generation.resumeButton(app.page)).toHaveCount(0)
  })
})
