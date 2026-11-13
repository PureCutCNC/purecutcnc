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
 * One edit action in Shape, Make unique in Instance, Delete alone at the
 * bottom (issue #1112 rt7-i). Frank: "for the other regular features 'Edit
 * sketch' is down at the bottom of the properties out of the sections. also
 * make unique is under SHAPE and it really belongs to the INSTANCE. so, can we
 * keep edit sketch or edit polygon (etc) (only one of them) in the shape
 * section. move make unique under INSTANCE. and leave delete feature at the
 * bottom out of the sections."
 *
 * So the single-feature Properties panel, rendered for real:
 *  - Shape carries exactly one edit action, in the place the canned shape's
 *    "Edit {shape}…" already sat: "Edit {shape}…" for a generated shape, "Edit
 *    sketch" for every other feature, with the enablement it had before;
 *  - Make unique renders inside Instance, and only while the shape is shared;
 *  - the bottom row outside the sections is Delete alone;
 *  - a generated shape's Properties show no "Edit sketch" anywhere, since its
 *    parameters own its geometry and its own editor is the one edit entry;
 *  - a text run is edited by its own "Edit text…" dialog, so Shape shows that
 *    alone and no "Edit sketch" (the disabled leftover it used to carry),
 *    exactly as for a generated shape with its own editor.
 *
 * Mutations checked one at a time against these assertions:
 *  - rendering "Edit sketch" in the bottom row again → "the bottom row is
 *    Delete alone" fails for the plain feature;
 *  - leaving Make unique in Shape → "Make unique lives in Instance" fails for
 *    the shared shape;
 *  - rendering the bottom-row "Edit sketch" for a canned shape → "a generated
 *    shape shows no Edit sketch at all" fails;
 *  - rendering Shape's disabled "Edit sketch" for a text run again → "Shape
 *    has exactly one edit action" fails for the run, as it did at 9b456ef7;
 *  - dropping the click handler from Shape's "Edit sketch" → the sketch-edit
 *    session assertion fails.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/feature-tree/shapeEditActions.test.ts
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
const { enMessages } = await import('../../i18n/locales/en')
const { PropertiesPanel } = await import('./PropertiesPanel')
const { UnitConversionContext } = await import('../project/UnitConversionContext')
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
const { newProject, rectProfile } = await import('../../types/project')
const { projectWithFeatures } = await import('../../test/projectFixtures')

type Project = ReturnType<typeof newProject>

const store = () => useProjectStore.getState()

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

const EDIT_SKETCH = enMessages['featureTree.properties.stock.editSketch']
const EDIT_TEXT = enMessages['featureTree.properties.text.edit']
const DELETE_FEATURE = enMessages['featureTree.properties.deleteFeature']
const MAKE_UNIQUE = enMessages['featureTree.properties.makeUnique']
const CANNED_EDIT = enMessages['featureTree.properties.canned.edit']

// ── fixtures ─────────────────────────────────────────────────

/** An empty milling project, ready for the store's own creation actions. */
function emptyProject(): Project {
  return projectWithFeatures(newProject('Shape edit actions', 'mm'), [])
}

/** Draw a plain rectangle and return the instance id. */
function addPlainRect(): string {
  store().loadProject(emptyProject())
  store().addRectFeature('Plate', 20, 20, 40, 30, 5)
  const created = store().project.features[0]
  assert.ok(created, 'the plain rectangle is created')
  return created.id
}

/** Create the canned ellipse the app's own command creates. */
function addCannedEllipse(): string {
  store().loadProject(emptyProject())
  store().addEllipseFeature('Ellipse', 40, 30, 10, 6, 3)
  const created = store().project.features[0]
  assert.ok(created, 'the canned ellipse is created')
  return created.id
}

/**
 * A second instance of the same definition — a linked copy, which is what shows
 * Make unique. Written straight into the store so the fixture cannot drift from
 * the shared-definition shape the panel reads.
 */
function addLinkedCopy(featureId: string): string {
  const project = store().project
  const first = project.features.find((feature) => feature.id === featureId)
  assert.ok(first, 'the first instance exists')
  const copy = { ...first, id: `${featureId}-copy`, name: 'Plate copy' }
  useProjectStore.setState({
    project: {
      ...project,
      features: [...project.features, copy],
      featureTree: [...project.featureTree, { type: 'feature', featureId: copy.id }],
    },
  })
  return copy.id
}

/**
 * A text run, written as a feature draft because the app's own text tool needs
 * a canvas pick to place it: same `kind`/`text`/frame the real action stores,
 * which is all the panel reads. The dialog for it is what "Edit text…" reopens.
 */
function addTextFeature(): string {
  const project = projectWithFeatures(emptyProject(), [{
    id: 'run',
    name: 'ABC',
    kind: 'text',
    operation: 'subtract',
    visible: true,
    locked: false,
    z_top: 5,
    z_bottom: 0,
    folderId: null,
    text: { text: 'ABC', style: 'skeleton', fontId: 'simple_stroke', size: 10 },
    sketch: {
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
      profile: rectProfile(20, 20, 30, 10),
    },
  } as never])
  store().loadProject(project)
  const created = store().project.features[0]
  assert.ok(created, 'the text run is created')
  return created.id
}

// ── the panel, rendered for real ─────────────────────────────

interface Mounted {
  host: HTMLElement
  section: (prefix: string) => Element | null
  openSection: (prefix: string) => Promise<void>
  bottomActions: () => Element | null
  unmount: () => void
}

function headerFor(host: HTMLElement, prefix: string): Element | null {
  return Array.from(host.querySelectorAll('.disclosure-section__header'))
    .find((candidate) => (candidate.textContent ?? '').trim().startsWith(prefix)) ?? null
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
  const section = (prefix: string): Element | null => headerFor(host, prefix)?.parentElement ?? null
  return {
    host,
    section,
    openSection: async (prefix: string) => {
      const header = headerFor(host, prefix)
      assert.ok(header, `the panel has a "${prefix}" section`)
      const button = header as unknown as HTMLButtonElement
      if (button.getAttribute('aria-expanded') !== 'true') button.click()
      await flush()
      assert.equal(
        headerFor(host, prefix)?.getAttribute('aria-expanded'),
        'true',
        `the "${prefix}" section is open`,
      )
    },
    // The action row outside the sections, not the one inside Shape or
    // Instance: it is the panel's own direct child.
    bottomActions: () => host.querySelector('.properties-panel > .properties-actions'),
    unmount: () => {
      flushSync(() => root.unmount())
      host.remove()
    },
  }
}

function buttons(scope: Element | null): HTMLButtonElement[] {
  if (!scope) return []
  return Array.from(scope.querySelectorAll('button'))
}

function labels(scope: Element | null): string[] {
  return buttons(scope).map((button) => (button.textContent ?? '').trim())
}

function buttonByLabel(scope: Element | null, label: string): HTMLButtonElement | null {
  return buttons(scope).find((button) => (button.textContent ?? '').trim() === label) ?? null
}

// ── a plain feature: Edit sketch in Shape, Delete alone below ─

async function testPlainFeature(): Promise<void> {
  const featureId = addPlainRect()
  store().selectFeature(featureId)
  const mounted = mount()
  await mounted.openSection('Shape')

  const shape = mounted.section('Shape')
  assert.ok(shape, 'the panel renders the Shape section')
  assert.ok(
    buttonByLabel(shape, EDIT_SKETCH),
    `Shape carries "${EDIT_SKETCH}", got ${JSON.stringify(labels(shape))}`,
  )
  // One edit action, as for a generated shape: nothing else in Shape edits the
  // feature's geometry.
  assert.equal(
    labels(shape).filter((label) => label.startsWith('Edit ')).length,
    1,
    `Shape has exactly one edit action, got ${JSON.stringify(labels(shape))}`,
  )

  const bottom = mounted.bottomActions()
  assert.ok(bottom, 'the panel has its action row outside the sections')
  assert.deepEqual(
    labels(bottom),
    [DELETE_FEATURE],
    'Delete is the only action left outside the sections',
  )
  assert.ok(
    !buttonByLabel(bottom, EDIT_SKETCH),
    'Edit sketch no longer renders in the bottom row',
  )
  // The row is the panel's own child, not something inside a section.
  assert.ok(
    !bottom?.querySelector('.disclosure-section'),
    'the bottom row is not inside a section',
  )
  assert.equal(
    Array.from(mounted.host.querySelectorAll('.properties-panel > .properties-actions')).length,
    1,
    'there is exactly one action row outside the sections',
  )
  mounted.unmount()

  // The moved button is the same action: it starts the sketch edit.
  const clickMount = mount()
  await clickMount.openSection('Shape')
  const edit = buttonByLabel(clickMount.section('Shape'), EDIT_SKETCH)
  assert.ok(edit, 'the Shape edit action renders')
  assert.equal(edit.hasAttribute('disabled'), false, 'and is offered for a plain feature')
  edit.click()
  await flush()
  assert.equal(store().sketchEditSession?.entityId, featureId, 'clicking it starts the sketch edit session')
  assert.equal(store().selection.mode, 'sketch_edit', 'and the workspace enters sketch edit')
  clickMount.unmount()
}

// ── a generated shape: its own editor in Shape, no Edit sketch ─

async function testCannedShape(): Promise<void> {
  const featureId = addCannedEllipse()
  store().selectFeature(featureId)
  const mounted = mount()
  await mounted.openSection('Shape')

  const shape = mounted.section('Shape')
  const editLabel = CANNED_EDIT.replace('{shape}', enMessages['canned.ellipse.name'])
  assert.ok(shape, 'the panel renders the Shape section')
  assert.ok(
    buttonByLabel(shape, editLabel),
    `Shape carries "${editLabel}", got ${JSON.stringify(labels(shape))}`,
  )
  assert.equal(
    labels(shape).filter((label) => label.startsWith('Edit ')).length,
    1,
    `a generated shape has exactly one edit action in Shape, got ${JSON.stringify(labels(shape))}`,
  )

  // No Edit sketch anywhere — not in Shape, not in the bottom row, not in
  // Instance: its parameters own its geometry.
  assert.ok(
    !labels(mounted.host).includes(EDIT_SKETCH),
    `a generated shape shows no "${EDIT_SKETCH}" at all, got ${JSON.stringify(labels(mounted.host))}`,
  )

  const bottom = mounted.bottomActions()
  assert.deepEqual(labels(bottom), [DELETE_FEATURE], 'its bottom row is Delete alone too')
  mounted.unmount()
}

// ── a text run: its own editor in Shape, no Edit sketch ──────

async function testTextFeature(): Promise<void> {
  const featureId = addTextFeature()
  store().selectFeature(featureId)
  const mounted = mount()
  await mounted.openSection('Shape')

  const shape = mounted.section('Shape')
  assert.ok(shape, 'the panel renders the Shape section')
  assert.ok(
    shape.querySelector('[data-testid="text-summary"]'),
    'the text run is the text branch, its summary is in Shape',
  )
  assert.ok(
    buttonByLabel(shape, EDIT_TEXT),
    `Shape carries "${EDIT_TEXT}", got ${JSON.stringify(labels(shape))}`,
  )
  // One edit action, as for every other kind: its own dialog, not a sketch
  // edit whose button was permanently disabled for a text run.
  assert.equal(
    labels(shape).filter((label) => label.startsWith('Edit ')).length,
    1,
    `Shape has exactly one edit action, got ${JSON.stringify(labels(shape))}`,
  )
  assert.deepEqual(
    labels(shape).filter((label) => label.startsWith('Edit ')),
    [EDIT_TEXT],
    'and that one action is the text editor',
  )
  // No Edit sketch anywhere — not in Shape, not in the bottom row, not in
  // Instance: the run's text owns its geometry.
  assert.ok(
    !labels(mounted.host).includes(EDIT_SKETCH),
    `a text run shows no "${EDIT_SKETCH}" at all, got ${JSON.stringify(labels(mounted.host))}`,
  )

  const bottom = mounted.bottomActions()
  assert.deepEqual(labels(bottom), [DELETE_FEATURE], 'its bottom row is Delete alone too')
  mounted.unmount()

  // The text editor still works: the one edit action reopens its dialog with the
  // run's own values, exactly as before.
  const clickMount = mount()
  await clickMount.openSection('Shape')
  const edit = buttonByLabel(clickMount.section('Shape'), EDIT_TEXT)
  assert.ok(edit, 'the text edit action renders')
  assert.equal(edit.hasAttribute('disabled'), false, 'and is offered for an unlocked run')
  edit.click()
  await flush()
  const title = clickMount.host.querySelector('.dialog-title')
  assert.equal(
    (title?.textContent ?? '').trim(),
    enMessages['dialogs.textTool.editTitle'],
    'clicking it reopens the text editor dialog',
  )
  const value = clickMount.host.querySelector('#text-tool-value') as HTMLInputElement | null
  assert.equal(value?.value, 'ABC', 'with the run it opened on')
  clickMount.unmount()
}

// ── a shared shape: Make unique in Instance ────────────────────

async function testMakeUniqueLivesInInstance(): Promise<void> {
  const featureId = addPlainRect()
  const copyId = addLinkedCopy(featureId)
  store().selectFeature(featureId)
  const mounted = mount()
  await mounted.openSection('Shape')
  await mounted.openSection('Instance')

  const shape = mounted.section('Shape')
  const instance = mounted.section('Instance')
  assert.ok(shape, 'the shared shape has a Shape section')
  assert.ok(instance, 'and an Instance section')
  assert.ok(
    !buttonByLabel(shape, MAKE_UNIQUE),
    `Make unique is not in Shape any more, got ${JSON.stringify(labels(shape))}`,
  )
  const makeUnique = buttonByLabel(instance, MAKE_UNIQUE)
  assert.ok(
    makeUnique,
    `Make unique renders inside Instance, got ${JSON.stringify(labels(instance))}`,
  )
  assert.ok(
    !buttonByLabel(mounted.bottomActions(), MAKE_UNIQUE),
    'and not in the bottom row',
  )

  // Unchanged behaviour: the click still unlinks this instance, and the entry
  // is still only there while the shape is shared.
  const before = store().project
  const definitionId = before.features.find((feature) => feature.id === featureId)?.definitionId
  assert.ok(definitionId, 'the shared instance has a definition')
  assert.ok(
    before.features.filter((feature) => feature.definitionId === definitionId).length === 2,
    'the fixture really is a shared definition',
  )
  makeUnique.click()
  await flush()
  const after = store().project
  const uniqueDefinition = after.features.find((feature) => feature.id === featureId)?.definitionId
  assert.notEqual(uniqueDefinition, definitionId, 'Make unique gives this instance its own definition')
  assert.equal(
    after.features.find((feature) => feature.id === copyId)?.definitionId,
    definitionId,
    'and leaves the other copy on the shared one',
  )
  assert.ok(
    !buttonByLabel(mounted.section('Instance'), MAKE_UNIQUE),
    'the entry disappears once the shape is no longer shared, as before',
  )
  mounted.unmount()
}

await testPlainFeature()
await testCannedShape()
await testTextFeature()
await testMakeUniqueLivesInInstance()

console.log('shape edit action tests passed')
