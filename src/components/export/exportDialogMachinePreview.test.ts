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
 * The last test opens the exported-motion debug view from the same real
 * project (issue #1179 correction round 3): that project's only operation is a
 * rotary rough, whose Z changes on every move, so the plan view's eligibility
 * refused it and the "Inspect exported motion" button was missing for the
 * operation the 3D wrapped view exists for.
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
 *    got;
 *  - the Inspect gate put back to the plan view's eligibility alone → the
 *    rotary-rough test finds no button;
 *  - the cutting-level selector shown again for variable-Z motion → the debug
 *    assertions find the level list and the per-level rows;
 *  - the wrapped view's WebGL fallback put back to the plan sentence → the
 *    rotary-rough test catches it promising a 2D plan this path never builds
 *    (correction round 4).
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
// The debug dialog's wrapped view measures its host; there is no layout here,
// so an observer that never fires is enough for it to mount.
globals.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { React?: typeof React }).React = React

const { ExportDialog } = await import('./ExportDialog')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { ThemeContext } = await import('../../theme/themeContext')
type ThemeContextValue = import('../../theme/themeContext').ThemeContextValue
const { translate } = await import('../../i18n/store')
const { useProjectStore } = await import('../../store/projectStore')
const { createToolpathGenerationService } = await import('../../app/toolpathGeneration/service')
const { reportedGrblCopy, reportedRotaryProject } = await import('../../test/reportedRotaryMachines')
const { validateMachineDefinition } = await import('../../engine/gcode/types')
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
import type { Project } from '../../types/project'

/**
 * The scene palette the debug dialog's wrapped view reads. Only the two colours
 * matter here; the view never draws in this environment (there is no WebGL2),
 * but it still mounts and reports its state.
 */
const THEME = {
  palette: { three: { background: '#000000', stockDefault: '#888888' } },
} as unknown as ThemeContextValue

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
  const root = createRoot(host, { onUncaughtError: (error) => console.error('[uncaught]', error) })
  // The debug dialog asks for a trace the same way the app does (purpose
  // `debug`, trace requested). The tests that never open it are unaffected.
  const requestGenerationTrace = async (operationId: string, signal?: AbortSignal) => {
    const outcome = await service.request(context, operationId, { purpose: 'debug', trace: true, signal })
    return outcome.status === 'completed' && outcome.raw
      ? { operationId, raw: outcome.raw, optimized: outcome.result }
      : null
  }
  flushSync(() => root.render(createElement(I18nProvider, null,
    createElement(ThemeContext.Provider, { value: THEME },
      createElement(ExportDialog, {
        onClose: () => {},
        service,
        contextRef: { current: context },
        requestGenerationTrace,
      }),
    ),
  )))
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

await test('a rotary program on a machine with no Zero A line warns that A must be zeroed', async () => {
  // #1103 slice ca-h: the operation ends at 0 up and the program pauses between
  // rotary operations, so this line is the only place the operator is told to
  // start with A zeroed at 0 up.
  const project = reportedRotaryProject(REPORTED, REPORTED.id, DISPLAYED_OPS)
  const dialog = mount(project)
  try {
    await dialog.waitFor(() => text(dialog.host, '.dialog-preview').includes('G20'), 'the program')
    const notice = text(dialog.host, '[data-testid="export-rotary-zero-notice"]')
    assert(notice === message('dialogs.export.rotaryZeroNotice'),
      `the dialog shows the rotary-zeroing note, got ${JSON.stringify(notice)}`)
  } finally {
    dialog.unmount()
  }
})

await test('a machine that zeroes A itself shows no rotary-zeroing note', async () => {
  assert(REPORTED.rotary !== undefined, 'fixture: the reported machine has a rotary block')
  const zeroing = validateMachineDefinition({
    ...structuredClone(REPORTED),
    // The reported GRBL program names no work coordinate system, so only the
    // active-system form proves which offset the line zeroes (#1152 correction
    // round 2, finding 2).
    rotary: { ...structuredClone(REPORTED.rotary!), zeroA: 'G10 L20 P0 A0' },
  })
  const project = reportedRotaryProject(zeroing, zeroing.id, DISPLAYED_OPS)
  const dialog = mount(project)
  try {
    await dialog.waitFor(() => text(dialog.host, '.dialog-preview').includes('G20'), 'the program')
    assert(text(dialog.host, '[data-testid="export-rotary-zero-notice"]') === '',
      'the note is absent when the machine carries a Zero A line')
  } finally {
    dialog.unmount()
  }
})

/** Dispatch a click, the way a pointer press reaches React's root. */
function click(element: Element): void {
  // linkedom's window has no MouseEvent; its HTMLElement.click() dispatches the
  // bubbling click React listens for.
  ;(element as unknown as { click: () => void }).click()
}

