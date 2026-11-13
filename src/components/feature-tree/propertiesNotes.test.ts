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
 * Properties notes are plain text, and a canned shape says so (issue #1112
 * rt7-h). Frank, looking at a Hex's Properties: "we should not use that orange
 * colour for the messages? … maybe we can have just text and add 'Canned
 * feature' somewhere there (maybe as a label?)".
 *
 * The orange bar was `.properties-linked-face-note` (`src/styles/face.css`), a
 * 2px `border-left` in `var(--face-bottom)`. It started as the change-face
 * dialog's linked-copy note and had been borrowed by every Properties note:
 *
 *  - `canned-shape-summary` — a generated shape's one-line summary;
 *  - `canned-shape-unknown` — parameters from a newer version;
 *  - `text-summary` — a text run's text and size;
 *  - `text-path-source-missing` — the vanished guide a text-on-path run lost;
 *  - `linked-other-face-note` — the linked copies on another face.
 *
 * All five are now `.properties-note` (plain secondary text), and a canned
 * shape adds the neutral `.properties-canned-label` above its summary. The bar
 * stays where it was drawn, in `.change-face__linked`.
 *
 * Both halves are checked against the real stylesheet and the real panel: the
 * class alone would not prove the bar is gone, because the bar was the CSS.
 * Mutations checked one at a time against these assertions:
 *  - the orange `border-left` put back on `.properties-note` → the "no bar"
 *    stylesheet assertion fails;
 *  - a `background`/`border` callout box added to `.properties-note` → same;
 *  - the old `.properties-linked-face-note` selector restored anywhere under
 *    `src/styles/` → the "selector is gone" assertion fails;
 *  - `.change-face__linked` losing its bar → the dialog assertion fails, which
 *    is the half of the old shared rule that had to survive;
 *  - a note's `className` reverted to the old class (or the class dropped) →
 *    that note's rendered-class assertion fails;
 *  - the `Canned feature` label dropped, or made kind-specific, → the canned
 *    assertions fail while the plain-feature one keeps passing;
 *  - the label rendered for a plain feature too → the plain-feature "no label"
 *    assertion fails.
 *
 * The panel is rendered for real (a client render into `linkedom`, the DOM the
 * other feature-tree tests use) rather than string-matched, so the label and
 * the notes are asserted as the markup a reader gets.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/feature-tree/propertiesNotes.test.ts
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
const { newProject, rectProfile } = await import('../../types/project')
const { projectWithFeatures } = await import('../../test/projectFixtures')

type Project = ReturnType<typeof newProject>

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const faceCss = readFileSync(resolve(root, 'src/styles/face.css'), 'utf8')
/** Every stylesheet the app ships, so the desktop/tablet/3D variants are covered. */
const stylesheets = readdirSync(resolve(root, 'src/styles'))
  .filter((name) => name.endsWith('.css'))
  .map((name) => [name, readFileSync(resolve(root, 'src/styles', name), 'utf8')] as const)
const propertiesPanel = readFileSync(resolve(root, 'src/components/feature-tree/PropertiesPanel.tsx'), 'utf8')
const summaryLine = readFileSync(resolve(root, 'src/components/feature-tree/CannedShapeSummaryLine.tsx'), 'utf8')

