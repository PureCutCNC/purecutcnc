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
 * The four rotary canned kinds have no Z range in Properties (issue #1112
 * rt6-a, item 39). A Thread and Flutes replace it with a line naming the Depth,
 * the surface it is measured from and where that surface sits (rt6-c); a Turn
 * and a Polygon show no line at all (rt7-b), because their own summary already
 * names the diameter or across flats and the Z it reaches.
 *
 * Frank: "what is the purpose of the Z top/bottom for the rotary canned
 * features? it does not seem to make sense." It has none — the span is built
 * from the parameter the Edit panel writes (Thread/Flutes Depth, Turn Diameter,
 * Polygon across flats) — so the control is gone. Then, of the read-only line:
 * "I don't think we need to show this again for turn", "same for the hex". A
 * plain canned shape and an imported model keep their Z control, and a mixed
 * selection edits only the shapes that own one.
 *
 * The panel is rendered for real: the Z control lives on the Instance tab and
 * the orientation section on its own, so both are opened the way a click does.
 * Mutations checked one at a time against these assertions:
 * - `cannedZOwned` forced false (the Z control shown for the four rotary kinds)
 *   → "a Thread has no Z range control" fails;
 * - the multi-selection exclusion dropped → the mixed-selection assertion
 *   fails, because the Turn's span is overwritten with the shared Z top;
 * - `zFromParameters={false}` on the orientation section → the Turn's "no Lift
 *   and no height figure" assertion fails;
 * - the Thread line reading `pitch` instead of `depth` → its value assertion
 *   fails;
 * - the surface clause dropped from the Thread line → its "below Turn (Ø …, surface
 *   at Z …)" assertion fails;
 * - the bar's surface Z read as half the thickness (the axis, not the surface)
 *   → the Thread and the warned Flutes lines fail;
 * - `cannedShapeSurface` returning null → the Turn's and Polygon's summary
 *   assertions fail;
 * - the surface Z read from the blank's size instead of its axis → the
 *   square-blank Turn summary assertion fails;
 * - the Turn line shown again (`zSource.turn` back in `REPORTS_Z_SOURCE`) → the
 *   Turn's "no Z-source line" assertion fails;
 * - the Polygon line shown again (`zSource.polygon` back) → the Polygon's
 *   assertion fails;
 * - a Turn/Polygon-only selection falling through to the "follows stock" line
 *   → that selection's assertion fails.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/feature-tree/cannedZRange.test.ts
 */

import assert from 'node:assert/strict'
import React from 'react'
import { parseHTML } from 'linkedom'

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
// Components are authored with the automatic JSX runtime; the tsx runner
// transpiles this file with the classic one, which expects a global `React`.
;(globalThis as unknown as { React?: typeof React }).React = React

const { useProjectStore } = await import('../../store/projectStore')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { PropertiesPanel } = await import('./PropertiesPanel')
const { UnitConversionContext } = await import('../project/UnitConversionContext')
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
const { defaultTool, newProject, rectProfile, roundStock } = await import('../../types/project')
const { squareStock } = await import('../../types/barStock')
const { projectWithFeatures } = await import('../../test/projectFixtures')
const { bundledMachines } = await import('../../machine/registry')
const { validateMachineDefinition } = await import('../../engine/gcode/types')
const { switchWorkspaceFace } = await import('../../store/workspaceFace')

type Project = Awaited<ReturnType<typeof newProject>>
type FeatureDefinition = import('../../types/project').FeatureDefinition
type FeatureInstance = import('../../types/project').FeatureInstance

const store = () => useProjectStore.getState()

