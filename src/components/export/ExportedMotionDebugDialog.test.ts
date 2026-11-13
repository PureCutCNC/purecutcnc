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
 * The debug dialog's drawing area while the trace is prepared (issue #1183).
 *
 * Acquiring the generation trace is a request, and on a big rotary toolpath it
 * takes seconds. The drawing area used to say "Warning" the whole time, which
 * is the verification verdict's word and reads as a fault; a failed request
 * said "Warning" too and threw the caught message away. The operator could not
 * tell "still preparing" from "it broke".
 *
 * This suite renders the real dialog and holds the three states the area can be
 * in:
 *
 *  - request pending → it says the exported motion is being prepared, and no
 *    "Warning" is on screen;
 *  - request rejecting → it says it could not prepare the motion and carries
 *    the message it caught;
 *  - request resolving → the drawing replaces that text, so the placeholder is
 *    a real transition rather than a permanent state.
 *
 * Mutations checked one at a time:
 *  - the `!model` branch put back to `t('dialogs.motionDebug.warning')` → the
 *    pending test reads "Warning" and fails;
 *  - the failure branch put back to the same word → the rejecting test fails
 *    with the message missing;
 *  - the success path not clearing the preparation state → the resolving test
 *    finds the preparing text where the SVG should be.
 *
 * Run with: npx tsx src/components/export/ExportedMotionDebugDialog.test.ts
 */

import * as React from 'react'
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
// The dialog measures its drawing frame before it can fit a viewBox. There is
// no layout under linkedom, so the frame is given a real size here; without it
// the SVG is never drawn and the resolving test could not tell the two states
// apart.
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => 800,
})
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get: () => 600,
})
// The viewport observer never fires here; the dialog's initial measurement is
// all that runs, which is enough to place the drawing.
globals.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { React?: typeof React }).React = React

const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { interpolate } = await import('../../i18n/catalog')
const { enMessages } = await import('../../i18n/locales/en')
const { ExportedMotionDebugDialog } = await import('./ExportedMotionDebugDialog')
const { newProject, defaultTool } = await import('../../types/project')
const { validateMachineDefinition } = await import('../../engine/gcode/types')
const { runPostProcessor } = await import('../../engine/gcode/postprocessor')
const { normalizeToolForProject } = await import('../../engine/toolpaths/geometry')
type Project = import('../../types/project').Project
type Operation = import('../../types/project').Operation
type MachineDefinition = import('../../engine/gcode/types').MachineDefinition
type PostProcessorResult = import('../../engine/gcode/types').PostProcessorResult
type ToolpathGenerationTrace = import('../../engine/toolpaths/types').ToolpathGenerationTrace
type ToolpathMove = import('../../engine/toolpaths/types').ToolpathMove
type ToolpathResult = import('../../engine/toolpaths/types').ToolpathResult

/** The drawing area's state text: the placeholder the dialog renders while it
 *  has no drawing, whichever reason it has for that. */
const STATUS = '[data-testid="motion-debug-status"]'

/** The English catalog's sentences, so the assertions cannot drift from them. */
const PREPARING = enMessages['dialogs.motionDebug.preparing']
const WARNING = enMessages['dialogs.motionDebug.warning']

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** The machine the fixture project exports with: a plain milling definition. */
function grblDefinition(): MachineDefinition {
  return validateMachineDefinition({
    id: 'test-grbl',
    name: 'TestGRBL',
    description: 'Test GRBL controller',
    fileExtension: 'nc',
    coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
    numberFormat: { decimalPlaces: { mm: 3, inch: 4 }, trailingZeros: false, leadingZero: true },
    units: { mmCommand: 'G21', inchCommand: 'G20' },
    program: {
      header: [],
      footer: [],
      commentPrefix: '(',
      commentSuffix: ')',
      lineNumbers: false,
      lineNumberIncrement: 10,
    },
    workCoordinates: { selectCommand: null },
    motion: {
      rapidCommand: 'G0',
      linearCommand: 'G1',
      cwArcCommand: 'G2',
      ccwArcCommand: 'G3',
      arcFormat: 'ij',
      modalMotion: true,
      arcInterpolation: true,
    },
    feedSpeed: {
      feedCommand: 'F',
      rpmCommand: 'S',
      spindleOnCW: 'M3',
      spindleOnCCW: 'M4',
      spindleOff: 'M5',
      inlineWithMotion: true,
      modalFeedSpeed: true,
    },
    toolChange: { commands: [], stopSpindleFirst: true, pauseAfterChange: false, pauseCommand: 'M0' },
    cannedCycles: null,
    coolant: null,
    stop: { programEndCommand: 'M30' },
  })
}

const DEFINITION = grblDefinition()

function fixtureProject(): Project {
  const project = newProject('Motion debug states', 'mm')
  project.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Test End Mill' }]
  return project
}

function fixtureOperation(): Operation {
  return {
    id: 'op-plan',
    name: 'Pocket',
    description: '',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'stock' },
    toolRef: 't1',
    stepdown: 1,
    stepover: 0.4,
    feed: 600,
    plungeFeed: 180,
    rpm: 12000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
  }
}

/**
 * A flat square pocket at one cutting level: eligible for the plan view, and
 * with no rotary angle, so the 3D wrapped view is never built here.
 */
