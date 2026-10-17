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
import type { Locator, Page } from '@playwright/test'
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
import { getProfileBounds, defaultTool, newProject, roundStock } from '../src/types/project'
import type { Project, RoundStock, SketchProfile } from '../src/types/project'
import { squareStock } from '../src/types/barStock'

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
async function generatedOperation(page: Page, operationId: string): Promise<GeneratedReadout> {
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
  const generated = await generatedOperation(page, snapshot.operationId!)
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
  const rightGenerated = await generatedOperation(page, (await rotarySnapshot(page)).operationId!)
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
  const leftGenerated = await generatedOperation(page, (await rotarySnapshot(page)).operationId!)
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

// ── C2-U2: Polygon / hex and Square to round on Around (issue #1016) ──
//
// The two one-shot solids. Each is driven through its own real entry and the
// created ordinary model is read back with its persisted mesh bounds, so the
// chuck-end start/length → absolute stock-space map is asserted physically
// rather than from the field text. Generation is driven through the same store
// path the preview uses: a gear that says "up to date" is not proof of motion.

interface SolidMeshBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

interface SolidSnapshot {
  folderCount: number
  folderName: string | null
  featureCount: number
  operationCount: number
  historyPast: number
  operationIds: string[]
  operationKinds: string[]
  /** Each operation's feature targets, in operation order. */
  targetFeatureIds: string[][]
  modelFeatureIds: string[]
  modelAuthoringFaces: Array<string | undefined>
  modelVertexCounts: number[]
  modelBounds: Array<SolidMeshBounds | null>
}

/** The created solid and its operations, read from the live project. */
async function solidSnapshot(page: Page): Promise<SolidSnapshot> {
  return page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const state = useProjectStore.getState()
    const project = state.project
    const models = project.features.filter((feature) => project.featureDefinitions[feature.definitionId]?.kind === 'stl')
    const assetOf = (feature: typeof models[number]) => {
      const assetId = project.featureDefinitions[feature.definitionId]?.stl?.meshAssetId
      return assetId ? project.modelAssets[assetId] : undefined
    }
    return {
      folderCount: project.featureFolders.length,
      folderName: project.featureFolders[0]?.name ?? null,
      featureCount: project.features.length,
      operationCount: project.operations.length,
      historyPast: state.history.past.length,
      operationIds: project.operations.map((operation) => operation.id),
      operationKinds: project.operations.map((operation) => operation.kind),
      targetFeatureIds: project.operations.map((operation) => (
        operation.target.source === 'features' ? operation.target.featureIds : []
      )),
      modelFeatureIds: models.map((feature) => feature.id),
      modelAuthoringFaces: models.map((feature) => feature.authoringFace),
      modelVertexCounts: models.map((feature) => assetOf(feature)?.vertexCount ?? 0),
      modelBounds: models.map((feature) => {
        const bounds = assetOf(feature)?.bounds
        return bounds
          ? {
              minX: bounds.minX, maxX: bounds.maxX,
              minY: bounds.minY, maxY: bounds.maxY,
              minZ: bounds.minZ, maxZ: bounds.maxZ,
            }
          : null
      }),
    }
  })
}

/** The project's tools, replaced wholesale (the seed helper the C1 tests use only covers flutes). */
async function seedTools(page: Page, tools: unknown[]): Promise<void> {
  const project = await getProject(page)
  await seedProject(page, JSON.stringify({ ...project, tools }))
}

async function operationToolRefs(page: Page): Promise<Array<string | null>> {
  return page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    return useProjectStore.getState().project.operations.map((operation) => operation.toolRef)
  })
}

/**
 * A square blank of side 25 mm and length 120 mm along X with a rotary machine
 * and one flat end mill, the real starting box of a square-to-round job.
 */
async function prepareMmSquareBlankWithRotary(page: Page): Promise<{ side: number; length: number }> {
  const project = await getProject(page)
  const meta = project.meta as Record<string, unknown>
  const blank = squareStock(25, 120, 'x')
  await seedProject(page, JSON.stringify({
    ...project,
    stock: blank,
    tools: [{ ...defaultTool('mm', 1), id: 't-flat', name: 'Flat 6', type: 'flat_endmill', diameter: 6 }],
    meta: { ...meta, units: 'mm', projectType: 'rotary', machineDefinitions: [ROTARY_MACHINE], selectedMachineId: 'grbl' },
  }))
  return { side: blank.thickness, length: 120 }
}

/** The live bar after an edit, read from the store rather than from a field. */
async function liveBar(page: Page): Promise<{
  shape: string
  axis: 'x' | 'y'
  thickness: number
  length: number
  units: 'mm' | 'inch'
}> {
  const project = await getProject(page) as unknown as Project
  const stock = project.stock as RoundStock
  const bounds = getProfileBounds(stock.profile)
  return {
    shape: stock.shape ?? 'block',
    axis: stock.axis,
    thickness: stock.thickness,
    length: stock.axis === 'x' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY,
    units: project.meta.units,
  }
}

/**
 * Re-aim or resize the live round bar through the helpers the Properties panel
 * uses, keeping the machine origin in step.
 */
async function editRoundBar(page: Page, change: { diameter?: number; length?: number; axis?: 'x' | 'y' }): Promise<void> {
  await page.evaluate(async (next) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { originAfterStockEdit, resizeRoundStock } = await import('/src/store/helpers/stockShape.ts') as typeof import('../src/store/helpers/stockShape')
    const state = useProjectStore.getState()
    const stock = state.project.stock
    if (stock.shape !== 'round') throw new Error('e2e: the stock is not a round bar')
    const resized = resizeRoundStock(stock, next)
    state.setStockAndOrigin(resized, originAfterStockEdit(state.project.origin, stock, resized))
  }, change)
}

/** A side edit on the live square blank, through the same helpers the panel uses. */
async function editSquareSide(page: Page, side: number): Promise<void> {
  await page.evaluate(async (nextSide) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { originAfterStockEdit, resizeSquareStock } = await import('/src/store/helpers/stockShape.ts') as typeof import('../src/store/helpers/stockShape')
    const state = useProjectStore.getState()
    const stock = state.project.stock
    if (stock.shape !== 'square') throw new Error('e2e: the stock is not a square blank')
    const resized = resizeSquareStock(stock, { side: nextSide })
    state.setStockAndOrigin(resized, originAfterStockEdit(state.project.origin, stock, resized))
  }, side)
}

/** Convert the project's units through the same store action the units dialog takes. */
async function convertUnits(page: Page, units: 'mm' | 'inch'): Promise<void> {
  await page.evaluate(async (next) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    useProjectStore.getState().setUnits(next, 'convert')
  }, units)
}

/** The active face, read from the page's own store. */
async function activeFaceOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { activeFace } = await import('/src/store/helpers/activeFace.ts') as typeof import('../src/store/helpers/activeFace')
    return activeFace(useProjectStore.getState().project)
  })
}

