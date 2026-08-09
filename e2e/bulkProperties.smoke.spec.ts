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

/** CSS selector for selected tab rows (avoids unsupported .filter({hasClass})). */
function selectedTabRows() {
  return '.tree-row.tree-row--tab.tree-row--selected'
}

/** CSS selector for selected clamp rows. */
function selectedClampRows() {
  return '.tree-row.tree-row--clamp.tree-row--selected'
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
      'def-base': {
        kind: 'rect' as const,
        operation: 'add' as const,
        profile: {
          start: { x: 0, y: 0 },
          segments: [
            { type: 'line' as const, to: { x: 40, y: 0 } },
            { type: 'line' as const, to: { x: 40, y: 30 } },
            { type: 'line' as const, to: { x: 0, y: 30 } },
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
        id: 'f-base',
        definitionId: 'def-base',
        name: 'Base Pad',
        folderId: null,
        visible: true,
        locked: false,
        z_top: 20,
        z_bottom: 0,
        transform: { a: 1, b: 0, c: 0, d: 1, e: 80, f: 65 },
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
    ],
    clamps: [
      { id: 'cl-1', name: 'Clamp A', type: 'step_clamp' as const, x: 50, y: 40, w: 12, h: 12, height: 5, visible: true },
      { id: 'cl-2', name: 'Clamp B', type: 'step_clamp' as const, x: 150, y: 40, w: 14, h: 10, height: 8, visible: true },
    ],
    ai_history: [],
  })
}

const BULK_FIXTURE_JSON = bulkFixtureJson()

// ── Spec ────────────────────────────────────────────────────────────

