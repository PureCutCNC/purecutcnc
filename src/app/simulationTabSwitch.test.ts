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
 * Opening the Simulation tab twice must not replay the same paths twice
 * (issue #1112 rt2-h).
 *
 * Frank: "there is a delay when switching to the simulation view when rough
 * operation is selected (finish too)". Measured on his `turn-shape-test-01`,
 * a switch back to the rough replayed 24k moves into the heightfield again
 * (86 ms), the finish's playback base replayed the rough a third time (89 ms),
 * and the tab-switch render re-folded the paths (11-25 ms) — none of which can
 * change the result, because none of it depends on the tab being open.
 *
 * This drives the real hook in a real React root (linkedom), with the real
 * heightfield engine and the real generated paths for a small fixture, and
 * asserts the two things a user feels:
 *   - switching away and back installs the result on the switch render itself
 *     (no loading overlay, no second build, the very same grid object);
 *   - pressing play on a later operation starts from the heightfield the
 *     earlier operation's own result already is.
 *
 * Mutations these assertions were checked against, each applied on its own and
 * reverted:
 * - dropping `?? cachedResult` from `simulationResult` → "the result is
 *   installed by the switch render" fails (the overlay comes back);
 * - dropping the cache check from the build effect → the switch back rebuilds,
 *   so "the same result object" fails;
 * - replaying the base grid directly (`priorReplayGrid`) instead of through
 *   `rememberedReplay` → "play starts from the earlier operation's own result"
 *   fails;
 *
 * Run with: NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/app/simulationTabSwitch.test.ts
 */

import * as React from 'react'
import { createElement } from 'react'
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

import { defaultTool, newProject, rectProfile } from '../types/project'
import type { Operation, Project } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { syncProjectSetups } from '../store/helpers/setups'
import type { ToolpathBounds, ToolpathMove, ToolpathResult } from '../engine/toolpaths/types'
import type { SimulationGrid, SimulationResult } from '../engine/simulation/types'
import { useSimulationModel } from './useSimulationModel'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

// ── Fixture: one setup, two pockets over the same rectangle ──────

const STOCK = { x: 0, y: 0, w: 40, h: 30, thickness: 8 }
const RECT = { x: 8, y: 6, w: 12, h: 10 }

function operation(id: string, name: string, setupId: string): Operation {
  return {
    id, name, kind: 'pocket', pass: id === 'opRough' ? 'rough' : 'finish',
    enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'features', featureIds: ['pocket'] }, toolRef: 't1', setupId,
    stepdown: 2, stepover: 0.4, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: true, finishFloor: true, carveDepth: 1, maxCarveDepth: 2,
    cutDirection: 'conventional', machiningOrder: 'level_first',
  }
}

function makeProject(): { project: Project; operations: Operation[] } {
  const base = newProject('tab-switch', 'mm')
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
    operation('opRough', 'Rough pocket', setupId),
    operation('opFinish', 'Finish pocket', setupId),
  ]
  return { project: syncProjectSetups({ ...withFeature, operations }), operations }
}

/** A path the replay can cut: a few passes inside the pocket rectangle. */
function makeToolpath(operation: Operation): ToolpathResult {
  const moves: ToolpathMove[] = []
  for (let level = 0; level < 2; level += 1) {
    const z = STOCK.thickness - 1 - level
    moves.push({ kind: 'plunge', from: { x: RECT.x + 1, y: RECT.y + 1, z: STOCK.thickness }, to: { x: RECT.x + 1, y: RECT.y + 1, z } })
    moves.push({ kind: 'cut', from: { x: RECT.x + 1, y: RECT.y + 1, z }, to: { x: RECT.x + RECT.w - 1, y: RECT.y + 1, z } })
    moves.push({ kind: 'cut', from: { x: RECT.x + RECT.w - 1, y: RECT.y + 1, z }, to: { x: RECT.x + RECT.w - 1, y: RECT.y + RECT.h - 1, z } })
  }
  const bounds: ToolpathBounds = {
    minX: RECT.x, minY: RECT.y, minZ: STOCK.thickness - 2,
    maxX: RECT.x + RECT.w, maxY: RECT.y + RECT.h, maxZ: STOCK.thickness,
  }
  return { operationId: operation.id, moves, warnings: [], bounds }
}

// ── The harness ──────────────────────────────────────────────────

interface Captured {
  result: SimulationResult | null
  pending: boolean
  getBaseGrid: (() => SimulationGrid) | null
}

