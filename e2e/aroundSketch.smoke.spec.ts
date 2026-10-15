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
import { getProfileBounds, defaultTool, roundStock } from '../src/types/project'
import type { SketchProfile } from '../src/types/project'

/** The bundled GRBL controller with a fourth axis bolted on. */
const ROTARY_MACHINE = {
  ...(JSON.parse(readFileSync(new URL('../src/engine/gcode/definitions/grbl.json', import.meta.url), 'utf8')) as Record<string, unknown>),
  rotary: { about: 'x', drive: 'own' },
}

/** The same controller, with the rotary axis along Y, for a bar along Y. */
const ROTARY_MACHINE_Y = {
  ...ROTARY_MACHINE,
  rotary: { about: 'y', drive: 'own' },
}

interface SavedFeature {
  id: string
  authoringFace?: 'top' | 'bottom' | 'around'
  z_top: number
  z_bottom: number
}

interface SheetInfo {
  axis: 'x' | 'y'
  zero: number
  sheetStart: number
  circumference: number
  rect: { minX: number; minY: number; maxX: number; maxY: number }
}

interface RoundBar {
  diameter: number
  /** The zero line: the bar's centreline across (issue #1026). */
  zero: number
  /** The sheet's first edge: `zero − π·diameter` (issue #1026). */
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
    meta: { ...meta, projectType: 'rotary', machineDefinitions: [ROTARY_MACHINE], selectedMachineId: 'grbl' },
  }))
  const barBounds = getProfileBounds(bar.profile)
  const zero = barBounds.minY + diameter / 2
  return { diameter, zero, sheetStart: zero - (Math.PI * diameter) / 2 }
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
    return sheet ? { axis: sheet.axis, zero: sheet.zero, sheetStart: sheet.sheetStart, circumference: sheet.circumference, rect: sheet.rect } : null
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
  // The zero line is the bar's centreline and runs through the middle of the
  // sheet; the sheet's own first edge is half a circumference below it
  // (issue #1026).
  expect(sheet!.zero).toBeCloseTo(bar.zero, 6)
  expect(sheet!.sheetStart).toBeCloseTo(bar.sheetStart, 6)
  expect(sheet!.rect.minY + sheet!.circumference / 2).toBeCloseTo(sheet!.zero, 6)

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

// ── C1: Thread and Flutes on Around (issue #1016) ────────────────────
//
// The dialogs and the entries that open them. The store action itself is the
// core slice's contract; these tests drive the real buttons, read the created
// ordinary geometry back, and check that the generated Engrave and the 3D /
// Simulation surfaces agree that something was cut.

type Ui = typeof import('./selectors')

interface RotarySnapshot {
  folderCount: number
  folderName: string | null
  featureCount: number
  operationCount: number
  operationId: string | null
  operationKind: string | null
  operationPass: string | null
  operationToolRef: string | null
  targetFeatureIds: string[]
  historyPast: number
}

async function rotarySnapshot(page: Page): Promise<RotarySnapshot> {
  return page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const state = useProjectStore.getState()
    const project = state.project
    const operation = project.operations[0]
    const target = operation?.target
    return {
      folderCount: project.featureFolders.length,
      folderName: project.featureFolders[0]?.name ?? null,
      featureCount: project.features.length,
      operationCount: project.operations.length,
      operationId: operation?.id ?? null,
      operationKind: operation?.kind ?? null,
      operationPass: operation?.pass ?? null,
      operationToolRef: operation?.toolRef ?? null,
      targetFeatureIds: target?.source === 'features' ? target.featureIds : [],
      historyPast: state.history.past.length,
    }
  })
}

interface RotaryLineGeometry {
  lineCount: number
  circumference: number
  /** The lead of the first line: along distance per full turn, from the sheet slope. */
  lead: number | null
  /** Across travel of each line, in project units. Signed: the physical hand. */
  acrossPerLine: number[]
  /** The across coordinate each line starts at, from the ordinary profile.start. */
  acrossStart: number[]
  /** Along coordinate (the bar's project axis) of each line's first point. */
  alongStart: number[]
  /** Along coordinate of each line's last point. */
  alongEnd: number[]
}

