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

import { test, expect } from './fixtures'
import { seedToolpathVisProject, TOOLPATH_VIS_FIXTURE_JSON } from './toolpathVisibility.helpers'
import type { Project } from '../src/types/project'
import type { ToolpathResult } from '../src/engine/toolpaths/types'

test('GPU renderer coverage union, shared styles, transform and retained buffers', async ({ app }, testInfo) => {
  const result = await app.page.evaluate(async () => {
    const gpuUrl = '/src/components/canvas/gpuToolpathRenderer.ts'
    const canvasUrl = '/src/components/canvas/previewPrimitives.ts'
    const paletteUrl = '/src/components/canvas/canvasPalette.ts'
    const { GpuToolpathRenderer } = await import(gpuUrl) as typeof import('../src/components/canvas/gpuToolpathRenderer')
    const { drawToolpath } = await import(canvasUrl) as typeof import('../src/components/canvas/previewPrimitives')
    const { canvasColors } = await import(paletteUrl) as typeof import('../src/components/canvas/canvasPalette')
    const gpuCanvas = document.createElement('canvas')
    const reference = document.createElement('canvas')
    const readback = document.createElement('canvas')
    for (const canvas of [gpuCanvas, reference, readback]) { canvas.width = 360; canvas.height = 240 }
    const gpu = new GpuToolpathRenderer(gpuCanvas, () => {})
    const point = (x: number, y: number, z = 0) => ({ x, y, z })
    const toolpath: ToolpathResult = {
      operationId: 'synthetic-gpu-parity', bounds: null, warnings: [],
      moves: [
        ...Array.from({ length: 1000 }, () => ({ kind: 'cut' as const, from: point(20, 30), to: point(140, 30) })),
        { kind: 'cut', from: point(80, 15), to: point(80, 40) },
        { kind: 'cut', from: point(20, 50), to: point(140, 50) },
        { kind: 'lead_in', from: point(20, 70), to: point(140, 70) },
        { kind: 'rapid', from: point(20, 90, 5), to: point(140, 90, 5) },
        { kind: 'plunge', from: point(20, 110, 5), to: point(140, 110) },
        { kind: 'rapid', from: point(20, 130), to: point(140, 130, 5) },
        { kind: 'cut', from: point(20, 150), to: point(140, 150), feedScale: .4 },
        { kind: 'rapid', from: point(20, 170, 5), to: point(140, 170, 5) },
      ], collidingMoveIndices: [1007],
    }
    const visibility = { cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true, directions: false, feedColours: true }
    const vt = { scale: 1, offsetX: 10, offsetY: 10 }
    const ctx = reference.getContext('2d')!, read = readback.getContext('2d')!
    const sample = (context: CanvasRenderingContext2D, x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data)
    const render = (emphasized: boolean) => {
      ctx.clearRect(0, 0, 360, 240)
      drawToolpath(ctx, toolpath, vt, emphasized, visibility, .4, { simplifyForDisplay: false })
      gpu.render([{ toolpath, emphasized, slotScale: .4 }], vt, 360, 240, visibility, canvasColors())
      read.clearRect(0, 0, 360, 240); read.drawImage(gpuCanvas, 0, 0)
    }
    try {
      render(false)
      const alpha = [40, 60].map(y => ({ canvas: sample(ctx, 50, y), gpu: sample(read, 50, y) }))
      const crossing = sample(read, 90, 40)
      render(true)
      const layers = [80, 100, 140, 160, 180].map(y => ({ canvas: sample(ctx, 50, y), gpu: sample(read, 50, y) }))
      const swatch = readback.toDataURL()
      const before = gpu.stats.preparations
      gpu.render([{ toolpath, emphasized: true, slotScale: .4 }], { scale: 1.5, offsetX: 20, offsetY: 15 }, 480, 300, visibility, canvasColors())
      const after = gpu.stats.preparations
      read.clearRect(0, 0, 360, 240); read.drawImage(gpuCanvas, 0, 0)
      const transformed = sample(read, 70, 60)
      const oldPosition = sample(read, 70, 40)
      // Hidden ordinary layers must not hide collision warnings.
      const hidden = { ...visibility, cuts: false, leadIns: false, rapids: false, plunges: false, retractions: false }
      gpu.render([{ toolpath, emphasized: true, slotScale: .4 }], vt, 360, 240, hidden, canvasColors())
      read.clearRect(0, 0, 360, 240); read.drawImage(gpuCanvas, 0, 0)
      const hiddenCut = sample(read, 50, 40)
      const collision = sample(read, 50, 180)
      gpu.render([], vt, 360, 240, visibility, canvasColors())
      read.clearRect(0, 0, 360, 240); read.drawImage(gpuCanvas, 0, 0)
      const cleared = sample(read, 50, 180)
      gpu.render([{ toolpath, emphasized: true, slotScale: .4 }], vt, 360, 240, visibility, canvasColors())
      const afterClear = gpu.stats.preparations
      const submissions = gpu.stats.submissions
      const zeroSize = gpu.render([], vt, 0, 0, visibility, canvasColors())
      const zeroSizeSubmissions = gpu.stats.submissions
      gpu.dispose()
      const disposed = gpu.render([], vt, 360, 240, visibility, canvasColors())
      return { alpha, crossing, layers, swatch, before, after, transformed, oldPosition, hiddenCut, collision, cleared, afterClear, submissions, zeroSize, zeroSizeSubmissions, disposed }
    } finally { gpu.dispose() }
  })
  expect(result.alpha[0].gpu[3]).toBe(result.alpha[1].gpu[3])
  expect(result.crossing[3]).toBe(result.alpha[0].gpu[3])
  for (const row of [...result.alpha, ...result.layers]) {
    expect(row.gpu[3]).toBeGreaterThan(0)
    for (let i = 0; i < 4; i++) expect(Math.abs(row.canvas[i] - row.gpu[i])).toBeLessThanOrEqual(12)
  }
  expect(result.before).toBe(result.after)
  expect(result.transformed[3]).toBeGreaterThan(0)
  expect(result.oldPosition[3]).toBe(0)
  expect(result.hiddenCut[3]).toBe(0)
  expect(result.collision[3]).toBeGreaterThan(0)
  expect(result.cleared[3]).toBe(0)
  expect(result.afterClear).toBe(result.after + 1)
  expect(result.zeroSize).toBe(false)
  expect(result.zeroSizeSubmissions).toBe(result.submissions)
  expect(result.disposed).toBe(false)
  await testInfo.attach('gpu-poc-layer-swatch', { body: Buffer.from(result.swatch.split(',')[1], 'base64'), contentType: 'image/png' })
})