/** The body of the first top-level rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  assert.ok(match, `the stylesheet must define a rule for ${selector}`)
  return match[1]
}

// ── The stylesheet: no bar, no box ───────────────────────────────
//
// The rendered class can only say which rule applies; the bar itself is the
// rule's `border-left`, so the rule is what has to be asserted.

{
  const body = ruleBody(faceCss, '.properties-note')
  assert.doesNotMatch(body, /border/, '.properties-note must carry no coloured bar or box')
  assert.doesNotMatch(body, /background/, '.properties-note must not be a callout box')
  assert.match(body, /color:\s*var\(--text-dim\)/, '.properties-note uses the panel\'s muted text token')
  assert.match(body, /font-size:\s*12px/, '.properties-note keeps the notes\' type size')
  assert.match(body, /line-height:\s*1\.45/, '.properties-note keeps the notes\' line height')
  assert.match(body, /margin:\s*8px 0 0/, '.properties-note keeps enough space to read as its own line')
}

// The bar belonged to the change-face dialog and only to it.
{
  const body = ruleBody(faceCss, '.change-face__linked')
  assert.match(
    body,
    /border-left:\s*2px solid var\(--face-bottom\)/,
    'the change-face dialog keeps the linked-copy bar it was drawn for',
  )
}

// The neutral label: the authoring-face chip's metrics, none of its colour.
{
  const body = ruleBody(faceCss, '.properties-canned-label')
  assert.doesNotMatch(body, /--face-bottom|--warning|--role-/, 'the label is neutral, never an orange/warning colour')
  assert.match(body, /color:\s*var\(--text-dim\)/, 'the label takes the panel\'s muted text token')
  assert.match(body, /border:\s*1px solid var\(--line-strong\)/, 'the label borrows the neutral chip border')
}

// No stylesheet reintroduces the old class, and no other one draws a bar on a
// note — including the desktop, tablet and 3D/Around/Bottom variants.
{
  for (const [name, css] of stylesheets) {
    assert.equal(css.includes('.properties-linked-face-note'), false, `${name} must not define the old orange-bar class`)
  }
  assert.match(
    propertiesPanel,
    /className="properties-note"/,
    'PropertiesPanel renders its notes as .properties-note',
  )
  assert.equal(
    propertiesPanel.includes('properties-linked-face-note'),
    false,
    'PropertiesPanel must not keep the old class anywhere',
  )
  assert.match(summaryLine, /className="properties-note"/, 'CannedShapeSummaryLine renders its summary as .properties-note')
}

// ── The panel, rendered for real ─────────────────────────────────

interface Mounted {
  noteClass: (testId: string) => string | null
  noteText: (testId: string) => string | null
  labelCount: () => number
  labelText: () => string | null
  html: () => string
  unmount: () => void
}

function select(id: string): void {
  useProjectStore.setState((state) => ({
    selection: { ...state.selection, mode: 'feature', selectedFeatureId: id, selectedFeatureIds: [id] },
  }))
}

function load(project: Project, selectedId: string): void {
  useProjectStore.setState({
    project,
    pendingAdd: null,
    history: { past: [], future: [], transactionStart: null },
    dirty: false,
  } as never)
  select(selectedId)
}

async function mount(...open: string[]): Promise<Mounted> {
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
  for (const title of open) {
    const header = Array.from(host.querySelectorAll('.disclosure-section__header'))
      .find((candidate) => (candidate.textContent ?? '').trim().startsWith(title))
    assert.ok(header, `the panel has a "${title}" section`)
    ;(header as unknown as HTMLButtonElement).click()
  }
  // A click's state update lands after React's event handler returns.
  await new Promise((done) => setTimeout(done, 20))
  const element = (testId: string): Element | null => document.querySelector(`[data-testid="${testId}"]`)
  const labels = (): Element[] => Array.from(document.querySelectorAll('[data-testid="canned-feature-label"]'))
  return {
    noteClass: (testId) => {
      const found = element(testId)
      return found ? found.getAttribute('class') : null
    },
    noteText: (testId) => {
      const found = element(testId)
      return found ? (found.textContent ?? '').trim() : null
    },
    labelCount: () => labels().length,
    labelText: () => {
      const found = labels()[0]
      return found ? (found.textContent ?? '').trim() : null
    },
    html: () => host.innerHTML,
    unmount: () => {
      flushSync(() => root.unmount())
      host.remove()
    },
  }
}

/** A plain rectangle the last user action drew, never a generated shape. */
function plainFeature(id = 'plate'): Record<string, unknown> {
  return {
    id,
    name: 'Plate',
    kind: 'rect',
    operation: 'add',
    visible: true,
    locked: false,
    z_top: 5,
    z_bottom: 0,
    folderId: null,
    text: null,
    stl: null,
    sketch: {
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
      profile: rectProfile(20, 20, 60, 40),
    },
  }
}

function base(): Project {
  const project = newProject('Notes', 'mm')
  return projectWithFeatures(project, [])
}