/**
 * Read the created ordinary line features back from the project and derive
 * their sheet geometry. This is a real geometry check: the field text is not
 * evidence that the store was called with the right pitch.
 */
async function rotaryLineGeometry(page: Page): Promise<RotaryLineGeometry> {
  return page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { rotaryPatternFrame } = await import('/src/store/helpers/rotaryPatterns.ts') as typeof import('../src/store/helpers/rotaryPatterns')
    const project = useProjectStore.getState().project
    const frame = rotaryPatternFrame(project)
    if (!frame) throw new Error('e2e: the project has no rotary frame')
    const profiles = project.features
      .map((feature) => project.featureDefinitions[feature.definitionId]?.profile)
      .filter((profile): profile is NonNullable<typeof profile> => profile !== undefined)
    const alongOf = (point: { x: number; y: number }): number => (frame.axis === 'x' ? point.x : point.y)
    const ends = profiles.map((profile) => {
      const segment = profile.segments[0]
      return segment && segment.type === 'line' ? segment.to : profile.start
    })
    const acrossPerLine = profiles.map((profile, index) => (
      frame.axis === 'x' ? ends[index].y - profile.start.y : ends[index].x - profile.start.x
    ))
    const acrossStart = profiles.map((profile) => (
      frame.axis === 'x' ? profile.start.y : profile.start.x
    ))
    const first = profiles[0]
    let lead: number | null = null
    if (first) {
      const along = alongOf(ends[0]) - alongOf(first.start)
      const across = acrossPerLine[0]
      lead = across === 0 ? null : Math.abs((along * frame.circumference) / across)
    }
    return {
      lineCount: profiles.length,
      circumference: frame.circumference,
      lead,
      acrossPerLine,
      acrossStart,
      alongStart: profiles.map((profile) => alongOf(profile.start)),
      alongEnd: ends.map((point) => alongOf(point)),
    }
  })
}

interface GeneratedReadout {
  moveCount: number
  errorCount: number
  allHaveAngle: boolean
}

/** Compute one operation in the page: "up to date" is not proof of motion. */
async function generatedThreadOperation(page: Page, operationId: string): Promise<GeneratedReadout> {
  return page.evaluate(async (id) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { computeOperationToolpath } = await import('/src/engine/toolpaths/generateOperation.ts') as typeof import('../src/engine/toolpaths/generateOperation')
    const { warningSeverity } = await import('/src/engine/toolpaths/warningCodes.ts') as typeof import('../src/engine/toolpaths/warningCodes')
    const project = useProjectStore.getState().project
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new Error(`e2e: the project has no operation ${id}`)
    const envelope = computeOperationToolpath(project, operation)
    if (!envelope) throw new Error(`e2e: ${id} did not generate`)
    const points = envelope.result.moves.flatMap((move) => [move.from, move.to])
    return {
      moveCount: envelope.result.moves.length,
      errorCount: envelope.result.warnings.filter((warning) => warningSeverity(warning.code) === 'error').length,
      allHaveAngle: points.every((point) => typeof point.a === 'number'),
    }
  }, operationId)
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    useProjectStore.getState().undo()
  })
}

async function redo(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    useProjectStore.getState().redo()
  })
}

/** The default project as an inch round bar with a rotary machine. */
async function prepareInchRoundBarWithRotary(page: Page): Promise<void> {
  const project = await getProject(page)
  const meta = project.meta as Record<string, unknown>
  await seedProject(page, JSON.stringify({
    ...project,
    stock: roundStock(0.5, 2, 'x'),
    meta: { ...meta, units: 'inch', projectType: 'rotary', machineDefinitions: [ROTARY_MACHINE], selectedMachineId: 'grbl' },
  }))
}

/**
 * A Ø25 × 120 mm round bar with a rotary machine. The app boots an inch
 * project, and the dialog's fields and defaults are unit-specific, so the mm
 * tests seed their units explicitly.
 */
async function prepareMmRoundBarWithRotary(page: Page): Promise<{ diameter: number }> {
  const project = await getProject(page)
  const meta = project.meta as Record<string, unknown>
  const bar = roundStock(25, 120, 'x')
  await seedProject(page, JSON.stringify({
    ...project,
    stock: bar,
    meta: { ...meta, units: 'mm', projectType: 'rotary', machineDefinitions: [ROTARY_MACHINE], selectedMachineId: 'grbl' },
  }))
  return { diameter: bar.thickness }
}

