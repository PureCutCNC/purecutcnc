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

/// <reference types="node" />

/**
 * Structural tests for the A1.4 "region as filter" UI treatment.
 *
 * These tests verify at the source level that:
 *   1. The CSS classes for the badge / note elements are defined in the stylesheet.
 *   2. FeatureTree renders the "mask" badge only when operation is 'region'.
 *   3. CAMPanel renders the region-filter note when operationTargetsRegion is true,
 *      and the copy matches the agreed wording.
 *   4. PropertiesPanel shows the Z-lock and region note for region features.
 *
 * This approach (reading source files in the test) catches class-name typos,
 * removed conditionals, and copy drift without requiring a DOM renderer.
 *
 * Run with: npx tsx src/components/feature-tree/regionPresentation.test.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// src/components/feature-tree/ → repo root is three levels up
const root = resolve(here, '../../..')

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), 'utf8')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const css = readSrc('src/styles/layout.css')
const featureTree = readSrc('src/components/feature-tree/FeatureTree.tsx')
const camPanel = readSrc('src/components/cam/CAMPanel.tsx')
const propertiesPanel = readSrc('src/components/feature-tree/PropertiesPanel.tsx')

// ── CSS class definitions ────────────────────────────────────────

assert(css.includes('.tree-region-badge'), 'layout.css must define .tree-region-badge')
assert(css.includes('.cam-region-note'), 'layout.css must define .cam-region-note')
assert(css.includes('.cam-region-note__badge'), 'layout.css must define .cam-region-note__badge')
assert(css.includes('.properties-region-note'), 'layout.css must define .properties-region-note')
assert(css.includes('.properties-region-note__badge'), 'layout.css must define .properties-region-note__badge')

// ── FeatureTree: mask badge on region rows ───────────────────────

// Badge must be gated on operation === 'region' so non-region rows are unaffected.
assert(
  featureTree.includes("operation === 'region'") && featureTree.includes('tree-region-badge'),
  'FeatureTree must render .tree-region-badge only when operation is "region"',
)
// Badge text is "mask" per REGION_FEATURE_SEMANTICS.md agreed copy.
// The text is a JSX child node: >\n  mask\n< — match with a relaxed regex.
assert(
  /tree-region-badge[\s\S]{0,400}>\s*mask\s*</.test(featureTree),
  'FeatureTree .tree-region-badge must display the text "mask"',
)

// ── CAMPanel: region-filter note when operation targets a region ─

// The note must be conditioned on the operationTargetsRegion helper so the
// display logic and the gating function are guaranteed to be the same function
// that is tested in operationValidity.test.ts.
assert(
  camPanel.includes('operationTargetsRegion') && camPanel.includes('cam-region-note'),
  'CAMPanel must render .cam-region-note when operationTargetsRegion is true',
)
// The badge inside the note must also read "mask".
assert(
  camPanel.includes('cam-region-note__badge') && camPanel.includes('>mask<'),
  'CAMPanel .cam-region-note must contain a .cam-region-note__badge with text "mask"',
)
// Agreed explanation copy — changing this text must fail the test so the copy
// stays consistent across PropertiesPanel, CAMPanel, and tooltips.
assert(
  camPanel.includes('Regions limit where this operation may cut'),
  'CAMPanel region note must include the agreed filter explanation',
)

// ── PropertiesPanel: Z-lock and region note for region features ──

// Z Range field must be shown and locked for region features.
assert(
  propertiesPanel.includes("operation === 'region'") && propertiesPanel.includes('Follows stock'),
  'PropertiesPanel must show the Z Range locked field for region features',
)
// Region note must appear with the agreed badge and copy.
assert(
  propertiesPanel.includes('properties-region-note') && propertiesPanel.includes('>mask<'),
  'PropertiesPanel must render .properties-region-note with "mask" badge for region features',
)
assert(
  propertiesPanel.includes('A region is a filter'),
  'PropertiesPanel region note must include the agreed filter explanation',
)

console.log('regionPresentation.test.ts passed')
