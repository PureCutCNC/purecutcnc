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
 * Plasma kerf preview smoke (issue #961, slice C): the 2D sketch draws a
 * translucent kerf band one torch-diameter wide under the existing centre line,
 * and opening the Simulation tab with a plasma operation selected is a working
 * WebGL view rather than a failure.
 *
 * The 2D probes are derived from the operation's own generated toolpath and the
 * view transform the canvas fits on load — never hard-coded canvas coordinates
 * — so a change to the fixture geometry or the fit keeps the test honest.
 */

import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  clickMenuItem,
  openRowContextMenu,
  rowByName,
  seedProject,
  selectMachine,
} from './helpers'

/**
 * The bundled definitions are the machines the picker offers, so the fixture's
 * selected machine is read from the same JSON the app ships.
 */
const QT_PLASMAC = JSON.parse(
  readFileSync(new URL('../src/engine/gcode/definitions/qtplasmac.json', import.meta.url), 'utf8'),
) as { name: string }

const PLASMA_OP = 'Plasma through-cut'
const TORCH_DIAMETER_MM = 3
const STOCK_WIDTH_MM = 80
const STOCK_HEIGHT_MM = 60
const FEATURE_X_MM = 25
const FEATURE_Y_MM = 20
const FEATURE_WIDTH_MM = 30
const FEATURE_HEIGHT_MM = 20

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

/**
 * A small mm project with a plasma machine absent, one torch and one closed
 * subtract, so the plasma cut is added the way a user adds it — and a kerf that
 * is many canvas pixels wide. A large stock would make the band sub-pixel and
 * the probe meaningless.
 */
function buildPlasmaKerfFixtureJson(): string {
  const now = '2026-01-01T00:00:00.000Z'
  return JSON.stringify({
    version: '3.0',
    meta: {
      name: 'Plasma Kerf Preview E2E Fixture',
      created: now,
      modified: now,
      units: 'mm',
      showFeatureInfo: true,
      showDimensions: true,
      copyMode: 'reference',
      maxTravelZ: 10,
      operationClearanceZ: 2,
      clampClearanceXY: 2,
      clampClearanceZ: 2,
      machineDefinitions: [],
      selectedMachineId: null,
    },
    grid: {
      extent: 200,
      majorSpacing: 10,
      minorSpacing: 1,
      snapEnabled: false,
      snapIncrement: 1,
      visible: true,
    },
    stock: {
      profile: resolvedRectProfile(0, 0, STOCK_WIDTH_MM, STOCK_HEIGHT_MM),
      thickness: 6,
      material: 'aluminum_6061',
      color: '#b9a83c',
      visible: true,
      origin: { x: 0, y: 0 },
    },
    // Hidden so the origin marker cannot sit under a probe pixel.
    origin: { name: 'Origin', x: STOCK_WIDTH_MM / 2, y: STOCK_HEIGHT_MM / 2, z: 6, visible: false },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {
      'def-kerf-target': {
        id: 'def-kerf-target',
        kind: 'rect',
        profile: resolvedRectProfile(0, 0, FEATURE_WIDTH_MM, FEATURE_HEIGHT_MM),
        dimensions: [],
        text: null,
        stl: null,
        operation: 'subtract',
      },
    },
    features: [
      {
        id: 'f-kerf-target',
        name: 'Kerf Target',
        definitionId: 'def-kerf-target',
        transform: { a: 1, b: 0, c: 0, d: 1, e: FEATURE_X_MM, f: FEATURE_Y_MM },
        constraints: [],
        folderId: null,
        z_top: 5,
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
        id: 'torch-1',
        name: 'Kerf Torch',
        units: 'mm',
        type: 'plasma',
        diameter: TORCH_DIAMETER_MM,
        pierceHeight: 3.8,
        cutHeight: 1.5,
        pierceDelay: 0.2,
        vBitAngle: null,
        flutes: 0,
        material: 'carbide',
        defaultRpm: 0,
        defaultFeed: 2200,
        defaultPlungeFeed: 300,
        defaultStepdown: 0,
        defaultStepover: 0,
        maxCutDepth: 0,
      },
    ],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  })
}

