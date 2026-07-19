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
 *   2. FeatureTree renders one include/exclude badge only when operation is 'region'.
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
const depthLegend = readSrc('src/components/canvas/DepthLegend.tsx')
const camEnCatalog = readSrc('src/i18n/locales/en/cam.ts')

// ── CSS class definitions ────────────────────────────────────────

assert(css.includes('.tree-region-badge'), 'layout.css must define .tree-region-badge')
assert(css.includes('.tree-region-badge--exclude'), 'layout.css must define .tree-region-badge--exclude')
assert(css.includes('.cam-region-note'), 'layout.css must define .cam-region-note')
assert(css.includes('.cam-region-note__badge'), 'layout.css must define .cam-region-note__badge')
assert(css.includes('.properties-region-note'), 'layout.css must define .properties-region-note')
assert(css.includes('.properties-region-note__badge'), 'layout.css must define .properties-region-note__badge')
assert(css.includes('.sketch-depth-legend__swatch--region-exclude'), 'layout.css must define the region exclude legend swatch')

// ── FeatureTree: include/exclude badge on region rows ────────────

// Badge must be gated on operation === 'region' so non-region rows are unaffected.
assert(
  featureTree.includes("operation === 'region'") && featureTree.includes('tree-region-badge'),
  'FeatureTree must render .tree-region-badge only when operation is "region"',
)
assert(
  featureTree.includes("t('featureTree.treeRow.badge.region.exclude')") &&
  featureTree.includes("t('featureTree.treeRow.badge.region.include')"),
  'FeatureTree .tree-region-badge must reference the i18n include/exclude keys',
)
const featureTreeEnCatalogReg = readSrc('src/i18n/locales/en/featureTree.ts')
assert(
  featureTreeEnCatalogReg.includes("'featureTree.treeRow.badge.region.include': 'include'"),
  'featureTree en catalog must carry the original region include label "include"',
)
assert(
  featureTreeEnCatalogReg.includes("'featureTree.treeRow.badge.region.exclude': 'exclude'"),
  'featureTree en catalog must carry the original region exclude label "exclude"',
)
assert(
  featureTree.includes("regionMaskMode === 'exclude'") && featureTree.includes('tree-region-badge--exclude'),
  'FeatureTree must display an "exclude" badge for exclude region masks',
)

// ── CAMPanel: region-filter note when operation targets a region ─

// The note must be conditioned on the operationTargetsRegion helper so the
// display logic and the gating function are guaranteed to be the same function
// that is tested in operationValidity.test.ts.
assert(
  camPanel.includes('operationTargetsRegion') && camPanel.includes('cam-region-note'),
  'CAMPanel must render .cam-region-note when operationTargetsRegion is true',
)
	// Badge text: component must reference the i18n key and the en catalog must
	// carry the byte-identical original string.
	assert(
	  camPanel.includes('cam-region-note__badge') && camPanel.includes("camT('cam.regionNote.badge')"),
	  "CAMPanel .cam-region-note__badge must reference the cam.regionNote.badge i18n key",
	)
	assert(
	  camEnCatalog.includes("'cam.regionNote.badge': 'mask'"),
	  'cam en catalog must carry the original region note badge text "mask"',
	)
	// Agreed explanation copy — component must reference the i18n key and the en
	// catalog must carry the byte-identical original string.
	assert(
	  camPanel.includes("camT('cam.regionNote.text')"),
	  "CAMPanel region note must reference the cam.regionNote.text i18n key",
	)
	assert(
	  camEnCatalog.includes("'cam.regionNote.text': 'Regions limit where this operation may cut"),
	  'cam en catalog must carry the original region note explanation',
	)

// ── PropertiesPanel: Z-lock and region note for region features ──

// Z Range field must be shown and locked for region features.
assert(
  propertiesPanel.includes("t('featureTree.properties.z.followsStock'"),
  'PropertiesPanel must show the Z Range locked field for region features',
)
assert(
  featureTreeEnCatalogReg.includes("'featureTree.properties.z.followsStock': 'Follows stock ({thickness} to 0)'"),
  'featureTree en catalog must carry the original followsStock string',
)
// Region note must appear with the agreed badge and copy.
assert(
  propertiesPanel.includes('properties-region-note') && propertiesPanel.includes("t('featureTree.properties.regionNote.badge')"),
  'PropertiesPanel must render .properties-region-note with the i18n region note badge key',
)
assert(
  featureTreeEnCatalogReg.includes("'featureTree.properties.regionNote.badge': 'mask'"),
  'featureTree en catalog must carry the original region note badge "mask"',
)
assert(
  propertiesPanel.includes("t('featureTree.properties.regionNote.text')"),
  'PropertiesPanel region note must reference the i18n text key',
)
assert(
  featureTreeEnCatalogReg.includes("'featureTree.properties.regionNote.text': 'A region is a filter: it limits where operations may cut, not a shape to machine.'"),
  'featureTree en catalog must carry the original region note explanation',
)
assert(
  propertiesPanel.includes('featureTree.properties.maskMode') && propertiesPanel.includes("t('featureTree.properties.operation.region')") && propertiesPanel.includes("t('featureTree.properties.maskMode.exclude')"),
  'PropertiesPanel must expose Region mask operation and Include/Exclude mask mode controls via i18n keys',
)

// ── DepthLegend: merged subtract color and region include/exclude keys ──

const canvasEn = readSrc('src/i18n/locales/en/canvas.ts')
assert(canvasEn.includes("'canvas.legend.subtract': 'Subtract'"), 'canvas i18n catalog must include the Subtract entry')
assert(!depthLegend.includes('Subtract'), 'DepthLegend must not hardcode Subtract — uses i18n key')
assert(!depthLegend.includes('Subtract shallow'), 'DepthLegend must not keep the old Subtract shallow entry')
assert(!depthLegend.includes('Subtract deep'), 'DepthLegend must not keep the old Subtract deep entry')
assert(canvasEn.includes("'canvas.legend.regionInclude': 'Region include'"), 'canvas i18n catalog must include Region include')
assert(canvasEn.includes("'canvas.legend.regionExclude': 'Region exclude'"), 'canvas i18n catalog must include Region exclude')

console.log('regionPresentation.test.ts passed')
