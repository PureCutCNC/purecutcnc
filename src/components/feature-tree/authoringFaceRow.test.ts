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
 * The "Change authoring face" control is absent while the workspace is on
 * Around (issue #1015 slice K). `requestAuthoringFaceChange` refuses there, so
 * leaving the control visible made it silently do nothing; it is now left out,
 * exactly as it already is for an Around feature.
 *
 * Two controls carry it, and both are rendered here:
 *  - `AuthoringFaceRow`, the feature-properties row ("Change…");
 *  - the ghost-feature context menu, whose entry is shown only for a flat face.
 *
 * The render is a real client render into a `linkedom` document (the DOM the
 * SVG importer tests already use) rather than `renderToStaticMarkup`: the
 * components read the active face through `useProjectStore`, and zustand v5
 * answers React's *server* snapshot from `getInitialState`, so a server render
 * would always see the project the store was created with and could not tell
 * Around from Top.
 *
 * Mutations checked one at a time against these assertions:
 *  - the `workspaceFace === 'around'` guard dropped from either component → the
 *    matching "absent on Around" assertion fails;
 *  - the guard inverted, or the face compared to the feature's instead of the
 *    workspace's → the "present on Top" assertions fail.
 *
 * Run with: npx tsx src/components/feature-tree/authoringFaceRow.test.ts
 */

import * as React from 'react'
import { createElement, type ReactElement } from 'react'
import { parseHTML } from 'linkedom'
import { AuthoringFaceRow } from './FaceChip'
import { FeatureContextMenu } from './FeatureContextMenu'
import { I18nProvider } from '../../i18n/I18nProvider'
import { enMessages } from '../../i18n/locales/en'
import { useProjectStore } from '../../store/projectStore'
import { newProject, rectProfile, roundStock } from '../../types/project'
import type { MachiningSetup, Project, SetupFace, SketchFeature } from '../../types/project'
import type { FeatureTreeActions } from '../../app/useFeatureTreeActions'

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

const noop = (): void => {}

const actions: FeatureTreeActions = {
  editSketch: noop,
  constraint: noop,
  copyFeature: noop,
  makeUnique: noop,
  selectLinkedInstances: noop,
  moveFeature: noop,
  resizeFeature: noop,
  rotateFeature: noop,
  mirrorFeature: noop,
  offsetFeatures: noop,
  joinFeatures: noop,
  cutFeatures: noop,
  useAsStock: noop,
  deleteFeatures: noop,
  createQuickOperation: async () => {},
  addToOperation: noop,
  removeFromOperation: noop,
  groupFeatures: noop,
  assignToFolder: noop,
  createNewFolderAndAssign: noop,
  editTab: noop,
  copyTab: noop,
  moveTab: noop,
  deleteTab: noop,
  deleteTabs: noop,
  editClamp: noop,
  copyClamp: noop,
  moveClamp: noop,
  deleteClamp: noop,
  deleteClamps: noop,
  switchFaceToEdit: noop,
  changeAuthoringFace: noop,
}

const AROUND_SETUP: MachiningSetup = {
  id: 'setup-around',
  name: 'Around',
  kind: 'around',
  orientation: { axis: 'x', angleDeg: 0 },
  indexing: 'manual',
  registration: [],
  notes: '',
  operationIds: [],
}

/** The workspace on Top, or on an Around setup with a round bar. */
function projectOn(face: 'top' | 'around'): Project {
  const base = newProject()
  if (face === 'top') return base
  return {
    ...base,
    stock: roundStock(12, 30, 'x'),
    setups: [...base.setups, AROUND_SETUP],
    activeSetupId: AROUND_SETUP.id,
  }
}

function feature(id: string, authoringFace: SetupFace): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    stl: null,
    folderId: null,
    sketch: { profile: rectProfile(0, 0, 10, 10), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'add',
    authoringFace,
    z_top: 0,
    z_bottom: -3,
    visible: true,
    locked: false,
  }
}

async function renderRow(project: Project, face: SetupFace): Promise<string> {
  useProjectStore.setState({ project })
  return render(createElement(I18nProvider, null, createElement(AuthoringFaceRow, { face, featureIds: ['f1'] })))
}

