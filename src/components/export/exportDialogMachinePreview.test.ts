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
 * The Export G-code dialog as the operator saw it (issue #1112 item 35).
 *
 * The report read: the dialog's header names a machine, the preview pane says
 * "Select a machine in project settings to generate G-code preview", and
 * nothing exports. The first two were true at the same time, and that is the
 * bug: the header and the export both read `getActiveMachineDefinition`, so a
 * named machine is proof the resolver returned a definition — no function ever
 * returned "no machine". The pane's sentence was a single fallback rendered for
 * **every** state without a program, which includes the dialog's own first
 * frame: `useExportPreparation` starts at `preparation === null` and only
 * prepares after a 300 ms debounce, plus however long generation takes.
 *
 * This suite renders that real dialog — the real component, the reporter's
 * machine data, the real generation service (no injected failure) — and holds
 * the two things the report could not both be:
 *
 *  - while the header names the machine, the pane never tells the operator to
 *    select one; before the first preparation settles it says it is preparing;
 *  - once generation settles, the program is on screen and Export is enabled,
 *    so "nothing exports" was never true of this project.
 *
 * It also renders the permanent form of the same lie: with every toolpath
 * hidden the default checklist is empty (the tick follows the display toggle;
 * four of the saved file's six operations have it off), the preparation blocks
 * on `no-operations`, and the pane must say that rather than "select a machine".
 *
 * Mutations checked one at a time:
 *  - the pane's fallback put back to `previewPlaceholder` → the first-frame and
 *    the blocked assertions fail with "Select a machine…" on screen;
 *  - `machineState` forced to `'none'` → the pane says "select a machine" while
 *    the header names one;
 *  - the `no-operations` branch dropped from `exportPreviewMessageKey` → the
 *    blocked state reads as "blocked, see the errors" instead of naming the
 *    empty selection;
 *  - `hasPreview` forced true → the first frame claims a program it has not
 *    got.
 *
 * Run with: npx tsx src/components/export/exportDialogMachinePreview.test.ts
 */

import * as React from 'react'
import { createElement } from 'react'
import { parseHTML } from 'linkedom'

const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
if (typeof globals.navigator === 'undefined') {
  globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
}
;(window as unknown as { matchMedia: (query: string) => unknown }).matchMedia = () => ({
  matches: false,
  media: '',
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
;(globalThis as unknown as { React?: typeof React }).React = React

const { ExportDialog } = await import('./ExportDialog')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { translate } = await import('../../i18n/store')
const { useProjectStore } = await import('../../store/projectStore')
const { createToolpathGenerationService } = await import('../../app/toolpathGeneration/service')
const { reportedGrblCopy, reportedRotaryProject } = await import('../../test/reportedRotaryMachines')
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
import type { Project } from '../../types/project'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(fn).then(
    () => { passed += 1; console.log(`   \u2713 ${name}`) },
    (error: unknown) => {
      failed += 1
      console.log(`   \u2717 ${name}: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** The catalog's sentence for a key — the pane renders the same string. */
function message(key: Parameters<typeof translate>[0]): string {
  return translate(key)
}

/** The sentence that made the report: the pane must never show it for a resolved machine. */
const SELECT_A_MACHINE = message('dialogs.export.previewPlaceholder')

interface MountedDialog {
  host: HTMLElement
  /** Resolves once `predicate` sees the document the dialog has rendered. */
  waitFor: (predicate: () => boolean, what: string) => Promise<void>
  unmount: () => void
}

/**
 * Mount the real dialog on `project`, with the real generation service. The
 * project goes into the store first because the dialog reads it from there —
 * that is the wiring the app uses, not a prop.
 */
function mount(project: Project): MountedDialog {
  useProjectStore.setState({ project })
  const context = { project, documentKey: 1 }
  const service = createToolpathGenerationService({ getCurrentContext: () => context, executor: 'inline' })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(createElement(I18nProvider, null, createElement(ExportDialog, {
    onClose: () => {},
    service,
    contextRef: { current: context },
    requestGenerationTrace: async () => null,
  }))))
  return {
    host,
    // Real timers, so the debounce and generation run as they do in the app;
    // the deadline only stops a hang from becoming a hung test, and is generous
    // because the suite runs many files at once.
    waitFor: async (predicate, what) => {
      const deadline = Date.now() + 30_000
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    },
    unmount: () => { flushSync(() => root.unmount()); host.remove() },
  }
}

function text(root: ParentNode, selector: string): string {
  return root.querySelector(selector)?.textContent?.trim() ?? ''
}

/** Ticked checkboxes in the operation checklist (the options area has two of its own). */
function checkedOperations(root: ParentNode): number {
  return [...root.querySelectorAll('.export-operation-list input[type="checkbox"]')]
    .filter((input) => (input as HTMLInputElement).checked)
    .length
}

const REPORTED = reportedGrblCopy()
const DISPLAYED_OPS = 2

await test('the dialog names the project\'s machine and never tells that operator to select one', async () => {
  const project = reportedRotaryProject(REPORTED, REPORTED.id, DISPLAYED_OPS)
  const dialog = mount(project)
  try {
    // The header half of the report: the machine is resolved and named.
    assert(
      text(dialog.host, '[data-testid="export-machine-name"]') === REPORTED.name,
      `the machine row names ${REPORTED.name}, not "${text(dialog.host, '[data-testid="export-machine-name"]')}"`,
    )

    // The pane half. This is the dialog's first frame: the preparation has not
    // started, which is exactly the state the old fallback turned into
    // "Select a machine in project settings" while the header said otherwise.
    const firstFrame = text(dialog.host, '.dialog-preview')
    assert(
      firstFrame === message('dialogs.export.previewPreparing'),
      `the pane says it is preparing, not "${firstFrame}"`,
    )
    assert(!firstFrame.includes(SELECT_A_MACHINE), 'and never the "select a machine" sentence')

    // The operations the saved project has displayed are ticked on open.
    assert(
      checkedOperations(dialog.host) === DISPLAYED_OPS,
      `the dialog opens with the project's ${DISPLAYED_OPS} displayed operations ticked (saw ${checkedOperations(dialog.host)})`,
    )

    await dialog.waitFor(
      () => text(dialog.host, '.dialog-preview').includes('G20'),
      'the program the real service posts',
    )

    // The whole reason the report's two observations could not both be true:
    // with this project and this machine the program arrives, and Save is live.
    const preview = text(dialog.host, '.dialog-preview')
    assert(preview.includes('G20'), `the pane shows the inch program (saw ${JSON.stringify(preview.slice(0, 80))})`)
    assert(!preview.includes(SELECT_A_MACHINE), 'the sentence is gone once the program lands')
    assert(
      text(dialog.host, '.export-preview-summary').length > 0,
      'and the dialog reports the program it previews (its moves and lines)',
    )
    assert(
      text(dialog.host, '[data-testid="export-machine-name"]') === REPORTED.name,
      'the machine row still names the machine it exported for',
    )
    assert(
      dialog.host.querySelectorAll('.export-error').length === 0,
      'nothing is refused: the errors list is empty',
    )
    const exportButton = dialog.host.querySelector('.dialog-footer .btn-primary') as HTMLButtonElement | null
    assert(exportButton, 'the dialog has its Export button')
    assert(!exportButton.disabled, 'and it is enabled, so this project exports')
  } finally {
    dialog.unmount()
  }
})

await test('an empty default checklist is named as that, never as a missing machine', async () => {
  // The permanent form of the reported pair, one toggle away in the saved file:
  // four of its six operations have the toolpath display off, and the checkbox
  // default follows the display. The machine is still named and still resolves.
  const displayed = reportedRotaryProject(REPORTED, REPORTED.id, DISPLAYED_OPS)
  const project: Project = {
    ...displayed,
    operations: displayed.operations.map((operation) => ({ ...operation, showToolpath: false })),
  }
  const dialog = mount(project)
  try {
    assert(
      text(dialog.host, '[data-testid="export-machine-name"]') === REPORTED.name,
      'the machine is resolved and named, as in the report',
    )
    assert(checkedOperations(dialog.host) === 0, 'and nothing is ticked, because no toolpath is displayed')

    await dialog.waitFor(
      () => text(dialog.host, '.dialog-preview') === message('dialogs.export.previewNoOperations'),
      'the blocked preparation',
    )

    const preview = text(dialog.host, '.dialog-preview')
    assert(preview === message('dialogs.export.previewNoOperations'), 'the pane names the empty selection')
    assert(!preview.includes(SELECT_A_MACHINE), 'and never the machine sentence')
    assert(
      [...dialog.host.querySelectorAll('.export-error')]
        .some((error) => error.textContent?.includes(message('dialogs.export.warning.noOperations'))),
      'the Errors list says which selection to make',
    )
    const exportButton = dialog.host.querySelector('.dialog-footer .btn-primary') as HTMLButtonElement | null
    assert(exportButton, 'the dialog has its Export button')
    assert(exportButton.disabled, 'and it is disabled, because nothing is ticked')
  } finally {
    dialog.unmount()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
