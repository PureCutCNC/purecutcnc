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
  startAddRectPlacement,
  setPendingAddAnchor,
  startJoinFeatures,
  startRotateFeature,
  getKeepOriginals,
  getFeatureCount,
  getProject,
} from './helpers'
import { seedOverlapFeatureProject } from './overlapFeatureSelection.helpers'

const PANEL = '.canvas-workflow-panel--creation'

test('Alt cycles axis lock only after an uninterrupted tap (issue #826)', async ({ app }) => {
  const page = app.page
  const lock = page.locator('.axis-lock-chip')
  const canvas = page.locator('#workspace-panel-sketch canvas').first()
  await canvas.focus()

  await page.keyboard.down('Alt')
  await expect(lock).toHaveCount(0)
  await page.keyboard.up('Alt')
  await expect(lock).toContainText('Lock X')

  await page.keyboard.down('Alt')
  await page.keyboard.press('Tab')
  await page.keyboard.up('Alt')
  await expect(lock).toContainText('Lock X')

  await page.keyboard.down('Alt')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.keyboard.up('Alt')
  await expect(lock).toContainText('Lock X')

  await canvas.focus()
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', repeat: true, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true }))
  })
  await expect(lock).toContainText('Lock X')

  await page.keyboard.press('Control+Alt')
  await expect(lock).toContainText('Lock X')
  await page.keyboard.press('Shift+Alt')
  await expect(lock).toContainText('Lock X')
  await page.keyboard.press('Meta+Alt')
  await expect(lock).toContainText('Lock X')

  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', ctrlKey: true, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true }))
  })
  await expect(lock).toContainText('Lock X')

  await openRectangleCreationPanel(page)
  const dimensions = page.locator(PANEL).getByRole('button', { name: 'Dimensions (Tab)' })
  await dimensions.click()
  const width = page.locator(PANEL).locator('input').first()
  await width.focus()
  await page.keyboard.press('Alt')
  await expect(lock).toContainText('Lock X')

  await canvas.focus()
  await page.keyboard.press('Alt')
  await expect(lock).toContainText('Lock Y')

  await page.locator('#workspace-tab-preview3d').click()
  await page.keyboard.press('Alt')
  await page.locator('#workspace-tab-sketch').click()
  await expect(lock).toContainText('Lock Y')

  await canvas.focus()
  const shortcutWasSwallowed = await page.evaluate(() => {
    const down = new KeyboardEvent('keydown', { key: 'Alt', bubbles: true, cancelable: true })
    const up = new KeyboardEvent('keyup', { key: 'Alt', bubbles: true, cancelable: true })
    window.dispatchEvent(down)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', altKey: true, bubbles: true }))
    window.dispatchEvent(up)
    return down.defaultPrevented || up.defaultPrevented
  })
  expect(shortcutWasSwallowed).toBe(false)
  await expect(lock).toContainText('Lock Y')
})

/** Rectangle mid-draw: anchor placed, waiting for the opposite corner. */
async function openRectangleCreationPanel(page: Parameters<typeof startAddRectPlacement>[0]) {
  await startAddRectPlacement(page)
  await setPendingAddAnchor(page, 10, 10)
}

test('creation panel collapses to its title bar when it has no body content', async ({ app }) => {
  await openRectangleCreationPanel(app.page)

  const panel = app.page.locator(PANEL)
  await expect(panel).toBeVisible()
  await expect(panel.locator('.canvas-workflow-panel__title')).toHaveText('Rectangle')
  await expect(panel.locator('.canvas-workflow-panel__step')).toHaveText(/Click opposite corner/)

  // Nothing to show below the title bar, so the body element is never rendered.
  // toHaveCount(0) rather than toBeHidden(): toBeHidden() also passes for an
  // element that does not exist, which would make this pass even if the collapse
  // broke and left an empty padded body behind.
  //
  // This covers the Children.toArray guard. The other half — the :empty CSS
  // backstop for call sites passing `cond ? <div/> : <>…</>` — is covered by the
  // rotate test below, where the fragment makes the element render regardless.
  await expect(panel.locator('.canvas-workflow-panel__body')).toHaveCount(0)
})

