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
 * The face menu is portalled to `document.body`, so it leaves the
 * `[data-shell-mode]` subtree `.app-shell` carries. The portal root has to
 * carry the shell mode itself, or the tablet `44px` entry rule in face.css
 * never matches and the menu keeps the 34px desktop rows (issue #1112).
 *
 * Mutations checked one at a time against these assertions:
 * - dropping `data-shell-mode` from the portal root → the tablet assertion
 *   fails, because the menu is no longer inside an attributed ancestor;
 * - hardcoding the shell mode → the desktop assertion fails;
 * - putting the attribute on the trigger's host only → the menu root assertion
 *   fails on tablet.
 *
 * Run with: npx tsx src/components/layout/faceSwitchPortalShellMode.test.ts
 */

import * as React from 'react'
import { createElement } from 'react'
import { parseHTML } from 'linkedom'
import { FaceSwitch } from './FaceSwitch'
import { I18nProvider } from '../../i18n/I18nProvider'
import { useProjectStore } from '../../store/projectStore'
import { defaultSetupForFace } from '../../store/helpers/provisionalSetup'
import { newProject, roundStock } from '../../types/project'
import type { Project } from '../../types/project'

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

/** A rotary project on a bar: the switch lists Top, Bottom and Around. */
function bothFacesProject(): Project {
  const base = newProject()
  const stock = roundStock(12, 30, 'x')
  const meta = { ...base.meta, projectType: 'rotary' as const }
  const around = defaultSetupForFace('around', { stock, meta })
  return { ...base, meta, stock, setups: [...base.setups, around], activeSetupId: around.id }
}

interface ShellModeViewport {
  coarse: boolean
  width: number
}

/**
 * Render the switch in the given shell, open its menu, and return the portal
 * root and the entries it contains.
 */
async function openMenu({ coarse, width }: ShellModeViewport): Promise<{ menu: Element | null; entries: Element[] }> {
  ;(window as unknown as { matchMedia: (query: string) => unknown }).matchMedia = () => ({
    matches: coarse,
    media: '',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })

  useProjectStore.setState({ project: bothFacesProject() })
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(createElement(I18nProvider, null, createElement(FaceSwitch))))
  const trigger = host.querySelector<HTMLButtonElement>('.face-switch__trigger')
  assert(trigger, 'the face switch renders a trigger')
  flushSync(() => trigger.click())

  const menu = document.querySelector('.face-switch__menu')
  const entries = Array.from(document.querySelectorAll('.face-switch__menu-item'))
  flushSync(() => root.unmount())
  host.remove()
  menu?.remove()
  return { menu, entries }
}

// A tablet shell puts the shell mode on the portal root, so the tablet entry
// rules in face.css still find the menu outside `.app-shell`.
{
  const { menu, entries } = await openMenu({ coarse: true, width: 1024 })
  assert(menu, 'the menu is portalled to the body')
  assert(menu.getAttribute('data-shell-mode') === 'tablet', 'the tablet menu root carries the tablet shell mode')
  assert(entries.length > 0, 'the menu lists the faces')
  assert(entries.every((entry) => menu.contains(entry)), 'every entry is inside the attributed portal root')
}

// A desktop shell is not dressed up as a tablet menu.
{
  const { menu } = await openMenu({ coarse: false, width: 1200 })
  assert(menu, 'the menu is portalled to the body on desktop too')
  assert(menu.getAttribute('data-shell-mode') === 'desktop-compact', 'the desktop menu root keeps the desktop shell mode')
}

console.log('face switch portal shell mode tests passed')
