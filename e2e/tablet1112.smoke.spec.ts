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
 * Tablet pass over the UI #1112 (PR #1126) added or changed (issue #1112,
 * slice rt4-a). Frank had not tested on a tablet yet, so this spec exists to
 * put fingers on the new surfaces before he does.
 *
 * Every surface is checked three ways, per orientation:
 *  - (a) each control inside the surface is at least 44 × 44 CSS px. Disabled
 *    controls are measured too — a refused menu row is still a row a finger
 *    lands on, and its visible reason is the point of it. `input[type=range]`
 *    sliders are the one exception: their thumb, not the track box, is the
 *    target, and this app never sizes a slider to the touch minimum.
 *  - (b) the panel/menu/dialog lies fully inside the viewport, and its body
 *    scrolls rather than being clipped when the form is taller than the space
 *    (a drawer's own scrolling counts — see `expectReachable`, which checks the
 *    two axes separately so vertical scrolling never excuses a surface clipped
 *    at the side). The page-side measurement lives in `tabletFit.ts`: it walks
 *    the clipping ancestors even when the surface's own box fits, refuses a
 *    surface wider than the scroller that is meant to show it, and refuses one
 *    painted past the window edge with no scroller left to bring it in.
 *  - (c) the surface's main action works by tap alone (`tap()`, never hover).
 *
 * A screenshot of each surface is written to `work/tablet-shots/`. `work/` is
 * gitignored, so nothing is committed from it.
 *
 * The handoff's surface list applies to a round bar **and** a square blank, so
 * every surface runs on both blanks: the Turn/Polygon creation and edit forms,
 * the feature context menu, the Cuts list, the top bar's face control, the
 * simulation info button, chuck properties and the side views drawn on Top.
 * Screenshots name the blank so the two runs of a surface cannot be mistaken
 * for each other (#1112 rt4-a fix2 review F2).
 *
 * Portrait is a **different answer**: the shell refuses a portrait tablet —
 * `src/styles/tablet.css` shows `.tablet-rotate-overlay` over the whole app for
 * `tablet`/`tablet-compact` under `(orientation: portrait)`, so no surface can
 * be tapped there at all. The portrait tests therefore assert the prompt, and
 * then measure the two new panels' layout by opening them through the store
 * (no pointer events), because "does the form fit 820 px wide" is still a real
 * question for a device that will be turned. The overlay is hidden for those
 * screenshots only — a portrait tablet would show the prompt — and each such
 * shot is named `-portrait.png` exactly as the handoff asked.
 *
 * Run in the `test:e2e:workflow-ui` lane (see `package.json`).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  cancelPendingAdd,
  getProject,
  placePendingAddAt,
  seedProject,
  selectFeatures,
  setPendingAddAnchor,
  startAddRectPlacement,
} from './helpers'
import { squareStock } from '../src/types/barStock'
import { defaultRoundWorkholding } from '../src/store/helpers/roundWorkholding'
import { tabletFitReport } from './tabletFit'
import {
  defaultTool,
  newProject,
  roundStock,
  type Clamp,
  type Project,
} from '../src/types/project'

/** The tablet sizes this pass covers: landscape as shipped, portrait as refused. */
const LANDSCAPE = { width: 1180, height: 820 }
const PORTRAIT = { width: 820, height: 1180 }

/** Where the surface screenshots land (`work/` is gitignored). */
const SHOTS = 'work/tablet-shots'

/** Anything a finger is expected to land on. */
const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="menuitemradio"]',
  '[role="option"]',
].join(', ')

/** The minimum a touch target may be, per the handoff (#1112 rt4-a). */
const TOUCH_TARGET = 44

// Read as a file: importing the machine registry would pull JSON imports into
// the Playwright runner, which Node refuses without an attribute.
const GRBL = JSON.parse(
  readFileSync(new URL('../src/engine/gcode/definitions/grbl.json', import.meta.url), 'utf8'),
) as Project['meta']['machineDefinitions'][number]

/**
 * A rotary project on a bar with a rotary machine and one chuck — the fixture
 * every surface here needs (a Turn or Polygon needs the bar, chuck properties
 * need the chuck). `shape` picks the physical blank: the handoff asks for both
 * a round bar and a square blank, and the panels, defaults and drawn outlines
 * differ between them (#1112 rt4-a review F1).
 */
function barProject(shape: 'round' | 'square' = 'round'): Project {
  const base = newProject('Tablet #1112', 'mm')
  const machine = {
    ...GRBL,
    id: 'e2e-tablet-rotary',
    name: 'E2E Tablet Rotary',
    builtin: false,
    rotary: { about: 'x' as const, drive: 'own' as const, reversed: false, inverseTimeFeed: { on: 'G93' as const, off: 'G94' as const } },
  }
  base.stock = shape === 'square' ? squareStock(25, 120, 'x') : roundStock(25, 120, 'x')
  base.meta = {
    ...base.meta,
    projectType: 'rotary',
    machineDefinitions: [machine],
    selectedMachineId: machine.id,
  }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', diameter: 3, maxCutDepth: 20 }]
  const chuck: Clamp = {
    id: 'chuck-1',
    name: 'Chuck',
    ...defaultRoundWorkholding('chuck', base.stock, 'mm'),
  }
  base.clamps = [chuck]
  return base
}

/**
 * Seed `barProject(shape)` and prove the blank really is the one under test.
 * Every surface below runs once per blank, and this assertion is what makes the
 * square run **bite**: seeding the round fixture for a "square blank" test fails
 * here instead of passing quietly (#1112 rt4-a fix2 review F2).
 */
async function seedBar(page: Page, shape: 'round' | 'square'): Promise<void> {
  await seedProject(page, JSON.stringify(barProject(shape)))
  const seeded = await getProject(page) as unknown as Project
  expect(seeded.stock.shape, `the ${shape} blank under test`).toBe(shape)
}

// ── Touch-target and fit assertions ────────────────────────────────────

interface ControlReading {
  describe: string
  width: number
  height: number
}

/**
 * Every visible, enabled control inside `root`, with its box. `root` is a CSS
 * selector because the walk happens in the page. Controls outside the viewport
 * are still measured: a 44px control scrolled out of a panel is a fit problem,
 * reported by {@link expectInsideViewport} instead.
 */
async function readControls(page: Page, root: string): Promise<ControlReading[]> {
  return page.evaluate(({ selector, interactive }) => {
    const scope = document.querySelector(selector)
    if (!scope) return []
    return Array.from(scope.querySelectorAll<HTMLElement>(interactive))
      .filter((element) => {
        // A range input's track box is not what a finger aims at.
        if (element instanceof HTMLInputElement && element.type === 'range') return false
        // Disabled controls are measured too: a refused menu row is still a row
        // a finger lands on, and its visible reason is the point of it.
        if (element.closest('[aria-hidden="true"]')) return false
        const style = getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        const box = element.getBoundingClientRect()
        return box.width > 0 || box.height > 0
      })
      .map((element) => {
        // A checkbox's own box is a 13px square; the label wrapping it is what
        // a finger actually hits, so that is the target measured here.
        const target = element instanceof HTMLInputElement
          && (element.type === 'checkbox' || element.type === 'radio')
          ? element.closest('label') ?? element
          : element
        const box = target.getBoundingClientRect()
        const label = (element.getAttribute('aria-label')
          ?? element.textContent?.trim()
          ?? element.getAttribute('title')
          ?? '').replace(/\s+/g, ' ').slice(0, 48)
        return {
          describe: `<${element.tagName.toLowerCase()} class="${element.className.toString().slice(0, 40)}"> "${label}"`,
          width: Math.round(box.width * 10) / 10,
          height: Math.round(box.height * 10) / 10,
        }
      })
  }, { selector: root, interactive: INTERACTIVE_SELECTOR })
}

/** (a) Assert every control inside `root` clears the tablet touch minimum. */
async function expectTouchTargets(page: Page, root: string): Promise<void> {
  const controls = await readControls(page, root)
  expect(controls.length, `no controls found inside ${root}`).toBeGreaterThan(0)
  const short = controls.filter(
    (control) => control.width < TOUCH_TARGET || control.height < TOUCH_TARGET,
  )
  expect(
    short,
    `${short.length} control(s) under ${TOUCH_TARGET}px inside ${root}: `
      + short.map((control) => `${control.describe} ${control.width}×${control.height}`).join('; '),
  ).toEqual([])
}

/** (b) Assert `locator` lies fully inside the viewport. */
async function expectInsideViewport(page: Page, locator: Locator, label: string): Promise<void> {
  const box = await locator.boundingBox()
  expect(box, `${label} has no box`).not.toBeNull()
  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  expect(
    box!.x >= -0.5 && box!.y >= -0.5
      && box!.x + box!.width <= viewport!.width + 0.5
      && box!.y + box!.height <= viewport!.height + 0.5,
    `${label} is not fully inside ${viewport!.width}×${viewport!.height}: `
      + `${Math.round(box!.x)},${Math.round(box!.y)} ${Math.round(box!.width)}×${Math.round(box!.height)}`,
  ).toBe(true)
}

/**
 * (b) For a surface that lives inside a drawer: it must be reachable — fully
 * inside the viewport, or cut off only inside a scrollable container that is
 * itself inside the viewport ("scrolling inside the panel is fine if it
 * scrolls", per the handoff). Each axis is checked on its own: a surface cut
 * off at the right edge needs something that scrolls **sideways**, however
 * much the drawer scrolls up and down.
 *
 * The ancestor walk itself lives in {@link tabletFitReport}, which runs in the
 * page: an ancestor clipping the surface is reported even when the surface's
 * own box fits the viewport, a surface wider than the scroller meant to show it
 * is refused rather than accepted because the scroller can move it, and a
 * surface still painted past the window edge when the walk ends is refused —
 * no clipping ancestor is not a pass (#1112 rt4-a fix2 review F1, fix3 review
 * F1). `issues` is therefore the whole answer for this assertion.
 */
async function expectReachable(page: Page, locator: Locator, label: string): Promise<void> {
  const viewport = page.viewportSize()
  expect(viewport, `${label} needs a viewport to measure against`).not.toBeNull()
  const report = await locator.evaluate(tabletFitReport, viewport!)
  const issues = [...report.horizontal.issues, ...report.vertical.issues]
  expect(
    issues,
    `${label} is not fully reachable on ${viewport!.width}×${viewport!.height}: `
      + issues.map((issue) => issue.detail).join('; '),
  ).toEqual([])
}

/**
 * (b) A form taller than the space it has must scroll its own body rather than
 * run past the viewport edge. Asserted separately from the box check because a
 * panel whose body is clipped still reports a fitting outer box.
 */
async function expectBodyScrollsWhenTall(page: Page, root: string): Promise<void> {
  const overflow = await page.evaluate((selector) => {
    const body = document.querySelector(`${selector} .canvas-workflow-panel__body`) as HTMLElement | null
    if (!body) return null
    return {
      scrolls: body.scrollHeight <= body.clientHeight + 1
        || ['auto', 'scroll'].includes(getComputedStyle(body).overflowY),
      hidden: body.scrollHeight - body.clientHeight,
      overflowY: getComputedStyle(body).overflowY,
    }
  }, root)
  expect(overflow, `${root} has no panel body`).not.toBeNull()
  expect(overflow!.scrolls, `${root} body clips ${overflow!.hidden}px (overflow-y: ${overflow!.overflowY})`).toBe(true)
}

// ── Driving the app ────────────────────────────────────────────────────

/** Switch the workspace face by tap, through the header control. */
async function tapFace(page: Page, face: 'Top' | 'Bottom' | 'Around'): Promise<void> {
  const current = page.locator('.face-switch__trigger')
  if (await current.getAttribute('data-face') === face.toLowerCase()) return
  await current.tap()
  await page.locator(`.face-switch__menu-item[data-face="${face.toLowerCase()}"]`).tap()
  await expect(current).toHaveAttribute('data-face', face.toLowerCase())
}

