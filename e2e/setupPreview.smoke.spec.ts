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
 * Setup-aware preview and per-setup simulation (issue #947).
 *
 * Every setup's toolpaths stay in canonical stock space and draw together,
 * the active setup's at full strength and the other's muted; simulation runs
 * one setup at a time in its own frame, on fresh stock, and says so.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { getProject, seedProject } from './helpers'
import { rectProfile, type Project } from '../src/types/project'
import type { ToolpathResult } from '../src/engine/toolpaths/types'

const THICKNESS = 2
const BOTTOM_DEPTH = 0.5
const TOP_FLOOR = 1

/** Top pocket and Bottom pocket on a 6 × 4 × 2 in block, one operation each. */
async function seedTwoSetups(page: Page, withBottom = true): Promise<Project> {
  await seedGcodeExportProject(page)
  const project = await getProject(page) as unknown as Project
  project.meta.name = 'Two sides'
  project.stock.profile = rectProfile(0, 0, 6, 4)
  project.stock.thickness = THICKNESS
  project.origin = { ...project.origin, x: 0, y: 4, z: THICKNESS }
  const template = project.features[0]
  const definition = project.featureDefinitions[template.definitionId]
  project.featureDefinitions = {
    body: { ...definition, id: 'body', operation: 'add', profile: rectProfile(0, 0, 6, 4) },
    blind: { ...definition, id: 'blind', operation: 'subtract', profile: rectProfile(0, 0, 1, 1) },
    bottom: { ...definition, id: 'bottom', operation: 'subtract', profile: rectProfile(0, 0, 1, 1) },
  }
  project.features = [
    { ...template, id: 'body', name: 'Stock body', definitionId: 'body', authoringFace: 'top', z_top: THICKNESS, z_bottom: 0, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
    { ...template, id: 'blind', name: 'Top blind', definitionId: 'blind', authoringFace: 'top', z_top: THICKNESS, z_bottom: TOP_FLOOR, transform: { a: 1, b: 0, c: 0, d: 1, e: 0.5, f: 0.5 } },
    ...(withBottom ? [{ ...template, id: 'bottom', name: 'Bottom pocket', definitionId: 'bottom', authoringFace: 'bottom' as const, z_top: BOTTOM_DEPTH, z_bottom: 0, transform: { a: 1, b: 0, c: 0, d: 1, e: 4, f: 1 } }] : []),
  ]
  project.featureTree = []
  const top = { ...project.setups[0], operationIds: ['op-top'] }
  const base = { ...project.operations[0], kind: 'pocket' as const, stepdown: 0.5 }
  project.operations = [
    { ...base, id: 'op-top', name: 'Top pass', target: { source: 'features', featureIds: ['blind'] }, setupId: top.id },
    ...(withBottom ? [{ ...base, id: 'op-bottom', name: 'Bottom pass', target: { source: 'features' as const, featureIds: ['bottom'] }, setupId: 'setup-bottom' }] : []),
  ]
  project.setups = withBottom
    ? [top, { ...top, id: 'setup-bottom', name: 'Bottom', orientation: { axis: 'x', angleDeg: 180 }, operationIds: ['op-bottom'] }]
    : [top]
  project.activeSetupId = top.id
  await seedProject(page, JSON.stringify(project))
  return await getProject(page) as unknown as Project
}

async function simStats(page: Page) {
  const viewport = page.locator('#workspace-panel-simulation .simulation-viewport')
  return {
    setup: await viewport.getAttribute('data-simulation-setup'),
    removed: Number(await viewport.getAttribute('data-simulation-removed-cells')),
    minZ: Number(await viewport.getAttribute('data-simulation-min-z')),
  }
}

test('simulation follows the selected setup, cuts Bottom from the top of the flipped stock and says it is fresh stock', async ({ app, ui }, testInfo) => {
  const { page } = app
  const project = await seedTwoSetups(page)
  const topId = project.setups[0].id

  // The inactive setup's section starts collapsed.
  await ui.setupCam.section(page, 'bottom').getByRole('button', { name: /Bottom operations/ }).click()
  await ui.operations.rowByName(page, 'Bottom pass').click()
  await ui.viewMenu.tabSimulation(page).click()
  await expect(ui.simSetup.picker(page)).toHaveValue('setup-bottom')
  await expect(ui.simSetup.note(page)).toHaveText('Bottom is simulated on fresh stock: material removed by other setups is not shown.')

  // Bottom: the pocket is cut down from the top of the turned stock — in the
  // canonical frame the cutter would come from under it and remove nothing.
  await expect.poll(async () => (await simStats(page)).removed).toBeGreaterThan(0)
  const bottom = await simStats(page)
  expect(bottom.setup).toBe('setup-bottom')
  expect(Math.abs(bottom.minZ - (THICKNESS - BOTTOM_DEPTH))).toBeLessThan(0.05)
  await expect(ui.simSetup.playTool(page)).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('bottom-simulation.png') })

  // Picking Top keeps the Bottom operation off Top's stock in selected mode…
  await ui.simSetup.picker(page).selectOption(topId)
  await expect(ui.simSetup.note(page)).toContainText('Top is simulated on fresh stock')
  await expect.poll(async () => (await simStats(page)).setup).toBe(topId)
  await expect.poll(async () => (await simStats(page)).removed).toBe(0)
  await expect(ui.simSetup.playTool(page)).toBeDisabled()

  // …and the visible set is Top's alone, on fresh stock: its floor, no Bottom cut.
  await ui.simSetup.modeVisible(page).click()
  await expect.poll(async () => (await simStats(page)).removed).toBeGreaterThan(0)
  const top = await simStats(page)
  expect(top.setup).toBe(topId)
  expect(Math.abs(top.minZ - TOP_FLOOR)).toBeLessThan(0.05)
  await page.screenshot({ path: testInfo.outputPath('top-simulation.png') })

  // Selecting an operation hands the choice back to its setup.
  await ui.operations.rowByName(page, 'Top pass').click()
  await ui.operations.rowByName(page, 'Bottom pass').click()
  await expect(ui.simSetup.picker(page)).toHaveValue('setup-bottom')
})

