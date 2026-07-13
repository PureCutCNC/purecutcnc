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
 * Import dialog smoke — real user flow through the dialog, file upload,
 * mode selection, classification summary, and import verification.
 *
 * Store-level import/classifier behavior is covered by focused tests.
 * These tests exercise the dialog wiring, DOM, and end-to-end store
 * integration through the real import path.
 */

import { test, expect } from './fixtures'
import { getProject } from './helpers'
import {
  SVG_FILL_AND_STROKE,
  DXF_NESTED_CLASSIFIER,
  selectSourceUnitsMm,
  openImportDialog,
} from './importGeometry.helpers'

function projectFeatureOperations(project: Record<string, unknown>): Array<string | undefined> {
  const features = project.features as Array<{ definitionId: string }>
  const definitions = project.featureDefinitions as Record<string, { operation?: string }>
  return features.map((feature) => definitions[feature.definitionId]?.operation)
}

// ── Dialog wiring ──────────────────────────────────────────────────────

test('dialog opens and closes', async ({ app }) => {
  const dialog = await openImportDialog(app.page)
  await app.page.locator('.dialog-close').click()
  await expect(dialog).not.toBeVisible({ timeout: 3000 })
})

test('import button disabled without file', async ({ app }) => {
  await openImportDialog(app.page)
  const importBtn = app.page.locator('.dialog-footer .btn-primary')
  await expect(importBtn).toBeDisabled()
})

test('geometry mode control hidden before file loaded', async ({ app }) => {
  const dialog = await openImportDialog(app.page)
  const modeSelect = dialog.locator('[data-testid="import-geometry-mode"]')
  await expect(modeSelect).not.toBeVisible()
})

// ── SVG: Auto mode ─────────────────────────────────────────────────────

test.describe('SVG import', () => {
  test('auto mode classifies filled as Add and stroke-only as closed Line', async ({ app }) => {
    const dialog = await openImportDialog(app.page)

    // Upload the synthetic SVG
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'test.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(SVG_FILL_AND_STROKE),
    })

    // Select source units (parse + classify require units to be set)
    await selectSourceUnitsMm(dialog)

    // Wait for analysis summary to appear
    const summary = dialog.locator('[data-testid="import-analysis-summary"]')
    await expect(summary).toBeVisible({ timeout: 10000 })

    // Auto mode: 2 total, 1 Add, 1 closed Line, 0 Subtract, 0 open Lines
    await expect(summary.locator('[data-testid="import-summary-total"] strong')).toHaveText('2')
    await expect(summary.locator('[data-testid="import-summary-add"] strong')).toHaveText('1')
    await expect(summary.locator('[data-testid="import-summary-closed-line"] strong')).toHaveText('1')
    await expect(summary.locator('[data-testid="import-summary-subtract"]')).not.toBeAttached()
    await expect(summary.locator('[data-testid="import-summary-open-line"]')).not.toBeAttached()
  })

  test('paths mode reclassifies both as closed Lines without re-upload', async ({ app }) => {
    const dialog = await openImportDialog(app.page)

    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'test.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(SVG_FILL_AND_STROKE),
    })

    await selectSourceUnitsMm(dialog)

    const summary = dialog.locator('[data-testid="import-analysis-summary"]')
    await expect(summary).toBeVisible({ timeout: 10000 })

    // Switch to Paths — summary updates without re-upload
    await dialog.locator('#import-geometry-mode').selectOption('paths')

    // Summary updates: 2 total, 2 closed Lines, 0 Add/Subtract/open
    await expect(summary.locator('[data-testid="import-summary-total"] strong')).toHaveText('2')
    await expect(summary.locator('[data-testid="import-summary-closed-line"] strong')).toHaveText('2')
    await expect(summary.locator('[data-testid="import-summary-add"]')).not.toBeAttached()
    await expect(summary.locator('[data-testid="import-summary-subtract"]')).not.toBeAttached()
    await expect(summary.locator('[data-testid="import-summary-open-line"]')).not.toBeAttached()
  })

  test('solid regions mode reclassifies both as Add', async ({ app }) => {
    const dialog = await openImportDialog(app.page)

    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'test.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(SVG_FILL_AND_STROKE),
    })

    await selectSourceUnitsMm(dialog)

    const summary = dialog.locator('[data-testid="import-analysis-summary"]')
    await expect(summary).toBeVisible({ timeout: 10000 })

    await dialog.locator('#import-geometry-mode').selectOption('solid-regions')

    // Summary updates: 2 total, 2 Add, 0 Lines/Subtract
    await expect(summary.locator('[data-testid="import-summary-total"] strong')).toHaveText('2')
    await expect(summary.locator('[data-testid="import-summary-add"] strong')).toHaveText('2')
    await expect(summary.locator('[data-testid="import-summary-closed-line"]')).not.toBeAttached()
    await expect(summary.locator('[data-testid="import-summary-subtract"]')).not.toBeAttached()
    await expect(summary.locator('[data-testid="import-summary-open-line"]')).not.toBeAttached()
  })

  test('import with auto mode creates correct project feature roles', async ({ app }) => {
    const dialog = await openImportDialog(app.page)

    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'test.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(SVG_FILL_AND_STROKE),
    })

    await selectSourceUnitsMm(dialog)

    const summary = dialog.locator('[data-testid="import-analysis-summary"]')
    await expect(summary).toBeVisible({ timeout: 10000 })

    // Switch back to Auto for import
    await dialog.locator('#import-geometry-mode').selectOption('auto')
    await expect(summary.locator('[data-testid="import-summary-add"] strong')).toHaveText('1')

    // Click Import
    await dialog.locator('.dialog-footer .btn-primary').click()

    // Wait for dialog to close
    await expect(dialog).not.toBeVisible({ timeout: 5000 })

    // Verify actual project features via existing test seam
    const project = await getProject(app.page)
    const ops = projectFeatureOperations(project).sort()
    expect(ops).toHaveLength(2)
    expect(ops).toEqual(['add', 'line'])
  })
})

