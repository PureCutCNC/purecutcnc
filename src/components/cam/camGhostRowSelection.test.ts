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
 * An operation from the other face is selectable from the CAM panel (issue
 * #1112 F3, review of PR #1126, finding 1). The slice made the header face
 * control the simulation's one setup choice, and selecting an operation is how
 * the face follows the work (`revealOperationFace`). That only holds if the
 * other face's rows can be selected: the panel lists every setup's operations,
 * so a Bottom row clicked from Top has to turn the workspace over to Bottom and
 * select the operation. Removing the row's click, key handler and focusability
 * left `revealOperationFace` unreachable from the only list a user picks an
 * operation from.
 *
 * The panel is rendered for real, with the app's own `useOperationSelection`
 * wired the way `App.tsx` wires it, so the assertion covers the whole route:
 * the row's handler → the selection hook → the store's face write. The stored
 * selection is read through the app's rule (`operationOnActiveSetup`), which is
 * what the panel receives as `effectiveSelectedOperationId`.
 *
 * Mutations checked one at a time:
 * - restoring `onClick={ghost ? undefined : …}` (with the same guards on
 *   `onKeyDown`, `role` and `tabIndex`) in `CAMPanel` → "clicking a Bottom row
 *   from Top selects it" and the focusability and keyboard assertions fail;
 * - dropping `revealOperationFace` from `useOperationSelection` → "the header
 *   face follows the click" fails, the face staying on Top;
 * - dropping the ghost's dimmed class → "the row still reads as a ghost" fails.
 *
 * Run with: NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/cam/camGhostRowSelection.test.ts
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
const { operationOnActiveSetup } = await import('./setupSections')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { useProjectStore } = await import('../../store/projectStore')
const { useOperationSelection } = await import('../../app/useOperationSelection')
const { activeFace } = await import('../../store/helpers/activeFace')
const { defaultOperationForTarget } = await import('../../store/helpers/operationDefaults')
const { withBottomSetup } = await import('../../test/projectFixtures')
const { newProject } = await import('../../types/project')
import type { Operation, Project } from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** A Top setup and a Bottom one, one operation each, on a small block. */
function twoFaceProject(): Project {
  const base = newProject('ghost row selection', 'mm')
  const make = (id: string): Operation => ({
    ...defaultOperationForTarget(base, 'pocket', 'rough', { source: 'features', featureIds: [] }, 0),
    id,
    name: id,
  })
  return withBottomSetup(
    { ...base, operations: [make('topOp'), make('bottomOp')] },
    { operationIds: ['bottomOp'] },
  )
}

const current = () => useProjectStore.getState().project

/** Render the panel wired like `App.tsx`: the selection hook owns the face write. */
async function mountPanel(project: Project): Promise<{
  host: HTMLElement
  selection: () => string | null
  unmount: () => void
}> {
  useProjectStore.setState({ project })
  let selected: string | null = null
  function Host() {
    const { selectedOperationId, selectOperation } = useOperationSelection()
    // eslint-disable-next-line react-hooks/globals
    selected = selectedOperationId
    const live = useProjectStore((state) => state.project)
    const operation = live.operations.find((entry) => entry.id === selectedOperationId)
    // What `App.tsx` hands the panel: a selection only counts on the face in view.
    const effective = operation && operationOnActiveSetup(live, operation) ? operation.id : null
    return createElement(CAMPanel, {
      mode: 'operations',
      selectedOperationId: effective,
      onSelectedOperationIdChange: selectOperation,
      onExport: () => {},
      onExportOperation: () => {},
      requestToolpath: async () => null,
      documentKey: 0,
    })
  }
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(createElement(I18nProvider, null, createElement(Host))))
  return {
    host,
    selection: () => selected,
    unmount: () => { flushSync(() => root.unmount()); host.remove() },
  }
}

/** The one ghost row in the panel: the Bottom operation, from Top. */
function ghostRow(host: HTMLElement): HTMLElement {
  const row = host.querySelector<HTMLElement>('.cam-operation-tree .tree-row[data-ghost="true"]')
  assert(row, 'the panel lists the Bottom operation as a ghost row')
  return row
}

/** The inactive setup's card starts collapsed; open it the way a user does. */
async function openBottomSection(host: HTMLElement): Promise<void> {
  const { flushSync } = await import('react-dom')
  const toggle = host.querySelector<HTMLElement>('.cam-setup-group[data-setup-face="bottom"] .cam-setup-group__toggle')
  assert(toggle, 'the Bottom setup has a card header')
  if (toggle.getAttribute('aria-expanded') !== 'true') flushSync(() => toggle.click())
  assert(toggle.getAttribute('aria-expanded') === 'true', 'the Bottom card is open')
}

/** A keydown as the DOM delivers it (linkedom has no `KeyboardEvent`). */
function pressKey(target: Element, key: string): void {
  const event = new window.Event('keydown', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'key', { value: key })
  target.dispatchEvent(event)
}

// ── The off-face row is a focusable button again ──────────────
{
  const harness = await mountPanel(twoFaceProject())
  assert(activeFace(current()) === 'top', 'the project starts on Top')
  await openBottomSection(harness.host)
  const row = ghostRow(harness.host)
  assert(row.classList.contains('tree-row--ghost'), 'the row still reads as a ghost')
  assert(row.getAttribute('role') === 'button', 'the row is announced as a button')
  assert(row.getAttribute('tabindex') === '0', 'the row is in the tab order')
  // Editing an operation of another setup is still not offered here: the eye is
  // the only control on the row, and the row cannot be dragged across setups.
  assert(row.querySelectorAll('button').length === 1, 'the ghost row keeps only its eye')
  assert(!row.hasAttribute('draggable'), 'the row is not draggable from the other face')
  harness.unmount()
}

// ── Clicking it selects the operation and turns the face over ──
{
  const harness = await mountPanel(twoFaceProject())
  await openBottomSection(harness.host)
  const row = ghostRow(harness.host)
  const { flushSync } = await import('react-dom')
  flushSync(() => row.click())
  assert(harness.selection() === 'bottomOp', 'clicking a Bottom row from Top selects it')
  assert(activeFace(current()) === 'bottom', 'the header face follows the click')
  // The workspace is on Bottom now, so the row is ordinary work: no ghost, and
  // it is the selected row.
  assert(harness.host.querySelectorAll('.cam-operation-tree .tree-row[data-ghost="true"]').length === 0,
    'the row stops being a ghost once its face is in view')
  const selected = harness.host.querySelector<HTMLElement>('.cam-operation-tree .tree-row--selected')
  assert(selected?.textContent?.includes('bottomOp'), 'the row is the selected one')
  harness.unmount()
}

// ── Enter and Space select it from the keyboard ───────────────
for (const key of ['Enter', ' '] as const) {
  const harness = await mountPanel(twoFaceProject())
  await openBottomSection(harness.host)
  const { flushSync } = await import('react-dom')
  flushSync(() => pressKey(ghostRow(harness.host), key))
  assert(harness.selection() === 'bottomOp', `${key === ' ' ? 'Space' : key} on a ghost row selects it`)
  assert(activeFace(current()) === 'bottom', `${key === ' ' ? 'Space' : key} on a ghost row turns the face over`)
  harness.unmount()
}

console.log('cam ghost row selection tests passed')
