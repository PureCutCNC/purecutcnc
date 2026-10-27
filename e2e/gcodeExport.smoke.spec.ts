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
 *
 * #1119 adds the machine-template guard: the #1109 fixture's header with
 * `G90.1` is reported line by line, blocks the save with no file written, and
 * exports once the embedded copy is repaired.
 */

import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { getProject, seedProject } from './helpers'
import { openMachineManager } from './machineLibrary.helpers'
import type { Page } from '@playwright/test'

const ISSUE_1109_FIXTURE = new URL('../src/engine/test-fixtures/issue-1109-tab-ramp-original.camj', import.meta.url)

/**
 * The untouched #1109 snapshot with one change (#1119): its allowed `G91.1`
 * header line becomes the refused `G90.1`. The machine itself is the
 * reporter's Avid Mach4 post, unchanged.
 */
function issue1109WithAbsoluteArcCentres(): string {
  const project = JSON.parse(readFileSync(ISSUE_1109_FIXTURE, 'utf8')) as {
    meta: {
      selectedMachineId: string
      machineDefinitions: Array<{ id: string; program: { header: string[] } }>
    }
  }
  const machine = project.meta.machineDefinitions.find(
    (entry) => entry.id === project.meta.selectedMachineId,
  )
  if (!machine) throw new Error('#1109 fixture has no selected machine')
  machine.program.header[machine.program.header.length - 1] = 'G90.1'
  return JSON.stringify(project)
}

/**
 * Replace the platform's save entry point with a probe. Every export must call
 * it with an explicit `null` destination (issue #1081); a previous path is never
 * permission to overwrite. `success` and `cancel` answer immediately; `pending`
 * hands the test the resolver so it can open another document mid-save.
 */
async function installExportSaveProbe(
  page: Page,
  mode: 'success' | 'cancel' | 'pending',
): Promise<void> {
  await page.evaluate(async (probeMode) => {
    const module = await import('/src/platform/index.ts') as {
      platform: { saveTextFile: (...args: unknown[]) => Promise<string | null> }
    }
    const probe = window as unknown as {
      __exportSaveCalls: unknown[][]
      __resolveExportSave: ((path: string | null) => void) | null
    }
    probe.__exportSaveCalls = []
    probe.__resolveExportSave = null
    module.platform.saveTextFile = async (...args: unknown[]) => {
      probe.__exportSaveCalls.push(args)
      if (probeMode === 'cancel') return null
      if (probeMode === 'pending') {
        return await new Promise<string | null>((resolve) => {
          probe.__resolveExportSave = resolve
        })
      }
      return '/tmp/e2e-export.nc'
    }
  }, mode)
}

async function exportSaveCalls(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => {
    const probe = window as unknown as { __exportSaveCalls?: unknown[][] }
    return probe.__exportSaveCalls ?? []
  })
}

async function lastExportPath(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const module = await import('/src/store/projectStore.ts') as {
      useProjectStore: { getState: () => { lastExportPath: string | null } }
    }
    return module.useProjectStore.getState().lastExportPath
  })
}

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