test('GPU renderer opts in, retains buffers through navigation and falls back on context loss', async ({ app, ui }) => {
  const page = app.page
  await page.goto('/?toolpathRenderer=gpu')
  await seedToolpathVisProject(page)
  const base = page.locator('canvas.sketch-canvas')
  const gpu = page.locator('canvas.sketch-toolpath-gpu')
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
  await ui.operations.rowByName(page, 'Route A').click()
  const preparations = () => gpu.getAttribute('data-poc-stats').then(value => JSON.parse(value!).preparations as number)
  const before = await preparations()
  const box = (await base.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 15, { steps: 8 })
  await page.mouse.up({ button: 'middle' })
  await page.mouse.wheel(0, -120)
  expect(await preparations()).toBe(before)
  const directions = ui.toolpathVis.sketchItems(page).filter({ hasText: 'Directions' })
  await expect(directions).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => {
    const gl = document.querySelector<HTMLCanvasElement>('canvas.sketch-toolpath-gpu')!.getContext('webgl2')!
    const extension = gl.getExtension('WEBGL_lose_context')!
    Object.assign(window, { restoreGpuPocContext: () => extension.restoreContext() })
    extension.loseContext()
  })
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'canvas-fallback')
  await expect(gpu).toBeHidden()
  await expect(directions).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => (window as unknown as { restoreGpuPocContext: () => void }).restoreGpuPocContext())
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
  await expect(gpu).toBeVisible()
  await page.goto('/')
  await expect(page.locator('canvas.sketch-toolpath-gpu')).toHaveCount(0)
})

test('GPU renderer initialization failure leaves Canvas toolpaths available', async ({ app, ui }) => {
  const page = app.page
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = new Proxy(original, {
      apply(target, canvas: HTMLCanvasElement, args: unknown[]) {
        if (canvas.classList.contains('sketch-toolpath-gpu') && args[0] === 'webgl2') return null
        return Reflect.apply(target, canvas, args)
      },
    })
  })
  await page.goto('/?toolpathRenderer=gpu')
  await seedToolpathVisProject(page)
  await expect(page.locator('canvas.sketch-canvas')).toHaveAttribute('data-toolpath-renderer', 'canvas-fallback')
  await expect(ui.toolpathVis.sketchPanel(page)).toBeVisible()
  await expect(page.locator('canvas.sketch-toolpath-gpu')).toHaveCount(0)
})



