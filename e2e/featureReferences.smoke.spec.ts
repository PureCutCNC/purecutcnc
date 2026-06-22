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
 * Phase 4 Browser Smoke: Feature References wiring + DOM integrity
 *
 * Covers the one layer store-level suites structurally can't reach:
 * that the rendered DOM and menu→action wiring are actually intact.
 *
 * NON-GOALS (see handoff):
 *  - No geometry/coordinate/segment-kind assertions
 *  - No screenshot/pixel diffing; no WebGL canvas-content checks
 *  - No Tauri native file-dialog flows
 * ─────────────────────────────────────────────────────────────────────
 */

import { test, expect, type Page } from '@playwright/test'

// ── Helpers ─────────────────────────────────────────────────────────

/** Resolved rect profile at world position. */
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

/** Rect FeatureDefinition (canonical / untransformed coordinates). */
function rectDef(id: string, cx: number, cy: number, w: number, h: number) {
  return {
    id,
    kind: 'rect' as const,
    profile: {
      start: { x: cx, y: cy },
      segments: [
        { type: 'line' as const, to: { x: cx + w, y: cy } },
        { type: 'line' as const, to: { x: cx + w, y: cy + h } },
        { type: 'line' as const, to: { x: cx, y: cy + h } },
        { type: 'line' as const, to: { x: cx, y: cy } },
      ],
      closed: true,
    },
    dimensions: [] as unknown[],
    text: null,
    stl: null,
    operation: 'add' as const,
  }
}

/** Build a linked SketchFeature with definitionId + transform and world-coord profile. */
function linkedFeature(
  id: string,
  name: string,
  definitionId: string,
  tx: number,
  ty: number,
  defCx: number,
  defCy: number,
  defW: number,
  defH: number,
) {
  const rx = defCx + tx
  const ry = defCy + ty
  return {
    id,
    name,
    kind: 'rect' as const,
    folderId: null,
    sketch: {
      profile: resolvedRectProfile(rx, ry, defW, defH),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [] as unknown[],
      constraints: [] as unknown[],
    },
    operation: 'add' as const,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
    definitionId,
    transform: [1, 0, 0, 1, tx, ty] as [number, number, number, number, number, number],
  }
}

/**
 * Build the linked-fixture project JSON in Node.js so it can be passed to
 * page.evaluate (browser context has no access to the helper functions).
 */
function buildLinkedProjectJson(): string {
  const defs: Record<string, unknown> = {}
  defs['def-linked'] = rectDef('def-linked', 0, 0, 60, 40)
  defs['def-independent'] = rectDef('def-independent', 0, 0, 60, 40)
  defs['def-unique'] = rectDef('def-unique', 0, 0, 60, 40)

  const features = [
    linkedFeature('f-linked-a', 'Linked A', 'def-linked', 0, 0, 0, 0, 60, 40),
    linkedFeature('f-linked-b', 'Linked B', 'def-linked', 80, 0, 0, 0, 60, 40),
    linkedFeature('f-independent', 'Independent', 'def-independent', 0, 80, 0, 0, 60, 40),
    linkedFeature('f-unique', 'Former Link', 'def-unique', 80, 80, 0, 0, 60, 40),
  ]

  const stockW = 200
  const stockH = 160
  return JSON.stringify({
    version: '2.0',
    meta: {
      name: 'E2E Smoke Fixture',
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      units: 'inch',
      showFeatureInfo: true,
      showDimensions: true,
      copyMode: 'reference',
      maxTravelZ: 2,
      operationClearanceZ: 0.2,
      clampClearanceXY: 0.5,
      clampClearanceZ: 0.2,
      machineDefinitions: [],
      selectedMachineId: null,
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
      profile: resolvedRectProfile(0, 0, stockW, stockH),
      thickness: 2,
      material: 'aluminum_6061',
      color: '#b9a83c',
      visible: true,
      origin: { x: 0, y: 0 },
    },
    origin: { name: 'Origin', x: stockW / 2, y: stockH / 2, z: 2, visible: true },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: defs,
    features,
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  })
}

const LINKED_FIXTURE_JSON = buildLinkedProjectJson()

/** Seed the store with the linked-fixture project. */
async function seedLinkedProject(page: Page): Promise<void> {
  await page.evaluate(async (json: string) => {
    const w = window as unknown as { __pcTest: { loadProject: (j: string) => Promise<void> } }
    await w.__pcTest.loadProject(json)
  }, LINKED_FIXTURE_JSON)
}

// ── Console-error collector ─────────────────────────────────────────

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(err.message))
  return errors
}

