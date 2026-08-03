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
import { seedCamQuickOperationProject } from './camOperations.helpers'
import {
  clickMenuItem,
  getProject,
  openRowContextMenu,
  rowByName,
} from './helpers'

interface OperationSnapshot {
  kind?: unknown
  pass?: unknown
  entryStrategy?: unknown
  entryRampAngle?: unknown
  entryHelixDiameterPercent?: unknown
  target?: {
    source?: unknown
    featureIds?: unknown
  }
}

test.describe('CAM operation browser smoke', () => {
  test('HTML5 drag reorders CAM operations', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    const edgeMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Machinable Add'))
    await ui.contextMenu.item(edgeMenu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create Outside Route')
    await expect(ui.operations.rowByName(app.page, 'Edge route outside Rough')).toBeVisible()

    const carveMenu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(carveMenu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create V-Carve (medial)')
    await expect(ui.operations.rows(app.page)).toHaveCount(2)

    await ui.operations.rowByName(app.page, 'V-Carve medial')
      .dragTo(ui.operations.rowByName(app.page, 'Edge route outside Rough'))

    await expect(ui.operations.rows(app.page).nth(0)).toContainText('V-Carve medial')
    await expect(ui.operations.rows(app.page).nth(1)).toContainText('Edge route outside Rough')

    const project = await getProject(app.page)
    const operations = project.operations as Array<{ name?: unknown }>
    expect(operations.map((operation) => operation.name)).toEqual([
      'V-Carve medial',
      'Edge route outside Rough',
    ])
  })

  test('feature-row quick operation creates a CAM operation', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    const row = rowByName(app.page, 'Machinable Add')
    const menu = await openRowContextMenu(app.page, row)
    await ui.contextMenu.item(menu, 'Create operation').hover()

    const submenu = ui.contextMenu.submenu(app.page)
    await expect(submenu).toBeVisible()
    await expect(ui.contextMenu.item(submenu, 'Create Outside Route')).toBeVisible()

    await clickMenuItem(submenu, 'Create Outside Route')

    await expect(ui.operations.countBadge(app.page)).toHaveText('1')
    const operationRow = ui.operations.rowByName(app.page, 'Edge route outside Rough')
    await expect(operationRow).toBeVisible()
    await expect(app.page.getByText('Stepdown', { exact: true })).toBeVisible()
    await expect(app.page.getByText('Stepover Ratio', { exact: true })).not.toBeVisible()
    await app.page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await expect(app.page.getByText('Entry', { exact: true })).toHaveCount(0)

    const project = await getProject(app.page)
    const operations = project.operations as OperationSnapshot[]
    expect(operations).toHaveLength(1)
    expect(operations[0].kind).toBe('edge_route_outside')
    expect(operations[0].pass).toBe('rough')
    expect(operations[0].target?.source).toBe('features')
    expect(operations[0].target?.featureIds).toEqual(['f-machinable-add'])
  })

  test('quick-op submenu splits 2D and 3D operations for an imported model', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    const menu = await openRowContextMenu(app.page, rowByName(app.page, 'Imported Model'))
    await ui.contextMenu.item(menu, 'Create operation').hover()

    const submenu = ui.contextMenu.submenu(app.page)
    await expect(submenu).toBeVisible()
    await expect(ui.contextMenu.groupLabels(submenu)).toHaveText(['2D operations', '3D operations'])

    // The 3D entries carry the CAM panel's own names, and all follow the 2D ones.
    await expect(ui.contextMenu.item(submenu, 'Create 3D Surface rough')).toBeVisible()
    await expect(ui.contextMenu.item(submenu, 'Create 3D Surface finish')).toBeVisible()
    await expect(ui.contextMenu.item(submenu, 'Create 3D Surface cleanup')).toBeVisible()

    await clickMenuItem(submenu, 'Create 3D Surface rough')

    // Creation is async (it may load the bundled tool library first), so wait
    // for the operation to land in the UI before reading project state.
    await expect(ui.operations.countBadge(app.page)).toHaveText('1')

    await app.page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await expect(app.page.getByText('Entry', { exact: true })).toBeVisible()

    const strategyField = app.page.getByText('Entry Strategy', { exact: true }).locator('..')
    await expect(strategyField.locator('.ui-select__label')).toHaveText('Plunge')
    await expect(app.page.getByText('Ramp Angle (°)', { exact: true })).toHaveCount(0)
    await expect(app.page.getByText('Helix Diameter (%)', { exact: true })).toHaveCount(0)

    await strategyField.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name: 'Helix', exact: true }).click()

    const rampAngleField = app.page.getByText('Ramp Angle (°)', { exact: true }).locator('..')
    const helixDiameterField = app.page.getByText('Helix Diameter (%)', { exact: true }).locator('..')
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
    await expect(ui.contextMenu.item(submenu, 'Create Outside Route')).toBeVisible()
    await expect(ui.contextMenu.groupLabels(submenu)).toHaveCount(0)
  })

  test('quick operation creates a V-Carve medial with an auto-picked V-bit', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    const row = rowByName(app.page, 'Carve Target')
    const menu = await openRowContextMenu(app.page, row)
    await ui.contextMenu.item(menu, 'Create operation').hover()

    const submenu = ui.contextMenu.submenu(app.page)
    await expect(submenu).toBeVisible()
    await clickMenuItem(submenu, 'Create V-Carve (medial)')

    await expect(ui.operations.countBadge(app.page)).toHaveText('1')
    const operationRow = ui.operations.rowByName(app.page, 'V-Carve medial')
    await expect(operationRow).toBeVisible()
    await expect(app.page.getByText('Max Carve Depth', { exact: true })).toBeVisible()
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

  test('helical drilling: select Helical, assert conditional controls, change and persist', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

    // Create a drilling operation on the circle feature
    const menu = await openRowContextMenu(app.page, rowByName(app.page, 'Drill Target'))
    await ui.contextMenu.item(menu, 'Create operation').hover()
    const submenu = ui.contextMenu.submenu(app.page)
    await expect(submenu).toBeVisible()
    await clickMenuItem(submenu, 'Create Drilling')

    // Wait for the operation row to appear
    await expect(ui.operations.countBadge(app.page)).toHaveText('1')
    await expect(ui.operations.rowByName(app.page, 'Drill')).toBeVisible()

    // Expand the advanced section to reveal the Drill Type selector
    await app.page.getByRole('button', { name: 'Advanced', exact: true }).click()

    // The Drill Type selector should show the default (Simple (G81))
    const drillTypeField = app.page.getByText('Drill Type', { exact: true }).locator('..')
    await expect(drillTypeField.locator('.ui-select__label')).toHaveText('Simple (G81)')

    // Ramp Angle and Helix Diameter should NOT be visible yet (default is Simple)
    await expect(app.page.getByText('Ramp Angle (°)', { exact: true })).toHaveCount(0)
    await expect(app.page.getByText('Helix Diameter (%)', { exact: true })).toHaveCount(0)

    // Select Helical from the drill type dropdown
    await drillTypeField.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name: 'Helical', exact: true }).click()

    // Wait for the selector label to update
    await expect(drillTypeField.locator('.ui-select__label')).toHaveText('Helical')

    // Conditional controls should now be visible with defaults
    const rampAngleField = app.page.getByText('Ramp Angle (°)', { exact: true }).locator('..')
    const helixDiameterField = app.page.getByText('Helix Diameter (%)', { exact: true }).locator('..')
    await expect(rampAngleField.locator('input')).toHaveValue('5')
    await expect(helixDiameterField.locator('input')).toHaveValue('80')

    // Change both values through the rendered inputs
    await rampAngleField.locator('input').fill('8')
    await rampAngleField.locator('input').blur()
    await helixDiameterField.locator('input').fill('65')
    await helixDiameterField.locator('input').blur()

    // Verify persisted operation state
    const project = await getProject(app.page)
    const operations = project.operations as OperationSnapshot[]
    expect(operations).toHaveLength(1)
    expect(operations[0].kind).toBe('drilling')
    expect((operations[0] as Record<string, unknown>).drillType).toBe('helical')
    expect(operations[0].entryRampAngle).toBe(8)
    expect(operations[0].entryHelixDiameterPercent).toBe(65)
  })
})
