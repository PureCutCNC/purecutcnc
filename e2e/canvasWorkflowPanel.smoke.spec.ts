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
} from './helpers'
import { seedOverlapFeatureProject } from './overlapFeatureSelection.helpers'

const PANEL = '.canvas-workflow-panel--creation'

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
  await startJoinFeatures(app.page, ['f-overlap-1', 'f-overlap-2'])

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