test('renderer preference persists without changing project, history or booklet pixels', async ({ app }) => {
  const page = app.page
  await seedToolpathVisProject(page)
  const selector = page.getByRole('button', { name: 'GPU', exact: true })
  const base = page.locator('canvas.sketch-canvas')
  await expect(selector).toHaveAttribute('aria-pressed', 'false')
  const snapshot = () => page.evaluate(async () => {
    const storeUrl = '/src/store/projectStore.ts'
    const snapshotUrl = '/src/components/canvas/operationSnapshot.ts'
    const { useProjectStore } = await import(storeUrl) as typeof import('../src/store/projectStore')
    const { renderOperationSnapshotPng } = await import(snapshotUrl) as typeof import('../src/components/canvas/operationSnapshot')
    const state = useProjectStore.getState()
    const toolpath: ToolpathResult = {
      operationId: state.project.operations[0].id, warnings: [], bounds: null,
      moves: [{ kind: 'cut', from: { x: 30, y: 30, z: 0 }, to: { x: 90, y: 30, z: 0 } }],
    }
    const png = await renderOperationSnapshotPng(state.project, state.project.operations[0], toolpath, { pixelRatio: 1 })
    return { project: JSON.stringify(state.project), history: JSON.stringify(state.history), dirty: state.dirty, png: Array.from(png) }
  })
  const before = await snapshot()
  await page.evaluate(async () => {
    const url = '/src/components/canvas/gpuToolpathRenderer.ts'
    const { GpuToolpathRenderer } = await import(url) as typeof import('../src/components/canvas/gpuToolpathRenderer')
    const render = GpuToolpathRenderer.prototype.render
    const seen = new Set<ToolpathResult>()
    GpuToolpathRenderer.prototype.render = function (...args) {
      for (const entry of args[0]) seen.add(entry.toolpath)
      return render.apply(this, args)
    }
    Object.assign(window, { generatedResultCount: () => seen.size })
  })
  await selector.click()
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
  expect(await snapshot()).toEqual(before)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('purecutcnc.toolpathRenderer'))).toBe('gpu')
  for (let i = 0; i < 3; i++) {
    await selector.click()
    await expect(page.locator('canvas.sketch-toolpath-gpu, canvas.sketch-toolpath-foreground')).toHaveCount(0)
    await selector.click()
    await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
    await expect(page.locator('canvas.sketch-toolpath-gpu')).toHaveCount(1)
  }
  expect(await snapshot()).toEqual(before)
  expect(await page.evaluate(() => (window as unknown as { generatedResultCount: () => number }).generatedResultCount())).toBe(1)
  await page.evaluate(() => {
    const gl = document.querySelector<HTMLCanvasElement>('canvas.sketch-toolpath-gpu')!.getContext('webgl2')!
    const extension = gl.getExtension('WEBGL_lose_context')!
    Object.assign(window, { restoreBookletGpu: () => extension.restoreContext() })
    extension.loseContext()
  })
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'canvas-fallback')
  expect(await snapshot()).toEqual(before)
  await page.evaluate(() => (window as unknown as { restoreBookletGpu: () => void }).restoreBookletGpu())
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
  await page.reload()
  await seedToolpathVisProject(page)
  await expect(selector).toHaveAttribute('aria-pressed', 'true')
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
  await page.getByRole('tab', { name: '3D view', exact: true }).click()
  await expect(selector).toBeHidden()
  await page.getByRole('tab', { name: 'Sketch', exact: true }).click()
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
})

test('GPU startup failure has a persistent preference, visible fallback and working retry', async ({ app }) => {
  const page = app.page
  await seedToolpathVisProject(page)
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = new Proxy(original, {
      apply(target, canvas: HTMLCanvasElement, args: unknown[]) {
        if (canvas.classList.contains('sketch-toolpath-gpu') && args[0] === 'webgl2') return null
        return Reflect.apply(target, canvas, args)
      },
    })
    Object.assign(window, { allowGpu: () => { HTMLCanvasElement.prototype.getContext = original } })
  })
  const selector = page.getByRole('button', { name: 'GPU', exact: true })
  const base = page.locator('canvas.sketch-canvas')
  await selector.click()
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'canvas-fallback')
  await expect(page.getByRole('status').filter({ hasText: 'GPU unavailable; using Canvas.' })).toBeVisible()
  await expect(selector).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => localStorage.getItem('purecutcnc.toolpathRenderer'))).toBe('gpu')
  await page.evaluate(() => (window as unknown as { allowGpu: () => void }).allowGpu())
  await page.getByRole('button', { name: 'Retry GPU', exact: true }).click()
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
  await expect(page.getByText('GPU unavailable; using Canvas.')).toHaveCount(0)
})

test('switching away cancels a pending lazy GPU load', async ({ app }) => {
  const page = app.page
  await seedToolpathVisProject(page)
  let release: () => void = () => {}
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route('**/gpuToolpathRenderer.ts', async route => { await pending; await route.continue() })
  const selector = page.getByRole('button', { name: 'GPU', exact: true })
  const request = page.waitForRequest('**/gpuToolpathRenderer.ts')
  await selector.click()
  await request
  await expect(selector).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByRole('status').filter({ hasText: 'Starting GPU' })).toHaveCount(1)
  await selector.click()
  release()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.locator('canvas.sketch-canvas')).toHaveAttribute('data-toolpath-renderer', 'canvas')
  await expect(page.locator('canvas.sketch-toolpath-gpu, canvas.sketch-toolpath-foreground')).toHaveCount(0)
  await selector.click()
  await expect(page.locator('canvas.sketch-canvas')).toHaveAttribute('data-toolpath-renderer', 'gpu')
  await expect(page.locator('canvas.sketch-toolpath-gpu')).toHaveCount(1)
})

for (const hasTouch of [false, true]) {
  test.describe(`GPU loading layout (${hasTouch ? 'tablet' : 'desktop'})`, () => {
    test.use({ hasTouch, viewport: { width: 1024, height: 768 } })
    test('pending startup keeps the panel and toggle positions stable', async ({ app }, testInfo) => {
      const page = app.page
      await seedToolpathVisProject(page)
      let release: () => void = () => {}
      const pending = new Promise<void>(resolve => { release = resolve })
      await page.route('**/gpuToolpathRenderer.ts', async route => { await pending; await route.continue() })
      const gpu = page.getByRole('button', { name: 'GPU', exact: true })
      const panel = page.locator('#workspace-panel-sketch .viewport-toolpath-vis')
      const layout = () => panel.evaluate(element => [element, ...element.querySelectorAll('button')].map(node => {
        const { x, y, width, height } = node.getBoundingClientRect()
        return { x, y, width, height }
      }))
      try {
        if (hasTouch) await gpu.tap()
        else await gpu.click()
        await expect(gpu).toHaveAttribute('aria-busy', 'true')
        await expect(gpu).toHaveAttribute('title', /Starting GPU/)
        const loadingLayout = await layout()
        await testInfo.attach('gpu-loading', { body: await panel.screenshot(), contentType: 'image/png' })
        release()
        await page.unrouteAll({ behavior: 'wait' })
        await expect(page.locator('canvas.sketch-canvas')).toHaveAttribute('data-toolpath-renderer', 'gpu')
        await expect(gpu).toHaveAttribute('aria-busy', 'false')
        await expect(page.getByRole('status').filter({ hasText: 'Starting GPU' })).toHaveCount(0)
        expect(await layout()).toEqual(loadingLayout)
      } finally {
        release()
        await page.unrouteAll({ behavior: 'wait' })
      }
    })
  })
}


