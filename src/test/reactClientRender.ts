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
 * A real React client render inside a `linkedom` document, for tests that need
 * effects to run (the same DOM the SVG importer and feature-tree suites use).
 *
 * `renderToStaticMarkup` never runs effects, so it cannot observe anything a
 * hook computes in one — an async worker job least of all. These helpers mount
 * through `react-dom/client` inside `act`, which flushes effects and the state
 * updates they schedule.
 *
 * The DOM globals are installed by the first mount, not at module load, so a
 * test's engine and worker imports are evaluated against a plain Node realm
 * exactly as they are in production.
 */

import * as React from 'react'
import { act, createElement, type ReactElement } from 'react'
import { parseHTML } from 'linkedom'

let installed = false

function installDom(): void {
  if (installed) return
  installed = true
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = window
  globals.document = document
  globals.HTMLElement = window.HTMLElement
  globals.Element = window.Element
  globals.Node = window.Node
  // Node 20 (CI) has no global `navigator`; the client renderer reads it.
  if (typeof globals.navigator === 'undefined') {
    globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
  }
  // Components are authored with the automatic JSX runtime; the tsx runner
  // transpiles these files with the classic one, which expects a global React.
  globals.React = React
  globals.IS_REACT_ACT_ENVIRONMENT = true
}

export interface MountedElement {
  /** Render different props into the same root, flushing effects. */
  rerender(element: ReactElement): Promise<void>
  unmount(): Promise<void>
}

/** Mount `element` as the browser would, flushing effects and microtasks. */
export async function mountReact(element: ReactElement): Promise<MountedElement> {
  installDom()
  const { createRoot } = await import('react-dom/client')
  const host = (globalThis as unknown as { document: Document }).document.createElement('div')
  ;(globalThis as unknown as { document: Document }).document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(React.Fragment, null, element))
  })
  return {
    async rerender(next: ReactElement): Promise<void> {
      await act(async () => {
        root.render(createElement(React.Fragment, null, next))
      })
    },
    async unmount(): Promise<void> {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

/** Flush pending effects and microtasks inside an act scope. */
export async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}