test('the Around solids follow the bar shape, one entry at a time', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  await switchToAround(page)

  // A round bar: Polygon is offered, Square to round is not, and the round-only
  // C1 sheet authoring stays.
  await expect(ui.rotarySolid.polygonButton(page)).toBeVisible()
  await expect(ui.rotarySolid.squareToRoundButton(page)).toHaveCount(0)
  await expect(ui.rotary.threadButton(page)).toBeVisible()
  await expect(page.locator('.toolbar-creation-picker')).toHaveCount(1)

  // Turn the bar square: the polygon entry gives way to Square to round, and
  // the round-only authoring is absent rather than offered and refused.
  await page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('/src/store/projectStore')
    useProjectStore.getState().setStockShape('square')
  })
  await expect(ui.rotarySolid.squareToRoundButton(page)).toBeVisible()
  await expect(ui.rotarySolid.polygonButton(page)).toHaveCount(0)
  await expect(ui.rotary.threadButton(page)).toHaveCount(0)
  await expect(ui.rotary.flutesButton(page)).toHaveCount(0)
  await expect(page.locator('.toolbar-creation-picker')).toHaveCount(0)

  // Back to round: the 2D authoring and the round-only entries return.
  await page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('/src/store/projectStore')
    useProjectStore.getState().setStockShape('round')
  })
  await expect(ui.rotarySolid.polygonButton(page)).toBeVisible()
  await expect(page.locator('.toolbar-creation-picker')).toHaveCount(1)
  await expect(ui.rotary.threadButton(page)).toBeVisible()
})

test('a hex polygon creates an ordinary model, rough and finish in one undo step', async ({ app, ui }) => {
  test.setTimeout(90_000)
  const { page } = app
  const bar = await prepareMmRoundBarWithRotary(page)
  await seedFluteTools(page)
  await switchToAround(page)
  const baseline = await solidSnapshot(page)

  await ui.rotarySolid.polygonButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  // Defaults: six sides, across flats at 0.75 × the bar diameter, rotation 0.
  await expect(ui.rotarySolid.field(page, 'sides')).toHaveValue('6')
  await expect(ui.rotarySolid.field(page, 'across-flats')).toHaveValue(String(bar.diameter * 0.75))
  await expect(ui.rotarySolid.field(page, 'rotation')).toHaveValue('0')

  await ui.rotarySolid.field(page, 'start').fill('10')
  await ui.rotarySolid.field(page, 'length').fill('20')
  await ui.rotarySolid.field(page, 'sides').fill('6')
  await ui.rotarySolid.field(page, 'across-flats').fill('15')
  await ui.rotarySolid.field(page, 'rotation').fill('0')
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()

  const snapshot = await solidSnapshot(page)
  expect(snapshot.folderName).toContain('Hex')
  expect(snapshot.featureCount).toBe(baseline.featureCount + 1)
  expect(snapshot.operationCount).toBe(baseline.operationCount + 2)
  expect(snapshot.operationKinds).toEqual(['rotary_rough', 'rotary_finish'])
  // The folder, the model and both operations are one history transition.
  expect(snapshot.historyPast).toBe(baseline.historyPast + 1)
  // Two rings of six sides: the sides the user typed reached the store.
  expect(snapshot.modelVertexCounts).toEqual([12])
  expect(snapshot.modelAuthoringFaces).toEqual(['top'])
  // Both operations target the one generated model.
  const modelId = snapshot.modelFeatureIds[0]
  expect(snapshot.targetFeatureIds).toEqual([[modelId], [modelId]])

  // The solid is 20 long from the chuck end (minX on an X bar) and 15 across
  // flats, centred on the bar's own centreline.
  const bounds = snapshot.modelBounds[0]!
  expect(bounds.minX).toBeCloseTo(10, 3)
  expect(bounds.maxX).toBeCloseTo(30, 3)
  expect(bounds.maxZ - bounds.minZ).toBeCloseTo(15, 3)
  expect(bounds.minZ).toBeCloseTo(bar.diameter / 2 - 15 / 2, 3)

  // A real generated path, not just a gear that says "up to date".
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })
  for (const operationId of snapshot.operationIds) {
    const generated = await generatedOperation(page, operationId)
    expect(generated.moveCount).toBeGreaterThan(0)
    expect(generated.errorCount).toBe(0)
  }

  // One undo removes the whole creation; redo restores it.
  await undo(page)
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })
  await redo(page)
  const restored = await solidSnapshot(page)
  expect(restored.featureCount).toBe(baseline.featureCount + 1)
  expect(restored.operationCount).toBe(baseline.operationCount + 2)
  expect(restored.historyPast).toBe(baseline.historyPast + 1)
})

test('polygon sides, across flats and rotation change the emitted solid', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  await seedFluteTools(page)
  await switchToAround(page)

  // An octagon, 10 across flats, rotated 22.5° so a corner stands up.
  await ui.rotarySolid.polygonButton(page).click()
  await ui.rotarySolid.field(page, 'start').fill('0')
  await ui.rotarySolid.field(page, 'length').fill('40')
  await ui.rotarySolid.field(page, 'sides').fill('8')
  await ui.rotarySolid.field(page, 'across-flats').fill('10')
  await ui.rotarySolid.field(page, 'rotation').fill('22.5')
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()
  const cornersUp = await solidSnapshot(page)
  expect(cornersUp.modelVertexCounts).toEqual([16])
  const cornerBounds = cornersUp.modelBounds[0]!
  // Rotated so a corner points up, the up extent is the across-corners size.
  expect(cornerBounds.maxZ - cornerBounds.minZ).toBeCloseTo(10 / Math.cos(Math.PI / 8), 3)
  expect(cornerBounds.minX).toBeCloseTo(0, 3)
  expect(cornerBounds.maxX).toBeCloseTo(40, 3)

  await undo(page)
  // The same octagon with a flat up: the up extent is the across-flats size.
  await ui.rotarySolid.polygonButton(page).click()
  await ui.rotarySolid.field(page, 'start').fill('0')
  await ui.rotarySolid.field(page, 'length').fill('40')
  await ui.rotarySolid.field(page, 'sides').fill('8')
  await ui.rotarySolid.field(page, 'across-flats').fill('10')
  await ui.rotarySolid.field(page, 'rotation').fill('0')
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()
  const flatBounds = (await solidSnapshot(page)).modelBounds[0]!
  expect(flatBounds.maxZ - flatBounds.minZ).toBeCloseTo(10, 3)
  expect(flatBounds.maxZ - flatBounds.minZ).not.toBeCloseTo(cornerBounds.maxZ - cornerBounds.minZ, 2)
})

test('the polygon band is measured from the chuck end on a bar along Y', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarAxis(page, 'y')
  await seedFluteTools(page)
  await switchToAround(page)

  await ui.rotarySolid.polygonButton(page).click()
  await ui.rotarySolid.field(page, 'start').fill('10')
  await ui.rotarySolid.field(page, 'length').fill('20')
  await ui.rotarySolid.field(page, 'sides').fill('6')
  await ui.rotarySolid.field(page, 'across-flats').fill('10')
  await ui.rotarySolid.field(page, 'rotation').fill('0')
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()

  // The chuck end of a Y bar is its maxY, so start 10 with length 20 is
  // y 90..110 — never the mirrored y 10..30.
  const bounds = (await solidSnapshot(page)).modelBounds[0]!
  expect(bounds.minY).toBeCloseTo(90, 3)
  expect(bounds.maxY).toBeCloseTo(110, 3)
})

