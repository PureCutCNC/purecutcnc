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

import assert from 'node:assert/strict'
import type { MouseEvent } from 'react'
import { aroundSelectionFixture } from './aroundSelection.testSupport'
import { computeSketchViewTransform, worldToCanvas } from './viewTransform'
import { aroundModelBandAt, aroundSheet } from './aroundSheet'
import { useClickPlacement } from './useClickPlacement'

for (const axis of ['x', 'y'] as const) {
  const f = aroundSelectionFixture(axis)
  const selected: (string | null)[] = []
  const explicit = {
    projectRef: { current: f.project }, selectionRef: { current: f.selection },
    viewStateRef: { current: f.viewState }, canvasRef: { current: f.canvas },
    dimEdit: { dimensionEditRef: { current: null } },
    snap: { resolveCurrentSketchSnap: () => ({ point: f.point, mode: null }),
      requiresResolvedSnapForPointPick: () => false },
    clearOverlapFeaturePicker: () => {},
    openOverlapFeaturePicker: () => { throw new Error('flat silhouettes must not open overlap picker') },
    canvasCoordinates: () => f.screen(), selectFeature: (id: string | null) => selected.push(id),
  }
  // Inactive workflows have empty refs; unexpected actions still throw.
  const ctx = new Proxy(explicit, { get(target, key) {
    if (key in target) return Reflect.get(target, key)
    if (typeof key === 'string' && key.endsWith('Ref')) return { current: null }
    return undefined
  } }) as unknown as Parameters<typeof useClickPlacement>[0]
  const click = () => useClickPlacement(ctx).handleClick({} as MouseEvent<HTMLCanvasElement>)
  assert.equal(aroundModelBandAt(aroundSheet(f.project)!, f.point), 'second')
  click()
  assert.equal(selected.pop(), 'second', `${axis}: topmost band wins over first model footprint`)
  // A footprint outside the sheet must never be selectable on Around.
  f.screen = () => ({ cx: -10000, cy: -10000 })
  click()
  assert.equal(selected.pop(), null)
  f.project.activeSetupId = f.project.setups[0].id
  f.screen = () => {
    const vt = computeSketchViewTransform(f.project, 800, 600, f.viewState)
    return worldToCanvas(f.point, vt)
  }
  click()
  assert.equal(selected.pop(), 'first', `${axis}: Top still selects the flat silhouette`)
}
console.log('useClickPlacement: Around band regression passed')
