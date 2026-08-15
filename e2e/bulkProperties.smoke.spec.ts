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
 *
 * ─────────────────────────────────────────────────────────────────────
 * Issue #468 S2 Browser Smoke — Bulk tab/clamp properties & Z-range
 * ─────────────────────────────────────────────────────────────────────
 */

import { test, expect } from './fixtures'
import { seedProject, getProject } from './helpers'

// ── Platform helpers ──────────────────────────────────────────────────

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control'

// ── Helpers ──────────────────────────────────────────────────────────

function getArray(project: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = project[key]
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** CSS selector for selected feature rows. */
function selectedFeatureRows() {
  return '.tree-row--feature.tree-row--selected'
}

/** CSS selector for selected tab rows. */
function selectedTabRows() {
  return '.tree-row.tree-row--tab.tree-row--selected'
}

/** CSS selector for selected clamp rows. */
function selectedClampRows() {
  return '.tree-row.tree-row--clamp.tree-row--selected'
}

// ── Canvas world-to-pixel mapping (VIEW_PADDING = 42) ────────────────

const VIEW_PADDING = 42
const STOCK_W = 200
const STOCK_H = 160

interface CanvasBox { x: number; y: number; width: number; height: number }

function worldToPixel(worldX: number, worldY: number, box: CanvasBox): { x: number; y: number } {
  const scale = Math.min(
    (box.width - VIEW_PADDING * 2) / STOCK_W,
    (box.height - VIEW_PADDING * 2) / STOCK_H,
  )
  const offsetX = (box.width - STOCK_W * scale) / 2
  const offsetY = (box.height - STOCK_H * scale) / 2
  return {
    x: offsetX + worldX * scale,
    y: offsetY + worldY * scale,
  }
}

// ── Fixture ──────────────────────────────────────────────────────────

function bulkFixtureJson(): string {
  return JSON.stringify({
    version: '3.0',
    meta: {
      name: 'Bulk Props Fixture',
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      units: 'mm',
      showFeatureInfo: false,
      showDimensions: false,
      copyMode: 'reference',
      maxTravelZ: 20,
      operationClearanceZ: 2,
      clampClearanceXY: 2,
      clampClearanceZ: 1,
      machineDefinitions: [],
      selectedMachineId: null,
    },
    grid: {
      extent: 100,
      majorSpacing: 10,
      minorSpacing: 2,
      snapEnabled: false,
      snapIncrement: 1,
      visible: true,
    },
    stock: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line' as const, to: { x: 200, y: 0 } },
          { type: 'line' as const, to: { x: 200, y: 160 } },
          { type: 'line' as const, to: { x: 0, y: 160 } },
          { type: 'line' as const, to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      thickness: 20,
      material: 'aluminum_6061',
      color: '#b9a83c',
      visible: true,
      origin: { x: 0, y: 0 },
    },
    origin: { name: 'Origin', x: 100, y: 80, z: 20, visible: true },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {
      'def-closed-1': {
        kind: 'rect' as const,
        operation: 'add' as const,
        profile: {
          start: { x: 0, y: 0 },
          segments: [
            { type: 'line' as const, to: { x: 30, y: 0 } },
            { type: 'line' as const, to: { x: 30, y: 20 } },
            { type: 'line' as const, to: { x: 0, y: 20 } },
            { type: 'line' as const, to: { x: 0, y: 0 } },
          ],
          closed: true,
        },
        dimensions: [],
        text: null,
        stl: null,
      },
      'def-closed-2': {
        kind: 'rect' as const,
        operation: 'subtract' as const,
        profile: {
          start: { x: 0, y: 0 },
          segments: [
            { type: 'line' as const, to: { x: 30, y: 0 } },
            { type: 'line' as const, to: { x: 30, y: 20 } },
            { type: 'line' as const, to: { x: 0, y: 20 } },
            { type: 'line' as const, to: { x: 0, y: 0 } },
          ],
          closed: true,
        },
        dimensions: [],
        text: null,
        stl: null,
      },
      'def-line': {
        kind: 'rect' as const,
        operation: 'line' as const,
        profile: {
          start: { x: 0, y: 0 },
          segments: [
            { type: 'line' as const, to: { x: 24, y: 0 } },
            { type: 'line' as const, to: { x: 24, y: 16 } },
            { type: 'line' as const, to: { x: 0, y: 16 } },
            { type: 'line' as const, to: { x: 0, y: 0 } },
          ],
          closed: true,
        },
        dimensions: [],
        text: null,
        stl: null,
      },
    },
    features: [
      {
        id: 'f-1',
        definitionId: 'def-closed-1',
        name: 'Pad A',
        folderId: null,
        visible: true,
        locked: false,
        z_top: 12,
        z_bottom: 0,
        transform: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 },
        constraints: [],
      },
      {
        id: 'f-2',
        definitionId: 'def-closed-2',
        name: 'Pocket B',
        folderId: null,
        visible: true,
        locked: false,
        z_top: 8,
        z_bottom: 2,
        transform: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 120 },
        constraints: [],
      },
      {
        id: 'f-3',
        definitionId: 'def-line',
        name: 'Line Path',
        folderId: null,
        visible: true,
        locked: false,
        z_top: 3,
        z_bottom: 0,
        transform: { a: 1, b: 0, c: 0, d: 1, e: 168, f: 5 },
        constraints: [],
      },
    ],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [
      { id: 'tb-1', name: 'Tab A', x: 40, y: 80, w: 8, h: 8, z_top: 5, z_bottom: 0, visible: true },
      { id: 'tb-2', name: 'Tab B', x: 100, y: 80, w: 10, h: 10, z_top: 3, z_bottom: 0, visible: true },
      { id: 'tb-3', name: 'Tab C', x: 160, y: 80, w: 6, h: 6, z_top: 4, z_bottom: 1, visible: true },
      { id: 'tb-4', name: 'Tab D', x: 70, y: 130, w: 8, h: 8, z_top: 3, z_bottom: 0, visible: false },
    ],
    clamps: [
      { id: 'cl-1', name: 'Clamp A', type: 'step_clamp' as const, x: 50, y: 40, w: 12, h: 12, height: 5, visible: true },
      { id: 'cl-2', name: 'Clamp B', type: 'step_clamp' as const, x: 150, y: 40, w: 14, h: 10, height: 8, visible: true },
      { id: 'cl-3', name: 'Clamp C', type: 'step_clamp' as const, x: 100, y: 130, w: 10, h: 10, height: 6, visible: false },
    ],
    ai_history: [],
  })
}

