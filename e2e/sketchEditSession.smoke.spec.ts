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
import {
  enterSketchEdit,
  getProject,
  getSketchEditState,
  insertFeaturePointAt,
  seedProject,
  setActiveSegmentControl,
  setPendingSketchSubject,
} from './helpers'
import { seedLinkedProject } from './featureReferences.helpers'

const EDIT_PANEL = '.canvas-workflow-panel--edit'

function defProfile(project: Record<string, unknown>): {
  segments: Array<{ to: { x: number } }>
} {
  const defs = project.featureDefinitions as Record<string, { profile: { segments: Array<{ to: { x: number } }> } }>
  return defs['def-linked'].profile
}

/** Minimal project with one open two-segment line — trim/extend only apply to
 *  open profiles, so their Done strip needs a non-closed feature. */
function buildOpenLineProjectJson(): string {
  const now = new Date().toISOString()
  return JSON.stringify({
    version: '3.0',
    meta: {
      name: 'Open line fixture', created: now, modified: now, units: 'inch',
      showFeatureInfo: true, showDimensions: true, copyMode: 'reference',
      maxTravelZ: 2, operationClearanceZ: 0.2, clampClearanceXY: 0.5, clampClearanceZ: 0.2,
      machineDefinitions: [], selectedMachineId: null,
    },
    grid: { extent: 200, majorSpacing: 1, minorSpacing: 0.25, snapEnabled: false, snapIncrement: 0.25, visible: true },
    stock: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 200, y: 0 } },
          { type: 'line', to: { x: 200, y: 160 } },
          { type: 'line', to: { x: 0, y: 160 } },
          { type: 'line', to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      thickness: 2, material: 'aluminum_6061', color: '#b9a83c', visible: true, origin: { x: 0, y: 0 },
    },
    origin: { name: 'Origin', x: 100, y: 80, z: 2, visible: true },
    backdrop: null, dimensions: {}, annotations: [], modelAssets: {},
    featureDefinitions: {
      'def-line': {
        id: 'def-line', kind: 'polygon',
        profile: {
          start: { x: 20, y: 20 },
          segments: [
            { type: 'line', to: { x: 80, y: 20 } },
            { type: 'line', to: { x: 80, y: 60 } },
          ],
          closed: false,
        },
        dimensions: [], text: null, stl: null, operation: 'add',
      },
    },
    features: [{
      id: 'f-line', name: 'Line', definitionId: 'def-line',
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      constraints: [], folderId: null, z_top: 5, z_bottom: 0, visible: true, locked: false,
    }],
    featureFolders: [], featureTree: [], global_constraints: [],
    tools: [], operations: [], tabs: [], clamps: [], ai_history: [],
  })
}