// ── A canned shape: label + plain summary ────────────────────────
//
// The flat ellipse stands for every canned kind: the label lives once in the
// panel's `isCannedShape` branch, which all of them take (flat and rotary).
{
  const project = projectWithFeatures(base(), [{
    ...plainFeature('ellipse'),
    name: 'Ellipse',
    kind: 'composite',
    canned: { kind: 'ellipse', params: { rx: 18, ry: 10 } },
  } as never])
  load(project, 'ellipse')
  const mounted = await mount('Shape')
  try {
    assert.equal(mounted.labelCount(), 1, 'a canned shape gets exactly one "Canned feature" label')
    assert.equal(mounted.labelText(), 'Canned feature', 'the label says what the shape is')
    assert.equal(mounted.noteClass('canned-shape-summary'), 'properties-note', 'the summary is a plain note')
    assert.equal(
      mounted.html().indexOf('canned-feature-label') < mounted.html().indexOf('canned-shape-summary'),
      true,
      'the label sits right before the summary line',
    )
  } finally {
    mounted.unmount()
  }
}

// ── Another canned kind, same label (a slot) ─────────────────────

{
  const project = projectWithFeatures(base(), [{
    ...plainFeature('slot'),
    name: 'Slot',
    kind: 'composite',
    canned: { kind: 'slot', params: { length: 40, width: 8 } },
  } as never])
  load(project, 'slot')
  const mounted = await mount('Shape')
  try {
    assert.equal(mounted.labelCount(), 1, 'a slot gets the same single label')
    assert.equal(mounted.noteClass('canned-shape-summary'), 'properties-note', 'a slot summary is a plain note')
  } finally {
    mounted.unmount()
  }
}

// ── A canned shape from a newer version still says it is canned ──

{
  const project = projectWithFeatures(base(), [{
    ...plainFeature('future'),
    name: 'Future shape',
    kind: 'composite',
    canned: { kind: 'shape-from-a-later-build', params: { sides: 7 } },
  } as never])
  load(project, 'future')
  const mounted = await mount('Shape')
  try {
    assert.equal(mounted.labelCount(), 1, 'an unknown canned kind is still labelled')
    assert.equal(mounted.noteClass('canned-shape-unknown'), 'properties-note', 'the unknown-shape note is plain')
  } finally {
    mounted.unmount()
  }
}

// ── A plain feature has no label at all ──────────────────────────

{
  const project = projectWithFeatures(base(), [plainFeature() as never])
  load(project, 'plate')
  const mounted = await mount('Shape')
  try {
    assert.equal(mounted.labelCount(), 0, 'a drawn feature is not a canned one, so it gets no label')
    assert.equal(mounted.noteText('canned-shape-summary'), null, 'and no shape summary line')
  } finally {
    mounted.unmount()
  }
}

// ── A text run: its summary and its vanished guide are plain notes ─

{
  const project = projectWithFeatures(base(), [{
    ...plainFeature('run'),
    name: 'ABC',
    kind: 'text',
    operation: 'subtract',
    text: { text: 'ABC', style: 'skeleton', fontId: 'simple_stroke', size: 10 },
    textLayout: {
      kind: 'path',
      path: rectProfile(0, 0, 40, 20),
      startOffset: 0,
      endOffset: 40,
      anchor: 'center',
      fit: 'natural',
      reversed: false,
      orientation: 'follow',
      sourceFeatureId: 'guide-that-was-deleted',
    },
    sketch: {
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
      profile: rectProfile(200, 200, 30, 10),
    },
  } as never])
  load(project, 'run')
  const mounted = await mount('Shape')
  try {
    assert.equal(mounted.labelCount(), 0, 'a text run is not a canned shape')
    assert.equal(mounted.noteClass('text-summary'), 'properties-note', 'the text summary is a plain note')
    assert.equal(
      mounted.noteClass('text-path-source-missing'),
      'properties-note',
      'the missing text-path source is a plain note',
    )
  } finally {
    mounted.unmount()
  }
}

// ── A linked copy on the other face: its count is a plain note ──

{
  const shared = plainFeature('plate-top')
  const project = projectWithFeatures(base(), [
    shared as never,
    {
      ...shared,
      id: 'plate-bottom',
      name: 'Plate (bottom copy)',
      definitionId: 'plate-top',
      authoringFace: 'bottom',
    } as never,
  ])
  load(project, 'plate-top')
  const mounted = await mount('Shape')
  try {
    assert.equal(
      mounted.noteClass('linked-other-face-note'),
      'properties-note',
      'the linked-copy count is a plain note',
    )
    assert.match(
      mounted.noteText('linked-other-face-note') ?? '',
      /linked cop/,
      'and it is the sentence about the copy on the other face',
    )
  } finally {
    mounted.unmount()
  }
}

console.log('propertiesNotes.test.ts passed')
