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
 * The chuck Properties and its tree-row chip as they render (issue #1112):
 * the capacity warning, the equipment fields, and a legacy chuck keeping its
 * unknown dimensions until the user picks a size. The size *pick* itself is
 * `chuckSizePatch`'s and is tested in `roundWorkholding.test.ts`.
 *
 * Run with: npx tsx src/components/feature-tree/ChuckProperties.test.ts
 */

import * as React from 'react'
import { createElement, type ReactElement } from 'react'
import { parseHTML } from 'linkedom'
import type { Clamp } from '../../types/project'

// A DOM for the client render, in place before React DOM is first imported.
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
// Components are authored with the automatic JSX runtime; the tsx runner
// transpiles this file with the classic one, which expects a global `React`.
;(globalThis as unknown as { React?: typeof React }).React = React

const { ChuckProperties, ChuckRangeWarning } = await import('./ChuckProperties')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { roundStock } = await import('../../types/project')
const { defaultRoundWorkholding } = await import('../../store/helpers/roundWorkholding')

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

const stock = roundStock(20, 100, 'x')
const clamp: Clamp = { id: 'c', name: 'Chuck', visible: true, ...defaultRoundWorkholding('chuck', stock, 'mm') }
const renderProperties = (value: Clamp): Promise<string> => render(createElement(
  I18nProvider,
  null,
  createElement(ChuckProperties, { clamp: value, stock, units: 'mm', onChange: () => {} }),
))

/** Render and keep the host, so a pick can be driven like the user's. */
async function mountProperties(
  value: Clamp,
  onChange: (patch: Partial<Clamp>) => void,
  onChangeStock: typeof stock = stock,
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(createElement(I18nProvider, null,
    createElement(ChuckProperties, { clamp: value, stock: onChangeStock, units: 'mm', onChange }))))
  return {
    host,
    unmount: () => {
      flushSync(() => root.unmount())
      host.remove()
    },
  }
}

/** Press a Select: open its trigger, then choose the option with this label. */
async function pick(host: HTMLElement, testId: string, label: string): Promise<void> {
  const { flushSync } = await import('react-dom')
  const field = host.querySelector(`[data-testid="${testId}"]`)
  assert(field, `${testId} is rendered`)
  const trigger = field.querySelector<HTMLElement>('.ui-select__trigger')
  assert(trigger, `${testId} has a trigger`)
  flushSync(() => trigger.click())
  const option = [...field.querySelectorAll<HTMLElement>('.ui-select__option')]
    .find((entry) => entry.textContent?.trim() === label)
  assert(option, `${testId} offers ${label}`)
  flushSync(() => option.dispatchEvent(new window.Event('pointerdown', { bubbles: true })))
}

// A chuck whose capacity covers the bar shows no warning but still shows the
// equipment fields, so the size is always editable.
{
  const html = await renderProperties(clamp)
  assert(!/role="alert"/.test(html), 'a fitting chuck shows no capacity warning')
  for (const label of ['Chuck size', 'Minimum grip diameter', 'Maximum grip diameter', 'Jaws']) {
    assert(html.includes(label), `the Properties show "${label}"`)
  }
}

// A capacity that excludes the bar warns in the panel, and the compact chip on
// the tree row carries the same reason as its accessible name.
{
  const limited: Clamp = { ...clamp, chuck: { ...clamp.chuck, clampingRangeMm: { min: 1, max: 10 } } }
  const html = await renderProperties(limited)
  assert(/role="alert"/.test(html), 'an out-of-range chuck warns in the Properties')
  assert(html.includes('outside the chuck'), 'and says the bar is outside it')

  const chip = await render(createElement(I18nProvider, null, createElement(ChuckRangeWarning, {
    clamp: limited,
    stock,
    units: 'mm',
    compact: true,
  })))
  assert(/role="img"/.test(chip), 'the tree-row chip is an image, not an action')
  assert(chip.includes('aria-label="Bar is outside'), 'its accessible name is the reason')
}

// A legacy chuck has no equipment data: it keeps its existing size and says
// the capacity is unknown instead of guessing.
{
  const legacy: Clamp = { ...clamp }
  delete legacy.chuck
  const html = await renderProperties(legacy)
  assert(html.includes('Existing size'), 'a legacy chuck keeps its existing size')
  assert(html.includes('Capacity unknown'), 'and its capacity is explicitly unknown')
  assert(legacy.chuck === undefined, 'rendering does not infer equipment onto it')
}

// A hand edit of the equipment is recorded as such (#1112 R2 item 23): the
// size pick marks the chuck manual and keeps the jaw set; the jaw pick marks it
// manual itself. Without the flag a stock change would re-default both.
{
  const patches: Partial<Clamp>[] = []
  const mounted = await mountProperties(clamp, (patch) => patches.push(patch))
  await pick(mounted.host, 'chuck-size', '12"')
  mounted.unmount()
  assert(patches.length === 1, 'a size pick reports one patch')
  assert(patches[0].chuck?.manual === true, 'a picked size is the operator\'s chuck')
  assert(patches[0].chuck?.size === 'bison-3204-12', 'the picked preset')
  assert(patches[0].chuck?.jawCount === 3, 'and it keeps the jaws the chuck already had')
}

{
  const patches: Partial<Clamp>[] = []
  const mounted = await mountProperties(clamp, (patch) => patches.push(patch))
  await pick(mounted.host, 'chuck-jaws', '6')
  mounted.unmount()
  assert(patches.length === 1, 'a jaw pick reports one patch')
  assert(patches[0].chuck?.jawCount === 6, 'the chosen jaw count')
  assert(patches[0].chuck?.manual === true, 'and it is a hand edit too')
}

console.log('chuck properties view tests passed')
