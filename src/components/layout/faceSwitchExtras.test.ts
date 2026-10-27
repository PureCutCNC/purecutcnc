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
 * What the face control carries beyond its menu (issue #1112 slice B).
 *
 * Mutations these assertions were checked against:
 * - naming the flip on Top too → "Top: no flip" fails;
 * - ignoring `bothFaces` → "Bottom on a Top-only project: no flip" fails;
 * - reporting a flip for Around → "Around: no flip" fails.
 *
 * Run with: npx tsx src/components/layout/faceSwitchExtras.test.ts
 */

import assert from 'node:assert/strict'
import { faceSwitchExtras } from './faceSwitchExtras'

// Top is the face the stock is flipped *to*, not away from: nothing to report.
assert.deepEqual(faceSwitchExtras({ face: 'top', bothFaces: true, axis: 'x' }), { flipAxis: null }, 'Top: no flip')

// Bottom is the flip, and the label names the axis the stock turned about.
assert.deepEqual(faceSwitchExtras({ face: 'bottom', bothFaces: true, axis: 'x' }), { flipAxis: 'x' }, 'Bottom about X: the label names X')
assert.deepEqual(faceSwitchExtras({ face: 'bottom', bothFaces: true, axis: 'y' }), { flipAxis: 'y' }, 'Bottom about Y: the label names Y')

// A single-face project has no second side, so a Bottom view explains nothing.
assert.deepEqual(faceSwitchExtras({ face: 'bottom', bothFaces: false, axis: 'x' }), { flipAxis: null }, 'Bottom on a Top-only project: no flip')

// Around is the bar's unrolled surface, not a half-turn of either flat face.
assert.deepEqual(faceSwitchExtras({ face: 'around', bothFaces: true, axis: 'x' }), { flipAxis: null }, 'Around: no flip')

console.log('face switch extras tests passed')