test('an inch project measures the polygon in inches', async ({ app, ui }) => {
  const { page } = app
  await prepareInchRoundBarWithRotary(page)
  await seedTools(page, [
    { ...defaultTool('inch', 1), id: 't-inch-flat', name: 'Flat 0.25', type: 'flat_endmill', diameter: 0.25 },
  ])
  await switchToAround(page)

  await ui.rotarySolid.polygonButton(page).click()
  // Default across flats is 0.75 × the 0.5 in bar diameter.
  await expect(ui.rotarySolid.field(page, 'across-flats')).toHaveValue('0.375')
  await ui.rotarySolid.field(page, 'start').fill('0.25')
  await ui.rotarySolid.field(page, 'length').fill('1')
  await ui.rotarySolid.field(page, 'sides').fill('6')
  await ui.rotarySolid.field(page, 'across-flats').fill('0.3')
  await ui.rotarySolid.field(page, 'rotation').fill('0')
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()

  const bounds = (await solidSnapshot(page)).modelBounds[0]!
  expect(bounds.minX).toBeCloseTo(0.25, 4)
  expect(bounds.maxX).toBeCloseTo(1.25, 4)
  expect(bounds.maxZ - bounds.minZ).toBeCloseTo(0.3, 4)
})

test('the tool picker offers only flat and ball end mills, at their physical size', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  // An inch-authored ball cutter in an mm project: its detail must show the
  // real 6.35 mm, never the raw 0.25.
  await seedTools(page, [
    { ...defaultTool('inch', 1), id: 't-inch-ball', name: 'Inch Ball', type: 'ball_endmill', diameter: 0.25 },
    { ...defaultTool('mm', 2), id: 't-v', name: 'V-bit 60', type: 'v_bit', vBitAngle: 60, diameter: 6 },
  ])
  await switchToAround(page)

  await ui.rotarySolid.polygonButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  await ui.rotarySolid.toolTrigger(page).click()
  // Only the ball end mill is offered; the V-bit is not a rotary cutter.
  await expect(ui.rotarySolid.dialog(page).getByRole('option')).toHaveCount(1)
  await expect(ui.rotarySolid.toolOption(page, 'Inch Ball')).toBeVisible()
  await expect(ui.rotarySolid.tool(page).locator('.ui-select__option-detail')).toHaveText('Ø6.35 mm')
  await ui.rotarySolid.toolOption(page, 'Inch Ball').click()
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()

  expect(await operationToolRefs(page)).toEqual(['t-inch-ball', 't-inch-ball'])
})

test('with no flat or ball end mill the dialog explains and creates nothing', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  await seedTools(page, [
    { ...defaultTool('mm', 2), id: 't-v', name: 'V-bit 60', type: 'v_bit', vBitAngle: 60, diameter: 6 },
  ])
  await switchToAround(page)
  const baseline = await solidSnapshot(page)

  await ui.rotarySolid.polygonButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  await expect(ui.rotarySolid.error(page)).toContainText('no flat or ball end mill')
  await expect(ui.rotarySolid.createButton(page)).toBeDisabled()
  await ui.rotarySolid.cancelButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })
})

test('the polygon inline bounds refuse bad input and Cancel creates nothing', async ({ app, ui }) => {
  const { page } = app
  const bar = await prepareMmRoundBarWithRotary(page)
  await seedFluteTools(page)
  await switchToAround(page)
  const baseline = await solidSnapshot(page)

  await ui.rotarySolid.polygonButton(page).click()
  // Across flats beyond the bar's across-corners ceiling: refused inline.
  const ceiling = bar.diameter * Math.cos(Math.PI / 6)
  await ui.rotarySolid.field(page, 'across-flats').fill(String(ceiling + 1))
  await expect(ui.rotarySolid.error(page)).toContainText('Across flats cannot exceed')
  await expect(ui.rotarySolid.createButton(page)).toBeDisabled()

  // Sides outside 3..64 are refused inline.
  await ui.rotarySolid.field(page, 'across-flats').fill('10')
  await ui.rotarySolid.field(page, 'sides').fill('2')
  await expect(ui.rotarySolid.error(page)).toContainText('whole number')
  await expect(ui.rotarySolid.createButton(page)).toBeDisabled()

  // A start and length beyond the bar are refused inline.
  await ui.rotarySolid.field(page, 'sides').fill('6')
  await ui.rotarySolid.field(page, 'start').fill('100')
  await ui.rotarySolid.field(page, 'length').fill('40')
  await expect(ui.rotarySolid.error(page)).toContainText('fit inside the bar')
  await expect(ui.rotarySolid.createButton(page)).toBeDisabled()

  // None of it touched the project.
  expect((await solidSnapshot(page)).historyPast).toBe(baseline.historyPast)
  await ui.rotarySolid.cancelButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })
})

test('turning the stock or leaving Around while a solid dialog is open creates nothing', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  await seedFluteTools(page)
  await switchToAround(page)
  const baseline = await solidSnapshot(page)

  // Round → square while the polygon form is open: the form closes with the
  // entry it belongs to and nothing is posted.
  await ui.rotarySolid.polygonButton(page).click()
  await ui.rotarySolid.field(page, 'length').fill('10')
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  await page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('/src/store/projectStore')
    useProjectStore.getState().setStockShape('square')
  })
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  await expect(ui.rotarySolid.squareToRoundButton(page)).toBeVisible()
  const afterFlip = await solidSnapshot(page)

  // Leaving Around with the square-to-round form open closes it; returning
  // mounts a fresh, closed one and never resurrects the stale request.
  await ui.rotarySolid.squareToRoundButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  await ui.rotarySolid.field(page, 'length').fill('10')
  await switchToTop(page)
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  await switchToAround(page)
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: afterFlip.folderCount,
    featureCount: afterFlip.featureCount,
    operationCount: afterFlip.operationCount,
    historyPast: afterFlip.historyPast,
  })
  expect(afterFlip.featureCount).toBe(baseline.featureCount)
})

test('square to round creates the finished round target inside the real blank', async ({ app, ui }) => {
  const { page } = app
  const blank = await prepareMmSquareBlankWithRotary(page)
  await switchToAround(page)
  const baseline = await solidSnapshot(page)
  await expect(ui.rotarySolid.squareToRoundButton(page)).toBeVisible()
  await expect(ui.rotarySolid.polygonButton(page)).toHaveCount(0)

  await ui.rotarySolid.squareToRoundButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  // The finished diameter defaults to the blank side, and beyond it is refused.
  await expect(ui.rotarySolid.field(page, 'diameter')).toHaveValue(String(blank.side))
  await ui.rotarySolid.field(page, 'diameter').fill(String(blank.side + 1))
  await expect(ui.rotarySolid.error(page)).toContainText('cannot exceed the blank side')
  await expect(ui.rotarySolid.createButton(page)).toBeDisabled()

  await ui.rotarySolid.field(page, 'diameter').fill('20')
  await ui.rotarySolid.field(page, 'start').fill('10')
  await ui.rotarySolid.field(page, 'length').fill('30')
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()

  const snapshot = await solidSnapshot(page)
  expect(snapshot.folderName).toContain('Square to round')
  expect(snapshot.featureCount).toBe(baseline.featureCount + 1)
  expect(snapshot.operationCount).toBe(baseline.operationCount + 2)
  expect(snapshot.operationKinds).toEqual(['rotary_rough', 'rotary_finish'])
  expect(snapshot.historyPast).toBe(baseline.historyPast + 1)
  const bounds = snapshot.modelBounds[0]!
  expect(bounds.minX).toBeCloseTo(10, 3)
  expect(bounds.maxX).toBeCloseTo(40, 3)
  // The finished target is the requested cylinder on the blank's own pivot.
  expect(bounds.maxY - bounds.minY).toBeCloseTo(20, 1)
  expect((bounds.minY + bounds.maxY) / 2).toBeCloseTo(blank.side / 2, 1)
  // The real blank is untouched: still a square of side 25.
  const project = await getProject(page) as unknown as Project
  expect((project.stock as { shape?: string; thickness: number }).shape).toBe('square')
  expect((project.stock as { shape?: string; thickness: number }).thickness).toBeCloseTo(25, 6)
})