test('switching tools exits the previous mode, keeping its edits and the session', async ({ app }) => {
  await seedLinkedProject(app.page)
  await enterSketchEdit(app.page, 'f-linked-a')

  const panel = app.page.locator(EDIT_PANEL)
  await expect(panel).toBeVisible()
  await expect(panel.locator('.canvas-workflow-panel__title')).toHaveText('Edit sketch')

  // Session actions are present in every sub-state, with session-wide meaning.
  await expect(panel.getByRole('button', { name: 'Finish editing' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Cancel editing' })).toBeVisible()

  // Add point is an immediate click-repeat mode: no Done strip, the toolbar
  // itself is the exit affordance.
  await panel.getByRole('button', { name: 'Add point' }).click()
  await expect(panel.getByRole('button', { name: 'Done adding points' })).toHaveCount(0)

  // The click an add-point tool would dispatch onto the top segment.
  await insertFeaturePointAt(app.page, 'f-linked-a', 0, 30, 0, 0.5)
  expect(defProfile(await getProject(app.page)).segments.length).toBe(5)

  // Clicking another tool closes the previous mode and keeps its edits.
  await panel.getByRole('button', { name: 'Delete segment' }).click()
  expect(await getSketchEditState(app.page)).toEqual({ mode: 'sketch_edit', tool: 'delete_segment', pending: null })
  expect(defProfile(await getProject(app.page)).segments.length).toBe(5)

  // Clicking the active tool again exits it entirely; edits and session stay.
  await panel.getByRole('button', { name: 'Delete segment' }).click()
  expect(await getSketchEditState(app.page)).toEqual({ mode: 'sketch_edit', tool: null, pending: null })
  await expect(panel.getByRole('button', { name: 'Finish editing' })).toBeVisible()
  expect(defProfile(await getProject(app.page)).segments.length).toBe(5)
})

test('Escape leaves the narrowest scope first and only then cancels the session', async ({ app }) => {
  await seedLinkedProject(app.page)
  await enterSketchEdit(app.page, 'f-linked-a')

  const panel = app.page.locator(EDIT_PANEL)
  await panel.getByRole('button', { name: 'Add point' }).click()

  // No mode has a Done strip; Escape is the first exit rung.
  await expect(panel.getByRole('button', { name: 'Done adding points' })).toHaveCount(0)
  await app.page.keyboard.press('Escape')
  await expect(panel).toBeVisible()
  expect((await getSketchEditState(app.page)).mode).toBe('sketch_edit')

  // Fillet behaves the same way; Escape still leaves the tool first.
  await panel.getByRole('button', { name: 'Round corner / fillet' }).click()
  await expect(panel.getByRole('button', { name: 'Done rounding' })).toHaveCount(0)
  await app.page.keyboard.press('Escape')
  await expect(panel).toBeVisible()
  expect((await getSketchEditState(app.page)).tool).toBeNull()

  // Trim holds a picked subject: the first Escape clears the pick but stays in
  // the tool, the second leaves the tool, the third cancels the session.
  await seedProject(app.page, buildOpenLineProjectJson())
  await enterSketchEdit(app.page, 'f-line')
  await panel.getByRole('button', { name: 'Trim to cutting edge' }).click()
  await setPendingSketchSubject(app.page, { featureId: 'f-line', segmentIndex: 0, x: 40, y: 20, t: 0.5 })
  expect(await getSketchEditState(app.page)).toEqual({
    mode: 'sketch_edit', tool: 'trim', pending: { tool: 'trim', phase: 'pick-reference' },
  })

  await app.page.keyboard.press('Escape')
  expect(await getSketchEditState(app.page)).toEqual({
    mode: 'sketch_edit', tool: 'trim', pending: { tool: 'trim', phase: 'pick-subject' },
  })

  await app.page.keyboard.press('Escape')
  expect(await getSketchEditState(app.page)).toEqual({ mode: 'sketch_edit', tool: null, pending: null })
  await expect(panel).toBeVisible()

  // Only the next Escape cancels the whole session.
  await app.page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  expect((await getSketchEditState(app.page)).mode).toBe('feature')
})

test('segment edits are live inside the session and Cancel editing discards them', async ({ app }) => {
  await seedLinkedProject(app.page)
  await enterSketchEdit(app.page, 'f-linked-a')
  expect(defProfile(await getProject(app.page)).segments[0].to.x).toBe(60)

  // Arm the top segment, focus the canvas, and open the inspector with Tab.
  await setActiveSegmentControl(app.page, 0)
  const canvas = app.page.locator('canvas').first()
  await canvas.evaluate((element) => (element as HTMLElement).focus())
  await app.page.keyboard.press('Tab')

  const panel = app.page.locator(EDIT_PANEL)
  const lengthField = panel.locator('.canvas-workflow-panel__field')
    .filter({ hasText: 'Length' })
    .locator('input')
  await expect(lengthField).toBeVisible()

  // The inspector is a labelled body section and never reuses the session
  // confirm/cancel controls: no extra buttons inside it.
  await expect(panel.locator('.canvas-workflow-panel__inspector').getByRole('button')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Finish editing' })).toBeVisible()

  // Live: typing moves the geometry immediately.
  await lengthField.fill('70')
  await expect.poll(async () => defProfile(await getProject(app.page)).segments[0].to.x).toBe(70)

  // Enter closes the inspector and keeps the value.
  await app.page.keyboard.press('Enter')
  await expect(lengthField).toHaveCount(0)
  await expect.poll(async () => defProfile(await getProject(app.page)).segments[0].to.x).toBe(70)

  // Reopen the inspector: a tool-button click also closes it (tablet has no
  // Enter key, so this is the touch exit path), and the live edit survives.
  await setActiveSegmentControl(app.page, 0)
  await canvas.evaluate((element) => (element as HTMLElement).focus())
  await app.page.keyboard.press('Tab')
  await expect(lengthField).toBeVisible()
  await lengthField.fill('65')
  await panel.getByRole('button', { name: 'Add point' }).click()
  await expect(lengthField).toHaveCount(0)
  expect(await getSketchEditState(app.page)).toEqual({ mode: 'sketch_edit', tool: 'add_point', pending: null })
  await expect.poll(async () => defProfile(await getProject(app.page)).segments[0].to.x).toBe(65)

  // Session cancel abandons everything, including the committed inspector edits.
  await panel.getByRole('button', { name: 'Cancel editing' }).click()
  await expect(panel).toHaveCount(0)
  await expect.poll(async () => defProfile(await getProject(app.page)).segments[0].to.x).toBe(60)
})