test('GPU annotation painter order matches Canvas across selection, resize and navigation', async ({ app }, testInfo) => {
  const results = await app.page.evaluate(async () => {
    const gpuUrl = '/src/components/canvas/gpuToolpathRenderer.ts'
    const previewUrl = '/src/components/canvas/previewPrimitives.ts'
    const paletteUrl = '/src/components/canvas/canvasPalette.ts'
    const { GpuToolpathRenderer } = await import(gpuUrl) as typeof import('../src/components/canvas/gpuToolpathRenderer')
    const { drawToolpath, drawToolpathAnnotations } = await import(previewUrl) as typeof import('../src/components/canvas/previewPrimitives')
    const { canvasColors } = await import(paletteUrl) as typeof import('../src/components/canvas/canvasPalette')
    const canvases = Array.from({ length: 4 }, () => document.createElement('canvas'))
    const [gpuCanvas, reference, incorrect, readback] = canvases
    const gpu = new GpuToolpathRenderer(gpuCanvas, () => {})
    const ctx = reference.getContext('2d')!, wrong = incorrect.getContext('2d')!, read = readback.getContext('2d')!
    const sources = ['bridgeSplitArms', 'siblingBridge', 'sameChildBridge', 'bootstrap', 'stepArms', 'intCornerBridge', 'contour', 'tryDirectLink', 'microContour']
    const point = (x: number, y: number) => ({ x, y, z: 0 })
    const selected: ToolpathResult = {
      operationId: 'annotated', warnings: [], debugToolpath: true,
      bounds: { minX: 20, minY: 20, minZ: 0, maxX: 180, maxY: 300, maxZ: 0 },
      moves: sources.map((source, i) => ({ kind: 'cut', from: point(20, 30 + i * 30), to: point(180, 30 + i * 30), source })),
    }
    const later: ToolpathResult = {
      operationId: 'later', warnings: [], bounds: selected.bounds,
      moves: [{ kind: 'rapid', from: point(100.5, 10), to: point(100.5, 300) }],
      collidingMoveIndices: [0],
    }
    const visibility = { cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true, directions: true, feedColours: false }
    const rows: { correctError: number; incorrectError: number; pixels: number }[] = []
    const swatches: string[] = []
    try {
      for (const [scale, width, height] of [[1, 240, 330], [2, 460, 660], [1, 240, 330]]) {
        for (const canvas of canvases) { canvas.width = width; canvas.height = height }
        const vt = { scale, offsetX: 10, offsetY: 10 }
        for (const deferArrows of [false, true]) {
          ctx.clearRect(0, 0, width, height); wrong.clearRect(0, 0, width, height)
          const entries = [{ toolpath: selected, emphasized: true, slotScale: 1 }, { toolpath: later, emphasized: false, slotScale: 1 }]
          for (const { toolpath, emphasized } of entries) drawToolpath(ctx, toolpath, vt, emphasized, visibility, 1, { deferArrows, simplifyForDisplay: false })
          for (const { toolpath, emphasized } of entries) drawToolpath(wrong, toolpath, vt, emphasized, { ...visibility, directions: false }, 1, { simplifyForDisplay: false })
          drawToolpathAnnotations(wrong, selected, vt, true, visibility, { deferArrows })
          gpu.render(entries, vt, width, height, visibility, canvasColors(), deferArrows)
          read.clearRect(0, 0, width, height); read.drawImage(gpuCanvas, 0, 0)
          if (rows.length === 2) swatches.push(reference.toDataURL(), readback.toDataURL(), incorrect.toDataURL())
          const a = ctx.getImageData(0, 0, width, height).data
          const b = wrong.getImageData(0, 0, width, height).data
          const g = read.getImageData(0, 0, width, height).data
          let correctError = 0, incorrectError = 0, pixels = 0
          const channel = (pixels: Uint8ClampedArray, i: number, c: number) =>
            c === 3 ? pixels[i + c] : pixels[i + c] * pixels[i + 3] / 255
          for (let i = 0; i < a.length; i += 4) {
            // Compare premultiplied pixels: straight RGB is undefined at zero
            // alpha and exaggerates MSAA edge differences. Only inspect pixels
            // that distinguish the correct order from the old all-arrows-last.
            if (Math.max(...[0, 1, 2].map(c => Math.abs(channel(a, i, c) - channel(b, i, c)))) < 30) continue
            for (let c = 0; c < 4; c++) {
              correctError += Math.abs(channel(a, i, c) - channel(g, i, c))
              incorrectError += Math.abs(channel(b, i, c) - channel(g, i, c))
            }
            pixels++
          }
          rows.push({ correctError, incorrectError, pixels })
        }
      }
      gpu.render([{ toolpath: selected, emphasized: false, slotScale: 1 }], { scale: 1, offsetX: 10, offsetY: 10 }, 240, 330, visibility, canvasColors())
      read.clearRect(0, 0, 240, 330); read.drawImage(gpuCanvas, 0, 0)
      const unselectedMarkerAlpha = read.getImageData(110, 43, 1, 1).data[3]
      gpu.render([], { scale: 1, offsetX: 0, offsetY: 0 }, 240, 330, visibility, canvasColors())
      read.clearRect(0, 0, 240, 330); read.drawImage(gpuCanvas, 0, 0)
      const emptyAlpha = read.getImageData(110, 43, 1, 1).data[3]
      return { rows, unselectedMarkerAlpha, emptyAlpha, swatches }
    } finally { gpu.dispose() }
  })
  for (const [index, swatch] of results.swatches.entries()) {
    await testInfo.attach('annotation-order-' + ['canvas', 'gpu', 'incorrect'][index], { body: Buffer.from(swatch.split(',')[1], 'base64'), contentType: 'image/png' })
  }
  for (const row of results.rows) {
    expect(row.pixels).toBeGreaterThan(0)
    expect(row.correctError / row.pixels, JSON.stringify(results.rows)).toBeLessThan(35)
    expect(row.correctError).toBeLessThan(row.incorrectError / 2)
  }
  expect(results.unselectedMarkerAlpha).toBe(0)
  expect(results.emptyAlpha).toBe(0)
})


