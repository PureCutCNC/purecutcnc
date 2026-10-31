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
 * What the operation properties' reach section shows (issue #1112 item 38):
 *
 *  - a target cut from one setup only has no card and no check button — the
 *    panel says nothing about it;
 *  - a target cut from both Top and Bottom is explained in one line, offers
 *    "Check the passes meet", and shows the meets/gap result once the check has
 *    run. The "Unverified" line belongs to that two-sided card and disappears
 *    when the check measures both passes;
 *  - a target the setup cannot reach at all keeps its error line (it is not a
 *    measurement) and still gets no check button.
 *
 * The check runs through the component's own `requestToolpath` prop, so the
 * test supplies measured toolpaths instead of generating them.
 *
 * Mutations checked against these assertions:
 *  - `visibleTargetReach` filtered on `verdict.through` (the old rule) → the
 *    one-sided test finds a card and a button;
 *  - the intro line or the result line dropped from the render → the two-sided
 *    test fails;
 *  - the unmeasured "Unverified" line left out → the pre-check assertion fails.
 *
 * Run with: npx tsx src/components/cam/setupReachPanel.test.ts
 */

import * as React from 'react'
import { createElement } from 'react'
import { parseHTML } from 'linkedom'
import { SetupOperationControls } from './SetupOperationControls'
import { I18nProvider } from '../../i18n/I18nProvider'
import { enMessages } from '../../i18n/locales/en'
import { useProjectStore } from '../../store/projectStore'
import { projectWithFeatures, withBottomSetup } from '../../test/projectFixtures'
import { syncProjectSetups } from '../../store/helpers/setups'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SetupFace, SketchFeature } from '../../types/project'
import type { ToolpathResult } from '../../engine/toolpaths/types'

// A DOM for the client render, in place before React DOM is first imported.
const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
// Node 20 (CI) has no global `navigator`; the i18n store reads its languages.
if (typeof globals.navigator === 'undefined') globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
globals.Element = window.Element
globals.Node = window.Node
// Components are authored with the automatic JSX runtime; the tsx runner
// transpiles this file with the classic one, which expects a global `React`.
;(globalThis as unknown as { React?: typeof React }).React = React

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function feature(id: string, x: number, zBottom = 0): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: { profile: rectProfile(x, 10, 20, 20), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: 20,
    z_bottom: zBottom,
    authoringFace: 'top' as SetupFace,
    visible: true,
    locked: false,
  }
}

function operation(id: string, featureIds: string[]): Operation {
  return {
    id,
    name: id,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
  }
}

/**
 * A 100 × 80 × 20 stock with a hole at x 65 → 85, y 10 → 30. One operation
 * always cuts it from Bottom; `topPass` decides whether a second operation
 * cuts it from Top (the difference between one-sided and two-sided), and
 * `blind` makes the feature stop above Bottom, so Bottom cannot reach it.
 */
