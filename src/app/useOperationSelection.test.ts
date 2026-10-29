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
 * Selecting an operation on another face turns the workspace over to it
 * (issue #1112 F3). This is the app-level wiring the whole slice rests on: the
 * header face control is the simulation's only setup choice, so a selection
 * that left the face behind would simulate a setup nobody is looking at.
 *
 * Mutations checked one at a time against these assertions:
 * - dropping `revealOperationFace` from `selectOperation` → "selecting a
 *   Bottom operation switches the face to Bottom" fails (the app would leave
 *   the face behind and the simulation would show the wrong setup);
 * - storing a cleared selection instead of the chosen one → "the selection is
 *   the one that was chosen" fails.
 *
 * Run with: NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/app/useOperationSelection.test.ts
 */

import * as React from 'react'
import { createElement } from 'react'
import { parseHTML } from 'linkedom'
import { useOperationSelection } from './useOperationSelection'
import { activeFace, activeSetup } from '../store/helpers/activeFace'
import { useProjectStore } from '../store/projectStore'
import { syncProjectSetups } from '../store/helpers/setups'
import { defaultTool, newProject, rectProfile } from '../types/project'
import type { Operation, Project } from '../types/project'

// A DOM for the client render, in place before React DOM is first imported.
const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
if (typeof globals.navigator === 'undefined') globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
// Components are authored with the automatic JSX runtime; the tsx runner
// transpiles this file with the classic one, which expects a global `React`.
;(globalThis as unknown as { React?: typeof React }).React = React

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function operation(id: string, setupId: string): Operation {
  return {
    id, name: id, kind: 'pocket', pass: 'rough', enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'features', featureIds: [] }, toolRef: 't1', setupId,
    stepdown: 2, stepover: 0.4, feed: 600, plungeFeed: 180, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: true, finishFloor: true, carveDepth: 2, maxCarveDepth: 2,
    cutDirection: 'conventional', machiningOrder: 'level_first',
  }
}

/** A Top setup and a Bottom setup, one operation each, on a small block. */
function twoFaceProject(): Project {
  const base = newProject('selection', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 50, 40), thickness: 10 }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Flat', diameter: 6, maxCutDepth: 40 }]
  const top = base.setups[0]!
  const bottom = {
    id: 'setup-bottom', name: 'Bottom', orientation: { axis: 'x' as const, angleDeg: 180 },
    indexing: 'manual' as const, registration: [], notes: '', operationIds: [],
  }
  return syncProjectSetups({
    ...base,
    setups: [top, bottom],
    activeSetupId: top.id,
    operations: [operation('opTop', top.id), operation('opBottom', bottom.id)],
  })
}

interface Selected {
  selectedOperationId: string | null
  selectOperation: (operationId: string | null) => void
}

/** Mount the hook and hand back its latest value plus a flushed selector. */
async function mountSelection(project: Project): Promise<{
  selected: () => Selected
  select: (operationId: string | null) => void
  unmount: () => void
}> {
  useProjectStore.setState({ project })
  let captured: Selected | null = null
  function Probe() {
    // eslint-disable-next-line react-hooks/globals
    captured = useOperationSelection()
    return null
  }
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(createElement(Probe)))
  return {
    selected: () => {
      assert(captured, 'the hook rendered')
      return captured
    },
    select: (operationId) => flushSync(() => captured!.selectOperation(operationId)),
    unmount: () => { flushSync(() => root.unmount()); host.remove() },
  }
}

const current = () => useProjectStore.getState().project

// ── Top, then a Bottom operation: the face follows the selection ─
{
  const harness = await mountSelection(twoFaceProject())
  const bottomSetupId = current().setups[1]!.id
  assert(activeFace(current()) === 'top', 'the project starts on Top')
  assert(harness.selected().selectedOperationId === null, 'with nothing selected')

  harness.select('opBottom')
  assert(harness.selected().selectedOperationId === 'opBottom', 'the selection is the one that was chosen')
  assert(activeFace(current()) === 'bottom', 'selecting a Bottom operation switches the face to Bottom')
  assert(activeSetup(current()).id === bottomSetupId, 'and the workspace setup is the Bottom one')

  harness.select('opTop')
  assert(harness.selected().selectedOperationId === 'opTop', 'selecting a Top operation keeps the new selection')
  assert(activeFace(current()) === 'top', 'and turns the workspace back to Top')

  harness.select(null)
  assert(harness.selected().selectedOperationId === null, 'clearing the selection clears it')
  assert(activeFace(current()) === 'top', 'and leaves the face where it is')
  harness.unmount()
}

// ── Selecting on the face already in view moves nothing ──────
{
  const harness = await mountSelection(twoFaceProject())
  const topSetupId = activeSetup(current()).id
  harness.select('opTop')
  assert(activeFace(current()) === 'top', 'a Top operation selected on Top leaves the face alone')
  assert(activeSetup(current()).id === topSetupId, 'and the workspace stays on the same setup object')
  harness.unmount()
}

// ── An unknown operation steers nothing ──────────────────────
{
  const harness = await mountSelection(twoFaceProject())
  harness.select('not-an-operation')
  assert(activeFace(current()) === 'top', 'an unknown operation does not switch the face')
  assert(harness.selected().selectedOperationId === 'not-an-operation', 'the selection is still stored')
  harness.unmount()
}

console.log('operation selection tests passed')
