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
 * The Sketch view on the Around face (issue #395 slice D2): with a round bar
 * and a rotary machine, the workspace on Around frames the bar's surface
 * unrolled flat — one circumference across, never mirrored — a feature drawn
 * there is stamped `'around'` with sheet coordinates, and a flat face and the
 * sheet never hit each other's features.
 *
 * The face is set through `switchWorkspaceFace('around')` because the face
 * switch control is another worker's slice; the module is reached the way the
 * other canvas specs reach the store, by importing it in the page.
 */

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  cancelPendingAdd,
  getHoveredFeatureId,
  getProject,
  placePendingAddAt,
  seedProject,
  selectFeatures,
  setPendingAddAnchor,
  startAddRectPlacement,
} from './helpers'
import { getProfileBounds, roundStock } from '../src/types/project'
import type { SketchProfile } from '../src/types/project'

/** The bundled GRBL controller with a fourth axis bolted on. */
const ROTARY_MACHINE = {
  ...(JSON.parse(readFileSync(new URL('../src/engine/gcode/definitions/grbl.json', import.meta.url), 'utf8')) as Record<string, unknown>),
  rotary: { about: 'x', drive: 'own' },
}

interface SavedFeature {
  id: string
  authoringFace?: 'top' | 'bottom' | 'around'
  z_top: number
  z_bottom: number
}

interface SheetInfo {
  axis: 'x' | 'y'
  sheetStart: number
  circumference: number
  rect: { minX: number; minY: number; maxX: number; maxY: number }
}

interface RoundBar {
  diameter: number
  sheetStart: number
}

/** Seed the default project as a round bar with a rotary machine. */
async function prepareRoundBarWithRotary(page: Page): Promise<RoundBar> {
  const project = await getProject(page)
  const stock = project.stock as { profile: SketchProfile; thickness: number }
  const meta = project.meta as Record<string, unknown>
  const bounds = getProfileBounds(stock.profile)
  const diameter = stock.thickness
  const length = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
  const bar = roundStock(diameter, length, 'x', { x: bounds.minX, y: bounds.minY })

  await seedProject(page, JSON.stringify({
    ...project,
    stock: bar,
    meta: { ...meta, machineDefinitions: [ROTARY_MACHINE], selectedMachineId: 'grbl' },
  }))
  return { diameter, sheetStart: getProfileBounds(bar.profile).minY }
}

/** Put the workspace on Around, the way the face switch control will. */
async function switchToAround(page: Page): Promise<void> {
  const switched = await page.evaluate(async () => {
    const url = '/src/store/workspaceFace.ts'
    const { switchWorkspaceFace } = await import(url) as typeof import('../src/store/workspaceFace')
    return switchWorkspaceFace('around')
  })
  expect(switched, 'the workspace switches to Around on a round bar with a rotary machine').toBe(true)
}

async function switchToTop(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const url = '/src/store/workspaceFace.ts'
    const { switchWorkspaceFace } = await import(url) as typeof import('../src/store/workspaceFace')
    switchWorkspaceFace('top')
  })
}

/** The sheet the page's own canvas code computes for the live project. */
async function sheetInfo(page: Page): Promise<SheetInfo | null> {
  return page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { aroundSheet } = await import('/src/components/canvas/aroundSheet.ts') as typeof import('../src/components/canvas/aroundSheet')
    const sheet = aroundSheet(useProjectStore.getState().project)
    return sheet ? { axis: sheet.axis, sheetStart: sheet.sheetStart, circumference: sheet.circumference, rect: sheet.rect } : null
  })
}

/**
 * The world rectangle the canvas is actually showing, from the live pan/zoom
 * the canvas published (issue #395 review). A fit recomputed in the test would
 * hide a broken Zoom to model.
 */
async function visibleWorldBounds(page: Page): Promise<{ minX: number; maxX: number; minY: number; maxY: number }> {
  return page.locator('canvas.sketch-canvas').evaluate(async (canvas) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const viewUrl = '/src/components/canvas/viewTransform.ts'
    const { canvasToWorld, computeSketchViewTransform } = await import(viewUrl) as typeof import('../src/components/canvas/viewTransform')
    const element = canvas as HTMLCanvasElement
    // Let React commit the view change and the effect publish it.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const viewState = {
      zoom: Number(element.dataset.viewZoom),
      panX: Number(element.dataset.viewPanX),
      panY: Number(element.dataset.viewPanY),
    }
    if (!Number.isFinite(viewState.zoom) || !Number.isFinite(viewState.panX) || !Number.isFinite(viewState.panY)) {
      throw new Error('e2e: the canvas published no live view state')
    }
    const project = useProjectStore.getState().project
    const vt = computeSketchViewTransform(project, element.width, element.height, viewState)
    const a = canvasToWorld(0, 0, vt)
    const b = canvasToWorld(element.width, element.height, vt)
    return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) }
  })
}

