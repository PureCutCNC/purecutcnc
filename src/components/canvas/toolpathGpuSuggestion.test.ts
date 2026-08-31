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
import { createSlowCanvasDetector, GPU_SUGGESTION_CODEC } from './toolpathGpuSuggestion'

const detector = createSlowCanvasDetector()
const sample = (durationMs: number, now: number, navigating = true) => detector.observe({ durationMs, now, navigating })
const slowGesture = (start = 0) => {
  for (let i = 0; i < 7; i++) assert.equal(sample(60, start + i * 100), false)
}
slowGesture()
assert.equal(sample(0, 700, false), true)
assert.equal(sample(0, 800, false), false)

// Multi-second draws must not be mistaken for inactivity between samples.
for (let i = 0; i < 7; i++) assert.equal(sample(2500, 5000 + i * 2600), false)
assert.equal(sample(0, 20700, false), true)

// Idle drawing and a cold first navigation frame cannot trigger the tip.
for (let i = 0; i < 12; i++) assert.equal(sample(500, i * 100, false), false)
assert.equal(sample(1000, 1300), false)
assert.equal(sample(0, 1400, false), false)

// Six slow samples include the ignored first sample, so are not enough.
for (let i = 0; i < 6; i++) sample(40, i * 100)
assert.equal(sample(0, 600, false), false)
slowGesture()
detector.reset()
assert.equal(sample(0, 700, false), false)

// Fast work, long gaps and invalid clocks reset accumulated evidence.
slowGesture()
sample(39, 700)
assert.equal(sample(0, 800, false), false)
slowGesture()
assert.equal(sample(0, 3000, false), false)
slowGesture()
sample(50, 3000)
assert.equal(sample(0, 3100, false), false)
for (const invalid of [NaN, Infinity, -1]) {
  slowGesture()
  assert.equal(sample(invalid, 700), false)
  assert.equal(sample(0, 800, false), false)
}
slowGesture()
assert.equal(sample(50, -1), false)
assert.equal(sample(0, 0, false), false)
slowGesture()
assert.equal(sample(50, NaN), false)
assert.equal(sample(0, 800, false), false)

for (const value of [true, false]) {
  assert.equal(GPU_SUGGESTION_CODEC.deserialize(GPU_SUGGESTION_CODEC.serialize(value)), value)
}
for (const invalid of ['', 'null', '1', '"true"']) assert.throws(() => GPU_SUGGESTION_CODEC.deserialize(invalid))
console.log('toolpathGpuSuggestion tests passed')
