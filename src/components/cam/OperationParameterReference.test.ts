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
    ['pattern', ['offset', 'parallel', 'waterline', 'seeded_offset']],
    ['cutDirection', ['conventional', 'climb']],
    ['edgeStrategy', ['contour', 'trochoidal']],
    ['machiningOrder', ['level_first', 'feature_first']],
    ['entryStrategy', ['plunge', 'helix', 'ramp']],
    ['drillType', ['simple', 'peck', 'dwell', 'chip_breaking', 'helical', 'countersink']],
    ['engagementMode', ['slots_only', 'engagement']],
    // #1112 decision 7: the rotary Passes field shows the two directions, and
    // the radial stock uses a rotary cross-section instead of the pocket wall.
    ['passes', ['along', 'around']],
    ['stockRadial', ['rotary', 'around']],
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

// The cut-direction arrow runs along the outside of the part's top edge. With a
// clockwise (M3) spindle, climb travels clockwise around the part — rightward
// on that edge — and conventional leftward (#899).
function arrowPointsRight(html: string): boolean {
  const head = /class="gear-reference__accent-fill" d="M[\d.]+ [\d.]+l(-?[\d.]+)/.exec(html)
  assert(head, 'cutDirection rendered no arrowhead')
  // The head path starts at the tip; its base lies behind it, so a base to the
  // left of the tip (negative dx) means the arrow points right.
  return Number(head[1]) < 0
}

function testCutDirectionArrowOrientation(): void {
  assert(arrowPointsRight(renderKind('cutDirection', 'climb')), 'climb arrow must point right')
  assert(!arrowPointsRight(renderKind('cutDirection', 'conventional')), 'conventional arrow must point left')
}

// The `data-arrow` marker names each rotary picture's signature arrow. Reading
// the marked path's geometry (not just its presence) is what makes a swap of
// the two pictures fail: the along arrow must be a straight run down the bar,
// the around arrow an arc, and neither picture may carry the other's marker.
function markedArrow(html: string, marker: string): string {
  const path = html.split('<path ').find((part) => part.includes(`data-arrow="${marker}"`))
  assert(path, `no data-arrow="${marker}" arrow in the picture`)
  const d = /\bd="([^"]+)"/.exec(path)
  assert(d, `data-arrow="${marker}" arrow has no path data`)
  return d[1]
}

function testRotaryPicturesDiffer(): void {
  const along = renderKind('passes', 'along')
  const around = renderKind('passes', 'around')
  assert(along !== around, 'passes along and around must not render the same picture')
  assert(
    along.includes(`aria-label="${operationParamRefLabel('passes')}"`)
      && around.includes(`aria-label="${operationParamRefLabel('passes')}"`),
    'both passes variants keep the same accessible label',
  )

  // Along the bar is one straight horizontal pass at the bar's centre line;
  // around the bar is the same motion drawn as an arc, so swapping the two
  // pictures (or their marked paths) fails here instead of merely differing.
  const alongArrow = markedArrow(along, 'along-bar')
  assert(
    /^M[\d.]+ 17h\d+$/.test(alongArrow),
    `the along picture needs the longitudinal arrow along the bar, got "${alongArrow}"`,
  )
  const aroundArrow = markedArrow(around, 'around-bar')
  assert(
    /[cCsS]/.test(aroundArrow),
    `the around picture needs the rotational (curved) arrow, got "${aroundArrow}"`,
  )
  assert(!along.includes('data-arrow="around-bar"'), 'the along picture must not contain the around arrow')
  assert(!around.includes('data-arrow="along-bar"'), 'the around picture must not contain the along arrow')

  const wall = renderKind('stockRadial')
  const rotary = renderKind('stockRadial', 'rotary')
  const aroundPocket = renderKind('stockRadial', 'around')
  assert(wall !== rotary, 'rotary stock-to-leave must not reuse the pocket-wall picture')
  // The pocket-wall diagram is the rectangle in the default branch; the rotary
  // one is the bar cross-section circle. Naming both makes the swap explicit.
  assert(wall.includes('M8 7h42v20H8z'), 'the default stockRadial picture stays the pocket wall')
  assert(rotary.includes('m-12 0a12 11'), 'the rotary stockRadial picture is a radial cross-section')
  // #1112 decision 8.16: the rotary picture says the walls are radial, and an
  // Around pocket keeps the pocket picture but carries the same note. A Top or
  // Bottom pocket gets neither.
  assert(rotary.includes('op-param-ref-note'), 'the rotary stockRadial picture carries its limit note')
  assert(rotary.includes('Walls are radial'), 'the rotary note reads "Walls are radial"')
  assert(wall.includes('M8 7h42v20H8z') && !wall.includes('op-param-ref-note'), 'the pocket-wall picture does not carry the rotary note')
  assert(aroundPocket.includes('M8 7h42v20H8z'), 'an Around pocket keeps the pocket-wall picture')
  assert(aroundPocket.includes('op-param-ref-note'), 'an Around pocket carries its radial-wall note')
  assert(aroundPocket.includes('Walls are radial'), 'the Around note reads "Walls are radial"')
}

testNoDuplicateKinds()
testAllKindsHaveNonEmptyLabel()
testAllLabelsAreUnique()
testEveryKindRendersSvg()
testVariantKindsRenderEveryOption()
testCutDirectionArrowOrientation()
testRotaryPicturesDiffer()

console.log('OperationParameterReference tests passed')