test('production renderer toggle works through normal project Open and persists', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const production = testInfo.project.name === 'production'
  await page.goto('/?toolpathRenderer=gpu')
  const base = page.locator('canvas.sketch-canvas')
  if (production) {
    expect(await page.evaluate(() => '__pcTest' in window)).toBe(false)
    // A DEV comparison URL must not bypass the production default.
    await expect(base).toHaveAttribute('data-toolpath-renderer', 'canvas')
  }
  await page.goto('/')
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'canvas')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  await (await chooser).setFiles({ name: 'renderer.camj', mimeType: 'application/json', buffer: Buffer.from(TOOLPATH_VIS_FIXTURE_JSON) })
  const selector = page.getByRole('button', { name: 'GPU', exact: true })
  await expect(selector).toHaveAttribute('aria-pressed', 'false')
  await selector.click()
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
  if (production) await expect(page.locator('canvas.sketch-toolpath-gpu')).not.toHaveAttribute('data-poc-stats')
  await page.reload()
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
  expect(await page.evaluate(() => localStorage.getItem('purecutcnc.toolpathRenderer'))).toBe('gpu')
  expect(errors).toEqual([])
})


test('render failure falls back until explicit retry, without leaving stale overlays', async ({ app }) => {
  const page = app.page
  await seedToolpathVisProject(page)
  await page.evaluate(async () => {
    const url = '/src/components/canvas/gpuToolpathRenderer.ts'
    const { GpuToolpathRenderer } = await import(url) as typeof import('../src/components/canvas/gpuToolpathRenderer')
    const render = GpuToolpathRenderer.prototype.render
    GpuToolpathRenderer.prototype.render = () => { throw new Error('injected render failure') }
    Object.assign(window, { repairGpu: () => { GpuToolpathRenderer.prototype.render = render } })
  })
  const selector = page.getByRole('button', { name: 'GPU', exact: true })
  const base = page.locator('canvas.sketch-canvas')
  await selector.click()
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'canvas-fallback')
  await expect(base).toHaveAttribute('data-toolpath-renderer-error', /injected render failure/)
  await expect(page.locator('canvas.sketch-toolpath-gpu')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Retry GPU', exact: true })).toBeVisible()
  await page.evaluate(() => (window as unknown as { repairGpu: () => void }).repairGpu())
  await page.getByRole('button', { name: 'Retry GPU', exact: true }).click()
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
  await expect(page.locator('canvas.sketch-toolpath-gpu')).toHaveCount(1)
  await expect(page.locator('canvas.sketch-toolpath-foreground')).toHaveCount(1)
  await expect(base).not.toHaveAttribute('data-toolpath-renderer-error')
})

test('hidden sketch submits no GPU work and releases hidden/replaced results', async ({ app }) => {
  const page = app.page
  await seedToolpathVisProject(page)
  await page.evaluate(async () => {
    const url = '/src/components/canvas/gpuToolpathRenderer.ts'
    const { GpuToolpathRenderer } = await import(url) as typeof import('../src/components/canvas/gpuToolpathRenderer')
    const render = GpuToolpathRenderer.prototype.render
    const retain = GpuToolpathRenderer.prototype.retain
    const observation = { submissions: 0, retained: -1 }
    GpuToolpathRenderer.prototype.render = function (...args) { observation.submissions++; return render.apply(this, args) }
    GpuToolpathRenderer.prototype.retain = function (toolpaths) { observation.retained = toolpaths.length; return retain.call(this, toolpaths) }
    Object.assign(window, { gpuObservation: observation })
  })
  await page.getByRole('button', { name: 'GPU', exact: true }).click()
  await expect(page.locator('canvas.sketch-canvas')).toHaveAttribute('data-toolpath-renderer', 'gpu')
  await page.getByRole('tab', { name: '3D view', exact: true }).click()
  await expect(page.locator('canvas.sketch-canvas')).toBeHidden()
  const read = () => page.evaluate(() => (window as unknown as { gpuObservation: { submissions: number; retained: number } }).gpuObservation)
  const before = await read()
  await page.getByRole('button', { name: 'Hide all toolpaths', exact: true }).click()
  await expect.poll(async () => (await read()).retained).toBe(0)
  expect((await read()).submissions).toBe(before.submissions)
  await seedToolpathVisProject(page)
  await expect.poll(async () => (await read()).retained).toBeGreaterThan(0)
  expect((await read()).submissions).toBe(before.submissions)
  await page.getByRole('tab', { name: 'Sketch', exact: true }).click()
  await expect.poll(async () => (await read()).submissions).toBeGreaterThan(before.submissions)
  await expect(page.locator('canvas.sketch-toolpath-gpu')).toBeVisible()
})


