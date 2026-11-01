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
 * The simulation toolbar's fresh-stock info button (issue #1112 F3).
 *
 * It stands in for the full-width note line (issue #947): the same sentence,
 * carried as the button's tooltip and accessible name, opened by a tap so it
 * is readable on touch too — and rendered only when the project has another
 * setup to explain.
 *
 * Mutations checked one at a time against these assertions:
 * - rendering the button for a null note (a single-setup project) → "a
 *   single-setup project renders no info button" fails;
 * - dropping `aria-label` or `title` → the tooltip and accessible-name
 *   assertions fail;
 * - always rendering the sentence instead of toggling it → "the sentence is
 *   not in the way until it is asked for" fails;
 * - changing the sentence in the popover (a shortened copy) → the text
 *   assertion fails.
 *
 * Run with: NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/simulation/SimulationSetupInfo.test.ts
 */

import * as React from 'react'
import { createElement } from 'react'
import { parseHTML } from 'linkedom'
import { SimulationSetupInfo } from './SimulationSetupInfo'

// A DOM for the client render, in place before React DOM is first imported.
const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
if (typeof globals.navigator === 'undefined') globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
// Components are authored with the automatic JSX runtime; the tsx runner
// transpiles this file with the classic one, which expects a global `React`.
;(globalThis as unknown as { React?: typeof React }).React = React

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const NOTE = 'Bottom is simulated on fresh stock: material removed by other setups is not shown.'

interface Mounted {
  host: HTMLElement
  /** Click inside `flushSync`, so the state update is on screen when it returns. */
  click: (element: Element) => void
  unmount: () => void
}

/** Render the control with `note`, then hand it back with its host. */
async function mount(note: string | null): Promise<Mounted> {
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(createElement(SimulationSetupInfo, { note })))
  return {
    host: host as unknown as HTMLElement,
    click: (element) => flushSync(() => (element as HTMLElement).click()),
    unmount: () => { flushSync(() => root.unmount()); host.remove() },
  }
}

// ── One setup: nothing to explain ─────────────────────────────
{
  const { host, unmount } = await mount(null)
  assert(host.querySelector('.simulation-setup-info__button') === null, 'a single-setup project renders no info button')
  assert(host.textContent?.trim() === '' || host.textContent === null, 'and no sentence either')
  unmount()
}

// ── More than one setup: the sentence behind one info button ──
{
  const { host, click, unmount } = await mount(NOTE)
  const button = host.querySelector<HTMLButtonElement>('.simulation-setup-info__button')
  assert(button, 'two setups render the info button at the end of the toolbar')
  assert(button.getAttribute('title') === NOTE, 'the sentence is the button\'s tooltip')
  assert(button.getAttribute('aria-label') === NOTE, 'and its accessible name')
  assert(button.getAttribute('aria-expanded') === 'false', 'it starts closed')
  assert(host.querySelector('.simulation-setup-info__text') === null, 'the sentence is not in the way until it is asked for')

  // A tap opens it: the touch shell has no hover.
  click(button)
  const text = host.querySelector('.simulation-setup-info__text')
  assert(text, 'a tap opens the sentence')
  assert(text.textContent === NOTE, 'with exactly the tooltip\'s wording')
  assert(text.getAttribute('role') === 'note', 'announced as a note')
  assert(button.getAttribute('aria-expanded') === 'true', 'and the button reports it is open')

  // A second tap closes it again.
  click(button)
  assert(host.querySelector('.simulation-setup-info__text') === null, 'a second tap closes it')
  assert(button.getAttribute('aria-expanded') === 'false', 'and the button reports it is closed')
  unmount()
}

console.log('simulation setup info tests passed')