/** Open the left project drawer by tap and wait for it to finish sliding in. */
async function openProjectDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open project panel' }).tap()
  await expect(page.locator('.app-shell')).toHaveAttribute('data-left-open', 'true')
  await expect(page.locator('.panel-left')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
}

/** Close the left project drawer by tap so the other drawer's scrim clears. */
async function closeProjectDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close project panel' }).tap()
  await expect(page.locator('.app-shell')).not.toHaveAttribute('data-left-open', 'true')
}

/** Open the right operations drawer by tap. */
async function openOperationsDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open operations panel' }).tap()
  await expect(page.locator('.app-shell')).toHaveAttribute('data-right-open', 'true')
  await expect(page.locator('.panel-right')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
}

/** Open the Canvas workflow panel's Shape disclosure, where Properties keeps
 *  a canned shape's own actions. */
async function openShapeDisclosure(page: Page): Promise<void> {
  const header = page.locator('.properties-panel .disclosure-section__header').first()
  if (await header.getAttribute('aria-expanded') !== 'true') await header.tap()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

/**
 * Create a Turn or Polygon from the canvas panel. `fields` are the panel's own
 * inputs (`length`, `sides`, `across-flats`, …), typed as a user would.
 */
async function createRotarySolid(
  page: Page,
  kind: 'turn' | 'polygon',
  fields: Record<string, string> = {},
): Promise<void> {
  await tapFace(page, 'Around')
  await page.locator(`[data-command="rotary-${kind}"]`).first().tap()
  const panel = page.locator('.rotary-solid-panel')
  await expect(panel).toBeVisible()
  for (const [field, value] of Object.entries(fields)) {
    await page.locator(`#rotary-solid-${field}`).fill(value)
  }
  await panel.locator('.rotary-panel__create').tap()
  await expect(panel).toHaveCount(0)
}

/**
 * Add a canned ellipse (an **expandable** canned shape, so its context menu
 * offers "Expand to features") at stock coordinates, through the store seam the
 * other canvas specs use — drawing an ellipse by hand would need two canvas
 * taps that say nothing about the surface under test.
 */
async function addEllipseFeature(page: Page, x: number, y: number, rx: number, ry: number): Promise<void> {
  await page.evaluate(async (input: { x: number; y: number; rx: number; ry: number }) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    useProjectStore.getState().startAddEllipsePlacement()
    useProjectStore.getState().setPendingAddAnchor({ x: input.x, y: input.y })
    useProjectStore.getState().placePendingAddAt({ x: input.x + input.rx, y: input.y + input.ry })
  }, { x, y, rx, ry })
  await cancelPendingAdd(page)
}

/** Draw a rectangle in stock coordinates through the store seam. */
async function drawRect(page: Page, x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await startAddRectPlacement(page)
  await setPendingAddAnchor(page, x1, y1)
  await placePendingAddAt(page, x2, y2)
  await cancelPendingAdd(page)
}

/** The screen point of a stock coordinate, using the canvas's own fitted view. */
async function stockPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(async (world) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { computeFitViewState, computeSketchViewTransform, worldToCanvas } =
      await import('../src/components/canvas/viewTransform')
    const canvas = document.querySelector('canvas.sketch-canvas') as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    const project = useProjectStore.getState().project
    const vt = computeSketchViewTransform(project, canvas.width, canvas.height, computeFitViewState(project, canvas.width, canvas.height))
    const point = worldToCanvas({ x: world.x, y: world.y }, vt)
    return { x: rect.left + point.cx, y: rect.top + point.cy }
  }, { x, y })
}

/**
 * The stock-space box of a canned model's generated side view — the outline a
 * flat face draws dashed (#1112 rt2-d). Read from the generated profile rather
 * than reconstructed from the panel's numbers: a polygon's silhouette width is
 * its own cross-section's, and hard-coding it here would test the arithmetic
 * instead of the drawing.
 */