// ── C2-U2F: review corrections (#1016) ───────────────────────────────
//
// Seven findings from the independent UI review, each pinned to behaviour the
// user can reach: a form must never survive a change to the physical context it
// was measured against, its defaults must be the stock's real numbers, the
// workflow must not be offered where the store refuses it, and a stale refusal
// must not outlive the request it described.

test('a solid form is dropped when the bar, units, document or face behind it change', async ({ app, ui }) => {
  test.setTimeout(120_000)
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  await seedFluteTools(page)
  await switchToAround(page)
  const baseline = await solidSnapshot(page)

  // ── face change ──
  // Leaving Around unmounts the entry and the dialog; coming back must not
  // resurrect a form whose numbers were typed on the same bar but a different
  // face of the workflow.
  await ui.rotarySolid.polygonButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  await ui.rotarySolid.field(page, 'length').fill('9')
  await switchToTop(page)
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  await switchToAround(page)
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })

  // ── units conversion ──
  // The old numbers were millimetres; after the conversion the same text would
  // be inches, so the form must open again with the converted default instead.
  await ui.rotarySolid.polygonButton(page).click()
  await ui.rotarySolid.field(page, 'length').fill('7')
  await convertUnits(page, 'inch')
  const afterUnits = await solidSnapshot(page)
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: afterUnits.folderCount,
    featureCount: afterUnits.featureCount,
    operationCount: afterUnits.operationCount,
    historyPast: afterUnits.historyPast,
  })
  expect(afterUnits.folderCount).toBe(baseline.folderCount)
  const inchBar = await liveBar(page)
  expect(inchBar.units).toBe('inch')
  await ui.rotarySolid.polygonButton(page).click()
  await expect(ui.rotarySolid.field(page, 'length')).toHaveValue(String(inchBar.length))
  await expect(ui.rotarySolid.field(page, 'length')).not.toHaveValue('7')
  await expect(ui.rotarySolid.field(page, 'across-flats')).toHaveValue(String(inchBar.thickness * 0.75))
  await expect(ui.rotarySolid.error(page)).toHaveCount(0)
  await ui.rotarySolid.cancelButton(page).click()

  // ── same-shaped document replacement ──
  // A load increments the store's document session even when the new file has
  // the same bar, so the request belongs to the replaced project, not this one.
  const replaced = await getProject(page)
  await ui.rotarySolid.polygonButton(page).click()
  await ui.rotarySolid.field(page, 'length').fill('2')
  await seedProject(page, JSON.stringify({
    ...replaced,
    meta: { ...(replaced.meta as Record<string, unknown>), name: 'Another inch bar' },
  }))
  const afterLoad = await solidSnapshot(page)
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: afterLoad.folderCount,
    featureCount: afterLoad.featureCount,
    operationCount: afterLoad.operationCount,
    historyPast: afterLoad.historyPast,
  })
  // A saved file carries the workspace on a real setup, not the provisional
  // Around the form was opened on, so the Around job is re-entered as well.
  await switchToAround(page)
  await expect(ui.rotarySolid.polygonButton(page)).toBeVisible()
  await ui.rotarySolid.polygonButton(page).click()
  await expect(ui.rotarySolid.field(page, 'length')).toHaveValue(String(inchBar.length))
  await expect(ui.rotarySolid.field(page, 'length')).not.toHaveValue('2')
  await ui.rotarySolid.cancelButton(page).click()

  // ── bar axis and diameter ──
  await convertUnits(page, 'mm')
  await ui.rotarySolid.polygonButton(page).click()
  await ui.rotarySolid.field(page, 'length').fill('5')
  await editRoundBar(page, { axis: 'y' })
  const afterAxis = await solidSnapshot(page)
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: afterAxis.folderCount,
    featureCount: afterAxis.featureCount,
    operationCount: afterAxis.operationCount,
    historyPast: afterAxis.historyPast,
  })
  await ui.rotarySolid.polygonButton(page).click()
  const reaimed = await liveBar(page)
  expect(reaimed.axis).toBe('y')
  await expect(ui.rotarySolid.field(page, 'length')).toHaveValue(String(reaimed.length))
  await expect(ui.rotarySolid.field(page, 'length')).not.toHaveValue('5')
  await ui.rotarySolid.cancelButton(page).click()
  await editRoundBar(page, { axis: 'x' })

  await ui.rotarySolid.polygonButton(page).click()
  await ui.rotarySolid.field(page, 'length').fill('5')
  await editRoundBar(page, { diameter: 30 })
  const afterDiameter = await solidSnapshot(page)
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: afterDiameter.folderCount,
    featureCount: afterDiameter.featureCount,
    operationCount: afterDiameter.operationCount,
    historyPast: afterDiameter.historyPast,
  })
  await ui.rotarySolid.polygonButton(page).click()
  const resizedBar = await liveBar(page)
  expect(resizedBar.thickness).toBeCloseTo(30, 6)
  await expect(ui.rotarySolid.field(page, 'across-flats')).toHaveValue(String(resizedBar.thickness * 0.75))
  await expect(ui.rotarySolid.field(page, 'length')).toHaveValue(String(resizedBar.length))
  await ui.rotarySolid.cancelButton(page).click()

  // ── bar length and machine origin ──
  // The endpoints are mapped from the bar's live box and the record carries
  // the machine origin, so either one changing invalidates the request too.
  await ui.rotarySolid.polygonButton(page).click()
  await ui.rotarySolid.field(page, 'length').fill('4')
  await editRoundBar(page, { length: 100 })
  const afterLength = await solidSnapshot(page)
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: afterLength.folderCount,
    featureCount: afterLength.featureCount,
    operationCount: afterLength.operationCount,
    historyPast: afterLength.historyPast,
  })
  await ui.rotarySolid.polygonButton(page).click()
  const shortened = await liveBar(page)
  expect(shortened.length).toBeCloseTo(100, 6)
  await expect(ui.rotarySolid.field(page, 'length')).toHaveValue(String(shortened.length))
  await expect(ui.rotarySolid.field(page, 'length')).not.toHaveValue('4')
  await ui.rotarySolid.cancelButton(page).click()

  await ui.rotarySolid.polygonButton(page).click()
  await ui.rotarySolid.field(page, 'length').fill('4')
  await page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const state = useProjectStore.getState()
    state.setOrigin({ ...state.project.origin, x: state.project.origin.x + 5 })
  })
  const afterOrigin = await solidSnapshot(page)
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: afterOrigin.folderCount,
    featureCount: afterOrigin.featureCount,
    operationCount: afterOrigin.operationCount,
    historyPast: afterOrigin.historyPast,
  })
  await ui.rotarySolid.polygonButton(page).click()
  await expect(ui.rotarySolid.field(page, 'length')).not.toHaveValue('4')
  await ui.rotarySolid.cancelButton(page).click()

  // ── the square form follows the same rule ──
  await prepareMmSquareBlankWithRotary(page)
  await switchToAround(page)
  const squareBaseline = await solidSnapshot(page)
  await ui.rotarySolid.squareToRoundButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  await ui.rotarySolid.field(page, 'length').fill('5')
  await editSquareSide(page, 30)
  const afterSide = await solidSnapshot(page)
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: afterSide.folderCount,
    featureCount: afterSide.featureCount,
    operationCount: afterSide.operationCount,
    historyPast: afterSide.historyPast,
  })
  expect(afterSide.folderCount).toBe(squareBaseline.folderCount)
  await ui.rotarySolid.squareToRoundButton(page).click()
  await expect(ui.rotarySolid.field(page, 'diameter')).toHaveValue('30')
  await expect(ui.rotarySolid.field(page, 'length')).toHaveValue('120')
  await expect(ui.rotarySolid.field(page, 'length')).not.toHaveValue('5')
  await expect(ui.rotarySolid.error(page)).toHaveCount(0)
  await ui.rotarySolid.cancelButton(page).click()
})