/** Seed the fixture, select the plasma machine and add the plasma cut on the closed feature. */
async function openPlasmaKerfProject(page: Page, ui: typeof import('./selectors')): Promise<void> {
  await seedProject(page, buildPlasmaKerfFixtureJson())
  await selectMachine(page, ui, QT_PLASMAC.name)

  const menu = await openRowContextMenu(page, rowByName(page, 'Kerf Target'))
  await ui.contextMenu.item(menu, 'Create operation').hover()
  await clickMenuItem(ui.contextMenu.submenu(page), 'Create plasma through-cut')

  const operation = ui.operations.rowByName(page, PLASMA_OP)
  await expect(operation).toBeVisible()
  await expect(operation).toHaveClass(/tree-row--selected/)
  // The panel only renders once a toolpath with moves exists, so this waits for
  // the plasma path the probe below reads.
  await expect(ui.toolpathVis.sketchPanel(page)).toBeVisible({ timeout: 30000 })
}

interface KerfProbes {
  /** Kerf width in project units — the torch diameter the band is stroked at. */
  width: number
  /** Canvas pixel inside the contour band, off the stroked centre line. */
  contour: { x: number; y: number }
  /** Canvas pixel on a lead move, clear of the contour band. */
  lead: { x: number; y: number }
  /** World-unit distance from the contour probe to the nearest cut move. */
  contourClearance: number
  /** World-unit distance from the lead probe to the nearest cut move. */
  leadClearance: number
}

/**
 * Derive probe pixels from the real toolpath and the fitted view.
 *
 * The canvas fits the project on load, and the toolbar's Zoom to model re-fits
 * it at the current size; `computeFitViewState` + `computeSketchViewTransform`
 * reproduce that exact transform, so the probes land on the drawn geometry.
 */
