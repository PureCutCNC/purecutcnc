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
 * The creation drawer on a square blank's Around sheet (issue #1112 decision 17,
 * Frank's test round 2 slice rt2-c).
 *
 * The sheet is round-only, so #1016 hid every drawing entry there and the
 * drawer kept nothing but Turn and Polygon. Decision 17 replaces that with the
 * CAM add menu's own treatment — every entry stays listed, and the ones that
 * would cut the sheet are disabled with the reason — and names the two entries
 * that do not cut: a region (a filter on a rotary operation, #1096) and a
 * construction line. Turn and Polygon are unchanged, and a round bar keeps every
 * entry live.
 *
 * The drawer is a portal, so this is a real client render into a `linkedom`
 * document (the harness `authoringFaceRow.test.ts` uses) with its button
 * clicked, not `renderToStaticMarkup`.
 *
 * Mutations checked one at a time against these assertions:
 *  - hiding the disabled entries instead of listing them (`return null` for the
 *    square-blank case) → every "stays listed" count fails, and the per-entry
 *    disabled assertions have nothing to read;
 *  - enabling a cutting shape on a square blank (dropping the disabled flag
 *    from the shape rows, or from the target toggle's feature/line buttons) →
 *    the matching disabled assertion fails;
 *  - the reason text swapped back to "Needs a round bar" → the value assertion
 *    on `sketch.creation.squareBarUnavailable` fails, and so does every title
 *    comparison;
 *  - disabling Thread and Flutes on a round bar → the round-bar block's "no
 *    entry is disabled" assertion fails.
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
import type { Project, Tool } from '../../../types/project'

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

/** The reason the drawer shows for work it cannot do on a square blank. */
const SQUARE_BAR_REASON = enMessages['sketch.creation.squareBarUnavailable']
// The exact wording decision 17 asks for. "Needs a round bar" is the string
// that was there and is wrong about what is missing: turning a square blank
// works, it is the sheet work that does not.
assert(
  SQUARE_BAR_REASON === 'Not available on a square bar yet',
  `the reason reads "Not available on a square bar yet", got "${SQUARE_BAR_REASON}"`,
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

/** Put a project on the workspace and land on `face`. */
function workspace(project: Project, face: 'top' | 'around'): void {
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

/** The shape entries the drawer offers for a creation target, by their labels. */
function shapeLabels(target: CreationTarget): string[] {
  const nouns = ['rectangle', 'circle', 'ellipse', 'polygon', 'spline', 'composite']
  const canned = ['slot', 'regular polygon', 'rounded rectangle', 'chamfered rectangle']
  const all = target === 'feature'
    ? [...nouns, 'text', 'slot', 'regular polygon', 'gear', 'rounded rectangle', 'chamfered rectangle']
    : [...nouns, ...canned]
  return all.map((noun) => `Add ${target} ${noun}`)
}

function assertDisabled(button: HTMLButtonElement, expected: boolean, label: string): void {
  if (expected) {
    assert(button.disabled, `${label}: disabled on the square blank's Around sheet`)
    assert(
      button.getAttribute('title') === SQUARE_BAR_REASON,
      `${label}: carries the reason, got "${button.getAttribute('title') ?? 'none'}"`,
    )
  } else {
    assert(!button.disabled, `${label}: stays live`)
    assert(
      button.getAttribute('title') !== SQUARE_BAR_REASON,
      `${label}: carries no square-blank reason`,
    )
  }
}

// ── A square blank on Around: everything listed, the cutting work disabled ──

workspace(rotaryProject('square'), 'around')

{
  const rendered = await renderDrawer('feature')
  assert(rendered.targets.length === 4, `the target toggle keeps all four targets, got ${rendered.targets.length}`)
  assertDisabled(targetButton(rendered, 'feature'), true, 'the feature target')
  assertDisabled(targetButton(rendered, 'line'), true, 'the line target')
  assertDisabled(targetButton(rendered, 'region'), false, 'the region target')
  assertDisabled(targetButton(rendered, 'construction'), false, 'the construction target')

  // 12 shapes on the feature target, then Thread, Flutes, Turn and Polygon.
  assert(rendered.drawer.length === 16, `the drawer keeps every entry, got ${rendered.drawer.length}`)
  for (const label of shapeLabels('feature')) {
    assertDisabled(drawerButton(rendered, label), true, label)
  }
  assertDisabled(drawerButton(rendered, 'Thread'), true, 'Thread')
  assertDisabled(drawerButton(rendered, 'Flutes'), true, 'Flutes')
  assertDisabled(drawerButton(rendered, 'Turn'), false, 'Turn')
  assertDisabled(drawerButton(rendered, 'Polygon / hex'), false, 'Polygon')
}

{
  // The two targets that do not cut the sheet make their own shapes live: a
  // region or a construction line never cuts, so nothing is refused.
  for (const target of ['region', 'construction'] as const) {
    const rendered = await renderDrawer(target)
    assert(
      rendered.drawer.length === 14,
      `${target}: the drawer lists its 10 shapes plus the four rotary entries, got ${rendered.drawer.length}`,
    )
    for (const label of shapeLabels(target)) {
      assertDisabled(drawerButton(rendered, label), false, label)
    }
    // Thread and Flutes are round-only sheet authoring whatever the target is.
    assertDisabled(drawerButton(rendered, 'Thread'), true, 'Thread')
    assertDisabled(drawerButton(rendered, 'Flutes'), true, 'Flutes')
    assertDisabled(drawerButton(rendered, 'Turn'), false, 'Turn')
    assertDisabled(drawerButton(rendered, 'Polygon / hex'), false, 'Polygon')
  }
}

// ── A round bar on Around: unchanged, every entry live ─────────────────────

workspace(rotaryProject('round'), 'around')

{
  const rendered = await renderDrawer('feature')
  for (const target of ['feature', 'line', 'region', 'construction'] as const) {
    assertDisabled(targetButton(rendered, target), false, `the ${target} target`)
  }
  assert(rendered.drawer.length === 16, `the round bar keeps every entry, got ${rendered.drawer.length}`)
  for (const button of rendered.drawer) {
    assert(
      !button.disabled,
      `the round bar offers "${button.getAttribute('aria-label') ?? '?'}"`,
    )
  }
}

// ── A square blank on Top: the sheet policy does not reach a flat face ─────

workspace(rotaryProject('square'), 'top')

{
  const rendered = await renderDrawer('feature')
  for (const target of ['feature', 'line', 'region', 'construction'] as const) {
    assertDisabled(targetButton(rendered, target), false, `the ${target} target on Top`)
  }
  // Turn and Polygon follow the bar, so they are offered here too; Thread and
  // Flutes are Around-only and absent (issue #1112 rt2-b item 20).
  assert(rendered.drawer.length === 14, `Top lists the 12 shapes and the two solids, got ${rendered.drawer.length}`)
  for (const button of rendered.drawer) {
    assert(!button.disabled, `Top offers "${button.getAttribute('aria-label') ?? '?'}"`)
  }
  assert(
    !rendered.drawer.some((button) => button.getAttribute('data-command') === 'rotary-thread'),
    'Thread is offered on Around only',
  )
}

console.log('squareAroundCreation: the square blank Around drawer entries passed')