test('awkward stock dimensions keep an exact default and still create', async ({ app, ui }) => {
  test.setTimeout(180_000)
  const { page } = app

  /** Seed one rotary bar project, the way the other C2 fixtures do. */
  const seedBar = async (
    units: 'mm' | 'inch',
    stock: ReturnType<typeof roundStock> | ReturnType<typeof squareStock>,
  ): Promise<void> => {
    const base = newProject(`awkward ${units}`, units)
    base.stock = stock
    base.meta.projectType = 'rotary'
    base.meta.machineDefinitions = [ROTARY_MACHINE]
    base.meta.selectedMachineId = 'grbl'
    base.tools = [{ ...defaultTool(units, 1), id: 't-flat', name: 'Flat 6', type: 'flat_endmill', diameter: units === 'mm' ? 6 : 0.25 }]
    await seedProject(page, JSON.stringify(base))
    await switchToAround(page)
  }

  // ── millimetres ──
  // Diameter 20.00006, length 23.70006. Four-decimal rounding made the length
  // default 23.7001, past the bar's own end, so the form opened refusing its
  // own default and Create could never be pressed.
  const mmBar = roundStock(20.00006, 23.70006, 'x')
  await seedBar('mm', mmBar)
  await ui.rotarySolid.polygonButton(page).click()
  await expect(ui.rotarySolid.field(page, 'length')).toHaveValue(String(23.70006))
  await expect(ui.rotarySolid.field(page, 'across-flats')).toHaveValue(String(20.00006 * 0.75))
  await expect(ui.rotarySolid.error(page)).toHaveCount(0)
  await expect(ui.rotarySolid.createButton(page)).toBeEnabled()
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()
  const mmCreated = (await solidSnapshot(page)).modelBounds[0]!
  expect(mmCreated.maxX - mmCreated.minX).toBeCloseTo(23.70006, 3)
  expect(mmCreated.maxZ - mmCreated.minZ).toBeCloseTo(20.00006 * 0.75, 3)

  // ── inches ──
  // The same failure in inch units: 4.70006 rounds to 4.7001.
  const inchBar = roundStock(0.80001, 4.70006, 'x')
  await seedBar('inch', inchBar)
  await ui.rotarySolid.polygonButton(page).click()
  await expect(ui.rotarySolid.field(page, 'length')).toHaveValue(String(4.70006))
  await expect(ui.rotarySolid.field(page, 'across-flats')).toHaveValue(String(0.80001 * 0.75))
  await expect(ui.rotarySolid.error(page)).toHaveCount(0)
  await expect(ui.rotarySolid.createButton(page)).toBeEnabled()
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()
  const inchCreated = (await solidSnapshot(page)).modelBounds[0]!
  expect(inchCreated.maxX - inchCreated.minX).toBeCloseTo(4.70006, 4)

  // ── the square form's finished-diameter default ──
  // A 20.00006 side would have defaulted to 20.0001, past the side it may not
  // exceed, so the square-to-round form also opened disabled.
  const blank = squareStock(20.00006, 23.70006, 'x')
  await seedBar('mm', blank)
  await ui.rotarySolid.squareToRoundButton(page).click()
  await expect(ui.rotarySolid.field(page, 'diameter')).toHaveValue(String(20.00006))
  await expect(ui.rotarySolid.field(page, 'length')).toHaveValue(String(23.70006))
  await expect(ui.rotarySolid.error(page)).toHaveCount(0)
  await expect(ui.rotarySolid.createButton(page)).toBeEnabled()
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()
  const squareCreated = (await solidSnapshot(page)).modelBounds[0]!
  expect(squareCreated.maxX - squareCreated.minX).toBeCloseTo(23.70006, 3)
  expect(squareCreated.maxY - squareCreated.minY).toBeCloseTo(20.00006, 3)
})

test('a loaded non-rotary file offers no Around solid, and restoring the type brings it back', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  await seedFluteTools(page)
  await switchToAround(page)
  const baseline = await solidSnapshot(page)
  // A saved file never stores the provisional Around id, so the fixture that a
  // loaded file can actually contain has a real Around setup and that setup
  // active — the state the review found the command appearing in.
  const before = await getProject(page)
  const setups = before.setups as Array<Record<string, unknown>>
  const aroundProject = {
    ...before,
    setups: [...setups, { ...setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 } }],
    activeSetupId: 'around',
  }
  const asMilling = {
    ...aroundProject,
    meta: { ...(aroundProject.meta as Record<string, unknown>), projectType: 'milling' },
  }

  // A form open across the workflow change must not create anything or survive.
  await ui.rotarySolid.polygonButton(page).click()
  await ui.rotarySolid.field(page, 'length').fill('5')
  await seedProject(page, JSON.stringify(asMilling))
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
  // The loaded file retains its bar and its Around setup as the workspace face…
  expect(await activeFaceOf(page)).toBe('around')
  // …but the Around workflow is unavailable, so the command is absent instead
  // of offered and then refused by the store.
  await expect(ui.rotarySolid.polygonButton(page)).toHaveCount(0)
  await expect(ui.rotarySolid.squareToRoundButton(page)).toHaveCount(0)
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })

  // The same file opened with its rotary type restores the command, with a
  // fresh closed form — never the one that was open before the change.
  await seedProject(page, JSON.stringify(aroundProject))
  await expect(ui.rotarySolid.polygonButton(page)).toBeVisible()
  await expect(ui.rotarySolid.dialog(page)).toHaveCount(0)
})

test('a store refusal disappears when the request it described is corrected', async ({ app, ui }) => {
  const { page } = app
  await prepareMmRoundBarWithRotary(page)
  // A compatible cutter with no usable diameter: the picker offers it (policy
  // is the cutter family), and only the store knows it cannot seed an
  // operation. The form itself is valid, so Create is enabled.
  await seedTools(page, [
    {
      ...defaultTool('mm', 1), id: 't-broken', name: 'Broken flat', type: 'flat_endmill',
      diameter: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0,
    },
    {
      ...defaultTool('mm', 2), id: 't-good', name: 'Good flat', type: 'flat_endmill',
      diameter: 6, defaultFeed: 800, defaultPlungeFeed: 200, defaultStepdown: 2, defaultStepover: 3,
    },
  ])
  await switchToAround(page)
  const baseline = await solidSnapshot(page)

  await ui.rotarySolid.polygonButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  await expect(ui.rotarySolid.createButton(page)).toBeEnabled()
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.error(page)).toContainText('no usable diameter or feeds')
  // The refusal created nothing.
  expect(await solidSnapshot(page)).toMatchObject({
    folderCount: baseline.folderCount,
    featureCount: baseline.featureCount,
    operationCount: baseline.operationCount,
    historyPast: baseline.historyPast,
  })

  // Correcting an input clears the reason immediately: it described the
  // request as it was, not the form now on screen. Rotation is the field to
  // edit here: the length default is the whole bar, so moving the start would
  // push the band past the bar and raise the form's own range refusal — a
  // different, legitimate message.
  await ui.rotarySolid.field(page, 'rotation').fill('1')
  await expect(ui.rotarySolid.error(page)).toHaveCount(0)
  await expect(ui.rotarySolid.createButton(page)).toBeEnabled()

  // Choosing a usable cutter is the actual fix; the same form then creates.
  await ui.rotarySolid.toolTrigger(page).click()
  await ui.rotarySolid.toolOption(page, 'Good flat').click()
  await expect(ui.rotarySolid.error(page)).toHaveCount(0)
  await expect(ui.rotarySolid.createButton(page)).toBeEnabled()
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()
  const created = await solidSnapshot(page)
  expect(created.folderCount).toBe(baseline.folderCount + 1)
  expect(created.operationCount).toBe(baseline.operationCount + 2)
})

