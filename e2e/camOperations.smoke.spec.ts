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

import { test, expect } from './fixtures'
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { Project } from '../src/types/project'
import {
  seedCamQuickOperationProject,
  seedCamQuickOperationProjectWithLowTab,
  seedCamQuickOperationProjectWithSmallCarveTarget,
} from './camOperations.helpers'
import {
  clickMenuItem,
  getProject,
  seedProject,
  openRowContextMenu,
  rowByName,
  selectFeatures,
} from './helpers'

interface OperationSnapshot {
  kind?: unknown
  pass?: unknown
  edgeStrategy?: unknown
  carveStrategy?: unknown
  trochoidalCutWidth?: unknown
  trochoidalAdvance?: unknown
  machiningOrder?: unknown
  entryStrategy?: unknown
  entryRampAngle?: unknown
  entryHelixDiameterPercent?: unknown
  xyLeadStrategy?: unknown
  countersinkDiameter?: unknown
  pocketPattern?: unknown
  target?: {
    source?: unknown
    featureIds?: unknown
  }
}

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control'

test.describe('CAM operation browser smoke', () => {
  test('HTML5 drag reorders CAM operations', async ({ app, ui }) => {
    await seedCamQuickOperationProjectWithSmallCarveTarget(app.page)

    const edgeMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Machinable Add'))
    await ui.contextMenu.item(edgeMenu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create outside route')
    await expect(ui.operations.rowByName(app.page, 'Edge route outside Rough')).toBeVisible()

    const carveMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(carveMenu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create V-carve (medial)')
    await expect(ui.operations.rows(app.page)).toHaveCount(2)

    await ui.operations.rowByName(app.page, 'V-carve medial')
      .dragTo(ui.operations.rowByName(app.page, 'Edge route outside Rough'))

    await expect(ui.operations.rows(app.page).nth(0)).toContainText('V-carve medial')
    await expect(ui.operations.rows(app.page).nth(1)).toContainText('Edge route outside Rough')

    const project = await getProject(app.page)
    const operations = project.operations as Array<{ name?: unknown }>
    expect(operations.map((operation) => operation.name)).toEqual([
      'V-carve medial',
      'Edge route outside Rough',
    ])
  })

  test('CAM Plan preview reviews operation-specific settings, shared tabs, atomic create and undo (#735)', async ({ app }) => {
    await seedCamQuickOperationProject(app.page)
    const seeded = await getProject(app.page)
    seeded.tools = [
      {
        id: 'plan-quarter', name: 'Plan quarter inch', units: 'inch', type: 'flat_endmill', diameter: 0.25,
        vBitAngle: null, flutes: 2, material: 'carbide', defaultRpm: 18000, defaultFeed: 40,
        defaultPlungeFeed: 12, defaultStepdown: 0.1, defaultStepover: 0.4, maxCutDepth: 5,
      },
      {
        id: 'plan-eighth', name: 'Plan eighth inch', units: 'inch', type: 'flat_endmill', diameter: 0.125,
        vBitAngle: null, flutes: 2, material: 'carbide', defaultRpm: 18000, defaultFeed: 30,
        defaultPlungeFeed: 10, defaultStepdown: 0.08, defaultStepover: 0.4, maxCutDepth: 5,
      },
      {
        id: 'plan-sixteenth', name: 'Plan sixteenth inch', units: 'inch', type: 'flat_endmill', diameter: 0.0625,
        vBitAngle: null, flutes: 2, material: 'carbide', defaultRpm: 18000, defaultFeed: 20,
        defaultPlungeFeed: 6, defaultStepdown: 0.04, defaultStepover: 0.35, maxCutDepth: 5,
      },
      {
        id: 'plan-two-inch', name: 'Plan two inch', units: 'inch', type: 'flat_endmill', diameter: 2,
        vBitAngle: null, flutes: 2, material: 'carbide', defaultRpm: 18000, defaultFeed: 90,
        defaultPlungeFeed: 20, defaultStepdown: 0.25, defaultStepover: 0.4, maxCutDepth: 5,
      },
      // The 20 in drill target is past every end mill's helical bore limit
      // (#906), so it only plans as drilling with a matching drill.
      {
        id: 'plan-drill-target', name: 'Plan drill target', units: 'inch', type: 'drill', diameter: 20,
        vBitAngle: null, flutes: 2, material: 'carbide', defaultRpm: 1000, defaultFeed: 10,
        defaultPlungeFeed: 5, defaultStepdown: 0.25, defaultStepover: 0.4, maxCutDepth: 5,
      },
    ]
    await seedProject(app.page, JSON.stringify(seeded))

    await app.page.getByRole('button', { name: 'Plan', exact: true }).click()
    const dialog = app.page.getByRole('dialog', { name: 'CAM Plan' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.cam-plan-header > div > .cam-plan-eyebrow')).toHaveCount(0)
    await expect.poll(async () => dialog.evaluate((element) => {
      const summary = element.querySelector('.cam-plan-summary')?.getBoundingClientRect()
      const body = element.querySelector('.cam-plan-body')?.getBoundingClientRect()
      return summary != null && body != null && Math.abs(summary.bottom - body.top) < 1
    })).toBe(true)
    await dialog.screenshot({ path: test.info().outputPath('cam-plan-preview.png') })

    // The initially selected drilling row owns its method; clearing controls
    // do not leak into it.
    await expect(dialog.getByText('Drill type', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Pattern', { exact: true })).toHaveCount(0)

    const pocketRough = dialog.locator('.cam-plan-row').filter({ hasText: 'Pocket · Rough' }).first()
    await pocketRough.click()
    await expect(dialog.getByText('Pattern', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Entry strategy', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Drill type', { exact: true })).toHaveCount(0)

    // A roughing correction replans only the automatic suffix: the paired
    // primary finish follows the selected cutter and its REST pass is rebuilt.
    const patternField = dialog.locator('.cam-plan-field').filter({ hasText: 'Pattern' })
    await patternField.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name: 'Offset', exact: true }).click()
    const toolField = dialog.locator('.cam-plan-field').filter({ hasText: 'Tool' }).first()
    await toolField.locator('.ui-select__trigger').click()
    await expect(app.page.getByRole('option', { name: /Plan two inch/ })).toBeVisible()
    await expect(app.page.getByRole('option', { name: /3\/8" Endmill/ })).toBeVisible()
    await expect(toolField.locator('.ui-select__dropdown')).not.toContainText('cam-plan-tool')
    await app.page.getByRole('option', { name: /Plan eighth inch/ }).click()
    const primaryPocketFinish = dialog.locator('.cam-plan-row')
      .filter({ hasText: 'Pocket · Finish' })
      .filter({ hasNot: dialog.locator('.cam-plan-tag') })
      .first()
    await expect(primaryPocketFinish).toContainText('Plan eighth inch')
    const pocketRest = dialog.locator('.cam-plan-row').filter({ hasText: 'REST' }).first()
    await expect(pocketRest).toContainText('Plan sixteenth inch')
    await pocketRest.click()
    await expect(dialog.getByText('The source operation changed. Refresh recommendations to recalculate this rest operation.', { exact: true })).toHaveCount(0)
    const restToolField = dialog.locator('.cam-plan-field').filter({ hasText: 'Tool' }).first()
    await restToolField.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name: /Plan eighth inch/ }).click()
    await expect(dialog.locator('.cam-plan-errors')).toContainText('Fix these before creating operations')
    const restError = dialog.locator('.cam-plan-errors__item')
    await expect(restError).toContainText('Your selected rest tool is no longer compatible with the corrected source operation.')
    await pocketRough.click()
    await restError.focus()
    await expect(restError).toBeFocused()
    await app.page.keyboard.press('Enter')
    const useRecommendedRestTool = dialog.getByRole('button', { name: 'Use recommended rest tool' })
    await expect(useRecommendedRestTool).toBeVisible()
    await useRecommendedRestTool.click()
    await expect(dialog.locator('.cam-plan-errors')).toHaveCount(0)
    await pocketRough.click()
    await expect(patternField.locator('.ui-select__trigger')).toContainText('Offset')

    // Exclude one recommendation, then edit the one shared tab layout rather
    // than seeing tab controls duplicated on each edge row.
    const pocketFinish = dialog.locator('.cam-plan-row').filter({ hasText: 'Pocket · Finish' }).first()
    await pocketFinish.locator('input[type="checkbox"]').uncheck()
    await dialog.locator('.cam-plan-row--shared').first().click()
    await expect(dialog.getByRole('paragraph').filter({ hasText: /Shared by \d+ operations/ })).toBeVisible()
    await expect(dialog.getByText('Width', { exact: true })).toHaveCount(1)
    const sharedTabsToggle = dialog.locator('.cam-plan-detail .cam-plan-check--card input[type="checkbox"]')
    await sharedTabsToggle.uncheck()
    await expect(dialog.getByText('Tabs are disabled for this separating edge cut. Confirm another workholding method before machining.', { exact: true })).toBeVisible()
    await sharedTabsToggle.check()
    const widthInput = dialog.locator('.cam-plan-field').filter({ hasText: 'Width' }).locator('input')
    await widthInput.fill('0.4')
    await widthInput.blur()

    // The imported model has no retained mesh asset in this quick fixture, so
    // creation stays gated until the user explicitly acknowledges that visible
    // unresolved coverage.
    const acknowledge = dialog.getByRole('checkbox', { name: /I understand these features will not be covered/ })
    await expect(acknowledge).toBeVisible()
    await acknowledge.check()
    const create = dialog.getByRole('button', { name: /Create \d+ operations/ })
    await expect(create).toBeEnabled()
    await create.click()
    await expect(dialog).toHaveCount(0)

    const created = await getProject(app.page)
    expect((created.operations as unknown[]).length).toBeGreaterThan(1)
    expect((created.tabs as unknown[]).length).toBeGreaterThan(0)

    await app.page.keyboard.press(`${modKey}+z`)
    const restored = await getProject(app.page)
    expect(restored.operations).toEqual([])
    expect(restored.tabs).toEqual([])
    expect(restored.tools).toEqual(seeded.tools)
  })

  test('CAM Plan recommends transformed imported-model rough and finish stages (#765)', async ({ app }) => {
    const project = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8'))
    project.operations = []
    project.tools.push(
      {
        id: 'plan-ball-finish', name: 'Plan ball finish', units: 'inch', type: 'ball_endmill', diameter: 0.0625,
        vBitAngle: null, flutes: 2, material: 'carbide', defaultRpm: 18000, defaultFeed: 30,
        defaultPlungeFeed: 10, defaultStepdown: 0.08, defaultStepover: 0.4, maxCutDepth: 1,
      },
      {
        id: 'plan-oversized', name: 'Plan oversized endmill', units: 'inch', type: 'flat_endmill', diameter: 1,
        vBitAngle: null, flutes: 2, material: 'carbide', defaultRpm: 18000, defaultFeed: 30,
        defaultPlungeFeed: 10, defaultStepdown: 0.08, defaultStepover: 0.4, maxCutDepth: 1,
      },
    )
    await seedProject(app.page, JSON.stringify(project))

    await app.page.getByRole('button', { name: 'Plan', exact: true }).click()
    const dialog = app.page.getByRole('dialog', { name: 'CAM Plan' })
    const rough = dialog.locator('.cam-plan-row').filter({ hasText: '3D surface rough · Rough' }).first()
    const finish = dialog.locator('.cam-plan-row').filter({ hasText: '3D surface finish · Finish' }).first()
    await expect(rough).toContainText(project.tools[0].name)
    await expect(finish).toContainText('Plan ball finish')

    await rough.click()
    await expect(dialog.getByText('Stock to leave radial', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Stock to leave axial', { exact: true })).toBeVisible()
    const roughToolField = dialog.locator('.cam-plan-field').filter({ hasText: 'Tool' }).first()
    await roughToolField.locator('.ui-select__trigger').click()
    const oversized = app.page.getByRole('option', { name: /Plan oversized endmill/ })
    await expect(oversized).toHaveAttribute('aria-disabled', 'true')
    await expect(oversized).toContainText('maximum cutter diameter')
    const shallowBall = app.page.getByRole('option', { name: /1\/8" Ball Endmill/ })
    await expect(shallowBall).toHaveAttribute('aria-disabled', 'true')
    await expect(shallowBall.locator('.ui-select__option-detail')).toHaveText('needs 0.75 in cutting depth; this tool provides 0.5 in')
    await expect(shallowBall).toHaveCSS('white-space', 'normal')
    await expect(roughToolField.locator('.ui-select')).toHaveClass(/ui-select--detailed/)
    await app.page.getByRole('option', { name: /Plan ball finish/ }).click()

    await rough.focus()
    await app.page.keyboard.press('ArrowDown')
    await expect(finish).toBeFocused()
    await app.page.keyboard.press('Enter')
    await expect(dialog.getByText('Pattern', { exact: true })).toBeVisible()
    await expect(dialog.getByText(/^Scallop height/)).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: 'Filter by surface slope', exact: true })).toBeVisible()
  })

  test('CAM Plan keeps an imported model with no compatible tool as a visible blocking row (#765)', async ({ app }) => {
    const project = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8'))
    project.operations = []
    project.tools = []
    const modelFeature = project.features.find((feature: { kind?: string; operation?: string }) =>
      feature.kind === 'stl' && feature.operation === 'model',
    ) as { stl: { scale: number } }
    modelFeature.stl.scale = 0.005
    await seedProject(app.page, JSON.stringify(project))

    await app.page.getByRole('button', { name: 'Plan', exact: true }).click()
    const dialog = app.page.getByRole('dialog', { name: 'CAM Plan' })
    const rough = dialog.locator('.cam-plan-row').filter({ hasText: '3D surface rough · Rough' }).first()
    await expect(rough).toBeVisible()
    await expect(rough.locator('.cam-plan-row__warning')).toBeVisible()
    await expect(dialog.locator('.cam-plan-errors')).toContainText('No compatible surface tool satisfies this model')
    await expect(dialog.getByRole('button', { name: /Create \d+ operations/ })).toBeDisabled()
  })

  test('CAM Plan preview treats resolver-accounted islands as retained material, not uncovered work (#735)', async ({ app }) => {
    await seedCamQuickOperationProject(app.page)
    const seeded = await getProject(app.page)
    delete seeded.featureDefinitions['def-imported-model']
    seeded.features = seeded.features.filter((feature) => feature.id !== 'f-imported-model')
    seeded.featureDefinitions['def-retained-island'] = {
      id: 'def-retained-island',
      kind: 'circle',
      profile: {
        start: { x: 2, y: 0 },
        segments: [{ type: 'circle', center: { x: 0, y: 0 }, to: { x: 2, y: 0 }, clockwise: true }],
        closed: true,
      },
      dimensions: [],
      text: null,
      stl: null,
      operation: 'add',
    }
    seeded.features.push({
      id: 'f-retained-island',
      name: 'Retained Island',
      definitionId: 'def-retained-island',
      transform: { a: 1, b: 0, c: 0, d: 1, e: 120, f: 34 },
      constraints: [],
      folderId: null,
      z_top: 2,
      z_bottom: 1.5,
      visible: true,
      locked: false,
    })
    seeded.tools = [
      {
        id: 'plan-quarter', name: 'Plan quarter inch', units: 'inch', type: 'flat_endmill', diameter: 0.25,
        vBitAngle: null, flutes: 2, material: 'carbide', defaultRpm: 18000, defaultFeed: 40,
        defaultPlungeFeed: 12, defaultStepdown: 0.1, defaultStepover: 0.4, maxCutDepth: 5,
      },
      {
        id: 'plan-eighth', name: 'Plan eighth inch', units: 'inch', type: 'flat_endmill', diameter: 0.125,
        vBitAngle: null, flutes: 2, material: 'carbide', defaultRpm: 18000, defaultFeed: 30,
        defaultPlungeFeed: 10, defaultStepdown: 0.08, defaultStepover: 0.4, maxCutDepth: 5,
      },
    ]
    await seedProject(app.page, JSON.stringify(seeded))

    await app.page.getByRole('button', { name: 'Plan', exact: true }).click()
    const dialog = app.page.getByRole('dialog', { name: 'CAM Plan' })
    await expect(dialog.getByText('Retained Island', { exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('checkbox', { name: /I understand these features will not be covered/ })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: /Create \d+ operations/ })).toBeEnabled()
  })

  test('feature-row quick operation creates a CAM operation', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    const row = rowByName(app.page, 'Machinable Add')
    const menu = await openRowContextMenu(app.page, row)
    await ui.contextMenu.item(menu, 'Create operation').hover()

    const submenu = ui.contextMenu.submenu(app.page)
    await expect(submenu).toBeVisible()
    await expect(ui.contextMenu.item(submenu, 'Create outside route')).toBeVisible()

    await clickMenuItem(submenu, 'Create outside route')

    await expect(ui.operations.countBadge(app.page)).toHaveText('1')
    const operationRow = ui.operations.rowByName(app.page, 'Edge route outside Rough')
    await expect(operationRow).toBeVisible()
    await expect(app.page.getByText('Stepdown', { exact: true })).toBeVisible()
    await expect(app.page.getByText('Stepover ratio', { exact: true })).not.toBeVisible()
    const contourProject = await getProject(app.page)
    const contourOperations = contourProject.operations as OperationSnapshot[]
    expect(contourOperations[0]?.pass).toBe('rough')
    expect(contourOperations[0]?.kind).toBe('edge_route_outside')

    // Cut strategy and the trochoidal settings it reveals live in Strategy.
    await ui.cam.operationGroup(app.page, 'Strategy').click()
    const strategyField = ui.cam.operationField(app.page, 'Strategy')
    await expect(strategyField.locator('.ui-select__label')).toHaveText('Contour')
    await strategyField.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name: 'Trochoidal', exact: true }).click()

    await expect(app.page.getByText('Trochoidal cut width', { exact: true })).toBeVisible()
    await expect(app.page.getByText('Advance per loop (% of tool diameter)', { exact: true })).toBeVisible()
    await expect(app.page.getByText('Advance per loop (distance)', { exact: true })).toBeVisible()
    await expect(app.page.getByRole('button', { name: 'Create rest operation', exact: true })).toBeDisabled()
    await expect(app.page.getByText('Rest machining is unavailable for trochoidal edge routing.', { exact: true })).toBeVisible()

    // Trochoidal honours both machining orders, so the control stays available.
    await expect(app.page.getByText('Machining order', { exact: true })).toBeVisible()
    await ui.cam.operationGroup(app.page, 'Entry & retract').click()
    const entryField = ui.cam.operationField(app.page, 'Entry strategy')
    await expect(entryField.locator('.ui-select__label')).toHaveText('Helix')
    await entryField.locator('.ui-select__trigger').click()
    await expect(app.page.getByRole('option', { name: 'Ramp', exact: true })).toHaveCount(0)
    await app.page.keyboard.press('Escape')

    const project = await getProject(app.page)
    const operations = project.operations as OperationSnapshot[]
    expect(operations).toHaveLength(1)
    expect(operations[0].kind).toBe('edge_route_outside')
    expect(operations[0].pass).toBe('rough')
    expect(operations[0].edgeStrategy).toBe('trochoidal')
    // Selecting the strategy must NOT pin the tool-derived settings. They stay
    // undefined so the displayed 1.5 x D width and 10% advance keep following
    // whichever tool the operation is assigned; only an explicit edit stores a
    // value. The panel above already asserted both fields render.
    expect(operations[0].trochoidalCutWidth).toBeUndefined()
    expect(operations[0].trochoidalAdvance).toBeUndefined()
    expect(operations[0].entryStrategy).toBe('helix')
    // Selecting Trochoidal must not rewrite machiningOrder. Generation is
    // level-first for trochoidal regardless (the engine skips the feature-first
    // block reordering) and the control is hidden above, so forcing the stored
    // value would only discard the user's choice for when they switch back.
    expect(operations[0].machiningOrder).toBe(contourOperations[0]?.machiningOrder)
    expect(operations[0].target?.source).toBe('features')
    expect(operations[0].target?.featureIds).toEqual(['f-machinable-add'])
  })

  test('a contour edge route offers the Z entry strategy and its settings (#708)', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    const menu = await openRowContextMenu(app.page, rowByName(app.page, 'Machinable Add'))
    await ui.contextMenu.item(menu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create outside route')
    await expect(ui.operations.rows(app.page)).toHaveCount(1)

    await ui.cam.operationGroup(app.page, 'Entry & retract').click()
    const entryField = ui.cam.operationField(app.page, 'Entry strategy')
    await expect(entryField).toHaveCount(1)

    // A rough edge route is created with 'helix' already stored — the value was
    // seeded for trochoidal roughing long before #708 and simply had no row to
    // show it and no generator reading it. Now it has both.
    await expect(entryField.locator('.ui-select__label')).toHaveText('Helix')
    let project = await getProject(app.page)
    let operations = project.operations as OperationSnapshot[]
    expect(operations[0].kind).toBe('edge_route_outside')
    expect(operations[0].pass).toBe('rough')
    expect(operations[0].entryStrategy).toBe('helix')

    const rampAngleField = ui.cam.operationField(app.page, 'Ramp angle (°)')
    const helixDiameterField = ui.cam.operationField(app.page, 'Helix diameter (%)')
    await expect(rampAngleField.locator('input')).toHaveValue('5')
    await expect(helixDiameterField.locator('input')).toHaveValue('80')

    // Unlike trochoidal roughing, a contour route offers Ramp as well.
    await entryField.locator('.ui-select__trigger').click()
    const options = entryField.locator('.ui-select__dropdown [role="option"]')
    await expect(options).toHaveText(['Plunge', 'Helix', 'Ramp'])
    await options.filter({ hasText: 'Ramp' }).click()
    await expect(entryField.locator('.ui-select__label')).toHaveText('Ramp')
    // A ramp has a run, not a bore, so the helix diameter goes away with it.
    await expect(rampAngleField).toHaveCount(1)
    await expect(app.page.getByText('Helix diameter (%)', { exact: true })).toHaveCount(0)
    await rampAngleField.locator('input').fill('7')
    await rampAngleField.locator('input').blur()

    project = await getProject(app.page)
    operations = project.operations as OperationSnapshot[]
    expect(operations[0].entryStrategy).toBe('ramp')
    expect(operations[0].entryRampAngle).toBe(7)

    // Plunge is the legacy descent and keeps both settings hidden.
    await entryField.locator('.ui-select__trigger').click()
    await entryField.locator('.ui-select__dropdown [role="option"]').filter({ hasText: 'Plunge' }).click()
    await expect(entryField.locator('.ui-select__label')).toHaveText('Plunge')
    await expect(app.page.getByText('Ramp angle (°)', { exact: true })).toHaveCount(0)
    await expect(app.page.getByText('Helix diameter (%)', { exact: true })).toHaveCount(0)

    project = await getProject(app.page)
    operations = project.operations as OperationSnapshot[]
    expect(operations[0].entryStrategy).toBe('plunge')

    // The XY approach composes with the Z entry rather than hiding behind it,
    // and is the half of #695 that #708 unlocks on an edge route.
    await expect(ui.cam.operationField(app.page, 'XY approach & exit')).toHaveCount(1)
  })

  test('Engrave strategy dropdown switches between Direct and Trochoidal', async ({ app, ui }) => {
    await seedCamQuickOperationProjectWithSmallCarveTarget(app.page)

    const row = rowByName(app.page, 'Carve Target')
    const menu = await openRowContextMenu(app.page, row)
    await ui.contextMenu.item(menu, 'Create operation').hover()

    const submenu = ui.contextMenu.submenu(app.page)
    await expect(submenu).toBeVisible()
    await expect(ui.contextMenu.item(submenu, 'Create engraving')).toBeVisible()

    await clickMenuItem(submenu, 'Create engraving')

    await expect(ui.operations.countBadge(app.page)).toHaveText('1')
    const operationRow = ui.operations.rowByName(app.page, 'Engrave')
    await expect(operationRow).toBeVisible()

    // Strategy field defaults to Direct.
    await ui.cam.operationGroup(app.page, 'Strategy').click()
    const strategyField = ui.cam.operationField(app.page, 'Strategy')
    await expect(strategyField.locator('.ui-select__label')).toHaveText('Direct')

    // Trochoidal fields not visible for Direct.
    await expect(app.page.getByText('Trochoidal cut width', { exact: true })).toHaveCount(0)
    await expect(app.page.getByText('Advance per loop (% of tool diameter)', { exact: true })).toHaveCount(0)
    await expect(app.page.getByText('Channel width', { exact: true })).toHaveCount(0)

    // Switch to Trochoidal.
    await strategyField.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name: 'Trochoidal (slot)', exact: true }).click()

    // Trochoidal fields become visible.
    await expect(app.page.getByText('Trochoidal cut width', { exact: true })).toBeVisible()
    await expect(app.page.getByText('Advance per loop (% of tool diameter)', { exact: true })).toBeVisible()
    await expect(app.page.getByText('Advance per loop (distance)', { exact: true })).toBeVisible()
    await expect(app.page.getByText('Channel width', { exact: true })).toBeVisible()
    // The channel-width note mentions the width.
    await expect(app.page.getByText(/Trochoidal cuts a /)).toBeVisible()

    // Cut direction belongs to the strategy, which is already open; entry has
    // its own group. Ramp stays excluded either way.
    await expect(app.page.getByText('Cut direction', { exact: true })).toBeVisible()
    await ui.cam.operationGroup(app.page, 'Entry & retract').click()
    const entryField = ui.cam.operationField(app.page, 'Entry strategy')
    await expect(entryField.locator('.ui-select__label')).toHaveText('Helix')
    await entryField.locator('.ui-select__trigger').click()
    await expect(app.page.getByRole('option', { name: 'Ramp', exact: true })).toHaveCount(0)
    await app.page.keyboard.press('Escape')

    let project = await getProject(app.page)
    let operations = project.operations as OperationSnapshot[]
    expect(operations).toHaveLength(1)
    expect(operations[0].kind).toBe('follow_line')
    expect(operations[0].carveStrategy).toBe('trochoidal')
    // Selecting the strategy must NOT pin the tool-derived settings.
    expect(operations[0].trochoidalCutWidth).toBeUndefined()
    expect(operations[0].trochoidalAdvance).toBeUndefined()
    // entryStrategy is not stored until the user edits it; the UI shows Helix.

    // Switch back to Direct.
    await strategyField.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name: 'Direct', exact: true }).click()

    // Trochoidal fields hide again.
    await expect(app.page.getByText('Trochoidal cut width', { exact: true })).toHaveCount(0)
    await expect(app.page.getByText('Channel width', { exact: true })).toHaveCount(0)
    // Cut Direction is hidden for direct Engrave.
    await expect(app.page.getByText('Cut direction', { exact: true })).toHaveCount(0)

    project = await getProject(app.page)
    operations = project.operations as OperationSnapshot[]
    expect(operations[0].carveStrategy).toBe('direct')
  })

  test('quick-op submenu splits 2D and 3D operations for an imported model', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    const menu = await openRowContextMenu(app.page, rowByName(app.page, 'Imported Model'))
    await ui.contextMenu.item(menu, 'Create operation').hover()

    const submenu = ui.contextMenu.submenu(app.page)
    await expect(submenu).toBeVisible()
    await expect(ui.contextMenu.groupLabels(submenu)).toHaveText(['2D operations', '3D operations'])

    // The 3D entries carry the CAM panel's own names, and all follow the 2D ones.
    await expect(ui.contextMenu.item(submenu, 'Create 3D surface rough')).toBeVisible()
    await expect(ui.contextMenu.item(submenu, 'Create 3D surface finish')).toBeVisible()
    await expect(ui.contextMenu.item(submenu, 'Create 3D surface cleanup')).toBeVisible()

    await clickMenuItem(submenu, 'Create 3D surface rough')

    // Creation is async (it may load the bundled tool library first), so wait
    // for the operation to land in the UI before reading project state.
    await expect(ui.operations.countBadge(app.page)).toHaveText('1')

    await ui.cam.operationGroup(app.page, 'Entry & retract').click()

    const strategyField = app.page.getByText('Entry strategy', { exact: true }).locator('..')
    await expect(strategyField.locator('.ui-select__label')).toHaveText('Plunge')
    await expect(app.page.getByText('Ramp angle (°)', { exact: true })).toHaveCount(0)
    await expect(app.page.getByText('Helix diameter (%)', { exact: true })).toHaveCount(0)

    await strategyField.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name: 'Helix', exact: true }).click()

    const rampAngleField = app.page.getByText('Ramp angle (°)', { exact: true }).locator('..')
    const helixDiameterField = app.page.getByText('Helix diameter (%)', { exact: true }).locator('..')
    await expect(rampAngleField.locator('input')).toHaveValue('5')
    await expect(helixDiameterField.locator('input')).toHaveValue('80')
    await rampAngleField.locator('input').fill('8')
    await rampAngleField.locator('input').blur()
    await helixDiameterField.locator('input').fill('65')
    await helixDiameterField.locator('input').blur()

    const project = await getProject(app.page)
    const operations = project.operations as OperationSnapshot[]
    expect(operations).toHaveLength(1)
    expect(operations[0].kind).toBe('rough_surface')
    expect(operations[0].entryStrategy).toBe('helix')
    expect(operations[0].entryRampAngle).toBe(8)
    expect(operations[0].entryHelixDiameterPercent).toBe(65)
    expect(operations[0].target?.featureIds).toEqual(['f-imported-model'])
  })

  test('quick-op submenu stays flat for a feature with 2D operations only', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    const menu = await openRowContextMenu(app.page, rowByName(app.page, 'Machinable Add'))
    await ui.contextMenu.item(menu, 'Create operation').hover()

    const submenu = ui.contextMenu.submenu(app.page)
    await expect(submenu).toBeVisible()
    await expect(ui.contextMenu.item(submenu, 'Create outside route')).toBeVisible()
    await expect(ui.contextMenu.groupLabels(submenu)).toHaveCount(0)
  })

  test('quick operation creates a V-Carve medial with an auto-picked V-bit', async ({ app, ui }) => {
    await seedCamQuickOperationProjectWithSmallCarveTarget(app.page)

    const row = rowByName(app.page, 'Carve Target')
    const menu = await openRowContextMenu(app.page, row)
    await ui.contextMenu.item(menu, 'Create operation').hover()

    const submenu = ui.contextMenu.submenu(app.page)
    await expect(submenu).toBeVisible()
    await clickMenuItem(submenu, 'Create V-carve (medial)')

    await expect(ui.operations.countBadge(app.page)).toHaveText('1')
    const operationRow = ui.operations.rowByName(app.page, 'V-carve medial')
    await expect(operationRow).toBeVisible()
    await expect(app.page.getByText('Max carve depth', { exact: true })).toBeVisible()
    await expect(app.page.getByText('Step Size', { exact: true })).toHaveCount(0)

    const project = await getProject(app.page)
    const operations = project.operations as Array<OperationSnapshot & { toolRef?: unknown }>
    expect(operations).toHaveLength(1)
    expect(operations[0].kind).toBe('v_carve_medial')
    expect(operations[0].target?.source).toBe('features')
    expect(operations[0].target?.featureIds).toEqual(['f-carve-target'])
    // The bundled library must have supplied a V-bit automatically.
    expect(operations[0].toolRef).toBeTruthy()
    const tools = project.tools as Array<{ id?: unknown; type?: unknown }>
    expect(tools.some((tool) => tool.id === operations[0].toolRef && tool.type === 'v_bit')).toBe(true)
  })

  test('helical drilling: select Helical, assert ramp angle visible, Helix Diameter absent, change and persist', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    // Create a drilling operation on the circle feature
    const menu = await openRowContextMenu(app.page, rowByName(app.page, 'Drill Target'))
    await ui.contextMenu.item(menu, 'Create operation').hover()
    const submenu = ui.contextMenu.submenu(app.page)
    await expect(submenu).toBeVisible()
    await clickMenuItem(submenu, 'Create drilling')

    // Wait for the operation row to appear
    await expect(ui.operations.countBadge(app.page)).toHaveText('1')
    await expect(ui.operations.rowByName(app.page, 'Drill')).toBeVisible()

    // Drilling opens its own group, so the drill type is already visible. Open
    // the entry group too: the ramp angle lives there, and without it the
    // "absent" assertions below would pass merely because it is collapsed.
    await ui.cam.operationGroup(app.page, 'Entry & retract').click()

    // The Drill Type selector should show the default (Simple (G81))
    const drillTypeField = app.page.getByText('Drill type', { exact: true }).locator('..')
    await expect(drillTypeField.locator('.ui-select__label')).toHaveText('Simple (G81)')

    // Ramp Angle and Helix Diameter should NOT be visible yet (default is Simple)
    await expect(app.page.getByText('Ramp angle (°)', { exact: true })).toHaveCount(0)
    await expect(app.page.getByText('Helix diameter (%)', { exact: true })).toHaveCount(0)

    // Select Helical from the drill type dropdown
    await drillTypeField.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name: 'Helical', exact: true }).click()

    // Wait for the selector label to update
    await expect(drillTypeField.locator('.ui-select__label')).toHaveText('Helical')

    // Ramp Angle should now be visible with default value
    const rampAngleField = app.page.getByText('Ramp angle (°)', { exact: true }).locator('..')
    await expect(rampAngleField.locator('input')).toHaveValue('5')

    // Helix Diameter must remain absent — the selected circle defines the bore
    // diameter, not the shared #412 entry-helix-diameter setting
    await expect(app.page.getByText('Helix diameter (%)', { exact: true })).toHaveCount(0)

    // Change the ramp angle
    await rampAngleField.locator('input').fill('8')
    await rampAngleField.locator('input').blur()

    // Verify persisted operation state
    const project = await getProject(app.page)
    const operations = project.operations as OperationSnapshot[]
    expect(operations).toHaveLength(1)
    expect(operations[0].kind).toBe('drilling')
    expect((operations[0] as Record<string, unknown>).drillType).toBe('helical')
    expect(operations[0].entryRampAngle).toBe(8)
  })

  test('countersink drilling: select Countersink, edit the diameter, see the V-bit requirement', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    const menu = await openRowContextMenu(app.page, rowByName(app.page, 'Drill Target'))
    await ui.contextMenu.item(menu, 'Create operation').hover()
    const submenu = ui.contextMenu.submenu(app.page)
    await expect(submenu).toBeVisible()
    await clickMenuItem(submenu, 'Create drilling')

    await expect(ui.operations.countBadge(app.page)).toHaveText('1')
    await expect(ui.operations.rowByName(app.page, 'Drill')).toBeVisible()

    // Precondition for the hint asserted below: a Drilling operation is fitted a
    // drill or (since the bundled library ships no drills) an endmill — never a
    // V-bit, because the mode is chosen after the tool. The operator assigns the
    // V-bit themselves, and until they do the panel has to say so.
    const seeded = await getProject(app.page)
    const seededOps = seeded.operations as Array<OperationSnapshot & { toolRef?: unknown }>
    const seededTools = seeded.tools as Array<{ id?: unknown; type?: unknown }>
    const fittedTool = seededTools.find((tool) => tool.id === seededOps[0].toolRef)
    expect(fittedTool).toBeDefined()
    expect(fittedTool?.type).not.toBe('v_bit')

    // Same reason as the helical test: the ramp angle asserted absent below
    // lives in the entry group, so open it rather than assert against a
    // collapsed section.
    await ui.cam.operationGroup(app.page, 'Entry & retract').click()

    const drillTypeField = app.page.getByText('Drill type', { exact: true }).locator('..')
    await drillTypeField.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name: 'Countersink', exact: true }).click()
    await expect(drillTypeField.locator('.ui-select__label')).toHaveText('Countersink')

    // Countersink owns the diameter field; the other modes' fields stay hidden.
    const diameterField = app.page.getByText('Countersink diameter', { exact: true }).locator('..')
    await expect(diameterField).toBeVisible()
    await expect(app.page.getByText('Peck depth', { exact: true })).toHaveCount(0)
    await expect(app.page.getByText('Dwell time (s)', { exact: true })).toHaveCount(0)
    await expect(app.page.getByText('Ramp angle (°)', { exact: true })).toHaveCount(0)

    // Depth is derived, so with a drill fitted there is nothing to derive from —
    // the panel says so at the field rather than only in the warnings list.
    await expect(app.page.getByText('Countersink depth', { exact: true }).locator('..')).toContainText('—')
    await expect(
      app.page.getByText('Countersinking needs a V-bit. Assign one to this operation.', { exact: true }),
    ).toBeVisible()

    await diameterField.locator('input').fill('0.25')
    await diameterField.locator('input').blur()

    const project = await getProject(app.page)
    const operations = project.operations as OperationSnapshot[]
    expect(operations).toHaveLength(1)
    expect(operations[0].kind).toBe('drilling')
    expect((operations[0] as Record<string, unknown>).drillType).toBe('countersink')
    expect(operations[0].countersinkDiameter).toBe(0.25)
  })
  test('context menu adds and removes features from existing operations', async ({ app, ui }) => {
    await seedCamQuickOperationProjectWithSmallCarveTarget(app.page)

    // With no operations at all, both entries render disabled.
    const emptyMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Machinable Add'))
    await expect(ui.contextMenu.item(emptyMenu, 'Add to operation')).toBeDisabled()
    await expect(ui.contextMenu.item(emptyMenu, 'Remove from operation')).toBeDisabled()
    await app.page.keyboard.press('Escape')

    // Create a pocket from the subtract rect.
    const carveMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(carveMenu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create pocket')
    await expect(ui.operations.rows(app.page)).toHaveCount(1)

    // The subtract circle is a compatible pocket target: it must appear under
    // "Add to operation" and clicking it merges it into the target.
    const drillMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Drill Target'))
    await ui.contextMenu.item(drillMenu, 'Add to operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Pocket Rough')

    let project = await getProject(app.page)
    let operations = project.operations as OperationSnapshot[]
    expect(operations[0].target?.featureIds).toEqual(['f-carve-target', 'f-drill-target'])

    // The merged feature is now listed under "Remove from operation".
    const drillMenu2 = await openRowContextMenu(app.page, rowByName(app.page, 'Drill Target'))
    await ui.contextMenu.item(drillMenu2, 'Remove from operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Pocket Rough')

    project = await getProject(app.page)
    operations = project.operations as OperationSnapshot[]
    expect(operations[0].target?.featureIds).toEqual(['f-carve-target'])

    // Dropping the pocket's only remaining machining feature would invalidate
    // the operation, so that remove entry renders disabled.
    const carveMenu2 = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(carveMenu2, 'Remove from operation').hover()
    await expect(ui.contextMenu.item(ui.contextMenu.submenu(app.page), 'Pocket Rough')).toBeDisabled()

    // An incompatible feature (add rect vs. pocket) sees no add candidates.
    const addMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Machinable Add'))
    await expect(ui.contextMenu.item(addMenu, 'Add to operation')).toBeDisabled()
  })
  test('the seeded circle pocket pattern is selectable and reaches the project (#554)', async ({ app, ui }) => {
    // Picking the pattern regenerates the toolpath on the main thread; the
    // full-size target makes that ~42 s and times the test out (#908).
    await seedCamQuickOperationProjectWithSmallCarveTarget(app.page)

    const carveMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(carveMenu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create pocket')
    await expect(ui.operations.rows(app.page)).toHaveCount(1)

    await ui.cam.operationGroup(app.page, 'Strategy').click()
    const pattern = ui.cam.operationField(app.page, 'Pattern')
    await expect(pattern).toHaveCount(1)

    // A new pocket starts on the shipped default, so picking the seeded
    // pattern below is a real change rather than a no-op that would pass
    // whatever the dropdown happened to contain.
    await expect(pattern.locator('.ui-select__label')).toHaveText('Offset')

    await pattern.locator('.ui-select__trigger').click()
    const options = pattern.locator('.ui-select__dropdown [role="option"]')
    await expect(options).toHaveText(['Offset', 'Seeded circles', 'Parallel', 'Trochoidal'])
    await options.filter({ hasText: 'Seeded circles' }).click()

    await expect(pattern.locator('.ui-select__label')).toHaveText('Seeded circles')

    const project = await getProject(app.page)
    const operations = project.operations as OperationSnapshot[]
    expect(operations[0].pocketPattern).toBe('seeded_offset')
  })
  test('the XY approach & exit selector is offered, persists, and follows the pattern (#695)', async ({ app, ui }) => {
    await seedCamQuickOperationProjectWithSmallCarveTarget(app.page)

    const carveMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(carveMenu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create pocket')
    await expect(ui.operations.rows(app.page)).toHaveCount(1)

    await ui.cam.operationGroup(app.page, 'Entry & retract').click()
    const leadField = ui.cam.operationField(app.page, 'XY approach & exit')
    await expect(leadField).toHaveCount(1)

    // Direct is the shipped default and must stay unstored until the user
    // picks something else: a saved pocket that never saw this control has to
    // keep cutting exactly as it did.
    await expect(leadField.locator('.ui-select__label')).toHaveText('Direct')
    let project = await getProject(app.page)
    let operations = project.operations as OperationSnapshot[]
    expect(operations[0].xyLeadStrategy).toBeUndefined()

    // It is independent of the Z entry: switching that must not hide it.
    const entryField = ui.cam.operationField(app.page, 'Entry strategy')
    await entryField.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name: 'Helix', exact: true }).click()
    await expect(entryField.locator('.ui-select__label')).toHaveText('Helix')
    await expect(leadField).toHaveCount(1)

    await leadField.locator('.ui-select__trigger').click()
    const options = leadField.locator('.ui-select__dropdown [role="option"]')
    await expect(options).toHaveText(['Direct', 'Tangent arc'])
    await options.filter({ hasText: 'Tangent arc' }).click()
    await expect(leadField.locator('.ui-select__label')).toHaveText('Tangent arc')

    project = await getProject(app.page)
    operations = project.operations as OperationSnapshot[]
    expect(operations[0].xyLeadStrategy).toBe('arc')

    // Radial stock on a ROUGHING pass means a finish pass comes back and
    // machines the mark away, so the generator emits no lead — and the row goes
    // with it rather than offering a setting that cannot change the program
    // (#708). The stored choice survives, so it is still there when the stock
    // goes back to zero.
    const stockField = ui.cam.operationField(app.page, 'Stock to leave radial')
    await stockField.locator('input').fill('0.5')
    await stockField.locator('input').blur()
    await expect(app.page.getByText('XY approach & exit', { exact: true })).toHaveCount(0)

    project = await getProject(app.page)
    operations = project.operations as OperationSnapshot[]
    expect(operations[0].xyLeadStrategy).toBe('arc')

    await stockField.locator('input').fill('0')
    await stockField.locator('input').blur()
    await expect(ui.cam.operationField(app.page, 'XY approach & exit')).toHaveCount(1)
    await expect(
      ui.cam.operationField(app.page, 'XY approach & exit').locator('.ui-select__label'),
    ).toHaveText('Tangent arc')

    // A raster pattern has no clearing ring to lead onto, so the row goes away
    // rather than offering a setting the generator would decline.
    await ui.cam.operationGroup(app.page, 'Strategy').click()
    const pattern = ui.cam.operationField(app.page, 'Pattern')
    await pattern.locator('.ui-select__trigger').click()
    await pattern.locator('.ui-select__dropdown [role="option"]').filter({ hasText: 'Parallel' }).click()
    await expect(pattern.locator('.ui-select__label')).toHaveText('Parallel')
    await expect(app.page.getByText('XY approach & exit', { exact: true })).toHaveCount(0)
  })
  test('actions, diagnostics and the dev toggle are not property rows (#559)', async ({ app, ui }) => {
    await seedCamQuickOperationProjectWithSmallCarveTarget(app.page)

    const carveMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(carveMenu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create pocket')
    await expect(ui.operations.rows(app.page)).toHaveCount(1)

    // Open every group, so "absent" below means absent rather than collapsed.
    for (const group of ['Strategy', 'Entry & retract', 'Corners', 'Output']) {
      await ui.cam.operationGroup(app.page, group).click()
    }

    // Positive controls, so the "absent" assertions below cannot pass merely
    // because a locator stopped matching anything at all.
    await expect(ui.cam.operationField(app.page, 'Target')).toHaveCount(1)
    await expect(
      app.page.locator('.cam-operation-properties .properties-group')
        .getByText('Stepdown', { exact: true }),
    ).toHaveCount(1)

    // The booklet export is an action: it lives in the panel's action row, not
    // in the same vertical run as "Stepdown = 2 mm".
    await expect(ui.cam.operationField(app.page, 'Booklet')).toHaveCount(0)
    await expect(app.page.getByRole('button', { name: 'Export booklet (PDF) for Pocket Rough' })).toBeEnabled()

    // Toolpath warnings are a diagnostic, reported in the status strip above
    // the groups rather than as a property row.
    await expect(ui.cam.operationField(app.page, 'Toolpath warnings')).toHaveCount(0)

    // The debug toggle still exists in a dev build — the e2e server is one —
    // but outside the groups, so it is no longer a property.
    const devToggle = app.page.locator('.cam-operation-properties .cam-operation-dev-toggle')
    await expect(devToggle).toContainText('Debug toolpath')
    await expect(
      app.page.locator('.cam-operation-properties .properties-group')
        .getByText('Debug toolpath', { exact: true }),
    ).toHaveCount(0)
  })

  test('booklet export shows it is busy and which stage is running (#924)', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    const carveMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(carveMenu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create pocket')
    await expect(ui.operations.rows(app.page)).toHaveCount(1)

    // Hold the save dialog open, so the export parks in its last stage and the
    // busy state can be observed without racing the earlier ones.
    await app.page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      let release: () => void = () => {}
      w.__releaseBookletSave = () => release()
      w.showSaveFilePicker = () => new Promise((resolve) => {
        release = () => resolve({
          name: 'booklet.pdf',
          createWritable: async () => ({ write: async () => {}, close: async () => {} }),
        })
      })
    })

    const button = app.page.getByRole('button', { name: 'Export booklet (PDF) for Pocket Rough' })
    const status = app.page.locator('.cam-operation-status .cam-field-message')
    await button.click()

    await expect(button).toHaveAttribute('aria-busy', 'true')
    await expect(button).toBeDisabled()
    await expect(button.locator('.cam-generating-spinner')).toBeVisible()
    await expect(status).toHaveText('Booklet: choose where to save the PDF...')
    await expect(button).toHaveAttribute('title', 'Booklet: choose where to save the PDF...')

    await app.page.evaluate(() => (window as unknown as { __releaseBookletSave: () => void }).__releaseBookletSave())
    await expect(status).toHaveText('Booklet exported: booklet.pdf')
    await expect(button).toHaveAttribute('aria-busy', 'false')
    await expect(button).toBeEnabled()
    await expect(button.locator('.cam-generating-spinner')).toHaveCount(0)
  })

  test('toolpath warnings collapse to a coloured header with their count (#837)', async ({ app, ui }) => {
    await seedCamQuickOperationProjectWithLowTab(app.page)

    const carveMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(carveMenu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create pocket')
    await expect(ui.operations.rows(app.page)).toHaveCount(1)

    const section = app.page.locator('.cam-operation-properties .cam-operation-warnings')
    const header = section.locator('.disclosure-section__header')
    const notes = section.locator('.cam-field-note')

    // Open by default: the warnings are listed and no count is shown.
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await expect(notes.first()).toBeVisible()
    const count = await notes.count()
    await expect(section.locator('.disclosure-section__suffix')).toHaveCount(0)
    const openColour = await header.evaluate((el) => getComputedStyle(el).color)

    // Collapsed: the list is gone, the header carries the count and turns the warning colour.
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(notes).toHaveCount(0)
    await expect(section.locator('.disclosure-section__suffix')).toHaveText(`(${count})`)
    const warningColour = await app.page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--warning-text)'
      document.body.appendChild(probe)
      const colour = getComputedStyle(probe).color
      probe.remove()
      return colour
    })
    await expect.poll(() => header.evaluate((el) => getComputedStyle(el).color)).toBe(warningColour)
    expect(warningColour).not.toBe(openColour)

    // Expanding again restores the list.
    await header.click()
    await expect(notes).toHaveCount(count)

    // The operation's row in the tree takes the warning colour too, selected or not.
    const row = ui.operations.rows(app.page).first()
    const rowLabelColour = () => row.locator('.tree-label').evaluate((el) => getComputedStyle(el).color)
    await expect(row).toHaveClass(/cam-operation-row--warning/)
    await expect.poll(rowLabelColour).toBe(warningColour)
  })

  test('expanded properties lay out in exactly two columns (#559)', async ({ app, ui }) => {
    await seedCamQuickOperationProjectWithSmallCarveTarget(app.page)

    const carveMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(carveMenu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create pocket')
    await expect(ui.operations.rows(app.page)).toHaveCount(1)

    // Open every group so the content is taller than the dialog — the condition
    // that used to push a third column off the panel's right edge, reachable by
    // nothing at all: the panel overflowed horizontally without a scrollbar.
    for (const group of ['Strategy', 'Entry & retract', 'Corners', 'Output']) {
      await ui.cam.operationGroup(app.page, group).click()
    }

    await app.page.getByRole('button', { name: 'Expand operation properties' }).click()
    await expect(app.page.locator('.dialog--panel-expand')).toBeVisible()

    const layout = await app.page.evaluate(() => {
      const panel = document.querySelector('.dialog--panel-expand .properties-panel') as HTMLElement
      const body = document.querySelector('.dialog-body--panel-expand') as HTMLElement
      const sections = [...document.querySelectorAll('.dialog--panel-expand .disclosure-section')]
      const panelRight = panel.getBoundingClientRect().right
      return {
        sections: sections.length,
        columns: new Set(sections.map((el) => Math.round(el.getBoundingClientRect().left))).size,
        pastRightEdge: sections.filter((el) => el.getBoundingClientRect().right > panelRight + 1).length,
        horizontalOverflow: panel.scrollWidth - Math.round(panel.getBoundingClientRect().width),
        // Precondition, measured in a way that holds whichever direction the
        // overflow goes: stacked in one column the groups are taller than the
        // dialog, which is the only case where a third column can appear.
        stackedHeight: Math.round(sections.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0)),
        bodyHeight: body.clientHeight,
      }
    })

    // Guards against the assertions below passing on an empty or short panel.
    expect(layout.sections).toBeGreaterThan(4)
    expect(layout.stackedHeight).toBeGreaterThan(layout.bodyHeight)

    expect(layout.columns).toBe(2)
    expect(layout.pastRightEdge).toBe(0)
    expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
  })

  test('Feed reduction row carries its parameter-reference icon (#555)', async ({ app, ui }) => {
    await seedCamQuickOperationProjectWithSmallCarveTarget(app.page)

    const carveMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(carveMenu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create pocket')
    await expect(ui.operations.rows(app.page)).toHaveCount(1)

    // Speeds and feeds are the numbers changed on every material change, so
    // they are visible without opening anything (#559); the arc-fitting output
    // detail, set once per machine, is the one that collapses.
    for (const label of ['Feed', 'Plunge feed', 'Slot feed (%)', 'RPM']) {
      await expect(app.page.getByText(label, { exact: true })).toBeVisible()
    }
    await expect(app.page.getByText('Arc fitting (G2/G3)', { exact: true })).not.toBeVisible()

    // Every parameter row shows a schematic reference icon in its third
    // column; Feed reduction was the one row missing it.
    const feedReductionField = ui.cam.operationField(app.page, 'Feed reduction')
    await expect(feedReductionField.locator('.op-param-ref')).toBeVisible()

    // Switching the mode keeps the icon and stores the choice.
    await feedReductionField.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name: 'By engagement', exact: true }).click()
    await expect(feedReductionField.locator('.ui-select__label')).toHaveText('By engagement')
    await expect(feedReductionField.locator('.op-param-ref')).toBeVisible()

    const project = await getProject(app.page)
    const operations = project.operations as OperationSnapshot[]
    expect((operations[0] as Record<string, unknown>).pocketFeedReduction).toBe('engagement')
  })

  test('Add menu lists what the selection can take and collapses the rest (#732)', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)
    await selectFeatures(app.page, ['f-imported-model'])

    await ui.operations.headerAddButton(app.page).click()
    await expect(ui.operations.addMenu(app.page)).toBeVisible()

    // The kinds an imported model accepts come first, in the catalogue's own
    // order, with no dead row to scan past.
    const available = ui.operations.addMenuAvailableRows(app.page)
    await expect(ui.operations.addMenuRowLabels(available)).toHaveText([
      'Edge out',
      'Surface',
      'Engrave',
      '3D surface rough',
      '3D surface cleanup',
      '3D surface finish',
    ])
    await expect(available.locator('.cam-operation-hint')).toHaveCount(0)

    // The rest sit behind one labelled disclosure, collapsed until asked for.
    const unavailableToggle = ui.operations.addMenuUnavailableToggle(app.page)
    await expect(unavailableToggle).toHaveText('Not available for this selection (6)')
    await expect(unavailableToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(ui.operations.addMenuUnavailableRows(app.page)).toHaveCount(0)

    await unavailableToggle.click()
    const unavailable = ui.operations.addMenuUnavailableRows(app.page)
    await expect(ui.operations.addMenuRowLabels(unavailable)).toHaveText([
      'Pocket',
      'V-carve offset',
      'V-carve medial',
      'Edge in',
      'Drill',
      'Plasma through-cut',
    ])
    // Expanding shows today's rows unchanged: an inline reason each, and the
    // add control still disabled.
    await expect(unavailable.locator('.cam-operation-hint')).toHaveCount(6)
    const drillRow = unavailable.filter({
      has: app.page.locator('.cam-operation-label', { hasText: 'Drill' }),
    })
    await expect(drillRow.getByRole('button', { name: 'Add', exact: true })).toBeDisabled()
  })

  test('Add menu states the empty-selection precondition once (#732)', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    await ui.operations.headerAddButton(app.page).click()
    await expect(ui.operations.addMenu(app.page)).toBeVisible()

    // One precondition message, not eleven variants of it, and no operation
    // row until the user asks for one.
    const hints = ui.operations.addMenu(app.page).locator('.cam-operation-hint')
    await expect(hints).toHaveCount(1)
    await expect(hints).toHaveText('Select geometry in the sketch or feature tree, then choose an operation')
    await expect(ui.operations.addMenuAvailableRows(app.page)).toHaveCount(0)
    await expect(ui.operations.addMenuUnavailableRows(app.page)).toHaveCount(0)

    const unavailableToggle = ui.operations.addMenuUnavailableToggle(app.page)
    await expect(unavailableToggle).toHaveText('Not available for this selection (12)')
    await unavailableToggle.click()
    await expect(ui.operations.addMenuUnavailableRows(app.page)).toHaveCount(12)
    await expect(ui.operations.addMenuRowLabels(ui.operations.addMenuUnavailableRows(app.page))).toHaveText([
      'Pocket', 'V-carve offset', 'V-carve medial', 'Edge in', 'Edge out', 'Surface', 'Engrave', 'Drill',
      '3D surface rough', '3D surface cleanup', '3D surface finish', 'Plasma through-cut',
    ])

    // "Select all" is the recovery path out of a wrong selection, so it has to
    // survive inside the collapsed section: it fixes the selection, and the
    // kind it fixed moves up into the available list.
    const drillRow = ui.operations.addMenuUnavailableRows(app.page).filter({
      has: app.page.locator('.cam-operation-label', { hasText: 'Drill' }),
    })
    await drillRow.hover()
    await drillRow.getByRole('button', { name: 'Select all', exact: true }).click()

    await expect(
      ui.operations.addMenuRowLabels(ui.operations.addMenuAvailableRows(app.page)),
    ).toContainText(['Drill'])
  })
})


