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
 * A canned ellipse's two radius handles (issue #1112 slices w3e-a, rt7-g).
 *
 * The handles belong to **Edit ellipse…**, not to a plain selection: a selected
 * ellipse draws none and nothing can be dragged, and they appear only while the
 * panel is open (Frank, round 7: "we should only show dots when in edit ellipse
 * mode"). The plain-selection case asserts the drawing as well as the gesture —
 * the feature pass publishes the handle count it drew (`data-radius-handles`),
 * so a dot that is visible but not grabbable fails here (issue #1112 rt7-g
 * review). A drag writes the panel's Radius X / Radius Y field and the canvas
 * draws the dragged outline, while the project keeps its stored parameters until
 * Save commits the whole session as one undo step; Cancel discards the drag
 * exactly as it discards a typed value. Typing the other radius afterwards
 * previews that field live but still does not store the dragged one before Save
 * (issue #1112 rt7-g correction, round 2).
 *
 * The open panel is also what lets the press through: a `canned-edit` session
 * borrows `pendingAdd` to show its side panel and places nothing, so it must not
 * claim the pointer as a reference point pick. It did, and every press on a
 * drawn handle was refused — the drag tests below were unreachable until that
 * was fixed (issue #1112 rt7-g correction, round 3).
 *
 * A placed, rotated ellipse draws one handle at the end of its local X axis and
 * one at the end of its local Y axis — in the ellipse's own frame, so a 30°
 * placement turns both handles with it. Dragging a handle changes only its own
 * radius, the placement is untouched.
 *
 * The expected handle positions here are computed from the fixture's known
 * placement (`translate(100, 80)` then rotate 30°), not read back from the
 * implementation, so a handle drawn in the wrong frame fails the drag rather
 * than agreeing with itself.
 *
 * Every drag is kept inside the canvas. The view is fitted to the scene, so a
 * handle sits about one padding-width from the edge and a pull long enough to
 * leave the canvas ends the drag there — the commit-on-leave every canvas drag
 * has, the circle's radius handle included. `dragRadiusHandle` stops short of
 * the edge and the expectation follows the point the pointer actually reached.
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
/** How far, in world units, each drag asks to pull its handle along its axis. */
const DRAG = 25
/**
 * How far from the canvas edge a drag may end, in page pixels. The handle sits
 * on the outer edge of the fitted scene, so the pull is clamped well inside the
 * canvas rather than leaving it.
 */
const CANVAS_EDGE_MARGIN = 24
/** A pull that reaches no further than this, in world units, is no drag at all. */
const MIN_PULL = 2

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

type EllipseRadiusAxis = 'rx' | 'ry'

/** The placed, rotated ellipse fixture: mm project, one ellipse. */
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
 * Open Edit ellipse… through the app's own registry opener, the route
 * Properties and the feature context menu use. It arms the `canned-edit`
 * session and seeds the panel's fields, which is what puts the handles on the
 * canvas (issue #1112 rt7-g).
 */
async function openEditEllipse(page: Page, featureId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const { getCannedShapeEditor } = await import('/src/cannedShapes/registry.ts') as typeof import('/src/cannedShapes/registry')
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('/src/store/projectStore')
    const opener = getCannedShapeEditor('ellipse')
    if (!opener) throw new Error('e2e: no Edit-ellipse opener is registered')
    opener(id)
    if (useProjectStore.getState().pendingAdd?.shape !== 'canned-edit') {
      throw new Error('e2e: the Edit-ellipse session did not open')
    }
  }, featureId)
  await page.locator('.canvas-workflow-panel--creation .canvas-workflow-panel__parameter-fields input').first().waitFor()
}

/** The Edit-ellipse panel's two radius fields, as text. */
async function radiusFields(page: Page): Promise<{ rx: string; ry: string }> {
  const inputs = page.locator('.canvas-workflow-panel--creation .canvas-workflow-panel__parameter-fields input')
  return { rx: await inputs.nth(0).inputValue(), ry: await inputs.nth(1).inputValue() }
}

/**
 * How many radius handles the canvas feature pass drew on its last frame.
 *
 * The pass publishes the count on the sketch canvas (`data-radius-handles`,
 * dev-only) because the handles are an in-canvas drawing: asserting that a
 * plain selection cannot be dragged says nothing about dots that are drawn but
 * not grabbable, which is exactly the reviewed escape (issue #1112 rt7-g
 * review). `NaN` until a frame has drawn; poll it, since the pass runs on an
 * animation frame.
 */
async function drawnRadiusHandles(page: Page): Promise<number> {
  return canvas.sketch(page).evaluate(
    (element) => Number((element as HTMLCanvasElement).dataset.radiusHandles),
  )
}

/** Wait for the drawn frame to publish `count` handles. */
async function expectDrawnHandles(page: Page, count: number, message: string): Promise<void> {
  await expect.poll(() => drawnRadiusHandles(page), { message }).toBe(count)
}

/**
 * Wait until the pass drew the edited ellipse at the panel's fields, then read
 * the radii it actually drew.
 */
async function drawnEllipseDraft(
  page: Page,
  expected: { rx: string; ry: string },
): Promise<{ rx: number; ry: number }> {
  const wanted = { rx: Number(expected.rx), ry: Number(expected.ry) }
  await page.waitForFunction(({ rx, ry }) => {
    const sketch = document.querySelector('canvas.sketch-canvas') as HTMLCanvasElement | null
    const drawn = sketch?.dataset.ellipseDraft
    if (!drawn) return false
    const [drawnRx, drawnRy] = drawn.split(',').map(Number)
    return Math.abs(drawnRx - rx) < 1e-6 && Math.abs(drawnRy - ry) < 1e-6
  }, wanted)
  const drawn = await canvas.sketch(page).evaluate(
    (element) => (element as HTMLCanvasElement).dataset.ellipseDraft ?? '',
  )
  const [rx, ry] = drawn.split(',').map(Number)
  return { rx, ry }
}

/** The drafted radii the pass published, or `null` while no editor is open. */
async function drawnEllipseDraftText(page: Page): Promise<string | null> {
  return canvas.sketch(page).evaluate(
    (element) => (element as HTMLCanvasElement).dataset.ellipseDraft ?? null,
  )
}

/** How many committed undo steps the project has. */
async function undoDepth(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('/src/store/projectStore')
    return useProjectStore.getState().history.past.length
  })
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
function handleWorldPoints(): Record<EllipseRadiusAxis, ScreenPoint> {
  return {
    // Local (rx, 0) and (0, ry) under translate(100, 80) · rotate(30°).
    rx: { x: PLACEMENT.e + RADII.rx * COS, y: PLACEMENT.f + RADII.rx * SIN },
    ry: { x: PLACEMENT.e - RADII.ry * SIN, y: PLACEMENT.f + RADII.ry * COS },
  }
}

/** The placed direction of each local axis, in world units. */
function axisDirection(axis: EllipseRadiusAxis): ScreenPoint {
  return axis === 'rx' ? { x: COS, y: SIN } : { x: -SIN, y: COS }
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

/** A page point in the world: the inverse of `screenPoint`, for the same view. */
async function worldPoint(page: Page, screen: ScreenPoint): Promise<ScreenPoint> {
  return canvas.sketch(page).evaluate(async (element, point) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('/src/store/projectStore')
    const viewUrl = '/src/components/canvas/viewTransform.ts'
    const { computeSketchViewTransform, canvasToWorld } = await import(viewUrl) as typeof import('/src/components/canvas/viewTransform')
    const sketch = element as HTMLCanvasElement
    const project = useProjectStore.getState().project
    const vt = computeSketchViewTransform(project, sketch.width, sketch.height, {
      zoom: Number(sketch.dataset.viewZoom),
      panX: Number(sketch.dataset.viewPanX),
      panY: Number(sketch.dataset.viewPanY),
    })
    const rect = sketch.getBoundingClientRect()
    return canvasToWorld(
      (point.x - rect.left) * (sketch.width / rect.width),
      (point.y - rect.top) * (sketch.height / rect.height),
      vt,
    )
  }, screen)
}

/** The canvas in page pixels, inset by `margin` on every side. */
async function canvasInterior(
  page: Page,
  margin: number,
): Promise<{ minX: number; maxX: number; minY: number; maxY: number }> {
  const box = await canvas.sketch(page).boundingBox()
  if (!box) throw new Error('e2e: the sketch canvas has no box')
  return {
    minX: box.x + margin,
    maxX: box.x + box.width - margin,
    minY: box.y + margin,
    maxY: box.y + box.height - margin,
  }
}

/**
 * The farthest point along `start → target` that stays inside `bounds`. The
 * press and every step of a move have to stay on the canvas: a pointer that
 * leaves it ends the drag where it left, so the release would store a
 * mid-path radius.
 */
function stopInsideCanvas(
  start: ScreenPoint,
  target: ScreenPoint,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): ScreenPoint {
  if (start.x < bounds.minX || start.x > bounds.maxX || start.y < bounds.minY || start.y > bounds.maxY) {
    throw new Error(`e2e: the handle press at ${start.x},${start.y} is outside the canvas`)
  }
  const dx = target.x - start.x
  const dy = target.y - start.y
  let scale = 1
  if (dx > 0) scale = Math.min(scale, (bounds.maxX - start.x) / dx)
  if (dx < 0) scale = Math.min(scale, (bounds.minX - start.x) / dx)
  if (dy > 0) scale = Math.min(scale, (bounds.maxY - start.y) / dy)
  if (dy < 0) scale = Math.min(scale, (bounds.minY - start.y) / dy)
  return { x: start.x + dx * scale, y: start.y + dy * scale }
}

/** The radius the pointer asks for at a world point, in the ellipse's own frame. */
function radiusAlong(axis: EllipseRadiusAxis, world: ScreenPoint): number {
  const dx = world.x - PLACEMENT.e
  const dy = world.y - PLACEMENT.f
  return Math.abs(axis === 'rx' ? dx * COS + dy * SIN : -dx * SIN + dy * COS)
}

/**
 * Press on a handle and pull it along its placed axis, stopping short of the
 * canvas edge. Returns the world point the pointer reached, read through the
 * same view the pointer moved in.
 */
async function dragRadiusHandle(page: Page, axis: EllipseRadiusAxis, distance: number): Promise<ScreenPoint> {
  const from = handleWorldPoints()[axis]
  const direction = axisDirection(axis)
  const start = await screenPoint(page, from)
  const target = await screenPoint(page, {
    x: from.x + direction.x * distance,
    y: from.y + direction.y * distance,
  })
  const end = stopInsideCanvas(start, target, await canvasInterior(page, CANVAS_EDGE_MARGIN))
  // Read the world point before the release: the view is the one the drag runs
  // in, and the last move is the radius the panel's field ends on.
  const reached = await worldPoint(page, end)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await page.mouse.up()
  return reached
}

async function storedEllipse(page: Page, definitionId: string): Promise<{ rx: number; ry: number }> {
  const project = await getProject(page)
  const definition = (project.featureDefinitions as Record<string, {
    canned?: { kind: string; params: { rx: number; ry: number } }
  }>)[definitionId]
  if (!definition?.canned) throw new Error(`e2e: ${definitionId} is not a canned shape`)
  return { rx: definition.canned.params.rx, ry: definition.canned.params.ry }
}

async function saveEditPanel(page: Page): Promise<void> {
  const panel = page.locator('.canvas-workflow-panel--creation')
  await panel.getByRole('button', { name: 'Save' }).click()
  await expect(panel).toHaveCount(0)
}

async function cancelEditPanel(page: Page): Promise<void> {
  const panel = page.locator('.canvas-workflow-panel--creation')
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(panel).toHaveCount(0)
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('/src/store/projectStore')
    useProjectStore.getState().undo()
  })
}

