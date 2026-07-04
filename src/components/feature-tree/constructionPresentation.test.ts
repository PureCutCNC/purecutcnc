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
 * Structural tests for the construction-geometry UI treatment (issue #199).
 *
 * Mirrors regionPresentation.test.ts: verifies at the source level that the
 * CSS classes exist, the tree renders the "ref" badge and Construction
 * section, the creation toolbars offer the third target, the canvas renders
 * construction dashed/unfilled, and the properties panel locks Z and shows
 * the construction note.
 *
 * Run with: npx tsx src/components/feature-tree/constructionPresentation.test.ts
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

const layoutCss = readSrc('src/styles/layout.css')
const tabletCss = readSrc('src/styles/tablet.css')
const featureTree = readSrc('src/components/feature-tree/FeatureTree.tsx')
const propertiesPanel = readSrc('src/components/feature-tree/PropertiesPanel.tsx')
const creationActions = readSrc('src/components/layout/toolbar/CreationActions.tsx')
const toolRail = readSrc('src/components/layout/ToolRail.tsx')
const previewPrimitives = readSrc('src/components/canvas/previewPrimitives.ts')
const appShell = readSrc('src/components/layout/AppShell.tsx')

// ── CSS class definitions ────────────────────────────────────────

assert(layoutCss.includes('.tree-construction-badge'), 'layout.css must define .tree-construction-badge')
assert(layoutCss.includes('.tree-row--construction'), 'layout.css must define .tree-row--construction')
assert(layoutCss.includes('.tree-row--constructions .tree-branch'), 'layout.css must style the Construction section root branch')
assert(layoutCss.includes('.toolbar-target-btn--construction.toolbar-target-btn--active'), 'layout.css must style the active construction target button')
assert(layoutCss.includes('.properties-construction-note'), 'layout.css must define .properties-construction-note')
assert(layoutCss.includes('.properties-construction-note__badge'), 'layout.css must define .properties-construction-note__badge')
assert(tabletCss.includes('.tool-rail__target-btn--construction.tool-rail__target-btn--active'), 'tablet.css must style the rail construction target button')

// ── FeatureTree: section root + ref badge + conversion menu ──────

assert(
  featureTree.includes('label="Construction"') && featureTree.includes('kind="constructions"'),
  'FeatureTree must render a Construction section root',
)
assert(
  featureTree.includes("operation === 'construction'") && featureTree.includes('tree-construction-badge'),
  'FeatureTree must render .tree-construction-badge only for construction rows',
)
assert(
  /tree-construction-badge[\s\S]{0,400}>\s*ref\s*</.test(featureTree),
  'FeatureTree .tree-construction-badge must display the text "ref"',
)
assert(
  featureTree.includes("onToggleOperation('construction')"),
  'FeatureTree operation menu must offer conversion to construction',
)
assert(
  featureTree.includes("onToggleOperation('line')"),
  'FeatureTree operation menu must offer converting open construction back to line',
)

// ── Creation toolbars: third target ──────────────────────────────

assert(
  creationActions.includes("renderCreationTargetButton('construction', 'construction', 'Create construction geometry')"),
  'CreationActions must render the construction creation target',
)
assert(
  toolRail.includes('tool-rail__target-btn--construction'),
  'ToolRail must render the construction creation target',
)

// ── Canvas: dashed, unfilled, muted rendering ────────────────────

assert(
  previewPrimitives.includes("feature.operation === 'construction'"),
  'drawFeature must branch on construction',
)
assert(
  previewPrimitives.includes('ctx.setLineDash([6, 4])'),
  'drawFeature must render construction with a dashed stroke',
)
assert(
  previewPrimitives.includes('profile.closed && !construction'),
  'drawFeature must never fill construction profiles',
)

// ── PropertiesPanel: Z lock + note ───────────────────────────────

assert(
  propertiesPanel.includes("selectedFeature.operation === 'construction'") && propertiesPanel.includes('Not machined'),
  'PropertiesPanel must show the locked Z field for construction features',
)
assert(
  propertiesPanel.includes('properties-construction-note') && propertiesPanel.includes('>ref<'),
  'PropertiesPanel must render .properties-construction-note with the "ref" badge',
)
assert(
  propertiesPanel.includes('Construction geometry is a sketch reference'),
  'PropertiesPanel construction note must include the agreed explanation',
)

// ── AppShell: statusbar visibility toggle ────────────────────────

assert(
  appShell.includes('setAllConstructionVisible(!anyConstructionVisible)'),
  'AppShell statusbar must include the construction visibility toggle',
)

console.log('constructionPresentation.test.ts passed')
