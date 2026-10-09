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
 * Export G-code dialog smoke: the operation checklist (issue #274) and the
 * error tier (issue #755).
 *
 * Covers the per-operation entry point (the Properties-header action
 * pre-checks only the selected operation), the default set from the header
 * Export button, the disabled state when nothing is checked, and a program
 * that changes tool with M6 off — reported as an error that blocks the export,
 * where a program whose operations share one tool is not.
 */

import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'

test.describe('Export G-code operation checklist smoke', () => {
  test('per-operation export pre-checks only that operation', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)

    // Selecting an operation row points the Properties-header export action at it.
    await ui.operations.rowByName(app.page, 'Route B').click()
    await ui.operations.propertiesExportButton(app.page, 'Route B').click()

    const dialog = ui.exportDialog.root(app.page)
    await expect(dialog).toBeVisible()
    await expect(ui.exportDialog.operationOptions(app.page)).toHaveCount(2)
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route A')).not.toBeChecked()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route B')).toBeChecked()

    // The GRBL machine is active, so the scoped preview enables Export.
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()

    // Unchecking the last operation disables Export and explains why.
    await ui.exportDialog.operationCheckbox(app.page, 'Route B').uncheck()
    await expect(ui.exportDialog.exportButton(app.page)).toBeDisabled()
    await expect(ui.exportDialog.errors(app.page).filter({
      hasText: 'No operations selected',
    })).toBeVisible()

    // Re-checking the other operation re-enables Export.
    await ui.exportDialog.operationCheckbox(app.page, 'Route A').check()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
  })

  test('header export pre-checks the whole visible set', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)

    await ui.operations.headerExportButton(app.page).click()

    await expect(ui.exportDialog.root(app.page)).toBeVisible()
    await expect(ui.exportDialog.title(app.page)).toHaveText('Export G-code')
    await expect(ui.exportDialog.root(app.page)).toContainText('Emit tool changes (M6)')
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route A')).toBeChecked()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route B')).toBeChecked()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()

    // The header toggle flips the whole selection: Deselect all → Select all.
    const toggle = ui.exportDialog.selectionToggle(app.page)
    await expect(toggle).toHaveText('Deselect all')
    await toggle.click()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route A')).not.toBeChecked()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route B')).not.toBeChecked()
    await expect(ui.exportDialog.exportButton(app.page)).toBeDisabled()
    await expect(toggle).toHaveText('Select all')
    await toggle.click()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route A')).toBeChecked()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route B')).toBeChecked()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
  })

  test('one tool across the program with tool changes off stays clean', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)
    await ui.operations.headerExportButton(app.page).click()

    // A ready program reports its total line count; the dialog shows nothing
    // while a preparation is in flight, which reads as 0 here.
    const reportedLines = async (): Promise<number> => {
      const summary = ui.exportPreview.summary(app.page)
      if (await summary.count() === 0) return 0
      const match = /(\d+) lines total/.exec((await summary.textContent()) ?? '')
      return match ? Number(match[1]) : 0
    }

    await expect.poll(reportedLines).toBeGreaterThan(0)
    const withToolChanges = await reportedLines()

    await ui.exportDialog.emitToolChanges(app.page).uncheck()

    // Rebuilding the program takes a debounce, and the change commands it drops
    // (with the spindle restart for the next operation) sit past the 30-line
    // preview, so the reported line count falling is the only whole-program
    // signal available. It has to fall *to a ready program*: the dialog reports
    // no count at all while a preparation is in flight, and "0 < before" would
    // otherwise let the assertions below describe that empty state rather than
    // the rebuilt program. Both routes share a tool, so nothing was left
    // unexecuted and there is no error.
    await expect.poll(async () => {
      const lines = await reportedLines()
      return lines > 0 && lines < withToolChanges
    }).toBe(true)
    await expect(ui.exportDialog.errors(app.page)).toHaveCount(0)
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
  })

  test('a real tool change with tool changes off blocks the export', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page, { routeBOnSecondTool: true })
    await ui.operations.headerExportButton(app.page).click()

    await ui.exportDialog.emitToolChanges(app.page).uncheck()

    // Route B would run with Route A's tool and nothing in the program pauses
    // the machine for a change, so this blocks the export rather than noting it.
    await expect(ui.exportDialog.errors(app.page).filter({ hasText: 'Route B' })).toBeVisible()
    await expect(ui.exportDialog.exportButton(app.page)).toBeDisabled()

    // Emitting the change is the fix the message asks for, and it clears the
    // error once the rebuilt program lands.
    await ui.exportDialog.emitToolChanges(app.page).check()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
    await expect(ui.exportDialog.errors(app.page)).toHaveCount(0)
  })

  test('the ShopBot machine exports a ShopBot part file, not G-code', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page, { machineId: 'shopbot' })
    await ui.operations.headerExportButton(app.page).click()

    // The dialog names what this machine exports, and the command its tool
    // change writes, rather than G-code and M6.
    await expect(ui.exportDialog.title(app.page)).toHaveText('Export ShopBot part file')
    await expect(ui.exportDialog.root(app.page)).toContainText('Emit tool changes (C9)')
    await expect(ui.exportDialog.root(app.page)).not.toContainText('(M6)')

    // The file the button saves is a .sbp.
    await expect(ui.exportDialog.exportButton(app.page)).toContainText('.sbp')
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
    await expect(ui.exportDialog.errors(app.page)).toHaveCount(0)

    // The preview is the program that will be saved (issue #953): the fixture
    // is in inches, so the units guard refuses a control set to millimetres,
    // speeds are per second (60 and 30 in/min), and motion is jogs and moves.
    const preview = ui.exportPreview.body(app.page)
    await expect(preview).toContainText('IF %(25)=1 THEN GOTO UNIT_ERROR')
    await expect(preview).toContainText('SA')
    await expect(preview).toContainText('&Tool=1')
    await expect(preview).toContainText('C9')
    await expect(preview).toContainText('TR,18000')
    await expect(preview).toContainText('C6')
    await expect(preview).toContainText('MS,1.0000,0.5000')
    await expect(preview).toContainText(/^M3,-?[\d.]+,-?[\d.]+,-?[\d.]+$/m)
    await expect(preview).not.toContainText(/^(G0|G1|G21|G20|M30)\b/m)
  })
})


