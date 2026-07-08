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
 * Tests for OperationParameterReference: the pure kind/label data plus a
 * render check that every exported kind actually produces an SVG diagram.
 *
 * Run with: npx tsx src/components/cam/OperationParameterReference.test.ts
 */

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperationParameterReference } from './OperationParameterReference'
import { OPERATION_PARAM_REF_KINDS, operationParamRefLabel } from './operationParamRefData'
import type { OperationParamRefKind } from './operationParamRefData'

// The component is authored with the automatic JSX runtime (like the app), but
// the standalone test runner (tsx) transpiles this file with the classic
// runtime, which expects a global `React`. Provide it so renderToStaticMarkup
// can invoke the component. Harmless if a runner ever uses the automatic runtime.
const globalWithReact = globalThis as typeof globalThis & { React?: typeof React }
globalWithReact.React = React

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function testNoDuplicateKinds(): void {
  const seen = new Set<string>()
  for (const kind of OPERATION_PARAM_REF_KINDS) {
    assert(!seen.has(kind), `duplicate kind: ${kind}`)
    seen.add(kind)
  }
}

function testAllKindsHaveNonEmptyLabel(): void {
  for (const kind of OPERATION_PARAM_REF_KINDS) {
    const label = operationParamRefLabel(kind)
    assert(typeof label === 'string' && label.length > 0, `empty label for kind: ${kind}`)
  }
}

function testAllLabelsAreUnique(): void {
  const labels = new Set<string>()
  for (const kind of OPERATION_PARAM_REF_KINDS) {
    const label = operationParamRefLabel(kind)
    assert(!labels.has(label), `duplicate label for kind ${kind}: ${label}`)
    labels.add(label)
  }
}

function renderKind(kind: OperationParamRefKind, variant?: string): string {
  return renderToStaticMarkup(React.createElement(OperationParameterReference, { kind, variant }))
}

// Every exported kind must render an accessible SVG diagram. This is what
// catches a kind that is listed but has no `case` in the component switch.
function testEveryKindRendersSvg(): void {
  assert(OPERATION_PARAM_REF_KINDS.length > 0, 'kind list is empty')
  for (const kind of OPERATION_PARAM_REF_KINDS) {
    const html = renderKind(kind)
    assert(html.includes('<svg'), `kind ${kind} did not render an <svg>`)
    assert(html.includes('class="op-param-ref"'), `kind ${kind} missing the op-param-ref frame`)
    assert(html.includes(`aria-label="${operationParamRefLabel(kind)}"`), `kind ${kind} aria-label mismatch`)
    assert(
      html.includes('<path') || html.includes('<circle') || html.includes('<rect'),
      `kind ${kind} rendered no geometry`,
    )
  }
}

// Dropdown-backed kinds must render for every real option value (each branch of
// the value-aware switch produces geometry).
function testVariantKindsRenderEveryOption(): void {
  const cases: Array<[OperationParamRefKind, readonly string[]]> = [
    ['pattern', ['offset', 'parallel', 'waterline']],
    ['cutDirection', ['conventional', 'climb']],
    ['machiningOrder', ['level_first', 'feature_first']],
    ['drillType', ['simple', 'peck', 'dwell', 'chip_breaking']],
  ]
  for (const [kind, variants] of cases) {
    for (const variant of variants) {
      const html = renderKind(kind, variant)
      assert(html.includes('<svg'), `kind ${kind} variant ${variant} did not render an <svg>`)
      assert(
        html.includes('gear-reference__accent'),
        `kind ${kind} variant ${variant} rendered no accent geometry`,
      )
    }
  }
}

testNoDuplicateKinds()
testAllKindsHaveNonEmptyLabel()
testAllLabelsAreUnique()
testEveryKindRendersSvg()
testVariantKindsRenderEveryOption()

console.log('OperationParameterReference tests passed')
