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
 * An empty face's feature-tree section belongs to the face being worked on,
 * not to every project that uses both faces (issue #1112 slice B review).
 *
 * The reported sequence: visit an empty Bottom from the menu, then return to
 * Around. Around already makes `projectUsesBothFaces` true, so rendering the
 * sections on that flag alone left Bottom behind after it was empty and no
 * longer current.
 *
 * Mutations checked one at a time against these assertions:
 * - rendering every face section whenever the project uses both faces → the
 *   "empty Bottom is hidden while Around is current" assertion fails;
 * - hiding every non-current face, content or not → the "Bottom with content
 *   stays" assertion fails;
 * - showing the current face only when it has content → the "current empty
 *   Bottom still says so" assertion fails;
 * - listing a canned model under both its authoring face and the current face
 *   → the "exactly one row" assertion fails (issue #1112).
 *
 * Run with: npx tsx src/components/feature-tree/faceSectionVisibility.test.ts
 */

import * as React from 'react'
import { createElement, type ReactElement } from 'react'
import { parseHTML } from 'linkedom'
import { FeatureTree } from './FeatureTree'
import { I18nProvider } from '../../i18n/I18nProvider'
import { enMessages } from '../../i18n/locales/en'
import { useProjectStore } from '../../store/projectStore'
import { defaultSetupForFace, provisionalSetupId } from '../../store/helpers/provisionalSetup'
import { newProject, rectProfile, roundStock } from '../../types/project'
import type { FeatureDefinition, FeatureInstance, Project } from '../../types/project'

// A DOM for the client render, in place before React DOM is first imported.
const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
if (typeof globals.navigator === 'undefined') globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
// `useShellMode` asks for a coarse pointer and the viewport width on mount.
;(window as unknown as { matchMedia: (query: string) => unknown }).matchMedia = () => ({
  matches: false,
  media: '',
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
// Components are authored with the automatic JSX runtime; the tsx runner
// transpiles this file with the classic one, which expects a global `React`.
;(globalThis as unknown as { React?: typeof React }).React = React

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** The default project, on a rotary bar so Around is a real face to be on. */
function projectOn(face: 'top' | 'around' | 'bottom', withBottomFeature = false): Project {
  const base = newProject()
  const stock = roundStock(12, 30, 'x')
  const meta = { ...base.meta, projectType: 'rotary' as const }
  const around = defaultSetupForFace('around', { stock, meta })
  const project: Project = {
    ...base,
    meta,
    stock,
    setups: [...base.setups, around],
    activeSetupId: face === 'around'
      ? around.id
      : face === 'bottom'
        ? provisionalSetupId('bottom')
        : base.activeSetupId,
  }
  if (!withBottomFeature) return project

  const definition: FeatureDefinition = {
    id: 'def-bottom-pocket',
    kind: 'rect',
    profile: rectProfile(1, 1, 3, 2),
    dimensions: [],
    operation: 'subtract',
  }
  const instance: FeatureInstance = {
    id: 'bottom-pocket',
    name: 'Bottom pocket',
    definitionId: definition.id,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    constraints: [],
    z_top: 0.25,
    z_bottom: 0,
    authoringFace: 'bottom',
    folderId: null,
    visible: true,
    locked: false,
  }
  return {
    ...project,
    featureDefinitions: { ...project.featureDefinitions, [definition.id]: definition },
    features: [instance],
    featureTree: [{ type: 'feature', featureId: instance.id }],
  }
}

/**
 * The same project with one canned model. A canned model is authored on Top
 * because that is the face the persisted-model loader accepts, but it is a
 * model rather than face geometry: it must be listed in the face being worked
 * on and nowhere else (issue #1112).
 */
function withCannedModel(project: Project): Project {
  const definition: FeatureDefinition = {
    id: 'def-hex',
    kind: 'stl',
    profile: rectProfile(0, 0, 4, 4),
    dimensions: [],
    operation: 'model',
    stl: null,
    canned: { kind: 'polygon', params: {} },
  }
  const instance: FeatureInstance = {
    id: 'hex',
    name: 'Hex',
    definitionId: definition.id,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    constraints: [],
    z_top: 4,
    z_bottom: 0,
    authoringFace: 'top',
    folderId: null,
    visible: true,
    locked: false,
  }
  return {
    ...project,
    featureDefinitions: { ...project.featureDefinitions, [definition.id]: definition },
    features: [instance],
    featureTree: [{ type: 'feature', featureId: instance.id }],
  }
}

/** Render `element` as the browser would, and return its markup. */
async function render(element: ReactElement): Promise<string> {
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(element))
  const html = host.innerHTML
  flushSync(() => root.unmount())
  host.remove()
  return html
}

async function renderTree(project: Project): Promise<string> {
  useProjectStore.setState({ project })
  return render(createElement(I18nProvider, null, createElement(FeatureTree)))
}

// An empty Bottom visited from the menu, then Around made current: both faces
// are in use because Around is, but Bottom has nothing and is not current.
{
  const html = await renderTree(projectOn('around'))
  assert(html.includes('data-face-layer="around"'), 'the current Around section is shown')
  assert(html.includes(enMessages['featureTree.face.empty']), 'the current empty Around section says so')
  assert(!html.includes('data-face-layer="bottom"'), 'the empty Bottom section is hidden while Around is current')
  assert(!html.includes('data-face-layer="top"'), 'the empty Top section is hidden while Around is current')
}

// The face being worked on keeps its section even when empty: it is where the
// next feature goes.
{
  const html = await renderTree(projectOn('bottom'))
  assert(html.includes('data-face-layer="bottom"'), 'the current empty Bottom section is shown')
  assert(html.includes(enMessages['featureTree.face.empty']), 'the current empty Bottom section says it is empty')
}

// Content keeps a face's section listed while another face is current.
{
  const html = await renderTree(projectOn('around', true))
  assert(html.includes('data-face-layer="bottom"'), 'a Bottom section with content stays while Around is current')
  assert(html.includes('data-face-state="ghost"'), 'that section is the ghost heading of the other face')
}

// ── A model is listed once, in the layer being worked on (issue #1112 I) ──

/**
 * An imported model is not tied to a face: it is a normal, selectable row on
 * every face, and it appears once — in the current face's layer — rather than
 * under its authoring face and the current one. Mutations checked one at a
 * time: listing it only under its authoring face → the Around/Bottom counts
 * fail; listing it under both → the count of 2 fails.
 */
function projectWithModel(face: 'top' | 'around' | 'bottom'): Project {
  const project = projectOn(face)
  const definition: FeatureDefinition = {
    id: 'def-model',
    kind: 'stl',
    profile: rectProfile(1, 1, 3, 2),
    dimensions: [],
    stl: null,
    operation: 'model',
    canned: { kind: 'polygon', params: {} },
  }
  const instance: FeatureInstance = {
    id: 'model',
    name: 'Model',
    definitionId: definition.id,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    constraints: [],
    z_top: 5,
    z_bottom: 0,
    authoringFace: 'top',
    folderId: null,
    visible: true,
    locked: false,
  }
  return {
    ...project,
    featureDefinitions: { ...project.featureDefinitions, [definition.id]: definition },
    features: [instance],
    featureTree: [{ type: 'feature', featureId: instance.id }],
  }
}

for (const face of ['top', 'bottom', 'around'] as const) {
  const html = await renderTree(projectWithModel(face))
  const rows = html.match(/data-feature-id="model"/g) ?? []
  assert(rows.length === 1, `on ${face}: the model row is listed once (${rows.length})`)
  const layer = face === 'around' ? 'around' : face
  assert(html.includes(`data-face-layer="${layer}"`), `on ${face}: its layer is the current one`)
}

// A through subtract is a normal, selectable row on the inactive flat face:
// it is not a ghost, because it can be a target from there too. A blind cut on
// the same face keeps its ghost row.
{
  const project = projectOn('top')
  const thickness = project.stock.thickness
  const definition: FeatureDefinition = {
    id: 'def-through',
    kind: 'rect',
    profile: rectProfile(1, 1, 3, 2),
    dimensions: [],
    operation: 'subtract',
  }
  const through: FeatureInstance = {
    id: 'through',
    name: 'Through',
    definitionId: definition.id,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    constraints: [],
    z_top: thickness,
    z_bottom: 0,
    authoringFace: 'top',
    folderId: null,
    visible: true,
    locked: false,
  }
  const blind: FeatureInstance = { ...through, id: 'blind', name: 'Blind', z_bottom: thickness / 2 }
  const html = await renderTree({
    ...project,
    features: [through, blind],
    featureTree: [{ type: 'feature', featureId: 'through' }, { type: 'feature', featureId: 'blind' }],
    featureDefinitions: { [definition.id]: definition },
    activeSetupId: provisionalSetupId('bottom'),
  })
  const rowTag = (markup: string, id: string): string => {
    const at = markup.indexOf(`data-feature-id="${id}"`)
    return markup.slice(markup.lastIndexOf('<div', at), markup.indexOf('>', at))
  }
  assert(html.includes('data-feature-id="through"'), 'the through feature is listed on Bottom')
  assert(!rowTag(html, 'through').includes('data-ghost="true"'), 'and it is not a ghost row')
  assert(rowTag(html, 'blind').includes('data-ghost="true"'), 'the blind cut on the other face is a ghost row')
}

// A canned model authored on Top is listed once, under the face being worked
// on. Rendering the authoring face too put one row under Top and one under
// Around at the same time (issue #1112).
{
  const html = await renderTree(withCannedModel(projectOn('around')))
  const rows = html.match(/data-feature-id="hex"/g) ?? []
  assert(rows.length === 1, 'the canned model has exactly one row while Around is current')
  assert(html.includes('data-face-layer="around"'), 'the row is in the current Around layer')
  assert(!html.includes('data-face-layer="top"'), 'the authored Top layer is not also shown')
}

// The same row follows the face switch: one row on Top, none left behind.
{
  const html = await renderTree(withCannedModel(projectOn('top')))
  const rows = html.match(/data-feature-id="hex"/g) ?? []
  assert(rows.length === 1, 'the canned model has exactly one row while Top is current')
  assert(html.includes('data-face-layer="top"'), 'the row is in the current Top layer')
}

console.log('face section visibility tests passed')