// ── Tablet geometry: the dialog must contain its own chrome ─────────────
//
// `toBeVisible()` and an element's own bounding box both pass for a control
// the dialog has clipped or pushed outside its frame: the box is reported in
// full while its pixels are cut off. These helpers compare the *complete*
// rectangle against the dialog and the viewport, then hit-test the centre and
// four points near the corners with `elementFromPoint`, so a control drawn
// outside its frame fails the test instead of passing on visibility alone.
//
// The header (title and close) and the footer actions are measured together
// from one frame snapshot and the footer is never scrolled into view first:
// `scrollIntoViewIfNeeded` on a clipped action can bring the whole frame into
// view and hide the regression (issue #1016 C1 correction, slice D2). Only a
// field or picker trigger inside the body may scroll, because the body is the
// one place scrolling is legitimate.

interface Box {
  x: number
  y: number
  width: number
  height: number
}

function inside(inner: Box, outer: Box, slack = 1): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  )
}

/** The centre and four points near the corners are all actually the element. */
async function expectUnoccluded(locator: Locator, label: string): Promise<void> {
  const missed = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const across = [0.5, 0.15, 0.85, 0.15, 0.85]
    const down = [0.5, 0.15, 0.15, 0.85, 0.85]
    const names = ['centre', 'top-left', 'top-right', 'bottom-left', 'bottom-right']
    const missedAt: string[] = []
    names.forEach((name, index) => {
      const top = document.elementFromPoint(
        rect.left + rect.width * across[index],
        rect.top + rect.height * down[index],
      )
      if (top === null || !(element === top || element.contains(top))) missedAt.push(name)
    })
    return missedAt
  })
  expect(missed, `${label} is unoccluded at its centre and corners`).toEqual([])
}

/**
 * The complete rectangle is inside the dialog and the viewport, and the
 * control's own pixels are on top. `scroll` is set only for a field or picker
 * trigger that legitimately lives in the scrolling body.
 */
async function expectComplete(
  page: Page,
  locator: Locator,
  dialog: Locator,
  label: string,
  options?: { scroll?: boolean },
): Promise<Box> {
  // A field below the fold is scrolled into the body first; the box asserted is
  // then the one the user sees, not an off-screen layout position.
  if (options?.scroll) await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  expect(box, `${label} has a layout box`).not.toBeNull()
  const frame = await dialog.boundingBox()
  expect(frame, 'the dialog has a layout box').not.toBeNull()
  const viewport = page.viewportSize()
  expect(viewport, 'the test has a viewport').not.toBeNull()
  expect(inside(box!, frame!), `${label} is complete inside the dialog`).toBe(true)
  expect(
    inside(box!, { x: 0, y: 0, width: viewport!.width, height: viewport!.height }),
    `${label} is complete inside the viewport`,
  ).toBe(true)
  await expectUnoccluded(locator, label)
  return box!
}

interface ChromeControl {
  label: string
  locator: Locator
}

interface ChromeSnapshot {
  frame: Box
  controls: Array<{ label: string; box: Box }>
}

/** The header, the title, the close button and both footer actions. */
function dialogChrome(dialog: Locator, cancel: Locator, create: Locator): ChromeControl[] {
  return [
    { label: 'header', locator: dialog.locator('.dialog-header') },
    { label: 'title', locator: dialog.locator('.dialog-title') },
    { label: 'close', locator: dialog.locator('.dialog-close') },
    { label: 'Cancel', locator: cancel },
    { label: 'Create', locator: create },
  ]
}

/**
 * Measure the header and the footer actions from one frame snapshot without
 * scrolling anything: either all of them are complete at the same time or the
 * dialog has failed to contain its own chrome.
 */
async function expectChromeComplete(
  page: Page,
  dialog: Locator,
  controls: ChromeControl[],
  label: string,
): Promise<ChromeSnapshot> {
  const frame = await dialog.boundingBox()
  expect(frame, `${label} dialog has a layout box`).not.toBeNull()
  const viewport = page.viewportSize()
  expect(viewport, 'the test has a viewport').not.toBeNull()
  const screen = { x: 0, y: 0, width: viewport!.width, height: viewport!.height }
  expect(inside(frame!, screen), `${label} dialog is complete inside the viewport`).toBe(true)

  const measured: Array<{ label: string; box: Box }> = []
  for (const control of controls) {
    const box = await control.locator.boundingBox()
    expect(box, `${label} ${control.label} has a layout box`).not.toBeNull()
    expect(inside(box!, frame!), `${label} ${control.label} is complete inside the dialog`).toBe(true)
    expect(inside(box!, screen), `${label} ${control.label} is complete inside the viewport`).toBe(true)
    measured.push({ label: control.label, box: box! })
  }
  for (const control of controls) await expectUnoccluded(control.locator, `${label} ${control.label}`)
  return { frame: frame!, controls: measured }
}

/** Two chrome snapshots agree: nothing moved while the body scrolled. */
function expectChromeUnchanged(before: ChromeSnapshot, after: ChromeSnapshot, label: string): void {
  const moved = (first: Box, second: Box): boolean =>
    Math.abs(first.x - second.x) > 1 ||
    Math.abs(first.y - second.y) > 1 ||
    Math.abs(first.width - second.width) > 1 ||
    Math.abs(first.height - second.height) > 1
  expect(moved(before.frame, after.frame), `${label} frame stays put`).toBe(false)
  before.controls.forEach((control, index) => {
    expect(moved(control.box, after.controls[index].box), `${label} ${control.label} stays put`).toBe(false)
  })
}

/** The header ends above the body, the body above the footer, all inside the frame. */
async function expectDialogStacked(dialog: Locator, label: string): Promise<void> {
  const frame = await dialog.boundingBox()
  const header = await dialog.locator('.dialog-header').boundingBox()
  const body = await dialog.locator('.dialog-body').boundingBox()
  const footer = await dialog.locator('.dialog-footer').boundingBox()
  expect(
    frame !== null && header !== null && body !== null && footer !== null,
    `${label} lays out header, body and footer`,
  ).toBe(true)
  expect(inside(header!, frame!), `${label} header is inside the dialog`).toBe(true)
  expect(inside(body!, frame!), `${label} body is inside the dialog`).toBe(true)
  expect(inside(footer!, frame!), `${label} footer is inside the dialog`).toBe(true)
  expect(header!.y + header!.height, `${label} header ends above the body`).toBeLessThanOrEqual(body!.y + 1)
  expect(body!.y + body!.height, `${label} body ends above the footer`).toBeLessThanOrEqual(footer!.y + 1)
}

interface BodyScroll {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  frameScrollTop: number
}

