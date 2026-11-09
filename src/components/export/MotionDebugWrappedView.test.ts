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
 * The 3D wrapped view's two UI contracts (review of #1179).
 *
 * The review of the slice found the dialog's sidebar answering neither way in
 * 3D: unchecking a layer changed `object.visible` without requesting a render,
 * so the pixels stayed until the next orbit or resize, and the cutting-level and
 * non-cutting filters were not passed to the wrapped view at all, so every level
 * and rapid stayed on screen.
 *
 * Both are drawn-state contracts, so this suite mounts the real component and
 * watches the real renderer calls (injected, because the unit suite has no
 * WebGL2 context) and the real `data-motion-pieces` count:
 *
 *  - unchecking Exported must both request a draw and report zero drawn pieces;
 *  - the level and non-cutting props must change how many pieces are drawn,
 *    with the same rule the 2D plan applies.
 *
 * Mutations checked one at a time:
 *  - the `renderRef.current?.()` call dropped from the visibility effect →
 *    "a layer toggle requests a draw" fails with the render count unchanged;
 *  - `filterWrappedPieces` skipped in the scene build and in the reported count
 *    → the filter assertions fail, both props reading as ignored.
 *
 * Run with: npx tsx src/components/export/MotionDebugWrappedView.test.ts
 */

import * as React from 'react'
import type { WebGLRenderer } from 'three'
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
Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
// The view measures its host with a ResizeObserver; there is no layout here, so
// the initial measurement is all that runs.
globals.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { React?: typeof React }).React = React

const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { ThemeContext } = await import('../../theme/themeContext')
type ThemeContextValue = import('../../theme/themeContext').ThemeContextValue
const { MotionDebugWrappedView } = await import('./MotionDebugWrappedView')
const { roundStock } = await import('../../types/project')
type BarStock = import('../../types/project').BarStock
type WrappedPiece = import('./motionDebugWrapped').WrappedPiece
type MotionDebugLayerId = import('../../engine/gcode/motionDebug').MotionDebugLayerId
type WrappedViewLayer = import('./MotionDebugWrappedView').WrappedViewLayer

/** The A span the fixture program commands. */
const A_RANGE = { min: 0, max: 90 }
const BAR: BarStock = roundStock(20, 100, 'x')
const ALL_LAYERS_VISIBLE: Record<MotionDebugLayerId, boolean> = {
  generated: true,
  optimized: true,
  exported: true,
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/**
 * Two cutting pieces at Z=10, one at Z=8, and one rapid at Z=12 — the four
 * cases the sidebar filters can produce (selected level, other level, hidden
 * rapid, shown rapid).
 */
function exportedPieces(): WrappedPiece[] {
  return [
    { from: { x: 0, y: 10, z: 10 }, to: { x: 5, y: 10, z: 10 }, rapid: false, cutting: true, z: 10, aFrom: 0, aTo: 5 },
    { from: { x: 5, y: 10, z: 10 }, to: { x: 10, y: 10, z: 10 }, rapid: false, cutting: true, z: 10, aFrom: 5, aTo: 10 },
    { from: { x: 10, y: 10, z: 8 }, to: { x: 15, y: 10, z: 8 }, rapid: false, cutting: true, z: 8, aFrom: 10, aTo: 15 },
    { from: { x: 0, y: 10, z: 12 }, to: { x: 5, y: 10, z: 12 }, rapid: true, cutting: false, z: 12, aFrom: 15, aTo: 20 },
  ]
}

function layers(): WrappedViewLayer[] {
  return [
    { id: 'generated', color: '#e69138', opacity: 0.65, pieces: [] },
    { id: 'optimized', color: '#3d7df4', opacity: 0.6, pieces: [] },
    { id: 'exported', color: '#d6336c', opacity: 0.9, pieces: exportedPieces() },
  ]
}

/** Only the palette the scene reads: the clear colour and the bar's. */
const themeValue = {
  palette: { three: { background: '#000000', stockDefault: '#888888' } },
} as unknown as ThemeContextValue

interface RenderLog {
  renders: number
  disposed: number
}

/**
 * A renderer that records each draw and disposal. Every other member the view
 * touches is a no-op; the real scene graph and orbit controls still run, so the
 * effect under test is the real one.
 */
function fakeRendererFactory(log: RenderLog): () => WebGLRenderer {
  return () => {
    const canvas = document.createElement('canvas')
    const renderer = {
      domElement: canvas,
      setPixelRatio: () => undefined,
      setSize: () => undefined,
      setClearColor: () => undefined,
      render: () => { log.renders += 1 },
      dispose: () => { log.disposed += 1 },
    }
    return renderer as unknown as WebGLRenderer
  }
}

interface Props {
  stock: BarStock
  layers: WrappedViewLayer[]
  visibleLayers: Record<MotionDebugLayerId, boolean>
  selectedZ: number | 'all'
  showNonCutting: boolean
  aRange: { min: number; max: number } | null
}

const BASE_PROPS: Props = {
  stock: BAR,
  layers: layers(),
  visibleLayers: ALL_LAYERS_VISIBLE,
  selectedZ: 'all',
  showNonCutting: false,
  aRange: A_RANGE,
}

interface Mounted {
  host: HTMLElement
  render: (props: Props) => void
  canvasCount: () => number
  unmount: () => void
}

function mount(log: RenderLog): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const factory = fakeRendererFactory(log)
  const render = (props: Props) => {
    flushSync(() => root.render(React.createElement(I18nProvider, null,
      React.createElement(ThemeContext.Provider, { value: themeValue },
        React.createElement(MotionDebugWrappedView, { ...props, rendererFactory: factory }),
      ),
    )))
  }
  render(BASE_PROPS)
  return {
    host,
    render,
    canvasCount: () => host.querySelectorAll('canvas').length,
    unmount: () => {
      flushSync(() => root.unmount())
      host.remove()
    },
  }
}

