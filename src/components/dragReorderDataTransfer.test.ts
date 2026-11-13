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
 * Every reorder drag carries the row id in `dataTransfer` (issue #1178).
 *
 * WebKitGTK — the webview of the Linux desktop build — will not complete an
 * HTML5 drag whose data store is empty: `dragstart` and `dragover` fire but
 * `drop` never does, so a row dragged in the Tauri app reordered nothing while
 * the same drag worked in Chromium. `dragDropEnabled: false` (#303) is still the
 * right setting; what was missing was a payload. The reorder itself reads the
 * component's own drag state, so the payload is belt-and-braces for other drop
 * targets and, more importantly, what makes WebKitGTK treat the drag as real.
 *
 * Both panels are rendered for real and dispatched a native DOM `dragstart`
 * with a stub `dataTransfer`, because the regression lives in the wiring
 * between the row and its handler, not in a pure function:
 * - removing `setData` from `FeatureTree`'s feature or folder drag start →
 *   "the feature row stores its id in the drag" / "the folder row stores its
 *   id in the drag" fails;
 * - removing `setData` from `CAMPanel`'s operation drag start → "the operation
 *   row stores its id in the drag" fails;
 * - dropping `effectAllowed = 'move'` → the effectAllowed assertions fail;
 * - dropping `dropEffect = 'move'` from either dragover → the drop-effect
 *   assertions fail.
 *
 * Run with: NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/dragReorderDataTransfer.test.ts
 */

import * as React from 'react'
import { createElement } from 'react'
import { parseHTML } from 'linkedom'

const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
if (typeof globals.navigator === 'undefined') globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
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
;(globalThis as unknown as { React?: typeof React }).React = React

const { FeatureTree } = await import('./feature-tree/FeatureTree')
const { CAMPanel } = await import('./cam/CAMPanel')
const { I18nProvider } = await import('../i18n/I18nProvider')
const { useProjectStore } = await import('../store/projectStore')
const { newProject } = await import('../types/project')
const { projectWithFeatures } = await import('../test/projectFixtures')
const { defaultOperationForTarget } = await import('../store/helpers/operationDefaults')
const { flushSync } = await import('react-dom')
import type { Operation, Project, SketchProfile } from '../types/project'
import type { TestFeatureRow } from '../test/projectFixtures'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function rectangle(x: number, y: number, w: number, h: number): SketchProfile {
  return {
    start: { x, y },
    segments: [
      { type: 'line', to: { x: x + w, y } },
      { type: 'line', to: { x: x + w, y: y + h } },
      { type: 'line', to: { x, y: y + h } },
      { type: 'line', to: { x, y } },
    ],
    closed: true,
  }
}

function feature(id: string): TestFeatureRow {
  return {
    id, name: id, kind: 'rect', folderId: null,
    sketch: { profile: rectangle(0, 0, 10, 10), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'add', z_top: 5, z_bottom: 0, visible: true, locked: false,
  }
}

/** Two features, one folder and two operations — the ids the drags must carry. */
function dragProject(): Project {
  const base = newProject('drag payload', 'mm')
  const withRows = projectWithFeatures(base, [feature('feat-a'), feature('feat-b')])
  const withFolder: Project = {
    ...withRows,
    featureFolders: [{ id: 'folder-a', name: 'Folder A', collapsed: false, section: 'features' }],
    featureTree: [{ type: 'folder', folderId: 'folder-a' }, ...withRows.featureTree],
  }
  const operation = (id: string): Operation => ({
    ...defaultOperationForTarget(withFolder, 'pocket', 'rough', { source: 'features', featureIds: ['feat-a'] }, 0),
    id,
    name: id,
  })
  return { ...withFolder, operations: [operation('op-a'), operation('op-b')] }
}

/** A `dataTransfer` the DOM can hand to React — linkedom has no DataTransfer. */
interface StubDataTransfer {
  data: Map<string, string>
  effectAllowed: string
  dropEffect: string
  setData: (type: string, value: string) => void
  getData: (type: string) => string
}

function stubDataTransfer(): StubDataTransfer {
  const data = new Map<string, string>()
  return {
    data,
    effectAllowed: 'none',
    dropEffect: 'none',
    setData(type, value) { data.set(type, value) },
    getData(type) { return data.get(type) ?? '' },
  }
}

/** A native drag event carrying the stub, dispatched the way the DOM does. */
function fireDrag(target: Element, type: 'dragstart' | 'dragover', dataTransfer: StubDataTransfer): Event {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  flushSync(() => target.dispatchEvent(event))
  return event
}

async function mount(element: React.ReactElement): Promise<{ host: HTMLElement; unmount: () => void }> {
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(createElement(I18nProvider, null, element)))
  return {
    host,
    unmount: () => { flushSync(() => root.unmount()); host.remove() },
  }
}

function row(host: HTMLElement, selector: string, label: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>(selector)]
    .find((element) => element.textContent?.includes(label))
  assert(found, `the panel renders the ${label} row`)
  return found
}

const project = dragProject()
useProjectStore.setState({ project })

// ── Feature rows ────────────────────────────────────────────────
{
  const harness = await mount(createElement(FeatureTree, {}))
  const featureRow = harness.host.querySelector<HTMLElement>('.tree-row[data-feature-id="feat-a"]')
  assert(featureRow, 'the tree renders feat-a')
  assert(featureRow.getAttribute('draggable') === 'true', 'the feature row is draggable')

  const start = stubDataTransfer()
  fireDrag(featureRow, 'dragstart', start)
  assert(start.getData('text/plain') === 'feat-a', 'the feature row stores its id in the drag')
  assert(start.effectAllowed === 'move', 'the feature drag allows the move effect')

  const over = stubDataTransfer()
  const target = harness.host.querySelector<HTMLElement>('.tree-row[data-feature-id="feat-b"]')
  assert(target, 'the tree renders feat-b')
  const dragover = fireDrag(target, 'dragover', over)
  assert(dragover.defaultPrevented, 'the feature row accepts the drop')
  assert(over.dropEffect === 'move', 'the feature drop effect is move')
  harness.unmount()
}

// ── Folder rows ─────────────────────────────────────────────────
{
  const harness = await mount(createElement(FeatureTree, {}))
  const folderRow = row(harness.host, '.tree-row--folder', 'Folder A')

  const start = stubDataTransfer()
  fireDrag(folderRow, 'dragstart', start)
  assert(start.getData('text/plain') === 'folder-a', 'the folder row stores its id in the drag')
  assert(start.effectAllowed === 'move', 'the folder drag allows the move effect')

  const over = stubDataTransfer()
  const dragover = fireDrag(folderRow, 'dragover', over)
  assert(dragover.defaultPrevented, 'the folder row accepts the drop')
  assert(over.dropEffect === 'move', 'the folder drop effect is move')
  harness.unmount()
}

// ── CAM operation rows ──────────────────────────────────────────
{
  const harness = await mount(createElement(CAMPanel, {
    mode: 'operations',
    selectedOperationId: null,
    onSelectedOperationIdChange: () => {},
    onExport: () => {},
    onExportOperation: () => {},
    requestToolpath: async () => null,
    documentKey: 0,
  }))
  const operationRow = row(harness.host, '.cam-operation-tree .tree-row', 'op-a')
  assert(operationRow.getAttribute('draggable') === 'true', 'the operation row is draggable')

  const start = stubDataTransfer()
  fireDrag(operationRow, 'dragstart', start)
  assert(start.getData('text/plain') === 'op-a', 'the operation row stores its id in the drag')
  assert(start.effectAllowed === 'move', 'the operation drag allows the move effect')

  const target = row(harness.host, '.cam-operation-tree .tree-row', 'op-b')
  const over = stubDataTransfer()
  const dragover = fireDrag(target, 'dragover', over)
  assert(dragover.defaultPrevented, 'the operation row accepts the drop')
  assert(over.dropEffect === 'move', 'the operation drop effect is move')
  harness.unmount()
}

console.log('Drag reorder payload: feature, folder and CAM operation drag starts carry an id')