async function readBodyScroll(dialog: Locator): Promise<BodyScroll> {
  return dialog.evaluate((element) => {
    const body = element.querySelector('.dialog-body') as HTMLElement | null
    if (body === null) throw new Error('the dialog has a body')
    return {
      scrollTop: body.scrollTop,
      clientHeight: body.clientHeight,
      scrollHeight: body.scrollHeight,
      frameScrollTop: (element as HTMLElement).scrollTop,
    }
  })
}

/**
 * The body owns the scroll: the frame's own offset stays at zero while the
 * form scrolls inside it, and the header and the footer keep the exact
 * rectangles they had when the dialog opened. The dialog frame must never be
 * the scroller, or scrolling for a field would carry the header away.
 */
async function expectBodyOwnsScroll(
  page: Page,
  dialog: Locator,
  controls: ChromeControl[],
  baseline: ChromeSnapshot,
  label: string,
  options: { requireOverflow: boolean },
): Promise<void> {
  await dialog.evaluate((element) => {
    const body = element.querySelector('.dialog-body') as HTMLElement | null
    if (body !== null) body.scrollTop = 0
  })
  const before = await readBodyScroll(dialog)
  expect(before.frameScrollTop, `${label} dialog frame is not the scroller`).toBe(0)
  expect(before.scrollTop, `${label} body starts at the top`).toBe(0)
  const overflows = before.scrollHeight > before.clientHeight
  if (options.requireOverflow) expect(overflows, `${label} body is taller than its viewport`).toBe(true)

  await dialog.evaluate((element) => {
    const body = element.querySelector('.dialog-body') as HTMLElement | null
    if (body !== null) body.scrollTop = body.scrollHeight
  })
  const after = await readBodyScroll(dialog)
  expect(after.frameScrollTop, `${label} frame stays at scrollTop 0`).toBe(0)
  if (overflows) {
    expect(after.scrollTop, `${label} body owns the scroll`).toBeGreaterThan(0)
  } else {
    expect(after.scrollTop, `${label} a body that fits does not scroll`).toBe(0)
  }

  const chrome = await expectChromeComplete(page, dialog, controls, `${label} scrolled`)
  expectChromeUnchanged(baseline, chrome, `${label} scrolled`)
}

/**
 * Open a shared Select and prove the trigger (which may legitimately be
 * scrolled into the body) and the open list are both complete inside the
 * dialog. The list is never scrolled into view: a list the dialog cannot show
 * in place must fail instead of being rescued.
 */
async function expectPickerComplete(
  page: Page,
  dialog: Locator,
  trigger: Locator,
  option: Locator,
  chosen: string,
  label: string,
): Promise<void> {
  await expectComplete(page, trigger, dialog, `${label} trigger`, { scroll: true })
  await trigger.click()
  await expect(option).toBeVisible()
  await expectComplete(page, option, dialog, `${label} option`)
  await option.click()
  await expect(trigger).toContainText(chosen)
}

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

    // The whole frame and the header plus both actions are complete at once,
    // with nothing scrolled into view to hide a footer the frame has pushed
    // out (issue #1016 C1 correction, slice D2).
    const chrome = await expectChromeComplete(
      page,
      dialog,
      dialogChrome(dialog, ui.rotary.cancelButton(page), ui.rotary.createButton(page)),
      'thread',
    )
    expect(chrome.frame.y, 'the dialog frame starts on screen').toBeGreaterThanOrEqual(0)
    expect(chrome.frame.y + chrome.frame.height, 'the dialog frame ends on screen').toBeLessThanOrEqual(820)

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    // Closing returns focus to the canvas.
    const canvasFocused = await page.evaluate(() => document.activeElement?.classList.contains('sketch-canvas') ?? false)
    expect(canvasFocused).toBe(true)
  })

  test('both dialogs keep every action and picker complete inside the dialog', async ({ app, ui }) => {
    const { page } = app
    await prepareMmRoundBarWithRotary(page)
    await seedFluteTools(page)
    await switchToAround(page)

    for (const kind of ['thread', 'flutes'] as const) {
      await rotaryEntry(page, ui, kind).click()
      const dialog = ui.rotary.dialog(page)
      await expect(dialog).toBeVisible()

      // Fresh open: the header and the actions are complete at once and none of
      // them is scrolled into view first. A clipped footer cannot pass by being
      // brought into view.
      const controls = dialogChrome(dialog, ui.rotary.cancelButton(page), ui.rotary.createButton(page))
      const fresh = await expectChromeComplete(page, dialog, controls, `${kind} fresh`)
      await expectDialogStacked(dialog, kind)

      // A field or picker may scroll the body; the frame, header and footer may
      // not move, and the open list must sit inside the dialog unaided.
      await expectPickerComplete(
        page,
        dialog,
        ui.rotary.directionTrigger(page),
        ui.rotary.directionOption(page, 'Left-hand'),
        'Left-hand',
        `${kind} Direction`,
      )
      if (kind === 'flutes') {
        await expectPickerComplete(
          page,
          dialog,
          ui.rotary.toolTrigger(page),
          ui.rotary.toolOption(page, 'Ball 3'),
          'Ball 3',
          `${kind} Tool`,
        )
      }
      const afterPickers = await expectChromeComplete(page, dialog, controls, `${kind} after pickers`)
      expectChromeUnchanged(fresh, afterPickers, `${kind} after pickers`)

      // Scrolling the body leaves the header and the footer where they were;
      // where the body is taller than its viewport it, not the frame, scrolls.
      await expectBodyOwnsScroll(page, dialog, controls, fresh, kind, { requireOverflow: false })

      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    }
  })

  test('a Left flute created from the tablet dialog reverses the hand and undoes in one step', async ({ app, ui }) => {
    const { page } = app
    await prepareMmRoundBarWithRotary(page)
    await seedFluteTools(page)
    await switchToAround(page)
    const baseline = await rotarySnapshot(page)

    await ui.rotary.flutesButton(page).click()
    const dialog = ui.rotary.dialog(page)
    await expect(dialog).toBeVisible()
    await ui.rotary.field(page, 'length').fill('30')
    await ui.rotary.field(page, 'count').fill('2')
    await ui.rotary.field(page, 'twist').fill('2')
    await ui.rotary.field(page, 'depth').fill('1')

    await expectPickerComplete(page, dialog, ui.rotary.toolTrigger(page), ui.rotary.toolOption(page, 'Ball 3'), 'Ball 3', 'Flutes Tool')
    await expectPickerComplete(
      page,
      dialog,
      ui.rotary.directionTrigger(page),
      ui.rotary.directionOption(page, 'Left-hand'),
      'Left-hand',
      'Flutes Direction',
    )
    await expectChromeComplete(
      page,
      dialog,
      dialogChrome(dialog, ui.rotary.cancelButton(page), ui.rotary.createButton(page)),
      'Flutes Create',
    )
    await ui.rotary.createButton(page).click()
    await expect(dialog).toBeHidden()

    const geometry = await rotaryLineGeometry(page)
    expect(geometry.lineCount).toBe(2)
    expect(geometry.acrossPerLine.every((across) => across < 0)).toBe(true)
    expect((await rotarySnapshot(page)).operationToolRef).toBe('t-ball')

    await undo(page)
    expect(await rotarySnapshot(page)).toMatchObject({
      folderCount: baseline.folderCount,
      featureCount: baseline.featureCount,
      operationCount: baseline.operationCount,
      historyPast: baseline.historyPast,
    })
  })
})

