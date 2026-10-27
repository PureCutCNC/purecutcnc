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
import { test } from 'node:test'
import type { Clamp } from '../../types/project'
import { aroundChuckFootprint, drawAroundChuck } from './aroundChuck'

test('Around chuck stays at its own axial size and one sheet high, independently of visible turns', () => {
  const clamp: Clamp = { id: 'c', name: 'Chuck', type: 'chuck', x: -40, y: -1000, w: 55, h: 2000, height: 50, visible: true }
  for (const axis of ['x', 'y'] as const) {
    const frame = { axis, sheetStart: -31, circumference: 62 }
    const display = aroundChuckFootprint(clamp, frame)
    assert.equal(axis === 'x' ? display.h : display.w, 62)
    assert.equal(axis === 'x' ? display.y : display.x, -31)
    assert.equal(axis === 'x' ? display.w : display.h, axis === 'x' ? clamp.w : clamp.h)
    assert.equal(axis === 'x' ? display.x : display.y, axis === 'x' ? clamp.x : clamp.y)
    assert.equal(clamp.h, 2000, 'keep-out band is never mutated')
    const labels: string[] = []
    const noop = () => {}
    const ctx = { beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop,
      setLineDash: noop, save: noop, restore: noop, fillText: (text: string) => labels.push(text) } as unknown as CanvasRenderingContext2D
    assert.equal(drawAroundChuck(ctx, clamp, frame, { scale: 2, offsetX: 0, offsetY: 0 }, false, false), true)
    assert.deepEqual(labels, ['Chuck'])
  }
})