/** Two compatible project tools for the flute dialog: a ball and a V-bit. */
async function seedFluteTools(page: Page): Promise<void> {
  const project = await getProject(page)
  await seedProject(page, JSON.stringify({
    ...project,
    tools: [
      { ...defaultTool('mm', 1), id: 't-ball', name: 'Ball 3', type: 'ball_endmill', diameter: 3 },
      { ...defaultTool('mm', 2), id: 't-v', name: 'V-bit 60', type: 'v_bit', vBitAngle: 60, diameter: 6 },
    ],
  }))
}

/**
 * The same Ø25 × 120 mm bar, but along the given axis, with a rotary machine
 * whose fourth axis lies along it. The physical hand is a property of the
 * helix, not the screen, so the direction tests run on both axes.
 */
async function prepareMmRoundBarAxis(page: Page, axis: 'x' | 'y'): Promise<{ diameter: number }> {
  const project = await getProject(page)
  const meta = project.meta as Record<string, unknown>
  const bar = roundStock(25, 120, axis)
  await seedProject(page, JSON.stringify({
    ...project,
    stock: bar,
    meta: {
      ...meta,
      units: 'mm',
      projectType: 'rotary',
      machineDefinitions: [axis === 'x' ? ROTARY_MACHINE : ROTARY_MACHINE_Y],
      selectedMachineId: 'grbl',
    },
  }))
  return { diameter: bar.thickness }
}

function rotaryEntry(page: Page, ui: Ui, kind: 'thread' | 'flutes') {
  return kind === 'thread' ? ui.rotary.threadButton(page) : ui.rotary.flutesButton(page)
}

test('Thread and Flutes are offered only on an available, active Around face', async ({ app, ui }) => {
  const { page } = app
  // A milling block has no Around face at all.
  await expect(ui.rotary.threadButton(page)).toHaveCount(0)
  await expect(ui.rotary.flutesButton(page)).toHaveCount(0)

  await prepareMmRoundBarWithRotary(page)
  // A rotary bar still shows nothing while the workspace is on Top.
  await expect(ui.rotary.threadButton(page)).toHaveCount(0)

  await switchToAround(page)
  await expect(ui.rotary.threadButton(page)).toBeVisible()
  await expect(ui.rotary.flutesButton(page)).toBeVisible()

  await switchToTop(page)
  await expect(ui.rotary.threadButton(page)).toHaveCount(0)
  await expect(ui.rotary.flutesButton(page)).toHaveCount(0)
})

test('a mm thread creates its folder, lines and Engrave in a single undo step', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  await switchToAround(page)
  const baseline = await rotarySnapshot(page)

  await ui.rotary.threadButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeVisible()
  await expect(ui.rotary.note(page)).toContainText('not precision thread tooling')
  // Defaults: one start, and a depth of 0.61 × the 1.5 mm default pitch.
  await expect(ui.rotary.field(page, 'starts')).toHaveValue('1')
  await expect(ui.rotary.field(page, 'depth')).toHaveValue('0.915')
  await ui.rotary.field(page, 'start').fill('2')
  await ui.rotary.field(page, 'length').fill('30')
  await ui.rotary.field(page, 'pitch').fill('2')
  await ui.rotary.field(page, 'starts').fill('2')
  await ui.rotary.field(page, 'depth').fill('1.2')
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()

  const snapshot = await rotarySnapshot(page)
  expect(snapshot.folderName).toContain('Thread')
  expect(snapshot.featureCount).toBe(baseline.featureCount + 2)
  expect(snapshot.operationKind).toBe('follow_line')
  expect(snapshot.operationPass).toBe('rough')
  expect(snapshot.targetFeatureIds).toHaveLength(2)
  // The folder, both lines and the operation are one history transition.
  expect(snapshot.historyPast).toBe(baseline.historyPast + 1)
  expect(snapshot.operationId).not.toBeNull()

  // A two-start thread has a lead of two pitches, and its starts sit half a
  // circumference apart across the sheet. The across *start* is what separates
  // the starts; each line's across travel is its own helix span, not an offset.
  const geometry = await rotaryLineGeometry(page)
  expect(geometry.lineCount).toBe(2)
  expect(geometry.lead ?? 0).toBeCloseTo(4, 6)
  const offsets = [...geometry.acrossStart].sort((a, b) => a - b)
  expect(Math.abs((offsets[1] - offsets[0]) - geometry.circumference / 2)).toBeLessThan(1e-6)
  expect(geometry.acrossPerLine.every((across) => Math.abs(across) > 1e-6)).toBe(true)

  // Let the generation gear settle before reading the generated moves back.
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })

  // The generated Engrave really moves, wrapped onto the bar.
  const generated = await generatedThreadOperation(page, snapshot.operationId!)
  expect(generated.moveCount).toBeGreaterThan(0)
  expect(generated.errorCount).toBe(0)
  expect(generated.allHaveAngle).toBe(true)

  // One undo removes the folder, both lines and the operation; redo restores them.
  await undo(page)
  expect(await rotarySnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })
  await redo(page)
  expect(await rotarySnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount + 1,
    featureCount: baseline.featureCount + 2,
    operationCount: baseline.operationCount + 1,
    historyPast: baseline.historyPast + 1,
  })
})

