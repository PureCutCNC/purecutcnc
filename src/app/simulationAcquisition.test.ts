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
 * The Simulation tab acquires its paths through the generation service
 * (issue #1112 rt2-h, correction 1 review P2).
 *
 * The rt2-h probe answered `requestToolpath` from a `Map`, which assumed the
 * paths were cached and so could not establish whether switching to Simulation
 * regenerates a path or crosses the worker boundary. The profile now drives the
 * real service and worker; these assertions are the part of that measurement
 * that stays in the suite, through App.tsx's own pair of hooks
 * (`useToolpathGeneration` → `useSimulationModel`) and the real generation
 * service behind them:
 *
 *   - a tab switch on a warm cache starts no generation job at all: the paths
 *     the Sketch/3D view already produced are served from the service cache;
 *   - a tab opened while the preview's generation is deferred acquires its
 *     prior-operation path *through the service* — one job, for exactly that
 *     operation — and never generates the selected operation itself, which is
 *     the preview's job. That second assertion is what a `Map` lookup cannot
 *     satisfy: with no other client, the path can only arrive if the tab really
 *     asked the service for it.
 *
 * Mutations these assertions were checked against, each applied on its own and
 * reverted:
 * - answering `useSimulationModel`'s `requestToolpath` from a local path `Map`
 *   instead of `useToolpathGeneration`'s callback → "the acquisition really
 *   asked the service" fails (no job starts, the prior operation never becomes
 *   ready);
 * - making the service submit a job for an already-valid cache entry → "the
 *   warm switch starts no generation" fails;
 * - generating the selected operation inside the tab's acquisition → "the tab
 *   never generates the selection" fails.
 *
 * Run with: NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/app/simulationAcquisition.test.ts
 */

import * as React from 'react'
import { createElement, useState } from 'react'
import { parseHTML } from 'linkedom'

// A DOM for the client render, in place before React DOM is first imported.
const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
globals.IS_REACT_ACT_ENVIRONMENT = true
if (typeof globals.navigator === 'undefined') {
  globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
}
;(globalThis as unknown as { React?: typeof React }).React = React

const { createRoot } = await import('react-dom/client')
const { act } = React

import { defaultTool, newProject, rectProfile } from '../types/project'
import type { Operation, Project } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { syncProjectSetups } from '../store/helpers/setups'
import type { SimulationResult } from '../engine/simulation/types'
import type { GenerationStatusSnapshot } from './toolpathGeneration/types'
import type { ToolpathGenerationService } from './toolpathGeneration/service'
import { useToolpathGeneration } from './useToolpathGeneration'
import { useSimulationModel } from './useSimulationModel'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

// ── Fixture: one setup, two pockets over the same rectangle ──────

const STOCK = { x: 0, y: 0, w: 40, h: 30, thickness: 8 }
const RECT = { x: 8, y: 6, w: 12, h: 10 }

function operation(id: string, name: string, pass: 'rough' | 'finish', setupId: string): Operation {
  return {
    id, name, kind: 'pocket', pass,
    enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'features', featureIds: ['pocket'] }, toolRef: 't1', setupId,
    stepdown: 2, stepover: 0.4, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: true, finishFloor: true, carveDepth: 1, maxCarveDepth: 2,
    cutDirection: 'conventional', machiningOrder: 'level_first',
  }
}

