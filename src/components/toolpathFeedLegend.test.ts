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
 * Structural tests for the feed-colour legend steps (issue #535).
 *
 * The legend must describe exactly what the renderers paint: the distinct
 * (scale, step) pairs on each visible toolpath's cut moves, cached by toolpath
 * identity so the render path never rescans moves. These tests pin the
 * correctness of the scan and the identity of the cache; the CPU-ratio test in
 * `toolpathFeedLegendCpu.test.ts` pins that the cache actually makes the
 * render path cheap.
 *
 * Run with: npx tsx src/components/toolpathFeedLegend.test.ts
 */

import assert from 'node:assert/strict'
import type { ToolpathMove, ToolpathResult } from '../engine/toolpaths/types'
import {
  feedColourLegendSteps,
  feedLegendStepLabels,
  scanFeedColourLegendSteps,
  unionFeedColourLegendSteps,
  type FeedColourLegendStep,
} from './toolpathVisibility'

function cut(from: number, to: number, feedScale?: number): ToolpathMove {
  return { kind: 'cut', from: { x: from, y: 0, z: 0 }, to: { x: to, y: 0, z: 0 }, ...(feedScale === undefined ? {} : { feedScale }) }
}

function toolpath(id: string, moves: ToolpathMove[]): ToolpathResult {
  return { operationId: id, moves, warnings: [], bounds: null }
}

function keys(steps: readonly FeedColourLegendStep[]): string[] {
  return steps.map((s) => `${s.scale}:${s.step}`)
}

// ── scan: distinct cut-move scales, absent feedScale is full feed ─────

{
  const steps = scanFeedColourLegendSteps([
    cut(0, 1),                 // absent -> scale 1, step 0
    cut(1, 2, 1),              // explicit 1 -> same entry
    cut(2, 3, 0.6),            // reduced under slotScale 0.6 -> step 7 (slowest)
    cut(3, 4, 0.6),            // duplicate scale/step
    { kind: 'rapid', from: { x: 0, y: 0, z: 1 }, to: { x: 1, y: 0, z: 1 }, feedScale: 0.5 },
    { kind: 'lead_in', from: { x: 0, y: 0, z: 1 }, to: { x: 0, y: 0, z: 0 }, feedScale: 0.5 },
  ], 0.6)
  assert.deepEqual(keys(steps), ['1:0', '0.6:7'], 'cut moves only; absent and 1 collapse to full feed')
}

{
  // The same emitted scale can land on different ramp steps under different
  // slot feeds — the step is what the swatch colour derives from.
  const at60 = scanFeedColourLegendSteps([cut(0, 1, 0.6)], 0.6)
  const at40 = scanFeedColourLegendSteps([cut(0, 1, 0.6)], 0.4)
  assert.equal(at60[0].step, 7, '0.6 at slotScale 0.6 is the slowest rung')
  assert.equal(at40[0].step, 6, '0.6 at slotScale 0.4 sits one rung up the ladder')
}

// ── cache: one scan per toolpath identity + slot scale ─────────────────

{
  const tp = toolpath('op-a', Array.from({ length: 1000 }, (_, i) => cut(i, i + 1, i % 2 === 0 ? undefined : 0.6)))
  const first = feedColourLegendSteps(tp, 0.6)
  const second = feedColourLegendSteps(tp, 0.6)
  assert.equal(first, second, 'same toolpath and slot scale must return the cached array identity')

  const otherScale = feedColourLegendSteps(tp, 0.4)
  assert.notEqual(otherScale, first, 'a different slot scale must recompute')
  assert.deepEqual(keys(otherScale), ['1:0', '0.6:6'])

  const otherToolpath = toolpath('op-b', tp.moves)
  assert.notEqual(feedColourLegendSteps(otherToolpath, 0.6), first, 'a different toolpath object must not share the cache')
}

// ── union: dedupe by (scale, step), sort by descending scale ──────────

{
  const engagement = toolpath('op-a', [cut(0, 1, 0.9), cut(1, 2, 0.75), cut(2, 3)])
  const slots = toolpath('op-b', [cut(0, 1, 0.6), cut(1, 2)])
  const empty = toolpath('op-c', [])
  const slotScaleOf = (id: string): number => (id === 'op-a' ? 0.75 : 0.6)

  const union = unionFeedColourLegendSteps([engagement, slots, empty], slotScaleOf)
  assert.deepEqual(keys(union), ['1:0', '0.9:4', '0.75:7', '0.6:7'],
    'union of engagement ladder and slot scale, full feed first, empty toolpath skipped')

  // Two entries may share a step but never a (scale, step) pair.
  const dup = unionFeedColourLegendSteps([engagement, engagement, slots], slotScaleOf)
  assert.deepEqual(keys(dup), keys(union), 'duplicate toolpaths contribute one entry per pair')
}

// ── legend labels: whole percents, one decimal only when rounding collides ──

{
  assert.deepEqual(
    feedLegendStepLabels([1, 0.95, 0.9]),
    ['100%', '95%', '90%'],
    'distinct rounded percents stay whole percents',
  )
  // Slot 90% ladder head: 1 / 0.995 / 0.99 — two entries round to 100%, so
  // every label drops to one decimal (trailing .0 stripped).
  assert.deepEqual(
    feedLegendStepLabels([1, 0.995, 0.99]),
    ['100%', '99.5%', '99%'],
    'colliding rounded labels fall back to one decimal across all entries',
  )
}

console.log('toolpathFeedLegend.test.ts passed')
