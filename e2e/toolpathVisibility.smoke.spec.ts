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
import { seedToolpathVisProject } from './toolpathVisibility.helpers'
import type { Project } from '../src/types/project'
import type { ToolpathResult } from '../src/engine/toolpaths/types'

test('GPU POC coverage union, shared styles, transform and retained buffers', async ({ app }, testInfo) => {
  const result = await app.page.evaluate(async () => {
    const gpuUrl = '/src/components/canvas/gpuToolpathPoc.ts'
    const canvasUrl = '/src/components/canvas/previewPrimitives.ts'
    const paletteUrl = '/src/components/canvas/canvasPalette.ts'
    const { GpuToolpathPoc } = await import(gpuUrl) as typeof import('../src/components/canvas/gpuToolpathPoc')
    const { drawToolpath } = await import(canvasUrl) as typeof import('../src/components/canvas/previewPrimitives')
    const { canvasColors } = await import(paletteUrl) as typeof import('../src/components/canvas/canvasPalette')
    const gpuCanvas = document.createElement('canvas')
    const reference = document.createElement('canvas')
    const readback = document.createElement('canvas')
    for (const canvas of [gpuCanvas, reference, readback]) { canvas.width = 360; canvas.height = 240 }
    const gpu = new GpuToolpathPoc(gpuCanvas, () => {})
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
      return { alpha, crossing, layers, swatch, before, after, transformed, oldPosition, hiddenCut, collision, cleared }
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
  await testInfo.attach('gpu-poc-layer-swatch', { body: Buffer.from(result.swatch.split(',')[1], 'base64'), contentType: 'image/png' })
})

test('GPU POC opts in, retains buffers through navigation and falls back on context loss', async ({ app, ui }) => {
  const page = app.page
  await page.goto('/?toolpathRenderer=gpu')
  await seedToolpathVisProject(page)
  const base = page.locator('canvas.sketch-canvas')
  const gpu = page.locator('canvas.sketch-toolpath-gpu-poc')
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu-poc')
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
    const gl = document.querySelector<HTMLCanvasElement>('canvas.sketch-toolpath-gpu-poc')!.getContext('webgl2')!
    const extension = gl.getExtension('WEBGL_lose_context')!
    Object.assign(window, { restoreGpuPocContext: () => extension.restoreContext() })
    extension.loseContext()
  })
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'canvas-fallback')
  await expect(gpu).toBeHidden()
  await expect(directions).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => (window as unknown as { restoreGpuPocContext: () => void }).restoreGpuPocContext())
  await expect(base).toHaveAttribute('data-toolpath-renderer', 'gpu-poc')
  await expect(gpu).toBeVisible()
  await page.goto('/')
  await expect(page.locator('canvas.sketch-toolpath-gpu-poc')).toHaveCount(0)
})

test('GPU POC initialization failure leaves Canvas toolpaths available', async ({ app, ui }) => {
  const page = app.page
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = new Proxy(original, {
      apply(target, canvas: HTMLCanvasElement, args: unknown[]) {
        if (canvas.classList.contains('sketch-toolpath-gpu-poc') && args[0] === 'webgl2') return null
        return Reflect.apply(target, canvas, args)
      },
    })
  })
  await page.goto('/?toolpathRenderer=gpu')
  await seedToolpathVisProject(page)
  await expect(page.locator('canvas.sketch-canvas')).toHaveAttribute('data-toolpath-renderer', 'canvas-fallback')
  await expect(ui.toolpathVis.sketchPanel(page)).toBeVisible()
  await expect(page.locator('canvas.sketch-toolpath-gpu-poc')).toHaveCount(0)
})


test.describe('Toolpath visibility panel smoke', () => {
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
    const firstItem = sketchItems.first()
    await expect(firstItem).toHaveAttribute('aria-pressed', 'true')
    await firstItem.click()
    await expect(firstItem).toHaveAttribute('aria-pressed', 'false')

    // Collapse and expand
    await ui.toolpathVis.toggle(app.page).click()
    await expect(sketchPanel).not.toHaveClass(/viewport-toolpath-vis--expanded/)
    await ui.toolpathVis.toggle(app.page).click()
    await expect(sketchPanel).toHaveClass(/viewport-toolpath-vis--expanded/)

    // Selection preserved
    await expect(sketchItems.first()).toHaveAttribute('aria-pressed', 'false')
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
