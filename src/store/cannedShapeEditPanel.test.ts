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
 * The Edit <shape>… surface is the canvas side panel (issue #1112 DE2 review).
 *
 * The registry opener arms a `canned-edit` pending session; the canvas renders
 * one page-level workflow panel with the shape's current values, and Apply is a
 * single `updateFeature` write (one undo step). This renders the real panel in a
 * DOM because the seam a plain model test cannot see is the panel itself: if the
 * editor did not arm the pending session, or the panel did not read the stored
 * parameters, Properties would open nothing or open blank fields.
 *
 * Run with: npx tsx src/store/cannedShapeEditPanel.test.ts
 */

import React from 'react'
import { parseHTML } from 'linkedom'
import type { CannedShapeData } from '../types/project'

// A DOM for the client render, in place before React DOM is first imported.
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
// Components use the automatic JSX runtime; the tsx runner transpiles this file
// with the classic one, which expects a global `React`.
globals.React = React

const { useProjectStore } = await import('./projectStore')
const { instantiateProjectTemplate } = await import('./helpers/normalize')
const { getCannedShapeEditor } = await import('../cannedShapes')
const { CannedShapeEditPanel } = await import('../components/canvas/CannedShapeEditPanel')
const { I18nProvider } = await import('../i18n/I18nProvider')
const { defaultGearCreationParams } = await import('../sketch/gearProfile')
const { createRoot } = await import('react-dom/client')

let passCount = 0
let failCount = 0
const failures: string[] = []

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function seed(kind: string, params: CannedShapeData['params']): string {
  const project = instantiateProjectTemplate()
  const canned: CannedShapeData = { kind, params }
  const feature = {
    id: 'f-edit',
    name: 'Shape',
    kind: 'composite' as const,
    sketch: {
      profile: { start: { x: 0, y: 0 }, segments: [], closed: true },
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'add' as const,
    z_top: 5,
    z_bottom: 0,
    authoringFace: 'top' as const,
    visible: true,
    locked: false,
    folderId: null,
    canned,
  }
  const definition = {
    id: 'def-edit',
    kind: 'composite' as const,
    profile: feature.sketch.profile,
    dimensions: [],
    text: null,
    canned,
    stl: null,
    operation: 'add' as const,
  }
  useProjectStore.setState({
    project: {
      ...project,
      featureDefinitions: { 'def-edit': definition },
      features: [{
        ...feature,
        definitionId: 'def-edit',
        transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        constraints: [],
      }],
      featureTree: [{ type: 'feature', featureId: 'f-edit' }],
    },
    history: { past: [], future: [], transactionStart: null },
  } as never)
  return 'f-edit'
}

function fieldInputs(): HTMLInputElement[] {
  return Array.from(document.body.querySelectorAll('input')) as unknown as HTMLInputElement[]
}

function pendingEdit() {
  const pending = useProjectStore.getState().pendingAdd
  assert(pending?.shape === 'canned-edit', 'the opener arms a canned-edit pending session')
  return pending
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passCount += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failCount += 1
    failures.push(`${name}: ${(error as Error).message}`)
    console.error(`✗ ${name}`)
    console.error(`  ${(error as Error).message}`)
  }
}

await scenario('the canvas registers an opener for every canned shape', async () => {
  for (const kind of ['ellipse', 'slot', 'ngon', 'roundrect', 'chamferrect', 'gear']) {
    assert(getCannedShapeEditor(kind) !== null, `${kind} has an editor`)
  }
  assert(getCannedShapeEditor('not-a-shape') === null, 'an unknown kind has none')
})

await scenario('Edit opens the pending session and the panel shows the current values', async () => {
  const featureId = seed('ngon', { sides: 6, size: 20, rotation: 15 })
  getCannedShapeEditor('ngon')!(featureId)
  const pending = pendingEdit()
  assert(pending.featureId === featureId, 'the panel is armed for that feature')

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null, React.createElement(CannedShapeEditPanel, {
    pending,
    containerRef: { current: null },
    canvasRef: { current: null },
    clearTransientCanvasState: () => {},
  })))
  await flush()

  await waitFor(() => fieldInputs().length === 3, 'the panel renders its three fields')
  const inputs = fieldInputs()
  assert(inputs.length === 3, `expected three fields, got ${inputs.length}`)
  assert(inputs[0].value === '6', `sides field shows 6, got ${inputs[0].value}`)
  assert(inputs[1].value === '20', `size field shows 20, got ${inputs[1].value}`)
  assert(inputs[2].value === '15', `rotation field shows 15, got ${inputs[2].value}`)
  assert(document.body.querySelector('.canvas-workflow-panel--creation') !== null, 'it is the creation side panel, not a modal')
  assert(document.body.querySelector('.canned-shape-edit-host') === null, 'no second React root was mounted')

  // Apply is one `updateFeature` write: one history entry, and the pending
  // session closes.
  const historyBefore = useProjectStore.getState().history.past.length
  const save = Array.from(document.body.querySelectorAll('button'))
    .find((button) => button.getAttribute('aria-label') === 'Save')
  assert(save, 'the panel has an Apply action')
  ;(save as HTMLButtonElement).click()
  await waitFor(() => useProjectStore.getState().pendingAdd === null, 'Apply closes the pending session')
  assert(
    useProjectStore.getState().history.past.length === historyBefore + 1,
    'Apply is exactly one undo step',
  )
  root.unmount()
  host.remove()
})

await scenario('opening another shape replaces the session instead of stacking', async () => {
  const featureId = seed('ellipse', { rx: 30, ry: 20 })
  getCannedShapeEditor('ellipse')!(featureId)
  assert(pendingEdit().featureId === featureId, 'the ellipse session is armed')
  assert(document.body.querySelectorAll('.canvas-workflow-panel--creation').length === 0, 'no stale panel remains')
})

await scenario('the gear opens the same panel with its stored parameters', async () => {
  const featureId = seed('gear', {
    ...defaultGearCreationParams(20),
    outsideRadius: 20,
    boreDiameter: 6,
  })
  getCannedShapeEditor('gear')!(featureId)
  const pending = pendingEdit()

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null, React.createElement(CannedShapeEditPanel, {
    pending,
    containerRef: { current: null },
    canvasRef: { current: null },
    clearTransientCanvasState: () => {},
  })))
  await flush()

  await waitFor(() => fieldInputs().length > 0, 'the gear panel renders its fields')
  const values = fieldInputs().map((input) => input.value)
  assert(values[0] === '20', `outside radius shows 20, got ${values[0]}`)
  assert(values.includes('6'), 'the bore diameter is filled in')
  assert(values.includes('24'), 'the tooth count is filled in')
  const historyBefore = useProjectStore.getState().history.past.length
  const save = Array.from(document.body.querySelectorAll('button'))
    .find((button) => button.getAttribute('aria-label') === 'Save')
  assert(save, 'the gear panel has an Apply action')
  ;(save as HTMLButtonElement).click()
  await waitFor(() => useProjectStore.getState().pendingAdd === null, 'gear Apply closes the pending session')
  assert(useProjectStore.getState().history.past.length === historyBefore + 1, 'gear Apply is one undo step')
  root.unmount()
  host.remove()
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) {
  console.error('\n' + failures.join('\n'))
  process.exitCode = 1
}
