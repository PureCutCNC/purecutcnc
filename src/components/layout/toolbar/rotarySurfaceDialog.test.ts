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
 * The two dialog faces of decision 10/11 (issue #1112 slice H).
 *
 * Rendered DOM is the only way to catch a read-only line the store data cannot
 * show: the Turn form must offer **Profile: Pick a shape** and disable the
 * numbers the profile owns, and the Thread form must say **on Turn · Ø10** and
 * disable Refresh with the reason once the source is gone. A Thread moved onto
 * another Turn must name that Turn and its diameter: the line resolves the
 * placed band, not the stored parameters. The same placement decides the span
 * an unchanged Apply writes, so the row is not pushed back onto the old Turn.
 *
 * Run with: npx tsx src/components/layout/toolbar/rotarySurfaceDialog.test.ts
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
globals.React = React

const { useProjectStore } = await import('../../../store/projectStore')
const { I18nProvider } = await import('../../../i18n/I18nProvider')
const { RotarySolidDialog } = await import('./RotarySolidDialog')
const { RotaryPatternDialog } = await import('./RotaryPatternDialog')
const { createRoot } = await import('react-dom/client')
const { newProject, roundStock } = await import('../../../types/project')
const { projectWithFeatures } = await import('../../../test/projectFixtures')
const { bundledMachines } = await import('../../../machine/registry')
const { validateMachineDefinition } = await import('../../../engine/gcode/types')
const { switchWorkspaceFace } = await import('../../../store/workspaceFace')
const { turnProfileFromFeature } = await import('../../../store/helpers/rotarySolids')
const { rotarySolidFrame } = await import('../../../cannedShapes/generators/rotarySolidParams')

const store = () => useProjectStore.getState()

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function projectWithSource() {
  const base = newProject('Dialogs', 'mm')
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

await scenario('the Turn dialog picks a profile and disables the numbers it owns', async () => {
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
  const { unmount } = mount(React.createElement(RotarySolidDialog, {
    kind: 'turn',
    featureId: created.featureId,
    onClose: () => { closed = true },
  }))
  await waitFor(() => document.querySelector('.rotary-dialog__profile') !== null, 'the profile field renders')

  const profile = document.querySelector('.rotary-dialog__profile')
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
    profile.querySelector('.rotary-dialog__profile-summary')?.textContent ?? '',
    /From Half profile · Ø20 mm/,
    'the summary reports the copied size',
  )
  const refresh = profile.querySelector('.rotary-dialog__profile-refresh') as HTMLButtonElement
  assert.equal(refresh.disabled, false, 'Refresh is available while the source exists')
  assert.equal(closed, false)

  // The summary reads the live source name, not the name copied at pick time.
  store().updateFeature('f-half-profile', { name: 'Renamed profile' })
  await waitFor(
    () => /From Renamed profile · Ø20 mm/.test(
      document.querySelector('.rotary-dialog__profile-summary')?.textContent ?? '',
    ),
    'the summary follows a source rename',
  )

  // Deleting the source keeps the copied profile and disables Refresh with the
  // reason, instead of silently doing nothing.
  store().deleteFeature('f-half-profile')
  await waitFor(
    () => (document.querySelector('.rotary-dialog__profile-refresh') as HTMLButtonElement | null)?.disabled === true,
    'Refresh becomes unavailable',
  )
  const after = document.querySelector('.rotary-dialog__profile') as HTMLElement
  assert.match(
    after.querySelector('.rotary-dialog__profile-refresh')?.getAttribute('title') ?? '',
    /source shape no longer exists/,
    'the disabled reason names the missing source',
  )
  assert.match(
    after.querySelector('.rotary-dialog__profile-missing')?.textContent ?? '',
    /The source shape no longer exists/,
    'the reason is visible beside the field',
  )
  assert.equal((document.querySelector('#rotary-solid-diameter') as HTMLInputElement).disabled, true, 'the copied profile stays')
  unmount()
})

await scenario('the Thread dialog shows the Turn diameter read-only', async () => {
  store().loadProject(projectWithSource())
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  const turn = store().addRotarySolid({ kind: 'turn', start: 20, length: 40, diameter: 10 })
  assert.ok(turn.ok, 'the Turn is created')
  const thread = store().addRotaryPattern({ kind: 'thread', start: 25, length: 20, pitch: 2, depth: 1 })
  assert.ok(thread.ok, 'the thread is created')

  const { unmount } = mount(React.createElement(RotaryPatternDialog, {
    kind: 'thread',
    featureId: thread.featureId,
    onClose: () => undefined,
  }))
  await waitFor(() => document.querySelector('.rotary-dialog__surface-note') !== null, 'the surface note renders')
  const note = document.querySelector('.rotary-dialog__surface-note')?.textContent ?? ''
  assert.match(note, /on Turn · Ø10 mm/, 'the read-only line names the Turn and its diameter')
  assert.equal(document.querySelector('.rotary-dialog__surface-warning'), null, 'a Turn surface has no warning')
  unmount()
})

await scenario('the Thread dialog follows a moved Thread onto its new surface', async () => {
  store().loadProject(projectWithSource())
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  const first = store().addRotarySolid({ kind: 'turn', start: 20, length: 40, diameter: 10 })
  assert.ok(first.ok, 'the first Turn is created')
  const second = store().addRotarySolid({ kind: 'turn', start: 70, length: 40, diameter: 16 })
  assert.ok(second.ok, 'the second Turn is created')
  store().updateFeature(second.featureId, { name: 'Shank' })
  const thread = store().addRotaryPattern({ kind: 'thread', start: 25, length: 20, pitch: 2, depth: 1 })
  assert.ok(thread.ok, 'the thread starts on the first Turn')

  // The row is moved before the dialog opens, so its stored band still lies
  // over the first Turn while the placed band lies over the second. Reading the
  // stored band would keep showing Ø10 (the named mutation).
  store().startMoveFeature(thread.featureId)
  store().setPendingMoveFrom({ x: 0, y: 0 })
  store().completePendingMove({ x: 50, y: 0 })
  const threadRow = () => store().project.features.find((row) => row.id === thread.featureId)
  assert.equal(Number(threadRow()?.z_top), 28, 'the move re-derives the thread span onto the Ø16 Turn')
  assert.equal(Number(threadRow()?.z_bottom), 27, 'the depth is measured down from the Ø16 Turn')

  const { unmount } = mount(React.createElement(RotaryPatternDialog, {
    kind: 'thread',
    featureId: thread.featureId,
    onClose: () => undefined,
  }))
  await waitFor(() => document.querySelector('.rotary-dialog__surface-note') !== null, 'the surface note renders')
  const note = document.querySelector('.rotary-dialog__surface-note')?.textContent ?? ''
  assert.match(note, /on Shank · Ø16 mm/, 'the read-only line names the Turn under the placed band')
  assert.doesNotMatch(note, /Ø10/, 'the stored band’s old diameter is not shown')
  assert.equal(document.querySelector('.rotary-dialog__surface-warning'), null, 'one Turn has no warning')

  // An unchanged Apply must keep the span the row already follows. Resolving
  // the **stored** band here would push it back to Ø10 (25/24), 3 mm too deep.
  const apply = document.querySelector('.rotary-dialog__create') as HTMLButtonElement | null
  assert.ok(apply, 'the edit dialog has an Apply action')
  apply.click()
  assert.equal(Number(threadRow()?.z_top), 28, 'an unchanged Apply keeps the placed Ø16 span')
  assert.equal(Number(threadRow()?.z_bottom), 27, 'an unchanged Apply keeps the placed depth')
  unmount()
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) process.exitCode = 1
