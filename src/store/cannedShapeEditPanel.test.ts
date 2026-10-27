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
 * The Edit <shape>… panel mounts and reopens with the current values
 * (issue #1112 slice D).
 *
 * Run with: npx tsx src/store/cannedShapeEditPanel.test.ts
 *
 * Renders the real dialog the canvas registers, through the registry the
 * Properties panel uses, in a DOM. Linking the dialog back to the registry is
 * the part a plain unit test cannot see: if the canvas module did not register
 * an opener, the Properties button would stay disabled. The field-level logic
 * (values in, validated parameters out) is pure and covered in
 * `src/cannedShapes/generators/shapes.test.ts`; the undo step and the edit
 * itself are covered in `src/store/cannedShapeCreation.test.ts`.
 */

import React from 'react'
import { parseHTML } from 'linkedom'
import type { CannedShapeData } from '../types/project'

// A DOM for the client render, in place before React DOM is first imported.
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
// Components use the automatic JSX runtime; the tsx runner transpiles this file
// with the classic one, which expects a global `React`.
globals.React = React

const { useProjectStore } = await import('./projectStore')
const { instantiateProjectTemplate } = await import('./helpers/normalize')
const { getCannedShapeEditor } = await import('../cannedShapes')
// Importing the canvas module registers the five editors, exactly as the app's
// startup import graph does through SketchCanvas.
await import('../components/canvas/CreationParameterReferences')

let passCount = 0
let failCount = 0
const failures: string[] = []

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function seed(kind: string, params: Record<string, number>): string {
  const project = instantiateProjectTemplate()
  const canned: CannedShapeData = { kind, params }
  const feature = {
    id: 'f-edit',
    name: 'Shape',
    kind: 'composite' as const,
    sketch: {
      profile: { start: { x: 0, y: 0 }, segments: [], closed: true },
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'add' as const,
    z_top: 5,
    z_bottom: 0,
    authoringFace: 'top' as const,
    visible: true,
    locked: false,
    folderId: null,
    canned,
  }
  const definition = {
    id: 'def-edit',
    kind: 'composite' as const,
    profile: feature.sketch.profile,
    dimensions: [],
    text: null,
    canned,
    stl: null,
    operation: 'add' as const,
  }
  useProjectStore.setState({
    project: {
      ...project,
      featureDefinitions: { 'def-edit': definition },
      features: [{
        ...feature,
        definitionId: 'def-edit',
        transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        constraints: [],
      }],
      featureTree: [{ type: 'feature', featureId: 'f-edit' }],
    },
    history: { past: [], future: [], transactionStart: null },
  } as never)
  return 'f-edit'
}

function fieldInputs(): HTMLInputElement[] {
  return Array.from(document.body.querySelectorAll('input')) as unknown as HTMLInputElement[]
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passCount += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failCount += 1
    failures.push(`${name}: ${(error as Error).message}`)
    console.error(`✗ ${name}`)
    console.error(`  ${(error as Error).message}`)
  }
}

await scenario('the canvas registers an opener for every flat canned shape', async () => {
  for (const kind of ['ellipse', 'slot', 'ngon', 'roundrect', 'chamferrect']) {
    assert(getCannedShapeEditor(kind) !== null, `${kind} has an editor`)
  }
  assert(getCannedShapeEditor('not-a-shape') === null, 'an unknown kind has none')
})

await scenario('the dialog opens with the current parameter values', async () => {
  const featureId = seed('ngon', { sides: 6, size: 20, rotation: 15 })
  getCannedShapeEditor('ngon')!(featureId)
  await flush()
  let inputs = fieldInputs()
  assert(inputs.length === 3, `expected three fields, got ${inputs.length}`)
  assert(inputs[0].value === '6', `sides field shows 6, got ${inputs[0].value}`)
  assert(inputs[1].value === '20', `size field shows 20, got ${inputs[1].value}`)
  assert(inputs[2].value === '15', `rotation field shows 15, got ${inputs[2].value}`)

  // Opening another shape replaces the panel rather than stacking two, and
  // shows that shape's values (the per-dialog close callback).
  const ellipseId = seed('ellipse', { rx: 30, ry: 20 })
  getCannedShapeEditor('ellipse')!(ellipseId)
  await flush()
  assert(document.querySelectorAll('.canned-shape-edit-host').length === 1, 'one dialog is open')
  inputs = fieldInputs()
  assert(inputs.length === 2, `expected two ellipse fields, got ${inputs.length}`)
  assert(inputs[0].value === '30' && inputs[1].value === '20', 'the ellipse shows its own radii')
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) {
  console.error('\n' + failures.join('\n'))
  process.exitCode = 1
}
