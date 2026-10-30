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
 * The theme manager's inline rename only offers Save when the trimmed name
 * differs from the saved one (issue #1112 F4).
 *
 * Frank: a Save button that writes nothing when there are no changes should be
 * greyed out rather than left clickable. This drives the real manager (with the
 * theme provider's value supplied directly, as the theme editor's own test
 * does): opening Rename leaves Save disabled, a real edit enables it, typing
 * the saved name back (exactly, padded with spaces, or leaving it blank)
 * disables it again, and only an enabled Save writes the trimmed name. Enter
 * takes the same gate.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/theme/themeManagerRename.test.ts
 */

import React from 'react'
import { parseHTML } from 'linkedom'

const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
if (typeof globals.navigator === 'undefined') {
  globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
}
// React decides once, when it first imports, whether an `input` event can drive
// `onChange` (`'oninput' in document`). linkedom's document has no `oninput`, so
// without this every controlled field would fall back to the legacy change path
// and take no edits at all — a silently inert test.
if (!('oninput' in (document as unknown as object))) {
  Object.defineProperty(document, 'oninput', { value: null, writable: true, configurable: true })
}
globals.React = React

const { createRoot } = await import('react-dom/client')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { ThemeContext } = await import('../../theme/themeContext')
type ThemeContextValue = import('../../theme/themeContext').ThemeContextValue
const { ThemeManagerDialog } = await import('./ThemeManagerDialog')
const registry = await import('../../theme/registry')
type CustomThemeData = import('../../theme/registry').CustomThemeData

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

const dom = window as unknown as {
  Event: new (type: string, init?: { bubbles?: boolean }) => object
  HTMLInputElement: { prototype: { value: string } }
}

const SAVED_NAME = 'My workshop'

/** A saved custom dark theme: the built-in with no overrides. */
const savedTheme: CustomThemeData = {
  schemaVersion: registry.CUSTOM_THEME_SCHEMA_VERSION,
  id: 'custom-dark',
  name: SAVED_NAME,
  family: 'dark',
  baseThemeId: 'dark',
  overrides: {},
}

/** Every theme the manager was asked to save, in order. */
const saves: CustomThemeData[] = []

// Only the parts of the provider this dialog reads are needed; storage and the
// media query would be noise, and the rename gate never touches them.
const themeValue = {
  selection: {
    mode: 'fixed',
    fixedThemeId: savedTheme.id,
    systemLightThemeId: 'light',
    systemDarkThemeId: 'dark',
  },
  setSelection: () => undefined,
  customThemes: [savedTheme],
  activeTheme: registry.resolveCustomTheme(savedTheme),
  activateTheme: () => undefined,
  saveCustomTheme: (theme: CustomThemeData) => { saves.push(theme) },
  deleteCustomTheme: () => undefined,
  systemPrefersDark: false,
} as unknown as ThemeContextValue

interface Mounted {
  unmount: () => void
}

async function mountManager(): Promise<Mounted> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null,
    React.createElement(ThemeContext.Provider, { value: themeValue },
      React.createElement(ThemeManagerDialog, { onClose: () => undefined }),
    ),
  ))
  await flush()
  return {
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => (candidate.textContent ?? '').trim() === text)
  assert(button, `the manager has a ${text} button`)
  return button as unknown as HTMLButtonElement
}

function saveNameButton(): HTMLButtonElement {
  return buttonWithText('Save name')
}

function renameInput(): HTMLInputElement {
  const input = document.body.querySelector('.theme-manager-rename__input')
  assert(input, 'the inline rename has a name field')
  return input as unknown as HTMLInputElement
}

/** Open the inline rename for the active custom theme. */
async function openRename(): Promise<HTMLInputElement> {
  buttonWithText('Rename').click()
  await flush()
  return renameInput()
}

/** Set a field the way typing does: value first, then the event React listens for. */
function typeInto(field: HTMLInputElement, value: string): void {
  if (!field.getAttribute('type')) field.setAttribute('type', 'text')
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set
  assert(setter, 'linkedom has an input value setter')
  setter.call(field, value)
  field.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
}

/** A key press as the browser reports it: handlers switch on `event.key`. */
function pressKey(target: EventTarget, key: string): void {
  const event = new dom.Event('keydown', { bubbles: true }) as unknown as { key?: string }
  Object.defineProperty(event, 'key', { value: key, configurable: true })
  target.dispatchEvent(event as unknown as Event)
}

// ── Unchanged → disabled ────────────────────────────────────────────

{
  const manager = await mountManager()
  await openRename()
  assert(saveNameButton().disabled, 'an unchanged inline rename has Save disabled')
  saveNameButton().click()
  await flush()
  assert(saves.length === 0, 'clicking a disabled Save writes nothing')

  // A whitespace-only draft is not a new name either.
  typeInto(renameInput(), '   ')
  await flush()
  assert(saveNameButton().disabled, 'a blank name keeps Save disabled')
  manager.unmount()
}

// ── Edit enables it, reverting disables it ─────────────────────────

{
  const manager = await mountManager()
  const input = await openRename()

  typeInto(input, 'Workshop Amber')
  await flush()
  assert(!saveNameButton().disabled, 'a changed name enables Save')

  typeInto(input, SAVED_NAME)
  await flush()
  assert(saveNameButton().disabled, 'typing the saved name back disables Save again')

  // The saved name is stored trimmed, so padding it is not an edit.
  typeInto(input, `  ${SAVED_NAME}  `)
  await flush()
  assert(saveNameButton().disabled, 'the saved name, padded, disables Save again')

  // And a real edit after a revert is a change once more.
  typeInto(input, 'Workshop Amber')
  await flush()
  assert(!saveNameButton().disabled, 'a real edit after a revert enables Save again')
  manager.unmount()
}

// ── Enter takes the same gate ───────────────────────────────────────

{
  const manager = await mountManager()
  const input = await openRename()
  pressKey(input, 'Enter')
  await flush()
  assert(saves.length === 0, 'Enter with the saved name writes nothing')
  manager.unmount()
}

// ── An enabled Save writes the trimmed name ─────────────────────────

{
  const manager = await mountManager()
  const input = await openRename()
  typeInto(input, '  Workshop Amber  ')
  await flush()
  assert(!saveNameButton().disabled, 'a changed name enables Save')
  saveNameButton().click()
  await flush()
  // Copy the log first: the earlier "writes nothing" check narrows `saves.length`.
  const written = saves.slice()
  assert(written.length === 1, 'an enabled Save writes once')
  assert(written[0]?.name === 'Workshop Amber', 'Save writes the trimmed name')
  manager.unmount()
}

console.log('theme manager rename Save gate tests passed')
