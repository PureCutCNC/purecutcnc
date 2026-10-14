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
 * The project type in the UI (issue #1028).
 *
 * The user chooses **Project type** in the project properties and the rest
 * follows: which machine is selected, whether the stock is a block or a round
 * bar, whether Around exists, and which operations the export cuts. The
 * confirmation says what will change, and nothing is ever deleted.
 *
 * Assumptions this spec makes, since it is written without a browser run:
 *
 * - The bundled library has no rotary-capable machine, so the fixture embeds
 *   one ("E2E Rotary Router") and selects it. Seeding merges a project's custom
 *   definitions into the application library, so the machine stays a candidate
 *   after the Plasma leg replaces the project's snapshot with QtPlasmaC, and
 *   the Rotary leg can select it again.
 * - The confirm dialog's lines are asserted exactly, which pins the wording and
 *   the order the lines are built in.
 * - The fixture has no Around **feature**, so the "kept but hidden" line is not
 *   asserted here; the operations and features are read straight from the store
 *   afterwards to prove nothing is deleted.
 */

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  chooseProjectType,
  clickMenuItem,
  confirmProjectTypeChange,
  getProject,
  openRowContextMenu,
  rowByName,
  seedProject,
  setProjectType,
} from './helpers'
import { camQuickOperationProjectJson } from './camOperations.helpers'
import { e2eMachineDefinition } from './machineLibrary.helpers'

const QT_PLASMAC = JSON.parse(
  readFileSync(new URL('../src/engine/gcode/definitions/qtplasmac.json', import.meta.url), 'utf8'),
) as { name: string }

const ROTARY_ROUTER_ID = 'e2e-rotary-router'
const ROTARY_ROUTER_NAME = 'E2E Rotary Router'
const POCKET = 'Pocket Rough'
const PLASMA = 'Plasma'
const ROTARY = 'Rotary'
const MILLING = 'Milling / routing'

