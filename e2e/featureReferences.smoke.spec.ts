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
 * Phase 4 Browser Smoke — Feature References wiring + DOM integrity
 *
 * Built on the shared fixture + selectors + helpers scaffolding.
 * Contains NO inline DOM selectors — every selector comes from the
 * `ui` module (e2e/selectors.ts).
 *
 * NON-GOALS: no geometry assertions, no pixel/screenshot diffing,
 * no WebGL canvas-content checks, no Tauri file dialogs.
 * ─────────────────────────────────────────────────────────────────────
 */

import { test, expect } from './fixtures'
import { seedLinkedProject } from './featureReferences.helpers'
import {
  seedProject,
  getProject,
  getPendingMove,
  completePendingMove,
  openRowContextMenu,
  clickMenuItem,
  rowByName,
  featureRowCount,
} from './helpers'

// ── Spec ────────────────────────────────────────────────────────────

test.describe('Feature references browser smoke', () => {
  // ── 1. Boots clean ─────────────────────────────────────────────

  test('app boots clean — canvas + feature tree present', async ({ app, ui }) => {
    await expect(ui.canvas.any(app.page)).toBeAttached()
    await expect(ui.tree.rows(app.page).first()).toBeAttached()
  })

  test('HTML5 drag reorders project features and folders', async ({ app, ui }) => {
    await seedLinkedProject(app.page)

    await rowByName(app.page, 'Linked B').dragTo(rowByName(app.page, 'Linked A'))
    await expect(ui.tree.featureRows(app.page).nth(0)).toContainText('Linked B')
    await expect(ui.tree.featureRows(app.page).nth(1)).toContainText('Linked A')

    await ui.tree.addFolderButton(app.page).click()
    await ui.tree.addFolderButton(app.page).click()
    await expect(ui.tree.folderRows(app.page)).toHaveCount(2)

    await ui.tree.folderRowByName(app.page, 'Folder 2')
      .dragTo(ui.tree.folderRowByName(app.page, 'Folder 1'))
    await expect(ui.tree.folderRows(app.page).nth(0)).toContainText('Folder 2')
    await expect(ui.tree.folderRows(app.page).nth(1)).toContainText('Folder 1')
  })

  // ── 2. Linked badge renders on the right rows ──────────────────

  test('linked badge visible on linked rows, absent on independent/unique', async ({ app, ui }) => {
    await seedLinkedProject(app.page)
    await expect(ui.tree.featureRows(app.page)).toHaveCount(4)

    // 2 badges: Linked A + Linked B sharing def-linked
    await expect(ui.badge.linked(app.page)).toHaveCount(2)

    for (const b of await ui.badge.linked(app.page).all()) {
      // Badge is visible (not zero-size, not blank)
      const box = await b.boundingBox()
      expect(box, 'linked badge should have non-zero bounding box').not.toBeNull()
      expect(box!.width, 'badge width > 0').toBeGreaterThan(0)
      expect(box!.height, 'badge height > 0').toBeGreaterThan(0)

      // The #link glyph resolves (SVG <use> element with href to icons.svg#link)
      const useEl = ui.badge.icon(b)
      await expect(useEl).toBeAttached()
      const href = await useEl.getAttribute('href')
      expect(href, 'badge icon should reference #link').toContain('#link')
    }

    // Independent and unique rows should NOT have linked badges
    await expect(ui.badge.linkedInRow(rowByName(app.page, 'Independent'))).toHaveCount(0)
    await expect(ui.badge.linkedInRow(rowByName(app.page, 'Former Link'))).toHaveCount(0)
  })

  // ── 3. Row layout intact ───────────────────────────────────────

  test('row layout — actions sit on same row as label, guarding overflow regression', async ({ app, ui }) => {
    await seedLinkedProject(app.page)

    const row = rowByName(app.page, 'Linked A')
    const labelBox = await ui.tree.labelWrap(row).boundingBox()
    const actionsBox = await ui.tree.actions(row).boundingBox()

    expect(labelBox, 'label should have bounding box').not.toBeNull()
    expect(actionsBox, 'actions should have bounding box').not.toBeNull()

    // Vertical centers within 5px → same visual row
    const labelMidY = labelBox!.y + labelBox!.height / 2
    const actionsMidY = actionsBox!.y + actionsBox!.height / 2
    expect(Math.abs(labelMidY - actionsMidY), 'label and actions should be on same row').toBeLessThan(5)
  })

  // ── 4. Make Unique unwires the link ─────────────────────────────

  test('Make Unique removes linked badge reactively', async ({ app, ui }) => {
    await seedLinkedProject(app.page)

    const row = rowByName(app.page, 'Linked A')
    const menu = await openRowContextMenu(app.page, row)

    // "Make Unique" and "Select Linked Instances" at top of linked context menu
    await expect(ui.contextMenu.item(menu, 'Make Unique')).toBeVisible()
    await expect(ui.contextMenu.item(menu, 'Select Linked Instances')).toBeVisible()

    await clickMenuItem(menu, 'Make Unique')
    await expect(menu).not.toBeVisible()

    // Badge on the made-unique row cleared reactively
    await expect(ui.badge.linkedInRow(row)).toHaveCount(0)

    // Other row sharing the same def now has only 1 instance → badge gone
    await expect(ui.badge.linkedInRow(rowByName(app.page, 'Linked B'))).toHaveCount(0)

    // P2: verify made-unique geometry is finite and valid (not NaN from broken matrix)
    const project = await getProject(app.page)
    const features = project.features as Array<Record<string, unknown>>
    const linkedA = features.find((f) => f.name === 'Linked A') as Record<string, unknown>
    expect(linkedA, 'Linked A should still exist after Make Unique').toBeDefined()
    const transform = linkedA.transform as Record<string, number>
    const definitionId = linkedA.definitionId as string
    const definitions = project.featureDefinitions as Record<string, Record<string, unknown>>
    const profile = definitions[definitionId].profile as Record<string, unknown>
    const start = profile.start as Record<string, number>
    expect(Number.isFinite(transform.e), `Linked A transform.e should be finite, got ${transform.e}`).toBe(true)
    expect(Number.isFinite(transform.f), `Linked A transform.f should be finite, got ${transform.f}`).toBe(true)
    expect(Number.isFinite(start.x), `Linked A start.x should be finite, got ${start.x}`).toBe(true)
    expect(Number.isFinite(start.y), `Linked A start.y should be finite, got ${start.y}`).toBe(true)
    // Linked A is at (0,0) in the original fixture — should stay near origin
    expect(Math.abs(start.x), `Linked A start.x expected near 0, got ${start.x}`).toBeLessThan(10)
    expect(Math.abs(start.y), `Linked A start.y expected near 0, got ${start.y}`).toBeLessThan(10)
  })

  // ── 5. Select Linked Instances ──────────────────────────────────

  test('Select Linked Instances selects the sibling set', async ({ app, ui }) => {
    await seedLinkedProject(app.page)

    const row = rowByName(app.page, 'Linked A')
    await row.click()
    await expect(row).toHaveClass(/tree-row--selected/)

    const menu = await openRowContextMenu(app.page, row)
    await clickMenuItem(menu, 'Select Linked Instances')

    const count = await ui.tree.selectedRows(app.page).count()
    expect(count, 'should select at least 2 rows (linked siblings)').toBeGreaterThanOrEqual(2)
  })

  // ── 6. Copy = reference by default ──────────────────────────────

  test('Copy produces a linked instance sharing the definition', async ({ app, ui }) => {
    await seedLinkedProject(app.page)

    const row = rowByName(app.page, 'Independent')
    await row.click()
    const menu = await openRowContextMenu(app.page, row)
    await clickMenuItem(menu, 'Copy')

    // Verify pending copy mode is set (wiring)
    const pending = await getPendingMove(app.page)
    expect(pending).toEqual({ mode: 'copy', entityType: 'feature', entityIds: ['f-independent'] })

    // Complete placement — canvas pointer events don't reliably set
    // fromPoint/toPoint in headless Chromium.
    await completePendingMove(app.page, 30, 110)

    // 5 rows: 4 original + 1 copy
    await expect(featureRowCount(app.page)).toHaveCount(5)

    // Before copy: 2 badges (def-linked). After: independent pair → +2 = 4.
    await expect(ui.badge.linked(app.page)).toHaveCount(4)

    // P2: verify copied feature geometry is finite and correctly placed
    const project = await getProject(app.page)
    const features = project.features as Array<Record<string, unknown>>
    // Find the copy — it should have a different id from the originals
    const originalIds = new Set(['f-linked-a', 'f-linked-b', 'f-independent', 'f-unique'])
    const copied = features.find((f) => !originalIds.has(f.id as string)) as Record<string, unknown>
    expect(copied, 'copied feature should exist with a new id').toBeDefined()
    const copiedTransform = copied.transform as Record<string, number>
    expect(Number.isFinite(copiedTransform.e), `copied transform.e should be finite, got ${copiedTransform.e}`).toBe(true)
    expect(Number.isFinite(copiedTransform.f), `copied transform.f should be finite, got ${copiedTransform.f}`).toBe(true)
    // The copy was placed near (30, 110) via completePendingMove
    expect(copiedTransform.e, `copied transform.e should be near 30, got ${copiedTransform.e}`).toBeGreaterThan(0)
    expect(copiedTransform.f, `copied transform.f should be near 110, got ${copiedTransform.f}`).toBeGreaterThan(50)
  })

  // ── 7. Edit Sketch enters/exits ─────────────────────────────────

  test('Edit Sketch enters and cancels cleanly', async ({ app, ui }) => {
    await seedLinkedProject(app.page)

    const row = rowByName(app.page, 'Linked A')
    const menu = await openRowContextMenu(app.page, row)
    await clickMenuItem(menu, 'Edit Sketch')

    // Sketch edit toolbar should appear
    await app.page.waitForTimeout(500)
    const groups = await ui.toolbar.groups(app.page).count()
    expect(groups, 'should have at least one toolbar group visible').toBeGreaterThan(0)

    // Escape cancels sketch edit
    await app.page.keyboard.press('Escape')
    await app.page.waitForTimeout(300)
    const addPointAfter = await ui.toolbar.addPointButton(app.page).count()
    expect(addPointAfter, 'sketch edit tools should disappear after Escape').toBe(0)
  })

  // ── 8. Properties grouping ──────────────────────────────────────

  test('Properties panel shows SHAPE vs INSTANCE grouping for linked features', async ({ app, ui }) => {
    await seedLinkedProject(app.page)

    // Select a linked feature
    await rowByName(app.page, 'Linked A').click()

    // Shape section should indicate shared instances
    const shapeHeader = ui.properties.text(app.page, /Shape/)
    await expect(shapeHeader.first()).toBeVisible()
    const shapeTitle = await shapeHeader.first().textContent()
    expect(shapeTitle, 'Shape section should indicate shared instances').toContain('shared with')

    // Instance section (exact match avoids "shared with N instances")
    await expect(ui.properties.exactText(app.page, 'Instance')).toBeVisible()

    // Select independent feature → Shape should NOT show "shared"
    await rowByName(app.page, 'Independent').click()
    await expect(ui.properties.exactText(app.page, 'Shape')).toBeVisible({ timeout: 3000 })
  })

  // ── 9. Save→load round-trip ─────────────────────────────────────

  test('save→load round-trip preserves tree structure and badges', async ({ app, ui }) => {
    await seedLinkedProject(app.page)

    const json = JSON.stringify(await getProject(app.page))
    await seedProject(app.page, json)
    await app.page.waitForTimeout(500)

    await expect(ui.tree.featureRows(app.page)).toHaveCount(4)
    await expect(ui.badge.linked(app.page)).toHaveCount(2)
    const saved = await getProject(app.page)
    expect(saved.version).toBe('3.0')
    expect((saved.features as Array<Record<string, unknown>>).every((feature) => !('sketch' in feature))).toBe(true)
  })

  test('legacy project warns, becomes unsaved, and saves as strict 3.0', async ({ app }) => {
    await seedLinkedProject(app.page)
    const current = await getProject(app.page)
    const instance = (current.features as Array<Record<string, unknown>>)[0]
    const definitions = current.featureDefinitions as Record<string, Record<string, unknown>>
    const definition = definitions[instance.definitionId as string]
    const legacyFeature = {
      id: instance.id,
      name: instance.name,
      kind: definition.kind,
      folderId: instance.folderId,
      sketch: {
        profile: definition.profile,
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: definition.dimensions,
        constraints: instance.constraints,
      },
      operation: definition.operation,
      text: definition.text,
      stl: definition.stl,
      z_top: instance.z_top,
      z_bottom: instance.z_bottom,
      visible: instance.visible,
      locked: instance.locked,
    }
    const legacy = {
      ...current,
      version: '2.1',
      featureDefinitions: {},
      features: [legacyFeature],
      featureTree: [{ type: 'feature', featureId: instance.id }],
    }

    let alertMessage = ''
    app.page.on('dialog', async (dialog) => {
      alertMessage = dialog.message()
      await dialog.accept()
    })
    await seedProject(app.page, JSON.stringify(legacy))
    await expect(app.page.getByText('Unsaved', { exact: true })).toBeVisible()
    await expect.poll(() => alertMessage).toContain('converted in memory')
    expect(alertMessage).toContain('not compatible with older')

    const saved = await getProject(app.page)
    expect(saved.version).toBe('3.0')
    expect((saved.features as Array<Record<string, unknown>>).every((feature) => !('sketch' in feature))).toBe(true)
  })

  // ── 10. Newer-version warning ────────────────────────────────────

  test('newer-version project fires forward-compat alert and still loads', async ({ app, ui }) => {
    let alertMessage = ''
    app.page.on('dialog', async (dialog) => {
      alertMessage = dialog.message()
      await dialog.accept()
    })

    // Load a project with version > LATEST_PROJECT_VERSION (3.0)
    const base = await getProject(app.page)
    ;(base as Record<string, unknown>).version = '4.0'
    await seedProject(app.page, JSON.stringify(base))

    expect(alertMessage, 'should show forward-compat warning alert').toContain('newer version')
    await expect(ui.canvas.any(app.page)).toBeAttached()
  })
})