function makeProject(): { project: Project; operations: Operation[] } {
  const base = newProject('acquisition', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(STOCK.x, STOCK.y, STOCK.w, STOCK.h), thickness: STOCK.thickness }
  base.origin = { name: 'Origin', x: 0, y: STOCK.h, z: STOCK.thickness, visible: true }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Flat endmill', diameter: 4, maxCutDepth: 20 }]
  const withFeature = projectWithFeatures(base, [{
    id: 'pocket', name: 'pocket', kind: 'rect', folderId: null,
    sketch: {
      profile: rectProfile(RECT.x, RECT.y, RECT.w, RECT.h),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'subtract', z_top: STOCK.thickness, z_bottom: STOCK.thickness - 4,
    authoringFace: 'top', visible: true, locked: false,
  }])
  const setupId = withFeature.activeSetupId
  const operations = [
    operation('opRough', 'Rough pocket', 'rough', setupId),
    operation('opFinish', 'Finish pocket', 'finish', setupId),
  ]
  return { project: syncProjectSetups({ ...withFeature, operations }), operations }
}

// ── Counting the generation jobs the service really starts ───────

interface JobCounter {
  starts: string[]
  reset: () => void
  /** Idempotent; called during the first render so no job can start unnoticed. */
  attach: (service: ToolpathGenerationService) => void
}

/**
 * Records the service's job starts from its own status stream: a job beginning
 * sets a non-null `activeOperationId` it did not have before. A cache hit emits
 * nothing, which is what makes "no new job" observable.
 */
function createJobCounter(): JobCounter {
  let attached: ToolpathGenerationService | null = null
  let lastActive: string | null = null
  const starts: string[] = []
  return {
    starts,
    reset() { starts.length = 0 },
    attach(service) {
      if (attached === service) return
      attached = service
      lastActive = service.getSnapshot().activeOperationId
      service.subscribe(() => {
        const snapshot = service.getSnapshot()
        if (snapshot.activeOperationId !== null && snapshot.activeOperationId !== lastActive) {
          starts.push(snapshot.activeOperationId)
        }
        lastActive = snapshot.activeOperationId
      })
    },
  }
}

interface Captured {
  result: SimulationResult | null
  pending: boolean
  status: GenerationStatusSnapshot | null
  service: ToolpathGenerationService | null
}

// ── The harness: App.tsx's own pair of hooks, in a real React root ──

interface Harness {
  captured: () => Captured
  counter: JobCounter
  state: { centerTab: 'sketch' | 'simulation'; selected: Operation | null }
  render: () => Promise<void>
  settle: (ticks?: number) => Promise<void>
  waitForResult: () => Promise<void>
  /** Wait until the service holds a cache-valid path for every id. */
  waitForPaths: (ids: readonly string[]) => Promise<void>
  unmount: () => Promise<void>
}

function mount(project: Project, options: {
  centerTab: 'sketch' | 'simulation'
  selected: Operation | null
  deferred: boolean
}): Harness {
  const counter = createJobCounter()
  const state: Harness['state'] = { centerTab: options.centerTab, selected: options.selected }
  let captured: Captured = { result: null, pending: false, status: null, service: null }

  function Probe() {
    const generation = useToolpathGeneration(project, state.selected, options.deferred, 0, 'inline')
    const model = useSimulationModel({
      project,
      centerTab: state.centerTab,
      simulationMode: 'selected',
      simulationDetailCells: 120,
      selectedOperation: state.selected,
      selectedToolpath: generation.selectedToolpath,
      requestToolpath: generation.requestToolpath,
    })
    // Subscribe on the first render: the demand effect and the acquisition
    // effect run after it, so every job either of them starts is counted.
    const [jobCounter] = useState(() => counter)
    jobCounter.attach(generation.service)
    // eslint-disable-next-line react-hooks/globals -- the observation this probe exists for
    captured = {
      result: model.simulationResult,
      pending: model.simulationInputPending,
      status: generation.generationStatus,
      service: generation.service,
    }
    return null
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  return {
    captured: () => captured,
    counter,
    state,
    async render() {
      await act(async () => {
        root.render(createElement(Probe))
        await tick()
      })
    },
    async settle(ticks = 4) {
      for (let index = 0; index < ticks; index += 1) {
        await act(async () => { await tick() })
      }
    },
    async waitForResult() {
      for (let attempt = 0; attempt < 4000 && captured.result === null; attempt += 1) {
        await act(async () => { await tick() })
      }
      assert(captured.result, 'the simulation result arrives')
    },
    async waitForPaths(ids) {
      const context = { project, documentKey: 0 }
      for (let attempt = 0; attempt < 4000; attempt += 1) {
        const service = captured.service
        if (service && ids.every((id) => service.peekCurrent(context, id) !== null)) return
        await act(async () => { await tick() })
      }
      throw new Error(`the service never produced ${ids.join(', ')}`)
    },
    async unmount() {
      await act(async () => { root.unmount() })
      host.remove()
    },
  }
}

// ── The two boundary checks ─────────────────────────────────────

/** The Sketch/3D view generated both paths; opening the tab must not redo it. */
async function warmSwitchStartsNoGeneration(): Promise<void> {
  console.log('Testing a warm Simulation tab switch starts no generation job...')
  const { project, operations } = makeProject()
  // The finish is the interesting selection: its playback stock is the prior
  // rough operation, so the tab has something to acquire.
  const selected = operations[1]!
  const harness = mount(project, { centerTab: 'sketch', selected, deferred: false })
  try {
    await harness.render()
    await harness.waitForPaths(operations.map((candidate) => candidate.id))
    // The preview's own jobs are the baseline; nothing below may add one.
    const previewJobs = harness.counter.starts.length
    harness.counter.reset()

    harness.state.centerTab = 'simulation'
    await harness.render()
    await harness.waitForResult()
    await harness.settle()

    const result = harness.captured().result
    assert(result, 'the simulation result is installed')
    assert(
      harness.counter.starts.length === 0,
      `the tab switch started ${harness.counter.starts.length} generation job(s) (${harness.counter.starts.join(', ')}) over the preview's ${previewJobs}`,
    )
    assert(result.stats.removedCellCount > 0, 'the selected cut is simulated from the cached path')
  } finally {
    await harness.unmount()
  }
}

/** With the preview deferred, the acquisition itself must ask the service. */
async function deferredPreviewStillAcquiresThroughTheService(): Promise<void> {
  console.log('Testing a deferred preview still acquires the prior path through the service...')
  const { project, operations } = makeProject()
  const selected = operations[1]!
  const harness = mount(project, { centerTab: 'simulation', selected, deferred: true })
  try {
    await harness.render()
    await harness.waitForResult()
    await harness.settle()

    assert(
      harness.counter.starts.join(',') === 'opRough',
      `exactly the prior operation is generated through the service, got [${harness.counter.starts.join(', ')}]`,
    )
    const status = harness.captured().status
    assert(status?.operations.get('opRough') === 'ready', 'the prior operation became ready: the tab really asked the service')
    assert(!status?.operations.has('opFinish'), 'the tab never generates the selected operation, which is the preview\'s job')
    const result = harness.captured().result
    assert(result, 'the panel settles instead of waiting for a path nobody will generate')
    assert(result.stats.removedCellCount === 0, 'without the preview there is no selected path to simulate yet')
  } finally {
    await harness.unmount()
  }
}

await warmSwitchStartsNoGeneration()
await deferredPreviewStillAcquiresThroughTheService()
console.log('simulation acquisition tests passed')