/** A rectangular sketch profile, matching the fixture's own shape. */
function rectProfile(cx: number, cy: number, w: number, h: number) {
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

/**
 * The CAM quick-operation fixture, with a stored milling type and a
 * rotary-capable router available. Carve Target is shrunk so the pocket
 * generates in about a second (see `seedCamQuickOperationProjectWithSmallCarveTarget`).
 * `selectedMachineId: null` leaves no machine chosen, so a type change has no
 * machine to move.
 */
function projectTypeFixtureJson(selectedMachineId: string | null = ROTARY_ROUTER_ID): string {
  const project = JSON.parse(camQuickOperationProjectJson) as {
    meta: Record<string, unknown>
    featureDefinitions: Record<string, { profile: unknown }>
  }
  project.featureDefinitions['def-carve-target'].profile = rectProfile(0, 0, 4, 2)
  project.meta.projectType = 'milling'
  project.meta.machineDefinitions = [
    e2eMachineDefinition({
      id: ROTARY_ROUTER_ID,
      name: ROTARY_ROUTER_NAME,
      rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
    }),
  ]
  project.meta.selectedMachineId = selectedMachineId
  return JSON.stringify(project)
}

interface SavedProject {
  meta: { projectType?: string }
  stock: { shape?: string }
  features: { id: string }[]
  operations: { id: string; kind: string }[]
}

async function savedProject(page: Page): Promise<SavedProject> {
  return await getProject(page) as unknown as SavedProject
}

test.describe('project type in the UI (#1028)', () => {
  test('a milling project survives a trip through Plasma and Rotary', async ({ app, ui }) => {
    // Seed through the seam, then read it back so the assertions compare the
    // project to itself rather than to the fixture.
    await seedProject(app.page, projectTypeFixtureJson())

    // A pocket operation on the top face.
    const menu = await openRowContextMenu(app.page, rowByName(app.page, 'Carve Target'))
    await ui.contextMenu.item(menu, 'Create operation').hover()
    await clickMenuItem(ui.contextMenu.submenu(app.page), 'Create pocket')
    const pocket = ui.operations.rowByName(app.page, POCKET)
    await expect(pocket).toBeVisible()
    await expect(ui.generation.gearStatus(app.page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })

    const before = await savedProject(app.page)
    expect(before.meta.projectType).toBe('milling')
    expect(before.operations.map((operation) => operation.kind)).toEqual(['pocket'])

    // ── Milling → Plasma ────────────────────────────────────────────
    await chooseProjectType(app.page, ui, PLASMA)
    // The confirm shows the operation the new type will not cut and the
    // machine the change selects, in that order.
    await expect(ui.projectTypeDialog.lines(app.page)).toHaveText([
      '1 enabled operation will not be cut',
      `Machine changes to ${QT_PLASMAC.name}`,
    ])
    await confirmProjectTypeChange(app.page, ui)

    // The plasma machine is selected and the milling pocket is reported as not
    // cut, not dropped.
    await expect(ui.properties.machineTrigger(app.page).locator('.ui-select__label')).toHaveText(QT_PLASMAC.name)
    await expect(ui.properties.machineTypeMismatch(app.page)).toHaveCount(0)
    await expect(pocket).toBeVisible()
    await expect(pocket.locator('.cam-operation-badge')).toHaveText(['not on this machine'])
    await expect(app.page.locator('.cam-operations-notice')).toHaveText(
      'Not plasma cuts, left out of the export on this machine: 1',
    )

    // ── Plasma → Rotary ─────────────────────────────────────────────
    await chooseProjectType(app.page, ui, ROTARY)
    // The stock becomes a bar and the rotary-capable router is selected again —
    // it is still in the application library the seed merged it into.
    await expect(ui.projectTypeDialog.lines(app.page)).toHaveText([
      'The block becomes a round bar of the same size',
      `Machine changes to ${ROTARY_ROUTER_NAME}`,
    ])
    await confirmProjectTypeChange(app.page, ui)

    await expect(ui.properties.machineTrigger(app.page).locator('.ui-select__label')).toHaveText(ROTARY_ROUTER_NAME)
    await ui.tree.stockRow(app.page).click()
    await expect(ui.properties.stockShape(app.page).locator('.ui-select__label')).toHaveText('Round bar')
    await expect(ui.properties.stockDiameter(app.page)).toBeVisible()

    // A rotary project with a round bar and a rotary machine has an Around face.
    await expect(ui.face.switchGroup(app.page)).toBeVisible()
    await expect(ui.face.segment(app.page, 'Around')).toBeVisible()
    await expect(ui.generation.gearStatus(app.page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })

    // ── Rotary → Milling ────────────────────────────────────────────
    await chooseProjectType(app.page, ui, MILLING)
    // Only the stock changes back; the rotary router already suits milling, so
    // there is no machine line.
    await expect(ui.projectTypeDialog.lines(app.page)).toHaveText([
      'The round bar becomes a block of the same size',
    ])
    await confirmProjectTypeChange(app.page, ui)

    await ui.tree.stockRow(app.page).click()
    await expect(ui.properties.stockShape(app.page).locator('.ui-select__label')).toHaveText('Block')

    // Nothing was deleted: the pocket, every other operation and every feature
    // are exactly what they were before the trip.
    const after = await savedProject(app.page)
    expect(after.meta.projectType).toBe('milling')
    expect(after.stock.shape === 'round').toBe(false)
    expect(after.operations.map((operation) => operation.id)).toEqual(before.operations.map((operation) => operation.id))
    expect(after.features.map((feature) => feature.id)).toEqual(before.features.map((feature) => feature.id))
  })

  test('a change with nothing to say is applied without a dialog', async ({ app, ui }) => {
    // No machine, no operations, a block either way: the milling → plasma
    // change has nothing to report, so it must not open the confirm.
    await seedProject(app.page, projectTypeFixtureJson(null))

    await setProjectType(app.page, ui, PLASMA)
    await expect(ui.properties.projectTypeTrigger(app.page).locator('.ui-select__label')).toHaveText(PLASMA)
    expect((await savedProject(app.page)).meta.projectType).toBe('plasma')

    // The stock shape control offers only the shapes the type does: a plasma
    // project is a block, shown as a disabled single-shape control rather than
    // a dead Block/Round bar dropdown.
    await ui.tree.stockRow(app.page).click()
    await expect(ui.properties.stockShape(app.page).locator('.ui-select__label')).toHaveText('Block')
    await expect(ui.properties.stockShape(app.page).locator('.ui-select__trigger')).toBeDisabled()
  })
})