// ── DXF: Auto mode (nesting-aware solids) ──────────────────────────────

test.describe('DXF import', () => {
  test('auto mode classifies outer as Add, inner as Subtract, open as Line', async ({ app }) => {
    const dialog = await openImportDialog(app.page)

    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'test.dxf',
      mimeType: 'application/dxf',
      buffer: Buffer.from(DXF_NESTED_CLASSIFIER),
    })

    await selectSourceUnitsMm(dialog)

    const summary = dialog.locator('[data-testid="import-analysis-summary"]')
    await expect(summary).toBeVisible({ timeout: 10000 })

    // Auto mode: 3 total, 1 Add, 1 Subtract, 1 open Line, 0 closed Lines
    await expect(summary.locator('[data-testid="import-summary-total"] strong')).toHaveText('3')
    await expect(summary.locator('[data-testid="import-summary-add"] strong')).toHaveText('1')
    await expect(summary.locator('[data-testid="import-summary-subtract"] strong')).toHaveText('1')
    await expect(summary.locator('[data-testid="import-summary-open-line"] strong')).toHaveText('1')
    await expect(summary.locator('[data-testid="import-summary-closed-line"]')).not.toBeAttached()
  })

  test('paths mode reclassifies closed contours as Lines', async ({ app }) => {
    const dialog = await openImportDialog(app.page)

    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'test.dxf',
      mimeType: 'application/dxf',
      buffer: Buffer.from(DXF_NESTED_CLASSIFIER),
    })

    await selectSourceUnitsMm(dialog)

    const summary = dialog.locator('[data-testid="import-analysis-summary"]')
    await expect(summary).toBeVisible({ timeout: 10000 })

    await dialog.locator('#import-geometry-mode').selectOption('paths')

    // Paths: 3 total, 2 closed Lines, 1 open Line, 0 Add/Subtract
    await expect(summary.locator('[data-testid="import-summary-total"] strong')).toHaveText('3')
    await expect(summary.locator('[data-testid="import-summary-closed-line"] strong')).toHaveText('2')
    await expect(summary.locator('[data-testid="import-summary-open-line"] strong')).toHaveText('1')
    await expect(summary.locator('[data-testid="import-summary-add"]')).not.toBeAttached()
    await expect(summary.locator('[data-testid="import-summary-subtract"]')).not.toBeAttached()
  })

  test('import with auto mode creates parent-before-child Add/Subtract order', async ({ app }) => {
    const dialog = await openImportDialog(app.page)

    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'test.dxf',
      mimeType: 'application/dxf',
      buffer: Buffer.from(DXF_NESTED_CLASSIFIER),
    })

    await selectSourceUnitsMm(dialog)

    const summary = dialog.locator('[data-testid="import-analysis-summary"]')
    await expect(summary).toBeVisible({ timeout: 10000 })

    // Ensure Auto is selected
    await expect(dialog.locator('#import-geometry-mode')).toHaveValue('auto')

    // Click Import
    await dialog.locator('.dialog-footer .btn-primary').click()
    await expect(dialog).not.toBeVisible({ timeout: 5000 })

    // Verify actual project features
    const project = await getProject(app.page)
    const operations = projectFeatureOperations(project)
    expect(operations.length).toBeGreaterThanOrEqual(3)

    // Add parent must precede Subtract child
    const addIdx = operations.findIndex((operation) => operation === 'add')
    const subIdx = operations.findIndex((operation) => operation === 'subtract')
    expect(addIdx).toBeGreaterThanOrEqual(0)
    expect(subIdx).toBeGreaterThanOrEqual(0)
    expect(addIdx).toBeLessThan(subIdx)

    // An open Line feature exists
    const lineIdx = operations.findIndex((operation) => operation === 'line')
    expect(lineIdx).toBeGreaterThanOrEqual(0)
  })
})

// ── Tablet landscape layout ────────────────────────────────────────────

test('SVG import dialog usable at landscape tablet viewport', async ({ app }) => {
  await app.page.setViewportSize({ width: 1024, height: 768 })

  const dialog = await openImportDialog(app.page)

  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'test.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(SVG_FILL_AND_STROKE),
  })

  await selectSourceUnitsMm(dialog)

  const summary = dialog.locator('[data-testid="import-analysis-summary"]')
  await expect(summary).toBeVisible({ timeout: 10000 })

  // Mode selector is visible and usable
  const modeSelect = dialog.locator('#import-geometry-mode')
  await expect(modeSelect).toBeVisible()
  await expect(modeSelect).toHaveValue('auto')

  // Switch mode and confirm summary updates
  await modeSelect.selectOption('paths')
  await expect(summary.locator('[data-testid="import-summary-closed-line"] strong')).toHaveText('2')

  // Dialog stays within viewport (no horizontal overflow)
  const dialogBox = await dialog.boundingBox()
  expect(dialogBox).not.toBeNull()
  const viewport = app.page.viewportSize()
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport!.width + 1)
  expect(dialogBox!.x).toBeGreaterThanOrEqual(-1)

  // Footer is within viewport
  const footer = dialog.locator('.dialog-footer')
  const footerBox = await footer.boundingBox()
  expect(footerBox).not.toBeNull()
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(viewport!.height + 1)

  // Close normally
  await app.page.locator('.dialog-close').click()
  await expect(dialog).not.toBeVisible({ timeout: 3000 })
})
