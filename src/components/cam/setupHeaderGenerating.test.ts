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
 * The setup card header shows the generating badge (issue #1143), so a
 * collapsed card still says its operations are being worked on.
 *
 * Mutations checked: dropping the `generating` prop at the CAMPanel call site
 * → the spinner assertion fails; ignoring `generationPaused` → the paused
 * assertion fails.
 *
 * Run with: npx tsx src/components/cam/setupHeaderGenerating.test.ts
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
  matches: false, media: '', onchange: null,
  addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
  dispatchEvent: () => false,
})
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
;(globalThis as unknown as { React?: typeof React }).React = React

const { CAMPanel } = await import('./CAMPanel')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { useProjectStore } = await import('../../store/projectStore')
const { rotaryOperationFixture } = await import('../../test/rotaryOperationFixture')
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const PROJECT = rotaryOperationFixture('x', 'rotary_rough')
const OPERATION = PROJECT.operations[0]
const SETUP = PROJECT.setups.find((setup) => setup.id === OPERATION.setupId)!

function headerOf(generating: Set<string>, paused: boolean): Element {
  useProjectStore.setState({ project: PROJECT })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(createElement(I18nProvider, null, createElement(CAMPanel, {
    mode: 'operations',
    selectedOperationId: null,
    onSelectedOperationIdChange: () => {},
    onExport: () => {},
    onExportOperation: () => {},
    requestToolpath: async () => null,
    documentKey: 0,
    generatingOperationIds: generating,
    generationPaused: paused,
  }))))
  const header = host.querySelector(`[data-setup-face="${SETUP.kind}"] .cam-setup-group__header`)
  assert(header, `the ${SETUP.kind} setup card rendered a header`)
  const clone = header.cloneNode(true) as Element
  flushSync(() => root.unmount())
  host.remove()
  return clone
}

{
  const header = headerOf(new Set([OPERATION.id]), false)
  assert(header.querySelector('.cam-generating-spinner'), 'a generating operation puts the spinner in its setup header')
}
{
  const header = headerOf(new Set([OPERATION.id]), true)
  assert(!header.querySelector('.cam-generating-spinner'), 'paused generation does not spin')
  assert(header.querySelector('.cam-operation-badge--paused'), 'paused generation shows the paused badge')
}
{
  const header = headerOf(new Set(), false)
  assert(!header.querySelector('.cam-setup-group__generating'), 'an idle setup header has no badge')
}

console.log('setupHeaderGenerating: ok')