/** Assert zero console errors so far. */
function assertNoConsoleErrors(errors: string[]) {
  expect(errors, 'console errors: ' + errors.join(' | ')).toHaveLength(0)
}

// ── Spec ────────────────────────────────────────────────────────────

test.describe('Feature references browser smoke', () => {
  let consoleErrors: string[] = []

  test.beforeEach(async ({ page }) => {
    consoleErrors = collectConsoleErrors(page)
  })

  // ── 1. Boots clean ─────────────────────────────────────────────

  test('app boots clean — canvas + feature tree present, zero console errors', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('canvas', { timeout: 15000 })
    await page.waitForSelector('.tree-row', { timeout: 10000 })

    assertNoConsoleErrors(consoleErrors)
  })

  // ── 2. Linked badge renders on the right rows ──────────────────

  test('linked badge visible on linked rows, absent on independent/unique', async ({ page }) => {
    await page.goto('/')
    await seedLinkedProject(page)
    await page.waitForSelector('.tree-row', { timeout: 10000 })

    // Should have 4 feature rows
    const rows = page.locator('.tree-row.tree-row--feature')
    await expect(rows).toHaveCount(4)

    // Linked rows: rows with .tree-linked-badge
    const linkedBadges = page.locator('.tree-linked-badge')
    await expect(linkedBadges).toHaveCount(2)

    for (const badge of await linkedBadges.all()) {
      // Badge is visible (not zero-size, not blank)
      const box = await badge.boundingBox()
      expect(box, 'linked badge should have non-zero bounding box').not.toBeNull()
      expect(box!.width, 'badge width > 0').toBeGreaterThan(0)
      expect(box!.height, 'badge height > 0').toBeGreaterThan(0)

      // The #link glyph resolves (SVG <use> element with href to icons.svg#link)
      const useEl = badge.locator('svg use')
      await expect(useEl).toBeAttached()
      const href = await useEl.getAttribute('href')
      expect(href, 'badge icon should reference #link').toContain('#link')
    }

    // The independent and unique rows should NOT have linked badges
    const independentRow = page.locator('.tree-row--feature').filter({ hasText: 'Independent' })
    const uniqueRow = page.locator('.tree-row--feature').filter({ hasText: 'Former Link' })
    await expect(independentRow.locator('.tree-linked-badge')).toHaveCount(0)
    await expect(uniqueRow.locator('.tree-linked-badge')).toHaveCount(0)

    assertNoConsoleErrors(consoleErrors)
  })

  // ── 3. Row layout intact ───────────────────────────────────────

  test('row layout — actions sit on same row as label, guarding overflow regression', async ({ page }) => {
    await page.goto('/')
    await seedLinkedProject(page)
    await page.waitForSelector('.tree-row', { timeout: 10000 })

    const linkedRow = page.locator('.tree-row--feature').filter({ hasText: 'Linked A' })
    const labelWrap = linkedRow.locator('.tree-label-wrap')
    const actions = linkedRow.locator('.tree-row-actions')

    const labelBox = await labelWrap.boundingBox()
    const actionsBox = await actions.boundingBox()

    expect(labelBox, 'label should have bounding box').not.toBeNull()
    expect(actionsBox, 'actions should have bounding box').not.toBeNull()

    // Both should be on the same visual row: vertical centers within 5px
    const labelMidY = labelBox!.y + labelBox!.height / 2
    const actionsMidY = actionsBox!.y + actionsBox!.height / 2
    expect(Math.abs(labelMidY - actionsMidY), 'label and actions should be on same row').toBeLessThan(5)

    assertNoConsoleErrors(consoleErrors)
  })

  // ── 4. Make Unique unwires the link ─────────────────────────────

  test('Make Unique removes linked badge reactively', async ({ page }) => {
    await page.goto('/')
    await seedLinkedProject(page)
    await page.waitForSelector('.tree-row', { timeout: 10000 })

    const linkedRow = page.locator('.tree-row--feature').filter({ hasText: 'Linked A' })

    // Right-click to open context menu
    await linkedRow.click({ button: 'right' })
    const menu = page.locator('.feature-context-menu')
    await expect(menu).toBeVisible()

    // "Make Unique" should be present
    const makeUniqueBtn = menu.locator('.feature-context-menu__item', { hasText: 'Make Unique' })
    await expect(makeUniqueBtn).toBeVisible()

    // "Select Linked Instances" should also be present
    const selectLinkedBtn = menu.locator('.feature-context-menu__item', { hasText: 'Select Linked Instances' })
    await expect(selectLinkedBtn).toBeVisible()

    // Click Make Unique
    await makeUniqueBtn.click()
    // Menu should close
    await expect(menu).not.toBeVisible()

    // The badge on this row should be gone
    await expect(linkedRow.locator('.tree-linked-badge')).toHaveCount(0)

    // The other linked row (Linked B) was sharing the same def; now it's
    // the only instance so its badge should be gone too.
    const linkedBRow = page.locator('.tree-row--feature').filter({ hasText: 'Linked B' })
    await expect(linkedBRow.locator('.tree-linked-badge')).toHaveCount(0)

    assertNoConsoleErrors(consoleErrors)
  })

  // ── 5. Select Linked Instances ──────────────────────────────────

  test('Select Linked Instances selects the sibling set', async ({ page }) => {
    await page.goto('/')
    await seedLinkedProject(page)
    await page.waitForSelector('.tree-row', { timeout: 10000 })

    const linkedRow = page.locator('.tree-row--feature').filter({ hasText: 'Linked A' })

    // Select this row first (left click)
    await linkedRow.click()
    await expect(linkedRow).toHaveClass(/tree-row--selected/)

    // Right-click → Select Linked Instances
    await linkedRow.click({ button: 'right' })
    const menu = page.locator('.feature-context-menu')
    await expect(menu).toBeVisible()

    const selectLinkedBtn = menu.locator('.feature-context-menu__item', { hasText: 'Select Linked Instances' })
    await selectLinkedBtn.click()

    // Both linked rows should now be selected
    const selectedRows = page.locator('.tree-row--selected')
    // At minimum, the two linked rows should be selected
    const count = await selectedRows.count()
    expect(count, 'should select at least 2 rows (linked siblings)').toBeGreaterThanOrEqual(2)

    assertNoConsoleErrors(consoleErrors)
  })

  // ── 6. Copy = reference by default ──────────────────────────────

  test('Copy produces a linked instance sharing the definition', async ({ page }) => {
    await page.goto('/')
    await seedLinkedProject(page)
    await page.waitForSelector('.tree-row', { timeout: 10000 })

    const independentRow = page.locator('.tree-row--feature').filter({ hasText: 'Independent' })
    await independentRow.click()

    // Right-click → Copy
    await independentRow.click({ button: 'right' })
    const menu = page.locator('.feature-context-menu')
    await expect(menu).toBeVisible()

    const copyBtn = menu.locator('.feature-context-menu__item', { hasText: 'Copy' })
    await copyBtn.click()

    // Copy sets pendingMove. Verify via seam, then complete placement.
    // (Headless canvas pointer events don't reliably set fromPoint/toPoint.)
    await page.waitForTimeout(500)
    const pendingState = await page.evaluate(async () => {
      const w = window as unknown as { __pcTest: { getPendingMove: () => Promise<unknown> } }
      return w.__pcTest.getPendingMove()
    })
    expect(pendingState).toEqual({
      mode: 'copy',
      entityType: 'feature',
      entityIds: ['f-independent'],
    })

    // Complete placement at a point near the original feature
    await page.evaluate(async () => {
      const w = window as unknown as { __pcTest: { completePendingMove: (x: number, y: number) => Promise<void> } }
      await w.__pcTest.completePendingMove(30, 110)
    })

    // A new tree row should appear (the copy)
    await page.waitForTimeout(500)
    const allRows = page.locator('.tree-row.tree-row--feature')
    const rowCount = await allRows.count()
    expect(rowCount, 'should have 5 rows after copy').toBe(5)

    // The copy should be a linked instance. Before copy we had:
    //   2 badges (def-linked: Linked A + Linked B)
    // After copy: def-independent now has 2 instances too → +2 badges = 4 total
    const linkedBadges = page.locator('.tree-linked-badge')
    const badgeCount = await linkedBadges.count()
    expect(badgeCount, 'copy should produce linked badges for def-independent too').toBe(4)

    assertNoConsoleErrors(consoleErrors)
  })

  // ── 7. Edit Sketch enters/exits ─────────────────────────────────

  test('Edit Sketch enters and cancels cleanly', async ({ page }) => {
    await page.goto('/')
    await seedLinkedProject(page)
    await page.waitForSelector('.tree-row', { timeout: 10000 })

    const linkedRow = page.locator('.tree-row--feature').filter({ hasText: 'Linked A' })
    await linkedRow.click({ button: 'right' })
    const menu = page.locator('.feature-context-menu')
    await expect(menu).toBeVisible()

    // Click Edit Sketch
    const editBtn = menu.locator('.feature-context-menu__item', { hasText: 'Edit Sketch' })
    await editBtn.click()

    // Sketch edit mode should be active — the SketchEditActions toolbar appears.
    await page.waitForTimeout(500) // let toolbar react

    // The ToolRail or toolbar should show sketch edit tools.
    // Check for toolbar buttons with Edit Sketch labels.
    const addPointBtn = page.locator('button[aria-label="Add point"]')
    const sketchEditGroup = page.locator('.toolbar-group')
    const groupCount = await sketchEditGroup.count()
    expect(groupCount, 'should have at least one toolbar group visible').toBeGreaterThan(0)

    // Press Escape to cancel sketch edit
    await page.keyboard.press('Escape')

    // Sketch edit toolbar should disappear
    await page.waitForTimeout(300)
    const addPointAfterCancel = await addPointBtn.count()
    expect(addPointAfterCancel, 'sketch edit tools should disappear after Escape').toBe(0)

    assertNoConsoleErrors(consoleErrors)
  })

  // ── 8. Properties grouping ──────────────────────────────────────

  test('Properties panel shows SHAPE vs INSTANCE grouping for linked features', async ({ page }) => {
    await page.goto('/')
    await seedLinkedProject(page)
    await page.waitForSelector('.tree-row', { timeout: 10000 })

    // Select a linked feature
    const linkedRow = page.locator('.tree-row--feature').filter({ hasText: 'Linked A' })
    await linkedRow.click()

    // The Properties panel should show the disclosure sections.
    // For a linked feature: "Shape (shared with N instances)" + "Instance"
    const shapeHeader = page.locator('.properties-panel').getByText(/Shape/)
    await expect(shapeHeader.first()).toBeVisible()

    // The linked feature should show the shared count
    const shapeTitle = await shapeHeader.first().textContent()
    expect(shapeTitle, 'Shape section should indicate shared instances').toContain('shared with')

    // Instance section should also be present (exact match to avoid
    // matching "shared with N instances")
    const instanceHeader = page.locator('.properties-panel').getByText('Instance', { exact: true })
    await expect(instanceHeader).toBeVisible()

    // Now select the independent feature — Shape should NOT show "shared"
    const independentRow = page.locator('.tree-row--feature').filter({ hasText: 'Independent' })
    await independentRow.click()

    const shapeHeader2 = page.locator('.properties-panel').getByText('Shape', { exact: true })
    await expect(shapeHeader2).toBeVisible({ timeout: 3000 })

    assertNoConsoleErrors(consoleErrors)
  })

  // ── 9. Save→load round-trip ─────────────────────────────────────

  test('save→load round-trip preserves tree structure and badges', async ({ page }) => {
    await page.goto('/')
    await seedLinkedProject(page)
    await page.waitForSelector('.tree-row', { timeout: 10000 })

    // Snapshot the project
    const json = await page.evaluate(async () => {
      const w = window as unknown as { __pcTest: { getProject: () => Promise<Record<string, unknown>> } }
      return JSON.stringify(await w.__pcTest.getProject())
    })

    // Reload it
    await page.evaluate(async (projectJson: string) => {
      const w = window as unknown as { __pcTest: { loadProject: (j: string) => Promise<void> } }
      await w.__pcTest.loadProject(projectJson)
    }, json)

    // Wait for React to settle
    await page.waitForTimeout(500)

    // Tree should have 4 feature rows again
    const rows = page.locator('.tree-row.tree-row--feature')
    await expect(rows).toHaveCount(4)

    // Linked badges should be restored (2 linked instances of def-linked)
    const linkedBadges = page.locator('.tree-linked-badge')
    await expect(linkedBadges).toHaveCount(2)

    assertNoConsoleErrors(consoleErrors)
  })

  // ── 10. Newer-version warning ────────────────────────────────────

  test('newer-version project fires forward-compat alert and still loads', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('canvas', { timeout: 15000 })

    // Listen for alert dialog
    let alertMessage = ''
    page.on('dialog', async (dialog) => {
      alertMessage = dialog.message()
      await dialog.accept()
    })

    // Load a project with version > LATEST_PROJECT_VERSION (2.0)
    await page.evaluate(async () => {
      const w = window as unknown as { __pcTest: { getProject: () => Promise<Record<string, unknown>>; loadProject: (j: string) => Promise<void> } }
      const base = JSON.parse(JSON.stringify(await w.__pcTest.getProject())) as Record<string, unknown>
      ;(base as any).version = '3.0'
      await w.__pcTest.loadProject(JSON.stringify(base))
    })

    // Alert should have fired
    expect(alertMessage, 'should show forward-compat warning alert').toContain('newer version')

    // App should still have rendered content (not a white screen)
    await expect(page.locator('canvas').first()).toBeAttached()
  })
})