function menuProps(menuFeature: SketchFeature): Parameters<typeof FeatureContextMenu>[0] {
  return {
    menuRef: { current: null },
    position: { left: 0, top: 0 },
    menuFeature,
    menuTab: null,
    menuClamp: null,
    menuHasMultipleSelection: false,
    menuCanUseAsStock: false,
    menuHasLockedSelection: false,
    menuFeatureHasLinkedInstances: false,
    menuQuickOperations: [],
    quickOpsSubmenu: null,
    menuFeatureFolders: [],
    menuAddToOperationCandidates: [],
    menuRemoveFromOperationCandidates: [],
    addToOperationSubmenu: null,
    removeFromOperationSubmenu: null,
    addToFolderSubmenu: null,
    menuSelectionInGroupedFolder: false,
    menuSelectionSectionsMixed: false,
    menuSelectionIsGroup: false,
    tabletShell: false,
    primaryId: menuFeature.id,
    ids: [menuFeature.id],
    actions,
    onOpenQuickOpsSubmenu: noop,
    onCloseQuickOpsSubmenu: noop,
    onOpenAddToFolderSubmenu: noop,
    onCloseAddToFolderSubmenu: noop,
    onOpenAddToOperationSubmenu: noop,
    onCloseAddToOperationSubmenu: noop,
    onOpenRemoveFromOperationSubmenu: noop,
    onCloseRemoveFromOperationSubmenu: noop,
  }
}

async function renderMenu(project: Project, menuFeature: SketchFeature): Promise<string> {
  useProjectStore.setState({ project })
  return render(createElement(I18nProvider, null, createElement(FeatureContextMenu, menuProps(menuFeature))))
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// ── The feature-properties row ────────────────────────────────

async function testAuthoringFaceRowOnTop(): Promise<void> {
  const html = await renderRow(projectOn('top'), 'bottom')
  assert(html.includes('face-row__change'), 'on Top the Change control is offered')
  assert(html.includes(enMessages['featureTree.face.change']), 'on Top the Change control carries its label')
}

async function testAuthoringFaceRowOnAround(): Promise<void> {
  const html = await renderRow(projectOn('around'), 'top')
  assert(!html.includes('face-row__change'), 'on Around the Change control is left out')
  assert(!html.includes(enMessages['featureTree.face.change']), 'on Around no Change label is drawn')
  assert(html.includes(enMessages['featureTree.face.chipTop']), 'the row still names the feature face')
}

/** An Around feature was never offered the change; the workspace guard must not change that. */
async function testAuthoringFaceRowOnAnAroundFeature(): Promise<void> {
  const html = await renderRow(projectOn('top'), 'around')
  assert(!html.includes('face-row__change'), 'an Around feature is still never offered the Change control')
}

// ── The ghost-feature context menu ────────────────────────────

const MENU_ITEM = 'class="feature-context-menu__item"'

async function testGhostMenuOnTop(): Promise<void> {
  // A Bottom feature seen from Top is a ghost; changing its face is offered.
  const html = await renderMenu(projectOn('top'), feature('f1', 'bottom'))
  assert(html.includes(enMessages['featureTree.face.switchToBottomToEdit']), 'the ghost menu offers the switch')
  assert(occurrences(html, MENU_ITEM) === 2, `on Top the ghost menu carries the Change entry (${occurrences(html, MENU_ITEM)} items)`)
  assert(html.includes(enMessages['featureTree.face.changeAuthoringFace']), 'on Top the Change entry carries its label')
}

async function testGhostMenuOnAround(): Promise<void> {
  // A Top feature seen from Around is a ghost; changing its face is refused there.
  const html = await renderMenu(projectOn('around'), feature('f1', 'top'))
  assert(html.includes(enMessages['featureTree.face.switchToTopToEdit']), 'the ghost menu still offers the switch')
  assert(occurrences(html, MENU_ITEM) === 1, `on Around the ghost menu has no Change entry (${occurrences(html, MENU_ITEM)} items)`)
  assert(!html.includes(enMessages['featureTree.face.changeAuthoringFace']), 'on Around no Change label is drawn')
}

async function main(): Promise<void> {
  await testAuthoringFaceRowOnTop()
  await testAuthoringFaceRowOnAround()
  await testAuthoringFaceRowOnAnAroundFeature()
  await testGhostMenuOnTop()
  await testGhostMenuOnAround()
  console.log('authoringFaceRow tests passed')
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
