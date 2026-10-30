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
 * The analysis input contract (issue #1112 N).
 *
 * A model never reaches the engine as a flat feature: imported STL rows and
 * the canned Turn/Polygon models carry a mesh, so they are dropped here. The
 * input also honours the fold's face rules — Around rows exist only on a
 * rotary round bar — and resolves dimension refs to numbers.
 *
 * Run with: npx tsx src/app/featureEffect/effectInput.test.ts
 */

import { buildEffectFeatures } from './effectInput'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import type { Project } from '../../types/project'
import { newProject, rectProfile, roundStock, type SketchProfile } from '../../types/project'
import { squareStock } from '../../types/barStock'

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

const PROFILE: SketchProfile = rectProfile(0, 0, 10, 10)

function resolved(
  id: string,
  overrides: Partial<ResolvedSketchFeature> = {},
): ResolvedSketchFeature {
  return {
    id,
    name: id,
    definitionId: id,
    instanceId: id,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    kind: 'rect',
    text: null,
    canned: null,
    textLayout: null,
    stl: null,
    folderId: null,
    sketch: {
      profile: PROFILE,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    regionMaskMode: undefined,
    z_top: 0,
    z_bottom: -5,
    authoringFace: 'top',
    visible: true,
    locked: false,
    ...overrides,
  }
}

const project = newProject('effect-input', 'mm')
const built = buildEffectFeatures(project, [
  resolved('plain'),
  resolved('imported-model', { kind: 'stl', operation: 'model' }),
  resolved('imported-add', { kind: 'stl', operation: 'add' }),
  resolved('line', { operation: 'line' }),
  resolved('region', { operation: 'region' }),
  resolved('construction', { operation: 'construction' }),
])
assertEqual(built.length, 1, 'only the flat add reaches the engine')
assertEqual(built[0].id, 'plain', 'the flat add is the survivor')

// Dimension refs are resolved on this side; the engine never sees a name.
const withDimension: Project = {
  ...project,
  dimensions: {
    depth: { id: 'depth', name: 'depth', value: -7.5, formula: null },
  },
}
const dimensioned = buildEffectFeatures(withDimension, [
  resolved('named-depth', { z_top: 'depth', z_bottom: -12 }),
])
assertEqual(dimensioned[0].zTop, -7.5, 'a named dimension resolves to its value')
assertEqual(dimensioned[0].zBottom, -12, 'a numeric ref passes through')

const numericString = buildEffectFeatures(project, [
  resolved('numeric-string', { z_top: '3.5', z_bottom: '-4' }),
])
assertEqual(numericString[0].zTop, 3.5, 'a finite numeric string resolves like the model does')
assertEqual(numericString[0].zBottom, -4, 'a negative numeric string resolves')

// Around rows only fold on a rotary round bar.
const blockAround = buildEffectFeatures(project, [
  resolved('sheet', { authoringFace: 'around' }),
])
assertEqual(blockAround.length, 0, 'Around is absent on a milling block')

const rotary: Project = {
  ...project,
  meta: { ...project.meta, projectType: 'rotary' },
  stock: roundStock(40, 200, 'x'),
}
const rotaryAround = buildEffectFeatures(rotary, [
  resolved('sheet', { authoringFace: 'around' }),
])
assertEqual(rotaryAround.length, 1, 'Around folds on a rotary round bar')

const squareRotary: Project = {
  ...rotary,
  stock: squareStock(40, 200, 'x'),
}
const squareAround = buildEffectFeatures(squareRotary, [
  resolved('sheet', { authoringFace: 'around' }),
])
assertEqual(squareAround.length, 0, 'a square blank does not model 2D sheet work')

console.log('effectInput.test.ts: all assertions passed')