/** Load-project fitting uses the same viewport transform; no approximate screen coordinates. */
async function plasmaCanvasPoint(page: Page, point: { x: number; y: number }) {
  const project = await getProject(page)
  return page.evaluate(async ({ project, point }) => {
    const modulePath = '/src/components/canvas/viewTransform.ts'
    const view = await import(modulePath) as typeof import('../src/components/canvas/viewTransform')
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.sketch-canvas')!
    const rect = canvas.getBoundingClientRect()
    const snapshot = project as unknown as Project
    const vt = view.computeSketchViewTransform(snapshot, canvas.width, canvas.height, view.computeFitViewState(snapshot, canvas.width, canvas.height))
    const screen = view.worldToCanvas(point, vt)
    return { x: rect.left + screen.cx * rect.width / canvas.width, y: rect.top + screen.cy * rect.height / canvas.height }
  }, { project, point })
}

for (const pointer of ['mouse', 'touch'] as const) {
  test.describe(`plasma picker ${pointer}`, () => {
    test.use({ hasTouch: pointer === 'touch', viewport: pointer === 'touch' ? { width: 1180, height: 820 } : { width: 1440, height: 900 } })
    test('plasma add menu and graphical per-contour starts persist (#957)', async ({ app, ui }) => {
      await seedCamQuickOperationProject(app.page)
      const fixture = await getProject(app.page)
      const meta = fixture.meta as Record<string, unknown>; meta.units = 'mm'
      const tools = fixture.tools as Array<Record<string, unknown>>
      fixture.tools = [...tools, { ...tools[0], id: 'torch-e2e', name: 'Plasma torch', type: 'plasma', units: 'mm', diameter: 1.2, pierceHeight: 3, cutHeight: 1.5, pierceDelay: 0.6, defaultFeed: 2200 }]
      await seedProject(app.page, JSON.stringify(fixture))
      await selectFeatures(app.page, ['f-machinable-add', 'f-carve-target'])
      if (pointer === 'touch') await app.page.getByRole('button', { name: 'Open operations panel', exact: true }).click()
      await ui.operations.headerAddButton(app.page).click()
      const row = ui.operations.addMenuAvailableRows(app.page).filter({ hasText: 'Plasma through-cut' })
      await row.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(ui.operations.rowByName(app.page, 'Plasma through-cut')).toBeVisible()
      for (const field of ['Stepdown', 'RPM', 'Tabs', 'Pass', 'Start X (mm)', 'Start Y (mm)']) await expect(ui.cam.operationField(app.page, field)).toHaveCount(0)
      const side = ui.cam.operationField(app.page, 'Kerf side')
      await side.locator('.ui-select__trigger').click()
      await app.page.getByRole('option', { name: 'Inside (hole)', exact: true }).click()
      const length = ui.cam.operationField(app.page, 'Lead-in length / arc radius (mm)').locator('input')
      await length.fill('8'); await length.press('Enter')
      await ui.cam.plasmaReverse(app.page).check()
      const choose = async (point: { x: number; y: number }) => {
        const screen = await plasmaCanvasPoint(app.page, point)
        if (pointer === 'touch') await app.page.touchscreen.tap(screen.x, screen.y)
        else await app.page.mouse.click(screen.x, screen.y)
      }
      if (pointer === 'touch') {
        await app.page.getByRole('button', { name: 'Expand operation properties', exact: true }).click()
        await app.page.locator('.dialog--panel-expand').getByRole('button', { name: 'Pick start point', exact: true }).click()
        await expect(app.page.locator('.dialog--panel-expand')).toHaveCount(0)
      } else await ui.cam.plasmaStart(app.page).click()
      await choose({ x: 140, y: 70 }) // unrelated drill contour: no pick or geometry edit
      await expect(app.page.getByTestId('plasma-pick-controls')).toBeVisible()
      expect((await getProject(app.page)).features).toEqual(fixture.features)
      const startScreen = await plasmaCanvasPoint(app.page, { x: 50, y: 30 })
      if (pointer === 'mouse') {
        await app.page.mouse.move(startScreen.x, startScreen.y); await app.page.mouse.down()
        await app.page.mouse.move(startScreen.x + 40, startScreen.y + 25); await app.page.mouse.up()
      } else {
        const session = await app.page.context().newCDPSession(app.page)
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startScreen.x, y: startScreen.y, id: 0 }, { x: startScreen.x + 40, y: startScreen.y + 25, id: 1 }] })
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await session.detach()
      }
      await expect(app.page.getByTestId('plasma-pick-controls')).toBeVisible()
      expect(((await getProject(app.page)).operations as Array<Record<string, unknown>>)[0].plasmaStartPoints).toBeUndefined()
      await choose({ x: 50, y: 30 })
      if (pointer === 'touch') await app.page.getByRole('button', { name: 'Open operations panel', exact: true }).click()
      await expect(ui.cam.plasmaStart(app.page)).toBeVisible()
      await expect(app.page.getByTestId('plasma-start-dot')).toHaveCount(1)
      let saved = await getProject(app.page)
      let operation = (saved.operations as Array<Record<string, unknown>>)[0]
      const points = operation.plasmaStartPoints as Record<string, { x: number; y: number }>
      expect(Object.keys(points)).toEqual(['f-machinable-add'])
      expect(points['f-machinable-add'].x).toBeCloseTo(20, 2); expect(points['f-machinable-add'].y).toBe(0)
      expect(operation.plasmaStartPoint).toBeUndefined()
      await ui.cam.plasmaStart(app.page).click()
      if (pointer === 'mouse') await ui.canvas.sketch(app.page).press('Escape')
      else await app.page.getByTestId('plasma-pick-controls').getByRole('button', { name: 'Cancel pick', exact: true }).click()
      expect((await getProject(app.page)).operations).toEqual(saved.operations)
      if (pointer === 'touch') await app.page.getByRole('button', { name: 'Open operations panel', exact: true }).click()
      await ui.cam.plasmaStart(app.page).click()
      await choose({ x: 120, y: 30 })
      await expect(app.page.getByTestId('plasma-start-dot')).toHaveCount(2)
      if (pointer === 'touch') await app.page.getByRole('button', { name: 'Open operations panel', exact: true }).click()
      saved = await getProject(app.page); operation = (saved.operations as Array<Record<string, unknown>>)[0]
      expect(operation.toolRef).toBe('torch-e2e'); expect(operation.plasmaSide).toBe('inside')
      expect(operation.plasmaLeadInLength).toBe(8); expect(operation.plasmaReverseDirection).toBe(true)
      const bothPoints = operation.plasmaStartPoints as Record<string, { x: number; y: number }>
      expect(Object.keys(bothPoints).sort()).toEqual(['f-carve-target', 'f-machinable-add'])
      for (const value of Object.values(bothPoints)) { expect(value.x).toBeCloseTo(20, 2); expect(value.y).toBe(0) }
      await seedProject(app.page, JSON.stringify(saved))
      if (!await ui.cam.plasmaReverse(app.page).isVisible()) await ui.operations.rowByName(app.page, 'Plasma through-cut').click()
      await expect(app.page.getByTestId('plasma-start-dot')).toHaveCount(2)
      const instances = saved.features as Array<Record<string, unknown>>
      const moved = instances.find((feature) => feature.id === 'f-machinable-add')!
      moved.transform = { a: 0, b: 1.5, c: -1.5, d: 0, e: 95, f: 15 }
      await seedProject(app.page, JSON.stringify(saved))
      if (!await ui.cam.plasmaReverse(app.page).isVisible()) await ui.operations.rowByName(app.page, 'Plasma through-cut').click()
      const expected = await plasmaCanvasPoint(app.page, { x: 95, y: 45 })
      const marker = app.page.locator('[data-contour-id="f-machinable-add"] circle')
      await expect(marker).toBeVisible()
      await expect.poll(async () => {
        const box = await marker.boundingBox()
        return box ? Math.hypot(box.x + box.width / 2 - expected.x, box.y + box.height / 2 - expected.y) : Infinity
      }).toBeLessThan(1)
      await expect(ui.cam.plasmaReverse(app.page)).toBeChecked()
      await expect(ui.cam.operationField(app.page, 'Lead-in length / arc radius (mm)').locator('input')).toHaveValue('8')
      await expect(ui.cam.plasmaHelp(app.page)).toContainText('No corner slowdown, overburn, micro-joints or bevel compensation')
      await app.page.getByRole('group', { name: 'Machinable Add', exact: true }).getByRole('button', { name: 'Use automatic start', exact: true }).click()
      await expect(app.page.getByTestId('plasma-start-dot')).toHaveCount(1)
      expect(((await getProject(app.page)).operations as Array<Record<string, unknown>>)[0].plasmaStartPoints).toEqual({ 'f-carve-target': bothPoints['f-carve-target'] })
      await app.page.getByRole('button', { name: 'Reset all starts', exact: true }).click()
      await expect(app.page.getByTestId('plasma-start-marker')).toHaveCount(0)
      expect(((await getProject(app.page)).operations as Array<Record<string, unknown>>)[0].plasmaStartPoints).toBeUndefined()
      await ui.cam.plasmaStart(app.page).click()
      await seedProject(app.page, JSON.stringify(saved))
      await expect(app.page.getByTestId('plasma-pick-controls')).toHaveCount(0)
      const operations = saved.operations as Array<Record<string, unknown>>
      saved.operations = [...operations, { ...operations[0], id: 'other-plasma', name: 'Other plasma', plasmaStartPoints: undefined }]
      await seedProject(app.page, JSON.stringify(saved))
      if (pointer === 'touch') await app.page.getByRole('button', { name: 'Open operations panel', exact: true }).click()
      if (!await ui.cam.plasmaStart(app.page).isVisible()) await ui.operations.rowByName(app.page, 'Plasma through-cut').click()
      await ui.cam.plasmaStart(app.page).click()
      if (pointer === 'touch') await app.page.getByRole('button', { name: 'Open operations panel', exact: true }).click()
      await ui.operations.rowByName(app.page, 'Other plasma').click()
      await expect(app.page.getByTestId('plasma-pick-controls')).toHaveCount(0)
      await ui.cam.plasmaStart(app.page).click()
      await app.page.getByRole('button', { name: 'Bottom', exact: true }).click()
      await expect(app.page.getByTestId('plasma-pick-controls')).toHaveCount(0)
    })
  })
}