test('an inch thread dialog converts 20 TPI to a 0.05 inch pitch', async ({ app, ui }) => {
  const { page } = app
  await prepareInchRoundBarWithRotary(page)
  await switchToAround(page)

  await ui.rotary.threadButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeVisible()
  // The inch field is threads per inch, not a pitch.
  await expect(ui.rotary.dialog(page).getByLabel('Threads per inch')).toBeVisible()
  // The default depth follows the pitch: 0.61 × (1/20) = 0.0305 in.
  await expect(ui.rotary.field(page, 'depth')).toHaveValue('0.0305')
  // A depth the user chose survives a later pitch edit.
  await ui.rotary.field(page, 'depth').fill('0.02')
  await ui.rotary.field(page, 'pitch').fill('10')
  await expect(ui.rotary.field(page, 'depth')).toHaveValue('0.02')
  await ui.rotary.field(page, 'length').fill('2')
  await ui.rotary.field(page, 'pitch').fill('20')
  await ui.rotary.field(page, 'depth').fill('0.03')
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()

  // 20 TPI is a physical pitch of 0.05 in, read back from the created line.
  const geometry = await rotaryLineGeometry(page)
  expect(geometry.lineCount).toBe(1)
  expect(geometry.lead ?? 0).toBeCloseTo(0.05, 8)
})

test('flutes follow count, twist and the chosen tool', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  await seedFluteTools(page)
  await switchToAround(page)

  // Straight flutes: three of them, no twist, cut with the ball tool.
  await ui.rotary.flutesButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeVisible()
  await ui.rotary.field(page, 'length').fill('30')
  await ui.rotary.field(page, 'count').fill('3')
  await ui.rotary.field(page, 'twist').fill('0')
  await ui.rotary.field(page, 'depth').fill('1')
  await ui.rotary.toolTrigger(page).click()
  await ui.rotary.toolOption(page, 'Ball 3').click()
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()

  let snapshot = await rotarySnapshot(page)
  expect(snapshot.folderName).toContain('Flutes')
  expect(snapshot.featureCount).toBe(3)
  expect(snapshot.operationKind).toBe('follow_line')
  expect(snapshot.operationToolRef).toBe('t-ball')
  let geometry = await rotaryLineGeometry(page)
  expect(geometry.lineCount).toBe(3)
  expect(geometry.acrossPerLine.every((across) => Math.abs(across) < 1e-6)).toBe(true)

  // A twisted flute with the V-bit: two turns of twist, and the chosen tool.
  await undo(page)
  await ui.rotary.flutesButton(page).click()
  await ui.rotary.field(page, 'length').fill('30')
  await ui.rotary.field(page, 'count').fill('2')
  await ui.rotary.field(page, 'twist').fill('2')
  await ui.rotary.field(page, 'depth').fill('1')
  await ui.rotary.toolTrigger(page).click()
  await ui.rotary.toolOption(page, 'V-bit 60').click()
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()

  snapshot = await rotarySnapshot(page)
  expect(snapshot.featureCount).toBe(2)
  expect(snapshot.operationToolRef).toBe('t-v')
  geometry = await rotaryLineGeometry(page)
  expect(geometry.lineCount).toBe(2)
  geometry.acrossPerLine.forEach((across) => {
    expect(Math.abs(Math.abs(across) / geometry.circumference - 2)).toBeLessThan(1e-6)
  })
})