test('panel actions state their shortcut and stay out of the tab order', async ({ app }) => {
  await openRectangleCreationPanel(app.page)
  const panel = app.page.locator(PANEL)

  // A labelled action carries its key inline, untranslated.
  const dimensions = panel.getByRole('button', { name: 'Dimensions (Tab)' })
  await expect(dimensions).toBeVisible()

  // Icon-only actions keep a clean accessible name and expose the key via
  // aria-keyshortcuts, with the combined form only in the tooltip. Asserting the
  // exact name here is deliberate: widening it to "Cancel (Esc)" is what broke
  // every existing consumer matching this button by role and name.
  const cancel = panel.getByRole('button', { name: 'Cancel', exact: true })
  await expect(cancel).toBeVisible()
  await expect(cancel).toHaveAttribute('aria-keyshortcuts', 'Esc')
  await expect(cancel).toHaveAttribute('title', 'Cancel (Esc)')

  // Both have a key mapped, so neither is a tab stop.
  await expect(dimensions).toHaveAttribute('tabindex', '-1')
  await expect(cancel).toHaveAttribute('tabindex', '-1')
})

// Outcome-level guard: asserts the behaviour the panel must have, not which of the
// two mechanisms delivers it (tabIndex={-1} on keyed actions, plus the capture-phase
// wrap in CanvasWorkflowPanel). For this panel the tabIndex rule alone is sufficient;
// the wrap is what holds panels whose last control has no shortcut, e.g. gear.
test('Tab cycles the panel fields without escaping into the app', async ({ app }) => {
  await openRectangleCreationPanel(app.page)
  const panel = app.page.locator(PANEL)

  await panel.getByRole('button', { name: 'Dimensions (Tab)' }).click()

  const field = (name: string) =>
    panel.locator('.canvas-workflow-panel__field').filter({ hasText: name }).locator('input')

  const width = field('Width')
  const height = field('Height')
  await expect(width).toBeVisible()
  await expect(height).toBeVisible()

  await width.focus()
  await app.page.keyboard.press('Tab')
  await expect(height).toBeFocused()

  // Wraps back to the first field rather than reaching the actions or the toolbar.
  await app.page.keyboard.press('Tab')
  await expect(width).toBeFocused()

  await app.page.keyboard.press('Shift+Tab')
  await expect(height).toBeFocused()

  // Focus never left the panel at any point in that cycle.
  const focusInsidePanel = await app.page.evaluate(
    (selector) => document.querySelector(selector)?.contains(document.activeElement) ?? false,
    PANEL,
  )
  expect(focusInsidePanel).toBe(true)
})

test('rotate panel collapses its all-false fragment body', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 2)
  await startRotateFeature(app.page, 'f-overlap-1')

  const panel = app.page.locator('.canvas-workflow-panel--transform')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.canvas-workflow-panel__step')).toHaveText(/Select origin/)

  // This panel passes `cond ? <div/> : <>…</>`, so the Children.toArray guard sees
  // one child and renders the body element regardless. Before the :empty rule that
  // left a stray divider and a band of empty padding under the title bar.
  const body = panel.locator('.canvas-workflow-panel__body')
  await expect(body).toHaveCount(1)
  await expect(body).toBeHidden()

  // The whole panel is therefore just its title bar.
  const height = await panel.evaluate((el) => el.getBoundingClientRect().height)
  expect(height).toBeLessThan(70)
})

test('K toggles keep originals on the join panel', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 2)
  // One feature only. Since issue #522 a selection of both would qualify and
  // join outright, leaving no panel to toggle — the fixture's two features are
  // coincident full-stock rects, i.e. exactly the qualifying case.
  await startJoinFeatures(app.page, ['f-overlap-1'])

  const panel = app.page.locator('.canvas-workflow-panel--join')
  await expect(panel).toBeVisible()

  const checkbox = panel.locator('.canvas-workflow-panel__check input[type="checkbox"]')
  await expect(checkbox).not.toBeChecked()
  await expect(panel.locator('.canvas-workflow-panel__check')).toHaveText(/Keep originals \(K\)/)

  const canvas = app.page.locator('canvas').first()
  await canvas.click({ position: { x: 5, y: 5 } })

  await app.page.keyboard.press('k')
  await expect(checkbox).toBeChecked()
  expect((await getKeepOriginals(app.page)).shapeAction).toBe(true)

  await app.page.keyboard.press('k')
  await expect(checkbox).not.toBeChecked()

  // Modifier combinations stay free for the app's own bindings.
  await app.page.keyboard.press('Meta+k')
  await expect(checkbox).not.toBeChecked()
})