async function plasmaKerfProbes(sketch: Locator, page: Page): Promise<KerfProbes> {
  // Re-fit first so the transform is the fit at the canvas's current size,
  // independent of any earlier layout pass.
  await page.getByRole('button', { name: 'Zoom to model', exact: true }).click()
  await waitForPaint(page)

  return sketch.evaluate(async (canvas) => {
    const storeUrl = '/src/store/projectStore.ts'
    const previewUrl = '/src/components/plasmaKerfPreview.ts'
    const viewUrl = '/src/components/canvas/viewTransform.ts'
    const generateUrl = '/src/engine/toolpaths/generateOperation.ts'
    const { useProjectStore } = await import(storeUrl) as typeof import('../src/store/projectStore')
    const { plasmaKerfGeometry, plasmaKerfWidth } = await import(previewUrl) as typeof import('../src/components/plasmaKerfPreview')
    const { computeFitViewState, computeSketchViewTransform, worldToCanvas } = await import(viewUrl) as typeof import('../src/components/canvas/viewTransform')
    const { computeOperationToolpath } = await import(generateUrl) as typeof import('../src/engine/toolpaths/generateOperation')

    const project = useProjectStore.getState().project
    const operation = project.operations.find((candidate) => candidate.kind === 'plasma_profile')
    if (!operation) throw new Error('e2e: the project has no plasma operation')
    const width = plasmaKerfWidth(project, operation.id)
    if (width === null) throw new Error('e2e: the plasma operation has no usable torch width')
    const envelope = computeOperationToolpath(project, operation)
    if (!envelope) throw new Error('e2e: the plasma operation did not generate')
    const geometry = plasmaKerfGeometry(envelope.result)
    if (geometry.contour.length === 0) throw new Error('e2e: the plasma toolpath has no cut moves')
    if (geometry.leads.length === 0) throw new Error('e2e: the plasma toolpath has no lead moves')

    const element = canvas as HTMLCanvasElement
    const viewState = computeFitViewState(project, element.width, element.height)
    const vt = computeSketchViewTransform(project, element.width, element.height, viewState)

    type Point = { x: number; y: number }
    type Segment = { fromX: number; fromY: number; toX: number; toY: number }
    const segmentLength = (segment: Segment): number =>
      Math.hypot(segment.toX - segment.fromX, segment.toY - segment.fromY)
    const distanceToSegment = (point: Point, segment: Segment): number => {
      const dx = segment.toX - segment.fromX
      const dy = segment.toY - segment.fromY
      const squared = dx * dx + dy * dy
      const t = squared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - segment.fromX) * dx + (point.y - segment.fromY) * dy) / squared))
      return Math.hypot(point.x - (segment.fromX + t * dx), point.y - (segment.fromY + t * dy))
    }
    const contourClearance = (point: Point): number =>
      Math.min(...geometry.contour.map((segment) => distanceToSegment(point, segment)))

    // Contour probe: the longest cut move, pushed three tenths of the kerf off
    // its centre line — inside the band, clear of the stroked line and, on
    // whichever side it lands, a fifth of the kerf clear of the part outline.
    const longest = geometry.contour.reduce((best, segment) =>
      segmentLength(segment) > segmentLength(best) ? segment : best)
    const midX = (longest.fromX + longest.toX) / 2
    const midY = (longest.fromY + longest.toY) / 2
    const normalX = -(longest.toY - longest.fromY) / segmentLength(longest)
    const normalY = (longest.toX - longest.fromX) / segmentLength(longest)
    const centroid = geometry.contour.reduce(
      (acc, segment) => ({ x: acc.x + (segment.fromX + segment.toX) / 2, y: acc.y + (segment.fromY + segment.toY) / 2 }),
      { x: 0, y: 0 },
    )
    centroid.x /= geometry.contour.length
    centroid.y /= geometry.contour.length
    const outward = (midX - centroid.x) * normalX + (midY - centroid.y) * normalY >= 0 ? 1 : -1
    const contourWorld = {
      x: midX + normalX * outward * width * 0.3,
      y: midY + normalY * outward * width * 0.3,
    }

    // Lead probe: the lead sample farthest from every cut move, so the contour
    // band can never paint it. Sampling the middle of each lead move keeps it
    // off the lead's own ends.
    let leadWorld: Point = { x: geometry.leads[0].fromX, y: geometry.leads[0].fromY }
    let leadClearance = contourClearance(leadWorld)
    for (const lead of geometry.leads) {
      for (const t of [0.35, 0.5, 0.65]) {
        const sample = { x: lead.fromX + (lead.toX - lead.fromX) * t, y: lead.fromY + (lead.toY - lead.fromY) * t }
        const clearance = contourClearance(sample)
        if (clearance > leadClearance) {
          leadWorld = sample
          leadClearance = clearance
        }
      }
    }

    const contour = worldToCanvas(contourWorld, vt)
    const lead = worldToCanvas(leadWorld, vt)
    return {
      width,
      contour: { x: contour.cx, y: contour.cy },
      lead: { x: lead.cx, y: lead.cy },
      contourClearance: contourClearance(contourWorld),
      leadClearance,
    }
  })
}

/** Wait for the canvas to repaint after a toggle or view change. */
async function waitForPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

/** Read one canvas pixel, keeping the pointer off the canvas so no hover lands in it. */
async function samplePixel(sketch: Locator, page: Page, point: { x: number; y: number }): Promise<number[]> {
  await page.mouse.move(0, 0)
  await waitForPaint(page)
  return sketch.evaluate((canvas, probe) => {
    const element = canvas as HTMLCanvasElement
    const context = element.getContext('2d')
    if (!context) throw new Error('sketch canvas has no 2d context')
    const x = Math.max(0, Math.min(element.width - 1, Math.round(probe.x)))
    const y = Math.max(0, Math.min(element.height - 1, Math.round(probe.y)))
    return Array.from(context.getImageData(x, y, 1, 1).data)
  }, point)
}

/** Largest per-channel difference between two sampled pixels. */
function channelDelta(first: number[], second: number[]): number {
  return Math.max(...first.map((value, index) => Math.abs(value - second[index])))
}

/** A visibility toggle in the sketch panel, by its label. */
function layerToggle(page: Page, ui: typeof import('./selectors'), label: string): Locator {
  return ui.toolpathVis.sketchItems(page).filter({ hasText: label })
}