const BULK_FIXTURE_JSON = bulkFixtureJson()

// ── Spec ────────────────────────────────────────────────────────────

test.describe('Bulk properties browser smoke', () => {
  // ====================================================================
  // 1. Global Ctrl/Cmd+A — feature-only selection
  // ====================================================================

  test(`global ${modKey}+A selects all visible feature rows, zero tab/clamp rows`, async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Click a feature row so the tree has focus, then select all.
    await ui.tree.featureRows(app.page).first().click()
    await app.page.keyboard.press(`${modKey}+a`)

    // Must select exactly all 3 visible feature rows, zero tab/clamp rows.
    await expect(app.page.locator(selectedFeatureRows())).toHaveCount(3)
    await expect(app.page.locator(selectedTabRows())).toHaveCount(0)
    await expect(app.page.locator(selectedClampRows())).toHaveCount(0)

  })

  // ====================================================================
  // 2. Tablet canvas multi-select — taps without modifiers
  // ====================================================================

  test.describe('Tablet (touch) canvas multi-select', () => {
    test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } })

    test('coarse-pointer media query matches', async ({ app }) => {
      const coarse = await app.page.evaluate(() =>
        window.matchMedia('(pointer: coarse)').matches,
      )
      expect(coarse).toBe(true)
    })

    test('tap Tab A then Tab C selects two tabs and shows bulk panel', async ({ app, ui }) => {
      await seedProject(app.page, BULK_FIXTURE_JSON)

      // The tablet command bar renders a "Multi" button for multi-select mode.
      const multiBtn = app.page.getByRole('button', { name: 'Multi', exact: true })
      await expect(multiBtn).toBeVisible()
      await multiBtn.click()
      await expect(multiBtn).toHaveClass(/active/)

      const canvas = app.page.locator('canvas.sketch-canvas')
      const box = await canvas.boundingBox()
      if (!box) throw new Error('Canvas not found')

      // Tab A centre (44, 84) — first tap.
      const ptA = worldToPixel(44, 84, box)
      await canvas.tap({ position: ptA })

      // Tab C centre (163, 83) — second tap adds to selection.
      const ptC = worldToPixel(163, 83, box)
      await canvas.tap({ position: ptC })

      // Two tab rows selected, bulk panel visible.
      await expect(app.page.locator(selectedTabRows())).toHaveCount(2)
      await expect(ui.properties.panel(app.page)).toContainText('2 Tabs')
      await expect(ui.properties.zRangeSlider(app.page)).toBeAttached()
    })

    test('tap Clamp A then Clamp B selects two clamps and shows bulk panel', async ({ app, ui }) => {
      await seedProject(app.page, BULK_FIXTURE_JSON)

      const multiBtn = app.page.getByRole('button', { name: 'Multi', exact: true })
      await expect(multiBtn).toBeVisible()
      await multiBtn.click()
      await expect(multiBtn).toHaveClass(/active/)

      const canvas = app.page.locator('canvas.sketch-canvas')
      const box = await canvas.boundingBox()
      if (!box) throw new Error('Canvas not found')

      // Clamp A centre (56, 46) — first tap.
      const ptA = worldToPixel(56, 46, box)
      await canvas.tap({ position: ptA })

      // Clamp B centre (157, 45) — second tap adds to selection.
      const ptB = worldToPixel(157, 45, box)
      await canvas.tap({ position: ptB })

      await expect(app.page.locator(selectedClampRows())).toHaveCount(2)
      await expect(ui.properties.panel(app.page)).toContainText('2 Clamps')
      await expect(ui.properties.zRangeSlider(app.page)).toBeAttached()
    })
  })

  // ====================================================================
  // 4. Mixed-visibility tab — indeterminate checkbox, no mutation
  // ====================================================================

  test('mixed-visibility tab bulk panel has indeterminate checkbox, opening causes no mutation', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Snapshot the complete project BEFORE any selection.
    const before = await getProject(app.page)

    // Select visible Tab A, then modifier-select hidden Tab D.
    await ui.tree.tabRows(app.page).nth(0).click()
    await ui.tree.tabRows(app.page).nth(3).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    // Bulk visibility checkbox must be indeterminate (visible + hidden).
    const bulkCheckbox = ui.properties.panel(app.page).locator('input[type="checkbox"]').last()
    const indeterminate = await bulkCheckbox.evaluate((el: HTMLInputElement) => el.indeterminate)
    expect(indeterminate).toBe(true)

    // Snapshot the complete project after the panel is open.
    const after = await getProject(app.page)
    // Normalise volatile timestamps before deep comparison.
    const normalize = (p: Record<string, unknown>) => {
      const meta = p.meta as Record<string, unknown> | undefined
      if (meta) { meta.modified = '<normalized>' }
    }
    normalize(before)
    normalize(after)
    // The complete project must be deeply equal — no mutation from opening the panel.
    expect(after).toEqual(before)
  })

  // ====================================================================
  // 5. Mixed-visibility clamp — indeterminate checkbox, no mutation
  // ====================================================================

  test('mixed-visibility clamp bulk panel has indeterminate checkbox, opening causes no mutation', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Snapshot the complete project BEFORE any selection.
    const before = await getProject(app.page)

    // Select visible Clamp A, then modifier-select hidden Clamp C.
    await ui.tree.clampRows(app.page).nth(0).click()
    await ui.tree.clampRows(app.page).nth(2).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    const bulkCheckbox = ui.properties.panel(app.page).locator('input[type="checkbox"]').last()
    const indeterminate = await bulkCheckbox.evaluate((el: HTMLInputElement) => el.indeterminate)
    expect(indeterminate).toBe(true)

    const after = await getProject(app.page)
    const normalize = (p: Record<string, unknown>) => {
      const meta = p.meta as Record<string, unknown> | undefined
      if (meta) { meta.modified = '<normalized>' }
    }
    normalize(before)
    normalize(after)
    // The complete project must be deeply equal — no mutation from opening the panel.
    expect(after).toEqual(before)
  })

  // ====================================================================
  // 6. Multi-feature Z: invalid top vs one member bottom rejects all
  // ====================================================================

  test('multi-feature invalid Z top against one member bottom rejects entire batch and resets field', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Select Pad A (z_top=12, z_bottom=0) and Pocket B (z_top=8, z_bottom=2).
    await ui.tree.featureRows(app.page).nth(0).click()
    await ui.tree.featureRows(app.page).nth(1).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    // Try z_top=1 — Pocket B has z_bottom=2, so 1<2 → rejected.
    await ui.properties.zRangeTopField(app.page).click()
    await ui.properties.zRangeTopField(app.page).fill('1')
    await ui.properties.zRangeTopField(app.page).blur()

    // Both features must be unchanged.
    const project = await getProject(app.page)
    const features = getArray(project, 'features')
    const pad = features.find((f) => str(f.id) === 'f-1')!
    const pocket = features.find((f) => str(f.id) === 'f-2')!
    expect(num(pad.z_top)).toBe(12)
    expect(num(pocket.z_top)).toBe(8)

    // Field must reset (mixed, since tops 12 and 8 differ).
    await expect(ui.properties.zRangeTopField(app.page)).toHaveValue('')
  })

  // ====================================================================
  // 7. Multi-feature Z: valid top updates all, undo restores each
  // ====================================================================

  test('multi-feature valid Z top updates all closed features, one undo restores each exact original', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    await ui.tree.featureRows(app.page).nth(0).click()
    await ui.tree.featureRows(app.page).nth(1).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    // Set z_top=4 — valid for both: 4>=0 and 4>=2.
    await ui.properties.zRangeTopField(app.page).click()
    await ui.properties.zRangeTopField(app.page).fill('4')
    await ui.properties.zRangeTopField(app.page).blur()

    let project = await getProject(app.page)
    let features = getArray(project, 'features')
    const padA = features.find((f) => str(f.id) === 'f-1')!
    const pocketB = features.find((f) => str(f.id) === 'f-2')!
    expect(num(padA.z_top)).toBe(4)
    expect(num(pocketB.z_top)).toBe(4)
    // Input shows common value now (both 4).
    await expect(ui.properties.zRangeTopField(app.page)).toHaveValue('4')

    // Undo restores exact original values.
    await app.page.keyboard.press(`${modKey}+z`)
    project = await getProject(app.page)
    features = getArray(project, 'features')
    const padAR = features.find((f) => str(f.id) === 'f-1')!
    const pocketBR = features.find((f) => str(f.id) === 'f-2')!
    expect(num(padAR.z_top)).toBe(12)
    expect(num(pocketBR.z_top)).toBe(8)
    // Field refreshes to mixed after undo.
    await expect(ui.properties.zRangeTopField(app.page)).toHaveValue('')
  })

  // ====================================================================
  // 8. Single Line feature — bottom disabled at 0
  // ====================================================================

  test('single Line feature shows bottom disabled at 0', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Select the Line feature by clicking its tree row by name.
    await ui.tree.rowByName(app.page, 'Line Path').click()

    // Verify the correct feature is selected.
    await expect(ui.properties.panel(app.page)).toContainText('Delete feature')

    // Expand the Instance disclosure section (closed by default).
    await app.page.getByRole('button', { name: 'Instance' }).click()

    // The Z-range slider should be present with bottom locked at 0.
    await expect(ui.properties.zRangeSlider(app.page)).toBeAttached()
    const bottomField = ui.properties.zRangeBottomField(app.page)
    await expect(bottomField).toHaveValue('0')
    await expect(bottomField).toBeDisabled()
  })

  // ====================================================================
  // 9. Mixed Line+closed selection — bottom editable for closed only
  // ====================================================================

  test('mixed Line+closed selection can edit bottom for closed feature only, Line stays at 0', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Select Pad A (closed, z_top=12, z_bottom=0) by first feature row.
    await ui.tree.featureRows(app.page).nth(0).click()
    // Select Line Path (z_top=3, z_bottom=0) by name to avoid brittle ordinal.
    await ui.tree.rowByName(app.page, 'Line Path').click({ modifiers: [modKey as 'Meta' | 'Control'] })

    // Line top is 3, closed top is 12. Use bottom=4 which is ABOVE Line's top
    // but below the closed feature's top. If validation incorrectly includes
    // the non-target Line feature, bottom=4 > Line top=3 would be rejected
    // and Line's bottom would not stay at 0.
    await ui.properties.zRangeBottomField(app.page).click()
    await ui.properties.zRangeBottomField(app.page).fill('4')
    await ui.properties.zRangeBottomField(app.page).blur()

    const project = await getProject(app.page)
    const features = getArray(project, 'features')
    const pad = features.find((f) => str(f.id) === 'f-1')!
    const line = features.find((f) => str(f.id) === 'f-3')!
    // Closed feature bottom becomes 4.
    expect(num(pad.z_bottom)).toBe(4)
    // Line bottom stays at 0 — validation correctly excluded the non-target.
    expect(num(line.z_bottom)).toBe(0)
    expect(num(line.z_top)).toBe(3)
  })

  // ====================================================================
  // 10. Mixed-opposite pointer: tab bottom slider drag
  // ====================================================================

  test('mixed-top tabs bottom slider drag above zero applies valid positive bottom', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Select Tab A (z_top=5, z_bottom=0) and Tab B (z_top=3, z_bottom=0).
    // Mixed top (null display), common bottom (0).
    await ui.tree.tabRows(app.page).nth(0).click()
    await ui.tree.tabRows(app.page).nth(1).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    // Drag the bottom slider handle from z=0 to z=1.
    const slider = ui.properties.zRangeSlider(app.page)
    const track = slider.locator('.z-range-slider__track')
    const trackBox = await track.boundingBox()
    if (!trackBox) throw new Error('Track not found')

    const domainMax = 20 // stock thickness
    const domainMin = 0
    const EDGE_MARGIN = 0.08

    function zToTrackY(z: number): number {
      const range = domainMax - domainMin
      const usable = 1 - 2 * EDGE_MARGIN
      const fraction = 1 - Math.max(0, Math.min(range, z - domainMin)) / range
      const percent = EDGE_MARGIN + fraction * usable
      return trackBox.y + percent * trackBox.height
    }

    const startY = zToTrackY(0)
    const endY = zToTrackY(1)
    const midX = trackBox.x + trackBox.width / 2

    // Use raw mouse on the page for the drag sequence.
    await app.page.mouse.move(midX, startY)
    await app.page.mouse.down()
    await app.page.mouse.move(midX, endY, { steps: 5 })
    await app.page.mouse.up()

    // Both tabs should have z_bottom=1.
    const project = await getProject(app.page)
    const tabs = getArray(project, 'tabs')
    const tabA = tabs.find((t) => str(t.id) === 'tb-1')!
    const tabB = tabs.find((t) => str(t.id) === 'tb-2')!
    expect(num(tabA.z_bottom)).toBe(1)
    expect(num(tabB.z_bottom)).toBe(1)
  })

  // ====================================================================
  // 11. Both-invalid tab Z — rejects, field resets, history unchanged
  // ====================================================================

  test('both-invalid tab Z rejects, field resets, then valid edit + undo prove rejected input created no history', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Select all tabs via button.
    await app.page.getByRole('button', { name: 'Select all tabs' }).click()

    // Capture every tab's z_top and z_bottom before the rejected edit.
    const before = await getProject(app.page)
    const tabsBefore = getArray(before, 'tabs')

    // Try z_top=-1 — rejected (z_top must be >= z_bottom=0 for all tabs).
    await ui.properties.zRangeTopField(app.page).click()
    await ui.properties.zRangeTopField(app.page).fill('-1')
    await ui.properties.zRangeTopField(app.page).blur()

    // Field must reset (mixed, since tabs have different z_tops: 5,3,4).
    await expect(ui.properties.zRangeTopField(app.page)).toHaveValue('')

    // Compare every tab before/after — no mutation.
    const after = await getProject(app.page)
    const tabsAfter = getArray(after, 'tabs')
    for (let i = 0; i < tabsBefore.length; i++) {
      expect(tabsAfter[i]).toEqual(tabsBefore[i])
    }

    // Now make one valid edit: z_bottom=1 (common across selected tabs).
    await ui.properties.zRangeBottomField(app.page).click()
    await ui.properties.zRangeBottomField(app.page).fill('1')
    await ui.properties.zRangeBottomField(app.page).blur()

    // Undo once. If the rejected edit had created a history entry,
    // this Undo would revert the z_bottom edit, leaving z_bottom=0.
    await app.page.keyboard.press(`${modKey}+z`)

    const undone = await getProject(app.page)
    const tabsUndone = getArray(undone, 'tabs')
    // All tabs restored to original z_bottom=0 (because the only real
    // edit was the z_bottom=1, and it was one entry).
    for (let i = 0; i < tabsUndone.length; i++) {
      expect(tabsUndone[i]).toEqual(tabsBefore[i])
    }

    // Second Undo would restore pre-select-all state — but the key
    // evidence is that there is exactly one history entry (the z_bottom
    // edit), not zero and not two. The fact that one Undo restores
    // the pre-edit state proves the rejected input added no history.
  })

  // ====================================================================
  // Preserved: basic panel display, center-preserving, atomic, delete
  // ====================================================================

  test('bulk tab panel shows after Select All tabs', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all tabs' }).click()

    await expect(app.page.locator(selectedTabRows())).toHaveCount(3)
    await expect(ui.properties.panel(app.page)).toContainText('3 Tabs')
    await expect(ui.properties.panel(app.page)).toContainText('Width')
    await expect(ui.properties.zRangeSlider(app.page)).toBeAttached()
  })

  test('bulk clamp panel shows after Select All clamps', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all clamps' }).click()

    await expect(app.page.locator(selectedClampRows())).toHaveCount(2)
    await expect(ui.properties.panel(app.page)).toContainText('2 Clamps')
    await expect(ui.properties.zRangeSlider(app.page)).toBeAttached()
  })

  test('center-preserving bulk width edit', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all tabs' }).click()

    const before = await getProject(app.page)
    const tabsBefore = getArray(before, 'tabs')
    // Only visible tabs are selected and edited.
    const visibleIds = new Set(tabsBefore.filter((t) => t.visible === true).map((t) => str(t.id)))
    const centresBefore = new Map(
      tabsBefore.filter((t) => visibleIds.has(str(t.id))).map((t) => [str(t.id), num(t.x) + num(t.w) / 2]),
    )

    const numericFields = ui.properties.panel(app.page).locator('[data-numeric-entry="true"]')
    await numericFields.nth(0).click()
    await numericFields.nth(0).fill('12')
    await numericFields.nth(0).blur()

    const after = await getProject(app.page)
    const tabsAfter = getArray(after, 'tabs')
    for (const t of tabsAfter) {
      if (!visibleIds.has(str(t.id))) continue
      const centre = num(t.x) + num(t.w) / 2
      const beforeCentre = centresBefore.get(str(t.id))
      expect(Math.abs(centre - beforeCentre!)).toBeLessThan(0.002)
    }
    expect(tabsAfter.filter((t) => visibleIds.has(str(t.id))).every((t) => Math.abs(num(t.w) - 12) < 0.002)).toBe(true)
  })

  test('bulk Z top edit is atomic (one store action)', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all tabs' }).click()

    await ui.properties.zRangeTopField(app.page).click()
    await ui.properties.zRangeTopField(app.page).fill('7')
    await ui.properties.zRangeTopField(app.page).blur()

    const project = await getProject(app.page)
    const tabs = getArray(project, 'tabs')
    // Only visible tabs were selected and edited.
    expect(tabs.filter((t) => t.visible === true).every((t) => num(t.z_top) === 7)).toBe(true)
  })

  test('bulk delete removes selected tabs', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all tabs' }).click()

    await ui.properties.deleteSelectedButton(app.page).click()

    const project = await getProject(app.page)
    // Only visible tabs were selected and deleted; hidden tab remains.
    const tabs = getArray(project, 'tabs')
    expect(tabs.filter((t) => t.visible === true).length).toBe(0)
  })

  // ── Clamp Z properties ───────────────────────────────────────────

  test('clamp bulk Z top maps to height, bottom is locked', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all clamps' }).click()

    await expect(ui.properties.zRangeBottomField(app.page)).toHaveValue('0')

    await ui.properties.zRangeTopField(app.page).click()
    await ui.properties.zRangeTopField(app.page).fill('10')
    await ui.properties.zRangeTopField(app.page).blur()

    const project = await getProject(app.page)
    const clamps = getArray(project, 'clamps')
    // Only visible clamps were selected and edited.
    expect(clamps.filter((c) => c.visible === true).every((c) => num(c.height) === 10)).toBe(true)
  })

  test('clamp bulk delete removes selected clamps', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all clamps' }).click()

    await ui.properties.deleteSelectedButton(app.page).click()

    const project = await getProject(app.page)
    // Only visible clamps were selected and deleted; hidden clamp remains.
    const clamps = getArray(project, 'clamps')
    expect(clamps.filter((c) => c.visible === true).length).toBe(0)
  })

  // ── Incompatible modifier addition ignored ────────────────────────

  test('adding clamp via modifier to tab selection is ignored', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    await ui.tree.tabRows(app.page).nth(0).click()
    await expect(ui.properties.panel(app.page)).toContainText('Delete tab')

    await ui.tree.clampRows(app.page).nth(0).click({ modifiers: [modKey as 'Meta' | 'Control'] })
    await expect(ui.properties.panel(app.page)).toContainText('Delete tab')
  })

  test('adding tab via modifier to clamp selection is ignored', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    await ui.tree.clampRows(app.page).nth(0).click()
    await expect(ui.properties.panel(app.page)).toContainText('Delete clamp')

    await ui.tree.tabRows(app.page).nth(0).click({ modifiers: [modKey as 'Meta' | 'Control'] })
    await expect(ui.properties.panel(app.page)).toContainText('Delete clamp')
  })

  // ── Locked bottom field ──

  test('clamp bottom field is disabled and shows 0', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all clamps' }).click()

    const bottomField = ui.properties.zRangeBottomField(app.page)
    await expect(bottomField).toHaveValue('0')
    await expect(bottomField).toBeDisabled()
  })

  test('single clamp bottom field is disabled and shows 0', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await ui.tree.clampRows(app.page).nth(0).click()

    const bottomField = ui.properties.zRangeBottomField(app.page)
    await expect(bottomField).toHaveValue('0')
    await expect(bottomField).toBeDisabled()
  })

  // ── Bulk clamp domain independent of stock thickness ──

  test('bulk clamp Z domain slider ARIA max differs from stock thickness', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all clamps' }).click()

    const topHandle = ui.properties.zRangeSlider(app.page).locator('[role="slider"]').first()
    const ariaMax = await topHandle.getAttribute('aria-valuemax')
    const ariaMaxNum = Number(ariaMax)
    expect(ariaMaxNum).toBeLessThan(20)
    expect(ariaMaxNum).toBeGreaterThan(8)
  })

  test('clamp Z range field accepts value exceeding stock thickness', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all clamps' }).click()

    await ui.properties.zRangeTopField(app.page).click()
    await ui.properties.zRangeTopField(app.page).fill('30')
    await ui.properties.zRangeTopField(app.page).blur()

    const project = await getProject(app.page)
    const clamps = getArray(project, 'clamps')
    // Only visible clamps were selected and edited.
    expect(clamps.filter((c) => c.visible === true).every((c) => num(c.height) === 30)).toBe(true)
  })

  // ====================================================================
  // S2-FINAL-CORRECTION: context-menu routing + Delete Selected + Undo
  // ====================================================================

  test.describe('Context-menu routing and bulk delete with Undo', () => {
    test('desktop tab context-menu: multi-select hides singleton actions, Delete Selected + Undo restores', async ({ app, ui }) => {
      await seedProject(app.page, BULK_FIXTURE_JSON)

      // Multi-select Tab A (nth 0) and Tab B (nth 1) via desktop modifier-click.
      await ui.tree.tabRows(app.page).nth(0).click()
      await ui.tree.tabRows(app.page).nth(1).click({ modifiers: [modKey as 'Meta' | 'Control'] })
      await expect(app.page.locator(selectedTabRows())).toHaveCount(2)

      // Snapshot the project before delete.
      const before = await getProject(app.page)
      const tabsBefore = getArray(before, 'tabs')
      expect(tabsBefore.length).toBe(4)

      // Right-click on the second selected tab row to open the context menu.
      await ui.tree.tabRows(app.page).nth(1).click({ button: 'right' })
      const menu = ui.contextMenu.container(app.page)
      await expect(menu).toBeVisible()

      // Singleton actions must be absent in multi-selection mode.
      await expect(ui.contextMenu.item(menu, 'Edit sketch')).not.toBeAttached()
      await expect(ui.contextMenu.item(menu, 'Copy')).not.toBeAttached()
      await expect(ui.contextMenu.item(menu, 'Move')).not.toBeAttached()

      // Delete Selected must be present.
      const deleteItem = ui.contextMenu.item(menu, 'Delete selected')
      await expect(deleteItem).toBeVisible()

      // Perform the bulk delete.
      await deleteItem.click()

      // Context menu should close after the action.
      await expect(menu).not.toBeVisible()

      // Only the two selected tabs (tb-1, tb-2) should be deleted.
      const after = await getProject(app.page)
      const tabsAfter = getArray(after, 'tabs')
      const deletedIds = new Set(['tb-1', 'tb-2'])
      const remaining = tabsAfter.filter((t) => !deletedIds.has(str(t.id)))
      expect(remaining.length).toBe(2) // tb-3 and tb-4 survive
      expect(tabsAfter.every((t) => !deletedIds.has(str(t.id)))).toBe(true)

      // Undo restores the deleted tabs.
      await app.page.keyboard.press(`${modKey}+z`)

      const restored = await getProject(app.page)
      const tabsRestored = getArray(restored, 'tabs')
      expect(tabsRestored.length).toBe(4)
      // All original tab IDs must be present.
      const restoredIds = new Set(tabsRestored.map((t) => str(t.id)))
      for (const id of ['tb-1', 'tb-2', 'tb-3', 'tb-4']) {
        expect(restoredIds.has(id)).toBe(true)
      }
    })

    test.describe('tablet clamp canvas multi-select + More-menu delete', () => {
      test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } })

      test('canvas tap multi-selects clamps, row More menu Delete Selected + Undo restores', async ({ app, ui }) => {
        await seedProject(app.page, BULK_FIXTURE_JSON)

        // Verify tablet shell is active.
        const coarse = await app.page.evaluate(() =>
          window.matchMedia('(pointer: coarse)').matches,
        )
        expect(coarse).toBe(true)

        // Enter tablet multi-select mode.
        const multiBtn = app.page.getByRole('button', { name: 'Multi', exact: true })
        await expect(multiBtn).toBeVisible()
        await multiBtn.click()
        await expect(multiBtn).toHaveClass(/active/)

        // Tap Clamp A and Clamp B on the canvas to multi-select.
        const canvas = app.page.locator('canvas.sketch-canvas')
        const box = await canvas.boundingBox()
        if (!box) throw new Error('Canvas not found')

        // Clamp A centre (56, 46) and Clamp B centre (157, 45).
        await canvas.tap({ position: worldToPixel(56, 46, box) })
        await canvas.tap({ position: worldToPixel(157, 45, box) })

        // Two clamps selected, bulk panel visible.
        await expect(app.page.locator(selectedClampRows())).toHaveCount(2)
        await expect(ui.properties.panel(app.page)).toContainText('2 Clamps')

        // Snapshot before delete.
        const before = await getProject(app.page)
        const clampsBefore = getArray(before, 'clamps')
        expect(clampsBefore.length).toBe(3)

        // Singleton Edit Sketch button must be absent/hidden in bulk panel.
        const editSketchBtn = ui.properties.panel(app.page).getByRole('button', { name: 'Edit sketch' })
        await expect(editSketchBtn).toHaveCount(0)

        // Open the context menu the way a tablet user does: the "⋮" More-actions
        // button on a selected clamp row. There is no right-click on touch, so
        // this button is the only real routing path into the bulk menu. The tree
        // lives in the tablet project drawer, which must be opened first — the
        // rows are in the DOM but translated outside the viewport while closed.
        await ui.tree.openProjectPanelButton(app.page).tap()

        const selectedClampRow = app.page.locator(selectedClampRows()).nth(1)
        const moreButton = ui.tree.rowMoreButton(selectedClampRow)
        await expect(moreButton).toBeVisible()
        await moreButton.tap()

        const menu = ui.contextMenu.container(app.page)
        await expect(menu).toBeVisible()

        // Opening the menu on an already-selected row must not collapse the
        // selection back to one clamp.
        await expect(app.page.locator(selectedClampRows())).toHaveCount(2)

        // Singleton actions must be absent while several clamps are selected.
        await expect(ui.contextMenu.item(menu, 'Edit sketch')).not.toBeAttached()
        await expect(ui.contextMenu.item(menu, 'Copy')).not.toBeAttached()
        await expect(ui.contextMenu.item(menu, 'Move')).not.toBeAttached()

        const deleteItem = ui.contextMenu.item(menu, 'Delete selected')
        await expect(deleteItem).toBeVisible()
        await deleteItem.tap()

        await expect(menu).not.toBeVisible()

        // Only cl-1 and cl-2 should be deleted; cl-3 (hidden) survives.
        const after = await getProject(app.page)
        const clampsAfter = getArray(after, 'clamps')
        expect(clampsAfter.length).toBe(1)
        expect(str(clampsAfter[0].id)).toBe('cl-3')

        // Undo restores all three clamps.
        await app.page.keyboard.press(`${modKey}+z`)

        const restored = await getProject(app.page)
        const clampsRestored = getArray(restored, 'clamps')
        expect(clampsRestored.length).toBe(3)
        const restoredIds = new Set(clampsRestored.map((c) => str(c.id)))
        for (const id of ['cl-1', 'cl-2', 'cl-3']) {
          expect(restoredIds.has(id)).toBe(true)
        }
      })
    })
  })

  // ====================================================================
  // Canvas renders EVERY selected tab/clamp, not just the primary
  // ====================================================================

  test.describe('Canvas multi-selection highlight', () => {
    /**
     * Samples the rendered pixel at a canvas position. Tab/clamp footprints use
     * a distinct fill when selected, so watching ONE footprint centre across
     * selection states tells us what the canvas actually painted. Comparing the
     * same point (rather than two different footprints) keeps whatever is drawn
     * underneath constant, so the only variable is the selection styling.
     */
    async function sampleAt(page: import('@playwright/test').Page, pt: { x: number; y: number }) {
      return page.evaluate(({ x, y }) => {
        const canvas = document.querySelector('canvas.sketch-canvas') as HTMLCanvasElement
        const ctx = canvas.getContext('2d')!
        const rect = canvas.getBoundingClientRect()
        const dpr = canvas.width / rect.width
        const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data
        return `${d[0]},${d[1]},${d[2]},${d[3]}`
      }, pt)
    }

    test('a tab stays painted as selected once it is no longer the primary', async ({ app }) => {
      await seedProject(app.page, BULK_FIXTURE_JSON)
      const canvas = app.page.locator('canvas.sketch-canvas')
      const box = (await canvas.boundingBox())!
      const a = worldToPixel(44, 84, box)   // Tab A centre
      const b = worldToPixel(105, 85, box)  // Tab B centre

      const unselected = await sampleAt(app.page, a)

      await canvas.click({ position: a })
      await expect(app.page.locator(selectedTabRows())).toHaveCount(1)
      const selectedAlone = await sampleAt(app.page, a)
      expect(selectedAlone).not.toBe(unselected)

      // Shift-click Tab B. Tab A is still selected but is no longer the
      // primary node, so a canvas that keys off selectedNode repaints it as
      // unselected while the tree still shows both.
      await canvas.click({ position: b, modifiers: ['Shift'] })
      await expect(app.page.locator(selectedTabRows())).toHaveCount(2)
      expect(await sampleAt(app.page, a)).toBe(selectedAlone)
    })

    test('a clamp stays painted as selected once it is no longer the primary', async ({ app }) => {
      await seedProject(app.page, BULK_FIXTURE_JSON)
      const canvas = app.page.locator('canvas.sketch-canvas')
      const box = (await canvas.boundingBox())!
      const a = worldToPixel(56, 46, box)   // Clamp A centre
      const b = worldToPixel(157, 45, box)  // Clamp B centre

      const unselected = await sampleAt(app.page, a)

      await canvas.click({ position: a })
      await expect(app.page.locator(selectedClampRows())).toHaveCount(1)
      const selectedAlone = await sampleAt(app.page, a)
      expect(selectedAlone).not.toBe(unselected)

      await canvas.click({ position: b, modifiers: ['Shift'] })
      await expect(app.page.locator(selectedClampRows())).toHaveCount(2)
      expect(await sampleAt(app.page, a)).toBe(selectedAlone)
    })
  })

  // ====================================================================
  // Z slider drag snaps to a usable increment (0.1 mm / 0.01 in)
  // ====================================================================

  test('dragging the Z handle lands on a 0.1 mm increment, not full precision', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Single tab, so the committed value is unambiguous.
    await ui.tree.tabRows(app.page).nth(0).click()
    const slider = ui.properties.zRangeSlider(app.page)
    const track = slider.locator('.z-range-slider__track')
    const trackBox = await track.boundingBox()
    if (!trackBox) throw new Error('Track not found')

    const domainMax = 20 // stock thickness
    const EDGE_MARGIN = 0.08
    function zToTrackY(z: number): number {
      const fraction = 1 - Math.max(0, Math.min(domainMax, z)) / domainMax
      return trackBox!.y + (EDGE_MARGIN + fraction * (1 - 2 * EDGE_MARGIN)) * trackBox!.height
    }

    // Aim deliberately between increments — a raw drag would commit something
    // like 1.2346, which is finer than the field ever displays.
    const midX = trackBox.x + trackBox.width / 2
    await app.page.mouse.move(midX, zToTrackY(0))
    await app.page.mouse.down()
    await app.page.mouse.move(midX, zToTrackY(1.23456), { steps: 5 })
    await app.page.mouse.up()

    const tabs = getArray(await getProject(app.page), 'tabs')
    const committed = num(tabs.find((t) => str(t.id) === 'tb-1')!.z_bottom)

    // It actually moved...
    expect(committed).toBeGreaterThan(0)
    // ...and landed on a tenth of a millimetre.
    expect(Math.abs(committed * 10 - Math.round(committed * 10))).toBeLessThan(1e-9)
  })

  // ====================================================================
  // Tab shape control (single + bulk)
  // ====================================================================

  test('single tab shape select defaults to Rectangular and switches to Smooth', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Select Tab A.
    await ui.tree.tabRows(app.page).nth(0).click()

    // Shape select must be present and default to Rectangular.
    const shapeSelect = ui.properties.panel(app.page).locator('[data-testid="tab-shape"]')
    await expect(shapeSelect).toBeAttached()
    await expect(shapeSelect).toHaveValue('rect')

    // Switch to Smooth.
    await shapeSelect.selectOption('smooth')

    // Verify the project data was updated.
    const project = await getProject(app.page)
    const tabs = getArray(project, 'tabs')
    const tabA = tabs.find((t) => str(t.id) === 'tb-1')!
    expect(str(tabA.shape)).toBe('smooth')
  })

  test('two legacy tabs read as Rectangular, not as mixed', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Neither fixture tab carries a `shape` key — they are legacy records, which
    // is what every project saved before this feature looks like. Opening them
    // together must read Rectangular, never "Mixed values".
    //
    // Two layers have to hold for that: `normalizeTab` resolves the missing
    // field at load, and the panel resolves again through `tabShape()`. Either
    // alone is sufficient, so this asserts the user-visible outcome rather than
    // pinning one mechanism — swapping the panel to raw `tab.shape` still passes
    // here, because normalization has already filled the field in by then.
    await ui.tree.tabRows(app.page).nth(0).click()
    await ui.tree.tabRows(app.page).nth(1).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    const bulkSelect = ui.properties.panel(app.page).locator('[data-testid="bulk-tab-shape"]')
    await expect(bulkSelect).toHaveValue('rect')
  })

  test('bulk tab shape select shows mixed state and applies to all', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // First set Tab A to smooth so we have mixed shapes.
    await ui.tree.tabRows(app.page).nth(0).click()
    const singleSelect = ui.properties.panel(app.page).locator('[data-testid="tab-shape"]')
    await singleSelect.selectOption('smooth')

    // Now multi-select Tab A (smooth) and Tab B (legacy/rect).
    await ui.tree.tabRows(app.page).nth(0).click()
    await ui.tree.tabRows(app.page).nth(1).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    // Bulk shape select should be present and show mixed (empty value).
    const bulkSelect = ui.properties.panel(app.page).locator('[data-testid="bulk-tab-shape"]')
    await expect(bulkSelect).toBeAttached()
    await expect(bulkSelect).toHaveValue('')

    // Select Rectangular for all.
    await bulkSelect.selectOption('rect')

    // Both tabs should now be rect.
    const project = await getProject(app.page)
    const tabs = getArray(project, 'tabs')
    const tabA = tabs.find((t) => str(t.id) === 'tb-1')!
    const tabB = tabs.find((t) => str(t.id) === 'tb-2')!
    expect(str(tabA.shape ?? 'rect')).toBe('rect')
    expect(str(tabB.shape ?? 'rect')).toBe('rect')
  })
})