test('the thread dialog defaults to Right, and Left reverses the same helix', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  await switchToAround(page)

  // Right is the default, and it is what the store is asked for.
  await ui.rotary.threadButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeVisible()
  await expect(ui.rotary.directionTrigger(page)).toContainText('Right-hand')
  await ui.rotary.field(page, 'start').fill('2')
  await ui.rotary.field(page, 'length').fill('30')
  await ui.rotary.field(page, 'pitch').fill('2')
  await ui.rotary.field(page, 'depth').fill('1.2')
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()

  const right = await rotaryLineGeometry(page)
  expect(right.lineCount).toBe(1)
  expect(right.lead ?? 0).toBeCloseTo(2, 6)
  expect(right.alongEnd[0] - right.alongStart[0]).toBeCloseTo(30, 6)
  expect(right.acrossPerLine[0]).toBeGreaterThan(0)

  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })
  const rightGenerated = await generatedThreadOperation(page, (await rotarySnapshot(page)).operationId!)
  expect(rightGenerated.moveCount).toBeGreaterThan(0)
  expect(rightGenerated.errorCount).toBe(0)

  // Left is the same line mirrored along the bar: same lead and endpoints,
  // opposite across sign, pitch untouched.
  await undo(page)
  await ui.rotary.threadButton(page).click()
  await ui.rotary.field(page, 'start').fill('2')
  await ui.rotary.field(page, 'length').fill('30')
  await ui.rotary.field(page, 'pitch').fill('2')
  await ui.rotary.field(page, 'depth').fill('1.2')
  await ui.rotary.directionTrigger(page).click()
  await ui.rotary.directionOption(page, 'Left-hand').click()
  await expect(ui.rotary.directionTrigger(page)).toContainText('Left-hand')
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()

  const left = await rotaryLineGeometry(page)
  expect(left.lineCount).toBe(1)
  expect(left.lead ?? 0).toBeCloseTo(2, 6)
  expect(left.alongEnd[0] - left.alongStart[0]).toBeCloseTo(30, 6)
  expect(left.alongStart[0]).toBeCloseTo(right.alongStart[0], 6)
  expect(left.acrossPerLine[0]).toBeLessThan(0)
  expect(Math.abs(left.acrossPerLine[0])).toBeCloseTo(Math.abs(right.acrossPerLine[0]), 6)

  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })
  const leftGenerated = await generatedThreadOperation(page, (await rotarySnapshot(page)).operationId!)
  expect(leftGenerated.moveCount).toBeGreaterThan(0)
  expect(leftGenerated.errorCount).toBe(0)
})

test('an inch Left thread keeps the 20 TPI pitch and reverses the helix', async ({ app, ui }) => {
  const { page } = app
  await prepareInchRoundBarWithRotary(page)
  await switchToAround(page)

  await ui.rotary.threadButton(page).click()
  await expect(ui.rotary.directionTrigger(page)).toContainText('Right-hand')
  await ui.rotary.directionTrigger(page).click()
  await ui.rotary.directionOption(page, 'Left-hand').click()
  await ui.rotary.field(page, 'length').fill('2')
  await ui.rotary.field(page, 'pitch').fill('20')
  await ui.rotary.field(page, 'depth').fill('0.03')
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()

  // The field is still threads per inch: 20 TPI is a 0.05 in physical pitch,
  // and the Left hand only flips the sheet slope.
  const geometry = await rotaryLineGeometry(page)
  expect(geometry.lineCount).toBe(1)
  expect(geometry.lead ?? 0).toBeCloseTo(0.05, 8)
  expect(geometry.acrossPerLine[0]).toBeLessThan(0)
})