async function setLayer(page: Page, ui: typeof import('./selectors'), label: string, on: boolean): Promise<void> {
  const item = layerToggle(page, ui, label)
  await expect(item).toHaveCount(1)
  if ((await item.getAttribute('aria-pressed')) !== String(on)) {
    await item.click()
  }
  await expect(item).toHaveAttribute('aria-pressed', String(on))
}

test.describe('plasma kerf preview (#961)', () => {
  test('the sketch draws the kerf band under Cuts and hides the lead band with Lead-ins', async ({ app, ui }) => {
    const page = app.page
    await openPlasmaKerfProject(page, ui)

    const sketch = ui.canvas.sketch(page)
    const probes = await plasmaKerfProbes(sketch, page)

    // Self-check the probes before trusting them: the contour probe is inside
    // the one-kerf band, the lead probe is clear of it.
    expect(probes.contourClearance).toBeGreaterThan(0)
    expect(probes.contourClearance).toBeLessThan(probes.width / 2)
    expect(probes.leadClearance).toBeGreaterThan(probes.width * 0.75)

    // The initial all-layers-on pixels anchor the poll below: they prove a
    // repaint has actually happened, so a sample is never read from the
    // previous visibility state.
    const contourAllOn = await samplePixel(sketch, page, probes.contour)
    const leadAllOn = await samplePixel(sketch, page, probes.lead)

    // Baseline: every toolpath layer off, so the only thing that can move a
    // probe pixel is the plasma preview. Directions goes off with the three the
    // slice names, because the selected operation's arrowheads would otherwise
    // paint the contour centre line and pollute the comparison.
    for (const label of ['Cuts', 'Lead-ins', 'Plunges', 'Directions']) {
      await setLayer(page, ui, label, false)
    }
    let contourOff = contourAllOn
    await expect.poll(async () => {
      contourOff = await samplePixel(sketch, page, probes.contour)
      return channelDelta(contourOff, contourAllOn)
    }).toBeGreaterThan(12)
    let leadOff = leadAllOn
    await expect.poll(async () => {
      leadOff = await samplePixel(sketch, page, probes.lead)
      return channelDelta(leadOff, leadAllOn)
    }).toBeGreaterThan(12)

    // Cuts alone back on: the contour band returns under its centre line while
    // the lead band stays hidden and its probe pixel is untouched.
    await setLayer(page, ui, 'Cuts', true)
    let contourOn = contourOff
    await expect.poll(async () => {
      contourOn = await samplePixel(sketch, page, probes.contour)
      return channelDelta(contourOn, contourOff)
    }).toBeGreaterThan(12)
    // The same repaint that restored the contour leaves the lead pixel alone.
    const leadOn = await samplePixel(sketch, page, probes.lead)
    expect(channelDelta(leadOff, leadOn), `lead probe off=${leadOff} on=${leadOn}`).toBeLessThanOrEqual(2)
  })

  test('the Simulation tab opens on the selected plasma operation', async ({ app, ui }) => {
    const page = app.page
    await openPlasmaKerfProject(page, ui)
    await expect(ui.operations.rowByName(page, PLASMA_OP)).toHaveClass(/tree-row--selected/)

    await ui.viewMenu.tabSimulation(page).click()
    const panel = page.locator('#workspace-panel-simulation')
    await expect(panel).toBeVisible()

    // No failure overlay, and the real WebGL canvas is mounted. No pixel probe:
    // the scene is WebGL, which the sketch's 2D readback cannot inspect.
    await expect(panel.locator('.viewport-webgl-overlay')).toHaveCount(0)
    await expect(panel.getByRole('status').filter({ hasText: "3D simulation isn't available" })).toHaveCount(0)
    await expect(panel.locator('.simulation-viewport__canvas canvas')).toHaveCount(1)

    // The selected plasma operation is a simulated through-cut (issue #961), so
    // it offers tool playback like any routing operation instead of being
    // filtered out as a torch.
    await expect(ui.simSetup.playTool(page)).toBeEnabled()
  })
})
