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
import { seedCamQuickOperationProject } from './camOperations.helpers'
import {
  clickMenuItem,
  getProject,
  seedProject,
  openRowContextMenu,
  rowByName,
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

test.describe('CAM operation browser smoke', () => {
  test('HTML5 drag reorders CAM operations', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

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

  test('Engrave strategy dropdown switches between Direct and Trochoidal', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

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
    await seedCamQuickOperationProject(app.page)

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
    await seedCamQuickOperationProject(app.page)

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
    await seedCamQuickOperationProject(app.page)

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
    await seedCamQuickOperationProject(app.page)

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
    await seedCamQuickOperationProject(app.page)

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

  test('expanded properties lay out in exactly two columns (#559)', async ({ app, ui }) => {
    await seedCamQuickOperationProject(app.page)

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
    await seedCamQuickOperationProject(app.page)

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
})


test('surface slope filter edits, validates, switches pattern and survives save/reload', async ({ app, ui }) => {
  const project = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8'))
  project.operations = [project.operations.find((operation: {kind: string}) => operation.kind === 'finish_surface')]
  project.operations[0].name = 'Slope finish'
  await seedProject(app.page, JSON.stringify(project))
  await ui.operations.rowByName(app.page, 'Slope finish').click()
  await ui.cam.operationGroup(app.page, 'Strategy').click()
  const toggle = app.page.getByRole('checkbox', { name: 'Filter by surface slope', exact: true })
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  const minimum = app.page.getByRole('spinbutton', { name: 'Minimum slope (°)', exact: true })
  const maximum = app.page.getByRole('spinbutton', { name: 'Maximum slope (°)', exact: true })
  await expect(minimum).toHaveValue('0')
  await expect(maximum).toHaveValue('30')
  await minimum.fill('40')
  await minimum.press('Enter')
  await expect(app.page.getByRole('alert')).toContainText('minimum no greater than maximum')
  await minimum.fill('5')
  await minimum.press('Enter')
  await expect(app.page.getByRole('alert')).toHaveCount(0)
  await ui.cam.operationField(app.page, 'Pattern').locator('.ui-select__trigger').click()
  await app.page.getByRole('option', { name: 'Waterline', exact: true }).click()
  await expect(toggle).toBeChecked()
  await expect(minimum).toHaveValue('5')
  const saved = await getProject(app.page)
  await app.page.reload()
  await seedProject(app.page, JSON.stringify(saved))
  await ui.operations.rowByName(app.page, 'Slope finish').click()
  if (!(await toggle.isVisible())) await ui.cam.operationGroup(app.page, 'Strategy').click()
  await expect(toggle).toBeChecked()
  await expect(minimum).toHaveValue('5')
  await expect(maximum).toHaveValue('30')
  await toggle.uncheck()
  await expect(minimum).toHaveCount(0)
  const cleared = (await getProject(app.page)).operations as Array<Record<string, unknown>>
  expect(cleared[0].finishSlopeMin).toBeUndefined()
  expect(cleared[0].finishSlopeMax).toBeUndefined()
})


test('ball-endmill finish uses scallop height with collapsed spacing overrides', async ({ app, ui }) => {
  // #720. Scallop height is the primary finish parameter for a ball endmill;
  // the old spacing controls remain available, but only in the collapsed
  // Advanced overrides group and with their implied cusp visible.
  const project = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8'))
  project.operations = [project.operations.find((operation: {kind: string}) => operation.kind === 'finish_surface')]
  project.operations[0].name = 'Scallop finish'
  project.tools[0].type = 'ball_endmill'
  await seedProject(app.page, JSON.stringify(project))
  await ui.operations.rowByName(app.page, 'Scallop finish').click()
  await ui.cam.operationGroup(app.page, 'Strategy').click()

  const pattern = ui.cam.operationField(app.page, 'Pattern')
  const scallopHeight = app.page.locator('.cam-operation-properties .properties-field')
    .filter({ has: app.page.getByText(/^Scallop height(?: \((?:in|mm)\))?$/) })
  const stepover = ui.cam.operationField(app.page, 'Stepover ratio')
  const adaptive = app.page.getByRole('checkbox', { name: /Adaptive refinement/ })
  const advanced = ui.cam.operationGroup(app.page, 'Advanced overrides')
  const selectPattern = async (name: string): Promise<void> => {
    await pattern.locator('.ui-select__trigger').click()
    await app.page.getByRole('option', { name, exact: true }).click()
    await expect(pattern.locator('.ui-select__label')).toHaveText(name)
  }

  await expect(pattern.locator('.ui-select__label')).toHaveText('Parallel')
  await expect(scallopHeight).toHaveCount(1)
  await expect(stepover).not.toBeVisible()
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await expect(adaptive).toHaveCount(0)

  await selectPattern('Waterline')
  await expect(adaptive).toBeChecked()
  await expect(app.page.getByText('Waterline uses the assumed 30° steep threshold.', { exact: true })).toBeVisible()
  await expect(ui.cam.operationField(app.page, 'Adaptive spacing')).not.toBeVisible()
  await advanced.click()
  const adaptiveSpacing = ui.cam.operationField(app.page, 'Adaptive spacing')
  await expect(adaptiveSpacing).toBeVisible()
  await expect(ui.cam.operationField(app.page, 'Stepdown')).toBeVisible()
  await expect(ui.cam.operationField(app.page, 'Max rings / band')).toBeVisible()
  const cuspNotes = app.page.getByText(/^Implied cusp/)
  await expect(cuspNotes).toHaveCount(2)
  const before = await cuspNotes.last().textContent()
  await adaptiveSpacing.locator('input').fill('0.02')
  await adaptiveSpacing.locator('input').blur()
  await expect(cuspNotes.last()).not.toHaveText(before ?? '')

  await selectPattern('Constant scallop')
  await expect(stepover).toHaveCount(0)
  await expect(advanced).toHaveCount(0)
  await expect(ui.cam.operationField(app.page, 'Stepdown')).toHaveCount(0)
  await expect(adaptive).toHaveCount(0)
  await expect(ui.cam.operationField(app.page, 'Adaptive spacing')).toHaveCount(0)
  await expect(ui.cam.operationField(app.page, 'Max rings / band')).toHaveCount(0)
  await expect(app.page.getByText(/^Implied cusp/)).toHaveCount(0)
  await scallopHeight.locator('input').fill('0.001')
  await scallopHeight.locator('input').blur()
  const stored = (await getProject(app.page)).operations as Array<Record<string, unknown>>
  expect(stored[0].pocketPattern).toBe('constant_scallop')
  expect(stored[0].finishScallopHeight).toBe(0.001)

  const saved = await getProject(app.page)
  await app.page.reload()
  await seedProject(app.page, JSON.stringify(saved))
  await ui.operations.rowByName(app.page, 'Scallop finish').click()
  if (!(await pattern.isVisible())) await ui.cam.operationGroup(app.page, 'Strategy').click()
  await expect(pattern.locator('.ui-select__label')).toHaveText('Constant scallop')
  await expect(scallopHeight.locator('input')).toHaveValue('0.001')
})

test('flat-endmill finish keeps legacy spacing controls', async ({ app, ui }) => {
  const project = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8'))
  project.operations = [project.operations.find((operation: {kind: string}) => operation.kind === 'finish_surface')]
  project.operations[0].name = 'Flat finish'
  await seedProject(app.page, JSON.stringify(project))
  await ui.operations.rowByName(app.page, 'Flat finish').click()
  await ui.cam.operationGroup(app.page, 'Strategy').click()

  await expect(ui.cam.operationField(app.page, 'Scallop height')).toHaveCount(0)
  const advanced = ui.cam.operationGroup(app.page, 'Advanced overrides')
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await advanced.click()
  await expect(ui.cam.operationField(app.page, 'Stepover ratio')).toBeVisible()
})

test.describe('Constant scallop single quality control on tablet', () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true })

  for (const units of ['mm', 'inch'] as const) {
    for (const legacyHeight of [undefined, 0]) {
      test(`preserves legacy ${String(legacyHeight)} height in ${units} until a valid edit`, async ({ app, ui }) => {
        const project = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8'))
        project.meta.units = units
        project.operations = [project.operations.find((operation: { kind: string }) => operation.kind === 'finish_surface')]
        Object.assign(project.operations[0], {
          name: 'Legacy scallop', pocketPattern: 'constant_scallop', stepover: 0.1,
          finishScallopHeight: legacyHeight,
        })
        Object.assign(project.tools[0], { type: 'ball_endmill', units, diameter: 4 })
        await seedProject(app.page, JSON.stringify(project))
        const before = await getProject(app.page)
        await app.page.getByRole('button', { name: 'Open operations panel' }).click()
        await ui.operations.rowByName(app.page, 'Legacy scallop').click()
        await app.page.getByRole('button', { name: 'Expand operation properties' }).click()
        const dialog = app.page.locator('.dialog--panel-expand')
        const field = dialog.locator('.properties-field').filter({
          has: app.page.getByText(`Scallop height (${units === 'inch' ? 'in' : 'mm'})`, { exact: true }),
        })
        if (!(await field.isVisible())) await dialog.getByRole('button', { name: 'Strategy', exact: true }).click()
        const input = field.locator('input')
        const expectedHeight = 2 - Math.sqrt(4 - 0.4 ** 2 / 4)
        expect(Number(await input.inputValue())).toBeCloseTo(expectedHeight, 8)
        await expect(dialog.getByText('Height of the ridges between passes. Smaller values give a finer finish and longer machining time.', { exact: true })).toBeVisible()
        await expect(ui.cam.operationGroup(app.page, 'Advanced overrides')).toHaveCount(0)
        await expect(ui.cam.operationField(app.page, 'Stepdown')).toHaveCount(0)
        await expect(ui.cam.operationField(app.page, 'Stepover ratio')).toHaveCount(0)
        await app.page.screenshot({ path: test.info().outputPath('constant-scallop.png') })
        await input.focus()
        await input.blur()
        expect((await getProject(app.page)).operations).toEqual(before.operations)

        for (const value of ['0', '-0.1', '', '2', 'abc']) {
          await input.fill(value)
          await input.blur()
          await expect(input).toHaveAttribute('aria-invalid', 'true')
          await expect(app.page.getByRole('alert')).toContainText('Enter a height greater than zero')
          expect((await getProject(app.page)).operations).toEqual(before.operations)
        }
        await input.focus()
        await input.press('Escape')
        // Escape also closes the expanded dialog; reopening must not commit
        // either an invalid draft or the rounded legacy display value.
        if (!(await dialog.isVisible())) {
          await app.page.getByRole('button', { name: 'Expand operation properties' }).click()
        }
        await expect(input).toHaveAttribute('aria-invalid', 'false')
        expect((await getProject(app.page)).operations).toEqual(before.operations)

        await input.fill('0.00001234')
        await input.press('Enter')
        const edited = await getProject(app.page)
        const operation = (edited.operations as Array<Record<string, unknown>>)[0]
        expect(operation.finishScallopHeight).toBe(0.00001234)
        expect(operation.stepover).toBe(0.1)
        await expect(input).toHaveValue('0.00001234')
        await app.page.reload()
        await seedProject(app.page, JSON.stringify(edited))
        await app.page.getByRole('button', { name: 'Open operations panel' }).click()
        await ui.operations.rowByName(app.page, 'Legacy scallop').click()
        await app.page.getByRole('button', { name: 'Expand operation properties' }).click()
        if (!(await field.isVisible())) await dialog.getByRole('button', { name: 'Strategy', exact: true }).click()
        await expect(input).toHaveValue('0.00001234')
        await input.focus()
        await input.blur()
        expect((await getProject(app.page)).operations).toEqual(edited.operations)
      })
    }
  }
})