async function main(): Promise<void> {
  const fixture = makeProject()
  const operations = fixture.operations
  // Mutated by the edit at the end: the store replaces the project object.
  let project = fixture.project
  const paths = new Map(operations.map((op) => [op.id, makeToolpath(op)]))
  // Stable identity, exactly as `useToolpathGeneration` gives it: the
  // generation service answers a cache hit with an already-resolved promise.
  const requestToolpath = async (operationId: string): Promise<ToolpathResult | null> => paths.get(operationId) ?? null

  let captured: Captured = { result: null, pending: false, getBaseGrid: null }
  // Every render, so a claim about what the panel painted can be checked
  // rather than inferred.
  const history: Captured[] = []
  let centerTab: 'sketch' | 'simulation' = 'sketch'
  let selected: Operation | null = operations[0]!

  function Probe() {
    const model = useSimulationModel({
      project,
      centerTab,
      simulationMode: 'selected',
      simulationDetailCells: 120,
      selectedOperation: selected,
      selectedToolpath: selected ? paths.get(selected.id) ?? null : null,
      requestToolpath,
    })
    // The observation this test is made of: what the panel rendered.
    // eslint-disable-next-line react-hooks/globals
    captured = {
      result: model.simulationResult,
      pending: model.simulationInputPending,
      getBaseGrid: model.simulationPlaybackInput?.getBaseGrid ?? null,
    }
    history.push(captured)
    return null
  }

  const { createRoot } = await import('react-dom/client')
  const { act } = React
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  /** Render the hook and let its effects (and any build they start) settle. */
  async function render(): Promise<void> {
    await act(async () => {
      root.render(createElement(Probe))
      await tick()
    })
  }

  /**
   * Switch tab and render, without giving anything a macrotask: the build
   * yields through `setTimeout`, so it cannot have finished when this returns
   * and the observation is the render itself plus the effects it scheduled.
   */
  async function switchTo(tab: 'sketch' | 'simulation'): Promise<void> {
    centerTab = tab
    await act(async () => { root.render(createElement(Probe)) })
  }

  /** Let everything the render scheduled run. */
  async function settle(ticks = 4): Promise<void> {
    for (let index = 0; index < ticks; index += 1) {
      await act(async () => { await tick() })
    }
  }

  async function waitForResult(): Promise<void> {
    for (let attempt = 0; attempt < 200 && captured.result === null; attempt += 1) {
      await act(async () => { await tick() })
    }
    assert(captured.result, 'the simulation result arrives')
  }

  try {
    await render() // mount on the sketch tab

    // ── First open: the switch render is the loading state, a build follows ──
    selected = operations[0]!
    let mark = history.length
    await switchTo('simulation')
    const firstSwitch = history[mark]
    assert(firstSwitch, 'the first open renders')
    assert(firstSwitch.pending, 'the first open commits as a loading state')
    assert(firstSwitch.result === null, 'with no result yet: nothing was replayed in the render')
    await waitForResult()
    const roughResult = captured.result as SimulationResult
    assert(roughResult.grid.topZ.length > 0, 'the first open installs a real heightfield')
    await settle()

    // ── Switch away and back ──
    console.log('Testing a switch back to the same operation reuses its replay...')
    await switchTo('sketch')
    mark = history.length
    await switchTo('simulation')
    await settle()
    const switchBack = history.slice(mark)
    assert(switchBack.length > 0, 'the switch back renders')
    assert(
      switchBack.every((render) => !render.pending),
      'the loading overlay never comes back: the replay cache answers the render',
    )
    assert(captured.result === roughResult, 'the same result object: the replay was not run again')

    // ── The playback starting stock of the finish is the rough's own result ──
    console.log("Testing play on the finish starts from the rough's own heightfield...")
    selected = operations[1]!
    await render() // the selection changes while the tab is open
    await waitForResult()
    await settle()
    const finish = captured.result as SimulationResult
    assert(finish !== roughResult, 'the finish built its own cut')
    const getBaseGrid = captured.getBaseGrid
    assert(getBaseGrid, 'the finish has playback input')
    const base = getBaseGrid()
    assert(base === roughResult.grid, "play starts from the rough's own heightfield, not a second replay")
    assert(base.topZ !== finish.grid.topZ, "and it is not the finish's own cut")

    // ── A switch back to the finish is served from the cache too ──
    await switchTo('sketch')
    mark = history.length
    await switchTo('simulation')
    await settle()
    assert(
      history.slice(mark).every((render) => !render.pending),
      'switching back to the finish paints no overlay either',
    )
    assert(captured.result === finish, 'and reuses its result object')

    // ── An edit is a new document state: every key must miss ──
    console.log('Testing an edit rebuilds instead of reusing the old replay...')
    project = { ...project }
    await render()
    await waitForResult()
    await settle()
    const afterEdit = captured.result as SimulationResult
    assert(afterEdit !== finish, 'an edit makes every key a miss: the replay is built again')
    assert(
      afterEdit.grid.topZ.length === finish.grid.topZ.length
      && afterEdit.grid.topZ.every((value, index) => value === finish.grid.topZ[index]),
      'and it is the same heightfield, so the rebuild is not a different result',
    )
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
  }
}

await main()
console.log('simulation tab switch tests passed')