test('a single-setup project simulates as before, with no picker and no note', async ({ app, ui }) => {
  const { page } = app
  await seedTwoSetups(page, false)
  await ui.operations.rowByName(page, 'Top pass').click()
  await ui.viewMenu.tabSimulation(page).click()
  await expect.poll(async () => (await simStats(page)).removed).toBeGreaterThan(0)
  await expect(ui.simSetup.picker(page)).toHaveCount(0)
  await expect(ui.simSetup.note(page)).toHaveCount(0)
})

test('the sketch draws both setups, the other muted, on Canvas and on GPU in a mirrored Bottom view', async ({ app }, testInfo) => {
  const result = await app.page.evaluate(async () => {
    const gpuUrl = '/src/components/canvas/gpuToolpathRenderer.ts'
    const canvasUrl = '/src/components/canvas/previewPrimitives.ts'
    const paletteUrl = '/src/components/canvas/canvasPalette.ts'
    const viewUrl = '/src/components/canvas/viewTransform.ts'
    const { GpuToolpathRenderer } = await import(gpuUrl) as typeof import('../src/components/canvas/gpuToolpathRenderer')
    const { drawToolpath } = await import(canvasUrl) as typeof import('../src/components/canvas/previewPrimitives')
    const { canvasColors } = await import(paletteUrl) as typeof import('../src/components/canvas/canvasPalette')
    const { reflectContextForView } = await import(viewUrl) as typeof import('../src/components/canvas/viewTransform')
    const size = { width: 240, height: 160 }
    const gpuCanvas = document.createElement('canvas')
    const reference = document.createElement('canvas')
    const readback = document.createElement('canvas')
    for (const canvas of [gpuCanvas, reference, readback]) Object.assign(canvas, size)
    const gpu = new GpuToolpathRenderer(gpuCanvas, () => {})
    const point = (x: number, y: number) => ({ x, y, z: 0 })
    const path = (operationId: string, y: number): ToolpathResult => ({
      operationId, bounds: null, warnings: [],
      moves: [{ kind: 'cut', from: point(20, y), to: point(100, y) }],
    })
    const active = path('active', 30)
    const muted = path('muted', 60)
    const visibility = { cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true, directions: false }
    // Bottom flipped about X: world y is drawn at 150 − y.
    const vt = { scale: 1, offsetX: 10, offsetY: 0, mirrorY: 150 }
    const ctx = reference.getContext('2d')!
    const read = readback.getContext('2d')!
    ctx.save()
    reflectContextForView(ctx, vt)
    drawToolpath(ctx, muted, vt, false, visibility, 0.4, { simplifyForDisplay: false, muted: true })
    drawToolpath(ctx, active, vt, false, visibility, 0.4, { simplifyForDisplay: false })
    ctx.restore()
    gpu.render([
      { toolpath: muted, emphasized: false, slotScale: 0.4, muted: true },
      { toolpath: active, emphasized: false, slotScale: 0.4 },
    ], vt, size.width, size.height, visibility, canvasColors())
    read.drawImage(gpuCanvas, 0, 0)
    const sample = (context: CanvasRenderingContext2D, x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data)
    // x = 10 + 60, y = 150 − world y.
    const rows = { active: 120, muted: 90, unmirroredActive: 30 }
    const out = {
      canvasActive: sample(ctx, 70, rows.active), gpuActive: sample(read, 70, rows.active),
      canvasMuted: sample(ctx, 70, rows.muted), gpuMuted: sample(read, 70, rows.muted),
      gpuUnmirrored: sample(read, 70, rows.unmirroredActive),
      swatch: readback.toDataURL(),
    }
    gpu.dispose()
    return out
  })
  // The GPU draws the mirrored view where Canvas does, and nothing where an unmirrored one would.
  expect(result.gpuActive[3]).toBeGreaterThan(0)
  expect(result.gpuUnmirrored[3]).toBe(0)
  for (const [canvas, gpu] of [[result.canvasActive, result.gpuActive], [result.canvasMuted, result.gpuMuted]]) {
    for (let channel = 0; channel < 4; channel += 1) expect(Math.abs(canvas[channel] - gpu[channel])).toBeLessThanOrEqual(12)
  }
  // The other setup's path is drawn, but clearly fainter than the active one.
  expect(result.gpuMuted[3]).toBeGreaterThan(0)
  expect(result.gpuMuted[3]).toBeLessThan(result.gpuActive[3] / 2)
  await testInfo.attach('mirrored-muted-swatch', { body: Buffer.from(result.swatch.split(',')[1], 'base64'), contentType: 'image/png' })
})

test('the GPU renderer keeps drawing when the workspace turns to Bottom', async ({ app, ui }, testInfo) => {
  const { page } = app
  await page.goto('/?toolpathRenderer=gpu')
  await seedTwoSetups(page)
  const base = page.locator('canvas.sketch-canvas')
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
  await ui.face.segment(page, 'Bottom').click()
  await expect(ui.face.segment(page, 'Bottom')).toHaveAttribute('aria-pressed', 'true')
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
  await expect(page.locator('canvas.sketch-toolpath-gpu')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('bottom-sketch-gpu.png') })
  await ui.viewMenu.tab3d(page).click()
  await page.screenshot({ path: testInfo.outputPath('bottom-3d.png') })
})
