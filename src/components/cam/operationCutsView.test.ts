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
 * The Cuts list as the panel draws it (issue #1112 slice I): the operation's
 * targets as chips, each with a remove × that is refused on the last one, and a
 * count that follows the target. The rules themselves are `operationCuts.ts`'s;
 * this pins the wiring — a chip that draws but cannot remove would leave the
 * "keep an unchecked model out" behaviour unreachable.
 *
 * Mutations checked one at a time:
 *  - `onRemove` dropped from the × → the store target keeps both ids;
 *  - the list rendered from every project feature → the chip count is 3;
 *  - the last chip's × left enabled → the disabled assertion fails;
 *  - the name dropped from a chip → the name assertion fails, and the chip's
 *    own remove button is left as its only labelled content (issue #1112 rt3-a,
 *    item 25: the panel drew a × with no name because the field rule stretched
 *    the button over the name's whole column);
 *  - the icon dropped from a chip → the icon assertion fails;
 *  - the chips drawn straight into the list instead of into a
 *    `.cam-cuts__group` → the wrapping assertion fails, because those chips
 *    would take a line each again (issue #1112 rt6-b, item 40);
 *  - the same for a long list's folder, whose chips are drawn into `<details>`
 *    without a group → the folder's wrapping assertion fails.
 *
 * The layout the chips are packed by is CSS, so "several on one line" is
 * asserted in the browser: `e2e/tablet1112.smoke.spec.ts` and
 * `e2e/setupCam.smoke.spec.ts`.
 *
 * Run with: npx tsx src/components/cam/operationCutsView.test.ts
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

const { OperationCuts } = await import('./OperationCuts')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { useProjectStore } = await import('../../store/projectStore')
const { projectWithFeatures } = await import('../../test/projectFixtures')
const { defaultOperationForTarget } = await import('../../store/helpers/operationDefaults')
const { newProject, rectProfile } = await import('../../types/project')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const drafts = ['a', 'b', 'c'].map((id) => ({
  id,
  name: id.toUpperCase(),
  kind: 'rect' as const,
  folderId: null,
  sketch: { profile: rectProfile(1, 1, 2, 2), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  operation: 'subtract' as const,
  z_top: 2,
  z_bottom: 0,
  visible: true,
  locked: false,
}))
const project = projectWithFeatures(newProject('cuts view', 'mm'), drafts)
const operation = defaultOperationForTarget(project, 'pocket', 'rough', { source: 'features', featureIds: ['a', 'b'] }, 0)
project.operations = [operation]
useProjectStore.setState({ project })

const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host)
flushSync(() => root.render(createElement(I18nProvider, null, createElement(OperationCuts, { project, operation }))))

const cuts = host.querySelector('[data-operation-cuts]')
assert(cuts, 'the Cuts list renders')
assert(cuts.textContent?.includes('Cuts'), 'it is labelled Cuts')
// The label is the field's own child with the list as its sibling, which is what
// lets it take a row above the chips instead of a column beside them
// (issue #1112 rt6-b, item 40).
const cutsLabel = Array.from(cuts.children).find((child) => child.tagName === 'SPAN')
assert(cutsLabel, 'the Cuts field has its own label')
assert(cutsLabel.textContent === 'Cuts', `the label reads Cuts (saw ${JSON.stringify(cutsLabel.textContent)})`)
assert(cutsLabel.nextElementSibling === host.querySelector('.cam-cuts__list'), 'and the chips follow it as a sibling')
assert(host.querySelectorAll('[data-cut-feature-id]').length === 2, 'only the operation targets are chips, not every feature')
// A chip is the target's icon, its name, and a small remove × — the name first,
// so a chip that only draws its × is caught here rather than in a screenshot
// (issue #1112 rt3-a, item 25).
const chipA = host.querySelector('[data-cut-feature-id="a"]')
assert(chipA, 'target "A" has a chip')
assert(chipA.classList.contains('cam-cuts__chip'), `a target is drawn as a chip (saw ${chipA.className})`)
// Chips are laid out by a wrapping group (issue #1112 rt6-b, item 40): the same
// chips placed straight in the list would take a line each, which is the bug
// the change removes.
const group = chipA.parentElement
assert(group, 'the chip has a parent to be laid out by')
assert(group.classList.contains('cam-cuts__group'), `chips share a wrapping group (saw ${group.className})`)
assert(group.querySelectorAll('.cam-cuts__chip').length === 2, 'both targets sit in that one group')
const nameA = chipA.querySelector('.cam-cuts__name')
assert(nameA?.textContent === 'A', `a chip shows the target name (saw ${JSON.stringify(nameA?.textContent)})`)
const iconA = chipA.querySelector('.cam-cuts__icon')
assert(iconA, 'a chip shows the target icon')
assert(iconA.getAttribute('data-cut-icon') === 'rect', 'the icon is the shape the target is')
const useA = iconA.querySelector('use')
assert(useA?.getAttribute('href')?.endsWith('#rect'), `the icon references the rect sprite symbol (saw ${useA?.getAttribute('href')})`)
const removeA = chipA.querySelector('.cam-cuts__remove')
assert(removeA, 'the chip has a remove control')

// Remove "B": the store target keeps only "A" (the Cuts list is a writer, not a
// second target store).
function click(selector: string): void {
  const element = host.querySelector(selector) as HTMLElement | null
  assert(element, `click target exists: ${selector}`)
  flushSync(() => element.click())
}
click('[data-cut-feature-id="b"] .cam-cuts__remove')
const written = useProjectStore.getState().project.operations[0].target
assert(written.source === 'features' && written.featureIds.join() === 'a', `the × writes the smaller target: ${JSON.stringify(written)}`)

// Render the narrowed operation: its last target's × is refused.
flushSync(() => root.render(createElement(I18nProvider, null, createElement(OperationCuts, { project: useProjectStore.getState().project, operation: { ...operation, target: written } }))))
const lastRemove = host.querySelector('[data-cut-feature-id="a"] .cam-cuts__remove') as HTMLButtonElement
assert(lastRemove.disabled, 'the last target cannot be removed')
assert(lastRemove.getAttribute('title') === 'An operation must cut at least one target', 'and it says why')

// A long list folds into folders, and a folder's chips still wrap: a chip drawn
// straight into the folder's <details> would take a line each, which is the bug
// the change removes (issue #1112 rt6-b, item 40).
const { CUTS_FOLDER_GROUP_THRESHOLD } = await import('./operationCuts')
const folderDrafts = Array.from({ length: CUTS_FOLDER_GROUP_THRESHOLD + 1 }, (_, index) => ({
  id: `h${index}`,
  name: `Hole ${index}`,
  kind: 'rect' as const,
  folderId: 'f-holes',
  sketch: { profile: rectProfile(1, 1, 2, 2), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  operation: 'subtract' as const,
  z_top: 2,
  z_bottom: 0,
  visible: true,
  locked: false,
}))
const folderBase = newProject('cuts folders', 'mm')
// The folder must exist before the instances are normalized, or their folderId
// is dropped as pointing at nothing.
folderBase.featureFolders = [{ id: 'f-holes', name: 'Holes', collapsed: false }]
const folderProject = projectWithFeatures(folderBase, folderDrafts)
const folderOperation = defaultOperationForTarget(folderProject, 'pocket', 'rough', {
  source: 'features',
  featureIds: folderDrafts.map((draft) => draft.id),
}, 0)
folderProject.operations = [folderOperation]
flushSync(() => root.render(createElement(I18nProvider, null, createElement(OperationCuts, { project: folderProject, operation: folderOperation }))))
const folder = host.querySelector('[data-cut-folder-id="f-holes"]')
assert(folder, 'the long list folds its chips into the tree folder')
const folderChips = folder.querySelectorAll('.cam-cuts__group > .cam-cuts__chip')
assert(
  folderChips.length === folderDrafts.length,
  `every folder chip wraps inside the folder's group (saw ${folderChips.length} of ${folderDrafts.length})`,
)
assert(folder.querySelector('summary')?.textContent?.includes('Holes'), 'the folder keeps its own summary')

flushSync(() => root.unmount())
host.remove()
console.log('operation cuts view tests passed')