test('a Left thread reverses the helix on a bar along Y as well', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarAxis(page, 'y')
  await switchToAround(page)

  await ui.rotary.threadButton(page).click()
  await ui.rotary.field(page, 'length').fill('30')
  await ui.rotary.field(page, 'pitch').fill('2')
  await ui.rotary.field(page, 'depth').fill('1.2')
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()
  const right = await rotaryLineGeometry(page)
  expect(right.lineCount).toBe(1)
  expect(right.lead ?? 0).toBeCloseTo(2, 6)

  await undo(page)
  await ui.rotary.threadButton(page).click()
  await ui.rotary.field(page, 'length').fill('30')
  await ui.rotary.field(page, 'pitch').fill('2')
  await ui.rotary.field(page, 'depth').fill('1.2')
  await ui.rotary.directionTrigger(page).click()
  await ui.rotary.directionOption(page, 'Left-hand').click()
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()
  const left = await rotaryLineGeometry(page)
  expect(left.lineCount).toBe(1)
  // The hand is physical, so on the other bar axis Left is the mirror of
  // Right: the same magnitude with the opposite signed across travel.
  expect(left.acrossPerLine[0] * right.acrossPerLine[0]).toBeLessThan(0)
  expect(Math.abs(left.acrossPerLine[0])).toBeCloseTo(Math.abs(right.acrossPerLine[0]), 6)
})

test('flute twist is a magnitude, and Left flips the hand', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  await seedFluteTools(page)
  await switchToAround(page)
  const baseline = await rotarySnapshot(page)

  // Right-hand (default): two positive turns of twist, cut with the ball tool.
  await ui.rotary.flutesButton(page).click()
  await expect(ui.rotary.directionTrigger(page)).toContainText('Right-hand')
  await ui.rotary.field(page, 'length').fill('30')
  await ui.rotary.field(page, 'count').fill('2')
  await ui.rotary.field(page, 'twist').fill('2')
  await ui.rotary.field(page, 'depth').fill('1')
  await ui.rotary.toolTrigger(page).click()
  await ui.rotary.toolOption(page, 'Ball 3').click()
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()
  const right = await rotaryLineGeometry(page)
  expect(right.lineCount).toBe(2)
  expect(right.acrossPerLine.every((across) => across > 0)).toBe(true)
  expect((await rotarySnapshot(page)).operationToolRef).toBe('t-ball')

  // Left-hand: the same positive magnitude, signed negative, V-bit tool.
  await undo(page)
  await ui.rotary.flutesButton(page).click()
  await ui.rotary.field(page, 'length').fill('30')
  await ui.rotary.field(page, 'count').fill('2')
  await ui.rotary.field(page, 'twist').fill('2')
  await ui.rotary.field(page, 'depth').fill('1')
  await ui.rotary.toolTrigger(page).click()
  await ui.rotary.toolOption(page, 'V-bit 60').click()
  await ui.rotary.directionTrigger(page).click()
  await ui.rotary.directionOption(page, 'Left-hand').click()
  // The field keeps the magnitude the user typed; the hand signs the store call.
  await expect(ui.rotary.field(page, 'twist')).toHaveValue('2')
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()
  const left = await rotaryLineGeometry(page)
  expect(left.lineCount).toBe(2)
  expect(left.acrossPerLine.every((across) => across < 0)).toBe(true)
  left.acrossPerLine.forEach((across, index) => {
    expect(Math.abs(across)).toBeCloseTo(Math.abs(right.acrossPerLine[index]), 6)
  })
  expect((await rotarySnapshot(page)).operationToolRef).toBe('t-v')

  // One undo removes the whole pattern; redo restores it.
  await undo(page)
  expect(await rotarySnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })
  await redo(page)
  expect(await rotarySnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount + 1,
    featureCount: baseline.featureCount + 2,
    operationCount: baseline.operationCount + 1,
    historyPast: baseline.historyPast + 1,
  })

  // Zero twist is straight in either hand: Left with 0 has no across travel.
  await undo(page)
  await ui.rotary.flutesButton(page).click()
  await ui.rotary.field(page, 'length').fill('30')
  await ui.rotary.field(page, 'count').fill('2')
  await ui.rotary.field(page, 'twist').fill('0')
  await ui.rotary.field(page, 'depth').fill('1')
  await ui.rotary.toolTrigger(page).click()
  await ui.rotary.toolOption(page, 'Ball 3').click()
  await ui.rotary.directionTrigger(page).click()
  await ui.rotary.directionOption(page, 'Left-hand').click()
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()
  const straight = await rotaryLineGeometry(page)
  expect(straight.lineCount).toBe(2)
  expect(straight.acrossPerLine.every((across) => Math.abs(across) < 1e-6)).toBe(true)
})

