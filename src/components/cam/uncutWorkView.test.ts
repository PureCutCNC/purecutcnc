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
 * The "kept but cannot be cut" warning as the user sees it (issue #1112 slice
 * K, decision 5): a marker on the feature's tree row and a note on its
 * operation. The rules are `uncutWork.ts`'s; this pins the wiring — a warning
 * that never renders would leave the kept work looking usable.
 *
 * Mutations checked one at a time:
 * - dropping the badge from `TreeRow` (the required "warning dropped from the
 *   tree row" mutation) → the row has no `[data-uncut-work]` and the
 *   assertion fails;
 * - rendering the badge on every row → the round-bar project's absence
 *   assertion fails;
 * - dropping the note from the operation panel → the note assertion fails;
 * - suppressing the badge on a ghost operation row (`!ghost` in the CAMPanel
 *   badge condition) → the expanded Around section's ghost-row assertion fails.
 *
 * Run with: npx tsx src/components/cam/uncutWorkView.test.ts
 */

import * as React from 'react'
import { createElement, type ReactElement } from 'react'
import { parseHTML } from 'linkedom'

const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
if (typeof globals.navigator === 'undefined') globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
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

const { CAMPanel } = await import('./CAMPanel')
const { FeatureTree } = await import('../feature-tree/FeatureTree')
const { UncutWorkNote } = await import('../common/UncutWorkNote')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { useProjectStore } = await import('../../store/projectStore')
const { rotaryOperationFixture } = await import('../../test/rotaryOperationFixture')
const { defaultOperationForTarget } = await import('../../store/helpers/operationDefaults')
const { operationUncutWarning } = await import('./uncutWork')
const { squareStock } = await import('../../types/barStock')
const { camT } = await import('./camI18n')
const { enMessages } = await import('../../i18n/locales/en')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** Render `element` as the browser would; the caller removed the host? No — return it. */
async function renderTo(host: HTMLElement, element: ReactElement): Promise<() => void> {
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const root = createRoot(host)
  flushSync(() => root.render(element))
  return () => {
    flushSync(() => root.unmount())
    host.remove()
  }
}

const ROUND = rotaryOperationFixture('x', 'rotary_rough')
const SQUARE = { ...ROUND, stock: squareStock(12, 30, 'x') }
const AROUND_SETUP = SQUARE.setups.find((setup) => setup.kind === 'around')!.id
const operation = {
  ...defaultOperationForTarget(SQUARE, 'pocket', 'rough', { source: 'features', featureIds: ['sketch'] }, 0),
  setupId: AROUND_SETUP,
}

/** The row markup for one feature id, from the rendered tree. */
function rowHtml(html: string, featureId: string): string {
  const at = html.indexOf(`data-feature-id="${featureId}"`)
  assert(at >= 0, `the tree rendered a row for ${featureId}`)
  const next = html.indexOf('data-feature-id="', at + 1)
  return html.slice(at, next >= 0 ? next : undefined)
}

// ── The square blank's kept sheet work warns on its tree row ──────────

{
  useProjectStore.setState({ project: SQUARE })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const done = await renderTo(host, createElement(I18nProvider, null, createElement(FeatureTree)))
  const markup = host.innerHTML
  const row = rowHtml(markup, 'sketch')
  assert(row.includes('data-uncut-work="true"'), 'the kept Around sketch row carries the warning marker')
  assert(
    row.includes(`title="${camT('cam.uncut.aroundNeedsRoundBar')}"`),
    'its tooltip is the round-bar reason, in the user\'s words',
  )
  // The model row is still cuttable (a square blank turns it), so it does not warn.
  assert(!rowHtml(markup, 'model').includes('data-uncut-work'), 'the model row is not flagged')
  done()
}

// ── The same project on a round bar shows no warning at all ───────────

{
  useProjectStore.setState({ project: ROUND })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const done = await renderTo(host, createElement(I18nProvider, null, createElement(FeatureTree)))
  assert(!host.innerHTML.includes('data-uncut-work'), 'a round bar flags no work')
  done()
}

// ── The operation panel says why the kept operation cannot cut ────────

{
  const warning = operationUncutWarning(SQUARE, operation)
  assert(warning !== null, 'the kept pocket has a warning')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const done = await renderTo(host, createElement(I18nProvider, null, createElement(UncutWorkNote, { text: warning! })))
  const note = host.querySelector('[data-uncut-work]')
  assert(note, 'the operation note renders the warning')
  assert(note.textContent === enMessages['cam.uncut.operationNeedsRoundBar'], 'and it is the user-facing sentence')
  assert(note.getAttribute('role') === 'note', 'it is announced as a note, not an action')
  done()
}

// ── A ghost operation still shows why it cannot cut (slice K re-check) ──

{
  // Top is the face being worked on, so the Around setup's operation is a
  // ghost row. It is listed for reference, but "kept, not cut" has to stay
  // visible on it: suppressing the badge on ghosts would hide the reason.
  const project = { ...SQUARE, operations: [operation], activeSetupId: SQUARE.setups[0].id }
  useProjectStore.setState({ project })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const done = await renderTo(host, createElement(I18nProvider, null, createElement(CAMPanel, {
    mode: 'operations',
    selectedOperationId: null,
    onSelectedOperationIdChange: () => {},
    onExport: () => {},
    onExportOperation: () => {},
    requestToolpath: async () => null,
    documentKey: 0,
  })))
  assert(
    host.querySelector('[data-setup-face="top"]')?.getAttribute('data-active') === 'true',
    'Top is the face being worked on',
  )
  const aroundToggle = host.querySelector('[data-setup-face="around"] .cam-setup-group__toggle') as HTMLElement | null
  assert(aroundToggle, 'the Around setup has a section header to expand')
  assert(host.querySelectorAll('[data-ghost="true"]').length === 0, 'the collapsed Around section lists no row yet')
  const { flushSync } = await import('react-dom')
  flushSync(() => aroundToggle.click())
  const ghost = host.querySelector('[data-ghost="true"]')
  assert(ghost, 'expanding Around lists its operation as a ghost row')
  assert(ghost.textContent?.includes(operation.name), 'the ghost row is the Around operation')
  const badge = ghost.querySelector('[data-uncut-work="true"]')
  assert(badge, 'the ghost row carries the uncut-work badge')
  assert(
    badge.getAttribute('aria-label') === enMessages['cam.uncut.operationNeedsRoundBar'],
    'with the operation reason as its accessible name',
  )
  done()
}

console.log('uncut work view tests passed')