const dom = window as unknown as {
  Event: new (type: string, init?: { bubbles?: boolean }) => object
  HTMLInputElement: { prototype: { value: string } }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

// ── fixture ──────────────────────────────────────────────────

/** A rotary project on a round bar: Around is a real face to create on. */
function rotaryProject(): Project {
  const base = newProject('Canned Z', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(40, 200, 'x', { x: 10, y: 30 })
  const machine = validateMachineDefinition({
    ...structuredClone(bundledMachines()[0]),
    id: 'canned-z',
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [{ ...defaultTool('mm', 1), id: 'ball', type: 'ball_endmill', diameter: 4 }]
  return projectWithFeatures(base, [])
}

/**
 * The same rotary project on a **square blank**: its turning axis is still
 * mid-thickness, which is what a Turn's surface Z must use there too.
 */
function squareRotaryProject(): Project {
  const base = rotaryProject()
  base.stock = squareStock(25, 120, 'x')
  return base
}

/**
 * Load the bar project, create the flat ellipse on Top (its own Z control has
 * to keep working) and the four rotary kinds on Around.
 */
function loadWithShapes(): {
  ellipseId: string
  threadId: string
  flutesId: string
  turnId: string
  polygonId: string
} {
  store().loadProject(rotaryProject())
  // The flat ellipse is drawn on the Around sheet so it shares a face with the
  // rotary kinds: a shape on another face is a ghost and cannot be selected
  // beside them, so a mixed selection could not exist otherwise.
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  const before = new Set(store().project.features.map((feature) => feature.id))
  store().addEllipseFeature('Ellipse', 100, 30, 10, 6, 3)
  const created = store().project.features.find((feature) => !before.has(feature.id))
  assert.ok(created, 'the ellipse is created')
  assert.equal(created.authoringFace, 'around', 'the flat shape is drawn on the sheet in view')
  const ellipseId = created.id

  const thread = store().addRotaryPattern({ kind: 'thread', start: 5, length: 20, pitch: 2, starts: 1, depth: 1.2 })
  assert.ok(thread.ok, 'the thread is created')
  const flutes = store().addRotaryPattern({ kind: 'flutes', start: 30, length: 20, count: 4, twist: 0.5, depth: 0.8 })
  assert.ok(flutes.ok, 'the flutes are created')
  const turn = store().addRotarySolid({ kind: 'turn', start: 5, length: 30, diameter: 30 })
  assert.ok(turn.ok, 'the turn is created')
  const polygon = store().addRotarySolid({ kind: 'polygon', start: 100, length: 20, sides: 6, acrossFlats: 20 })
  assert.ok(polygon.ok, 'the polygon is created')

  return {
    ellipseId,
    threadId: thread.featureId,
    flutesId: flutes.featureId,
    turnId: turn.featureId,
    polygonId: polygon.featureId,
  }
}

/** One imported (not generated) model on Top, for the control that must stay. */
function addImportedModel(): string {
  const project = store().project
  const definition: FeatureDefinition = {
    id: 'def-imported',
    kind: 'stl',
    profile: rectProfile(100, 10, 20, 20),
    dimensions: [],
    operation: 'model',
    stl: { format: 'stl', meshAssetId: 'mesh-imported', scale: 1, axisSwap: 'none' },
  }
  const instance: FeatureInstance = {
    id: 'imported-model',
    name: 'Imported model',
    definitionId: definition.id,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    constraints: [],
    z_top: 10,
    z_bottom: 0,
    authoringFace: 'top',
    folderId: null,
    visible: true,
    locked: false,
  }
  useProjectStore.setState({
    project: {
      ...project,
      featureDefinitions: { ...project.featureDefinitions, [definition.id]: definition },
      features: [...project.features, instance],
      featureTree: [...project.featureTree, { type: 'feature', featureId: instance.id }],
    },
  })
  return instance.id
}

// ── the panel, rendered for real ─────────────────────────────

interface Mounted {
  html: () => string
  openSection: (title: string) => void
  unmount: () => void
}

function mount(): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => {
    root.render(React.createElement(
      I18nProvider,
      null,
      React.createElement(
        UnitConversionContext.Provider,
        { value: () => undefined },
        React.createElement(PropertiesPanel),
      ),
    ))
  })
  return {
    html: () => host.innerHTML,
    openSection: (title) => {
      const header = Array.from(host.querySelectorAll('.disclosure-section__header'))
        .find((candidate) => (candidate.textContent ?? '').trim() === title)
      assert.ok(header, `the panel has a "${title}" section`)
      const button = header as unknown as HTMLButtonElement
      if (button.getAttribute('aria-expanded') === 'true') return
      button.click()
    },
    unmount: () => {
      flushSync(() => root.unmount())
      host.remove()
    },
  }
}

/** The read-only line, or null when the panel shows a Z control instead. */
function zSourceLine(mounted: Mounted): { text: string } | null {
  const line = mounted.html().match(/<p[^>]*data-testid="canned-z-source"[^>]*>(.*?)<\/p>/)
  return line ? { text: line[1] } : null
}

/** How many Z-source lines the panel shows (a multi-selection can show several). */
function zSourceLineCount(mounted: Mounted): number {
  return mounted.html().match(/data-testid="canned-z-source"/g)?.length ?? 0
}

/** The `Shape` summary line, which names the surface a Turn/Polygon reaches. */
function summaryLine(mounted: Mounted): { text: string } | null {
  const line = mounted.html().match(/<p[^>]*data-testid="canned-shape-summary"[^>]*>(.*?)<\/p>/)
  return line ? { text: line[1] } : null
}

function hasZSlider(mounted: Mounted): boolean {
  return mounted.html().includes('z-range-slider')
}

/** Render the panel for one selection with the Instance tab open. */
async function renderSingle(featureId: string): Promise<Mounted> {
  store().selectFeature(featureId)
  const mounted = mount()
  mounted.openSection('Instance')
  await flush()
  return mounted
}

// ── a Thread has no Z control (mutation 1, 2, 5) ─────────────

{
  const { threadId } = loadWithShapes()
  const mounted = await renderSingle(threadId)
  assert.equal(hasZSlider(mounted), false, 'a Thread has no Z range control')
  const line = zSourceLine(mounted)
  assert.ok(line, 'a Thread shows its Depth read-only instead')
  assert.equal(
    line.text,
    'Depth 1.2 mm below Turn (Ø 30 mm, surface at Z 35) · set in Edit thread…',
    'the line names the Edit panel field and value, the surface it is measured from and that surface\'s Z',
  )
  mounted.unmount()
}

// ── Flutes likewise ──────────────────────────────────────────

{
  const { flutesId } = loadWithShapes()
  const mounted = await renderSingle(flutesId)
  assert.equal(hasZSlider(mounted), false, 'Flutes have no Z range control')
  const line = zSourceLine(mounted)
  assert.ok(line, 'Flutes show their Depth read-only instead')
  // This band runs past the Turn's end, so it measures from the bar and repeats
  // the warning word for word instead of claiming the Turn's diameter.
  assert.equal(
    line.text,
    'Depth 0.8 mm below the bar (Ø 40 mm, surface at Z 40) · '
      + "This pattern crosses the end of Turn, where the bar's diameter changes. · set in Edit flutes…",
    'the warned Flutes line says it is measured from the bar and why',
  )
  mounted.unmount()
}

// ── a Turn: no Z-source line, and no lift or height figure ───

{
  const { turnId } = loadWithShapes()
  const mounted = await renderSingle(turnId)
  assert.equal(hasZSlider(mounted), false, 'a Turn has no Z range control')
  // No line either (rt7-b): the Turn's summary below already says Ø30 and where
  // that surface sits, so Frank asked for the repeat to go.
  assert.equal(zSourceLine(mounted), null, 'a Turn shows no Z-source line')
  assert.equal(mounted.html().includes('set in Edit turn'), false, 'and no leftover Turn line')
  assert.equal(mounted.html().includes('Follows stock'), false, 'nor a claim that the Turn follows the stock')

  // The summary names where that diameter's surface sits: the bar axis (20) plus
  // the radius (15) on a Ø40 bar (rt6-c).
  mounted.openSection('Shape')
  await flush()
  const summary = summaryLine(mounted)
  assert.ok(summary, 'a Turn shows its parameter summary')
  assert.equal(
    summary.text,
    'Turn · start 5 · length 30 · Ø30 · surface at Z 35',
    'the Turn summary adds the Z its surface reaches',
  )

  // The orientation section still offers the rotations — but a generated
  // model's height is not something the user lifts or types.
  mounted.openSection('3D orientation')
  await flush()
  const html = mounted.html()
  assert.equal(html.includes('Lift'), false, 'a generated model shows no lift field')
  assert.equal(html.includes('Model height:'), false, 'and no height figure')
  assert.equal(html.includes('Rotate X'), true, 'the rotation controls it keeps are still there')
  assert.equal(html.includes('Reset to import orientation'), true, 'and so is the reset action')
  mounted.unmount()
}

// ── a Polygon: no Z-source line ──────────────────────────────

{
  const { polygonId } = loadWithShapes()
  const mounted = await renderSingle(polygonId)
  assert.equal(hasZSlider(mounted), false, 'a Polygon has no Z range control')
  // Same as the Turn (rt7-b): "same for the hex". Its summary names the across
  // flats and the Z the flats reach, so the line was the same sentence twice.
  assert.equal(zSourceLine(mounted), null, 'a Polygon shows no Z-source line')
  assert.equal(mounted.html().includes('set in Edit polygon'), false, 'and no leftover Polygon line')
  assert.equal(
    mounted.html().includes('Follows stock'),
    false,
    'nor a claim that the Polygon follows the stock',
  )

  // A Polygon presents its flats at the axis plus half the across flats (rt6-c).
  mounted.openSection('Shape')
  await flush()
  const summary = summaryLine(mounted)
  assert.ok(summary, 'a Polygon shows its parameter summary')
  assert.equal(
    summary.text,
    'Polygon · start 100 · length 20 · 6 sides · across flats 20 · rotation 0° · flats at Z 30',
    'the Polygon summary adds the Z its flats reach',
  )
  mounted.unmount()
}

// ── the Turn line's Z on a square blank ──────────────────────
//
// The axis is mid-thickness on a square blank exactly as on a round bar, so a
// Ø20 Turn on a 25 mm blank is at Z 12.5 + 10 = 22.5 — not at the side
// (25 + 10) and not at the corner radius. Reading the blank's size as the axis
// is the mutation.

{
  store().loadProject(squareRotaryProject())
  assert.equal(switchWorkspaceFace('around'), true, 'a square blank has an Around face')
  const squareTurn = store().addRotarySolid({ kind: 'turn', start: 5, length: 30, diameter: 20 })
  assert.ok(squareTurn.ok, 'the Turn is created on the blank')
  const mounted = await renderSingle(squareTurn.featureId)
  mounted.openSection('Shape')
  await flush()
  const summary = summaryLine(mounted)
  assert.ok(summary, 'a Turn on a square blank shows its summary')
  assert.equal(
    summary.text,
    'Turn · start 5 · length 30 · Ø20 · surface at Z 22.5',
    'the same Turn sits at mid-thickness plus its radius on a square blank',
  )
  mounted.unmount()
}

// ── a plain canned shape keeps its Z control ─────────────────

{
  const { ellipseId } = loadWithShapes()
  const mounted = await renderSingle(ellipseId)
  assert.equal(hasZSlider(mounted), true, 'an ellipse keeps its Z range control')
  assert.equal(zSourceLine(mounted), null, 'and shows no read-only line')
  mounted.unmount()
}

// ── an imported model keeps both its Z control and its lift ──

{
  loadWithShapes()
  assert.equal(switchWorkspaceFace('top'), true, 'Top for the imported model')
  const modelId = addImportedModel()
  const mounted = await renderSingle(modelId)
  assert.equal(hasZSlider(mounted), true, 'an imported model keeps its Z range control')
  assert.equal(zSourceLine(mounted), null, 'and shows no read-only line')
  mounted.openSection('3D orientation')
  await flush()
  const html = mounted.html()
  assert.equal(html.includes('Lift'), true, 'an imported model keeps its lift field')
  assert.equal(html.includes('Model height:'), true, 'and its height figure')
  mounted.unmount()
}

// ── a mixed selection edits only the shapes that own a Z ─────

{
  const { ellipseId, turnId } = loadWithShapes()
  const turnTop = store().project.features.find((feature) => feature.id === turnId)?.z_top
  assert.equal(typeof turnTop, 'number', 'the Turn has a stored span')

  store().selectFeatures([ellipseId, turnId])
  const mounted = mount()
  await flush()
  assert.equal(hasZSlider(mounted), true, 'a mixed selection still shares the Z of the ellipse')

  const field = document.body.querySelector('.properties-panel .z-range-slider__field--top')
  assert.ok(field, 'the shared Z editor has a top field')
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'linkedom has an input value setter')
  // Above the Around sheet's own bottom (the bar surface less the depth), so
  // the shared edit is accepted.
  setter.call(field, '39.5')
  // React dispatches `onBlur` from `focusout`.
  field.dispatchEvent(new dom.Event('focusout', { bubbles: true }) as unknown as Event)
  await flush()

  const after = store().project.features
  assert.equal(after.find((feature) => feature.id === ellipseId)?.z_top, 39.5, 'the ellipse took the shared Z top')
  assert.equal(
    after.find((feature) => feature.id === turnId)?.z_top,
    turnTop,
    'the Turn kept the span its Diameter sets',
  )
  mounted.unmount()
}

// ── a selection of only rotary kinds offers no Z editor ──────

{
  const { threadId, turnId } = loadWithShapes()
  store().selectFeatures([threadId, turnId])
  const mounted = mount()
  await flush()
  assert.equal(hasZSlider(mounted), false, 'no Z editor when every selected shape owns its span')
  assert.equal(
    zSourceLineCount(mounted),
    1,
    'only the Thread reports its value in a Thread + Turn selection',
  )
  const html = mounted.html()
  assert.equal(html.includes('Depth 1.2 mm · set in Edit thread…'), true, 'the Thread value is reported')
  assert.equal(html.includes('set in Edit turn'), false, 'the Turn value is not repeated (rt7-b)')
  mounted.unmount()
}

// ── a Turn + Polygon selection reports nothing at all ────────
//
// Neither kind shows a line now (rt7-b), and neither has a Z editor, so the
// slot must stay empty rather than fall through to "Follows stock" — which
// would be a wrong answer about a shape whose span comes from its parameters.

{
  const { turnId, polygonId } = loadWithShapes()
  store().selectFeatures([turnId, polygonId])
  const mounted = mount()
  await flush()
  assert.equal(hasZSlider(mounted), false, 'no Z editor for a Turn + Polygon selection')
  assert.equal(zSourceLineCount(mounted), 0, 'and no Z-source line for either')
  const html = mounted.html()
  assert.equal(html.includes('Follows stock'), false, 'and no "Follows stock" line either')
  mounted.unmount()
}

console.log('canned Z range tests passed')
