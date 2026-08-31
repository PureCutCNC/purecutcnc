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
