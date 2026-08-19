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
  setActiveSegmentControl,
} from './helpers'
import { seedLinkedProject } from './featureReferences.helpers'

const EDIT_PANEL = '.canvas-workflow-panel--edit'

function defProfile(project: Record<string, unknown>): {
  segments: Array<{ to: { x: number } }>
} {
  const defs = project.featureDefinitions as Record<string, { profile: { segments: Array<{ to: { x: number } }> } }>
  return defs['def-linked'].profile
}

test('a tool entered from the panel exits via Done, keeping its edits and the session', async ({ app }) => {
  await seedLinkedProject(app.page)
  await enterSketchEdit(app.page, 'f-linked-a')

  const panel = app.page.locator(EDIT_PANEL)
  await expect(panel).toBeVisible()
  await expect(panel.locator('.canvas-workflow-panel__title')).toHaveText('Edit sketch')

  // Session actions are present in every sub-state, with session-wide meaning.
  await expect(panel.getByRole('button', { name: 'Finish editing' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Cancel editing' })).toBeVisible()

  // The tools live in the panel now; the global rail no longer hosts them.
  await panel.getByRole('button', { name: 'Add point' }).click()
  await expect(panel.getByRole('button', { name: 'Done adding points' })).toBeVisible()

  // The click an add-point tool would dispatch onto the top segment.
  await insertFeaturePointAt(app.page, 'f-linked-a', 0, 30, 0, 0.5)
  expect(defProfile(await getProject(app.page)).segments.length).toBe(5)

  // Done exits the mode — the edit survives and the session stays open.
  await panel.getByRole('button', { name: 'Done adding points' }).click()
  await expect(panel.getByRole('button', { name: 'Done adding points' })).toHaveCount(0)
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Finish editing' })).toBeVisible()
  expect(await getSketchEditState(app.page)).toEqual({ mode: 'sketch_edit', tool: null, pending: null })
  expect(defProfile(await getProject(app.page)).segments.length).toBe(5)
})

test('Escape leaves the tool first and only then cancels the session', async ({ app }) => {
  await seedLinkedProject(app.page)
  await enterSketchEdit(app.page, 'f-linked-a')

  const panel = app.page.locator(EDIT_PANEL)
  await panel.getByRole('button', { name: 'Add point' }).click()
  await expect(panel.getByRole('button', { name: 'Done adding points' })).toBeVisible()

  // First Escape exits the mode, keeping the session alive.
  await app.page.keyboard.press('Escape')
  await expect(panel.getByRole('button', { name: 'Done adding points' })).toHaveCount(0)
  await expect(panel).toBeVisible()
  expect((await getSketchEditState(app.page)).mode).toBe('sketch_edit')

  // Second Escape cancels the whole session.
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

  // Session cancel abandons everything, including the committed inspector edit.
  await panel.getByRole('button', { name: 'Cancel editing' }).click()
  await expect(panel).toHaveCount(0)
  await expect.poll(async () => defProfile(await getProject(app.page)).segments[0].to.x).toBe(60)
})