test.describe('tablet Thread and Flutes on a short viewport', () => {
  // At this height the form is taller than the body, so the body must scroll
  // while the header and the footer actions stay put.
  test.use({ viewport: { width: 1180, height: 600 }, hasTouch: true })

  test('both dialogs keep their actions and pickers reachable while the body scrolls', async ({ app, ui }) => {
    const { page } = app
    await prepareMmRoundBarWithRotary(page)
    await seedFluteTools(page)
    await switchToAround(page)

    for (const kind of ['thread', 'flutes'] as const) {
      await rotaryEntry(page, ui, kind).click()
      const dialog = ui.rotary.dialog(page)
      await expect(dialog).toBeVisible()

      // Fresh open: the header and the actions are complete at once and none of
      // them is scrolled into view first, at the height where the frame has the
      // least room to spare (issue #1016 C1 correction, slice D2).
      const controls = dialogChrome(dialog, ui.rotary.cancelButton(page), ui.rotary.createButton(page))
      const fresh = await expectChromeComplete(page, dialog, controls, `${kind} fresh`)
      await expectDialogStacked(dialog, kind)

      // The form really is taller than the body at this height, so the test is
      // exercising the scroll path and not a form that happens to fit.
      const metrics = await readBodyScroll(dialog)
      expect(metrics.scrollHeight, `${kind} body scrolls on a short viewport`).toBeGreaterThan(metrics.clientHeight)

      await expectPickerComplete(
        page,
        dialog,
        ui.rotary.directionTrigger(page),
        ui.rotary.directionOption(page, 'Left-hand'),
        'Left-hand',
        `${kind} Direction`,
      )
      if (kind === 'flutes') {
        await expectPickerComplete(
          page,
          dialog,
          ui.rotary.toolTrigger(page),
          ui.rotary.toolOption(page, 'Ball 3'),
          'Ball 3',
          `${kind} Tool`,
        )
      }
      const afterPickers = await expectChromeComplete(page, dialog, controls, `${kind} after pickers`)
      expectChromeUnchanged(fresh, afterPickers, `${kind} after pickers`)

      // Even with the form taller than the body, the body owns the scroll and
      // the header and the footer keep the rectangles they opened with.
      await expectBodyOwnsScroll(page, dialog, controls, fresh, kind, { requireOverflow: true })

      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    }
  })
})


/** True when the focused element matches `selector` and sits inside the solid dialog. */
async function solidDialogHasFocus(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const active = document.activeElement
    return active instanceof HTMLElement
      && active.matches(sel)
      && active.closest('.rotary-solid-dialog') !== null
  }, selector)
}

test.describe('tablet solid dialogs', () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true })

  test('both solid dialogs keep their actions complete and their picker inside', async ({ app, ui }) => {
    const { page } = app
    await prepareMmRoundBarWithRotary(page)
    await seedFluteTools(page)
    await switchToAround(page)

    // Polygon, on a round bar: the C1 frame contains its own chrome, and the
    // tool list opens inside the dialog unaided.
    await ui.rotarySolid.polygonButton(page).click()
    const dialog = ui.rotarySolid.dialog(page)
    await expect(dialog).toBeVisible()
    const controls = dialogChrome(dialog, ui.rotarySolid.cancelButton(page), ui.rotarySolid.createButton(page))
    const fresh = await expectChromeComplete(page, dialog, controls, 'polygon fresh')
    await expectDialogStacked(dialog, 'polygon')
    await expectPickerComplete(
      page,
      dialog,
      ui.rotarySolid.toolTrigger(page),
      ui.rotarySolid.toolOption(page, 'Ball 3'),
      'Ball 3',
      'Polygon Tool',
    )
    const afterPicker = await expectChromeComplete(page, dialog, controls, 'polygon after picker')
    expectChromeUnchanged(fresh, afterPicker, 'polygon after picker')
    await expectBodyOwnsScroll(page, dialog, controls, fresh, 'polygon', { requireOverflow: false })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // Square to round, on a real blank: the short form fits the same frame.
    await prepareMmSquareBlankWithRotary(page)
    await switchToAround(page)
    await ui.rotarySolid.squareToRoundButton(page).click()
    const square = ui.rotarySolid.dialog(page)
    await expect(square).toBeVisible()
    const squareControls = dialogChrome(square, ui.rotarySolid.cancelButton(page), ui.rotarySolid.createButton(page))
    await expectChromeComplete(page, square, squareControls, 'square fresh')
    await expectDialogStacked(square, 'square')
    await page.keyboard.press('Escape')
    await expect(square).toBeHidden()
  })

  test('the solid dialog takes and traps keyboard focus, and Escape closes the picker first', async ({ app, ui }) => {
    const { page } = app
    await prepareMmRoundBarWithRotary(page)
    await seedFluteTools(page)
    await switchToAround(page)

    await ui.rotarySolid.polygonButton(page).click()
    const dialog = ui.rotarySolid.dialog(page)
    await expect(dialog).toBeVisible()

    // Opening focuses the first field the user fills, inside the modal.
    await expect.poll(
      async () => solidDialogHasFocus(page, '#rotary-solid-start'),
      { message: 'Start takes focus on open' },
    ).toBe(true)

    // Tab from the last control wraps to the first instead of leaving the modal.
    await expect(ui.rotarySolid.createButton(page)).toBeEnabled()
    await ui.rotarySolid.createButton(page).focus()
    await page.keyboard.press('Tab')
    expect(await solidDialogHasFocus(page, '.dialog-close'), 'Tab wraps to the close button').toBe(true)
    // Shift+Tab wraps the other way.
    await page.keyboard.press('Shift+Tab')
    expect(await solidDialogHasFocus(page, '.rotary-dialog__create'), 'Shift+Tab wraps back to Create').toBe(true)

    // The picker owns the first Escape; the form owns the next one.
    await ui.rotarySolid.toolTrigger(page).click()
    await expect(ui.rotarySolid.toolOption(page, 'Ball 3')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(ui.rotarySolid.toolOption(page, 'Ball 3')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    // Closing returns focus to the canvas, the existing dialog contract.
    await expect.poll(
      async () => page.evaluate(() => document.activeElement?.classList.contains('sketch-canvas') ?? false),
      { message: 'the canvas regains focus' },
    ).toBe(true)
  })
})

test.describe('tablet solid dialogs on a short viewport', () => {
  // At this height the polygon form is taller than the body, so the body must
  // scroll while the header and the footer actions stay put — the C1 D2 rule
  // applied to the solid dialog (#1016 C2-U2).
  test.use({ viewport: { width: 1180, height: 600 }, hasTouch: true })

  test('the polygon form scrolls its body and keeps its actions reachable', async ({ app, ui }) => {
    const { page } = app
    await prepareMmRoundBarWithRotary(page)
    await seedFluteTools(page)
    await switchToAround(page)

    await ui.rotarySolid.polygonButton(page).click()
    const dialog = ui.rotarySolid.dialog(page)
    await expect(dialog).toBeVisible()
    const controls = dialogChrome(dialog, ui.rotarySolid.cancelButton(page), ui.rotarySolid.createButton(page))
    const fresh = await expectChromeComplete(page, dialog, controls, 'polygon short')
    await expectDialogStacked(dialog, 'polygon short')

    // Whether or not the form is taller than the body at this height, the body
    // is the only scroller and the header and footer keep their rectangles: a
    // form the frame cannot show must not push its actions out instead.
    await expectBodyOwnsScroll(page, dialog, controls, fresh, 'polygon short', { requireOverflow: false })

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})
