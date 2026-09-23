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

import { chromium } from '@playwright/test'
import { test, expect } from './fixtures'
import { getProject } from './helpers'
import {
  SVG_FILL_AND_STROKE,
  DXF_NESTED_CLASSIFIER,
  selectSourceUnitsMm,
  openImportDialog,
} from './importGeometry.helpers'
import { stepFile, type StepFixtureSolid } from '../src/test/stepFixtures'

function projectFeatureOperations(project: Record<string, unknown>): Array<string | undefined> {
  const features = project.features as Array<{ definitionId: string }>
  const definitions = project.featureDefinitions as Record<string, { operation?: string }>
  return features.map((feature) => definitions[feature.definitionId]?.operation)
}

const LARGE_PATH_COUNT = 2980
const LARGE_PATH_SEGMENT_COUNT = 38

function largeStrokeOnlySvg(): string {
  const paths = Array.from({ length: LARGE_PATH_COUNT }, (_, index) => {
    const centerX = (index % 60) * 3 + 1.5
    const centerY = Math.floor(index / 60) * 3 + 1.5
    const points = Array.from({ length: LARGE_PATH_SEGMENT_COUNT }, (_, pointIndex) => {
      const angle = (pointIndex / LARGE_PATH_SEGMENT_COUNT) * Math.PI * 2
      return {
        x: (centerX + Math.cos(angle)).toFixed(3),
        y: (centerY + Math.sin(angle)).toFixed(3),
      }
    })
    const [start, ...rest] = points
    if (!start) return ''
    return `<path d="M ${start.x} ${start.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(' ')} Z" />`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="180mm" height="150mm" viewBox="0 0 180 150" fill="none" stroke="#000">${paths}</svg>`
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

  test('closed Lines offer Subtract only below an Add (#827)', async ({ app }) => {
    const { page } = app
    const dialog = await openImportDialog(page)
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'test.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(SVG_FILL_AND_STROKE),
    })
    await selectSourceUnitsMm(dialog)
    const summary = dialog.locator('[data-testid="import-analysis-summary"]')
    await expect(summary).toBeVisible({ timeout: 10000 })
    await dialog.locator('#import-geometry-mode').selectOption('paths')
    await expect(summary.locator('[data-testid="import-summary-closed-line"] strong')).toHaveText('2')
    await dialog.locator('.dialog-footer .btn-primary').click()
    await expect(dialog).not.toBeVisible({ timeout: 5000 })

    const rows = page.locator('.tree-row--feature')
    await expect(rows).toHaveCount(2)
    const menuItem = (label: string) =>
      page.locator('.tree-operation-menu__item').filter({ hasText: new RegExp(`^.?${label}$`) })

    // No Add anywhere: Subtract would make either Line the base solid.
    for (const index of [0, 1]) {
      await rows.nth(index).locator('.tree-action-btn--operation').click()
      await expect(menuItem('Subtract')).toBeDisabled()
      await expect(menuItem('Subtract')).toHaveAttribute('title', /first solid/)
      await page.locator('.tree-operation-overlay').click()
    }

    // An Add in the first row unlocks Subtract on the row below it.
    await rows.nth(0).locator('.tree-action-btn--operation').click()
    await menuItem('Add').click()
    await rows.nth(1).locator('.tree-action-btn--operation').click()
    await expect(menuItem('Subtract')).toBeEnabled()
    await menuItem('Subtract').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.tree-operation-menu')).not.toBeAttached()

    // The chosen role sticks: nothing was silently turned back into Add.
    const project = await getProject(page)
    expect(projectFeatureOperations(project)).toEqual(['add', 'subtract'])
  })

  test('large path import completes and leaves the app interactive', async ({ baseURL }) => {
    test.setTimeout(60_000)
    const browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))

    try {
      // Manual browser launch bypasses the config's baseURL plumbing, so
      // resolve it from the fixture — a hardcoded port breaks worktree runs.
      await page.goto(baseURL ?? 'http://localhost:1420/')
      await page.waitForSelector('canvas', { timeout: 15_000 })
      const dialog = await openImportDialog(page)

      await dialog.locator('input[type="file"]').setInputFiles({
        name: 'large-path-import.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(largeStrokeOnlySvg()),
      })
      await selectSourceUnitsMm(dialog)

      const summary = dialog.locator('[data-testid="import-analysis-summary"]')
      await expect(summary).toBeVisible({ timeout: 30_000 })
      await dialog.locator('#import-geometry-mode').selectOption('paths')
      await expect(summary.locator('[data-testid="import-summary-closed-line"] strong')).toHaveText(
        `${LARGE_PATH_COUNT}`,
        { timeout: 30_000 },
      )

      await dialog.locator('.dialog-footer .btn-primary').click()
      await expect(dialog).not.toBeVisible({ timeout: 30_000 })

      const project = await getProject(page)
      expect(project.features as Array<unknown>).toHaveLength(LARGE_PATH_COUNT)
      const followUpDialog = await openImportDialog(page)
      await expect(followUpDialog).toBeVisible()
      await followUpDialog.locator('.dialog-close').click()
      await expect(followUpDialog).not.toBeVisible({ timeout: 3000 })

      expect(errors, `browser errors: ${errors.join(' | ')}`).toHaveLength(0)
    } finally {
      await browser.close()
    }
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

// ── STEP: tessellated by Open CASCADE in the import worker (issue #784) ──

interface ImportedModelProject {
  meta: { units: 'mm' | 'inch' }
  features: Array<{ id: string, definitionId: string, folderId: string | null }>
  featureFolders: Array<{ id: string, name: string }>
  featureDefinitions: Record<string, { operation?: string, stl?: { format?: string, meshAssetId?: string } | null }>
  modelAssets?: Record<string, { sourceFormat?: string, bounds: { minX: number, maxX: number } }>
}

function stepBox(min: [number, number, number], max: [number, number, number]): StepFixtureSolid {
  return { kind: 'box', min, max }
}

test.describe('STEP import', () => {
  test('an inch part imports through the worker at its declared size', async ({ app }) => {
    test.setTimeout(90_000)
    const dialog = await openImportDialog(app.page)
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'bracket.step',
      mimeType: 'application/step',
      buffer: Buffer.from(stepFile([stepBox([0, 0, 0], [2, 1, 0.5])], { unit: 'inch' })),
    })

    // The declared unit is shown and preselected, and the tolerance is a visible input.
    const sourceUnits = dialog.locator('.import-dialog__info-row').filter({ hasText: 'Source units' }).locator('select')
    await expect(sourceUnits).toHaveValue('inch')
    await expect(dialog.locator('[data-testid="import-step-units"]')).toHaveText('Units declared in the file: in')
    await expect(dialog.locator('[data-testid="import-step-tolerance"]')).not.toHaveValue('')

    await dialog.locator('.dialog-footer .btn-primary').click()
    await expect(dialog).not.toBeVisible({ timeout: 60_000 })

    const project = await getProject(app.page) as unknown as ImportedModelProject
    expect(project.features).toHaveLength(1)
    const definition = project.featureDefinitions[project.features[0].definitionId]
    expect(definition.operation).toBe('model')
    expect(definition.stl?.format).toBe('step')
    const asset = project.modelAssets?.[definition.stl?.meshAssetId ?? '']
    expect(asset?.sourceFormat).toBe('step')
    // Two declared inches, in whatever units the project uses.
    const width = project.meta.units === 'inch' ? 2 : 50.8
    expect((asset?.bounds.maxX ?? 0) - (asset?.bounds.minX ?? 0)).toBeCloseTo(width, 3)
  })

  test('a two-solid file becomes a folder of two model features', async ({ app }) => {
    test.setTimeout(90_000)
    const dialog = await openImportDialog(app.page)
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'pair.stp',
      mimeType: 'application/step',
      buffer: Buffer.from(stepFile([stepBox([0, 0, 0], [10, 10, 5]), stepBox([20, 0, 0], [30, 10, 5])])),
    })
    await expect(dialog.locator('.import-dialog__info-row').filter({ hasText: 'Format' }).locator('strong')).toHaveText('STEP')

    await dialog.locator('.dialog-footer .btn-primary').click()
    await expect(dialog).not.toBeVisible({ timeout: 60_000 })

    const project = await getProject(app.page) as unknown as ImportedModelProject
    expect(project.features).toHaveLength(2)
    const folderIds = new Set(project.features.map((feature) => feature.folderId))
    expect(folderIds.size).toBe(1)
    expect(project.featureFolders.find((folder) => folderIds.has(folder.id))?.name).toBe('pair')
    for (const feature of project.features) {
      expect(project.featureDefinitions[feature.definitionId].stl?.format).toBe('step')
    }
  })

  test('a malformed file reports why and leaves the project unchanged', async ({ app }) => {
    test.setTimeout(90_000)
    const before = await getProject(app.page) as unknown as ImportedModelProject
    const dialog = await openImportDialog(app.page)
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'broken.step',
      mimeType: 'application/step',
      buffer: Buffer.from('this is not a STEP file'),
    })

    // Nothing is declared, so the user must choose before importing.
    await expect(dialog.locator('.import-dialog__field-note--warn')).toContainText('Units not detected')
    await selectSourceUnitsMm(dialog)
    await dialog.locator('.dialog-footer .btn-primary').click()

    await expect(dialog.locator('.cam-field-message')).toContainText('The STEP file could not be read.', { timeout: 60_000 })
    await expect(dialog).toBeVisible()
    const after = await getProject(app.page) as unknown as ImportedModelProject
    expect(after.features).toHaveLength(before.features.length)
    expect(Object.keys(after.modelAssets ?? {})).toHaveLength(Object.keys(before.modelAssets ?? {}).length)
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
