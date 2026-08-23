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
 * Feed-coloured toolpath smoke (issue #498 S4, extended by S5).
 *
 * Asserts the load-bearing rendering contract on the sketch canvas pixels:
 * with the feed-colour toggle on, a pocket in `engagement` mode draws its
 * cut segments in more than one distinct colour; a slots-only pocket draws them
 * in exactly one. Pixel comparisons are between full-canvas samples of the same
 * fixture with only the toggle flipped, so the test needs no colour math — any
 * palette change re-verifies against the live ramp rather than against
 * hardcoded values. The S5 test adds a non-40% slot feed and pins the legend
 * to the rungs the engine actually emits for that setting.
 */

import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { seedProject } from './helpers'

/** A pixel colour is "dominant" when it covers at least this many canvas
 *  pixels — antialiased edges and single-pixel noise fall below it, interior
 *  runs of the 2.5px emphasized cut lines sit far above it. */
const MIN_GROUP_PIXELS = 30

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
 * The two fixture variants differ only in pocket feed mode. The engagement
 * variant emits the full bucket ladder (verified against the engine: distinct
 * cut scales 0.88 / 0.64 / 0.40 plus full-feed moves); the slots-only variant
 * emits no scaled moves at all, so its cuts must stay a single colour.
 * `slotPercent` varies the engagement ladder's slot feed (issue #498 S5): the
 * emitted rungs and the legend both derive from it.
 *
 * The slots-only variant pins its slot feed to 100% explicitly: an unset
 * `pocketSlotFeedPercent` is normalized to the app default of 60% on load
 * (issue #524), which makes the engine stamp its full-width slot stretches
 * with a scaled feed — real product behaviour, but not the "no scaled moves"
 * contract this variant exists to pin. 100% is the engine's no-feed anchor
 * (`resolveSlotFeedScale` returns null there), so the move stream carries no
 * feed scales and toggling feed colours must not change the canvas.
 *
 * Since #535 the legend is data-driven: it prints the union of the (scale,
 * step) pairs actually emitted by the toolpaths in the preview — a slots-only
 * pocket at 60% contributes its single slot rung, an engagement pocket its
 * ladder, and a mixed preview both, independent of selection. The legend
 * renders only while feed colours are on.
 */
interface PocketOperationFixture {
  id: string
  name: string
  mode: 'slots_only' | 'engagement'
  slotPercent: number
}

function pocketOperationJson({ id, name, mode, slotPercent }: PocketOperationFixture): Record<string, unknown> {
  return {
    id,
    name,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f-machinable-subtract'] },
    toolRef: 'tool-1',
    stepdown: 0.1,
    stepover: 0.125,
    feed: 60,
    plungeFeed: 30,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    ...(mode === 'engagement'
      ? { pocketSlotFeedPercent: slotPercent, pocketFeedReduction: 'engagement' }
      : { pocketSlotFeedPercent: slotPercent, pocketFeedReduction: 'slots_only' }),
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
  }
}

function feedColoursProjectJson(label: string, operations: Record<string, unknown>[]): string {
  const now = '2026-01-01T00:00:00.000Z'
  return JSON.stringify({
    version: '3.0',
    meta: {
      name: `Feed Colours ${label} Fixture`,
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
      profile: resolvedRectProfile(0, 0, 24, 16),
      thickness: 0.2,
      material: 'aluminum_6061',
      color: '#b9a83c',
      visible: true,
      origin: { x: 0, y: 0 },
    },
    // Origin marker invisible so it cannot vary under toolpath pixels.
    origin: { name: 'Origin', x: 12, y: 8, z: 2, visible: false },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {
      'def-machinable-subtract': {
        id: 'def-machinable-subtract',
        kind: 'rect',
        profile: resolvedRectProfile(9, 6, 6, 4),
        dimensions: [],
        text: null,
        stl: null,
        operation: 'subtract',
      },
    },
    features: [
      {
        id: 'f-machinable-subtract',
        name: 'Machinable Subtract',
        definitionId: 'def-machinable-subtract',
        transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        constraints: [],
        folderId: null,
        z_top: 0.2,
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
    operations,
    tabs: [],
    clamps: [],
    ai_history: [],
  })
}

function buildFeedColoursProjectJson(mode: 'slots_only' | 'engagement', slotPercent = 40): string {
  return feedColoursProjectJson(mode, [
    pocketOperationJson({
      id: 'op-pocket-a',
      name: 'Pocket A',
      mode,
      slotPercent: mode === 'engagement' ? slotPercent : 100,
    }),
  ])
}

/** A slots-only pocket with an explicit slot feed below 100% — the classic
 *  path stamps its full-width slot stretches with exactly this scale, so the
 *  legend must show this single rung next to full feed. */
function buildSlotsOnlyAtSlotFeedProjectJson(slotPercent: number): string {
  return feedColoursProjectJson(`slots_only_${slotPercent}`, [
    pocketOperationJson({ id: 'op-pocket-a', name: 'Pocket A', mode: 'slots_only', slotPercent }),
  ])
}

/** Two pockets on the same feature: engagement at 75% (emits its ladder) plus
 *  slots-only at 60% (emits its single slot scale). The legend must show the
 *  union of both, whichever operation is selected. */
function buildMixedFeedColoursProjectJson(): string {
  return feedColoursProjectJson('mixed', [
    pocketOperationJson({ id: 'op-pocket-a', name: 'Pocket A', mode: 'engagement', slotPercent: 75 }),
    pocketOperationJson({ id: 'op-pocket-b', name: 'Pocket B', mode: 'slots_only', slotPercent: 60 }),
  ])
}

const ENGAGEMENT_FIXTURE_JSON = buildFeedColoursProjectJson('engagement')
const SLOTS_ONLY_FIXTURE_JSON = buildFeedColoursProjectJson('slots_only')
const SLOTS_ONLY_SLOT_FEED_60_JSON = buildSlotsOnlyAtSlotFeedProjectJson(60)
const MIXED_FIXTURE_JSON = buildMixedFeedColoursProjectJson()

/** Distinct pixel colours covering at least MIN_GROUP_PIXELS each. */
async function dominantPixelGroups(sketchCanvas: Locator): Promise<string[]> {
  return sketchCanvas.evaluate((canvas, minGroup) => {
    const element = canvas as HTMLCanvasElement
    const ctx = element.getContext('2d')
    if (!ctx) {
      throw new Error('sketch canvas has no 2d context')
    }
    const data = ctx.getImageData(0, 0, element.width, element.height).data
    const counts = new Map<string, number>()
    for (let index = 0; index < data.length; index += 4) {
      const key = `${data[index]},${data[index + 1]},${data[index + 2]},${data[index + 3]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const groups: string[] = []
    for (const [key, count] of counts) {
      if (count >= minGroup) {
        groups.push(key)
      }
    }
    return groups
  }, MIN_GROUP_PIXELS)
}

/** Wait for the canvas to repaint after a toggle click. */
async function waitForPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

async function sampleCanvas(page: Page, sketchCanvas: Locator): Promise<Set<string>> {
  // Keep the pointer off the canvas so no hover feedback lands in the sample.
  await page.mouse.move(0, 0)
  await waitForPaint(page)
  return new Set(await dominantPixelGroups(sketchCanvas))
}

test.describe('Feed-coloured toolpath smoke', () => {
  test('engagement pocket renders cut segments in multiple colours with the toggle on', async ({ app, ui }) => {
    await seedProject(app.page, ENGAGEMENT_FIXTURE_JSON)

    // The panel only renders once the generated toolpath exists.
    const panel = ui.toolpathVis.sketchPanel(app.page)
    await expect(panel).toBeVisible({ timeout: 30000 })

    const feedToggle = ui.toolpathVis.sketchItems(app.page).filter({ hasText: 'Feed colours' })
    await expect(feedToggle).toHaveCount(1)

    // Selecting the operation emphasizes its toolpath and defaults the
    // feed-colour toggle on (engagement mode).
    await ui.operations.rowByName(app.page, 'Pocket A').click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'true')

    // Baseline: explicit off.
    await feedToggle.click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'false')
    const offGroups = await sampleCanvas(app.page, ui.canvas.sketch(app.page))

    // Toggle on — the cut layer must gain at least two distinct ramp colours.
    await feedToggle.click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'true')
    const sketchCanvas = ui.canvas.sketch(app.page)
    await expect.poll(async () => {
      const onGroups = await dominantPixelGroups(sketchCanvas)
      return onGroups.filter((key) => !offGroups.has(key)).length
    }, { timeout: 10000 }).toBeGreaterThanOrEqual(2)
  })

  test('engagement pocket at 75% slot feed renders the derived ramp and legend', async ({ app, ui }) => {
    await seedProject(app.page, buildFeedColoursProjectJson('engagement', 75))

    const panel = ui.toolpathVis.sketchPanel(app.page)
    await expect(panel).toBeVisible({ timeout: 30000 })

    const feedToggle = ui.toolpathVis.sketchItems(app.page).filter({ hasText: 'Feed colours' })
    await expect(feedToggle).toHaveCount(1)

    // Selecting the operation emphasizes its toolpath and defaults the
    // feed-colour toggle on (engagement mode).
    await ui.operations.rowByName(app.page, 'Pocket A').click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'true')

    // The legend prints the rungs derived from the 75% slot feed, not the
    // hardcoded 40% ladder the engine no longer emits (issue #498 S5), and
    // since #535 it is data-driven: it lists only the rungs the emitted moves
    // actually carry. Since #591 the ladder is non-uniform, so the stretches
    // this geometry used to charge as one 95% rung now split across the two
    // finer top rungs (99% / 98%), and the 0.80/0.85-zone rung is absent
    // because minimum-fragment merges take the lower scale — nothing on the
    // canvas paints them and the legend must not claim them.
    await expect(panel.locator('.viewport-toolpath-vis__legend-step')).toHaveText([
      '100%', '99%', '98%', '90%', '85%', '75%',
    ])

    // Baseline: explicit off.
    await feedToggle.click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'false')
    const offGroups = await sampleCanvas(app.page, ui.canvas.sketch(app.page))

    // Toggle on — the cut layer must gain at least two distinct ramp colours.
    await feedToggle.click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'true')
    const sketchCanvas = ui.canvas.sketch(app.page)
    await expect.poll(async () => {
      const onGroups = await dominantPixelGroups(sketchCanvas)
      return onGroups.filter((key) => !offGroups.has(key)).length
    }, { timeout: 10000 }).toBeGreaterThanOrEqual(2)
  })

  test('slots-only pocket renders cut segments in exactly one colour with the toggle on', async ({ app, ui }) => {
    await seedProject(app.page, SLOTS_ONLY_FIXTURE_JSON)

    const panel = ui.toolpathVis.sketchPanel(app.page)
    await expect(panel).toBeVisible({ timeout: 30000 })

    const feedToggle = ui.toolpathVis.sketchItems(app.page).filter({ hasText: 'Feed colours' })
    await expect(feedToggle).toHaveCount(1)

    // A slots-only operation defaults the feed-colour toggle off.
    await ui.operations.rowByName(app.page, 'Pocket A').click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'false')

    const offGroups = await sampleCanvas(app.page, ui.canvas.sketch(app.page))

    // Toggle on — slots-only cuts carry no feed scale, so nothing may change.
    await feedToggle.click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'true')
    const onGroups = await sampleCanvas(app.page, ui.canvas.sketch(app.page))
    expect([...onGroups].sort()).toEqual([...offGroups].sort())

    // Guard against a vacuous pass: the off sample must contain real cut
    // pixels, proven by hiding the cuts layer and seeing the canvas change.
    const sketchCanvas = ui.canvas.sketch(app.page)
    const offKeys = [...offGroups].sort().join('|')
    await ui.toolpathVis.sketchItems(app.page).first().click()
    await expect.poll(async () => {
      const hiddenGroups = await dominantPixelGroups(sketchCanvas)
      return [...hiddenGroups].sort().join('|') !== offKeys
    }, { timeout: 10000 }).toBe(true)
  })

  test('slots-only pocket at 60% slot feed shows only its emitted rung and hides the legend when the toggle is off', async ({ app, ui }) => {
    await seedProject(app.page, SLOTS_ONLY_SLOT_FEED_60_JSON)

    const panel = ui.toolpathVis.sketchPanel(app.page)
    await expect(panel).toBeVisible({ timeout: 30000 })

    const feedToggle = ui.toolpathVis.sketchItems(app.page).filter({ hasText: 'Feed colours' })
    await expect(feedToggle).toHaveCount(1)

    // A slots-only operation defaults the feed-colour toggle off — and with
    // feed colours off there is nothing for a legend to explain (issue #535).
    await ui.operations.rowByName(app.page, 'Pocket A').click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(panel.locator('.viewport-toolpath-vis__legend')).toHaveCount(0)

    // On: the classic path emitted exactly one scale — the 60% slot feed — so
    // the legend is full feed plus that single rung, not the 6-rung ladder.
    await feedToggle.click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.locator('.viewport-toolpath-vis__legend-step')).toHaveText(['100%', '60%'])

    await feedToggle.click()
    await expect(panel.locator('.viewport-toolpath-vis__legend')).toHaveCount(0)
  })

  test('mixed pockets show the union of emitted scales in both panels, independent of selection', async ({ app, ui }) => {
    await seedProject(app.page, MIXED_FIXTURE_JSON)

    const panel = ui.toolpathVis.sketchPanel(app.page)
    await expect(panel).toBeVisible({ timeout: 30000 })

    const feedToggle = ui.toolpathVis.sketchItems(app.page).filter({ hasText: 'Feed colours' })
    await expect(feedToggle).toHaveCount(1)

    // The union of the engagement ladder (this fixture's geometry emits the
    // fine top rungs but skips the mid zone — see the 75% test) and the
    // slots-only pocket's 60% rung, whichever operation is selected.
    const unionSteps = ['100%', '99%', '98%', '90%', '85%', '75%', '60%']

    // Selecting the engagement pocket defaults the toggle on; the legend is
    // the union of the engagement ladder and the slots-only pocket's 60% rung.
    await ui.operations.rowByName(app.page, 'Pocket A').click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.locator('.viewport-toolpath-vis__legend-step')).toHaveText(unionSteps)

    // Make the toggle explicit so a selection change cannot move its default,
    // then select the other operation: the union must not change.
    await feedToggle.click()
    await feedToggle.click()
    await ui.operations.rowByName(app.page, 'Pocket B').click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.locator('.viewport-toolpath-vis__legend-step')).toHaveText(unionSteps)

    // The 3D panel shares the visibility state and must show the same union.
    const view3d = ui.toolpathVis.view3dPanel(app.page)
    await expect(view3d).toBeAttached({ timeout: 15000 })
    await expect(view3d.locator('.viewport-toolpath-vis__legend-step')).toHaveText(unionSteps)

    // Toggle off hides the legend in both panels.
    await feedToggle.click()
    await expect(feedToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(panel.locator('.viewport-toolpath-vis__legend')).toHaveCount(0)
    await expect(view3d.locator('.viewport-toolpath-vis__legend')).toHaveCount(0)
  })
})
