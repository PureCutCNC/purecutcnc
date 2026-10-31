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
 * Dragging a canned ellipse's two radius handles (issue #1112 slice w3e-a).
 *
 * A placed, rotated ellipse draws one handle at the end of its local X axis and
 * one at the end of its local Y axis — in the ellipse's own frame, so a 30°
 * placement turns both handles with it. Dragging a handle changes only its own
 * radius, the placement is untouched, and the release is one undo step.
 *
 * The expected handle positions here are computed from the fixture's known
 * placement (`translate(100, 80)` then rotate 30°), not read back from the
 * implementation, so a handle drawn in the wrong frame fails the drag rather
 * than agreeing with itself.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { getProject } from './helpers'
import { canvas } from './selectors'

const PLACEMENT = { e: 100, f: 80 }
const ANGLE = Math.PI / 6
const COS = Math.cos(ANGLE)
const SIN = Math.sin(ANGLE)
const RADII = { rx: 30, ry: 20 }
/** How far, in world units, each drag pulls the handle outward. */
const DRAG = 25

interface ScreenPoint {
  x: number
  y: number
}

interface StoredEllipse {
  featureId: string
  definitionId: string
  params: { rx: number; ry: number }
  transform: { a: number; b: number; c: number; d: number; e: number; f: number }
}

/** The placed, rotated ellipse fixture: mm project, stock 200×160, one ellipse. */
async function seedRotatedEllipse(page: Page): Promise<StoredEllipse> {
  return page.evaluate(async ({ e, f, rx, ry }) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('/src/store/projectStore')
    const { newProject } = await import('/src/types/project.ts') as typeof import('/src/types/project')
    const store = useProjectStore.getState()
    store.loadProject(newProject('Ellipse radius handles', 'mm'))
    store.addEllipseFeature('Ellipse', e, f, rx, ry, 5)

    const project = useProjectStore.getState().project
    const angle = Math.PI / 6
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const centred = project.features[0]
    useProjectStore.getState().loadProject({
      ...project,
      features: [{
        ...centred,
        // Rotation about the definition origin, then the placement translation.
        transform: { a: cos, b: sin, c: -sin, d: cos, e, f },
      }],
    })

    const loaded = useProjectStore.getState().project
    const feature = loaded.features[0]
    useProjectStore.getState().selectFeature(feature.id)
    return {
      featureId: feature.id,
      definitionId: feature.definitionId,
      params: { rx, ry },
      transform: feature.transform,
    }
  }, { e: PLACEMENT.e, f: PLACEMENT.f, rx: RADII.rx, ry: RADII.ry })
}

/**
 * Let the project load and the fit-to-stock effect publish the new view before
 * the published transform is read: React commits the load and its fit on the
 * frames after the seeding call returns.
 */
async function settleView(page: Page): Promise<void> {
  const twoFrames = () => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  await page.evaluate(twoFrames)
  await page.waitForFunction(() => {
    const sketch = document.querySelector('canvas.sketch-canvas') as HTMLCanvasElement | null
    return !!sketch
      && Number.isFinite(Number(sketch.dataset.viewZoom))
      && Number.isFinite(Number(sketch.dataset.viewPanX))
      && Number.isFinite(Number(sketch.dataset.viewPanY))
  })
  await page.evaluate(twoFrames)
}

/** Where the two radius handles sit in the world, from the fixture's placement. */
function handleWorldPoints(): { rx: ScreenPoint; ry: ScreenPoint } {
  return {
    // Local (rx, 0) and (0, ry) under translate(100, 80) · rotate(30°).
    rx: { x: PLACEMENT.e + RADII.rx * COS, y: PLACEMENT.f + RADII.rx * SIN },
    ry: { x: PLACEMENT.e - RADII.ry * SIN, y: PLACEMENT.f + RADII.ry * COS },
  }
}