test('a negative flute twist is refused without creating anything', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  await seedFluteTools(page)
  await switchToAround(page)
  const baseline = await rotarySnapshot(page)

  await ui.rotary.flutesButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeVisible()
  await ui.rotary.field(page, 'length').fill('30')
  await ui.rotary.field(page, 'twist').fill('-1')
  await expect(ui.rotary.error(page)).toContainText('cannot be negative')
  await expect(ui.rotary.createButton(page)).toBeDisabled()
  expect(await rotarySnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })

  // Twist is a magnitude: the same 1 typed positive is accepted.
  await ui.rotary.field(page, 'twist').fill('1')
  await expect(ui.rotary.error(page)).toHaveCount(0)
  await expect(ui.rotary.createButton(page)).toBeEnabled()
})

test('a centreline depth is refused, and Cancel or Escape creates nothing', async ({ app, ui }) => {
  const { page } = app
  const bar = await prepareMmRoundBarWithRotary(page)
  await switchToAround(page)
  const baseline = await rotarySnapshot(page)

  await ui.rotary.threadButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeVisible()
  await ui.rotary.field(page, 'length').fill('10')
  await ui.rotary.field(page, 'depth').fill(String(bar.diameter / 2))
  await expect(ui.rotary.error(page)).toContainText('Keep the depth above the bar centreline.')
  await expect(ui.rotary.createButton(page)).toBeDisabled()
  expect(await rotarySnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })

  await page.keyboard.press('Escape')
  await expect(ui.rotary.dialog(page)).toBeHidden()
  expect(await rotarySnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })

  await ui.rotary.threadButton(page).click()
  await ui.rotary.cancelButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()
  expect((await rotarySnapshot(page)).historyPast).toBe(baseline.historyPast)
})

test('leaving Around while a dialog is open applies nothing', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  await switchToAround(page)
  const baseline = await rotarySnapshot(page)

  await ui.rotary.threadButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeVisible()
  await ui.rotary.field(page, 'length').fill('10')

  await switchToTop(page)
  await expect(ui.rotary.dialog(page)).toHaveCount(0)
  // Returning to Around does not resurrect the stale request.
  await switchToAround(page)
  await expect(ui.rotary.dialog(page)).toHaveCount(0)
  expect(await rotarySnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })
})

/** The face the store says the workspace is on, read from the live project. */
async function workspaceFace(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const storeUrl = '/src/store/projectStore.ts'
    const { useProjectStore } = await import(storeUrl) as typeof import('../src/store/projectStore')
    const faceUrl = '/src/store/helpers/activeFace.ts'
    const { activeFace } = await import(faceUrl) as typeof import('../src/store/helpers/activeFace')
    return activeFace(useProjectStore.getState().project)
  })
}

/**
 * The parked create's own catalog await, reached from outside the unmounted
 * dialog. `loadBundledToolLibrary` memoizes one promise per page, and the
 * Create click registered its continuation on that promise first; a reaction
 * registered on it later runs later, so by the time this resolves the parked
 * `handleCreate` has already resumed — and already written, if the unmount
 * guard is missing. That is what makes the assertion below about the guard
 * rather than about the clock: the store is read after the create, not racing
 * it. This drives the real loader; nothing is stubbed.
 */
async function awaitCatalogContinuation(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const url = '/src/toolLibrary.ts'
    const { loadBundledToolLibrary } = await import(url) as typeof import('../src/toolLibrary')
    await loadBundledToolLibrary()
  })
}

