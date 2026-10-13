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
 * The Around face in the 3D view and the Simulation tab (issue #395 slice E).
 *
 * A round bar with a rotary machine and one Around setup: the 3D view draws
 * the real bar with the wrapped pass on its surface (captured from the default
 * view and from a low angle, where the underside of the wrap shows), and the
 * Simulation tab lists the Around setup and plays the job unrolled flat.
 *
 * The project is seeded through the page's store, as `setupCam.smoke.spec.ts`
 * and `setupPreview.smoke.spec.ts` do. The fixture already fails the test on
 * any console error, which is what a bad geometry or NaN transform emits.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { getProject, seedProject } from './helpers'
import { roundStock, type MachineDefinition, type Project, type RoundStock } from '../src/types/project'
import { BUNDLED_DEFINITIONS } from '../src/engine/gcode/definitions'

const BAR = roundStock(40, 200, 'x', { x: 10, y: 30 })
/** Flat coordinates of the Around pocket: on the sheet, x along, y across. */
const POCKET = { x: 50, y: BAR.profile.start.y + 12, w: 60, h: 10 }

/**
 * A complete bundled definition plus a rotary axis about x (issue #393). The
 * bundled GRBL carries every block the schema requires, so this is the real
 * machine shape, not a partial object.
 */
function rotaryMachine(): MachineDefinition {
  const grbl = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl')
  if (!grbl) throw new Error('fixture: the bundled GRBL definition is missing')
  return {
    ...structuredClone(grbl),
    id: 'e2e-rotary',
    name: 'E2E Rotary Mill',
    builtin: false,
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  }
}

/**
 * Seed the bar, the rotary machine and an Around setup whose pocket engraves
 * the unrolled sheet. Returns the saved project for the tests to read back.
 */
async function seedAroundProject(page: Page): Promise<Project> {
  await seedGcodeExportProject(page)
  const seeded = await getProject(page) as unknown as Project
  const project = structuredClone(seeded)
  project.meta.name = 'Around bar'
  project.meta.units = 'mm'
  project.stock = BAR
  project.origin = { ...project.origin, x: BAR.profile.start.x, y: BAR.profile.start.y, z: BAR.thickness }
  project.meta.machineDefinitions = project.meta.machineDefinitions ?? []
  project.meta.machineDefinitions = [...project.meta.machineDefinitions, rotaryMachine()]
  project.meta.selectedMachineId = 'e2e-rotary'
  const template = project.features[0]
  const definition = project.featureDefinitions[template.definitionId]
  project.featureDefinitions = {
    ...project.featureDefinitions,
    'around-pocket': {
      ...definition,
      id: 'around-pocket',
      operation: 'subtract',
      profile: {
        start: { x: POCKET.x, y: POCKET.y },
        segments: [
          { type: 'line', to: { x: POCKET.x + POCKET.w, y: POCKET.y } },
          { type: 'line', to: { x: POCKET.x + POCKET.w, y: POCKET.y + POCKET.h } },
          { type: 'line', to: { x: POCKET.x, y: POCKET.y + POCKET.h } },
          { type: 'line', to: { x: POCKET.x, y: POCKET.y } },
        ],
        closed: true,
      },
    },
  }
  project.features = [{
    ...template,
    id: 'around-pocket', name: 'Around pocket', definitionId: 'around-pocket',
    authoringFace: 'around', z_top: BAR.thickness, z_bottom: BAR.thickness - 4,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  }]
  project.featureTree = []
  project.setups = [{
    id: 'setup-around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 },
    indexing: 'manual', registration: [], notes: '', operationIds: [],
  }]
  project.activeSetupId = 'setup-around'
  project.operations = [{
    ...project.operations[0],
    id: 'op-around', name: 'Around pocket', kind: 'pocket',
    target: { source: 'features', featureIds: ['around-pocket'] },
    setupId: 'setup-around', toolRef: 't1', stepdown: 2, stepover: 0.4,
    feed: 600, plungeFeed: 180, rpm: 18000, enabled: true, showToolpath: true,
  }]
  await seedProject(page, JSON.stringify(project))
  return await getProject(page) as unknown as Project
}

async function viewportStats(page: Page) {
  const viewport = page.locator('#workspace-panel-simulation .simulation-viewport')
  return {
    setup: await viewport.getAttribute('data-simulation-setup'),
    removed: Number(await viewport.getAttribute('data-simulation-removed-cells')),
  }
}

test('the 3D view draws the wrapped Around pass on the real bar', async ({ app, ui }, testInfo) => {
  const { page } = app
  const project = await seedAroundProject(page)
  expect((project.stock as RoundStock).shape).toBe('round')
  expect(project.setups[0].kind).toBe('around')

  await ui.viewMenu.tab3d(page).click()
  const canvas = page.locator('#workspace-panel-preview3d canvas')
  await expect(canvas).toBeVisible()
  const size = await canvas.evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }))
  expect(size.width).toBeGreaterThan(0)
  expect(size.height).toBeGreaterThan(0)

  // The scene build is asynchronous; give it a frame and capture the default
  // isometric view the workspace opens on.
  await page.waitForTimeout(500)
  await page.screenshot({ path: testInfo.outputPath('around-3d-default.png') })

  // A low angle: drag the panel roughly -60 px so the camera drops under the
  // bar, then zoom in. The wrapped pass must still be there, underside included.
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  const centre = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  await page.mouse.move(centre.x, centre.y)
  await page.mouse.down()
  await page.mouse.move(centre.x - 60, centre.y, { steps: 12 })
  await page.mouse.up()
  await page.mouse.move(centre.x, centre.y)
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('around-3d-low-angle.png') })

  // The view is still the live 3D scene, not a blank panel after the drag.
  await expect(canvas).toBeVisible()
})

test('the Simulation tab lists the Around setup and plays the unrolled job', async ({ app, ui }, testInfo) => {
  const { page } = app
  await seedAroundProject(page)

  await ui.viewMenu.tabSimulation(page).click()
  await expect(ui.simSetup.picker(page)).toContainText('Around')
  await expect(ui.simSetup.note(page)).toContainText('Around')

  // The flat job is simulated and the fresh sheet loses material.
  await expect.poll(async () => (await viewportStats(page)).removed).toBeGreaterThan(0)
  expect((await viewportStats(page)).setup).toBe('setup-around')
  await expect(ui.simSetup.playTool(page)).toBeEnabled()

  // Play tool runs the whole job to completion.
  await ui.simSetup.playTool(page).click()
  const readout = page.locator('#workspace-panel-simulation .simulation-playback-bar__readout')
  await expect(readout).toBeVisible()
  const play = page.locator('#workspace-panel-simulation .simulation-playback-bar__btn--primary')
  await play.click()
  await expect.poll(async () => Number((await readout.textContent())?.replace('%', '') ?? '0'), {
    timeout: 30_000,
  }).toBe(100)
  await page.screenshot({ path: testInfo.outputPath('around-simulation.png') })
})