test('a qualifying selection joins with no panel at all (issue #522)', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 2)
  expect(await getFeatureCount(app.page)).toBe(2)

  await startJoinFeatures(app.page, ['f-overlap-1', 'f-overlap-2'])

  // The selection had already answered the panel's only question, so the join
  // runs outright and the originals are consumed into one feature.
  await expect.poll(() => getFeatureCount(app.page)).toBe(1)
  await expect(app.page.locator('.canvas-workflow-panel--join')).toHaveCount(0)
})

test('a new project lands on the sketch view with no empty-state card (issue #769)', async ({ app, ui }) => {
  const card = app.page.locator('.empty-state-card')

  // The blank document the app opens with still gets the first-run nudge.
  await expect(card).toBeVisible()

  await ui.toolbar.newProjectButton(app.page).click()
  const dialog = ui.newProjectDialog.root(app.page)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Create project' }).click()

  await expect(dialog).toHaveCount(0)

  // The nudge belongs to the boot document only. A project the user deliberately
  // created must land on the sketch view drawable, not behind the card.
  await expect(card).toHaveCount(0)
  await expect(app.page.locator('#workspace-panel-sketch')).toHaveClass(/centre-view--active/)
})

test('blank templates create projects with their entered stock dimensions (issue #809)', async ({ app, ui }) => {
  await ui.toolbar.newProjectButton(app.page).click()
  const dialog = ui.newProjectDialog.root(app.page)
  const stockInputWidth = await ui.newProjectDialog.stockDimension(app.page, 'width').evaluate(
    (input) => input.getBoundingClientRect().width,
  )

  expect(stockInputWidth).toBeGreaterThan(80)

  await ui.newProjectDialog.stockDimension(app.page, 'width').fill('254')
  await ui.newProjectDialog.stockDimension(app.page, 'height').fill('127')
  await ui.newProjectDialog.stockDimension(app.page, 'thickness').fill('19')
  await expect.poll(() =>
    ui.newProjectDialog.stockDimension(app.page, 'width').evaluate((input) => (input as HTMLInputElement).value),
  ).toBe('254')
  await dialog.getByRole('button', { name: 'Create project' }).click()

  const metricStock = (await getProject(app.page)).stock as { thickness: number }
  expect(metricStock.thickness).toBe(19)
  await expect(ui.statusBar.stockDimensions(app.page)).toContainText('254')
  await expect(ui.statusBar.stockDimensions(app.page)).toContainText('127')

  await ui.toolbar.newProjectButton(app.page).click()
  await ui.newProjectDialog.template(app.page, 'Blank imperial').click()
  await ui.newProjectDialog.stockDimension(app.page, 'width').fill('12')
  await ui.newProjectDialog.stockDimension(app.page, 'height').fill('8')
  await ui.newProjectDialog.stockDimension(app.page, 'thickness').fill('0.75')
  await dialog.getByRole('button', { name: 'Create project' }).click()

  const imperialStock = (await getProject(app.page)).stock as { thickness: number }
  expect(imperialStock.thickness).toBe(0.75)
  await expect(ui.statusBar.stockDimensions(app.page)).toContainText('12')
  await expect(ui.statusBar.stockDimensions(app.page)).toContainText('8')
})

test('stock summary opens editable Stock properties from pointer and keyboard (issue #809)', async ({ app, ui }) => {
  const stockDimensions = ui.statusBar.stockDimensions(app.page)

  await stockDimensions.click()
  await expect(ui.properties.panel(app.page)).toContainText('Width')
  await expect(ui.properties.panel(app.page)).toContainText('Thickness')

  await ui.tree.projectRow(app.page).click()
  await stockDimensions.focus()
  await app.page.keyboard.press('Enter')
  await expect(ui.properties.panel(app.page)).toContainText('Width')
  await expect(ui.properties.panel(app.page)).toContainText('Thickness')
})
