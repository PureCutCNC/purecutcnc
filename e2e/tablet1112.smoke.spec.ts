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
 *    at the side).
 *  - (c) the surface's main action works by tap alone (`tap()`, never hover).
 *
 * A screenshot of each surface is written to `work/tablet-shots/`. `work/` is
 * gitignored, so nothing is committed from it.
 *
 * The handoff's surface list applies to a round bar **and** a square blank, so
 * the fixtures come in both shapes: the round-bar tests cover every surface,
 * and the square-blank tests re-run the parts whose DOM or geometry actually
 * depends on the blank (the Turn/Polygon forms and the side views drawn on
 * Top). Context menu, Cuts list, header face control, simulation info and chuck
 * properties render the same controls on either blank and are covered once.
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
 * One scrollable ancestor on one axis, and whether it can bring `element` into
 * view on that axis.
 */
interface ScrollPath {
  axis: 'x' | 'y'
  /** The container itself lies inside the viewport on that axis. */
  inside: boolean
  /** Scrolling it as far as it goes brings the surface fully inside it. */
  reachable: boolean
  /** Pixels of scrolling needed from where it is now (negative = scroll back). */
  needed: number
  /** The furthest it can scroll. */
  maxScroll: number
  rect: { left: number; right: number; top: number; bottom: number }
}

/**
 * The nearest ancestor that scrolls `element` back into view on each axis,
 * answered **separately**. A vertical scroller must never make a surface
 * clipped at the side look reachable: that was the hole in the first version
 * of {@link expectReachable} (#1112 rt4-a review F3).
 */
async function scrollPaths(
  page: Page,
  locator: Locator,
): Promise<{ horizontal: ScrollPath | null; vertical: ScrollPath | null }> {
  return locator.evaluate((element) => {
    function path(axis: 'x' | 'y'): ScrollPath | null {
      const box = element.getBoundingClientRect()
      let node: HTMLElement | null = (element as HTMLElement).parentElement
      while (node) {
        const style = getComputedStyle(node)
        const overflow = axis === 'x' ? style.overflowX : style.overflowY
        const scrollSize = axis === 'x' ? node.scrollWidth : node.scrollHeight
        const clientSize = axis === 'x' ? node.clientWidth : node.clientHeight
        if (scrollSize > clientSize + 1 && (overflow === 'auto' || overflow === 'scroll')) {
          const rect = node.getBoundingClientRect()
          const start = axis === 'x' ? rect.left : rect.top
          const end = axis === 'x' ? rect.right : rect.bottom
          const elementStart = axis === 'x' ? box.left : box.top
          const elementEnd = axis === 'x' ? box.right : box.bottom
          const scroll = axis === 'x' ? node.scrollLeft : node.scrollTop
          const maxScroll = scrollSize - clientSize
          const needed = elementEnd > end
            ? elementEnd - end + scroll
            : elementStart < start
              ? elementStart - start + scroll
              : 0
          return {
            axis,
            inside: axis === 'x'
              ? rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5
              : rect.top >= -0.5 && rect.bottom <= window.innerHeight + 0.5,
            // A surface wider (or taller) than the scroll port can never be
            // brought fully into view, however far the container scrolls.
            reachable: needed >= -0.5 && needed <= maxScroll + 0.5,
            needed: Math.round(needed),
            maxScroll: Math.round(maxScroll),
            rect: {
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              top: Math.round(rect.top),
              bottom: Math.round(rect.bottom),
            },
          }
        }
        node = node.parentElement
      }
      return null
    }
    return { horizontal: path('x'), vertical: path('y') }
  })
}

/**
 * (b) For a surface that lives inside a drawer: it must be reachable — fully
 * inside the viewport, or cut off only inside a scrollable container that is
 * itself inside the viewport ("scrolling inside the panel is fine if it
 * scrolls", per the handoff). Each axis is checked on its own: a surface cut
 * off at the right edge needs something that scrolls **sideways**, however
 * much the drawer scrolls up and down. A surface painted past the window edge
 * with nothing to scroll, on either axis, is the failure this catches.
 */
