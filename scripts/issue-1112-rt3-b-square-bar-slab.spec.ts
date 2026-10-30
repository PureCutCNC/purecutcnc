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
 * Deliberately NOT under `e2e/`: it asserts nothing, and a spec there without a
 * CI lane fails `npm run check:e2e-lanes`. To run it, copy it into `e2e/` for
 * the duration of the check (it then passes lint and the lane gate does not see
 * it), point PROJECT at the repro file, and run:
 *
 *   cp scripts/issue-1112-rt3-b-square-bar-slab.spec.ts e2e/zz-square-bar-slab.smoke.spec.ts
 *   PURECUT_SLAB_PROJECT=<checkout>/work/turn-on-square-block-test-01.camj \
 *     npx playwright test e2e/zz-square-bar-slab.smoke.spec.ts
 *   rm e2e/zz-square-bar-slab.smoke.spec.ts
 *
 * The PNGs land in `tmp-issue-1112-rt3-b/`: iso, front, bottom, left, and three
 * low-angle views of each end, plus a zoomed underside. Compare them with the
 * reported screenshot; with the clamp in place nothing may sit below the bar's
 * bottom face along the uncut ends.
 */

import { readFileSync, mkdirSync } from 'node:fs'
import { test, expect } from '../../e2e/fixtures'
import { seedProject } from '../../e2e/helpers'

/**
 * The repro project, read from the environment: the file lives in the primary
 * checkout's `work/` folder, outside every worktree, so it has no portable
 * default. Point PURECUT_SLAB_PROJECT at it.
 */
const PROJECT = process.env.PURECUT_SLAB_PROJECT ?? ''
const OUT = 'tmp-issue-1112-rt3-b'

test('scratch: square blank around bar view from every angle', async ({ app, ui }) => {
  test.setTimeout(300_000)
  const { page } = app
  if (PROJECT === '') throw new Error('set PURECUT_SLAB_PROJECT to the repro .camj file')
  mkdirSync(OUT, { recursive: true })
  await seedProject(page, readFileSync(PROJECT, 'utf8'))
  await ui.viewMenu.tabSimulation(page).click()
  const viewport = ui.simSetup.viewport(page)
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
    const canvas = ui.simSetup.canvas(page)
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
})
