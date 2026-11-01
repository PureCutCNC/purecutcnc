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

/// <reference types="node" />

/**
 * What the feature tree is allowed to display (issue #1112 N review).
 *
 * The hook is rendered for real into a `linkedom` document, with a fake
 * `Worker` behind the real client. Two failures the unit tests could not see
 * before are asserted here:
 *
 * - a result computed from an earlier input snapshot is hidden as soon as the
 *   input changes, instead of staying on screen through the debounce and the
 *   worker pass; and
 * - a worker failure clears the warning instead of leaving the previous
 *   verdict visible forever.
 *
 * Mutations checked one at a time against these assertions:
 * - returning the stored result regardless of its snapshot (dropping the
 *   `result.snapshot === snapshot` gate) → the "hidden immediately" assertion
 *   fails;
 * - dropping the cleared result from `FeatureEffectClient.fail()` → the
 *   "cleared on worker failure" assertion fails.
 *
 * Run with: npx tsx src/app/featureEffect/useFeatureEffectWarnings.test.ts
 */

import { createElement } from 'react'
import { parseHTML } from 'linkedom'
import type { Project } from '../../types/project'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import type { FeatureEffectWorkerLike } from './client'
import type { FeatureEffectRequest, FeatureEffectResponse } from './protocol'

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

class FakeWorker implements FeatureEffectWorkerLike {
  static instances: FakeWorker[] = []
  readonly messages: FeatureEffectRequest[] = []
  terminated = false
  onmessage: ((event: MessageEvent<FeatureEffectResponse>) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: FeatureEffectRequest): void {
    this.messages.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  respond(index: number, warnings: string[]): void {
    const message = this.messages[index]
    if (!message) throw new Error(`no request at index ${index}`)
    this.onmessage?.({
      data: { type: 'result', requestId: message.requestId, warnings },
    } as MessageEvent<FeatureEffectResponse>)
  }

  fail(): void {
    this.onerror?.({} as Event)
  }
}

globals.Worker = FakeWorker

const { newProject } = await import('../../types/project')
const { useFeatureEffectWarnings } = await import('./useFeatureEffectWarnings')
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

const NO_FEATURES: readonly ResolvedSketchFeature[] = []
let displayed: ReadonlySet<string> = new Set<string>()

function Probe({ project }: { project: Project }) {
  // eslint-disable-next-line react-hooks/globals -- this is the value under test
  displayed = useFeatureEffectWarnings(project, NO_FEATURES)
  return null
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function renderProject(project: Project, previousInstances: number) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(createElement(Probe, { project })))
  await waitFor(
    () => FakeWorker.instances.length > previousInstances,
    'the analysis worker to be created',
  )
  const worker = FakeWorker.instances[previousInstances]
  await waitFor(() => worker.messages.length === 1, 'the first analysis to be posted')
  return { host, root, worker }
}

// A result for an earlier input is hidden immediately, while the new analysis
// is still in its debounce.
{
  const before = FakeWorker.instances.length
  const mounted = await renderProject(newProject('stale-a', 'mm'), before)
  flushSync(() => mounted.worker.respond(0, ['covered']))
  assert(displayed.has('covered'), 'the current snapshot result is displayed')

  const nextProject = newProject('stale-b', 'mm')
  flushSync(() => mounted.root.render(createElement(Probe, { project: nextProject })))
  assertEqual(displayed.size, 0, 'the previous snapshot result is hidden as soon as the input changes')

  await waitFor(() => mounted.worker.messages.length === 2, 'the second analysis to be posted')
  flushSync(() => mounted.worker.respond(1, ['surviving']))
  assert(displayed.has('surviving'), 'the new snapshot result is displayed')

  flushSync(() => mounted.root.unmount())
  mounted.host.remove()
}

// A worker failure clears the warning instead of leaving it forever.
{
  const before = FakeWorker.instances.length
  const mounted = await renderProject(newProject('failure', 'mm'), before)
  flushSync(() => mounted.worker.respond(0, ['covered']))
  assert(displayed.has('covered'), 'the warning is displayed before the failure')

  flushSync(() => mounted.worker.fail())

  assertEqual(displayed.size, 0, 'the warning is cleared on worker failure')
  assert(mounted.worker.terminated, 'the dead worker is terminated')

  flushSync(() => mounted.root.unmount())
  mounted.host.remove()
}

console.log('useFeatureEffectWarnings.test.ts: all assertions passed')
