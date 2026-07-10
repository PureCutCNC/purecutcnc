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
 * Unit tests for the feature-role predicates (issue #199).
 *
 * Run with: npx tsx src/store/helpers/featureRoles.test.ts
 */

import type { FeatureOperation, SketchFeature } from '../../types/project'
import { rectProfile } from '../../types/project'
import { isConstruction, isMachinable, isRegion, isSolid, modelFeatures, sectionForOperation } from './featureRoles'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeFeature(id: string, operation: FeatureOperation): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 10, 5),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

const ALL_OPERATIONS: FeatureOperation[] = ['add', 'subtract', 'region', 'model', 'line', 'construction']

// ── Predicates partition the operation space ─────────────────────

for (const operation of ALL_OPERATIONS) {
  const feature = makeFeature(`f-${operation}`, operation)
  const construction = isConstruction(feature)
  const region = isRegion(feature)
  const machinable = isMachinable(feature)

  assert(construction === (operation === 'construction'), `isConstruction(${operation})`)
  assert(region === (operation === 'region'), `isRegion(${operation})`)
  assert(machinable === (operation !== 'region' && operation !== 'construction'), `isMachinable(${operation})`)
  // Exactly one of machinable / region / construction holds for every operation.
  assert(
    Number(construction) + Number(region) + Number(machinable) === 1,
    `roles must partition: ${operation}`,
  )
}

// ── sectionForOperation ──────────────────────────────────────────

assert(sectionForOperation('region') === 'regions', 'region → regions section')
assert(sectionForOperation('construction') === 'construction', 'construction → construction section')
assert(sectionForOperation('add') === 'features', 'add → features section')
assert(sectionForOperation('subtract') === 'features', 'subtract → features section')
assert(sectionForOperation('model') === 'features', 'model → features section')
assert(sectionForOperation('line') === 'features', 'line → features section')
assert(sectionForOperation(undefined) === 'features', 'undefined → features section')

// ── isSolid distinguishes solid-contributing from path-only machinable ──

for (const operation of ALL_OPERATIONS) {
  const feature = makeFeature(`fs-${operation}`, operation)
  assert(isSolid(feature) === (operation === 'add' || operation === 'subtract' || operation === 'model'),
    `isSolid(${operation})`)
}

// ── modelFeatures excludes construction only ─────────────────────

const mixed = ALL_OPERATIONS.map((operation) => makeFeature(`f-${operation}`, operation))
const model = modelFeatures(mixed)
assert(model.length === ALL_OPERATIONS.length - 1, 'modelFeatures drops exactly the construction feature')
assert(model.every((feature) => feature.operation !== 'construction'), 'no construction in model features')
assert(model.some((feature) => feature.operation === 'region'), 'regions stay in model features (display walls)')

console.log('featureRoles.test.ts passed')