/**
 * A canvas drag lands within a pixel of the pointer, and the grid snap can pull
 * the release up to ~0.7 world units off it, so the stored value is close to —
 * not equal to — the pointer's own axis coordinate.
 */
function expectNear(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: expected ${expected}, got ${actual}`).toBeLessThan(1.5)
}

test('a plain selection of a canned ellipse has no radius handles', async ({ app }) => {
  const ellipse = await seedRotatedEllipse(app.page)
  await settleView(app.page)
  // The selection the seeding left is the plain one: no Edit panel, and — the
  // part the drag alone cannot see — no handles drawn on the canvas.
  await expect(app.page.locator('.canvas-workflow-panel--creation')).toHaveCount(0)
  await expectDrawnHandles(app.page, 0, 'a plain selection draws no radius handles')
  expect(await drawnEllipseDraftText(app.page), 'and previews no editor draft').toBeNull()
  const undoBefore = await undoDepth(app.page)

  // Press exactly where the X handle would be and pull: nothing moves, because
  // a plain selection draws no handles to grab.
  const from = handleWorldPoints().rx
  const start = await screenPoint(app.page, from)
  const target = await screenPoint(app.page, {
    x: from.x + axisDirection('rx').x * DRAG,
    y: from.y + axisDirection('rx').y * DRAG,
  })
  const end = stopInsideCanvas(start, target, await canvasInterior(app.page, CANVAS_EDGE_MARGIN))
  await app.page.mouse.move(start.x, start.y)
  await app.page.mouse.down()
  await app.page.mouse.move(end.x, end.y, { steps: 8 })
  await app.page.mouse.up()

  const after = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(after.rx, RADII.rx, 'a press on a plain selection leaves rx alone')
  expectNear(after.ry, RADII.ry, 'a press on a plain selection leaves ry alone')
  expect(await undoDepth(app.page), 'and writes no undo step').toBe(undoBefore)
  await expectDrawnHandles(app.page, 0, 'and the press draws no handles either')
})

test('the X handle writes the panel field and only Save stores rx', async ({ app }) => {
  const ellipse = await seedRotatedEllipse(app.page)
  await settleView(app.page)
  expect(ellipse.transform.b).not.toBe(0)
  const undoBeforeDrag = await undoDepth(app.page)

  await openEditEllipse(app.page, ellipse.featureId)
  expect(await radiusFields(app.page)).toEqual({ rx: '30', ry: '20' })
  await expectDrawnHandles(app.page, 2, 'the open editor draws both handles')

  // Pull the X handle further along the placed X axis: rx 30 → 55, as far as the
  // canvas allows.
  const reached = await dragRadiusHandle(app.page, 'rx', DRAG)
  const asked = radiusAlong('rx', reached)
  expect(asked, `the X drag must stay on the canvas and pull the handle: it reached ${asked}`)
    .toBeGreaterThan(RADII.rx + MIN_PULL)

  // The drag is the panel's field and the canvas' drawing, not a project write:
  // the panel shows it, the Y field is untouched, the canvas draws the held
  // draft, and the stored parameters are still the ones the session opened on
  // (issue #1112 rt7-g review).
  const fields = await radiusFields(app.page)
  expectNear(Number(fields.rx), asked, 'the X drag fills the panel’s Radius X field')
  expect(Number(fields.ry), 'the drag leaves the Radius Y field alone').toBe(RADII.ry)
  const previewed = await drawnEllipseDraft(app.page, fields)
  expectNear(previewed.rx, asked, 'the canvas draws the dragged rx')
  expect(previewed.ry, 'and the untouched ry').toBe(RADII.ry)
  await expectDrawnHandles(app.page, 2, 'both handles stay on the canvas through the drag')
  const beforeSave = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(beforeSave.rx, RADII.rx, 'a dragged radius is not stored before Save')
  expectNear(beforeSave.ry, RADII.ry, 'and the other radius is not either')
  expect(await undoDepth(app.page), 'a drag before Save is not an undo step').toBe(undoBeforeDrag)

  // Typing the other radius previews live but must not carry the dragged rx
  // into the project with it (issue #1112 rt7-g correction, round 2): this mixed
  // sequence used to store {rx: dragged, ry: typed} before Save.
  await app.page
    .locator('.canvas-workflow-panel--creation .canvas-workflow-panel__parameter-fields input')
    .nth(1)
    .fill('25')
  const mixed = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(mixed.rx, RADII.rx, 'typing ry leaves the dragged rx unpersisted')
  expectNear(mixed.ry, 25, 'the typed ry previews live')
  expectNear(Number((await radiusFields(app.page)).rx), asked, 'the dragged field keeps its text through the typed edit')

  await saveEditPanel(app.page)
  const after = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(after.rx, asked, 'Save stores the dragged rx')
  expectNear(after.ry, 25, 'Save stores the typed ry too')
  expect(await undoDepth(app.page), 'Save commits the whole session as one undo step').toBe(undoBeforeDrag + 1)
  await expectDrawnHandles(app.page, 0, 'Save takes the handles away')

  await undo(app.page)
  const restored = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(restored.rx, RADII.rx, 'one undo restores rx')
  expectNear(restored.ry, RADII.ry, 'one undo restores ry')
})

test('the Y handle changes ry, in the ellipse’s own rotated frame', async ({ app }) => {
  const ellipse = await seedRotatedEllipse(app.page)
  await settleView(app.page)
  const undoBeforeDrag = await undoDepth(app.page)
  await openEditEllipse(app.page, ellipse.featureId)
  await expectDrawnHandles(app.page, 2, 'the open editor draws both handles')

  // Pull the Y handle along the placed Y axis: ry 20 → 45, as far as the canvas
  // allows.
  const reached = await dragRadiusHandle(app.page, 'ry', DRAG)
  const asked = radiusAlong('ry', reached)
  expect(asked, `the Y drag must stay on the canvas and pull the handle: it reached ${asked}`)
    .toBeGreaterThan(RADII.ry + MIN_PULL)

  const fields = await radiusFields(app.page)
  expectNear(Number(fields.ry), asked, 'the Y drag fills the panel’s Radius Y field')
  expect(Number(fields.rx), 'the drag leaves the Radius X field alone').toBe(RADII.rx)
  const previewed = await drawnEllipseDraft(app.page, fields)
  expectNear(previewed.ry, asked, 'the canvas draws the dragged ry')
  const beforeSave = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(beforeSave.ry, RADII.ry, 'a dragged radius is not stored before Save')

  await saveEditPanel(app.page)
  const after = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(after.ry, asked, 'Save stores the dragged ry')
  expectNear(after.rx, RADII.rx, 'Save leaves rx alone')
  expect(await undoDepth(app.page), 'Save commits one undo step').toBe(undoBeforeDrag + 1)

  await undo(app.page)
  const restored = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(restored.ry, RADII.ry, 'one undo restores ry')
  expectNear(restored.rx, RADII.rx, 'one undo restores rx')
})

test('Cancel discards a dragged radius like a typed one', async ({ app }) => {
  const ellipse = await seedRotatedEllipse(app.page)
  await settleView(app.page)
  const undoBeforeDrag = await undoDepth(app.page)
  await openEditEllipse(app.page, ellipse.featureId)

  const reached = await dragRadiusHandle(app.page, 'rx', DRAG)
  expect(radiusAlong('rx', reached), 'the drag must pull the X handle')
    .toBeGreaterThan(RADII.rx + MIN_PULL)
  expectNear(Number((await radiusFields(app.page)).rx), radiusAlong('rx', reached), 'the drag is in the field')
  const held = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(held.rx, RADII.rx, 'a dragged radius is held out of the project before Save')

  await cancelEditPanel(app.page)
  const after = await storedEllipse(app.page, ellipse.definitionId)
  expectNear(after.rx, RADII.rx, 'Cancel leaves the stored rx as it was')
  expectNear(after.ry, RADII.ry, 'Cancel leaves ry alone')
  expect(await undoDepth(app.page), 'Cancel leaves the undo history alone').toBe(undoBeforeDrag)
  await expectDrawnHandles(app.page, 0, 'Cancel takes the handles away')
})

test('a placed centre and rotation stay put through a radius drag', async ({ app }) => {
  const ellipse = await seedRotatedEllipse(app.page)
  await settleView(app.page)
  const before = await getProject(app.page)
  const beforeTransform = (before.features as Array<{ transform: StoredEllipse['transform'] }>)[0].transform
  await openEditEllipse(app.page, ellipse.featureId)

  const reached = await dragRadiusHandle(app.page, 'ry', DRAG)
  expect(radiusAlong('ry', reached), 'the drag must pull the Y handle')
    .toBeGreaterThan(RADII.ry + MIN_PULL)

  const after = await getProject(app.page)
  const afterTransform = (after.features as Array<{ transform: StoredEllipse['transform'] }>)[0].transform
  expect(afterTransform).toEqual(beforeTransform)
  expect(ellipse.transform).toEqual(beforeTransform)
})