test.describe('GPU tablet emulation', () => {
  test.use({ hasTouch: true, deviceScaleFactor: 2, viewport: { width: 1024, height: 768 } })
  test('touch-sized toggle and pinch keep the GPU surface aligned', async ({ app }, testInfo) => {
    const page = app.page
    await seedToolpathVisProject(page)
    const selector = page.getByRole('button', { name: 'GPU', exact: true })
    await expect(selector).toBeVisible()
    expect((await selector.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await selector.tap()
    const base = page.locator('canvas.sketch-canvas')
    const gpu = page.locator('canvas.sketch-toolpath-gpu')
    await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu')
    const panel = page.locator('#workspace-panel-sketch .viewport-toolpath-vis')
    const toggleBox = (await selector.boundingBox())!
    expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(toggleBox.height + 16)
    const box = (await base.boundingBox())!
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    const stats = async () => JSON.parse((await gpu.getAttribute('data-poc-stats'))!) as { submissions: number; preparations: number }
    const before = await stats()
    const touch = await page.context().newCDPSession(page)
    try {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 11, x: x - 40, y }, { id: 12, x: x + 40, y }] })
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 11, x: x - 60, y: y + 10 }, { id: 12, x: x + 60, y: y + 10 }] })
      await expect.poll(async () => (await stats()).submissions).toBeGreaterThan(before.submissions)
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally { await touch.detach() }
    expect((await stats()).preparations).toBe(before.preparations)
    await page.setViewportSize({ width: 1180, height: 820 })
    await expect.poll(async () => {
      const a = await base.boundingBox(), b = await gpu.boundingBox()
      return JSON.stringify(a) === JSON.stringify(b)
    }).toBe(true)
    const sizes = await page.evaluate(() => [...document.querySelectorAll<HTMLCanvasElement>('canvas.sketch-canvas, canvas.sketch-toolpath-gpu, canvas.sketch-toolpath-foreground')].map(canvas => [canvas.width, canvas.height]))
    expect(sizes).toHaveLength(3)
    expect(sizes[1]).toEqual(sizes[0])
    expect(sizes[2]).toEqual(sizes[0])
    await testInfo.attach('gpu-tablet-emulation', { body: await page.screenshot(), contentType: 'image/png' })
  })
})

