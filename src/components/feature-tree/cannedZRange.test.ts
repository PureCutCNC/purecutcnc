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
 * rt6-a, item 39). Frank: "what is the purpose of the Z top/bottom for the
 * rotary canned features? it does not seem to make sense." It has none — the
 * span is built from the parameter the Edit panel writes (Thread/Flutes Depth,
 * Turn Diameter, Polygon across flats) — so the control is gone.
 *
 * Since rt7-d a Thread's or Flutes' Depth is not a line of its own under
 * Instance any more: it is appended to the shape's own **Shape** summary, with
 * the surface the depth is measured from and that surface's Z, and without the
 * "set in Edit …" half the Edit button under the line already implies. A Turn
 * and a Polygon still report nothing (rt7-b), because their summary already
 * names the diameter or across flats and the Z it reaches.
 *
 * rt7-e adds the other half of the same rule: a **generated** model gets no 3D
 * orientation section at all. Frank approved hiding it — Rotate X/Y/Z would tip
 * the solid off the bar axis, turning about the bar is the Polygon editor's
 * Rotation field, and a regenerate would undo a manual rotation. An imported
 * model keeps the section exactly as it was, and the other "Rotate" entries
 * (context menu, toolbar, rail) were the 2D placement transform, which never
 * wrote `stl.orientation` — and since rt7-f that transform is refused for the
 * four rotary kinds altogether (`store/helpers/cannedShapeActions.ts`), so the
 * closest an orientation question gets is a refused start.
 *
 * The panel is rendered for real: the Z control lives on the Instance tab and
 * the orientation section on its own, so both are opened the way a click does.
 * Mutations checked one at a time against these assertions:
 * - `cannedZOwned` forced false (the Z control shown for the four rotary kinds)
 *   → "a Thread has no Z range control" fails;
 * - the multi-selection exclusion dropped → the mixed-selection assertion
 *   fails, because the Turn's span is overwritten with the shared Z top;
 * - `isGeneratedModel` dropped from the orientation-section gate (#1112 rt7-e)
 *   → the Turn's and the Hex's "no 3D orientation section" assertions fail;
 * - the Thread's Depth read from `pitch` instead of `depth` → its merged-line
 *   value assertion fails;
 * - the surface clause dropped from the merged line → the Thread's, both
 *   Flutes' (the warned band and the one wholly on the Turn) and the bare-bar
 *   Thread's "below … (Ø …, surface at Z …)" assertions fail;
 * - the bar's surface Z read as half the thickness (the axis, not the surface)
 *   → the Thread and the warned Flutes lines fail;
 * - the old read-only line rendered again under Instance (a second
 *   `data-testid="canned-z-source"`) → "no second read-only line" and "the
 *   Depth is stated once" fail;
 * - `cannedShapeSurface` returning null → the Turn's and Polygon's summary
 *   assertions fail;
 * - the surface Z read from the blank's size instead of its axis → the
 *   square-blank Turn summary assertion fails;
 * - `cannedShapeDepth` widened to report a Turn or a Polygon → each of their
 *   exact summary assertions fails, because the line would gain a depth clause;
 * - a Turn/Polygon-only selection falling through to the "follows stock" line
 *   → that selection's assertion fails;
 * - `selectedReportsCannedDepth` dropped from the panel condition (the slot
 *   filled only when *every* selected kind owns its span) → the Thread +
 *   construction assertion fails, because the slot claims "Follows stock"
 *   (#1112 rt7-b correction 1, kept by rt7-d).
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
const { resolvedProjectFeatures } = await import('../../store/helpers/resolveFeatures')

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
  hasSection: (title: string) => boolean
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
  const header = (title: string): Element | undefined => Array.from(host.querySelectorAll('.disclosure-section__header'))
    .find((candidate) => (candidate.textContent ?? '').trim() === title)
  return {
    html: () => host.innerHTML,
    hasSection: (title) => header(title) !== undefined,
    openSection: (title) => {
      const found = header(title)
      assert.ok(found, `the panel has a "${title}" section`)
      const button = found as unknown as HTMLButtonElement
      if (button.getAttribute('aria-expanded') === 'true') return
      button.click()
    },
    unmount: () => {
      flushSync(() => root.unmount())
      host.remove()
    },
  }
}

/**
 * The read-only line rt7-d removed, or null when the panel shows none. A Thread
 * or Flutes must never render it again: its Depth lives on the Shape summary.
 */
function zSourceLine(mounted: Mounted): { text: string } | null {
  const line = mounted.html().match(/<p[^>]*data-testid="canned-z-source"[^>]*>(.*?)<\/p>/)
  return line ? { text: line[1] } : null
}

/** The `Shape` summary line, which since rt7-d also carries the Depth. */
function summaryLine(mounted: Mounted): { text: string } | null {
  const line = mounted.html().match(/<p[^>]*data-testid="canned-shape-summary"[^>]*>(.*?)<\/p>/)
  return line ? { text: line[1] } : null
}

/**
 * How many times the panel states one sentence — the merged summary says the
 * Depth once, and a second line (the removed Instance one) would say it twice.
 * Case-insensitive so a line that starts its own sentence still counts.
 */
function statementCount(mounted: Mounted, text: string): number {
  return mounted.html().toLowerCase().split(text.toLowerCase()).length - 1
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

// ── a Thread on a Turn: one line, summary + depth + surface ──
//
// Frank was shown two lines for one shape (issue #1112 rt7-d): "Thread · 1-start
// · pitch 0.2 · length 2" under Shape, and "Depth 0.122 in below Turn (…) · set
// in Edit thread…" under Instance. They are one line now, in the Shape section
// where the summary already was, and the Instance section has nothing to say.

{
  const { threadId } = loadWithShapes()
  const mounted = await renderSingle(threadId)
  mounted.openSection('Shape')
  await flush()
  assert.equal(hasZSlider(mounted), false, 'a Thread has no Z range control')
  const summary = summaryLine(mounted)
  assert.ok(summary, 'a Thread shows its Shape summary line')
  assert.equal(
    summary.text,
    'Thread · 1-start · pitch 2 · length 20 · depth 1.2 mm below Turn (Ø 30 mm, surface at Z 35)',
    'the one line is the summary, then the Depth, its surface and that surface\'s Z',
  )
  assert.equal(zSourceLine(mounted), null, 'no second read-only line under Instance')
  assert.equal(
    statementCount(mounted, 'depth 1.2 mm'),
    1,
    'the Depth is stated once, not once per section',
  )
  mounted.unmount()
}

// ── Flutes likewise ──────────────────────────────────────────

{
  const { flutesId } = loadWithShapes()
  const mounted = await renderSingle(flutesId)
  mounted.openSection('Shape')
  await flush()
  assert.equal(hasZSlider(mounted), false, 'Flutes have no Z range control')
  const summary = summaryLine(mounted)
  assert.ok(summary, 'Flutes show their Shape summary line')
  // This band runs past the Turn's end, so it measures from the bar and repeats
  // the warning word for word instead of claiming the Turn's diameter.
  assert.equal(
    summary.text,
    'Flutes · 4 · twist 0.5 turns · length 20 · depth 0.8 mm below the bar '
      + '(Ø 40 mm, surface at Z 40) · '
      + 'This pattern crosses the end of Turn, where the bar\'s diameter changes.',
    'the warned Flutes line says it is measured from the bar and why',
  )
  assert.equal(zSourceLine(mounted), null, 'no second read-only line under Instance')
  assert.equal(statementCount(mounted, 'depth 0.8 mm'), 1, 'and the Depth is stated once')
  mounted.unmount()
}

// ── Flutes wholly on the Turn: the same line, no warning ─────
//
// The fixture's own Flutes run to 50 while the Turn ends at 35, so they are the
// warned case above. This band (8…28) sits wholly inside that Turn, so nothing
// warns: the same one line must name the Turn, its diameter and that surface's
// Z, and the Instance section must still have nothing to say.

{
  loadWithShapes()
  const contained = store().addRotaryPattern({
    kind: 'flutes',
    start: 8,
    length: 20,
    count: 4,
    twist: 0.5,
    depth: 0.8,
  })
  assert.ok(contained.ok, 'a Flutes band wholly inside the Turn is created')
  const mounted = await renderSingle(contained.featureId)
  mounted.openSection('Shape')
  await flush()
  assert.equal(hasZSlider(mounted), false, 'Flutes have no Z range control')
  const summary = summaryLine(mounted)
  assert.ok(summary, 'Flutes show their Shape summary line')
  assert.equal(
    summary.text,
    'Flutes · 4 · twist 0.5 turns · length 20 · depth 0.8 mm below Turn (Ø 30 mm, surface at Z 35)',
    'a band wholly on the Turn is measured from that Turn, with its diameter and surface Z',
  )
  assert.equal(zSourceLine(mounted), null, 'no second read-only line under Instance')
  assert.equal(statementCount(mounted, 'depth 0.8 mm'), 1, 'and the Depth is stated once')
  mounted.unmount()
}

// ── a Thread with no Turn under it still shows the summary and depth ──
//
// On the bare bar there is no Turn to measure from, so the bar supplies the
// surface — the same clause the removed line carried (rt7-d keeps the values and
// their computation, only where they are shown moves).

{
  // The Turn is created after the Thread, so the Thread sits on the plain bar.
  store().loadProject(rotaryProject())
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  const bareThread = store().addRotaryPattern({
    kind: 'thread',
    start: 5,
    length: 20,
    pitch: 2,
    starts: 1,
    depth: 1.2,
  })
  assert.ok(bareThread.ok, 'the Thread is created on the bare bar')
  const mounted = await renderSingle(bareThread.featureId)
  mounted.openSection('Shape')
  await flush()
  const summary = summaryLine(mounted)
  assert.ok(summary, 'the bare-bar Thread shows its summary')
  assert.equal(
    summary.text,
    'Thread · 1-start · pitch 2 · length 20 · depth 1.2 mm below the bar (Ø 40 mm, surface at Z 40)',
    'with no Turn under it the line still names the depth and the bar surface it is measured from',
  )
  assert.equal(zSourceLine(mounted), null, 'and no second line under Instance')
  mounted.unmount()
}

// ── a Depth whose surface cannot be resolved keeps its number ─
//
// The surface comes from the bar (`rotaryPatternFrame` needs a round one). A
// file whose bar is no longer round resolves none, so the merged line keeps the
// Depth and drops only the clause — never the whole line, and never a stale
// surface Z.

{
  const { threadId } = loadWithShapes()
  store().setStock(squareStock(25, 120, 'x'))
  const mounted = await renderSingle(threadId)
  mounted.openSection('Shape')
  await flush()
  const summary = summaryLine(mounted)
  assert.ok(summary, 'a Thread still shows its summary')
  assert.equal(
    summary.text,
    'Thread · 1-start · pitch 2 · length 20 · depth 1.2 mm',
    'the Depth keeps its number when no surface can be resolved',
  )
  mounted.unmount()
}

// ── a Turn: no Z-source line, and no lift or height figure ───

{
  const { turnId } = loadWithShapes()
  const mounted = await renderSingle(turnId)
  assert.equal(hasZSlider(mounted), false, 'a Turn has no Z range control')
  // No line either (rt7-b, kept by rt7-d): the Turn's summary below already
  // says Ø30 and where that surface sits, so a second sentence repeated it.
  assert.equal(zSourceLine(mounted), null, 'a Turn shows no Z-source line')
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
    'the Turn summary adds the Z its surface reaches, and no Depth',
  )

  // rt7-e: a generated model gets no 3D orientation section at all. Rotating it
  // about X, Y or Z could only tip it off the bar axis, and turning about the
  // bar is the Polygon editor's Rotation field.
  assert.equal(mounted.hasSection('3D orientation'), false, 'a generated model has no 3D orientation section')
  const html = mounted.html()
  assert.equal(html.includes('Rotate X'), false, 'nor Rotate X')
  assert.equal(html.includes('Rotate Y'), false, 'nor Rotate Y')
  assert.equal(html.includes('Rotate Z'), false, 'nor Rotate Z')
  assert.equal(html.includes('Lift'), false, 'nor a lift field')
  assert.equal(html.includes('Model height:'), false, 'nor a height figure')
  assert.equal(html.includes('Reset to import orientation'), false, 'nor a reset action')
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
    'the Polygon summary adds the Z its flats reach, and no Depth',
  )
  // "same for the hex" (rt7-e): the section is absent for it too, and the
  // rotation about the bar stays the editor's own Rotation field.
  assert.equal(mounted.hasSection('3D orientation'), false, 'a generated Polygon has no 3D orientation section')
  assert.equal(mounted.html().includes('Rotate X'), false, 'and no Rotate X to tip it off the bar axis')
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

// ── a plain canned shape keeps its Z control and its summary ──

{
  const { ellipseId } = loadWithShapes()
  const mounted = await renderSingle(ellipseId)
  assert.equal(hasZSlider(mounted), true, 'an ellipse keeps its Z range control')
  assert.equal(zSourceLine(mounted), null, 'and shows no read-only line')
  // Another canned kind's summary is untouched: no Depth, no surface clause.
  mounted.openSection('Shape')
  await flush()
  const summary = summaryLine(mounted)
  assert.ok(summary, 'the ellipse shows its summary')
  assert.equal(summary.text, 'Ellipse · 10 × 6', 'a shape that owns no Depth reports none')
  mounted.unmount()
}

// ── an imported model keeps the whole orientation section ───

{
  loadWithShapes()
  assert.equal(switchWorkspaceFace('top'), true, 'Top for the imported model')
  const modelId = addImportedModel()
  const mounted = await renderSingle(modelId)
  assert.equal(hasZSlider(mounted), true, 'an imported model keeps its Z range control')
  assert.equal(zSourceLine(mounted), null, 'and shows no read-only line')
  // rt7-e hides the section for a *generated* model only. An imported mesh still
  // gets the rotations, the lift, the height it can be lifted within, and reset.
  assert.equal(mounted.hasSection('3D orientation'), true, 'an imported model still has its 3D orientation section')
  mounted.openSection('3D orientation')
  await flush()
  const html = mounted.html()
  assert.equal(html.includes('Rotate X'), true, 'it keeps Rotate X')
  assert.equal(html.includes('Rotate Y'), true, 'Rotate Y')
  assert.equal(html.includes('Rotate Z'), true, 'Rotate Z')
  assert.equal(html.includes('Lift'), true, 'its lift field')
  assert.equal(html.includes('Model height:'), true, 'its height figure')
  assert.equal(html.includes('Reset to import orientation'), true, 'and the reset action')
  mounted.unmount()
}

// ── the other "Rotate" entries are placement, not orientation ─
//
// The handoff asked whether the context menu, the toolbar/rail button or a
// keyboard action can reach the model orientation for a canned model. They all
// dispatch `startRotateFeature` — a 2D placement transform that never wrote
// `stl.orientation` — and since issue #1112 rt7-f that dispatch is refused for
// the four rotary kinds outright (`store/helpers/cannedShapeActions.ts`). This
// pins that boundary at both ends: the placement rotate does not arm, and the
// stored orientation stays absent, so no reachable action but the imported
// model's ModelOrientationSection can re-orient a generated model.

{
  const { turnId } = loadWithShapes()
  const turn = store().project.features.find((feature) => feature.id === turnId)
  assert.ok(turn, 'the Turn exists')
  const definition = store().project.featureDefinitions[turn.definitionId]
  assert.equal(definition.stl?.orientation, undefined, 'a fresh Turn has no stored orientation')

  store().selectFeature(turnId)
  store().startRotateFeature(turnId)
  assert.equal(
    store().pendingTransform,
    null,
    'the placement rotate is refused for a rotary canned shape (rt7-f)',
  )
  assert.equal(
    store().project.featureDefinitions[turn.definitionId].stl?.orientation,
    undefined,
    'so nothing here can write the 3D orientation',
  )
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
//
// Neither kind has a shared Z to edit, and since rt7-d neither reports its value
// here either: a Thread's Depth rides on its own Shape summary, which a
// multi-selection does not show. What must not happen is the "follows stock"
// line, which would be a wrong answer about a shape whose span comes from its
// Edit panel.

{
  const { threadId, turnId } = loadWithShapes()
  store().selectFeatures([threadId, turnId])
  const mounted = mount()
  await flush()
  assert.equal(hasZSlider(mounted), false, 'no Z editor when every selected shape owns its span')
  assert.equal(zSourceLine(mounted), null, 'and no separate Z-source line for either')
  const html = mounted.html()
  assert.equal(html.includes('Follows stock'), false, 'nor a claim that they follow the stock')
  assert.equal(html.includes('depth 1.2 mm'), false, 'the Depth stays on the instance summary')
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
  assert.equal(zSourceLine(mounted), null, 'and no Z-source line for either')
  const html = mounted.html()
  assert.equal(html.includes('Follows stock'), false, 'and no "Follows stock" line either')
  mounted.unmount()
}

// ── a Thread + construction selection stays silent, not wrong ─
//
// A construction feature owns no Z either, so the selection has nothing to
// edit. The slot must stay empty rather than claim "Follows stock" — a wrong
// answer about a Thread whose depth comes from its Edit panel (#1112 rt7-b
// correction 1, still guarded by `selectedReportsCannedDepth` after rt7-d).

{
  const { ellipseId, threadId } = loadWithShapes()
  store().updateFeatures([ellipseId], { operation: 'construction' })
  assert.equal(
    resolvedProjectFeatures(store().project).find((feature) => feature.id === ellipseId)?.operation,
    'construction',
    'the second selected feature is construction geometry',
  )

  store().selectFeatures([threadId, ellipseId])
  assert.equal(store().selection.selectedFeatureIds.length, 2, 'the Thread and the construction row are both selected')
  const mounted = mount()
  await flush()
  assert.equal(hasZSlider(mounted), false, 'a Thread + construction selection has no shared Z editor')
  assert.equal(zSourceLine(mounted), null, 'and no separate Z-source line')
  assert.equal(
    mounted.html().includes('Follows stock'),
    false,
    'instead of claiming the selection follows the stock',
  )
  mounted.unmount()
}

console.log('canned Z range tests passed')
