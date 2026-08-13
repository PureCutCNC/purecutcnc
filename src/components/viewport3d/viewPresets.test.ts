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

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import * as THREE from 'three'
import {
  VIEW_PRESETS,
  VIEW_PRESET_ORDER,
  viewPresetMeta,
  type ViewPreset,
} from './viewPresets'

const ALL_PRESETS: ViewPreset[] = ['iso', 'top', 'bottom', 'front', 'back', 'right', 'left']

test('VIEW_PRESETS has an entry for every preset', () => {
  for (const preset of ALL_PRESETS) {
    assert.ok(preset in VIEW_PRESETS, `missing preset: ${preset}`)
  }
  assert.equal(Object.keys(VIEW_PRESETS).length, ALL_PRESETS.length)
})

test('every preset has a spherical phi in the closed range [0, π]', () => {
  for (const preset of ALL_PRESETS) {
    const { phi } = VIEW_PRESETS[preset]
    assert.ok(phi >= 0 && phi <= Math.PI, `${preset} phi ${phi} must be in [0, π]`)
  }
})

// This replaces an older `phi` strictly-inside-(0, π) check. That was a proxy
// for "lookAt must be well defined", which is really a statement about `up`, not
// about phi: the poles are only unusable when `up` is parallel to the view
// direction. Top and Bottom carry a perpendicular `up` of their own so they can
// sit exactly on the pole and give a true plan view. Asserting the real property
// is strictly stronger — the old check passed anything off-pole, including a
// preset whose `up` pointed straight down its own view direction. Issue #493.
test('every preset keeps up non-parallel to the view direction', () => {
  for (const preset of ALL_PRESETS) {
    const { theta, phi, up } = VIEW_PRESETS[preset]
    const eye = new THREE.Vector3(
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.cos(theta),
    )
    const cross = new THREE.Vector3().crossVectors(new THREE.Vector3(...up), eye)
    assert.ok(
      cross.length() > 0.1,
      `${preset} up ${JSON.stringify(up)} is parallel to its view direction — lookAt is undefined`,
    )
  }
})

test('every preset has a unit-length up vector', () => {
  for (const preset of ALL_PRESETS) {
    const [x, y, z] = VIEW_PRESETS[preset].up
    const len = Math.hypot(x, y, z)
    assert.ok(Math.abs(len - 1) < 1e-6, `${preset} up vector length ${len} is not unit`)
  }
})

test('VIEW_PRESET_ORDER contains every preset exactly once and iso is first', () => {
  assert.equal(VIEW_PRESET_ORDER[0], 'iso')
  assert.equal(VIEW_PRESET_ORDER.length, ALL_PRESETS.length)
  const sorted = [...VIEW_PRESET_ORDER].sort()
  const expected = [...ALL_PRESETS].sort()
  assert.deepEqual(sorted, expected)
})

test('viewPresetMeta returns an icon id and label key for every preset', () => {
  for (const preset of ALL_PRESETS) {
    const meta = viewPresetMeta(preset)
    assert.ok(meta.iconId.startsWith('view-'), `${preset} iconId ${meta.iconId}`)
    assert.ok(meta.labelKey.startsWith('viewport.presets.'), `${preset} labelKey ${meta.labelKey}`)
  }
})

test('viewPresetMeta(null) returns the custom-view fallback', () => {
  const meta = viewPresetMeta(null)
  assert.equal(meta.iconId, 'view-free')
  assert.equal(meta.labelKey, 'viewport.presets.free')
})

test('iso preset matches the default camera spherical orientation', () => {
  const iso = VIEW_PRESETS.iso
  assert.equal(iso.theta, Math.PI / 4)
  assert.equal(iso.phi, Math.PI / 3)
})
