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
 * Structural test for the canvas redraw dependency list (issues #671, #813).
 *
 * `SketchCanvas` draws every pending workflow preview from a ref, so the only
 * thing that puts a panel edit on screen is the redraw effect listing that
 * workflow's store state. A missing entry is invisible in review and silent at
 * runtime — the preview simply stops tracking the panel until some unrelated
 * state changes. It happened to `pendingTextLayout` (#671) and then to
 * `pendingFeatureDistribution` (#813), both fixed by adding the dependency.
 *
 * Run with: npx tsx src/components/canvas/canvasRedrawDependencies.test.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// src/components/canvas/ → repo root is three levels up
const source = readFileSync(resolve(here, '../../..', 'src/components/canvas/SketchCanvas.tsx'), 'utf8')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// The effect whose whole body is `scheduleDraw()` and whose deps carry the
// project — the one redraw that panel-driven state has to reach.
const effects = [...source.matchAll(/useEffect\(\(\) => \{\s*scheduleDraw\(\)\s*\}, \[([^\]]*)\]\)/g)]
  .map((match) => match[1].split(',').map((dep) => dep.trim()))
const dependencies = effects.find((deps) => deps.includes('project'))
assert(dependencies, 'SketchCanvas must keep a scheduleDraw effect that depends on the project')

// Every workflow with a canvas preview driven by its own panel fields.
for (const workflow of [
  'pendingAdd',
  'pendingMove',
  'pendingTransform',
  'pendingOffset',
  'pendingClipboardPlacement',
  'pendingTextLayout',
  'pendingFeatureDistribution',
]) {
  assert(
    dependencies.includes(workflow),
    `the canvas redraw effect must depend on ${workflow}, or its panel edits never reach the preview`,
  )
}

console.log('canvasRedrawDependencies: OK')