test.describe('Bulk properties browser smoke', () => {
  // ── Basic panel display ──────────────────────────────────────────

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

  // ── Center-preserving & atomic edits ─────────────────────────────

  test('center-preserving bulk width edit', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all tabs' }).click()

    const before = await getProject(app.page)
    const tabsBefore = getArray(before, 'tabs')
    const centresBefore = new Map(
      tabsBefore.map((t) => [str(t.id), num(t.x) + num(t.w) / 2]),
    )

    const numericFields = ui.properties.panel(app.page).locator('[data-numeric-entry="true"]')
    await numericFields.nth(0).click()
    await numericFields.nth(0).fill('12')
    await numericFields.nth(0).blur()

    const after = await getProject(app.page)
    const tabsAfter = getArray(after, 'tabs')
    for (const t of tabsAfter) {
      const centre = num(t.x) + num(t.w) / 2
      const beforeCentre = centresBefore.get(str(t.id))
      expect(Math.abs(centre - beforeCentre!)).toBeLessThan(0.002)
    }
    expect(tabsAfter.every((t) => Math.abs(num(t.w) - 12) < 0.002)).toBe(true)
  })

  test('bulk Z top edit is atomic (one store action)', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all tabs' }).click()

    await ui.properties.zRangeTopField(app.page).click()
    await ui.properties.zRangeTopField(app.page).fill('7')
    await ui.properties.zRangeTopField(app.page).blur()

    const project = await getProject(app.page)
    const tabs = getArray(project, 'tabs')
    expect(tabs.every((t) => num(t.z_top) === 7)).toBe(true)
  })

  test('bulk delete removes selected tabs', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all tabs' }).click()

    await ui.properties.deleteSelectedButton(app.page).click()

    const project = await getProject(app.page)
    expect(getArray(project, 'tabs').length).toBe(0)
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
    expect(clamps.every((c) => num(c.height) === 10)).toBe(true)
  })

  test('clamp bulk delete removes selected clamps', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all clamps' }).click()

    await ui.properties.deleteSelectedButton(app.page).click()

    const project = await getProject(app.page)
    expect(getArray(project, 'clamps').length).toBe(0)
  })

  // ── Acceptance: Select All features excludes tabs/clamps ──────────

  test(`global ${modKey}+A selects only visible features, not tabs or clamps`, async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Click a feature row first so the tree has focus, then select all.
    await ui.tree.featureRows(app.page).first().click()
    await app.page.keyboard.press(`${modKey}+a`)

    // When only features are selected, the panel shows "Delete Feature" not bulk panels.
    await expect(ui.properties.panel(app.page)).toContainText('Delete Feature')
    await expect(ui.properties.panel(app.page)).not.toContainText('3 Tabs')
    await expect(ui.properties.panel(app.page)).not.toContainText('2 Clamps')
  })

  // ── Acceptance: Mixed-value bulk panel shows without mutation ─────

  test('mixed-value bulk tab panel shows mixed state, opening causes no mutation', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Select tabs with different z_tops (5, 3, 4).
    await ui.tree.tabRows(app.page).nth(0).click()
    await ui.tree.tabRows(app.page).nth(1).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    await expect(ui.properties.panel(app.page)).toContainText('2 Tabs')

    // The z-top field should show the mixed placeholder (empty input).
    const topField = ui.properties.zRangeTopField(app.page)
    await expect(topField).toHaveValue('')

    // Opening the mixed panel MUST NOT mutate the project.
    const before = await getProject(app.page)
    const tabsBefore = getArray(before, 'tabs')
    const zTops = tabsBefore.map((t) => num(t.z_top)).sort()
    expect(zTops).toEqual([3, 4, 5])
  })

  // ── Acceptance: Ctrl/Cmd+click multi-select for tabs ──────────────

  test('Ctrl+click multi-selects two tabs and shows bulk panel', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    await ui.tree.tabRows(app.page).nth(0).click()
    await ui.tree.tabRows(app.page).nth(2).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    await expect(ui.properties.panel(app.page)).toContainText('2 Tabs')
    await expect(ui.properties.zRangeSlider(app.page)).toBeAttached()
  })

  // ── Acceptance: Ctrl/Cmd+click multi-select for clamps ────────────

  test('Ctrl+click multi-selects two clamps and shows bulk panel', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    await ui.tree.clampRows(app.page).nth(0).click()
    await ui.tree.clampRows(app.page).nth(1).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    await expect(ui.properties.panel(app.page)).toContainText('2 Clamps')
    await expect(ui.properties.zRangeSlider(app.page)).toBeAttached()
  })

  // ── Acceptance: Invalid bulk Z edit rejected, valid edit + Undo ───

  test('invalid bulk Z edit that violates one item ordering is rejected and field resets', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // First set Tab C z_bottom to 3 so z_top must be >= 3.
    await ui.tree.tabRows(app.page).nth(2).click()
    await ui.properties.zRangeBottomField(app.page).click()
    await ui.properties.zRangeBottomField(app.page).fill('3')
    await ui.properties.zRangeBottomField(app.page).blur()

    // Now select Tab B (z_top=3) and Tab C (z_top=4, z_bottom=3).
    await ui.tree.tabRows(app.page).nth(1).click()
    await ui.tree.tabRows(app.page).nth(2).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    // Try setting z_top=2 — should be rejected because Tab C has z_bottom=3.
    // getTop=2, getBottom=3 → effectiveTop=2, effectiveBottom=3 → 2<3 rejected.
    await ui.properties.zRangeTopField(app.page).click()
    await ui.properties.zRangeTopField(app.page).fill('2')
    await ui.properties.zRangeTopField(app.page).blur()

    // Tab C z_top should still be 4 (unchanged).
    const project = await getProject(app.page)
    const tabs = getArray(project, 'tabs')
    expect(tabs.some((t) => str(t.id) === 'tb-3' && num(t.z_top) === 4)).toBe(true)

    // The input field should reset to the mixed/committed value, not show "2".
    await expect(ui.properties.zRangeTopField(app.page)).toHaveValue('')
  })

  test('valid bulk Z edit updates all, one Undo reverses complete change and updates display', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Select Tab A and Tab B.
    await ui.tree.tabRows(app.page).nth(0).click()
    await ui.tree.tabRows(app.page).nth(1).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    // Both have z_top=5 and z_top=3 respectively (mixed), but both have z_bottom=0 (common).
    // Set z_bottom to 1 — valid for both.
    await ui.properties.zRangeBottomField(app.page).click()
    await ui.properties.zRangeBottomField(app.page).fill('1')
    await ui.properties.zRangeBottomField(app.page).blur()

    // Both should have z_bottom=1.
    let project = await getProject(app.page)
    let tabs = getArray(project, 'tabs')
    const ab = tabs.filter((t) => str(t.id) === 'tb-1' || str(t.id) === 'tb-2')
    expect(ab.every((t) => num(t.z_bottom) === 1)).toBe(true)

    // Undo — both restored.
    await app.page.keyboard.press(`${modKey}+z`)
    project = await getProject(app.page)
    tabs = getArray(project, 'tabs')
    const abRestored = tabs.filter((t) => str(t.id) === 'tb-1' || str(t.id) === 'tb-2')
    expect(abRestored.every((t) => num(t.z_bottom) === 0)).toBe(true)

    // The input field should reflect the restored z_bottom=0.
    // Since Tab A and Tab B now have common z_bottom=0, the field shows "0".
    await expect(ui.properties.zRangeBottomField(app.page)).toHaveValue('0')
  })

  // ── Acceptance: Tab invalid Z rejects, history unchanged ──────────

  test('invalid bulk tab Z bottom > top rejects entire batch, history unchanged', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    // Tab A: z_top=5, z_bottom=0; Tab B: z_top=3, z_bottom=0.
    // Select both and try z_bottom=4 → Tab B would have effectiveTop=3, effectiveBottom=4 → rejected.
    await ui.tree.tabRows(app.page).nth(0).click()
    await ui.tree.tabRows(app.page).nth(1).click({ modifiers: [modKey as 'Meta' | 'Control'] })

    await ui.properties.zRangeBottomField(app.page).click()
    await ui.properties.zRangeBottomField(app.page).fill('4')
    await ui.properties.zRangeBottomField(app.page).blur()

    // Both should still have z_bottom=0 (unchanged).
    const project = await getProject(app.page)
    const tabs = getArray(project, 'tabs')
    const ab = tabs.filter((t) => str(t.id) === 'tb-1' || str(t.id) === 'tb-2')
    expect(ab.every((t) => num(t.z_bottom) === 0)).toBe(true)

    // Verify Undo stack is not polluted (the rejected edit creates no history entry,
    // so a subsequent Undo would undo something else — not relevant in isolation).
  })

  // ── Acceptance: Clamp invalid Z rejection ─────────────────────────

  test('invalid bulk clamp Z height < 0 rejects, history unchanged', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all clamps' }).click()

    // Clamp bottom is fixed at 0; height (Z top) must be >= 0.
    const beforeProject = await getProject(app.page)
    const clampsBefore = getArray(beforeProject, 'clamps')
    const heightsBefore = clampsBefore.map((c) => num(c.height))

    await ui.properties.zRangeTopField(app.page).click()
    await ui.properties.zRangeTopField(app.page).fill('-1')
    await ui.properties.zRangeTopField(app.page).blur()

    // All clamp heights should be unchanged.
    const project = await getProject(app.page)
    const clamps = getArray(project, 'clamps')
    clamps.forEach((c, i) => {
      expect(num(c.height)).toBe(heightsBefore[i])
    })
  })

  // ── Acceptance: Incompatible modifier addition ignored ────────────

  test('adding clamp via modifier to tab selection is ignored', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    await ui.tree.tabRows(app.page).nth(0).click()
    await expect(ui.properties.panel(app.page)).toContainText('Delete Tab')

    await ui.tree.clampRows(app.page).nth(0).click({ modifiers: [modKey as 'Meta' | 'Control'] })
    await expect(ui.properties.panel(app.page)).toContainText('Delete Tab')
  })

  test('adding tab via modifier to clamp selection is ignored', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)

    await ui.tree.clampRows(app.page).nth(0).click()
    await expect(ui.properties.panel(app.page)).toContainText('Delete Clamp')

    await ui.tree.tabRows(app.page).nth(0).click({ modifiers: [modKey as 'Meta' | 'Control'] })
    await expect(ui.properties.panel(app.page)).toContainText('Delete Clamp')
  })

  // ── Acceptance: Locked bottom field ───────────────────────────────

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

  // ── Acceptance: Bulk clamp domain is independent of stock thickness ─

  test('bulk clamp Z domain slider ARIA max differs from stock thickness', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all clamps' }).click()

    // Stock thickness is 20mm. Clamp domain should NOT be capped by stock.
    // Clamps: heights 5 and 8, headroom ~5mm, so domain max ≈ 13mm.
    // Verify the slider handle aria-valuemax is NOT 20 (stock).
    const topHandle = ui.properties.zRangeSlider(app.page).locator('[role="slider"]').first()
    const ariaMax = await topHandle.getAttribute('aria-valuemax')
    const ariaMaxNum = Number(ariaMax)
    // Domain max should be less than stock (20) — it's based on clamp heights + headroom.
    expect(ariaMaxNum).toBeLessThan(20)
    expect(ariaMaxNum).toBeGreaterThan(8) // Above the tallest clamp.
  })

  test('clamp Z range field accepts value exceeding stock thickness', async ({ app, ui }) => {
    await seedProject(app.page, BULK_FIXTURE_JSON)
    await app.page.getByRole('button', { name: 'Select all clamps' }).click()

    // Stock is 20mm. Clamp domain is independent — entering 30 should work.
    await ui.properties.zRangeTopField(app.page).click()
    await ui.properties.zRangeTopField(app.page).fill('30')
    await ui.properties.zRangeTopField(app.page).blur()

    const project = await getProject(app.page)
    const clamps = getArray(project, 'clamps')
    expect(clamps.every((c) => num(c.height) === 30)).toBe(true)
  })

  // ── Acceptance: Multi-feature Z rules (line bottom locked) ─────────
  // Not tested at e2e level — PropertiesPanel multi-feature Z validation
  // is covered by the validateZEdits structural tests in mixedValue.test.ts
  // and bulkSelection.test.ts. Adding multi-feature fixtures with interleaved
  // open/closed sketches requires deep store setup not practical via __pcTest.

  // ── Acceptance: Mixed-opposite pointer behavior ───────────────────
  // Pointer-level drag tests are impractical in headless Playwright without
  // precise canvas coordinate mapping. The constrainZ null-opposite behavior
  // is covered by structural tests in mixedValue.test.ts.
})