test('QtPlasmaC export writes the torch path and leaves milling operations out', async ({ app, ui }) => {
  await seedGcodeExportProject(app.page, { machineId: 'qtplasmac', plasmaCut: { materialNumber: 1 } })
  await ui.operations.headerExportButton(app.page).click()
  const warnings = ui.exportDialog.warnings(app.page)
  const preview = ui.exportPreview.body(app.page)
  await expect(warnings.filter({ hasText: 'Route A' })).toContainText('is not a plasma cut')
  await expect(warnings.filter({ hasText: 'The torch will not fire' })).toHaveCount(0)
  for (const line of ['#<holes> = 1', 'M190 P1', 'M66 P3 L3 Q1', 'F#<_hal[plasmac.cut-feed-rate]>', 'M3 $0 S1', 'M5 $0']) {
    await expect(preview).toContainText(line)
  }
  await expect(preview).not.toContainText(/\bZ-?[\d.]/)
  await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
  await ui.exportDialog.operationCheckbox(app.page, 'Route A').uncheck()
  await expect(warnings.filter({ hasText: 'Route A' })).toHaveCount(0)
})

test('a QtPlasmaC torch without a material number blocks the export', async ({ app, ui }) => {
  await seedGcodeExportProject(app.page, { machineId: 'qtplasmac', plasmaCut: { materialNumber: null } })
  await ui.operations.headerExportButton(app.page).click()
  await expect(ui.exportDialog.errors(app.page).filter({ hasText: 'Plasma Torch' })).toContainText('no material number')
  await expect(ui.exportDialog.exportButton(app.page)).toBeDisabled()
  await expect(ui.exportPreview.body(app.page)).not.toContainText('M190')
})