function fixtureMoves(): ToolpathMove[] {
  return [
    { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 0, y: 0, z: 5 } },
    { kind: 'plunge', from: { x: 0, y: 0, z: 5 }, to: { x: 0, y: 0, z: -1 } },
    { kind: 'cut', from: { x: 0, y: 0, z: -1 }, to: { x: 10, y: 0, z: -1 } },
    { kind: 'cut', from: { x: 10, y: 0, z: -1 }, to: { x: 10, y: 10, z: -1 } },
    { kind: 'cut', from: { x: 10, y: 10, z: -1 }, to: { x: 0, y: 10, z: -1 } },
    { kind: 'rapid', from: { x: 0, y: 10, z: -1 }, to: { x: 0, y: 10, z: 5 } },
  ]
}

const PROJECT = fixtureProject()
const OPERATION = fixtureOperation()

function fixtureToolpath(): ToolpathResult {
  return { operationId: OPERATION.id, warnings: [], bounds: null, moves: fixtureMoves() }
}

/** The program the Export dialog would have prepared for the operation. */
function fixturePreview(): PostProcessorResult {
  return runPostProcessor({
    project: PROJECT,
    definition: DEFINITION,
    operations: [{
      operation: OPERATION,
      tool: normalizeToolForProject(PROJECT.tools[0], PROJECT),
      toolpath: fixtureToolpath(),
    }],
    options: { emitToolChanges: false, emitCoolant: false, captureMotionTrace: true },
  })
}

const PREVIEW = fixturePreview()

interface Mounted {
  host: HTMLElement
  /** Resolves once `predicate` sees the state the dialog has rendered. */
  waitFor: (predicate: () => boolean, what: string) => Promise<void>
  unmount: () => void
}

function mount(request: (operationId: string, signal?: AbortSignal) => Promise<ToolpathGenerationTrace | null>): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(React.createElement(I18nProvider, null,
    React.createElement(ExportedMotionDebugDialog, {
      operation: OPERATION,
      requestGenerationTrace: request,
      project: PROJECT,
      definition: DEFINITION,
      previewResult: PREVIEW,
      onClose: () => {},
    }),
  )))
  return {
    host,
    waitFor: async (predicate, what) => {
      const deadline = Date.now() + 10_000
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    unmount: () => {
      flushSync(() => root.unmount())
      host.remove()
    },
  }
}

/** Let the pending request's continuation and React's passive effects run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function statusText(host: HTMLElement): string {
  return host.querySelector(STATUS)?.textContent?.trim() ?? ''
}

function hostText(host: HTMLElement): string {
  return host.textContent ?? ''
}

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`   \u2713 ${name}`)
  } catch (error) {
    failed += 1
    console.log(`   \u2717 ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

await test('a pending trace says it is preparing, not "Warning"', async () => {
  // Never settles: the request is in flight for as long as the test looks.
  const mounted = mount(() => new Promise<ToolpathGenerationTrace | null>(() => {}))
  try {
    await flush()
    assert(statusText(mounted.host) === PREPARING,
      `the drawing area says it is preparing, got "${statusText(mounted.host)}"`)
    assert(!hostText(mounted.host).includes(WARNING),
      'the "Warning" verdict word is not shown while the trace is still preparing')
  } finally {
    mounted.unmount()
  }
})

await test('a rejected trace shows the message it caught', async () => {
  const FAILURE = 'trace stream closed unexpectedly'
  const mounted = mount(() => Promise.reject(new Error(FAILURE)))
  try {
    // Wait for the failure text to replace the preparing one, so the old
    // placeholder fails here by staying empty rather than by comparing an
    // absent message.
    await mounted.waitFor(() => {
      const text = statusText(mounted.host)
      return text !== '' && text !== PREPARING
    }, 'the failure to replace the preparing text')
    const expected = interpolate(enMessages['dialogs.motionDebug.prepareFailed'], { message: FAILURE })
    assert(statusText(mounted.host) === expected,
      `the drawing area reports the failure, got "${statusText(mounted.host)}"`)
    assert(hostText(mounted.host).includes(FAILURE),
      `the caught message is on screen, got "${statusText(mounted.host)}"`)
    assert(!hostText(mounted.host).includes(WARNING),
      'the failure is reported with its message instead of the "Warning" verdict word')
  } finally {
    mounted.unmount()
  }
})

await test('a resolved trace replaces the preparing text with the drawing', async () => {
  const toolpath = fixtureToolpath()
  const mounted = mount(async () => ({ operationId: OPERATION.id, raw: toolpath, optimized: toolpath }))
  try {
    await mounted.waitFor(() => mounted.host.querySelector('.motion-debug__svg') !== null,
      `the drawing to appear, saw "${statusText(mounted.host)}"`)
    assert(statusText(mounted.host) === '',
      `the preparing text is gone once the drawing is up, got "${statusText(mounted.host)}"`)
    assert(!hostText(mounted.host).includes(PREPARING), 'the preparing sentence left with the placeholder')
  } finally {
    mounted.unmount()
  }
})

if (failed > 0) {
  console.error(`ExportedMotionDebugDialog tests failed: ${failed} of ${passed + failed}`)
  process.exit(1)
}
console.log(`ExportedMotionDebugDialog tests passed (${passed})`)