test('a machine that still breaks a template rule blocks export with zero writes until repaired', async ({ app, ui }) => {
  // The reporter's 0.5.x Avid post with G90.1 in its header: structurally
  // valid, refused by the #1057 program-header rule (#1119).
  let alertMessage = ''
  app.page.on('dialog', async (dialog) => {
    alertMessage = dialog.message()
    await dialog.accept()
  })
  await seedProject(app.page, issue1109WithAbsoluteArcCentres())
  await expect.poll(() => alertMessage).toContain('export is blocked')
  expect(alertMessage).toContain('Avid Mach4')

  await installExportSaveProbe(app.page, 'success')
  await ui.operations.headerExportButton(app.page).click()
  const dialog = ui.exportDialog.root(app.page)
  await expect(dialog).toBeVisible()

  // The dialog shows the same line-level diagnostics the manager does.
  const diagnostics = ui.exportDialog.machineDiagnostics(app.page)
  await expect(diagnostics).toContainText('program.header')
  await expect(diagnostics).toContainText('G90.1')
  await expect(ui.exportDialog.exportButton(app.page)).toBeDisabled()

  // Nothing is written while the machine is blocked: the probe was never
  // called and the preparation never reached a program.
  expect(await exportSaveCalls(app.page)).toHaveLength(0)
  await expect(ui.exportPreview.body(app.page)).not.toContainText('G90.1')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()

  // Repair the project's embedded copy and apply it explicitly. The selected
  // custom machine is also rescued into My Machines, so the library and the
  // project each have a row with this name; the project row is last.
  await openMachineManager(app.page, ui)
  await expect(ui.machineManager.groupLabel(app.page, 'In this project')).toBeVisible()
  await ui.machineManager.item(app.page, 'Avid Mach4 (inch, shop)').last().click()
  await expect(ui.machineManager.diagnostics(app.page)).toContainText('G90.1')
  await ui.machineManager.editButton(app.page).click()
  const editor = ui.machineEditor.dialog(app.page)
  await expect(editor).toBeVisible()
  await expect(ui.machineEditor.diagnostics(app.page)).toContainText('G90.1')
  const header = ui.machineEditor.field(app.page, 'Header')
  // Restore the relative-arc-centre word the fixture originally had.
  const repairedHeader = (await header.inputValue())
    .split('\n')
    .map((line) => (line.trim() === 'G90.1' ? 'G91.1' : line))
    .join('\n')
  await header.fill(repairedHeader)
  await expect(ui.machineEditor.diagnostics(app.page)).toHaveCount(0)
  await ui.machineEditor.saveButton(app.page).click()
  await expect(editor).toBeHidden()
  // The library's rescued copy was not touched by the project repair.
  await expect(ui.machineManager.item(app.page, 'Avid Mach4 (inch, shop)').first()).toContainText('Export blocked')
  await ui.machineManager.doneButton(app.page).click()

  // The repaired machine exports: the same dialog now has no machine
  // diagnostics and the save is attempted exactly once with real G-code.
  await ui.operations.headerExportButton(app.page).click()
  await expect(dialog).toBeVisible()
  await expect(ui.exportDialog.machineDiagnostics(app.page)).toHaveCount(0)
  await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
  await ui.exportDialog.exportButton(app.page).click()
  await expect(dialog).toBeHidden()
  const calls = await exportSaveCalls(app.page)
  expect(calls).toHaveLength(1)
  expect(String(calls[0][1])).toContain('M30')
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

// #983 feed repair: the G-code plasma drop feed is a rendered tool control, and
// an unconfigured one blocks the export instead of writing F0.
test('Grbl plasma blocks the export while the drop feed is unconfigured', async ({ app, ui }) => {
  await seedGcodeExportProject(app.page, { machineId: 'grbl-plasma', plasmaCut: { materialNumber: null, plungeFeed: 0 } })
  await ui.operations.headerExportButton(app.page).click()
  await expect(ui.exportDialog.errors(app.page).filter({ hasText: 'Plasma Cut' })).toContainText('no positive plunge feed')
  await expect(ui.exportDialog.exportButton(app.page)).toBeDisabled()
})

test('the plasma drop feed control configures the exported feed', async ({ app, ui }) => {
  await seedGcodeExportProject(app.page, { machineId: 'grbl-plasma', plasmaCut: { materialNumber: null, plungeFeed: 0 } })

  // The tool panel renders the drop feed as "Plunge feed", with no unit in the
  // label, and editing it writes the tool's plunge feed.
  await app.page.getByRole('tab', { name: 'Tools' }).click()
  await app.page.locator('.cam-tool-tree .tree-row--feature').filter({ hasText: 'Plasma Torch' }).click()
  const dropFeed = app.page.locator('.cam-tool-properties .properties-field').filter({ hasText: 'Plunge feed' })
  await expect(dropFeed.locator('span').first()).toHaveText('Plunge feed')
  const input = dropFeed.locator('input')
  await input.fill('200')
  await input.press('Enter')

  const project = await getProject(app.page)
  const torch = (project.tools as Array<{ name: string; defaultPlungeFeed: number }>)
    .find((tool) => tool.name === 'Plasma Torch')
  expect(torch?.defaultPlungeFeed).toBe(200)

  // The configured drop feed unblocks the export and reaches the program.
  await app.page.getByRole('tab', { name: 'Operations' }).click()
  await ui.operations.headerExportButton(app.page).click()
  await expect(ui.exportDialog.errors(app.page)).toHaveCount(0)
  await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
  // The drop line (not the contour feed) now carries the configured value.
  await expect(ui.exportPreview.body(app.page)).toContainText(/G1 Z[\d.]+ F200\.0+/)
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
test.describe('Export G-code destination smoke (#1081)', () => {
  test('every export asks for a destination, even after a successful export', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)
    await installExportSaveProbe(app.page, 'success')

    const dialog = ui.exportDialog.root(app.page)

    await ui.operations.headerExportButton(app.page).click()
    await expect(dialog).toBeVisible()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
    await ui.exportDialog.exportButton(app.page).click()
    await expect(dialog).toBeHidden()

    let calls = await exportSaveCalls(app.page)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(4)
    expect(calls[0]?.[3]).toBeNull()
    const firstSuggestedName = calls[0]?.[0]

    // Same document and same remembered export path, but a rename and a
    // changed operation selection alter the suggested name. It must still ask.
    await app.page.evaluate(async () => {
      const module = await import('/src/store/projectStore.ts') as {
        useProjectStore: { getState: () => { setProjectName: (name: string) => void } }
      }
      module.useProjectStore.getState().setProjectName('Renamed Part')
    })

    await ui.operations.headerExportButton(app.page).click()
    await expect(dialog).toBeVisible()
    await ui.exportDialog.operationCheckbox(app.page, 'Route B').uncheck()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
    await ui.exportDialog.exportButton(app.page).click()
    await expect(dialog).toBeHidden()

    calls = await exportSaveCalls(app.page)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toHaveLength(4)
    expect(calls[1]?.[3]).toBeNull()
    expect(calls[1]?.[0]).not.toBe(firstSuggestedName)
    expect(calls[1]?.[0]).toContain('Renamed_Part')
  })

  test('cancelling the destination neither closes the dialog nor marks an export', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)
    await installExportSaveProbe(app.page, 'cancel')

    const dialog = ui.exportDialog.root(app.page)
    await ui.operations.headerExportButton(app.page).click()
    await expect(dialog).toBeVisible()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()

    await ui.exportDialog.exportButton(app.page).click()
    await expect.poll(async () => (await exportSaveCalls(app.page)).length).toBe(1)

    const calls = await exportSaveCalls(app.page)
    expect(calls[0]).toHaveLength(4)
    expect(calls[0]?.[3]).toBeNull()
    await expect(dialog).toBeVisible()
    expect(await lastExportPath(app.page)).toBeNull()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
  })

  test('a destination chosen during an in-flight save is not attributed to a switched document', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)
    await installExportSaveProbe(app.page, 'pending')

    const dialog = ui.exportDialog.root(app.page)
    await ui.operations.headerExportButton(app.page).click()
    await expect(dialog).toBeVisible()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()

    await ui.exportDialog.exportButton(app.page).click()
    await expect.poll(async () => (await exportSaveCalls(app.page)).length).toBe(1)
    await expect(dialog).toBeVisible()

    // Swap documents while the platform save promise is still open.
    await app.page.evaluate(async () => {
      const w = window as unknown as {
        __pcTest: { getProject: () => Promise<Record<string, unknown>>; loadProject: (json: string) => Promise<void> }
      }
      const project = await w.__pcTest.getProject()
      const meta = project.meta as Record<string, unknown>
      project.meta = { ...meta, name: 'Switched project' }
      await w.__pcTest.loadProject(JSON.stringify(project))
    })
    await expect(dialog).toBeVisible()

    await app.page.evaluate(() => {
      const probe = window as unknown as { __resolveExportSave?: ((path: string | null) => void) | null }
      probe.__resolveExportSave?.('/tmp/previous-project.nc')
    })

    // The async document-identity check closes the dialog without marking the
    // switched project exported (issue #675) and without clearing the marker
    // the switch already reset.
    await expect(dialog).toBeHidden()
    expect(await lastExportPath(app.page)).toBeNull()
  })
})
