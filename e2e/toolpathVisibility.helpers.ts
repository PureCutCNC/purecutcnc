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

import { expect, type Page } from '@playwright/test'
import { seedProject } from './helpers'

function resolvedRectProfile(cx: number, cy: number, w: number, h: number) {
  return {
    start: { x: cx, y: cy },
    segments: [
      { type: 'line' as const, to: { x: cx + w, y: cy } },
      { type: 'line' as const, to: { x: cx + w, y: cy + h } },
      { type: 'line' as const, to: { x: cx, y: cy + h } },
      { type: 'line' as const, to: { x: cx, y: cy } },
    ],
    closed: true,
  }
}

function buildToolpathVisProjectJson(): string {
  const now = '2026-01-01T00:00:00.000Z'
  const stockW = 180
  const stockH = 120

  return JSON.stringify({
    version: '3.0',
    meta: {
      name: 'Toolpath Visibility E2E Fixture',
      created: now,
      modified: now,
      units: 'inch',
      showFeatureInfo: true,
      showDimensions: true,
      copyMode: 'reference',
      maxTravelZ: 2,
      operationClearanceZ: 0.2,
      clampClearanceXY: 0.5,
      clampClearanceZ: 0.2,
      machineId: 'grbl',
    },
    grid: {
      extent: 200,
      majorSpacing: 1,
      minorSpacing: 0.25,
      snapEnabled: false,
      snapIncrement: 0.25,
      visible: true,
    },
    stock: {
      profile: resolvedRectProfile(0, 0, stockW, stockH),
      thickness: 2,
      material: 'aluminum_6061',
      color: '#b9a83c',
      visible: true,
      origin: { x: 0, y: 0 },
    },
    origin: { name: 'Origin', x: stockW / 2, y: stockH / 2, z: 2, visible: true },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {
      'def-machinable-add': {
        id: 'def-machinable-add',
        kind: 'rect',
        profile: resolvedRectProfile(0, 0, 60, 40),
        dimensions: [],
        text: null,
        stl: null,
        operation: 'add',
      },
    },
    features: [
      {
        id: 'f-machinable-add',
        name: 'Machinable Add',
        definitionId: 'def-machinable-add',
        transform: { a: 1, b: 0, c: 0, d: 1, e: 30, f: 30 },
        constraints: [],
        folderId: null,
        z_top: 2,
        z_bottom: 0,
        visible: true,
        locked: false,
      },
    ],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [
      {
        id: 'tool-1',
        name: 'Quarter Inch Endmill',
        units: 'inch',
        type: 'flat_endmill',
        diameter: 0.25,
        vBitAngle: null,
        flutes: 2,
        material: 'carbide',
        defaultRpm: 18000,
        defaultFeed: 60,
        defaultPlungeFeed: 30,
        defaultStepdown: 0.1,
        defaultStepover: 0.125,
        maxCutDepth: 1,
      },
    ],
    operations: [
      {
        id: 'op-route-a',
        name: 'Route A',
        kind: 'edge_route_outside',
        pass: 'rough',
        enabled: true,
        showToolpath: true,
        debugToolpath: false,
        target: { source: 'features', featureIds: ['f-machinable-add'] },
        toolRef: 'tool-1',
        stepdown: 0.1,
        stepover: 0.125,
        feed: 60,
        plungeFeed: 30,
        rpm: 18000,
        pocketPattern: 'offset',
        pocketAngle: 0,
        roundOutsideCorners: false,
        stockToLeaveRadial: 0,
        stockToLeaveAxial: 0,
        finishWalls: false,
        finishFloor: false,
        carveDepth: 0,
        maxCarveDepth: 0,
      },
    ],
    tabs: [],
    clamps: [],
    ai_history: [],
  })
}

export const TOOLPATH_VIS_FIXTURE_JSON = buildToolpathVisProjectJson()

export async function seedToolpathVisProject(page: Page): Promise<void> {
  await seedProject(page, TOOLPATH_VIS_FIXTURE_JSON)
}

/** Synthetic clock only: charge one real Canvas cut stroke per frame, without
 * busy-waiting or changing production code. This tests policy, not performance. */
export async function installSlowCanvasClock(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'GPU', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.sketch-canvas')!
    const now = performance.now.bind(performance)
    const clock = { offset: 0, frames: 0, charged: false }
    Object.assign(window, { slowCanvasClock: clock })
    performance.now = () => now() + clock.offset
    const clear = CanvasRenderingContext2D.prototype.clearRect
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas === canvas) { clock.frames++; clock.charged = false }
      return clear.apply(this, args)
    }
    const stroke = CanvasRenderingContext2D.prototype.stroke
    CanvasRenderingContext2D.prototype.stroke = new Proxy(stroke, {
      apply(original, context: CanvasRenderingContext2D, args: unknown[]) {
        // Unselected toolpaths use the shared 0.34 alpha; grid/stock do not.
        if (context.canvas === canvas && Math.abs(context.globalAlpha - 0.34) < 0.001 && !clock.charged) {
          clock.offset += 60
          clock.charged = true
        }
        return Reflect.apply(original, context, args)
      },
    })
  })
}

export async function panForGpuSuggestion(page: Page): Promise<void> {
  const box = (await page.locator('canvas.sketch-canvas').boundingBox())!
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  const frames = () => page.evaluate(() => (window as unknown as { slowCanvasClock: { frames: number } }).slowCanvasClock.frames)
  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'middle' })
  try {
    for (let i = 1; i <= 9; i++) {
      const before = await frames()
      await page.mouse.move(x + i * 2, y + i)
      await expect.poll(frames).toBeGreaterThan(before)
    }
    await expect(page.getByRole('complementary', { name: 'Try GPU for smoother navigation' })).toHaveCount(0)
  } finally {
    await page.mouse.up({ button: 'middle' })
  }
}
