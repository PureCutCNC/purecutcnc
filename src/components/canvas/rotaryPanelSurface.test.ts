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
 * The two panel faces of decision 10/11 (issue #1112 slice H).
 *
 * Rendered DOM is the only way to catch a read-only line the store data cannot
 * show: the Turn form must offer **Profile: Pick a shape** and disable the
 * numbers the profile owns, and the Thread panel must say **on Turn · Ø10** and
 * disable Refresh with the reason once the source is gone. A Thread moved onto
 * another Turn must name that Turn and its diameter: the line resolves the
 * placed band, not the stored parameters. The same placement decides the span
 * an unchanged Apply writes, so the row is not pushed back onto the old Turn.
 * A groove inside one Turn must warn about the internal diameter change, not
 * claim the band crosses the Turn's end (#1112 rt3-c correction 1).
 *
 * Run with: npx tsx src/components/canvas/rotaryPanelSurface.test.ts
 */

import assert from 'node:assert/strict'
import React from 'react'
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
// React decides once, when it first imports, whether an `input` event can drive
// `onChange` (`'oninput' in document`). linkedom's document has no `oninput`, so
// without this a typed field would take no edit at all — a silently inert test.
if (!('oninput' in (document as unknown as object))) {
  Object.defineProperty(document, 'oninput', { value: null, writable: true, configurable: true })
}
globals.React = React

const { useProjectStore } = await import('../../store/projectStore')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { RotarySolidPanel } = await import('./RotarySolidPanel')
const { RotaryPatternPanel } = await import('./RotaryPatternPanel')
const { createRoot } = await import('react-dom/client')
const { newProject, roundStock } = await import('../../types/project')
const { projectWithFeatures } = await import('../../test/projectFixtures')
const { bundledMachines } = await import('../../machine/registry')
const { validateMachineDefinition } = await import('../../engine/gcode/types')
const { switchWorkspaceFace } = await import('../../store/workspaceFace')
const { turnProfileFromFeature } = await import('../../store/helpers/rotarySolids')
const { rotarySolidFrame } = await import('../../cannedShapes/generators/rotarySolidParams')

const store = () => useProjectStore.getState()

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Set a field the way typing does: value first, then the event React listens for. */
function setInputValue(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'linkedom has an input value setter')
  setter.call(field, value)
  field.dispatchEvent(new (window as unknown as {
    Event: new (type: string, init?: { bubbles?: boolean }) => object
  }).Event('input', { bubbles: true }) as unknown as Event)
}