test('a thread catalog load held across leaving and returning to Around creates nothing', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  // A V-bit in the project, so a create that wrongly gets through cannot fail
  // for want of a tool: whether the abandoned request writes is the only
  // question left. The dialog still awaits the catalog for a thread regardless.
  await seedFluteTools(page)
  await switchToAround(page)
  const baseline = await rotarySnapshot(page)
  expect(await workspaceFace(page)).toBe('around')

  // Hold the bundled tool-library fetch open so Create is genuinely in flight.
  let releaseLibrary: () => void = () => {}
  const libraryGate = new Promise<void>((resolve) => { releaseLibrary = resolve })
  await page.route('**/tool-library.json', async (route) => {
    await libraryGate
    await route.continue()
  })

  await ui.rotary.threadButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeVisible()
  await ui.rotary.field(page, 'length').fill('10')
  const request = page.waitForRequest('**/tool-library.json')
  await ui.rotary.createButton(page).click()
  await request

  // Leaving Around unmounts the dialog and parks its create on the held fetch.
  await switchToTop(page)
  await expect(ui.rotary.dialog(page)).toHaveCount(0)

  // Return to Around *before* the catalog is released. The face is valid again
  // and the store would accept the create if the parked request simply resumed,
  // so only the dialog's own unmount guard can stop it. A fresh, closed dialog
  // mounts; the stale one is not resurrected.
  await switchToAround(page)
  await expect(ui.rotary.threadButton(page)).toBeVisible()
  await expect(ui.rotary.dialog(page)).toHaveCount(0)
  expect(await workspaceFace(page)).toBe('around')

  // Only now release the catalog, and wait for the held response to be
  // delivered and the parked create to resume against it.
  const response = page.waitForResponse('**/tool-library.json')
  releaseLibrary()
  await response
  await awaitCatalogContinuation(page)
  await page.unrouteAll({ behavior: 'wait' })
  // Belt and braces for any continuation that ran past the memoized promise.
  await page.waitForTimeout(250)

  // The abandoned create wrote nothing, and the fresh dialog stayed closed.
  await expect(ui.rotary.dialog(page)).toHaveCount(0)
  expect(await rotarySnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })
})

test('the created thread wraps in the 3D overlay and removes simulation material', async ({ app, ui }) => {
  test.setTimeout(120_000)
  const { page } = app
  const bar = await prepareMmRoundBarWithRotary(page)
  await switchToAround(page)

  await ui.rotary.threadButton(page).click()
  await ui.rotary.field(page, 'length').fill('20')
  await ui.rotary.field(page, 'pitch').fill('2')
  await ui.rotary.field(page, 'depth').fill('1.5')
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })

  // The 3D overlay publishes the wrapped segments, and they pass under the bar.
  await ui.viewMenu.tab3d(page).click()
  await expect(page.locator('#workspace-panel-preview3d canvas')).toBeVisible()
  const overlay = page.locator('#workspace-panel-preview3d .viewport-3d')
  await expect.poll(
    async () => Number(await overlay.getAttribute('data-toolpath-segments')),
    { timeout: 15_000 },
  ).toBeGreaterThan(0)
  expect(Number(await overlay.getAttribute('data-toolpath-min-z'))).toBeLessThan(bar.diameter / 2)

  // Simulation: the Engrave cuts into the bar, so material is removed.
  await ui.operations.rowByName(page, 'Thread Engrave').click()
  await ui.viewMenu.tabSimulation(page).click()
  const viewport = ui.simSetup.viewport(page)
  await expect(viewport).toBeVisible()
  await expect.poll(
    async () => Number(await viewport.getAttribute('data-simulation-removed-cells')),
    { timeout: 60_000 },
  ).toBeGreaterThan(0)
})

test.describe('tablet Thread and Flutes', () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true })

  test('the tool rail offers both dialogs, which fit with reachable actions', async ({ app, ui }) => {
    const { page } = app
    await prepareMmRoundBarWithRotary(page)
    await switchToAround(page)

    // The rail variant of the entries carries the same stable command hook.
    await expect(rotaryEntry(page, ui, 'thread')).toBeVisible()
    await expect(rotaryEntry(page, ui, 'flutes')).toBeVisible()
    await rotaryEntry(page, ui, 'thread').click()

    const dialog = ui.rotary.dialog(page)
    await expect(dialog).toBeVisible()
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(820)
    await expect(ui.rotary.createButton(page)).toBeVisible()
    await expect(ui.rotary.cancelButton(page)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    // Closing returns focus to the canvas.
    const canvasFocused = await page.evaluate(() => document.activeElement?.classList.contains('sketch-canvas') ?? false)
    expect(canvasFocused).toBe(true)
  })
})