async function flush(): Promise<void> {
  // Passive effects land after the commit; one macrotask is enough here.
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function drawnPieces(host: HTMLElement): number {
  const element = host.querySelector('[data-testid="motion-debug-3d"]')
  return Number(element?.getAttribute('data-motion-pieces') ?? '-1')
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

await test('a layer toggle requests a draw instead of leaving stale pixels', async () => {
  const log: RenderLog = { renders: 0, disposed: 0 }
  const mounted = mount(log)
  try {
    await flush()
    assert(mounted.canvasCount() === 1, 'the scene built one canvas')
    const atMount = log.renders
    assert(atMount > 0, `the scene drew on mount, got ${atMount} draws`)
    assert(drawnPieces(mounted.host) === 3, `the three cutting pieces are drawn, got ${drawnPieces(mounted.host)}`)

    // The finding: hiding the exported layer changed visibility but never drew.
    mounted.render({ ...BASE_PROPS, visibleLayers: { ...ALL_LAYERS_VISIBLE, exported: false } })
    await flush()
    assert(log.renders > atMount,
      `unchecking Exported requested a draw, render count stayed ${atMount}`)
    assert(drawnPieces(mounted.host) === 0,
      `a hidden exported layer draws nothing, reported ${drawnPieces(mounted.host)}`)

    const afterHide = log.renders
    mounted.render({ ...BASE_PROPS, visibleLayers: ALL_LAYERS_VISIBLE })
    await flush()
    assert(log.renders > afterHide,
      `rechecking Exported requested a draw, render count stayed ${afterHide}`)
    assert(drawnPieces(mounted.host) === 3,
      `rechecking restores the three cutting pieces, reported ${drawnPieces(mounted.host)}`)
  } finally {
    mounted.unmount()
  }
})

await test('the sidebar level and non-cutting filters reach the 3D view', async () => {
  const log: RenderLog = { renders: 0, disposed: 0 }
  const mounted = mount(log)
  try {
    await flush()

    // All cutting levels, rapids hidden (the dialog's default unchecked box).
    assert(drawnPieces(mounted.host) === 3,
      `all cutting levels draw three pieces, reported ${drawnPieces(mounted.host)}`)

    // One cutting level: the Z=8 piece and the rapid are not at Z=10.
    mounted.render({ ...BASE_PROPS, selectedZ: 10 })
    await flush()
    assert(drawnPieces(mounted.host) === 2,
      `Z=10 draws its two pieces, reported ${drawnPieces(mounted.host)}`)

    // Non-cutting on: the rapid at Z=12 joins the selected level.
    mounted.render({ ...BASE_PROPS, selectedZ: 10, showNonCutting: true })
    await flush()
    assert(drawnPieces(mounted.host) === 3,
      `Z=10 plus non-cutting draws three pieces, reported ${drawnPieces(mounted.host)}`)

    // Every level plus non-cutting is the unfiltered scene.
    mounted.render({ ...BASE_PROPS, showNonCutting: true })
    await flush()
    assert(drawnPieces(mounted.host) === 4,
      `all levels plus non-cutting draw four pieces, reported ${drawnPieces(mounted.host)}`)

    // A level nothing was cut at draws nothing, rather than everything.
    mounted.render({ ...BASE_PROPS, selectedZ: 4 })
    await flush()
    assert(drawnPieces(mounted.host) === 0,
      `an empty level draws nothing, reported ${drawnPieces(mounted.host)}`)
  } finally {
    mounted.unmount()
  }
})

await test('closing the view disposes the renderer and removes the canvas', async () => {
  const log: RenderLog = { renders: 0, disposed: 0 }
  const mounted = mount(log)
  await flush()
  assert(mounted.canvasCount() === 1, 'the scene built one canvas')
  mounted.unmount()
  assert(log.disposed >= 1, `the renderer was disposed, got ${log.disposed} disposals`)
  assert(mounted.canvasCount() === 0, 'the canvas left with the view')
})

if (failed > 0) {
  console.error(`MotionDebugWrappedView tests failed: ${failed} of ${passed + failed}`)
  process.exit(1)
}
console.log(`MotionDebugWrappedView tests passed (${passed})`)