// #959 / PR #993: long preview lines must scroll inside their own column,
// while blocking errors remain readable inside the export dialog.
for (const layout of [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, hasTouch: false },
  { name: 'landscape tablet', viewport: { width: 1024, height: 768 }, hasTouch: true },
]) {
  test.describe(`export layout ${layout.name}`, () => {
    test.use({ viewport: layout.viewport, hasTouch: layout.hasTouch })

    test('long QtPlasmaC errors and preview stay inside the dialog', async ({ app, ui }, testInfo) => {
      const { page } = app
      const toolName = `Powermax45 XP 45 A — 2 mm mild steel (example) — inch units — PMX45-${'X'.repeat(80)}`
      await seedGcodeExportProject(page, { machineId: 'qtplasmac', plasmaCut: { materialNumber: null, toolName } })
      const trigger = ui.operations.headerExportButton(page)
      if (layout.hasTouch) await ui.operations.openPanelButton(page).click()
      await trigger.click()
      const dialog = ui.exportDialog.root(page)
      const error = ui.exportDialog.errors(page).filter({ hasText: toolName })
      const preview = ui.exportPreview.body(page)
      await expect(error).toContainText('no material number')
      await expect(preview).toContainText(`PMX45-${'X'.repeat(80)}`)
      await expect(ui.exportDialog.exportButton(page)).toBeDisabled()
      await expect(preview).not.toContainText('M190')
      await dialog.screenshot({ path: testInfo.outputPath('export-layout.png') })

      const geometry = await preview.evaluate((element) => {
        const column = element.parentElement!
        const body = column.parentElement!
        const root = body.parentElement!
        const bounds = (node: Element) => {
          const rect = node.getBoundingClientRect()
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        }
        return { root: bounds(root), body: bounds(body), column: bounds(column), preview: bounds(element),
          bodyScrollWidth: body.scrollWidth, bodyClientWidth: body.clientWidth,
          previewScrollWidth: element.scrollWidth, previewClientWidth: element.clientWidth }
      })
      expect(geometry.root.left).toBeGreaterThanOrEqual(0)
      expect(geometry.root.right).toBeLessThanOrEqual(layout.viewport.width)
      expect(geometry.column.right).toBeLessThanOrEqual(geometry.body.right + 1)
      expect(geometry.preview.left).toBeGreaterThanOrEqual(geometry.body.left)
      expect(geometry.preview.right).toBeLessThanOrEqual(geometry.body.right + 1)
      expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.bodyClientWidth + 1)

      const message = await error.evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const bounds = element.getBoundingClientRect()
        return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
          left: bounds.left, right: bounds.right,
          lines: Array.from(range.getClientRects(), rect => ({ left: rect.left, right: rect.right })) }
      })
      expect(message.right).toBeLessThanOrEqual(geometry.body.right + 1)
      expect(message.scrollWidth).toBeLessThanOrEqual(message.clientWidth + 1)
      for (const line of message.lines) {
        expect(line.left).toBeGreaterThanOrEqual(message.left)
        expect(line.right).toBeLessThanOrEqual(message.right + 1)
      }
      // G-code retains its exact lines: horizontal scrolling belongs to the preview.
      expect(geometry.previewScrollWidth).toBeGreaterThan(geometry.previewClientWidth)
      expect(await preview.evaluate(element => { element.scrollLeft = element.scrollWidth; return element.scrollLeft })).toBeGreaterThan(0)
      await expect(ui.exportDialog.exportButton(page)).toBeVisible()
      const button = await ui.exportDialog.exportButton(page).boundingBox()
      expect(button!.x + button!.width).toBeLessThanOrEqual(layout.viewport.width)
      expect(button!.y + button!.height).toBeLessThanOrEqual(layout.viewport.height)
    })
  })
}