async function sideViewBox(
  page: Page,
  featureId: string,
): Promise<{ minX: number; minY: number; maxX: number; maxY: number }> {
  return page.evaluate(async (id) => {
    const { getFeatureGeometryProfiles } = await import('/src/text/index.ts') as typeof import('../src/text')
    const { resolveFeatureInstance } = await import('/src/store/helpers/resolveFeatures') as typeof import('../src/store/helpers/resolveFeatures')
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const feature = resolveFeatureInstance(useProjectStore.getState().project, id)
    if (!feature) throw new Error(`e2e: no feature ${id}`)
    const profiles = getFeatureGeometryProfiles(feature)
    if (profiles.length === 0) throw new Error(`e2e: ${id} generated no outline`)
    const points = profiles.flatMap((profile) => [
      profile.start,
      ...profile.segments.map((segment) => segment.to),
    ])
    return {
      minX: Math.min(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxX: Math.max(...points.map((point) => point.x)),
      maxY: Math.max(...points.map((point) => point.y)),
    }
  }, featureId)
}


/**
 * How much of a straight world-space edge is painted, sampled along the drawn
 * outline. A solid line reads ~100% painted; the ghost dash the Turn/Polygon
 * side view uses (`GHOST_DASH = [4, 4]`) leaves half the samples unpainted, so
 * the gap fraction is what distinguishes dashed from solid.
 *
 * "Painted" is read as "bluer than the material behind it" rather than "not the
 * fill colour": the outline is a blue-grey stroke (the palette's ghost colour,
 * or the active colour while the model is selected) over the olive bar fill,
 * and a fractional pixel row tints the gaps with antialiasing that would defeat
 * an exact-colour comparison.
 */
async function edgeCoverage(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<{ samples: number; painted: number; gaps: number }> {
  return page.evaluate(async (edge) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../../src/store/projectStore')
    const { computeFitViewState, computeSketchViewTransform, worldToCanvas } =
      await import('../src/components/canvas/viewTransform')
    const canvas = document.querySelector('canvas.sketch-canvas') as HTMLCanvasElement
    const ctx = canvas.getContext('2d')!
    const project = useProjectStore.getState().project
    const vt = computeSketchViewTransform(project, canvas.width, canvas.height, computeFitViewState(project, canvas.width, canvas.height))
    const a = worldToCanvas(edge.from, vt)
    const b = worldToCanvas(edge.to, vt)
    const length = Math.hypot(b.cx - a.cx, b.cy - a.cy)
    // 2px steps: the dash is 4px on / 4px off, so every gap is sampled twice.
    const steps = Math.max(1, Math.floor(length / 2))
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const isStroke = (cx: number, cy: number) => {
      const index = (Math.round(cy) * canvas.width + Math.round(cx)) * 4
      const red = image.data[index]
      const blue = image.data[index + 2]
      return blue - red > 25 && blue > 60
    }
    let painted = 0
    let gaps = 0
    for (let step = 0; step <= steps; step += 1) {
      const cx = a.cx + (b.cx - a.cx) * (step / steps)
      const cy = a.cy + (b.cy - a.cy) * (step / steps)
      if (isStroke(cx, cy)) painted += 1
      else gaps += 1
    }
    return { samples: steps + 1, painted, gaps }
  }, { from, to })
}

/** A screenshot per surface, in the handoff's naming. */
async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

// ── Landscape tablet ──────────────────────────────────────────────────

test.describe('landscape tablet (1180 × 820, touch)', () => {
  test.use({ viewport: LANDSCAPE, hasTouch: true })

  test('Turn and Polygon creation panels: touch-sized, room to fit, created by tap', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    await tapFace(page, 'Around')

    // ── Turn: the profile picker, its empty-list hint and the picture ──
    await page.locator('[data-command="rotary-turn"]').first().tap()
    const turnPanel = ui.rotarySolid.dialog(page)
    await expect(turnPanel).toBeVisible()
    await expect(turnPanel).toContainText('Turn a diameter')
    // Nothing in the project can supply a side profile yet, so the picker says
    // so instead of leaving the user guessing where one comes from.
    await expect(ui.rotarySolid.profileHint(page)).toBeVisible()
    await expect(ui.rotarySolid.profileHint(page)).toHaveText(/draw .*profile/i)
    await expect(ui.rotarySolid.profileFigure(page)).toBeVisible()
    // Refresh has nothing to refresh while None is picked, so it is absent.
    await expect(ui.rotarySolid.profileRefresh(page)).toHaveCount(0)
    // The picker opens by tap and offers the plain diameter. Its options are
    // controls too, so they are measured while the list is open. Tapping the
    // trigger again closes the list — Escape would close the whole panel, its
    // own documented shortcut.
    await ui.rotarySolid.profileTrigger(page).tap()
    const noneOption = ui.rotarySolid.profileOption(page, /None/)
    await expect(noneOption).toBeVisible()
    await expectTouchTargets(page, '.rotary-solid-panel')
    await shoot(page, 'turn-profile-dropdown-landscape')
    await ui.rotarySolid.profileTrigger(page).tap()
    await expect(noneOption).toHaveCount(0)

    await expectTouchTargets(page, '.rotary-solid-panel')
    await expectInsideViewport(page, turnPanel, 'Turn panel')
    await expectBodyScrollsWhenTall(page, '.rotary-solid-panel')
    await shoot(page, 'turn-create-landscape')

    // ── The panel's own action, by tap ──
    await page.locator('#rotary-solid-start').fill('20')
    await page.locator('#rotary-solid-length').fill('40')
    await page.locator('#rotary-solid-diameter').fill('10')
    await ui.rotarySolid.createButton(page).tap()
    await expect(turnPanel).toHaveCount(0)
    const afterTurn = await getProject(page) as unknown as Project
    expect(afterTurn.features).toHaveLength(1)
    expect(afterTurn.features[0].name).toBe('Turn')

    // ── Polygon: same panel, its own fields, and its own Save ──
    await page.locator('[data-command="rotary-polygon"]').first().tap()
    const polygonPanel = ui.rotarySolid.dialog(page)
    await expect(polygonPanel).toBeVisible()
    await expect(polygonPanel).toContainText('Cut a polygon')
    await expect(page.locator('#rotary-solid-sides')).toBeVisible()
    await expect(page.locator('#rotary-solid-across-flats')).toBeVisible()
    await expectTouchTargets(page, '.rotary-solid-panel')
    await expectInsideViewport(page, polygonPanel, 'Polygon panel')
    await expectBodyScrollsWhenTall(page, '.rotary-solid-panel')
    await shoot(page, 'polygon-create-landscape')
    // The panel's main action is Create, not Cancel: it must write the model,
    // not just close the form (issue #1112 rt4-a review F1 — the first pass
    // only ever cancelled here).
    await page.locator('#rotary-solid-start').fill('70')
    await page.locator('#rotary-solid-length').fill('30')
    await page.locator('#rotary-solid-sides').fill('6')
    await page.locator('#rotary-solid-across-flats').fill('12')
    await ui.rotarySolid.createButton(page).tap()
    await expect(polygonPanel).toHaveCount(0)
    const afterPolygon = await getProject(page) as unknown as Project
    expect(afterPolygon.features).toHaveLength(2)
    const polygonFeature = afterPolygon.features.find(
      (feature) => afterPolygon.featureDefinitions[feature.definitionId]?.canned?.kind === 'polygon',
    )!
    expect(polygonFeature, 'the polygon the panel created').toBeDefined()
    const polygonCanned = afterPolygon.featureDefinitions[polygonFeature.definitionId].canned!
    expect(polygonCanned.params).toMatchObject({
      start: 70, length: 30, sides: 6, acrossFlats: 12,
    })

    // ── Thread and Flutes share the layout: only the fit check was missing ──
    await page.locator('[data-command="rotary-thread"]').first().tap()
    const threadPanel = ui.rotary.dialog(page)
    await expect(threadPanel).toBeVisible()
    await expectTouchTargets(page, '.rotary-pattern-panel')
    await expectInsideViewport(page, threadPanel, 'Thread panel')
    await expectBodyScrollsWhenTall(page, '.rotary-pattern-panel')
    await shoot(page, 'thread-panel-landscape')
    await ui.rotary.cancelButton(page).tap()
    await expect(threadPanel).toHaveCount(0)
  })

  /**
   * The Turn editor runs on both blanks: the form is the same, but its stored
   * numbers and its fit are measured against the blank the test is named for.
   * The first pass only ran it round (#1112 rt4-a fix2 review F2).
   */
  for (const shape of ['round', 'square'] as const) {
    test(`the Turn edit panel opens from Properties and saves by tap (${shape} blank)`, async ({ app, ui }) => {
      const { page } = app
      await seedBar(page, shape)
      await createRotarySolid(page, 'turn', { start: '20', length: '40', diameter: '10' })
      const created = await getProject(page) as unknown as Project
      const turnId = created.features[0].id

      // The model is authored on Top (a bar model belongs to no face), so Top is
      // where Properties offers its editor.
      await tapFace(page, 'Top')
      await openProjectDrawer(page)
      await page.locator(`.tree-row--feature[data-feature-id="${turnId}"]`).tap()
      await openShapeDisclosure(page)
      const editTurn = page.getByRole('button', { name: /^Edit turn/ })
      await expect(editTurn).toBeVisible()
      const editBox = await editTurn.boundingBox()
      expect(editBox!.height, 'the turn editor entry').toBeGreaterThanOrEqual(TOUCH_TARGET)

      await editTurn.tap()
      const panel = ui.rotarySolid.dialog(page)
      await expect(panel).toBeVisible()
      // The stored numbers are what the form opened with.
      await expect(page.locator('#rotary-solid-length')).toHaveValue('40')
      await expect(page.locator('#rotary-solid-diameter')).toHaveValue('10')
      await expectTouchTargets(page, '.rotary-solid-panel')
      await expectInsideViewport(page, panel, `Turn edit panel (${shape} blank)`)
      await expectBodyScrollsWhenTall(page, '.rotary-solid-panel')
      await shoot(page, `turn-edit-${shape}-landscape`)

      // A change is saved with the panel's own action, by tap.
      await page.locator('#rotary-solid-length').fill('30')
      await ui.rotarySolid.createButton(page).tap()
      await expect(panel).toHaveCount(0)
      const edited = await getProject(page) as unknown as Project
      const stored = edited.featureDefinitions[edited.features[0].definitionId].canned
      expect((stored!.params as Record<string, unknown>).length).toBe(30)
    })
  }

  /**
   * The Polygon editor was missing from the first tablet pass entirely —
   * Polygon creation only ever cancelled, so no polygon form had ever been
   * filled in, created or saved (#1112 rt4-a review F1). Both blank shapes run
   * it because the handoff's panel surface covers a round bar and a square
   * blank, and a square blank's polygon is measured against its side.
   */
  for (const shape of ['round', 'square'] as const) {
    test(`the Polygon edit panel opens from Properties and saves by tap (${shape} blank)`, async ({ app, ui }) => {
      const { page } = app
      await seedBar(page, shape)
      await createRotarySolid(page, 'polygon', {
        start: '70', length: '30', sides: '6', 'across-flats': '12',
      })
      const created = await getProject(page) as unknown as Project
      const polygon = created.features[0]
      expect(polygon, 'the polygon the panel created').toBeDefined()
      expect(created.featureDefinitions[polygon.definitionId].canned?.kind).toBe('polygon')

      // The model is authored on Top (a bar model belongs to no face), so Top
      // is where Properties offers its editor.
      await tapFace(page, 'Top')
      await openProjectDrawer(page)
      await page.locator(`.tree-row--feature[data-feature-id="${polygon.id}"]`).tap()
      await openShapeDisclosure(page)
      const editPolygon = page.getByRole('button', { name: /^Edit polygon/ })
      await expect(editPolygon).toBeVisible()
      const editBox = await editPolygon.boundingBox()
      expect(editBox!.height, 'the polygon editor entry').toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(editBox!.width, 'the polygon editor entry').toBeGreaterThanOrEqual(TOUCH_TARGET)

      await editPolygon.tap()
      const panel = ui.rotarySolid.dialog(page)
      await expect(panel).toBeVisible()
      await expect(panel).toContainText('Edit polygon')
      // The stored numbers are what the form opened with.
      await expect(page.locator('#rotary-solid-length')).toHaveValue('30')
      await expect(page.locator('#rotary-solid-sides')).toHaveValue('6')
      await expect(page.locator('#rotary-solid-across-flats')).toHaveValue('12')
      await expectTouchTargets(page, '.rotary-solid-panel')
      await expectInsideViewport(page, panel, 'Polygon edit panel')
      await expectBodyScrollsWhenTall(page, '.rotary-solid-panel')
      await shoot(page, `polygon-edit-${shape}-landscape`)

      // A change is saved with the panel's own action, by tap.
      await page.locator('#rotary-solid-across-flats').fill('14')
      await ui.rotarySolid.createButton(page).tap()
      await expect(panel).toHaveCount(0)
      const edited = await getProject(page) as unknown as Project
      expect(edited.features).toHaveLength(1)
      expect(edited.features[0].id).toBe(polygon.id)
      expect(edited.featureDefinitions[polygon.definitionId].canned!.params).toMatchObject({
        sides: 6, acrossFlats: 14, length: 30,
      })
    })
  }

  /**
   * The handoff's panel surface applies to a square blank as well as a round
   * bar. The other square-blank tests elsewhere only assert that the panels
   * fit; here they are measured against the tablet touch minimum and driven by
   * tap alone, which is what this pass is for (#1112 rt4-a review F1).
   */
  test('a square blank creates Turn and Polygon models by tap', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject('square')))
    await tapFace(page, 'Around')

    // ── Turn inside the square blank ──
    await page.locator('[data-command="rotary-turn"]').first().tap()
    const turnPanel = ui.rotarySolid.dialog(page)
    await expect(turnPanel).toBeVisible()
    // A square blank's finished target defaults to its side — the largest
    // round the blank holds — so the form proves which blank it is measured
    // against before anything is typed.
    await expect(page.locator('#rotary-solid-diameter')).toHaveValue('25')
    await expectTouchTargets(page, '.rotary-solid-panel')
    await expectInsideViewport(page, turnPanel, 'Turn panel (square blank)')
    await expectBodyScrollsWhenTall(page, '.rotary-solid-panel')
    await shoot(page, 'turn-create-square-landscape')
    await page.locator('#rotary-solid-start').fill('10')
    await page.locator('#rotary-solid-length').fill('30')
    await page.locator('#rotary-solid-diameter').fill('20')
    await ui.rotarySolid.createButton(page).tap()
    await expect(turnPanel).toHaveCount(0)
    const afterTurn = await getProject(page) as unknown as Project
    expect(afterTurn.features).toHaveLength(1)
    expect(afterTurn.featureDefinitions[afterTurn.features[0].definitionId].canned?.kind).toBe('turn')

    // ── Polygon, created by tap as well ──
    await page.locator('[data-command="rotary-polygon"]').first().tap()
    const polygonPanel = ui.rotarySolid.dialog(page)
    await expect(polygonPanel).toBeVisible()
    await expectTouchTargets(page, '.rotary-solid-panel')
    await expectInsideViewport(page, polygonPanel, 'Polygon panel (square blank)')
    await expectBodyScrollsWhenTall(page, '.rotary-solid-panel')
    await shoot(page, 'polygon-create-square-landscape')
    await page.locator('#rotary-solid-start').fill('50')
    await page.locator('#rotary-solid-length').fill('30')
    await page.locator('#rotary-solid-sides').fill('6')
    await page.locator('#rotary-solid-across-flats').fill('18')
    await ui.rotarySolid.createButton(page).tap()
    await expect(polygonPanel).toHaveCount(0)
    const afterPolygon = await getProject(page) as unknown as Project
    expect(afterPolygon.features).toHaveLength(2)
    const polygon = afterPolygon.features.find(
      (feature) => afterPolygon.featureDefinitions[feature.definitionId]?.canned?.kind === 'polygon',
    )!
    expect(polygon, 'the polygon the panel created').toBeDefined()
    expect(afterPolygon.featureDefinitions[polygon.definitionId].canned!.params).toMatchObject({
      start: 50, length: 30, sides: 6, acrossFlats: 18,
    })
    // Both models live inside the real blank, which is never rewritten.
    expect(afterPolygon.stock).toMatchObject({ shape: 'square', thickness: 25 })
  })

  for (const shape of ['round', 'square'] as const) {
    test(`the feature context menu is touch-sized on a canned shape and names the other face (${shape} blank)`, async ({ app, ui }) => {
      const { page } = app
      await seedBar(page, shape)
      await createRotarySolid(page, 'turn', { start: '20', length: '40', diameter: '10' })
      await tapFace(page, 'Top')
      await addEllipseFeature(page, 20, 4, 10, 6)
      const project = await getProject(page) as unknown as Project
      const ellipse = project.features.find((feature) => feature.name.startsWith('Ellipse'))!
      const turn = project.features.find((feature) => feature.name === 'Turn')!

      // ── The canned (expandable) shape: Edit, Expand and a wrapped reason ──
      await openProjectDrawer(page)
      // The ⋮ on the row is the touch route to the menu: right-click has no
      // touch equivalent, and the button used to shrink to 32px in the drawer.
      const more = page.locator(`.tree-row--feature[data-feature-id="${ellipse.id}"] .tree-action-btn--more`)
      const moreBox = await more.boundingBox()
      expect(moreBox!.height, 'the menu’s touch entry point').toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(moreBox!.width, 'the menu’s touch entry point').toBeGreaterThanOrEqual(TOUCH_TARGET)
      await more.tap()
      const menu = ui.contextMenu.container(page)
      await expect(menu).toBeVisible()
      await expect(ui.contextMenu.itemExact(menu, 'Edit ellipse…')).toBeEnabled()
      await expect(ui.contextMenu.itemExact(menu, 'Expand to features')).toBeEnabled()
      // "Edit sketch" refuses a generated shape, and the refusal is visible text
      // under the label — the row a finger has to read, and the one that used to
      // stay under 44px (issue #1112 F2).
      const refused = menu.locator('.feature-context-menu__item--reason').filter({ hasText: 'Edit sketch' })
      await expect(refused).toContainText(/generated|Expand to features/i)
      await expectTouchTargets(page, '.feature-context-menu')
      await expectInsideViewport(page, menu, `context menu (canned shape, ${shape} blank)`)
      await shoot(page, `context-menu-canned-${shape}-landscape`)

      // Tapping Edit opens the same canvas panel the Properties button does.
      await ui.contextMenu.itemExact(menu, 'Edit ellipse…').tap()
      const editPanel = page.locator('.canvas-workflow-panel--creation')
      await expect(editPanel).toBeVisible()
      await editPanel.getByRole('button', { name: 'Cancel' }).tap()
      await expect(editPanel).toHaveCount(0)

      // ── The other-face model: the menu names the way to its own face ──
      // The drawer has to close first: its scrim covers the header control.
      await closeProjectDrawer(page)
      await tapFace(page, 'Bottom')
      await openProjectDrawer(page)
      await page.locator(`.tree-row--feature[data-feature-id="${turn.id}"] .tree-action-btn--more`).tap()
      const ghostMenu = ui.contextMenu.container(page)
      await expect(ghostMenu).toBeVisible()
      await expect(ui.contextMenu.itemExact(ghostMenu, 'Switch to top face to edit')).toBeVisible()
      // A generated shape's parameter editor belongs to no face: Properties
      // offers "Edit turn…" from Bottom, so the ghost menu leads with it, above
      // the way to the model's own face (issue #1112 rt7-c). No other edit of
      // the model is offered here.
      await expect(ui.contextMenu.itemExact(ghostMenu, 'Edit turn…')).toBeEnabled()
      await expect(ui.contextMenu.itemExact(ghostMenu, 'Edit sketch')).toHaveCount(0)
      await expect(ghostMenu.locator('button').first()).toContainText('Edit turn…')
      await expectTouchTargets(page, '.feature-context-menu')
      await expectInsideViewport(page, ghostMenu, `context menu (other face, ${shape} blank)`)
      await shoot(page, `context-menu-other-face-${shape}-landscape`)
      await page.keyboard.press('Escape')
    })
  }

  for (const shape of ['round', 'square'] as const) {
    test(`the operation Cuts list is touch-sized and removes a target by tap (${shape} blank)`, async ({ app, ui }) => {
      const { page } = app
      await seedBar(page, shape)
      // Two cuttable features on Top, so the Cuts list has a removable row (the
      // last target's × is deliberately disabled).
      await drawRect(page, 10, 4, 30, 12)
      await drawRect(page, 40, 4, 70, 12)
      const drawn = await getProject(page) as unknown as Project
      expect(drawn.features).toHaveLength(2)
      await selectFeatures(page, drawn.features.map((feature) => feature.id))
      await openOperationsDrawer(page)
      await ui.setupCam.addAction(page).tap()
      await expect(ui.setupCam.addMenu(page)).toBeVisible()
      await ui.setupCam.addMenu(page)
        .locator('.cam-operation-item')
        .filter({ has: page.getByRole('button', { name: 'Pocket', exact: true }) })
        .getByRole('button', { name: 'Rough', exact: true })
        .tap()

      const cuts = page.locator('[data-operation-cuts]')
      await expect(cuts).toBeVisible()
      const chips = cuts.locator('.cam-cuts__chip')
      await expect(chips).toHaveCount(2)
      // Every chip carries the target's icon, its name (visible, not squeezed to
      // nothing by the ×) and a remove ×.
      for (const chip of await chips.all()) {
        await expect(chip.locator('.cam-cuts__icon')).toBeVisible()
        await expect(chip.locator('.cam-cuts__name')).toBeVisible()
        await expect(chip.locator('.cam-cuts__remove')).toBeEnabled()
      }
      await expectTouchTargets(page, '.cam-cuts')
      await expectReachable(page, cuts, `Cuts list (${shape} blank)`)
      await cuts.scrollIntoViewIfNeeded()
      await shoot(page, `operation-cuts-${shape}-landscape`)

      const removedName = (await chips.first().locator('.cam-cuts__name').textContent())!.trim()
      await chips.first().locator('.cam-cuts__remove').tap()
      await expect(chips).toHaveCount(1)
      await expect(chips.first().locator('.cam-cuts__name')).not.toHaveText(removedName)
      // The last target cannot be removed: its × is disabled, with the reason as
      // its title.
      await expect(chips.first().locator('.cam-cuts__remove')).toBeDisabled()
      const afterRemoval = await getProject(page) as unknown as Project
      expect(afterRemoval.operations[0].target.source).toBe('features')
      expect((afterRemoval.operations[0].target as { featureIds: string[] }).featureIds).toHaveLength(1)
    })
  }

  test('three short cuts pack onto one line as chips, each × owns its own 44px area, and a tap removes that cut', async ({ app, ui }) => {
    const { page } = app
    await seedBar(page, 'round')
    // Three short-named targets: one-letter names keep the question to the chip
    // layout, not to how much of a name the panel can afford. They are drawn
    // (creation through the canvas is the only way in) and then named, so the
    // chips read A, B, C however many features the blank already had.
    await drawRect(page, 10, 4, 30, 12)
    await drawRect(page, 40, 4, 70, 12)
    await drawRect(page, 80, 4, 100, 12)
    const drawn = await getProject(page) as unknown as Project
    expect(drawn.features).toHaveLength(3)
    const ids = drawn.features.map((feature) => feature.id)
    const names = ['A', 'B', 'C']
    await page.evaluate(async ({ ids: featureIds, names: newNames }: { ids: string[]; names: string[] }) => {
      const module = await import('/src/store/projectStore.ts') as {
        useProjectStore: {
          getState: () => { updateFeature: (id: string, patch: { name: string }) => void }
        }
      }
      featureIds.forEach((id, index) => module.useProjectStore.getState().updateFeature(id, { name: newNames[index] }))
    }, { ids, names })
    await selectFeatures(page, ids)
    await openOperationsDrawer(page)
    await ui.setupCam.addAction(page).tap()
    await expect(ui.setupCam.addMenu(page)).toBeVisible()
    await ui.setupCam.addMenu(page)
      .locator('.cam-operation-item')
      .filter({ has: page.getByRole('button', { name: 'Pocket', exact: true }) })
      .getByRole('button', { name: 'Rough', exact: true })
      .tap()

    const cuts = page.locator('[data-operation-cuts]')
    await expect(cuts).toBeVisible()
    const chips = cuts.locator('.cam-cuts__chip')
    await expect(chips).toHaveCount(3)
    // Order-independent: what matters is that each chip carries one of the three
    // names, not the order selection happened to write the target in.
    expect((await cuts.locator('.cam-cuts__name').allTextContents()).sort()).toEqual([...names].sort())
    await expectTouchTargets(page, '.cam-cuts')
    await expectReachable(page, cuts, 'Cuts chips (round blank)')
    await cuts.scrollIntoViewIfNeeded()

    // Read every chip's own box and its × box, then ask the document what a
    // finger lands on at that box's edges: the middle of a flat edge of a
    // 44 × 44 box that overhangs a 26px chip is exactly where a neighbouring
    // chip's body, or the panel's clip, would steal the tap if the spacing were
    // wrong. The centre alone is not enough — a box the panel clips keeps its
    // measured size and a clickable middle while its overhanging edge is gone
    // (issue #1112 rt6-b fix1 F2).
    const measured = await page.evaluate(() => {
      // A point 1px inside each of the four flat edges.
      const edges = (box: DOMRect): Array<[string, number, number]> => [
        ['top', box.left + box.width / 2, box.top + 1],
        ['bottom', box.left + box.width / 2, box.bottom - 1],
        ['left', box.left + 1, box.top + box.height / 2],
        ['right', box.right - 1, box.top + box.height / 2],
      ]
      // The corners fall inside the 4px border-radius, so they may be outside
      // the painted box.
      const corners = (box: DOMRect): Array<[number, number]> => [
        [box.left + 1, box.top + 1],
        [box.right - 1, box.top + 1],
        [box.left + 1, box.bottom - 1],
        [box.right - 1, box.bottom - 1],
      ]
      // The × a point resolves to, or null when nothing there is a remove button.
      const removeAt = (x: number, y: number): string | null => {
        const at = document.elementFromPoint(x, y)
        return at?.closest('.cam-cuts__remove')?.closest('[data-cut-feature-id]')
          ?.getAttribute('data-cut-feature-id') ?? null
      }
      return Array.from(document.querySelectorAll('[data-operation-cuts] .cam-cuts__chip')).map((chip) => {
        const remove = chip.querySelector('.cam-cuts__remove') as HTMLElement
        const name = chip.querySelector('.cam-cuts__name') as HTMLElement
        const chipBox = chip.getBoundingClientRect()
        const removeBox = remove.getBoundingClientRect()
        const id = chip.getAttribute('data-cut-feature-id')
        return {
          id,
          top: Math.round(chipBox.top),
          left: Math.round(chipBox.left),
          height: chipBox.height,
          nameClipped: name.scrollWidth > name.clientWidth + 1,
          hit: { x: removeBox.x, y: removeBox.y, width: removeBox.width, height: removeBox.height },
          centre: removeAt(removeBox.x + removeBox.width / 2, removeBox.y + removeBox.height / 2),
          edges: edges(removeBox).map(([edge, x, y]) => [edge, removeAt(x, y)] as [string, string | null]),
          corners: corners(removeBox).map(([x, y]) => removeAt(x, y)),
        }
      })
    })
    expect(measured, 'three chips measured').toHaveLength(3)
    for (const chip of measured) {
      // A finger still gets a 44 × 44 area for the ×, even though the chip it
      // sits in is only one line tall.
      expect(chip.hit.width, `× touch width on ${chip.id}`).toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(chip.hit.height, `× touch height on ${chip.id}`).toBeGreaterThanOrEqual(TOUCH_TARGET)
      // The chip itself stays visibly smaller than that box: the box overhangs
      // it instead of inflating it back into the row the change removed.
      expect(chip.height, `the chip on ${chip.id} is shorter than its × box`).toBeLessThan(chip.hit.height)
      // The chip keeps room for the name, so it is not an icon and a × with the
      // target's name squeezed out of it (the shape of the rt3-a item 25 bug).
      expect(chip.nameClipped, `the name is not ellipsized on ${chip.id}`).toBe(false)
      // Its middle is the button itself, so the area is usable, not just present.
      expect(chip.centre, `the centre of ${chip.id}'s × box is its own ×`).toBe(chip.id)
      // No flat edge of that area reaches another chip's × or the clip that
      // hides it: every edge midpoint must still be this chip's own button, so
      // a finger aiming there removes this cut. The box's measured size and its
      // clickable centre both survive being clipped or covered, which is why
      // only checking those passed a box that was unusable at its edges.
      for (const [edge, hit] of chip.edges) {
        expect(hit, `the ${edge} edge of ${chip.id}'s × box is its own ×`).toBe(chip.id)
      }
      // A point right at a box's corner may fall outside its snapped paint box,
      // which is why a corner may resolve to nothing — never to a stranger.
      for (const hit of chip.corners) {
        expect([null, chip.id], `a corner of ${chip.id}'s × box resolves to ${String(hit)}`).toContain(hit)
      }
    }
    // One line, left to right, and no two touch areas overlap.
    expect(new Set(measured.map((chip) => chip.top)).size, 'three chips share one line').toBe(1)
    for (let index = 1; index < measured.length; index += 1) {
      expect(measured[index].left, 'chips run left to right').toBeGreaterThan(measured[index - 1].left)
    }
    for (let index = 0; index < measured.length; index += 1) {
      for (let other = index + 1; other < measured.length; other += 1) {
        const a = measured[index].hit
        const b = measured[other].hit
        const overlaps = a.x < b.x + b.width && b.x < a.x + a.width
          && a.y < b.y + b.height && b.y < a.y + a.height
        expect(overlaps, `× areas of ${measured[index].id} and ${measured[other].id} do not overlap`).toBe(false)
      }
    }
    await shoot(page, 'operation-cuts-chips-round-landscape')

    // Tapping the middle chip's × removes that cut and only that one.
    const middle = chips.nth(1)
    const middleId = (await middle.getAttribute('data-cut-feature-id'))!
    const middleName = (await middle.locator('.cam-cuts__name').textContent())!.trim()
    await middle.locator('.cam-cuts__remove').tap()
    await expect(cuts.locator(`[data-cut-feature-id="${middleId}"]`)).toHaveCount(0)
    await expect(chips).toHaveCount(2)
    expect((await cuts.locator('.cam-cuts__name').allTextContents()).sort())
      .toEqual(names.filter((name) => name !== middleName).sort())
  })

  test('wrapped Cuts chips keep the two lines of × areas apart, and a long name ellipsizes under a full-name title', async ({ app, ui }) => {
    const { page } = app
    await seedBar(page, 'round')
    await drawRect(page, 10, 4, 30, 12)
    await drawRect(page, 40, 4, 70, 12)
    await drawRect(page, 80, 4, 100, 12)
    const drawn = await getProject(page) as unknown as Project
    const ids = drawn.features.map((feature) => feature.id)
    // Long enough that no two chips share the 340px drawer: the list wraps, and
    // that is where one chip's × area can reach into the neighbouring line's.
    const names = [
      'A very long target name that cannot possibly fit inside one chip',
      'Another very long target name that cannot possibly fit inside one chip',
      'One more very long target name that cannot possibly fit inside one chip',
    ]
    await page.evaluate(async ({ ids: featureIds, names: newNames }: { ids: string[]; names: string[] }) => {
      const module = await import('/src/store/projectStore.ts') as {
        useProjectStore: {
          getState: () => { updateFeature: (id: string, patch: { name: string }) => void }
        }
      }
      featureIds.forEach((id, index) => module.useProjectStore.getState().updateFeature(id, { name: newNames[index] }))
    }, { ids, names })
    await selectFeatures(page, ids)
    await openOperationsDrawer(page)
    await ui.setupCam.addAction(page).tap()
    await expect(ui.setupCam.addMenu(page)).toBeVisible()
    await ui.setupCam.addMenu(page)
      .locator('.cam-operation-item')
      .filter({ has: page.getByRole('button', { name: 'Pocket', exact: true }) })
      .getByRole('button', { name: 'Rough', exact: true })
      .tap()

    const cuts = page.locator('[data-operation-cuts]')
    await expect(cuts).toBeVisible()
    await expect(cuts.locator('.cam-cuts__chip')).toHaveCount(3)
    await expectTouchTargets(page, '.cam-cuts')
    await cuts.scrollIntoViewIfNeeded()

    const measured = await page.evaluate(() => {
      // The × a point resolves to, or null when nothing there is a remove button.
      const removeAt = (x: number, y: number): string | null => {
        const at = document.elementFromPoint(x, y)
        return at?.closest('.cam-cuts__remove')?.closest('[data-cut-feature-id]')
          ?.getAttribute('data-cut-feature-id') ?? null
      }
      return Array.from(
        document.querySelectorAll('[data-operation-cuts] .cam-cuts__chip'),
      ).map((chip) => {
        const chipBox = chip.getBoundingClientRect()
        const removeBox = (chip.querySelector('.cam-cuts__remove') as HTMLElement).getBoundingClientRect()
        const name = chip.querySelector('.cam-cuts__name') as HTMLElement
        // The flat edges' midpoints, 1px inside each: a full-width chip's right
        // overhang is the one the panel's clip can take away.
        const edges = ([
          ['top', removeBox.left + removeBox.width / 2, removeBox.top + 1],
          ['bottom', removeBox.left + removeBox.width / 2, removeBox.bottom - 1],
          ['left', removeBox.left + 1, removeBox.top + removeBox.height / 2],
          ['right', removeBox.right - 1, removeBox.top + removeBox.height / 2],
        ] as Array<[string, number, number]>).map(([edge, x, y]) => [edge, removeAt(x, y)] as [string, string | null])
        return {
          id: chip.getAttribute('data-cut-feature-id'),
          top: chipBox.top,
          bottom: chipBox.bottom,
          height: chipBox.height,
          nameClipped: name.scrollWidth > name.clientWidth + 1,
          nameTitle: name.getAttribute('title'),
          nameText: (name.textContent ?? '').trim(),
          hit: { x: removeBox.x, y: removeBox.y, width: removeBox.width, height: removeBox.height },
          edges,
        }
      })
    })
    expect(measured, 'three chips measured').toHaveLength(3)
    for (const chip of measured) {
      expect(chip.hit.width, `× touch width on ${chip.id}`).toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(chip.hit.height, `× touch height on ${chip.id}`).toBeGreaterThanOrEqual(TOUCH_TARGET)
      // A chip that fills its line must not push the × under the panel's clip:
      // the box would keep the size and the centre the two checks above read,
      // while its right edge was no longer part of the button (issue #1112
      // rt6-b fix1 F2).
      for (const [edge, hit] of chip.edges) {
        expect(hit, `the ${edge} edge of ${chip.id}'s × box is its own ×`).toBe(chip.id)
      }
      // A name too long for the chip ellipsizes, and keeps the whole name in the
      // title so it is still readable.
      expect(chip.nameClipped, `the long name on ${chip.id} is ellipsized`).toBe(true)
      expect(names, `a title names a real target on ${chip.id}`).toContain(chip.nameTitle!)
      expect(chip.nameText, `the title is the whole name on ${chip.id}`).toBe(chip.nameTitle)
    }
    // One chip per line: each name is wider than half the drawer.
    const lines = [...measured].sort((a, b) => a.top - b.top)
    expect(new Set(lines.map((chip) => Math.round(chip.top))).size, 'every long chip takes its own line').toBe(3)
    // The wrap spacing, not luck: the gap between two lines must be at least the
    // part of the × box that reaches above and below its chip (its height minus
    // the chip's), or the two touch areas overlap and the lower chip's × steals
    // taps aimed at the upper one.
    for (let index = 1; index < lines.length; index += 1) {
      const above = lines[index - 1]
      const below = lines[index]
      const overhang = above.hit.height - above.height
      expect(below.top - above.bottom, `the gap above ${below.id} covers the overhanging × boxes`)
        .toBeGreaterThanOrEqual(overhang)
      const overlaps = above.hit.x < below.hit.x + below.hit.width
        && below.hit.x < above.hit.x + above.hit.width
        && above.hit.y < below.hit.y + below.hit.height
        && below.hit.y < above.hit.y + above.hit.height
      expect(overlaps, `× areas of ${above.id} and ${below.id} do not overlap`).toBe(false)
    }
  })

  /**
   * A long list groups its chips by the tree's folders, which puts a folder's
   * summary directly above a line of × boxes, and one block's last line directly
   * above the next block's first. Both boxes overhang their 26px chip by 9px, so
   * the spacing at those boundaries is what decides whether a finger on a
   * summary line or on a block's edge removes the cut it aimed at (issue #1112
   * rt6-b fix1 F1).
   */
  test('a grouped Cuts list keeps every × area out of the folder summary and the next group', async ({ app, ui }) => {
    const { page } = app
    await seedBar(page, 'round')
    // Nine targets: grouping starts above eight rows, and five of them in one
    // tree folder put the ungrouped block right below the folder's last line.
    for (let index = 0; index < 9; index += 1) {
      const x = 4 + index * 12
      await drawRect(page, x, 4, x + 8, 12)
    }
    const drawn = await getProject(page) as unknown as Project
    const ids = drawn.features.map((feature) => feature.id)
    expect(ids, 'nine drawn targets').toHaveLength(9)
    // The folder grouping is the tree's own: five instances claim a folder the
    // project owns. Writing the group rather than dragging rows keeps this test
    // about the Cuts layout.
    drawn.featureFolders = [{ id: 'f-holes', name: 'Holes', collapsed: false }]
    drawn.features.forEach((feature, index) => {
      feature.folderId = index < 5 ? 'f-holes' : null
    })
    await seedProject(page, JSON.stringify(drawn))

    await selectFeatures(page, ids)
    await openOperationsDrawer(page)
    await ui.setupCam.addAction(page).tap()
    await expect(ui.setupCam.addMenu(page)).toBeVisible()
    await ui.setupCam.addMenu(page)
      .locator('.cam-operation-item')
      .filter({ has: page.getByRole('button', { name: 'Pocket', exact: true }) })
      .getByRole('button', { name: 'Rough', exact: true })
      .tap()

    const cuts = page.locator('[data-operation-cuts]')
    await expect(cuts).toBeVisible()
    await expect(cuts.locator('.cam-cuts__chip')).toHaveCount(9)
    // The long form: one folder for its five targets, then the ungrouped block.
    const folder = cuts.locator('.cam-cuts__folder')
    await expect(folder).toHaveCount(1)
    await expect(folder.locator('.cam-cuts__chip')).toHaveCount(5)
    await expect(folder.locator('summary')).toContainText('Holes (5)')
    await expect(cuts.locator('.cam-cuts__group')).toHaveCount(2)
    await cuts.scrollIntoViewIfNeeded()

    const measured = await page.evaluate(() => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return {
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        }
      }
      // The × a point resolves to, or null when nothing there is a remove button.
      const removeAt = (x: number, y: number): string | null => {
        const at = document.elementFromPoint(x, y)
        return at?.closest('.cam-cuts__remove')?.closest('[data-cut-feature-id]')
          ?.getAttribute('data-cut-feature-id') ?? null
      }
      const summary = document.querySelector('[data-operation-cuts] .cam-cuts__folder-summary')
      return {
        summary: summary ? box(summary) : null,
        chips: Array.from(document.querySelectorAll('[data-operation-cuts] .cam-cuts__chip')).map((chip) => {
          const removeBox = (chip.querySelector('.cam-cuts__remove') as HTMLElement).getBoundingClientRect()
          const edges = ([
            ['top', removeBox.left + removeBox.width / 2, removeBox.top + 1],
            ['bottom', removeBox.left + removeBox.width / 2, removeBox.bottom - 1],
            ['left', removeBox.left + 1, removeBox.top + removeBox.height / 2],
            ['right', removeBox.right - 1, removeBox.top + removeBox.height / 2],
          ] as Array<[string, number, number]>)
            .map(([edge, x, y]) => [edge, removeAt(x, y)] as [string, string | null])
          return {
            id: chip.getAttribute('data-cut-feature-id'),
            inFolder: Boolean(chip.closest('.cam-cuts__folder')),
            hit: box(chip.querySelector('.cam-cuts__remove') as HTMLElement),
            edges,
          }
        }),
      }
    })
    expect(measured.chips, 'nine chips measured').toHaveLength(9)
    expect(measured.summary, 'the folder has a summary').not.toBeNull()
    for (const chip of measured.chips) {
      expect(chip.hit.width, `× touch width on ${chip.id}`).toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(chip.hit.height, `× touch height on ${chip.id}`).toBeGreaterThanOrEqual(TOUCH_TARGET)
      // Every flat edge of the × box is still that chip's own × — including the
      // top of a folder's first line and both sides of a block boundary, which
      // is where the overhang used to land on a neighbour.
      for (const [edge, hit] of chip.edges) {
        expect(hit, `the ${edge} edge of ${chip.id}'s × box is its own ×`).toBe(chip.id)
      }
    }
    // A folder's summary is not inside its own chips' boxes: the first line's ×
    // box starts below the summary's line box, so tapping the summary's text
    // cannot remove a cut.
    const folderChips = measured.chips.filter((chip) => chip.inFolder)
    expect(folderChips, 'the folder holds five chips').toHaveLength(5)
    expect(
      Math.min(...folderChips.map((chip) => chip.hit.y)),
      "a folder's summary clears its own chips' × boxes",
    ).toBeGreaterThanOrEqual(measured.summary!.bottom)
    // No two × areas overlap anywhere in the list: within a wrapped group, and
    // across the boundary from the folder's last line to the ungrouped block.
    for (let index = 0; index < measured.chips.length; index += 1) {
      for (let other = index + 1; other < measured.chips.length; other += 1) {
        const a = measured.chips[index].hit
        const b = measured.chips[other].hit
        const overlaps = a.x < b.x + b.width && b.x < a.x + a.width
          && a.y < b.y + b.height && b.y < a.y + a.height
        expect(
          overlaps,
          `× areas of ${measured.chips[index].id} and ${measured.chips[other].id} do not overlap`,
        ).toBe(false)
      }
    }
    await shoot(page, 'operation-cuts-grouped-round-landscape')
  })

  for (const shape of ['round', 'square'] as const) {
    test(`the top bar carries the face control and the CAM panel opens from its own button (${shape} blank)`, async ({ app, ui }) => {
      const { page } = app
      await seedBar(page, shape)

      // The one face control rides in the top command bar, right after the
      // Sketch / 3D / Sim switch (issue #1112 rt5-a, item 37), and the row that
      // used to hold it above the workspace is gone (not merely empty).
      const control = ui.face.current(page)
      await expect(ui.face.topBarControl(page)).toBeVisible()
      await expect(page.locator('.centre-workspace > .panel-tabs-header')).toHaveCount(0)
      await expect(control).toBeVisible()
      // It is the bar's own 44 × 44 button, not a labelled 48px row control.
      const box = await control.boundingBox()
      expect(box!.width, 'face control width').toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(box!.height, 'face control height').toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(Math.round(box!.width), 'face control width is the touch target').toBe(TOUCH_TARGET)
      expect(Math.round(box!.height), 'face control height is the touch target').toBe(TOUCH_TARGET)
      await expectInsideViewport(page, control, `face control (${shape} blank)`)
      // The name it used to show is still its accessible name, and the label is
      // the part that gave way to the bar's width — not the control.
      await expect(control).toHaveAttribute('aria-label', 'Current face: Top')
      await expect(control.locator('.face-switch__trigger-label')).toBeHidden()
      await shoot(page, `face-control-${shape}-landscape`)

      // Opening it is a tap, and its entries are touch-sized on the tablet shell.
      await control.tap()
      await expect(ui.face.menu(page)).toBeVisible()
      await expectTouchTargets(page, '.face-switch__menu')
      await expectInsideViewport(page, ui.face.menu(page), 'face menu')
      await ui.face.item(page, 'Bottom').tap()
      await expect(control).toHaveAttribute('data-face', 'bottom')
      // …and the menu is the same one: the face it now shows is on screen.
      await expect(control).toHaveAttribute('aria-label', /^Current face: Bottom/)

      // A tablet has no `»` pull-out handle: the CAM panel is a drawer, opened by
      // the command bar's Operations button, which is its stand-in here. The
      // button used to inherit the command bar's 40px control height, so it is
      // held to the same 44px minimum as the handle it replaces
      // (`.top-cmd-btn--operations` in `src/styles/tablet.css`, #1112 rt4-a
      // review F2).
      await expect(page.locator('#panel-handle-right')).toHaveCount(0)
      const operationsButton = ui.operations.openPanelButton(page)
      const operationsBox = await operationsButton.boundingBox()
      expect(operationsBox!.height, 'the Operations entry that replaces the » handle')
        .toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(operationsBox!.width, 'the Operations entry that replaces the » handle')
        .toBeGreaterThanOrEqual(TOUCH_TARGET)
      await openOperationsDrawer(page)
      await expectInsideViewport(page, page.locator('#panel-right'), 'operations drawer')
    })
  }

  /**
   * The bar has to hold one more 44px control at the two landscape widths the
   * handoff names, with the face control fully in the window and reachable
   * without scrolling the bar to it (issue #1112 rt5-a: shrink what already
   * shrinks there instead of bringing the row back).
   *
   * One fresh page per width, never a resize: a tablet shell's sketch canvas is
   * sized from its container and its `width` attribute then holds the layout's
   * min-content open, so shrinking a loaded page would measure that artefact
   * instead of the bar.
   */
  const WIDTHS = [1180, 1024] as const
  for (const width of WIDTHS) {
    test.describe(`tablet landscape at ${width} × 820`, () => {
      test.use({ viewport: { width, height: 820 } })

      test(`the top bar holds the face control at ${width} wide`, async ({ app, ui }) => {
        const { page } = app
        await seedBar(page, 'round')
        await expect(page.locator('.app-shell')).toHaveAttribute('data-shell-mode', 'tablet')
        // The row that used to hold the control above the workspace is gone, so
        // the bar is the control's only home and the stage is the panel's only row.
        await expect(ui.face.topBarControl(page)).toBeVisible()
        await expect(page.locator('.centre-workspace > .panel-tabs-header')).toHaveCount(0)

        const control = ui.face.current(page)
        await expect(control).toBeVisible()
        const box = await control.boundingBox()
        expect(box!.width, `face control width at ${width}`).toBeGreaterThanOrEqual(TOUCH_TARGET)
        expect(box!.height, `face control height at ${width}`).toBeGreaterThanOrEqual(TOUCH_TARGET)
        expect(box!.x, `face control starts on screen at ${width}`).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width, `face control ends on screen at ${width}`)
          .toBeLessThanOrEqual(width + 0.5)

        // No empty row is left behind either: the workspace starts at the bar's
        // bottom edge and fills the rest of the window (a tablet's old header row
        // sat between them, 60px tall, holding the face control). Measured, not
        // inferred from the class: a leftover spacer would fail this too.
        const rows = await page.evaluate(() => {
          const bar = document.querySelector('.app-toolbar')!.getBoundingClientRect()
          const stage = document.querySelector('.centre-stage')!.getBoundingClientRect()
          return {
            gap: Math.round(stage.top - bar.bottom),
            share: stage.height / window.innerHeight,
          }
        })
        expect(rows.gap, `nothing sits between the top bar and the workspace at ${width}`)
          .toBeLessThanOrEqual(1)
        expect(rows.share, `the workspace fills the window below the bar at ${width}`)
          .toBeGreaterThan(0.75)

        // It is not merely painted inside the window: the bar is not scrolled to
        // reach it, so it is there on arrival. The row's own content is what must
        // give way; the control and its gap are never clipped.
        const bar = await page.evaluate(() => {
          const centre = document.querySelector<HTMLElement>('.top-command-bar__center')
          return {
            centreLeft: centre?.scrollLeft ?? 0,
            centreOverflow: (centre?.scrollWidth ?? 0) - (centre?.clientWidth ?? 0),
            documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }
        })
        expect(bar.centreLeft, `the bar is scrolled to reach the control at ${width}`).toBe(0)
        expect(bar.centreOverflow, `the view switch and face control overflow their row at ${width}`)
          .toBeLessThanOrEqual(0)
        expect(bar.documentOverflow, `the page scrolls sideways at ${width}`).toBeLessThanOrEqual(0)

        // And it works by tap at this width: the same menu, the same entries.
        await control.tap()
        await expect(ui.face.menu(page)).toBeVisible()
        await ui.face.item(page, 'Bottom').tap()
        await expect(control).toHaveAttribute('data-face', 'bottom')
        await shoot(page, `face-control-bar-${width}`)
      })
    })
  }

  /**
   * The same bar on a **coarse-pointer** tablet, where its buttons take the
   * 44px touch token: that is the layout Frank uses, and it is wider than this
   * harness's default (Playwright's `hasTouch` does not flip `pointer` to
   * coarse, so the two tokens the `(pointer: coarse)` block sets are forced
   * here). At 1180 — the larger of the two widths the handoff names — the bar
   * still holds every control inside the window, which is what the spacing and
   * project-title squeeze bought for the new face control (issue #1112 rt5-a).
   * 1024 is not asserted to fit: the bar's content needs more than that on a
   * coarse pointer and already did before the face control existed.
   */
  test('the top bar still fits at 1180 with 44px coarse-pointer buttons', async ({ app, ui }) => {
    const { page } = app
    await seedBar(page, 'round')
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--touch-target', '44px')
      document.querySelector<HTMLElement>('.app-shell')!
        .style.setProperty('--control-hit-target', '44px')
    })
    await expect(ui.face.topBarControl(page)).toBeVisible()
    const data = await page.evaluate(() => {
      const rect = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector)
        return el ? el.getBoundingClientRect() : null
      }
      const barEl = document.querySelector<HTMLElement>('.top-command-bar')!
      const bar = barEl.getBoundingClientRect()
      const ops = rect('.top-cmd-btn--operations')!
      const centre = document.querySelector<HTMLElement>('.top-command-bar__center')!
      const face = rect('.face-switch')!
      return {
        barRight: Math.round(bar.right),
        barOverflow: barEl.scrollWidth - barEl.clientWidth,
        opsRight: Math.round(ops.right),
        faceRight: Math.round(face.right),
        faceWidth: Math.round(face.width),
        centreScrollLeft: centre.scrollLeft,
        windowWidth: window.innerWidth,
      }
    })
    expect(data.faceWidth, 'the control keeps its 44px target').toBe(TOUCH_TARGET)
    expect(data.barRight, 'the top bar stays inside the 1180px window')
      .toBeLessThanOrEqual(data.windowWidth)
    expect(data.opsRight, 'the last control in the bar is inside the window')
      .toBeLessThanOrEqual(data.windowWidth)
    expect(data.faceRight, 'the face control is inside the window')
      .toBeLessThanOrEqual(data.windowWidth)
    expect(data.barOverflow, 'the bar has no content pushed out of it').toBeLessThanOrEqual(0)
    expect(data.centreScrollLeft, 'the bar is not scrolled').toBe(0)
  })

  for (const shape of ['round', 'square'] as const) {
    test(`the simulation toolbar explains fresh stock behind a 44px info button (${shape} blank)`, async ({ app, ui }) => {
      const { page } = app
      await seedBar(page, shape)

      // One setup only: nothing to explain, so no button.
      await page.getByRole('button', { name: 'Sim', exact: true }).tap()
      await expect(ui.simSetup.viewport(page)).toBeVisible()
      await expect(ui.simSetup.info(page)).toHaveCount(0)

      // A second face's work makes a second setup, and the sentence appears.
      await tapFace(page, 'Bottom')
      await drawRect(page, 20, 8, 60, 16)
      const twoSided = await getProject(page) as unknown as Project
      expect(twoSided.setups.length).toBeGreaterThan(1)
      await expect(ui.simSetup.info(page)).toBeVisible()
      const note = 'Bottom is simulated on fresh stock: material removed by other setups is not shown.'
      await expect(ui.simSetup.info(page)).toHaveAttribute('aria-label', note)

      const infoBox = await ui.simSetup.info(page).boundingBox()
      expect(infoBox!.height).toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(infoBox!.width).toBeGreaterThanOrEqual(TOUCH_TARGET)
      // A tap opens the sentence: a `title` alone never shows on a touch screen.
      await expect(ui.simSetup.note(page)).toHaveCount(0)
      await ui.simSetup.info(page).tap()
      await expect(ui.simSetup.note(page)).toBeVisible()
      await expect(ui.simSetup.note(page)).toHaveText(note)
      await expectInsideViewport(page, ui.simSetup.note(page), 'fresh-stock sentence')
      await expectTouchTargets(page, '#workspace-panel-simulation .viewport-presets')
      await shoot(page, `simulation-info-${shape}-landscape`)
    })
  }

  for (const shape of ['round', 'square'] as const) {
    test(`chuck properties are touch-sized (${shape} blank)`, async ({ app, ui }) => {
      const { page } = app
      await seedBar(page, shape)
      await openProjectDrawer(page)
      await page.locator('.tree-row--clamp').first().tap()

      const size = ui.properties.chuckSize(page)
      await expect(size).toBeVisible()
      await expect(page.getByTestId('chuck-jaws')).toBeVisible()
      // Size, jaws and both ends of the clamping range are all real controls.
      await expectTouchTargets(page, '.properties-panel')
      await expectReachable(page, page.locator('.properties-panel'), `chuck properties (${shape} blank)`)
      await page.locator('[data-testid="chuck-size"]').scrollIntoViewIfNeeded()
      await shoot(page, `chuck-properties-${shape}-landscape`)

      // The picker's rows are targets of their own (they were 24px tall).
      await size.locator('.ui-select__trigger').tap()
      const options = size.getByRole('option')
      await expect(options.first()).toBeVisible()
      for (const option of await options.all()) {
        const optionBox = await option.boundingBox()
        expect(optionBox!.height, `chuck size option ${await option.textContent()}`).toBeGreaterThanOrEqual(TOUCH_TARGET)
      }
      // Closed by tapping the trigger again (a tap on an option is the defect the
      // fixme below covers). Closing must leave the clamp alone.
      await size.locator('.ui-select__trigger').tap()
      await expect(options).toHaveCount(0)
      const stillThere = await getProject(page) as unknown as Project
      expect(stillThere.clamps).toHaveLength(1)

      // The range the body was clamped between is readable and editable.
      await expect(page.getByText('Minimum grip diameter')).toBeVisible()
      await expect(page.getByText('Maximum grip diameter')).toBeVisible()
    })
  }

  /**
   * Known tablet defect found by this pass, not fixed here (feature behaviour
   * is out of this slice's scope): `Select`'s option commits on `pointerdown`
   * and closes the list there, so the compatibility `click` a tap also sends
   * lands on whatever the closed list has uncovered. Picking a chuck size
   * therefore hits the control underneath — observed deleting the clamp
   * outright (its `Delete clamp` button sits where the list was). A mouse's
   * click lands before the list closes, which is why only touch shows it.
   *
   * The fix belongs to `src/components/Select.tsx` (commit on click, or
   * suppress the tap's compatibility click); un-fixme once that lands. It is
   * blank-independent, so it stays on the round fixture (#1112 rt4-a fix2
   * review F2 covers the surfaces that differ, not this defect).
   */
  test.fixme('picking a chuck size by tap applies it to the clamp (#1112 rt4-a)', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    await openProjectDrawer(page)
    await page.locator('.tree-row--clamp').first().tap()
    const size = ui.properties.chuckSize(page)
    const before = await getProject(page) as unknown as Project
    await size.locator('.ui-select__trigger').tap()
    await size.getByRole('option').nth(2).tap()
    const after = await getProject(page) as unknown as Project
    expect(after.clamps, 'picking a size must not remove the clamp').toHaveLength(1)
    expect(after.clamps[0].chuck?.size).not.toBe(before.clamps[0].chuck?.size)
  })

  /**
   * The handoff asks for round **and** square bar rotary projects, and a square
   * blank is a different drawing target: its side view sits on its own blank,
   * so the dashed outline and the tap target are checked on both shapes with
   * only the fixture changing (#1112 rt4-a review F1).
   */
  for (const shape of ['round', 'square'] as const) {
    test(`Turn and Polygon side views draw dashed on Top and select by tap (${shape} blank)`, async ({ app }) => {
      const { page } = app
      await seedBar(page, shape)
      await createRotarySolid(page, 'turn', { start: '20', length: '40', diameter: '10' })
      await createRotarySolid(page, 'polygon', { start: '70', length: '30', sides: '6', 'across-flats': '12' })
      await tapFace(page, 'Top')
      const project = await getProject(page) as unknown as Project
      const cannedKindOf = (feature: Project['features'][number]) =>
        project.featureDefinitions[feature.definitionId]?.canned?.kind
      const turn = project.features.find((feature) => cannedKindOf(feature) === 'turn')!
      // A six-sided polygon is named "Hex" — its own kind is what identifies it.
      const polygon = project.features.find((feature) => cannedKindOf(feature) === 'polygon')!
      expect(turn, 'the Turn feature').toBeDefined()
      expect(polygon, 'the Polygon feature').toBeDefined()

      // ── Both are drawn, and dashed: the side view's outline is a ghost stroke
      // over the bar's fill, half covered by the dash gaps (#1112 rt2-d item 19) ──
      const turnBox = await sideViewBox(page, turn.id)
      const polygonBox = await sideViewBox(page, polygon.id)
      for (const [label, box] of [['Turn', turnBox], ['Polygon', polygonBox]] as const) {
        const coverage = await edgeCoverage(
          page,
          { x: box.minX + 1, y: box.minY },
          { x: box.maxX - 1, y: box.minY },
        )
        expect(coverage.samples, `${label} edge samples`).toBeGreaterThan(20)
        expect(coverage.painted, `${label} outline is not drawn`).toBeGreaterThan(coverage.samples * 0.2)
        expect(
          coverage.gaps,
          `${label} outline is solid, not dashed (${coverage.painted}/${coverage.samples} painted)`,
        ).toBeGreaterThan(coverage.samples * 0.2)
      }
      // The round shot keeps the handoff's plain surface name; the square one
      // names its blank so the two are not mistaken for each other.
      await shoot(page, shape === 'round' ? 'top-side-views-landscape' : `top-side-views-${shape}-landscape`)

      // ── Tapping the side view selects the model: the outline is a real target ──
      const canvas = page.locator('canvas.sketch-canvas')
      for (const [label, box, feature] of [
        ['Turn', turnBox, turn],
        ['Polygon', polygonBox, polygon],
      ] as const) {
        const screen = await stockPoint(page, (box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2)
        const canvasBox = (await canvas.boundingBox())!
        await canvas.tap({ position: { x: screen.x - canvasBox.x, y: screen.y - canvasBox.y } })
        await expect(
          page.locator(`.tree-row--feature[data-feature-id="${feature.id}"].tree-row--selected`),
          `${label} side view did not select by tap`,
        ).toHaveCount(1)
      }
    })
  }

  /**
   * A fixed-position clipping fixture: `container` is the box around the
   * surface, `content` the surface's own style, `wrap` an optional intermediate
   * element (used to give a scroller more content than the surface). The surface
   * keeps the id, so the locator is stable. Returns the surface locator.
   */
  async function clipFixture(
    page: Page,
    fixture: {
      id: string
      container: string
      content: string
      wrap?: string
      scrollLeft?: number
    },
  ): Promise<Locator> {
    await page.evaluate((spec) => {
      document.querySelector(`#${spec.id}`)?.parentElement?.remove()
      const container = document.createElement('div')
      container.id = `${spec.id}-box`
      container.style.cssText = spec.container
      const surface = document.createElement('div')
      surface.id = spec.id
      surface.style.cssText = spec.content
      if (spec.wrap) {
        const wrap = document.createElement('div')
        wrap.style.cssText = spec.wrap
        wrap.appendChild(surface)
        container.appendChild(wrap)
      } else {
        container.appendChild(surface)
      }
      document.body.appendChild(container)
      if (spec.scrollLeft) container.scrollLeft = spec.scrollLeft
    }, fixture)
    const surface = page.locator(`#${fixture.id}`)
    await expect(surface).toHaveCount(1)
    return surface
  }

  /** Remove a fixture built by {@link clipFixture}. */
  async function removeClipFixture(page: Page, id: string): Promise<void> {
    await page.evaluate((fixtureId) => {
      document.querySelector(`#${fixtureId}`)?.parentElement?.remove()
    }, id)
  }

  /**
   * An off-screen fixture with **no clipping ancestor**: the surface lives in an
   * open shadow root, so {@link tabletFitReport}'s `parentElement` walk ends at
   * the root and never reaches the page's own `overflow: hidden` body. That is
   * the point — on a body-attached fixture the page would report
   * `clipped-hidden` and the missing viewport check would never be exercised
   * (#1112 rt4-a fix3 review F1). Playwright's CSS engine pierces open shadow
   * roots, so the returned locator is the real surface.
   */
  async function shadowFixture(
    page: Page,
    fixture: { id: string; content: string },
  ): Promise<Locator> {
    await page.evaluate((spec) => {
      document.querySelector(`#${spec.id}-host`)?.remove()
      const host = document.createElement('div')
      host.id = `${spec.id}-host`
      document.body.appendChild(host)
      const surface = document.createElement('div')
      surface.id = spec.id
      surface.style.cssText = `position: fixed; ${spec.content}`
      host.attachShadow({ mode: 'open' }).appendChild(surface)
    }, fixture)
    const surface = page.locator(`#${fixture.id}`)
    await expect(surface).toHaveCount(1)
    return surface
  }

  /** Remove a fixture built by {@link shadowFixture}. */
  async function removeShadowFixture(page: Page, id: string): Promise<void> {
    await page.evaluate((fixtureId) => {
      document.querySelector(`#${fixtureId}-host`)?.remove()
    }, id)
  }

  /**
   * Pins the fit helper's contract (#1112 rt4-a review F3): a surface cut off
   * at the side must not be excused by a vertically scrolling ancestor. The
   * fixture is exactly the shape the old helper accepted — a 900px-wide block
   * inside a 200px-wide, vertically scrolling, horizontally hidden box at the
   * right edge of the window — so restoring "any scrolling ancestor counts"
   * makes this test fail.
   */
  test('the fit helper refuses a surface clipped sideways inside a vertical scroller', async ({ app }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    const clipped = await clipFixture(page, {
      id: 'e2e-horizontal-clip',
      // Fixed near the right edge: the child's layout box runs past the window
      // while the scroller itself fits, which is what the old helper saw.
      container: 'position:fixed;left:700px;top:20px;width:200px;height:120px;'
        + 'overflow-x:hidden;overflow-y:auto;z-index:2147483647',
      content: 'width:900px;height:400px;background:#333',
    })
    // Vertical scrolling exists and its container fits the window: only the
    // sideways clipping is wrong, and that alone must be reported.
    const report = await clipped.evaluate(tabletFitReport, LANDSCAPE)
    expect(report.vertical.issues, 'a vertical scroller alone is fine').toEqual([])
    expect(report.horizontal.issues.length, 'the sideways clip').toBeGreaterThan(0)
    await assert.rejects(
      expectReachable(page, clipped, 'clipped fixture'),
      /sideways/,
    )
    await removeClipFixture(page, 'e2e-horizontal-clip')
  })

  /**
   * F1a (#1112 rt4-a fix2 review): a surface can pass the old check by having
   * its own box inside the window while an `overflow: hidden` ancestor cuts a
   * third of it away. The early "inside the viewport" return skipped the
   * ancestor walk, so this 400px surface inside a 200px hidden box was accepted
   * although half of it can never be seen. Removing the ancestor walk makes the
   * two assertions below disagree and the test fail.
   */
  test('the fit helper refuses a surface its own box fits but an ancestor clips', async ({ app }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    const clipped = await clipFixture(page, {
      id: 'e2e-hidden-clip',
      container: 'position:fixed;left:100px;top:20px;width:200px;height:120px;'
        + 'overflow:hidden;z-index:2147483647',
      content: 'width:400px;height:100px;background:#333',
    })
    // The false pass: the surface's own box is comfortably inside 1180 × 820.
    await expectInsideViewport(page, clipped, 'hidden-clipped fixture')
    const report = await clipped.evaluate(tabletFitReport, LANDSCAPE)
    expect(report.vertical.issues, 'nothing vertical is wrong with the fixture').toEqual([])
    expect(report.horizontal.issues.length, 'the hidden ancestor still clips it').toBeGreaterThan(0)
    await assert.rejects(
      expectReachable(page, clipped, 'hidden-clipped fixture'),
      /sideways/,
    )
    await removeClipFixture(page, 'e2e-hidden-clip')
  })

  /**
   * F1b (#1112 rt4-a fix2 review): the old `reachable` test compared the scroll
   * distance with the scroll range and so accepted any surface a scroller could
   * move, even one wider than the port itself. A 900px surface in a 200px
   * horizontal scroller needs 700px of a 700px range — and can still never be
   * seen whole. Horizontal containment is what refuses it.
   */
  test('the fit helper refuses a surface wider than the horizontal scroller meant to show it', async ({ app }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    const clipped = await clipFixture(page, {
      id: 'e2e-narrow-scroller',
      container: 'position:fixed;left:700px;top:20px;width:200px;height:120px;'
        + 'overflow-x:auto;overflow-y:hidden;z-index:2147483647',
      content: 'width:900px;height:100px;background:#333',
    })
    const box = (await clipped.boundingBox())!
    expect(box.width, 'the surface is wider than the port').toBeGreaterThan(200)
    const report = await clipped.evaluate(tabletFitReport, LANDSCAPE)
    expect(report.horizontal.issues.length, 'containment, not scroll range, decides').toBeGreaterThan(0)
    await assert.rejects(
      expectReachable(page, clipped, 'narrow-scroller fixture'),
      /sideways/,
    )
    await removeClipFixture(page, 'e2e-narrow-scroller')
  })

  /**
   * The other half of F1: refusing a scroller that cannot show the surface whole
   * must not refuse one that can. Here 300px sits in a 400px horizontal port
   * with 100px of range and 50px to scroll, so the whole surface is reachable —
   * and the ancestor walk (which no longer returns early on a fitting box) has
   * to leave it alone.
   */
  test('the fit helper accepts a surface its horizontal scroller can show in full', async ({ app }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    const surface = await clipFixture(page, {
      id: 'e2e-reachable-scroller',
      container: 'position:fixed;left:100px;top:20px;width:400px;height:120px;'
        + 'overflow-x:auto;overflow-y:hidden;z-index:2147483647',
      wrap: 'width:500px;height:100px',
      content: 'width:300px;height:80px;margin-left:150px;background:#333',
    })
    const report = await surface.evaluate(tabletFitReport, LANDSCAPE)
    expect(report.horizontal.issues, 'a scroller that can show it whole is fine').toEqual([])
    expect(report.vertical.issues, 'nothing vertical is wrong with the fixture').toEqual([])
    await expectReachable(page, surface, 'reachable-scroller fixture')
    await removeClipFixture(page, 'e2e-reachable-scroller')
  })

  /**
   * The line the new viewport check must not cross: a surface below the fold is
   * fine when its own scroller is inside the window and can carry it up — that
   * is the handoff's "scrolling inside the panel is fine if it scrolls". The
   * surface itself spans y = 700–900 in an 820px window, so a check against the
   * surface's own box (rather than the part its scroller can show) would refuse
   * a legitimate panel; the 400px needed is inside the 600px range.
   */
  test('the fit helper accepts a below-the-fold surface its vertical scroller can reach', async ({ app }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    const surface = await clipFixture(page, {
      id: 'e2e-below-fold-reachable',
      container: 'position:fixed;left:100px;top:100px;width:300px;height:400px;'
        + 'overflow-x:hidden;overflow-y:auto;z-index:2147483647',
      wrap: 'width:300px;height:1000px;padding-top:600px;box-sizing:border-box',
      content: 'width:300px;height:200px;background:#333',
    })
    const box = (await surface.boundingBox())!
    expect(box.y, 'the surface starts below the scroller port').toBeGreaterThan(500)
    expect(box.y + box.height, 'the surface itself runs past the window').toBeGreaterThan(LANDSCAPE.height)
    const report = await surface.evaluate(tabletFitReport, LANDSCAPE)
    expect(report.vertical.issues, 'its scroller can carry it into the window').toEqual([])
    expect(report.horizontal.issues, 'nothing sideways is wrong with the fixture').toEqual([])
    await expectReachable(page, surface, 'below-fold-reachable fixture')
    await removeClipFixture(page, 'e2e-below-fold-reachable')
  })

  /**
   * F1 (#1112 rt4-a fix3 review): ending the ancestor walk used to mean
   * "nothing is wrong", so a surface painted entirely past the right edge of
   * the window passed. Nothing can scroll it back in: there is no scroller on
   * that axis at all. The fixture is the exact reproduction from the review —
   * a 400px surface starting at x = 1100 in a 1180px viewport — and the numbers
   * are asserted on the box first, so a fixture that stopped being off-screen
   * fails before it can pass vacuously. Removing the post-walk viewport check
   * leaves `issues` empty and fails the reason assertion.
   */
  test('the fit helper refuses a surface painted past the right edge with no scroller', async ({ app }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    const offscreen = await shadowFixture(page, {
      id: 'e2e-offscreen-x',
      content: 'left: 1100px; top: 20px; width: 400px; height: 100px; background: #333',
    })
    const box = (await offscreen.boundingBox())!
    expect(box.x, 'the fixture starts inside the window').toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, 'the fixture really runs past the right edge').toBeGreaterThan(LANDSCAPE.width)

    const report = await offscreen.evaluate(tabletFitReport, LANDSCAPE)
    expect(report.horizontal.withinViewport, 'the surface itself is off-screen').toBe(false)
    expect(report.vertical.issues, 'nothing vertical is wrong with the fixture').toEqual([])
    expect(
      report.horizontal.issues.map((issue) => issue.reason),
      'an off-screen surface is unreachable without a scroller',
    ).toEqual(['outside-viewport'])
    expect(report.horizontal.issues[0].detail, 'the finding names the axis').toMatch(/sideways/)
    // The assertion the spec uses (`expectReachable`) checks exactly this list.
    await assert.rejects(expectReachable(page, offscreen, 'off-screen fixture'), /sideways/)
    await removeShadowFixture(page, 'e2e-offscreen-x')

    // The same hole on the other side: a surface painted past the left edge.
    const offLeft = await shadowFixture(page, {
      id: 'e2e-offscreen-x-negative',
      content: 'left: -200px; top: 20px; width: 400px; height: 100px; background: #333',
    })
    const leftReport = await offLeft.evaluate(tabletFitReport, LANDSCAPE)
    expect(leftReport.horizontal.withinViewport, 'the surface itself is off-screen').toBe(false)
    expect(
      leftReport.horizontal.issues.map((issue) => issue.reason),
      'a surface past the left edge is unreachable too',
    ).toEqual(['outside-viewport'])
    expect(leftReport.horizontal.issues[0].detail).toMatch(/sideways/)
    await assert.rejects(expectReachable(page, offLeft, 'left-off-screen fixture'), /sideways/)
    await removeShadowFixture(page, 'e2e-offscreen-x-negative')
  })

  /**
   * The vertical half of F1: the same hole below the bottom edge. The surface
   * spans y = 760–960 in an 820px window and no ancestor clips it, so only the
   * viewport itself can refuse it. Without the post-walk check this reports no
   * issue on either axis and the surface passes as "reachable".
   */
  test('the fit helper refuses a surface painted below the bottom edge with no scroller', async ({ app }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    const offscreen = await shadowFixture(page, {
      id: 'e2e-offscreen-y',
      content: 'left: 20px; top: 760px; width: 100px; height: 200px; background: #333',
    })
    const box = (await offscreen.boundingBox())!
    expect(box.y, 'the fixture starts inside the window').toBeGreaterThanOrEqual(0)
    expect(box.y + box.height, 'the fixture really runs past the bottom edge').toBeGreaterThan(LANDSCAPE.height)

    const report = await offscreen.evaluate(tabletFitReport, LANDSCAPE)
    expect(report.vertical.withinViewport, 'the surface itself is off-screen').toBe(false)
    expect(report.horizontal.issues, 'nothing sideways is wrong with the fixture').toEqual([])
    expect(
      report.vertical.issues.map((issue) => issue.reason),
      'an off-screen surface is unreachable without a scroller',
    ).toEqual(['outside-viewport'])
    expect(report.vertical.issues[0].detail, 'the finding names the axis').toMatch(/vertically/)
    await assert.rejects(expectReachable(page, offscreen, 'off-screen fixture'), /vertically/)
    await removeShadowFixture(page, 'e2e-offscreen-y')

    // The same hole above the top edge.
    const offTop = await shadowFixture(page, {
      id: 'e2e-offscreen-y-negative',
      content: 'left: 20px; top: -200px; width: 100px; height: 400px; background: #333',
    })
    const topReport = await offTop.evaluate(tabletFitReport, LANDSCAPE)
    expect(topReport.vertical.withinViewport, 'the surface itself is off-screen').toBe(false)
    expect(
      topReport.vertical.issues.map((issue) => issue.reason),
      'a surface past the top edge is unreachable too',
    ).toEqual(['outside-viewport'])
    expect(topReport.vertical.issues[0].detail).toMatch(/vertically/)
    await assert.rejects(expectReachable(page, offTop, 'top-off-screen fixture'), /vertically/)
    await removeShadowFixture(page, 'e2e-offscreen-y-negative')
  })

})