/**
 * The Inspect motion button is reachable for the operation the 3D wrapped view
 * exists for (issue #1179 correction round 3).
 *
 * The fixture's only operation is a rotary rough, so its cutting Z changes on
 * every move. The plan view's eligibility refuses that, and the dialog used it
 * for the button — which is why Frank's real bolt file, with only a Rotary
 * rough ticked, offered no way into the wrapped view at all. The button is now
 * offered from the motion carrying angles, and the dialog lands on 3D.
 */
await test('a variable-Z rotary rough opens the debug view on the wrapped 3D scene', async () => {
  const project = reportedRotaryProject(REPORTED, REPORTED.id, 1)
  const dialog = mount(project)
  try {
    await dialog.waitFor(() => text(dialog.host, '.dialog-preview').includes('G20'), 'the program')
    const inspect = [...dialog.host.querySelectorAll('.dialog-footer button')]
      .find((button) => button.textContent?.includes(message('dialogs.export.inspectMotion')))
    assert(inspect, 'the dialog offers "Inspect exported motion" for a variable-Z rotary rough')
    click(inspect)

    await dialog.waitFor(
      () => dialog.host.querySelector('[data-testid="motion-debug-3d"]') !== null,
      'the wrapped 3D scene',
    )
    assert(
      dialog.host.querySelector('.dialog--motion-debug .motion-debug__svg') === null,
      'the dialog lands on the wrapped view, not the flat plan',
    )
    // The plan model is a per-level comparison that costs seconds on this path
    // and cannot offer a level, so the plan view is not offered at all — the
    // wrapped scene is the view, not a mode of one.
    assert(
      dialog.host.querySelector('.motion-debug__view-toggle') === null,
      'the plan view is not offered for a path with a level per move',
    )

    // The angle readout names the program's A span — the thing the flat plan
    // could never show.
    await dialog.waitFor(
      () => /A range: -?[\d.]+° … -?[\d.]+°/.test(text(dialog.host, '.motion-debug__angle-readout')),
      'the A range readout',
    )

    // A level selector would list one entry per move's Z (hundreds) and the
    // per-level table one row per level, so neither is offered for this path;
    // it draws every cut and says so instead.
    assert(
      dialog.host.querySelector('[data-testid="motion-debug-level"]') === null,
      'no cutting-level selector for a path whose Z changes every move',
    )
    assert(
      dialog.host.querySelector('[data-testid="motion-debug-per-level"]') === null,
      'and no per-level table',
    )
    assert(
      text(dialog.host, '[data-testid="motion-debug-variable-z-note"]')
        .includes(message('dialogs.motionDebug.variableZAllLevels')),
      'the sidebar explains why every cut is drawn',
    )

    // Metrics that do not assume one level still report the program.
    const sidebar = text(dialog.host, '.motion-debug__sidebar')
    assert(sidebar.includes(message('dialogs.motionDebug.optimizedMoves')), 'the optimized move count stays')
    assert(!sidebar.includes('—'), 'and it is filled in, not left as a placeholder')
    // The rotary generator reports no separate raw path, so the dialog neither
    // claims one in the layer list nor reports the prepared path twice under
    // two names.
    assert(!sidebar.includes(message('dialogs.motionDebug.layerGenerated')),
      'no "Generated (raw)" layer is offered for a path with no raw trace')
    assert(!sidebar.includes(`${message('dialogs.motionDebug.rawMoves')}:`),
      'and no raw move count is shown for it')

    // The dialog never tells this operator their rotary rough cannot be shown.
    assert(
      !dialog.host.textContent?.includes(message('dialogs.motionDebug.ineligibleVariableZ')),
      'the variable-Z refusal sentence is not shown for the rotary operation it refused',
    )
    // No comparison is run for the wrapped-only path, so no verdict is claimed
    // either way (the sidebar says why instead).
    assert(
      dialog.host.querySelector('.motion-debug__diagnostic') === null,
      'no exported-vs-source verdict is claimed for a path never compared',
    )

    // This environment provides no WebGL2, so the wrapped view reports the
    // fallback instead of drawing. The dialog never builds a 2D plan for this
    // path and the toggle above is absent, so the message must not promise one
    // (review of #1179, correction round 4). Waiting for the message itself
    // rather than sleeping lets the view's passive effect land first.
    await dialog.waitFor(
      () => dialog.host.querySelector('[data-testid="motion-debug-webgl-unavailable"]') !== null,
      'the WebGL fallback message',
    )
    const fallback = text(dialog.host, '[data-testid="motion-debug-webgl-unavailable"]')
    assert(
      fallback === message('dialogs.motionDebug.webglUnavailableNoPlan'),
      `the WebGL fallback says the motion cannot be shown, got "${fallback}"`,
    )
    assert(
      fallback !== message('dialogs.motionDebug.webglUnavailable'),
      `the WebGL fallback does not promise a 2D plan this path never builds, got "${fallback}"`,
    )
  } finally {
    dialog.unmount()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