/** A world point in page pixels, through the view the canvas is actually showing. */
async function screenPoint(page: Page, world: ScreenPoint): Promise<ScreenPoint> {
  return canvas.sketch(page).evaluate(async (element, point) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('/src/store/projectStore')
    const viewUrl = '/src/components/canvas/viewTransform.ts'
    const { computeSketchViewTransform, worldToCanvas } = await import(viewUrl) as typeof import('/src/components/canvas/viewTransform')
    const sketch = element as HTMLCanvasElement
    const viewState = {
      zoom: Number(sketch.dataset.viewZoom),
      panX: Number(sketch.dataset.viewPanX),
      panY: Number(sketch.dataset.viewPanY),
    }
    if (!Number.isFinite(viewState.zoom) || !Number.isFinite(viewState.panX) || !Number.isFinite(viewState.panY)) {
      throw new Error('e2e: the canvas published no live view state')
    }
    const project = useProjectStore.getState().project
    const vt = computeSketchViewTransform(project, sketch.width, sketch.height, viewState)
    const canvasPoint = worldToCanvas(point, vt)
    const rect = sketch.getBoundingClientRect()
    return {
      x: rect.left + canvasPoint.cx * (rect.width / sketch.width),
      y: rect.top + canvasPoint.cy * (rect.height / sketch.height),
    }
  }, world)
}

/** Press on a handle and pull it to another world point, as a pointer drag does. */
async function dragHandle(page: Page, from: ScreenPoint, toWorld: ScreenPoint): Promise<void> {
  const start = await screenPoint(page, from)
  const end = await screenPoint(page, toWorld)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await page.mouse.up()
}

async function storedEllipse(page: Page, definitionId: string): Promise<{ rx: number; ry: number }> {
  const project = await getProject(page)
  const definition = (project.featureDefinitions as Record<string, {
    canned?: { kind: string; params: { rx: number; ry: number } }
  }>)[definitionId]
  if (!definition?.canned) throw new Error(`e2e: ${definitionId} is not a canned shape`)
  return { rx: definition.canned.params.rx, ry: definition.canned.params.ry }
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('/src/store/projectStore')
    useProjectStore.getState().undo()
  })
}

/** A canvas drag lands within a pixel of the pointer, so the world value is close. */
function expectNear(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: expected ${expected}, got ${actual}`).toBeLessThan(1.5)
}

test('the X handle changes rx, in the ellipse’s own rotated frame', async ({ app }) => {
  const ellipse = await seedRotatedEllipse(app.page)
  await settleView(app.page)
  expect(ellipse.transform.b).not.toBe(0)

  const handles = handleWorldPoints()
  // Pull the X handle further along the placed X axis: rx 30 → 55.
  await dragHandle(app.page, handles.rx, {
    x: handles.rx.x + DRAG * COS,
    y: handles.rx.y + DRAG * SIN,
  })

  const after = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(after.rx, RADII.rx + DRAG, 'the X drag sets rx')
  expectNear(after.ry, RADII.ry, 'the X drag leaves ry alone')

  // The second undo proves the whole gesture was one write: a second mid-drag
  // step would still be stored here.
  await undo(app.page)
  const restored = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(restored.rx, RADII.rx, 'one undo restores rx')
  expectNear(restored.ry, RADII.ry, 'one undo restores ry')
})

test('the Y handle changes ry, in the ellipse’s own rotated frame', async ({ app }) => {
  const ellipse = await seedRotatedEllipse(app.page)
  await settleView(app.page)

  const handles = handleWorldPoints()
  // Pull the Y handle along the placed Y axis: ry 20 → 45.
  await dragHandle(app.page, handles.ry, {
    x: handles.ry.x - DRAG * SIN,
    y: handles.ry.y + DRAG * COS,
  })

  const after = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(after.ry, RADII.ry + DRAG, 'the Y drag sets ry')
  expectNear(after.rx, RADII.rx, 'the Y drag leaves rx alone')

  await undo(app.page)
  const restored = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(restored.ry, RADII.ry, 'one undo restores ry')
  expectNear(restored.rx, RADII.rx, 'one undo restores rx')
})

test('a placed centre and rotation stay put through a radius drag', async ({ app }) => {
  const ellipse = await seedRotatedEllipse(app.page)
  await settleView(app.page)
  const before = await getProject(app.page)
  const beforeTransform = (before.features as Array<{ transform: StoredEllipse['transform'] }>)[0].transform

  const handles = handleWorldPoints()
  await dragHandle(app.page, handles.ry, {
    x: handles.ry.x - DRAG * SIN,
    y: handles.ry.y + DRAG * COS,
  })

  const after = await getProject(app.page)
  const afterTransform = (after.features as Array<{ transform: StoredEllipse['transform'] }>)[0].transform
  expect(afterTransform).toEqual(beforeTransform)
  expect(ellipse.transform).toEqual(beforeTransform)
})
