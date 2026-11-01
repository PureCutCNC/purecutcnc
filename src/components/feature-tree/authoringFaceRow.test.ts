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
 * A disabled context-menu item's reason is also asserted as visible text on
 * both desktop and tablet (issue #1112 A3): touch has no native `title`.
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
import { resolveFeatureInstance } from '../../store/helpers/resolveFeatures'
import { newProject, rectProfile, roundStock } from '../../types/project'
import type { FeatureDefinition, FeatureInstance, MachiningSetup, Project, SetupFace, SketchFeature } from '../../types/project'
import type { FeatureTreeActions } from '../../app/useFeatureTreeActions'
import { registerTestCannedShapes, testPlateCanned } from '../../test/cannedShapeFixture'

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
  editCannedShape: noop,
  expandCannedFeature: noop,
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

function menuProps(
  menuFeature: SketchFeature,
  overrides: { tabletShell?: boolean } = {},
): Parameters<typeof FeatureContextMenu>[0] {
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
    menuFeatureTargetableFromFace: false,
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
    tabletShell: overrides.tabletShell ?? false,
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

async function renderMenu(
  project: Project,
  menuFeature: SketchFeature,
  overrides: { tabletShell?: boolean } = {},
): Promise<string> {
  useProjectStore.setState({ project })
  return render(createElement(I18nProvider, null, createElement(FeatureContextMenu, menuProps(menuFeature, overrides))))
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

function menuItemCount(html: string): number {
  return (html.match(/class="feature-context-menu__item(?=[" ])/g) ?? []).length
}

async function testGhostMenuOnTop(): Promise<void> {
  // A Bottom feature seen from Top is a ghost; changing its face is offered.
  const html = await renderMenu(projectOn('top'), feature('f1', 'bottom'))
  assert(html.includes(enMessages['featureTree.face.switchToBottomToEdit']), 'the ghost menu offers the switch')
  assert(menuItemCount(html) === 2, `on Top the ghost menu carries the Change entry (${menuItemCount(html)} items)`)
  assert(html.includes(enMessages['featureTree.face.changeAuthoringFace']), 'on Top the Change entry carries its label')
}

async function testGhostMenuOnAround(): Promise<void> {
  // A Top feature seen from Around is a ghost; changing its face is refused there.
  const html = await renderMenu(projectOn('around'), feature('f1', 'top'))
  assert(html.includes(enMessages['featureTree.face.switchToTopToEdit']), 'the ghost menu still offers the switch')
  assert(menuItemCount(html) === 1, `on Around the ghost menu has no Change entry (${menuItemCount(html)} items)`)
  assert(!html.includes(enMessages['featureTree.face.changeAuthoringFace']), 'on Around no Change label is drawn')
}

// ── Refusals are visible text, not hover-only ──────────────────

function cannedProject(): { project: Project; menuFeature: SketchFeature } {
  registerTestCannedShapes()
  const definition: FeatureDefinition = {
    id: 'def-canned',
    kind: 'composite',
    profile: rectProfile(0, 0, 100, 60),
    dimensions: [],
    text: null,
    canned: testPlateCanned(100, 60, 12),
    stl: null,
    operation: 'add',
  }
  const instance: FeatureInstance = {
    id: 'canned',
    name: 'Plate',
    definitionId: definition.id,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    constraints: [],
    folderId: null,
    z_top: 5,
    z_bottom: 0,
    authoringFace: 'top',
    visible: true,
    locked: false,
  }
  const project: Project = {
    ...newProject(),
    featureDefinitions: { [definition.id]: definition },
    features: [instance],
  }
  const menuFeature = resolveFeatureInstance(project, instance.id)
  assert(menuFeature, 'the canned feature resolves')
  return { project, menuFeature }
}

async function testCannedRefusalIsVisibleOnDesktopAndTablet(): Promise<void> {
  const { project, menuFeature } = cannedProject()
  const refusal = enMessages['sketch.canned.actionRefused']
  const cases: Array<[string, string]> = [
    [enMessages['featureTree.contextMenu.addConstraint'], refusal],
    [enMessages['featureTree.contextMenu.offset'], refusal],
    [enMessages['featureTree.contextMenu.join'], refusal],
    [enMessages['featureTree.contextMenu.cut'], refusal],
  ]

  for (const tabletShell of [false, true]) {
    const html = await renderMenu(project, menuFeature, { tabletShell })
    const parsed = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
    const buttons = Array.from(parsed.document.querySelectorAll('button'))
    const shell = tabletShell ? 'tablet' : 'desktop'
    for (const [label, reason] of cases) {
      const button = buttons.find((candidate) => (candidate.textContent ?? '').startsWith(label))
      assert(button, `${shell}: the ${label} item is rendered`)
      assert(button.hasAttribute('disabled'), `${shell}: ${label} is disabled for a canned shape`)
      assert(
        (button.textContent ?? '').includes(reason),
        `${shell}: ${label} shows its reason as visible text, not only a title`,
      )
      assert(button.getAttribute('title') === reason, `${shell}: ${label} keeps the desktop title`)
    }
    // A generated shape's one edit entry is its own editor: Edit sketch is not
    // offered at all, so there is no second, disabled edit to read
    // (issue #1112 rt7-i).
    assert(
      !buttons.some((candidate) => (candidate.textContent ?? '').startsWith(enMessages['featureTree.contextMenu.editSketch'])),
      `${shell}: a canned shape shows no Edit sketch entry`,
    )
    assert(
      html.includes('feature-context-menu__item-reason'),
      `${shell}: the reason line uses the shared menu-item presentation`,
    )
  }
}

async function main(): Promise<void> {
  await testAuthoringFaceRowOnTop()
  await testAuthoringFaceRowOnAround()
  await testAuthoringFaceRowOnAnAroundFeature()
  await testGhostMenuOnTop()
  await testGhostMenuOnAround()
  await testCannedRefusalIsVisibleOnDesktopAndTablet()
  console.log('authoringFaceRow tests passed')
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
