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
 * The creation drawer's availability: every entry stays listed, and the ones
 * that cannot do the work are disabled with their reason (issue #1112 rt3-d
 * item 31, over the square-blank sheet policy of decision 17 / rt2-c).
 *
 * Two rules meet here, on the same rows:
 *   - item 31 — nothing is hidden any more. A block project has no bar to turn,
 *     so Turn, Polygon, Thread and Flutes used to vanish; off the Around face
 *     Thread and Flutes used to vanish; and off the feature target Text and
 *     Gear used to be filtered out. Each keeps its place, disabled, saying what
 *     is missing.
 *   - decision 17 — a square blank's Around sheet is round-only (#1016 hid the
 *     drawing entries there), so the work that would cut it stays listed and
 *     disabled ("Not available on a square bar yet"), while a region (a filter
 *     on a rotary operation, #1096) and a construction line stay live.
 *
 * The drawer is a portal, so this is a real client render into a `linkedom`
 * document (the harness `authoringFaceRow.test.ts` uses) with its button
 * clicked, not `renderToStaticMarkup`.
 *
 * Mutations checked one at a time against these assertions:
 *  - hiding an unavailable entry instead of listing it (`return null` in
 *    `RotarySolidActions` or `RotaryPatternActions`, the rotary group's own
 *    early return, or the Text/Gear filter in `CreationActions`) → the "keeps
 *    every entry" counts and the per-entry refusal assertions fail;
 *  - leaving a refused entry live (dropping `disabled` from a row or from the
 *    rotary group) → the matching refusal assertion fails;
 *  - giving every refusal one reason (e.g. the square-blank reason on a block)
 *    → the per-case reason assertions fail;
 *  - asking the bar reason before the face reason → the Top/Bottom case fails
 *    on a bar project, where a bar is present and only the face is wrong;
 *  - the square-blank reason text swapped back to "Needs a round bar" → the
 *    value assertion on `sketch.creation.squareBarUnavailable` fails, and so
 *    does every title comparison.
 *
 * Run with: NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/layout/toolbar/squareAroundCreation.test.ts
 */

import * as React from 'react'
import { createElement } from 'react'
import { parseHTML } from 'linkedom'
import { CreationActions } from './CreationActions'
import { I18nProvider } from '../../../i18n/I18nProvider'
import { enMessages } from '../../../i18n/locales/en'
import { useProjectStore } from '../../../store/projectStore'
import { switchWorkspaceFace } from '../../../store/workspaceFace'
import { defaultTool, newProject, roundStock } from '../../../types/project'
import { squareStock } from '../../../types/barStock'
import type { CreationTarget } from '../../../store/types'
import type { Project, ProjectType, Tool } from '../../../types/project'

// A DOM for the client render, in place before React DOM is first imported.
const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
// linkedom has no viewport, and the drawer's placement divides by it (NaN in a
// style property React then warns about).
;(window as unknown as { innerWidth: number }).innerWidth = 1280
;(window as unknown as { innerHeight: number }).innerHeight = 800
// Node 20 (CI) has no global `navigator`; the i18n store reads its languages.
if (typeof globals.navigator === 'undefined') globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
// Components are authored with the automatic JSX runtime; the tsx runner
// transpiles this file with the classic one, which expects a global `React`.
;(globalThis as unknown as { React?: typeof React }).React = React

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** The reason for work a square blank's round-only Around sheet refuses. */
const SQUARE_BAR_REASON = enMessages['sketch.creation.squareBarUnavailable']
/** The reason for work that needs the bar workflow: a block has no bar. */
const BAR_REASON = enMessages['sketch.creation.rotaryBarUnavailable']
/** The reason for a bar entry that is Around-only: Thread and Flutes off Around. */
const AROUND_REASON = enMessages['sketch.creation.aroundFaceOnly']
/** The reason for a feature-only shape on the line / region / construction target. */
const FEATURE_TARGET_REASON = enMessages['sketch.creation.featureTargetOnly']
// The exact wording decision 17 asks for. "Needs a round bar" is the string
// that was there and is wrong about what is missing: turning a square blank
// works, it is the sheet work that does not.
assert(
  SQUARE_BAR_REASON === 'Not available on a square bar yet',
  `the reason reads "Not available on a square bar yet", got "${SQUARE_BAR_REASON}"`,
)
assert(
  BAR_REASON === 'Needs a bar in a rotary project',
  `a block's reason reads "Needs a bar in a rotary project", got "${BAR_REASON}"`,
)
assert(
  AROUND_REASON === 'Only available on the around face',
  `the Around-only reason reads "Only available on the around face", got "${AROUND_REASON}"`,
)
assert(
  FEATURE_TARGET_REASON === 'Only available on the feature target',
  `the feature-only reason reads "Only available on the feature target", got "${FEATURE_TARGET_REASON}"`,
)

/** A rotary project with one cutter and no machine, on a square or a round bar. */
function rotaryProject(shape: 'square' | 'round'): Project {
  const base = newProject('Around creation', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = shape === 'square' ? squareStock(25, 120, 'x') : roundStock(25, 120, 'x')
  base.meta.machineDefinitions = []
  base.meta.selectedMachineId = null
  const cutter: Tool = { ...defaultTool('mm', 1), id: 'ball', name: 'ball', diameter: 4, defaultStepover: 1.6 }
  base.tools = [cutter]
  return base
}

/** A block project — milling or plasma. There is no bar, so the rotary entries cannot work. */
function blockProject(type: ProjectType): Project {
  const base = newProject('Block creation', 'mm')
  base.meta.projectType = type
  base.meta.machineDefinitions = []
  base.meta.selectedMachineId = null
  return base
}

/** Put a project on the workspace and land on `face`. */
function workspace(project: Project, face: 'top' | 'bottom' | 'around'): void {
  useProjectStore.getState().loadProject(project)
  assert(switchWorkspaceFace(face), `the workspace enters ${face}`)
}

interface Rendered {
  /** The buttons of the creation target toggle. */
  targets: HTMLButtonElement[]
  /** Every button inside the open drawer, in document order. */
  drawer: HTMLButtonElement[]
}

/** Render the creation block, open its drawer with a click, and read it back. */
async function renderDrawer(creationTarget: CreationTarget): Promise<Rendered> {
  useProjectStore.getState().setCreationTarget(creationTarget)
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const noop = (): void => {}
  flushSync(() => root.render(createElement(
    I18nProvider,
    null,
    createElement(CreationActions, {
      pendingShape: null,
      creationTarget,
      onCreationTargetChange: noop,
      onRect: noop,
      onCircle: noop,
      onEllipse: noop,
      onPolygon: noop,
      onSpline: noop,
      onComposite: noop,
      onText: noop,
      onSlot: noop,
      onNgon: noop,
      onGear: noop,
      onRoundRect: noop,
      onChamferRect: noop,
    }),
  )))
  const drawerButton = host.querySelector<HTMLButtonElement>('.toolbar-creation-picker__drawer-btn')
  assert(drawerButton, 'the creation drawer button is rendered')
  flushSync(() => { drawerButton.click() })
  const drawer = document.querySelector<HTMLElement>('.toolbar-creation-picker__drawer')
  assert(drawer, 'the drawer opens')
  const rendered: Rendered = {
    targets: [...host.querySelectorAll<HTMLButtonElement>('.toolbar-target-toggle button')],
    drawer: [...drawer.querySelectorAll<HTMLButtonElement>('button')],
  }
  flushSync(() => root.unmount())
  host.remove()
  drawer.remove()
  return rendered
}

const TARGET_LABELS: Record<CreationTarget, string> = {
  feature: 'Create features',
  line: 'Create lines',
  region: 'Create regions',
  construction: 'Create construction geometry',
}

/** The twelve shape rows, in the drawer's own order: six primary, six secondary. */
const SHAPE_NOUNS = [
  'rectangle', 'circle', 'ellipse', 'polygon', 'spline', 'composite', 'text',
  'slot', 'regular polygon', 'gear', 'rounded rectangle', 'chamfered rectangle',
] as const

/** The four rotary entries, in the drawer's own order. */
const ROTARY_LABELS = ['Thread', 'Flutes', 'Turn', 'Polygon / hex'] as const

function targetButton(rendered: Rendered, target: CreationTarget): HTMLButtonElement {
  const button = rendered.targets.find((entry) => entry.getAttribute('aria-label') === TARGET_LABELS[target])
  assert(button, `the ${target} target is listed`)
  return button
}

function drawerButton(rendered: Rendered, label: string): HTMLButtonElement {
  const button = rendered.drawer.find((entry) => entry.getAttribute('aria-label') === label)
  assert(button, `"${label}" is listed in the drawer`)
  return button
}

function shapeRow(rendered: Rendered, target: CreationTarget, noun: string): HTMLButtonElement {
  return drawerButton(rendered, `Add ${target} ${noun}`)
}

/** The drawer keeps all twelve shapes and all four rotary entries, always. */
function assertEveryEntryListed(rendered: Rendered, target: CreationTarget, note: string): void {
  assert(
    rendered.drawer.length === SHAPE_NOUNS.length + ROTARY_LABELS.length,
    `${note}: the drawer keeps every entry (12 shapes and 4 rotary), got ${rendered.drawer.length}`,
  )
  for (const noun of SHAPE_NOUNS) shapeRow(rendered, target, noun)
  for (const label of ROTARY_LABELS) drawerButton(rendered, label)
}

function assertRefused(button: HTMLButtonElement, reason: string, label: string): void {
  assert(button.disabled, `${label}: listed disabled rather than hidden`)
  assert(
    button.getAttribute('title') === reason,
    `${label}: carries the reason "${reason}", got "${button.getAttribute('title') ?? 'none'}"`,
  )
}

/** Every reason this drawer can show. A live entry carries none of them. */
const REFUSALS: ReadonlySet<string> = new Set([SQUARE_BAR_REASON, BAR_REASON, AROUND_REASON, FEATURE_TARGET_REASON])

function assertLive(button: HTMLButtonElement, label: string): void {
  assert(!button.disabled, `${label}: stays live`)
  const title = button.getAttribute('title')
  // A live target button still carries its own label as a tooltip.
  assert(
    title === null || !REFUSALS.has(title),
    `${label}: carries no refusal, got "${title ?? 'none'}"`,
  )
}

// ── A milling block on Top: no bar, so all four rotary entries say so ──────

workspace(blockProject('milling'), 'top')

{
  const rendered = await renderDrawer('feature')
  assert(rendered.targets.length === 4, `the target toggle keeps all four targets, got ${rendered.targets.length}`)
  for (const target of ['feature', 'line', 'region', 'construction'] as const) {
    assertLive(targetButton(rendered, target), `the ${target} target on a block`)
  }
  assertEveryEntryListed(rendered, 'feature', 'a milling block')
  for (const noun of SHAPE_NOUNS) assertLive(shapeRow(rendered, 'feature', noun), noun)
  // Turn and Polygon turn the bar; Thread and Flutes need the Around sheet.
  // With no bar at all, that is the reason every rotary entry gives.
  for (const label of ROTARY_LABELS) assertRefused(drawerButton(rendered, label), BAR_REASON, label)
}

// ── A plasma block on Top: the same four, the same reason ─────────────────

workspace(blockProject('plasma'), 'top')

{
  const rendered = await renderDrawer('feature')
  assertEveryEntryListed(rendered, 'feature', 'a plasma block')
  for (const label of ROTARY_LABELS) assertRefused(drawerButton(rendered, label), BAR_REASON, label)
}

// ── A rotary round bar on Around: every entry live, as before ─────────────

workspace(rotaryProject('round'), 'around')

{
  const rendered = await renderDrawer('feature')
  assertEveryEntryListed(rendered, 'feature', 'a round bar on Around')
  for (const target of ['feature', 'line', 'region', 'construction'] as const) {
    assertLive(targetButton(rendered, target), `the ${target} target`)
  }
  for (const button of rendered.drawer) {
    assertLive(button, `"${button.getAttribute('aria-label') ?? '?'}"`)
  }
}

// ── A bar on Top/Bottom: Turn and Polygon work, Thread and Flutes say why ─

for (const [shape, face] of [
  ['round', 'top'], ['round', 'bottom'], ['square', 'top'], ['square', 'bottom'],
] as const) {
  workspace(rotaryProject(shape), face)
  const note = `a ${shape} bar on ${face}`
  const rendered = await renderDrawer('feature')
  assertEveryEntryListed(rendered, 'feature', note)
  for (const noun of SHAPE_NOUNS) assertLive(shapeRow(rendered, 'feature', noun), `${noun} on ${note}`)
  // Turn and Polygon follow the bar (issue #1112 rt2-b item 20); Thread and
  // Flutes are Around-only, and now they say so instead of vanishing.
  assertLive(drawerButton(rendered, 'Turn'), `Turn on ${note}`)
  assertLive(drawerButton(rendered, 'Polygon / hex'), `Polygon on ${note}`)
  for (const label of ['Thread', 'Flutes'] as const) {
    assertRefused(drawerButton(rendered, label), AROUND_REASON, `${label} on ${note}`)
  }
}

// ── Text and Gear are features: off the feature target they say why ───────

workspace(rotaryProject('round'), 'around')

for (const target of ['line', 'region', 'construction'] as const) {
  const rendered = await renderDrawer(target)
  assertEveryEntryListed(rendered, target, `the ${target} target`)
  for (const noun of ['text', 'gear'] as const) {
    assertRefused(shapeRow(rendered, target, noun), FEATURE_TARGET_REASON, `${noun} on the ${target} target`)
  }
  for (const noun of SHAPE_NOUNS.filter((entry) => entry !== 'text' && entry !== 'gear')) {
    assertLive(shapeRow(rendered, target, noun), `${noun} on the ${target} target`)
  }
  for (const label of ROTARY_LABELS) assertLive(drawerButton(rendered, label), `${label} on the ${target} target`)
}

// ── A square blank on Around: the sheet policy still holds ────────────────

workspace(rotaryProject('square'), 'around')

{
  const rendered = await renderDrawer('feature')
  assert(rendered.targets.length === 4, `the target toggle keeps all four targets, got ${rendered.targets.length}`)
  assertRefused(targetButton(rendered, 'feature'), SQUARE_BAR_REASON, 'the feature target')
  assertRefused(targetButton(rendered, 'line'), SQUARE_BAR_REASON, 'the line target')
  assertLive(targetButton(rendered, 'region'), 'the region target')
  assertLive(targetButton(rendered, 'construction'), 'the construction target')

  assertEveryEntryListed(rendered, 'feature', "a square blank's Around sheet")
  for (const noun of SHAPE_NOUNS) assertRefused(shapeRow(rendered, 'feature', noun), SQUARE_BAR_REASON, noun)
  // Thread and Flutes are round-only sheet authoring; Turn and Polygon work on
  // either bar shape, so the sheet refusal does not reach them.
  for (const label of ['Thread', 'Flutes'] as const) {
    assertRefused(drawerButton(rendered, label), SQUARE_BAR_REASON, label)
  }
  assertLive(drawerButton(rendered, 'Turn'), 'Turn')
  assertLive(drawerButton(rendered, 'Polygon / hex'), 'Polygon')
}

{
  // The two targets that do not cut the sheet make their own shapes live: a
  // region or a construction line never cuts, so nothing is refused there.
  for (const target of ['region', 'construction'] as const) {
    const rendered = await renderDrawer(target)
    assertEveryEntryListed(rendered, target, `${target} on a square blank's Around sheet`)
    for (const noun of SHAPE_NOUNS) {
      if (noun === 'text' || noun === 'gear') {
        assertRefused(shapeRow(rendered, target, noun), FEATURE_TARGET_REASON, `${noun} on the ${target} target`)
      } else {
        assertLive(shapeRow(rendered, target, noun), noun)
      }
    }
    assertRefused(drawerButton(rendered, 'Thread'), SQUARE_BAR_REASON, 'Thread')
    assertRefused(drawerButton(rendered, 'Flutes'), SQUARE_BAR_REASON, 'Flutes')
    assertLive(drawerButton(rendered, 'Turn'), 'Turn')
    assertLive(drawerButton(rendered, 'Polygon / hex'), 'Polygon')
  }
}

console.log('squareAroundCreation: the drawer keeps every entry and states each refusal')
