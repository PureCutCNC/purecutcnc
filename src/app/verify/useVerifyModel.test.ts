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
 * The Verify mode's state through the real hook (issue #1269): a run happens
 * only on `run()`, a finished result goes stale after a project edit or a
 * changed comparison without running again, and leaving the mode cancels a
 * run in progress.
 *
 * Run with: NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/app/verify/useVerifyModel.test.ts
 */

import * as React from 'react'
import { createElement } from 'react'
import { parseHTML } from 'linkedom'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { syncProjectSetups } from '../../store/helpers/setups'
import { defaultTool, newProject, rectProfile, type Operation, type Project } from '../../types/project'
import { useVerifyModel, type VerifyModel } from './useVerifyModel'

const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
if (typeof globals.navigator === 'undefined') globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
;(globalThis as unknown as { React?: typeof React }).React = React

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function operation(id: string, setupId: string): Operation {
  return {
    id, name: `Op ${id}`, kind: 'pocket', pass: 'rough', enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'stock' }, toolRef: 't1', setupId, stepdown: 2, stepover: 0.4, feed: 600, plungeFeed: 180,
    rpm: 18000, pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: false, finishFloor: false, carveDepth: 0, maxCarveDepth: 0,
  }
}

function project(): Project {
  const base = newProject('verify state', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 40, 30), thickness: 10 }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1' }]
  return syncProjectSetups({ ...base, operations: [operation('a', base.activeSetupId), operation('b', base.activeSetupId)] })
}

function path(operationId: string): ToolpathResult {
  return {
    operationId,
    moves: [{ kind: 'cut', from: { x: 5, y: 5, z: 8 }, to: { x: 30, y: 5, z: 8 } }],
    warnings: [],
    bounds: null,
  }
}

const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await settle()
  }
  throw new Error(`timed out waiting for ${what}`)
}

const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')

let captured: VerifyModel | null = null
let requests = 0
let gate: Promise<void> = Promise.resolve()
async function requestToolpath(operationId: string): Promise<ToolpathResult | null> {
  requests += 1
  await gate
  return path(operationId)
}

function Probe({ value, selected }: { value: Project; selected: string | null }) {
  // eslint-disable-next-line react-hooks/globals
  captured = useVerifyModel({ project: value, selectedOperationId: selected, detailCells: 240, requestToolpath })
  return null
}

const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host)
const render = (value: Project, selected: string | null) => flushSync(() => root.render(createElement(Probe, { value, selected })))
const model = () => {
  assert(captured, 'the hook rendered')
  return captured
}

// ── Nothing runs until asked ────────────────────────────────
let current = project()
render(current, 'b')
await settle()
assert(model().status === 'idle' && model().result === null && requests === 0, 'mounting runs nothing')
assert(model().comparison === 'modelInternal' && !model().active, 'Model ↔ Internal, mode off')
assert(model().scope.uptoOperationName === 'Op b', 'the run would be cumulative up to the selection')
flushSync(() => model().setActive(true))
await settle()
assert(model().active && requests === 0, 'entering the mode runs nothing either')

// ── A run, then staleness without a rerun ───────────────────
flushSync(() => model().run())
assert(model().status === 'running', 'the run starts')
await waitFor(() => model().status === 'done', 'the run')
const first = model().result
assert(first && first.operations.map((entry) => entry.operationId).join() === 'a,b', 'the run covers a and b')
assert(model().staleness === 'current', 'a fresh result is current')
const requestsAfterRun = requests

current = { ...current }
render(current, 'b')
await settle()
assert(model().staleness === 'projectEdited', 'an edit marks the result stale')
assert(model().result === first && model().status === 'done' && requests === requestsAfterRun, 'and does not run again')

flushSync(() => model().run())
await waitFor(() => model().status === 'done' && model().result !== first, 'the second run')
assert(model().staleness === 'current', 'running again makes it current')
flushSync(() => model().setComparison('internalExported'))
assert(model().staleness === 'requestChanged', 'another comparison marks it stale')
render(current, 'a')
assert(model().scope.uptoOperationName === 'Op a', 'the scope follows the selection')

// ── Leaving the mode cancels a run in progress ──────────────
let release: () => void = () => {}
gate = new Promise<void>((resolve) => { release = resolve })
const before = model().result
flushSync(() => model().run())
assert(model().status === 'running', 'a run is in progress')
flushSync(() => model().setActive(false))
release()
await settle()
await settle()
assert(model().status === 'idle' && model().result === before, 'the cancelled run installs nothing')

flushSync(() => root.unmount())
host.remove()
console.log('useVerifyModel tests passed')