// ── Portrait tablet ───────────────────────────────────────────────────

test.describe('portrait tablet (820 × 1180, touch)', () => {
  test.use({ viewport: PORTRAIT, hasTouch: true })

  test('the shell asks for landscape instead of drawing a cut-off layout', async ({ app }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    // The rotate prompt is the whole portrait answer: no surface is reachable
    // behind it (the overlay is a full-viewport, top-most element).
    const overlay = page.locator('.tablet-rotate-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay).toHaveText(/rotate your device/i)
    await expectInsideViewport(page, overlay, 'rotate prompt')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-shell-mode', 'tablet-compact')
    expect(await page.evaluate(() => matchMedia('(orientation: portrait)').matches)).toBe(true)
    // What the prompt promises is that nothing behind it is reachable: it is
    // the topmost element across the viewport. Whether the landscape shell
    // underneath happens to overflow 820px is deliberately **not** asserted —
    // pinning that would make a future layout fix fail, and the refusal is the
    // overlay's job, not the width's (#1112 rt4-a review F4).
    const probes = await page.evaluate(() => {
      const points: [number, number][] = [[410, 590], [40, 40], [780, 1140]]
      return points.map(([x, y]) => ({
        x,
        y,
        covered: Boolean(document.elementFromPoint(x, y)?.closest('.tablet-rotate-overlay')),
      }))
    })
    expect(
      probes.every((probe) => probe.covered),
      `the portrait prompt does not cover the shell: ${JSON.stringify(probes)}`,
    ).toBe(true)
    await shoot(page, 'rotate-prompt-portrait')
  })

  /**
   * Both blanks run here too: a square blank's Turn/Polygon form asks the same
   * questions but is measured against a different side, and "does it fit 820px"
   * is a question about the form, not about the blank (#1112 rt4-a fix2 review
   * F2).
   */
  for (const shape of ['round', 'square'] as const) {
    test(`the Turn and Polygon panels still fit a portrait viewport (${shape} blank)`, async ({ app }) => {
      const { page } = app
      await seedBar(page, shape)

      // Opened through the store: a pointer cannot reach the rail behind the
      // prompt, but the form's own layout is exactly what turning the device
      // would show, so its size and fit are worth asserting.
      for (const kind of ['turn', 'polygon'] as const) {
        await page.evaluate(async (next: 'turn' | 'polygon') => {
          const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
          useProjectStore.getState().startAddRotarySolidPlacement(next)
        }, kind)
        const panel = page.locator('.rotary-solid-panel')
        await expect(panel).toBeVisible()
        await expectTouchTargets(page, '.rotary-solid-panel')
        await expectInsideViewport(page, panel, `${kind} panel (portrait, ${shape} blank)`)
        await expectBodyScrollsWhenTall(page, '.rotary-solid-panel')
        // Screenshot only: a portrait tablet shows the prompt, so the overlay is
        // lifted for this shot to show the layout the manager asked to see.
        await page.evaluate(() => {
          document.querySelector('.tablet-rotate-overlay')?.setAttribute('style', 'display: none')
        })
        await shoot(page, `${kind}-create-${shape}-portrait`)
        await page.evaluate(() => {
          document.querySelector('.tablet-rotate-overlay')?.removeAttribute('style')
        })
        await page.evaluate(async () => {
          const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
          useProjectStore.getState().cancelPendingAdd()
        })
        await expect(panel).toHaveCount(0)
      }
    })
  }

  test('the top-bar face control stays inside a portrait viewport', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    // The portrait shell is a landscape layout in an 820px window, and the face
    // control rides in the top command bar (issue #1112 rt5-a). What is worth
    // pinning is that the control is there at all, that a tablet pointer target
    // keeps its size, and that the *document* never scrolls sideways (the rotate
    // prompt, not a horizontal scrollbar, is the portrait answer). Whether the
    // control happens to be off-screen behind the prompt is not asserted: a
    // future portrait layout that fits must not fail this test
    // (#1112 rt4-a review F4).
    const control = ui.face.current(page)
    await expect(ui.face.topBarControl(page)).toBeVisible()
    await expect(control).toBeVisible()
    const box = await control.boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(TOUCH_TARGET)
    expect(box!.width).toBeGreaterThanOrEqual(TOUCH_TARGET)
    const page_width = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(page_width.scrollWidth, 'portrait document scrolls sideways').toBeLessThanOrEqual(page_width.clientWidth + 1)
    await page.evaluate(() => {
      document.querySelector('.tablet-rotate-overlay')?.setAttribute('style', 'display: none')
    })
    await shoot(page, 'face-control-portrait')
  })
})