/** A page click at a world (stock/sheet) point, through the view the app draws. */
async function clickWorld(page: Page, point: { x: number; y: number }): Promise<void> {
  const at = await page.locator('canvas.sketch-canvas').evaluate(async (canvas, world) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const viewUrl = '/src/components/canvas/viewTransform.ts'
    const { computeFitViewState, computeSketchViewTransform, worldToCanvas } = await import(viewUrl) as typeof import('../src/components/canvas/viewTransform')
    const element = canvas as HTMLCanvasElement
    const project = useProjectStore.getState().project
    const vt = computeSketchViewTransform(project, element.width, element.height, computeFitViewState(project, element.width, element.height))
    const canvasPoint = worldToCanvas(world, vt)
    const rect = element.getBoundingClientRect()
    return {
      x: rect.left + canvasPoint.cx * (rect.width / element.width),
      y: rect.top + canvasPoint.cy * (rect.height / element.height),
    }
  }, point)
  await page.mouse.click(at.x, at.y)
}

async function selectedFeatureIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    return useProjectStore.getState().selection.selectedFeatureIds
  })
}

/** Draw a rectangle through the store, in stock/sheet coordinates, as the canvas does. */
async function drawRect(page: Page, x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await startAddRectPlacement(page)
  await setPendingAddAnchor(page, x1, y1)
  await placePendingAddAt(page, x2, y2)
  await cancelPendingAdd(page)
}

async function features(page: Page): Promise<SavedFeature[]> {
  return (await getProject(page)).features as unknown as SavedFeature[]
}

async function zoomToModel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Zoom to model', exact: true }).click()
}

test('the Around canvas frames the unrolled sheet, one circumference across', async ({ app }) => {
  const { page } = app
  const bar = await prepareRoundBarWithRotary(page)
  await switchToAround(page)
  await zoomToModel(page)

  const sheet = await sheetInfo(page)
  expect(sheet, 'the workspace is on the unrolled sheet').not.toBeNull()
  expect(sheet!.axis).toBe('x')
  expect(sheet!.circumference).toBeCloseTo(Math.PI * bar.diameter, 6)
  expect(sheet!.sheetStart).toBeCloseTo(bar.sheetStart, 6)

  // Fit-to-view shows the whole sheet. A bar-rectangle fit would have stopped
  // at the diameter and left the far edge of the sheet off the canvas.
  const visible = await visibleWorldBounds(page)
  expect(visible.minY).toBeLessThanOrEqual(sheet!.rect.minY + 1e-6)
  expect(visible.maxY).toBeGreaterThanOrEqual(sheet!.rect.maxY - 1e-6)
  expect(visible.maxX - visible.minX).toBeGreaterThanOrEqual(sheet!.rect.maxX - sheet!.rect.minX - 1e-6)
})

test('drawing on Around stamps the sheet, and the flat faces are not hit there', async ({ app }) => {
  const { page } = app
  await prepareRoundBarWithRotary(page)

  // A flat feature first, so the cross-face case exists.
  await drawRect(page, 1, 1, 3, 2)
  const [topFeature] = await features(page)
  expect(topFeature.authoringFace).toBe('top')

  await switchToAround(page)
  await zoomToModel(page)

  // Where the Top feature is drawn on the bar, the sheet picks nothing: it is
  // not hovered and not selected there.
  await clickWorld(page, { x: 2, y: 1.5 })
  expect(await selectedFeatureIds(page)).not.toContain(topFeature.id)
  expect(await getHoveredFeatureId(page)).toBeNull()

  // A rectangle drawn on the sheet is stamped around and keeps sheet coordinates.
  await drawRect(page, 1, 0.2, 3, 0.8)
  const around = (await features(page)).find((feature) => feature.id !== topFeature.id)
  expect(around?.authoringFace).toBe('around')
  expect(around!.z_top).toBeGreaterThan(around!.z_bottom)

  // It is hit on the sheet...
  await selectFeatures(page, [])
  await clickWorld(page, { x: 2, y: 0.5 })
  expect(await selectedFeatureIds(page)).toEqual([around!.id])

  // ...and not once the workspace is back on Top.
  await selectFeatures(page, [])
  await switchToTop(page)
  await zoomToModel(page)
  await clickWorld(page, { x: 2, y: 0.5 })
  expect(await selectedFeatureIds(page)).not.toContain(around!.id)
})
