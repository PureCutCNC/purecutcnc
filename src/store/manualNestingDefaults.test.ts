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

import { rectProfile } from '../types/project'
import type { FeatureOperation, SketchFeature } from '../types/project'
import { useProjectStore } from './projectStore'
import { resolvedProjectFeatures } from './helpers/resolveFeatures'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function resetStore(): void {
  useProjectStore.getState().createNewProject()
  useProjectStore.getState().setCreationTarget('feature')
}

function operation(name: string): FeatureOperation | undefined {
  return resolvedProjectFeatures(useProjectStore.getState().project).find((feature) => feature.name === name)?.operation
}

function explicitFeature(
  id: string,
  name: string,
  operationValue: FeatureOperation,
  x: number,
  y: number,
  size: number,
): SketchFeature {
  return {
    id,
    name,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, size, size),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: operationValue,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function testPrimitiveAlternatingNesting(): void {
  resetStore()
  const store = useProjectStore.getState()
  store.addRectFeature('outer', 0, 0, 100, 100, 5)
  useProjectStore.getState().addRectFeature('pocket', 10, 10, 80, 80, 5)
  useProjectStore.getState().addRectFeature('island', 20, 20, 20, 20, 5)
  useProjectStore.getState().addRectFeature('outside', 200, 200, 10, 10, 5)

  assert(operation('outer') === 'add', 'outside root defaults Add')
  assert(operation('pocket') === 'subtract', 'inside Add defaults Subtract')
  assert(operation('island') === 'add', 'inside Subtract defaults Add')
  assert(operation('outside') === 'add', 'disjoint feature defaults Add')
}

function testNonSolidContainersIgnored(): void {
  resetStore()
  useProjectStore.getState().addRectFeature('outer', 0, 0, 100, 100, 5)
  const store = useProjectStore.getState()
  store.addFeature(explicitFeature('line-container', 'line-container', 'line', 10, 10, 80))
  store.addFeature(explicitFeature('region-container', 'region-container', 'region', 20, 20, 60))
  store.addFeature(explicitFeature('construction-container', 'construction-container', 'construction', 30, 30, 40))
  store.addFeature(explicitFeature('model-container', 'model-container', 'model', 35, 35, 30))
  useProjectStore.getState().addRectFeature('candidate', 40, 40, 10, 10, 5)
  assert(operation('candidate') === 'subtract', 'Line/Region/Construction/Model do not mask containing Add')
}

function testExplicitOperationsAndTargetsWin(): void {
  resetStore()
  useProjectStore.getState().addRectFeature('outer', 0, 0, 100, 100, 5)
  useProjectStore.getState().addFeature(
    explicitFeature('explicit-subtract', 'explicit-subtract', 'subtract', 200, 200, 10),
  )
  assert(operation('explicit-subtract') === 'subtract', 'direct explicit Subtract is not inferred')

  useProjectStore.getState().setCreationTarget('line')
  useProjectStore.getState().addRectFeature('closed-line', 10, 10, 10, 10, 5)
  assert(operation('closed-line') === 'line', 'Line creation target keeps a closed primitive as Line')

  useProjectStore.getState().setCreationTarget('region')
  useProjectStore.getState().addRectFeature('ignored-region-name', 10, 10, 10, 10, 5)
  assert(
    resolvedProjectFeatures(useProjectStore.getState().project).some((feature) => feature.operation === 'region'),
    'Region creation target wins',
  )
  useProjectStore.getState().setCreationTarget('construction')
  useProjectStore.getState().addRectFeature('ignored-construction-name', 10, 10, 10, 10, 5)
  assert(
    resolvedProjectFeatures(useProjectStore.getState().project).some((feature) => feature.operation === 'construction'),
    'Construction creation target wins',
  )
}

function testLaterOuterDoesNotReclassifyExisting(): void {
  resetStore()
  useProjectStore.getState().addRectFeature('first-inner', 20, 20, 10, 10, 5)
  useProjectStore.getState().addRectFeature('later-outer', 0, 0, 100, 100, 5)
  assert(operation('first-inner') === 'add', 'existing feature keeps its original operation')
  assert(operation('later-outer') === 'add', 'new enclosing root defaults Add')
}

function testClosedCompositeUsesSameInference(): void {
  resetStore()
  useProjectStore.getState().addRectFeature('outer', 0, 0, 100, 100, 5)
  useProjectStore.setState({
    pendingAdd: {
      shape: 'composite',
      start: { x: 10, y: 10 },
      lastPoint: { x: 10, y: 10 },
      segments: [
        { type: 'line', to: { x: 20, y: 10 } },
        { type: 'line', to: { x: 15, y: 20 } },
        { type: 'line', to: { x: 10, y: 10 } },
      ],
      currentMode: 'line',
      pendingArcEnd: null,
      closed: true,
      session: 1,
    },
  })
  useProjectStore.getState().completePendingComposite()
  const composite = resolvedProjectFeatures(useProjectStore.getState().project).find((feature) => feature.name.startsWith('Composite'))
  assert(composite?.operation === 'subtract', 'closed composite inside Add defaults Subtract')
  assert(useProjectStore.getState().pendingAdd === null, 'composite completion clears pending draft')
}

const tests = [
  ['primitive alternating nesting', testPrimitiveAlternatingNesting],
  ['non-solid containers ignored', testNonSolidContainersIgnored],
  ['explicit operations and targets win', testExplicitOperationsAndTargetsWin],
  ['later outer does not reclassify existing', testLaterOuterDoesNotReclassifyExisting],
  ['closed composite uses same inference', testClosedCompositeUsesSameInference],
] as const

let passed = 0
for (const [name, test] of tests) {
  test()
  passed += 1
  console.log(`${name}: PASSED`)
}
console.log(`\nmanualNestingDefaults.test.ts: ${passed} passed, 0 failed`)
