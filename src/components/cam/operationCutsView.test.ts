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
 * targets as rows, each with a remove × that is refused on the last one, and a
 * count that follows the target. The rules themselves are `operationCuts.ts`'s;
 * this pins the wiring — a row that draws but cannot remove would leave the
 * "keep an unchecked model out" behaviour unreachable.
 *
 * Mutations checked one at a time:
 *  - `onRemove` dropped from the × → the store target keeps both ids;
 *  - the list rendered from every project feature → the row count is 3;
 *  - the last row's × left enabled → the disabled assertion fails;
 *  - the name dropped from a row → the name assertion fails, and the row's own
 *    remove button is left as its only labelled content (issue #1112 rt3-a,
 *    item 25: the panel drew a × with no name because the field rule stretched
 *    the button over the name's whole column);
 *  - the icon dropped from a row → the icon assertion fails.
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
assert(host.querySelectorAll('[data-cut-feature-id]').length === 2, 'only the operation targets are rows, not every feature')
// A row is the target's icon, its name, and a small remove × — the name first,
// so a row that only draws its × is caught here rather than in a screenshot
// (issue #1112 rt3-a, item 25).
const rowA = host.querySelector('[data-cut-feature-id="a"]')
assert(rowA, 'target "A" has a row')
const nameA = rowA.querySelector('.cam-cuts__name')
assert(nameA?.textContent === 'A', `a row shows the target name (saw ${JSON.stringify(nameA?.textContent)})`)
const iconA = rowA.querySelector('.cam-cuts__icon')
assert(iconA, 'a row shows the target icon')
assert(iconA.getAttribute('data-cut-icon') === 'rect', 'the icon is the shape the target is')
const useA = iconA.querySelector('use')
assert(useA?.getAttribute('href')?.endsWith('#rect'), `the icon references the rect sprite symbol (saw ${useA?.getAttribute('href')})`)
const removeA = rowA.querySelector('.cam-cuts__remove')
assert(removeA, 'the row has a remove control')

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

flushSync(() => root.unmount())
host.remove()
console.log('operation cuts view tests passed')
