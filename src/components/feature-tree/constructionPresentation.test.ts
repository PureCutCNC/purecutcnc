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
assert(layoutCss.includes('.toolbar-target-btn--line.toolbar-target-btn--active'), 'layout.css must style the active line target button')
assert(layoutCss.includes('.properties-construction-note'), 'layout.css must define .properties-construction-note')
assert(layoutCss.includes('.properties-construction-note__badge'), 'layout.css must define .properties-construction-note__badge')
assert(tabletCss.includes('.tool-rail__target-btn--construction.tool-rail__target-btn--active'), 'tablet.css must style the rail construction target button')
assert(tabletCss.includes('.tool-rail__target-btn--line.tool-rail__target-btn--active'), 'tablet.css must style the rail line target button')

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

// ── Creation toolbars: Line and Construction targets ─────────────

assert(
  creationActions.includes("renderCreationTargetButton('line', 'snap-line', t(CREATION_TARGET_LABEL_KEYS.line))"),
  'CreationActions must render the line creation target',
)

assert(
  creationActions.includes("renderCreationTargetButton('construction', 'construction', t(CREATION_TARGET_LABEL_KEYS.construction))"),
  'CreationActions must render the construction creation target',
)
assert(
  toolRail.includes('tool-rail__target-btn--line'),
  'ToolRail must render the line creation target',
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
  previewPrimitives.includes("ctx.setLineDash(construction ? [6, 4] : lineDash)"),
  'drawFeature must render construction with a dashed stroke',
)
assert(
  previewPrimitives.includes('profile.closed && featureUsesSketchFill(feature.operation)'),
  'drawFeature must gate closed-profile fill by feature role',
)
assert(
  previewPrimitives.includes("return operation !== 'line' && operation !== 'construction'"),
  'drawFeature must never fill Line or Construction profiles',
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
// Single-feature AND multi-select operation controls both offer Construction.
assert(
  propertiesPanel.split("{ value: 'construction', label: 'Construction' }").length >= 3,
  'PropertiesPanel must offer Construction in both operation selectors',
)
// Open profiles convert Line ↔ Construction (mirrors the tree menu).
assert(
  propertiesPanel.includes("{ value: 'line', label: 'Line' }"),
  'PropertiesPanel open-profile operation control must offer Line ↔ Construction',
)
// The base-solid lock tracks the first SOLID feature, not row 0.
assert(
  propertiesPanel.includes('features.find(isSolid)'),
  'PropertiesPanel first-solid lookup must use isSolid',
)
assert(
  featureTree.includes('feature.id === firstSolidFeature?.id'),
  'FeatureTree first-feature lock must track the first solid feature',
)

// ── AppShell: statusbar visibility toggle ────────────────────────

assert(
  appShell.includes('setAllConstructionVisible(!anyConstructionVisible)'),
  'AppShell statusbar must include the construction visibility toggle',
)

// ── Sketch view: drawing-mode badge ──────────────────────────────

const creationTargetBadge = readSrc('src/components/canvas/CreationTargetBadge.tsx')
const sketchCanvas = readSrc('src/components/canvas/SketchCanvas.tsx')
const canvasEn = readSrc('src/i18n/locales/en/canvas.ts')

assert(
  layoutCss.includes('.creation-target-badge') && layoutCss.includes('.creation-target-badge--construction') && layoutCss.includes('.creation-target-badge--line'),
  'layout.css must define the drawing-mode badge with line and construction variants',
)
assert(
  /\.creation-target-badge \{[^}]*pointer-events: none/s.test(layoutCss),
  'the drawing-mode badge must not intercept canvas pointer events',
)
assert(
  creationTargetBadge.includes("canvas.target.drawingLines"),
  'CreationTargetBadge must reference the drawing-lines i18n key',
)
assert(
  canvasEn.includes("'canvas.target.drawingLines': 'Drawing lines'"),
  'canvas i18n catalog must include the drawing-lines English string',
)
assert(
  creationTargetBadge.includes("canvas.target.drawingConstruction"),
  'CreationTargetBadge must reference the drawing-construction i18n key',
)
assert(
  canvasEn.includes("'canvas.target.drawingConstruction': 'Drawing construction'"),
  'canvas i18n catalog must include the drawing-construction English string',
)
assert(
  sketchCanvas.includes('<CreationTargetBadge />'),
  'SketchCanvas must render the drawing-mode badge overlay',
)

console.log('constructionPresentation.test.ts passed')
