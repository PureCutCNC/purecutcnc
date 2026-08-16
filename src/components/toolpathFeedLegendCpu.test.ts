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
 * CPU-ratio guard for the feed-colour legend cache (issue #535).
 *
 * The legend render path must not scan moves: `feedColourLegendSteps` scans
 * once per toolpath identity and returns a cached array afterwards. The
 * reference here is the scan itself — the same code path on the same fixtures,
 * provably unable to benefit from the cache — so the ratio measures only the
 * cache. Deleting the cache collapses the ratio to ~1 (verified by mutation;
 * see AGENTS.md §Performance).
 *
 * Run with: npx tsx src/components/toolpathFeedLegendCpu.test.ts
 */

import assert from 'node:assert/strict'
import { cpuRatio } from '../test/cpuRatio'
import type { ToolpathMove, ToolpathResult } from '../engine/toolpaths/types'
import { feedColourLegendSteps, scanFeedColourLegendSteps } from './toolpathVisibility'

const TOOLPATH_COUNT = 16
const MOVES_PER_TOOLPATH = 25_000
const SCALES = [undefined, 0.6, 0.75, 0.8, 0.9, 0.95, 1]

function buildFixtures(): ToolpathResult[] {
  const toolpaths: ToolpathResult[] = []
  for (let t = 0; t < TOOLPATH_COUNT; t += 1) {
    const moves: ToolpathMove[] = []
    for (let i = 0; i < MOVES_PER_TOOLPATH; i += 1) {
      const scale = SCALES[i % SCALES.length]
      moves.push({
        kind: 'cut',
        from: { x: i, y: 0, z: 0 },
        to: { x: i + 1, y: 0, z: 0 },
        ...(scale === undefined ? {} : { feedScale: scale }),
      })
    }
    toolpaths.push({ operationId: `op-${t}`, moves, warnings: [], bounds: null })
  }
  return toolpaths
}

// Built once, outside the measured region.
const toolpaths = buildFixtures()
const SLOT_SCALE = 0.75

const subject = {
  run: () => {
    for (const toolpath of toolpaths) {
      feedColourLegendSteps(toolpath, SLOT_SCALE)
    }
  },
}
const reference = {
  run: () => {
    for (const toolpath of toolpaths) {
      scanFeedColourLegendSteps(toolpath.moves, SLOT_SCALE)
    }
  },
}

// Warm the JIT and prime the cache outside the measurement.
subject.run()
reference.run()

const measured = cpuRatio(subject, reference)
console.log(`toolpathFeedLegendCpu: ${JSON.stringify(measured)}`)
assert.ok(measured.referenceMs > 0, 'reference must do measurable work or the ratio is meaningless')

// Threshold = geometric midpoint of the worst pair, per AGENTS.md §Performance.
//
// Baseline (cache intact, 16 × 25k cut moves, 5 runs): ratio 0.000052–0.000091,
// subjectMs 0.003–0.005, referenceMs 53.8–61.7.
// Regression (cache hit deleted, mutation-verified): ratio 0.974,
// subjectMs 60.8, referenceMs 62.4 — the reference stayed put, so it is not
// contaminated. sqrt(0.000091 × 0.974) ≈ 0.0094. The bound leaves ~100x
// headroom over the worst baseline and fails hard the moment the render path
// rescans moves.
assert.ok(
  measured.ratio < 0.0095,
  `cached legend derivation must stay far below a full move scan (ratio ${measured.ratio.toFixed(5)})`,
)