function makeProject(options: { topPass?: boolean; blind?: boolean } = {}): Project {
  const base = newProject('reach', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1' }]
  const withFeatures = projectWithFeatures(base, [feature('pin', 65, options.blind ? 14 : 0)])
  const operations = [...(options.topPass ? [operation('topOp', ['pin'])] : []), operation('bottomOp', ['pin'])]
  return withBottomSetup(
    syncProjectSetups({ ...withFeatures, operations }),
    { operationIds: ['bottomOp'] },
  )
}

/** A generated toolpath whose only cut sits in the hole at `z`. */
function toolpath(operationId: string, z: number): ToolpathResult {
  return {
    operationId,
    moves: [{ kind: 'cut', from: { x: 75, y: 20, z }, to: { x: 75, y: 20, z } }],
    warnings: [],
    bounds: null,
  }
}

/** The stock-Z the fake generator reaches for each operation; absent = no toolpath. */
function measuredBy(zByOperation: Readonly<Record<string, number>>) {
  return async (id: string): Promise<ToolpathResult | null> => {
    const z = zByOperation[id]
    return z === undefined ? null : toolpath(id, z)
  }
}

interface Mounted {
  host: HTMLElement
  text(): string
  html(): string
  button(label: string): HTMLElement | null
  unmount(): void
}

async function mount(project: Project, requestToolpath: (id: string, purpose: 'booklet', signal?: AbortSignal) => Promise<ToolpathResult | null>): Promise<Mounted> {
  useProjectStore.setState({ project })
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const operation = project.operations.find((entry) => entry.id === 'bottomOp')!
  flushSync(() => root.render(createElement(I18nProvider, null, createElement(SetupOperationControls, { operation, requestToolpath }))))
  return {
    host,
    text: () => host.textContent ?? '',
    html: () => host.innerHTML,
    button: (label: string): HTMLElement | null => {
      for (const candidate of host.querySelectorAll('button')) {
        if ((candidate.textContent ?? '').trim() === label) return candidate as unknown as HTMLElement
      }
      return null
    },
    unmount: () => {
      flushSync(() => root.unmount())
      host.remove()
    },
  }
}

/** React flushes an async state update on its own schedule; poll the DOM for it. */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function testOneSidedHasNoCardOrButton(): Promise<void> {
  const view = await mount(makeProject(), measuredBy({ bottomOp: 9 }))
  try {
    assert(!view.html().includes('cam-setup-reach'), 'a target cut from one setup renders no reach section')
    assert(!view.text().includes(enMessages['cam.setup.unverified']), 'no "Unverified" line for a one-sided target')
    assert(view.button(enMessages['cam.setup.checkPasses']) === null, 'no check button for a one-sided target')
    assert(view.button(enMessages['cam.setup.checkingPasses']) === null, 'not even the checking label')
  } finally {
    view.unmount()
  }
}

async function testTwoSidedExplainsAndMeasures(): Promise<void> {
  const view = await mount(makeProject({ topPass: true }), measuredBy({ topOp: 8, bottomOp: 9 }))
  try {
    const intro = enMessages['cam.setup.reachIntro.one']
    assert(view.text().includes(intro), 'the two-sided card explains itself in one line')
    const check = view.button(enMessages['cam.setup.checkPasses'])
    assert(check !== null, 'the two-sided card offers the check')
    assert(view.text().includes(enMessages['cam.setup.unverified']), 'nothing is measured before the check: unverified')
    assert(!view.text().includes('Meets the other pass'), 'no meets result before the check')
    assert(view.html().includes('cam-setup-reach__target'), 'the card is the reach card, not a stray paragraph')

    check.click()
    await waitFor(() => view.text().includes('Meets the other pass'), 'the meets result')
    assert(view.text().includes('Meets the other pass · overlap 1 mm'), `the overlap is the measured one: ${view.text()}`)
    assert(view.text().includes('Generated reach in stock Z:'), 'the measured reach is shown')
    assert(!view.text().includes(enMessages['cam.setup.unverified']), 'the check measured both passes: no unverified line')
  } finally {
    view.unmount()
  }
}

async function testTwoSidedGapResult(): Promise<void> {
  const view = await mount(makeProject({ topPass: true }), measuredBy({ topOp: 12, bottomOp: 9 }))
  try {
    view.button(enMessages['cam.setup.checkPasses'])!.click()
    await waitFor(() => view.text().includes('Gap between passes:'), 'the gap result')
    assert(view.text().includes('Gap between passes: 3 mm'), `the gap is the measured one: ${view.text()}`)
  } finally {
    view.unmount()
  }
}

// "Cannot reach" is not a reach measurement: it keeps its error line, gets no
// depth/reach lines, and is no reason to offer a check.
async function testRejectedTargetKeepsOnlyItsError(): Promise<void> {
  const view = await mount(makeProject({ blind: true }), measuredBy({ bottomOp: 9 }))
  try {
    assert(view.text().includes(enMessages['cam.setup.unreachable']), '"cannot reach" is still reported')
    assert(!view.text().includes(enMessages['cam.setup.unverified']), 'an unreachable target claims no measurement')
    assert(!view.text().includes(enMessages['cam.setup.reachIntro.one']), 'there is nothing cut from both sides to explain')
    assert(view.button(enMessages['cam.setup.checkPasses']) === null, 'there is no middle to check: no button')
  } finally {
    view.unmount()
  }
}

await testOneSidedHasNoCardOrButton()
await testTwoSidedExplainsAndMeasures()
await testTwoSidedGapResult()
await testRejectedTargetKeepsOnlyItsError()

console.log('setup reach panel tests passed')