test.describe('Toolpath visibility panel smoke', () => {
  test('GPU is the first inline toggle and supports keyboard switching', async ({ app, ui }, testInfo) => {
    const page = app.page
    await seedToolpathVisProject(page)
    const panel = ui.toolpathVis.sketchPanel(page)
    const items = ui.toolpathVis.sketchItems(page)
    await expect(items).toHaveText(['GPU', 'Cuts', 'Lead-ins', 'Rapids', 'Plunges', 'Retractions', 'Directions', 'Feed colours'])
    await expect(panel.getByRole('combobox')).toHaveCount(0)
    const centers = await items.evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect()
      return box.y + box.height / 2
    }))
    expect(new Set(centers).size).toBe(1)
    const gpu = items.first()
    await expect(gpu).toHaveAttribute('aria-pressed', 'false')
    await gpu.focus()
    await page.keyboard.press('Enter')
    await expect(gpu).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('canvas.sketch-canvas')).toHaveAttribute('data-toolpath-renderer', 'gpu')
    await page.keyboard.press('Space')
    await expect(gpu).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('canvas.sketch-canvas')).toHaveAttribute('data-toolpath-renderer', 'canvas')
    await testInfo.attach('inline-gpu-toggle', { body: await panel.screenshot(), contentType: 'image/png' })
  })

  test('solid rapid styling renders in Canvas and booklet snapshots', async ({ app, ui }, testInfo) => {
    await seedToolpathVisProject(app.page)
    await expect(ui.toolpathVis.sketchPanel(app.page)).toBeVisible({ timeout: 15000 })
    await ui.operations.rowByName(app.page, 'Route A').click()
    const rendered = await app.page.evaluate(async () => {
      const previewUrl = '/src/components/canvas/previewPrimitives.ts'
      const snapshotUrl = '/src/components/canvas/operationSnapshot.ts'
      const { drawToolpath } = await import(previewUrl) as typeof import('../src/components/canvas/previewPrimitives')
      const { renderOperationSnapshotPng } = await import(snapshotUrl) as typeof import('../src/components/canvas/operationSnapshot')
      const project = await (window as unknown as { __pcTest: { getProject: () => Promise<Project> } }).__pcTest.getProject()
      // Synthetic display swatch: spaced horizontal moves make gaps observable.
      // The sloped plunge/retract deliberately has an XY projection for inspection.
      const toolpath: ToolpathResult = {
        operationId: project.operations[0].id,
        moves: [
          { kind: 'cut', from: { x: 25, y: 20, z: 0 }, to: { x: 145, y: 20, z: 0 } },
          { kind: 'lead_in', from: { x: 25, y: 35, z: 0 }, to: { x: 145, y: 35, z: 0 } },
          { kind: 'rapid', from: { x: 25, y: 50, z: 5 }, to: { x: 145, y: 50, z: 5 } },
          { kind: 'plunge', from: { x: 25, y: 65, z: 5 }, to: { x: 145, y: 65, z: 0 } },
          { kind: 'rapid', from: { x: 25, y: 80, z: 0 }, to: { x: 145, y: 80, z: 5 } },
        ],
        warnings: [],
        bounds: null,
      }
      const visibility = { cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true, directions: false }
      const canvas = document.createElement('canvas')
      canvas.width = 360
      canvas.height = 200
      const ctx = canvas.getContext('2d')!
      const rows: { emphasized: boolean; simplifyForDisplay: boolean; gaps: boolean[] }[] = []
      for (const simplifyForDisplay of [true, false]) {
        for (const emphasized of [true, false]) {
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          drawToolpath(ctx, toolpath, { scale: 2, offsetX: 0, offsetY: 0 }, emphasized,
            visibility, 0.4, { simplifyForDisplay })
          rows.push({ emphasized, simplifyForDisplay, gaps: [20, 35, 50, 65, 80].map(y => {
            const pixels = ctx.getImageData(60, y * 2, 220, 1).data
            return pixels.some((value, index) => index % 4 === 3 && value === 0)
          }) })
        }
      }
      ctx.fillStyle = '#18212f'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      drawToolpath(ctx, toolpath, { scale: 2, offsetX: 0, offsetY: 0 }, true, visibility)
      const swatch = canvas.toDataURL('image/png').split(',')[1]
      // Observe the actual booklet call, not just its full-detail option above.
      const strokes: { width: number; dash: number[] }[] = []
      const originalStroke = CanvasRenderingContext2D.prototype.stroke
      let snapshot: Uint8Array
      CanvasRenderingContext2D.prototype.stroke = new Proxy(originalStroke, {
        apply(original, context: CanvasRenderingContext2D, args: unknown[]) {
          strokes.push({ width: context.lineWidth, dash: context.getLineDash() })
          return Reflect.apply(original, context, args)
        },
      })
      try {
        snapshot = await renderOperationSnapshotPng(project, project.operations[0], toolpath, { pixelRatio: 1 })
      } finally {
        CanvasRenderingContext2D.prototype.stroke = originalStroke
      }
      return { rows, swatch, snapshot: Array.from(snapshot), strokes }
    })
    for (const row of rendered.rows) {
      expect(row.gaps, JSON.stringify(row)).toEqual([false, false, false, true, false])
    }
    const rapidStrokes = rendered.strokes.filter(stroke => Math.abs(stroke.width - 1.65) < 0.001)
    expect(rapidStrokes).toHaveLength(2)
    expect(rapidStrokes.map(stroke => stroke.dash)).toEqual([[], []])
    expect(rendered.strokes.filter(stroke => Math.abs(stroke.width - 1.85) < 0.001).map(stroke => stroke.dash)).toEqual([[3, 4]])
    await testInfo.attach('phase-0-display-swatch', { body: Buffer.from(rendered.swatch, 'base64'), contentType: 'image/png' })
    await testInfo.attach('phase-0-booklet-snapshot', { body: Buffer.from(rendered.snapshot), contentType: 'image/png' })
    await testInfo.attach('phase-0-live-sketch', { body: await app.page.locator('canvas.sketch-canvas').screenshot(), contentType: 'image/png' })
  })

  test('gcode icon toggle expands and collapses the panel', async ({ app, ui }) => {
    await seedToolpathVisProject(app.page)

    // Async toolpath generation — wait for the sketch panel to appear.
    const sketchPanel = ui.toolpathVis.sketchPanel(app.page)
    await expect(sketchPanel).toBeVisible({ timeout: 15000 })
    await expect(sketchPanel).toHaveClass(/viewport-toolpath-vis--expanded/)

    // Items visible when expanded
    const sketchItems = ui.toolpathVis.sketchItems(app.page)
    await expect(sketchItems.first()).toBeVisible()

    // Collapse
    await ui.toolpathVis.toggle(app.page).click()
    await expect(sketchPanel).not.toHaveClass(/viewport-toolpath-vis--expanded/)
    await expect(sketchItems).toHaveCount(0)

    // Expand again
    await ui.toolpathVis.toggle(app.page).click()
    await expect(sketchPanel).toHaveClass(/viewport-toolpath-vis--expanded/)
    await expect(sketchItems.first()).toBeVisible()
  })

  test('collapse preserves toggle selections', async ({ app, ui }) => {
    await seedToolpathVisProject(app.page)

    const sketchPanel = ui.toolpathVis.sketchPanel(app.page)
    await expect(sketchPanel).toBeVisible({ timeout: 15000 })

    // Toggle off one item
    const sketchItems = ui.toolpathVis.sketchItems(app.page)
    const firstItem = sketchItems.filter({ hasText: 'Cuts' })
    await expect(firstItem).toHaveAttribute('aria-pressed', 'true')
    await firstItem.click()
    await expect(firstItem).toHaveAttribute('aria-pressed', 'false')

    // Collapse and expand
    await ui.toolpathVis.toggle(app.page).click()
    await expect(sketchPanel).not.toHaveClass(/viewport-toolpath-vis--expanded/)
    await ui.toolpathVis.toggle(app.page).click()
    await expect(sketchPanel).toHaveClass(/viewport-toolpath-vis--expanded/)

    // Selection preserved
    await expect(firstItem).toHaveAttribute('aria-pressed', 'false')
  })

  test('panel renders in both sketch and 3D views', async ({ app, ui }) => {
    await seedToolpathVisProject(app.page)

    const sketchPanel = ui.toolpathVis.sketchPanel(app.page)
    await expect(sketchPanel).toBeVisible({ timeout: 15000 })
    await expect(ui.toolpathVis.sketchItems(app.page).first()).toBeVisible()

    // The 3D panel exists in the DOM (LCR layout) but may be hidden behind
    // the inactive preview tab — verify it is present in the DOM.
    await expect(ui.toolpathVis.view3dPanel(app.page)).toBeAttached({ timeout: 15000 })
    await expect(ui.toolpathVis.view3dItems(app.page).first()).toBeAttached()
  })

  test('navigation defers arrow rendering and restores the user setting', async ({ app, ui }) => {
    const page = app.page
    await seedToolpathVisProject(page)
    await expect(ui.toolpathVis.sketchPanel(page)).toBeVisible({ timeout: 15000 })
    await page.getByText('Route A', { exact: true }).click()
    // Observe actual Canvas arrow fills, not a test-only production flag.
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas.sketch-canvas')
      if (!canvas) throw new Error('Sketch canvas missing')
      const counts = { frames: 0, arrows: 0, completed: [] as number[] }
      Object.assign(window, { navigationDrawCounts: counts })
      const clear = CanvasRenderingContext2D.prototype.clearRect
      const fill = CanvasRenderingContext2D.prototype.fill
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        if (this.canvas === canvas) { counts.completed.push(counts.arrows); counts.frames++; counts.arrows = 0 }
        return clear.apply(this, args)
      }
      CanvasRenderingContext2D.prototype.fill = new Proxy(fill, {
        apply(original, ctx: CanvasRenderingContext2D, args: unknown[]) {
          if (ctx.canvas === canvas && Math.abs(ctx.globalAlpha - 0.95) < 0.001 && Math.abs(ctx.lineWidth - 1.4) < 0.001) counts.arrows++
          return Reflect.apply(original, ctx, args)
        },
      })
    })
    const counts = () => page.evaluate(() => (window as unknown as {
      navigationDrawCounts: { frames: number; arrows: number; completed: number[] }
    }).navigationDrawCounts)
    const canvas = page.locator('canvas.sketch-canvas')
    const box = (await canvas.boundingBox())!
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    const directions = ui.toolpathVis.sketchItems(page).filter({ hasText: 'Directions' })
    await expect(directions).toHaveAttribute('aria-pressed', 'true')
    await page.mouse.move(x, y)
    await page.mouse.down({ button: 'middle' })
    const beforePan = (await counts()).frames
    await page.mouse.move(x + 30, y + 10)
    await expect.poll(async () => (await counts()).frames).toBeGreaterThan(beforePan)
    expect((await counts()).arrows).toBe(0)
    // Idle timeout must not restore arrows while a pointer gesture is held.
    await page.waitForTimeout(250)
    expect((await counts()).arrows).toBe(0)
    await page.mouse.up({ button: 'middle' })
    await expect.poll(async () => (await counts()).arrows).toBeGreaterThan(0)
    await expect(directions).toHaveAttribute('aria-pressed', 'true')

    const beforeWheel = (await counts()).frames
    await page.mouse.wheel(0, -30)
    await expect.poll(async () => (await counts()).frames).toBeGreaterThan(beforeWheel)
    await expect.poll(async () => (await counts()).arrows).toBeGreaterThan(0)
    expect((await counts()).completed.slice(beforeWheel + 1)).toContain(0)

    // Browser-level touches provide real pointer capture; dispatchEvent alone
    // cannot create the active pointers required by setPointerCapture.
    const touchSession = await page.context().newCDPSession(page)
    await touchSession.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ id: 11, x: x - 40, y }, { id: 12, x: x + 40, y }],
    })
    const beforePinch = (await counts()).frames
    await touchSession.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ id: 11, x: x - 40, y }, { id: 12, x: x + 60, y }],
    })
    await expect.poll(async () => (await counts()).frames).toBeGreaterThan(beforePinch)
    await page.waitForTimeout(250)
    expect((await counts()).arrows).toBe(0)
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    await touchSession.detach()
    await expect.poll(async () => (await counts()).arrows).toBeGreaterThan(0)

    await directions.click()
    await expect(directions).toHaveAttribute('aria-pressed', 'false')
    await page.mouse.move(x, y)
    await page.mouse.wheel(0, 30)
    await page.waitForTimeout(300)
    expect((await counts()).arrows).toBe(0)
    await expect(directions).toHaveAttribute('aria-pressed', 'false')
  })
})