function projectWithSource() {
  const base = newProject('Panels', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(40, 200, 'x', { x: 10, y: 30 })
  const machine = validateMachineDefinition({
    ...structuredClone(bundledMachines()[0]),
    id: 'around-dialogs',
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  return projectWithFeatures(base, [{
    id: 'f-half-profile',
    name: 'Half profile',
    kind: 'spline',
    folderId: null,
    sketch: {
      profile: {
        start: { x: 30, y: 50 },
        segments: [
          { type: 'line', to: { x: 60, y: 40 } },
          { type: 'line', to: { x: 60, y: 50 } },
        ],
        closed: false,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'construction',
    authoringFace: 'top',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }])
}

let passCount = 0
let failCount = 0

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passCount += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failCount += 1
    console.error(`✗ ${name}`)
    console.error(`  ${(error as Error).stack ?? (error as Error).message}`)
  }
}

function mount(element: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null, element))
  return {
    root,
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
}

await scenario('the Turn panel picks a profile and disables the numbers it owns', async () => {
  store().loadProject(projectWithSource())
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  const frame = rotarySolidFrame(store().project)
  assert.ok(frame)
  const picked = turnProfileFromFeature(store().project, frame, 'f-half-profile')
  assert.ok(picked.ok, 'the source is picked')
  const created = store().addRotarySolid({
    kind: 'turn',
    start: picked.start,
    length: picked.length,
    diameter: picked.diameter,
    profile: picked.profile,
  })
  assert.ok(created.ok, 'the profiled Turn is created')

  let closed = false
  const { unmount } = mount(React.createElement(RotarySolidPanel, {
    kind: 'turn',
    featureId: created.featureId,
    onClose: () => { closed = true },
  }))
  await waitFor(() => document.querySelector('.rotary-panel__profile') !== null, 'the profile field renders')

  const profile = document.querySelector('.rotary-panel__profile')
  assert.ok(profile, 'the profile group exists')
  assert.match(profile.textContent ?? '', /Profile: pick a shape/, 'the label names Pick a shape')
  assert.match(
    profile.querySelector('.ui-select__trigger')?.textContent ?? '',
    /Half profile/,
    'the select shows the copied source',
  )
  assert.equal((document.querySelector('#rotary-solid-start') as HTMLInputElement).disabled, true, 'start is set by the profile')
  assert.equal((document.querySelector('#rotary-solid-length') as HTMLInputElement).disabled, true, 'length is set by the profile')
  assert.equal((document.querySelector('#rotary-solid-diameter') as HTMLInputElement).disabled, true, 'diameter is set by the profile')
  assert.match(
    profile.querySelector('.rotary-panel__profile-summary')?.textContent ?? '',
    /From Half profile · Ø20 mm/,
    'the summary reports the copied size',
  )
  const refresh = profile.querySelector('.rotary-panel__profile-refresh') as HTMLButtonElement
  assert.equal(refresh.disabled, false, 'Refresh is available while the source exists')
  assert.equal(closed, false)

  // The summary reads the live source name, not the name copied at pick time.
  store().updateFeature('f-half-profile', { name: 'Renamed profile' })
  await waitFor(
    () => /From Renamed profile · Ø20 mm/.test(
      document.querySelector('.rotary-panel__profile-summary')?.textContent ?? '',
    ),
    'the summary follows a source rename',
  )

  // Deleting the source keeps the copied profile and disables Refresh with the
  // reason, instead of silently doing nothing.
  store().deleteFeature('f-half-profile')
  await waitFor(
    () => (document.querySelector('.rotary-panel__profile-refresh') as HTMLButtonElement | null)?.disabled === true,
    'Refresh becomes unavailable',
  )
  const after = document.querySelector('.rotary-panel__profile') as HTMLElement
  assert.match(
    after.querySelector('.rotary-panel__profile-refresh')?.getAttribute('title') ?? '',
    /source shape no longer exists/,
    'the disabled reason names the missing source',
  )
  assert.match(
    after.querySelector('.rotary-panel__profile-missing')?.textContent ?? '',
    /The source shape no longer exists/,
    'the reason is visible beside the field',
  )
  assert.equal((document.querySelector('#rotary-solid-diameter') as HTMLInputElement).disabled, true, 'the copied profile stays')
  unmount()
})

await scenario('the Thread panel shows the Turn diameter read-only', async () => {
  store().loadProject(projectWithSource())
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  const turn = store().addRotarySolid({ kind: 'turn', start: 20, length: 40, diameter: 10 })
  assert.ok(turn.ok, 'the Turn is created')
  const thread = store().addRotaryPattern({ kind: 'thread', start: 25, length: 20, pitch: 2, depth: 1 })
  assert.ok(thread.ok, 'the thread is created')

  const { unmount } = mount(React.createElement(RotaryPatternPanel, {
    kind: 'thread',
    featureId: thread.featureId,
    onClose: () => undefined,
  }))
  await waitFor(() => document.querySelector('.rotary-panel__surface-note') !== null, 'the surface note renders')
  const note = document.querySelector('.rotary-panel__surface-note')?.textContent ?? ''
  assert.match(note, /on Turn · Ø10 mm/, 'the read-only line names the Turn and its diameter')
  assert.equal(document.querySelector('.rotary-panel__surface-warning'), null, 'a Turn surface has no warning')
  unmount()
})

await scenario('the Thread panel warns about an internal groove, not the Turn end', async () => {
  // The reviewed false warning (#1112 rt3-c correction 1): in the bar frame the
  // band (25–35) lies wholly on the Turn (20–60) and crosses a groove inside
  // it. This test's bar starts at x=10, so the band is 15–25 from the chuck
  // end. Nothing runs past the Turn's end, so the panel must not say that it
  // does.
  store().loadProject(projectWithSource())
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  const turn = store().addRotarySolid({
    kind: 'turn',
    start: 20,
    length: 40,
    diameter: 20,
    profile: {
      sourceFeatureId: 'no-source',
      contours: [{
        closed: false,
        points: [
          { along: 20, radius: 5 },
          { along: 30.1, radius: 5 },
          { along: 30.1, radius: 3 },
          { along: 30.3, radius: 3 },
          { along: 30.3, radius: 5 },
          { along: 60, radius: 5 },
        ],
      }],
    },
  })
  assert.ok(turn.ok, 'the grooved Turn is created')
  const thread = store().addRotaryPattern({ kind: 'thread', start: 15, length: 10, pitch: 2, depth: 1 })
  assert.ok(thread.ok, 'the thread is created')

  const { unmount } = mount(React.createElement(RotaryPatternPanel, {
    kind: 'thread',
    featureId: thread.featureId,
    onClose: () => undefined,
  }))
  await waitFor(
    () => document.querySelector('.rotary-panel__surface-warning') !== null,
    'the surface warning renders',
  )
  const warning = document.querySelector('.rotary-panel__surface-warning')?.textContent ?? ''
  assert.equal(
    warning,
    'This pattern crosses a diameter change in Turn.',
    'the panel names the Turn and the internal diameter change',
  )
  assert.doesNotMatch(warning, /end of/, 'an internal groove does not claim to cross the Turn end')
  unmount()
})

await scenario('the Thread panel follows a moved Thread onto its new surface', async () => {
  store().loadProject(projectWithSource())
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  const first = store().addRotarySolid({ kind: 'turn', start: 20, length: 40, diameter: 10 })
  assert.ok(first.ok, 'the first Turn is created')
  const second = store().addRotarySolid({ kind: 'turn', start: 70, length: 40, diameter: 16 })
  assert.ok(second.ok, 'the second Turn is created')
  store().updateFeature(second.featureId, { name: 'Shank' })
  const thread = store().addRotaryPattern({ kind: 'thread', start: 25, length: 20, pitch: 2, depth: 1 })
  assert.ok(thread.ok, 'the thread starts on the first Turn')

  // The row is moved before the panel opens, so its stored band still lies
  // over the first Turn while the placed band lies over the second. Reading the
  // stored band would keep showing Ø10 (the named mutation).
  store().startMoveFeature(thread.featureId)
  store().setPendingMoveFrom({ x: 0, y: 0 })
  store().completePendingMove({ x: 50, y: 0 })
  const threadRow = () => store().project.features.find((row) => row.id === thread.featureId)
  assert.equal(Number(threadRow()?.z_top), 28, 'the move re-derives the thread span onto the Ø16 Turn')
  assert.equal(Number(threadRow()?.z_bottom), 27, 'the depth is measured down from the Ø16 Turn')

  const { unmount } = mount(React.createElement(RotaryPatternPanel, {
    kind: 'thread',
    featureId: thread.featureId,
    onClose: () => undefined,
  }))
  await waitFor(() => document.querySelector('.rotary-panel__surface-note') !== null, 'the surface note renders')
  const note = document.querySelector('.rotary-panel__surface-note')?.textContent ?? ''
  assert.match(note, /on Shank · Ø16 mm/, 'the read-only line names the Turn under the placed band')
  assert.doesNotMatch(note, /Ø10/, 'the stored band’s old diameter is not shown')
  assert.equal(document.querySelector('.rotary-panel__surface-warning'), null, 'one Turn has no warning')

  // An Apply that leaves the depth alone must keep the span the row already
  // follows. Resolving the **stored** band here would push it back to Ø10
  // (25/24), 3 mm too deep. The pitch is edited first because an Apply with
  // nothing changed is disabled (issue #1112 F4), and the span depends on the
  // surface and the depth, neither of which the pitch touches.
  const apply = document.querySelector('.rotary-panel__create') as HTMLButtonElement | null
  assert.ok(apply, 'the edit panel has a Save action')
  assert.equal(apply.disabled, true, 'an unchanged Thread offers no Save')
  setInputValue(document.querySelector('#rotary-pitch') as HTMLInputElement, '2.5')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(apply.disabled, false, 'a changed pitch offers Save')
  apply.click()
  assert.equal(Number(threadRow()?.z_top), 28, 'the edited Apply keeps the placed Ø16 span')
  assert.equal(Number(threadRow()?.z_bottom), 27, 'the edited Apply keeps the placed depth')
  unmount()
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) process.exitCode = 1
