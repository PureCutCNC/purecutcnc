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
 * Scratch visual check for issue #1112 rt3-b (item 26): the thin slab Frank
 * saw under each uncut square end of `turn-on-square-block-test-01.camj` in the
 * Simulation tab, looked at from a low angle.
 *
 * Deliberately NOT under `e2e/`: it belongs to no CI lane, and a spec there
 * without one fails `npm run check:e2e-lanes`. It is a plain Playwright spec:
 * its only import is `@playwright/test`, and it seeds the project through the
 * dev-only `__pcTest` seam exactly as `e2e/helpers.ts#seedProject` does, so the
 * copy below is all it needs. It takes no relative import from `e2e/` — the
 * earlier version's `../../e2e/...` resolved outside the worktree and broke
 * even after the copy (Codex review of rt3-b, correction round 1).
 *
 *   cp scripts/issue-1112-rt3-b-square-bar-slab.spec.ts e2e/zz-square-bar-slab.smoke.spec.ts
 *   PURECUT_SLAB_PROJECT=<checkout>/work/turn-on-square-block-test-01.camj \
 *     npx playwright test e2e/zz-square-bar-slab.smoke.spec.ts
 *   rm e2e/zz-square-bar-slab.smoke.spec.ts
 *
 * Remove the copy before any build or lane check: while it exists it is a spec
 * under `e2e/` claimed by no lane, which `check:e2e-lanes` rejects.
 *
 * The PNGs land in `tmp-issue-1112-rt3-b/`: iso, front, bottom, left, three
 * low-angle views, and one orbited front view. Compare them with the reported
 * screenshot; with the clamp in place nothing may sit below the bar's bottom
 * face along the uncut ends.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'

/**
 * The repro project, read from the environment: the file lives in the primary
 * checkout's `work/` folder, outside every worktree, so it has no portable
 * default. Point PURECUT_SLAB_PROJECT at it.
 */
const PROJECT = process.env.PURECUT_SLAB_PROJECT ?? ''
const OUT = 'tmp-issue-1112-rt3-b'

/** Load a project JSON string through the dev-only seam (as `e2e/helpers.ts` does). */
async function seedProject(page: Page, json: string): Promise<void> {
  await page.evaluate(async ({ json: text }: { json: string }) => {
    const w = window as unknown as { __pcTest: { loadProject: (s: string) => Promise<void> } }
    await w.__pcTest.loadProject(text)
  }, { json })
}

test('scratch: square blank around bar view from every angle', async ({ page }) => {
  test.setTimeout(300_000)
  // Keep the shared e2e fixture's console-error guard: a shader that fails to
  // compile renders nothing and would make every screenshot look clean.
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => {
    errors.push(error.message)
  })
  await page.goto('/')
  await page.waitForSelector('canvas', { timeout: 15_000 })

  if (PROJECT === '') throw new Error('set PURECUT_SLAB_PROJECT to the repro .camj file')
  mkdirSync(OUT, { recursive: true })
  await seedProject(page, readFileSync(PROJECT, 'utf8'))
  await page.getByRole('tab', { name: 'Simulation' }).click()
  const viewport = page.locator('#workspace-panel-simulation .simulation-viewport')
  await expect(viewport).toHaveAttribute('data-simulation-view', 'bar', { timeout: 120_000 })
  await expect(viewport).toHaveAttribute('data-simulation-surface', 'heightfield', { timeout: 120_000 })

  // Visible mode replays both rotary operations: square ends, turned middle.
  await page.locator('.simulation-mode-toggle__btn', { hasText: 'Visible' }).click()
  // Wait for the replayed result itself, not a fixed delay: the attribute is
  // the simulation's own removed-cell count.
  await expect(viewport).toHaveAttribute('data-simulation-removed-cells', /[0-9]+/, { timeout: 120_000 })
  await page.waitForTimeout(2000)
  console.log('removed cells', await viewport.getAttribute('data-simulation-removed-cells'))

  const preset = async (label: string) => {
    await page.locator('#workspace-panel-simulation').getByRole('button', { name: 'Camera view' }).click()
    await page.getByRole('menuitemradio', { name: label }).click()
    await page.waitForTimeout(1500)
  }
  const orbit = async (dx: number, dy: number) => {
    const canvas = page.locator('#workspace-panel-simulation canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('no simulation canvas')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    for (let step = 1; step <= 12; step += 1) {
      await page.mouse.move(cx + (dx * step) / 12, cy + (dy * step) / 12)
      await page.waitForTimeout(40)
    }
    await page.mouse.up()
    await page.waitForTimeout(1200)
  }

  for (const [label, file] of [
    ['Isometric view', 'iso'],
    ['Front view', 'front'],
    ['Bottom view', 'bottom'],
    ['Left view', 'left'],
  ] as const) {
    await preset(label)
    await page.screenshot({ path: `${OUT}/${file}.png` })
  }

  // Low angles: the only place a lip under the ends can be seen.
  await preset('Bottom view')
  for (let step = 1; step <= 3; step += 1) {
    await orbit(0, -30)
    await page.screenshot({ path: `${OUT}/low-${step}.png` })
  }
  await preset('Front view')
  await orbit(60, -30)
  await page.screenshot({ path: `${OUT}/low-front.png` })

  if (errors.length > 0) throw new Error(`console errors during the check:\n${errors.join('\n')}`)
})
