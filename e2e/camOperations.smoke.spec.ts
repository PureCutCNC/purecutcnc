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
    await expect(app.page.getByText('Stepover Ratio', { exact: true })).toBeVisible()

    const project = await getProject(app.page)
    const operations = project.operations as OperationSnapshot[]
    expect(operations).toHaveLength(1)
    expect(operations[0].kind).toBe('edge_route_outside')
    expect(operations[0].pass).toBe('rough')
    expect(operations[0].target?.source).toBe('features')
    expect(operations[0].target?.featureIds).toEqual(['f-machinable-add'])
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
})
