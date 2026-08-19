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
  edgeStrategy?: unknown
  carveStrategy?: unknown
  trochoidalCutWidth?: unknown
  trochoidalAdvance?: unknown
  machiningOrder?: unknown
  entryStrategy?: unknown
  entryRampAngle?: unknown
  entryHelixDiameterPercent?: unknown
  countersinkDiameter?: unknown
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