async function expectReachable(page: Page, locator: Locator, label: string): Promise<void> {
  const box = await locator.boundingBox()
  expect(box, `${label} has no box`).not.toBeNull()
  const viewport = page.viewportSize()!
  const withinX = box!.x >= -0.5 && box!.x + box!.width <= viewport.width + 0.5
  const withinY = box!.y >= -0.5 && box!.y + box!.height <= viewport.height + 0.5
  if (withinX && withinY) return
  const paths = await scrollPaths(page, locator)
  if (!withinX) {
    expect(
      paths.horizontal,
      `${label} runs past the ${viewport.width}px viewport width with nothing to scroll sideways`,
    ).not.toBeNull()
    expect(
      paths.horizontal!.inside,
      `${label}'s horizontal scroll container is itself off-screen: ${JSON.stringify(paths.horizontal!.rect)}`,
    ).toBe(true)
    expect(
      paths.horizontal!.reachable,
      `${label} cannot be scrolled into view sideways: `
        + `needs ${paths.horizontal!.needed}px, ${paths.horizontal!.maxScroll}px available`,
    ).toBe(true)
  }
  if (!withinY) {
    expect(
      paths.vertical,
      `${label} runs past the ${viewport.height}px viewport height with nothing to scroll`,
    ).not.toBeNull()
    expect(
      paths.vertical!.inside,
      `${label}'s scroll container is itself off-screen: ${JSON.stringify(paths.vertical!.rect)}`,
    ).toBe(true)
    expect(
      paths.vertical!.reachable,
      `${label} cannot be scrolled into view: `
        + `needs ${paths.vertical!.needed}px, ${paths.vertical!.maxScroll}px available`,
    ).toBe(true)
  }
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

  test('the Turn edit panel opens from Properties and saves by tap', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
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
    expect(editBox!.height).toBeGreaterThanOrEqual(TOUCH_TARGET)

    await editTurn.tap()
    const panel = ui.rotarySolid.dialog(page)
    await expect(panel).toBeVisible()
    // The stored numbers are what the form opened with.
    await expect(page.locator('#rotary-solid-length')).toHaveValue('40')
    await expect(page.locator('#rotary-solid-diameter')).toHaveValue('10')
    await expectTouchTargets(page, '.rotary-solid-panel')
    await expectInsideViewport(page, panel, 'Turn edit panel')
    await shoot(page, 'turn-edit-landscape')

    // A change is saved with the panel's own action, by tap.
    await page.locator('#rotary-solid-length').fill('30')
    await ui.rotarySolid.createButton(page).tap()
    await expect(panel).toHaveCount(0)
    const edited = await getProject(page) as unknown as Project
    const stored = edited.featureDefinitions[edited.features[0].definitionId].canned
    expect((stored!.params as Record<string, unknown>).length).toBe(30)
  })

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
      await seedProject(page, JSON.stringify(barProject(shape)))
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

  test('the feature context menu is touch-sized on a canned shape and names the other face', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
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
    await expectInsideViewport(page, menu, 'context menu (canned shape)')
    await shoot(page, 'context-menu-canned-landscape')

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
    // Nothing here edits a model authored on the other face.
    await expect(ui.contextMenu.itemExact(ghostMenu, 'Edit turn…')).toHaveCount(0)
    await expectTouchTargets(page, '.feature-context-menu')
    await expectInsideViewport(page, ghostMenu, 'context menu (other face)')
    await shoot(page, 'context-menu-other-face-landscape')
    await page.keyboard.press('Escape')
  })

  test('the operation Cuts list is touch-sized and removes a target by tap', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
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
    const rows = cuts.locator('.cam-cuts__row')
    await expect(rows).toHaveCount(2)
    // Every row carries the target's icon, its name (visible, not squeezed to
    // nothing by the ×) and a remove ×.
    for (const row of await rows.all()) {
      await expect(row.locator('.cam-cuts__icon')).toBeVisible()
      await expect(row.locator('.cam-cuts__name')).toBeVisible()
      await expect(row.locator('.cam-cuts__remove')).toBeEnabled()
    }
    await expectTouchTargets(page, '.cam-cuts')
    await expectReachable(page, cuts, 'Cuts list')
    await cuts.scrollIntoViewIfNeeded()
    await shoot(page, 'operation-cuts-landscape')

    const removedName = (await rows.first().locator('.cam-cuts__name').textContent())!.trim()
    await rows.first().locator('.cam-cuts__remove').tap()
    await expect(rows).toHaveCount(1)
    await expect(rows.first().locator('.cam-cuts__name')).not.toHaveText(removedName)
    // The last target cannot be removed: its × is disabled, with the reason as
    // its title.
    await expect(rows.first().locator('.cam-cuts__remove')).toBeDisabled()
    const afterRemoval = await getProject(page) as unknown as Project
    expect(afterRemoval.operations[0].target.source).toBe('features')
    expect((afterRemoval.operations[0].target as { featureIds: string[] }).featureIds).toHaveLength(1)
  })

  test('the header face control is touch-sized and the CAM panel opens from its own button', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))

    // The one face control sits at the right end of the tab row.
    const control = ui.face.current(page)
    await expect(ui.face.tabBarControl(page)).toBeVisible()
    await expect(control).toBeVisible()
    const box = await control.boundingBox()
    expect(box!.height, 'face control height').toBeGreaterThanOrEqual(TOUCH_TARGET)
    expect(box!.width, 'face control width').toBeGreaterThanOrEqual(TOUCH_TARGET)
    await expectInsideViewport(page, control, 'face control')
    await shoot(page, 'face-control-landscape')

    // Opening it is a tap, and its entries are touch-sized on the tablet shell.
    await control.tap()
    await expect(ui.face.menu(page)).toBeVisible()
    await expectTouchTargets(page, '.face-switch__menu')
    await expectInsideViewport(page, ui.face.menu(page), 'face menu')
    await ui.face.item(page, 'Bottom').tap()
    await expect(control).toHaveAttribute('data-face', 'bottom')

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

  test('the simulation toolbar explains fresh stock behind a 44px info button', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))

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
    await shoot(page, 'simulation-info-landscape')
  })

  test('chuck properties on a bar are touch-sized', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    await openProjectDrawer(page)
    await page.locator('.tree-row--clamp').first().tap()

    const size = ui.properties.chuckSize(page)
    await expect(size).toBeVisible()
    await expect(page.getByTestId('chuck-jaws')).toBeVisible()
    // Size, jaws and both ends of the clamping range are all real controls.
    await expectTouchTargets(page, '.properties-panel')
    await expectReachable(page, page.locator('.properties-panel'), 'chuck properties')
    await page.locator('[data-testid="chuck-size"]').scrollIntoViewIfNeeded()
    await shoot(page, 'chuck-properties-landscape')

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
   * suppress the tap's compatibility click); un-fixme once that lands.
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
      await seedProject(page, JSON.stringify(barProject(shape)))
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
    const clipped = page.locator('#e2e-horizontal-clip')
    await page.evaluate(() => {
      const scroller = document.createElement('div')
      scroller.id = 'e2e-vertical-scroller'
      // Fixed near the right edge: the child's layout box runs past the window
      // while the scroller itself fits, which is what the old helper saw.
      scroller.style.cssText = 'position:fixed;left:700px;top:20px;width:200px;height:120px;'
        + 'overflow-x:hidden;overflow-y:auto;z-index:2147483647'
      const content = document.createElement('div')
      content.id = 'e2e-horizontal-clip'
      content.style.cssText = 'width:900px;height:400px;background:#333'
      scroller.appendChild(content)
      document.body.appendChild(scroller)
    })
    await expect(clipped).toHaveCount(1)
    // Vertical scrolling exists and its container fits the window: only the
    // sideways clipping is wrong, and that alone must be reported.
    await assert.rejects(
      expectReachable(page, clipped, 'clipped fixture'),
      /sideways/,
    )
    await page.evaluate(() => document.querySelector('#e2e-vertical-scroller')?.remove())
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

  test('the Turn and Polygon panels still fit a portrait viewport', async ({ app }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))

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
      await expectInsideViewport(page, panel, `${kind} panel (portrait)`)
      await expectBodyScrollsWhenTall(page, '.rotary-solid-panel')
      // Screenshot only: a portrait tablet shows the prompt, so the overlay is
      // lifted for this shot to show the layout the manager asked to see.
      await page.evaluate(() => {
        document.querySelector('.tablet-rotate-overlay')?.setAttribute('style', 'display: none')
      })
      await shoot(page, `${kind}-create-portrait`)
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

  test('the header face control stays inside a portrait viewport', async ({ app, ui }) => {
    const { page } = app
    await seedProject(page, JSON.stringify(barProject()))
    // The portrait shell is a landscape layout in an 820px window, and the face
    // control sits at the right end of its row. What is worth pinning is that a
    // tablet pointer target keeps its size there and that the *document* never
    // scrolls sideways (the rotate prompt, not a horizontal scrollbar, is the
    // portrait answer). Whether the control happens to be off-screen behind the
    // prompt is not asserted: a future portrait layout that fits must not fail
    // this test (#1112 rt4-a review F4).
    const control = ui.face.current(page)
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
