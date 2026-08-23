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

import type { ToolpathMove, ToolpathResult } from '../engine/toolpaths/types'
import { feedColourStep } from '../theme/palette'

export interface ToolpathVisibility {
  cuts: boolean
  leadIns: boolean
  rapids: boolean
  plunges: boolean
  retractions: boolean
  directions: boolean
  /**
   * Colour cut moves by emitted feed scale (issue #498). Optional on purpose:
   * `undefined` defers to the renderer default — on when the selected
   * operation's toolpath carries engagement telemetry, off otherwise — so
   * legacy projects and non-pockets stay pixel-identical. An explicit value
   * overrides the default for every toolpath.
   */
  feedColours?: boolean
}

/** True when the operation emitted engagement telemetry — the marker that its
 *  pocketFeedReduction is 'engagement' (issue #498). Shared by both
 *  renderers and by the toggle's per-selection default, so the two views
 *  cannot disagree about when feed colours are on. */
export function toolpathHasEngagementTelemetry(toolpath: ToolpathResult): boolean {
  return 'engagementTelemetry' in toolpath && toolpath.engagementTelemetry !== undefined
}

export const DEFAULT_TOOLPATH_VISIBILITY: ToolpathVisibility = {
  cuts: true,
  leadIns: true,
  rapids: true,
  plunges: true,
  retractions: true,
  directions: true,
}

export const ALL_TOOLPATH_HIDDEN: ToolpathVisibility = {
  cuts: false,
  leadIns: false,
  rapids: false,
  plunges: false,
  retractions: false,
  directions: false,
}

// ── Feed-colour legend steps (issue #535) ────────────────────────────
//
// The legend must show only the feed scales the visible toolpaths actually
// emit — the scales the canvas really paints — not a theoretical ladder
// derived from the selected operation. The renderers already classify every
// cut move through `feedColourStep`; these helpers collect that same
// classification once per ToolpathResult and cache it, so the legend render
// path never scans moves. A full scan here would run on every store update
// (selection, hover, visibility) inside SketchCanvas, and large projects
// carry tens of thousands of moves.

/** One legend rung: a feed scale and the ramp step the renderers paint it at. */
export interface FeedColourLegendStep {
  /** Fraction of full feed this rung represents (1 = full feed). */
  scale: number
  /** Ramp step index (0 = `toolpathCut`, last = `toolpathCutSlow`) — the same
   *  value `feedColourStep` returns for this scale under the toolpath's slot
   *  feed, so the legend swatch always matches the painted colour. */
  step: number
}

/**
 * One O(moves) scan: the distinct (scale, step) pairs the cut layer paints
 * for a toolpath when feed colours are on. A move without a `feedScale` runs
 * at full feed, so it contributes scale 1 / step 0 exactly like an explicit
 * 1. Non-cut moves never contribute. Exported for the performance test's
 * invariant reference — callers should go through `feedColourLegendSteps`.
 */
export function scanFeedColourLegendSteps(
  moves: readonly ToolpathMove[],
  slotScale: number,
): FeedColourLegendStep[] {
  const seen = new Map<string, FeedColourLegendStep>()
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    const scale = move.feedScale ?? 1
    const step = feedColourStep(scale, slotScale)
    const key = `${scale}:${step}`
    if (!seen.has(key)) {
      seen.set(key, { scale, step })
    }
  }
  return [...seen.values()]
}

interface CachedLegendSteps {
  slotScale: number
  steps: readonly FeedColourLegendStep[]
}

/**
 * The legend steps for one toolpath, scanned once per toolpath object (and
 * per slot scale — the same scale can land on a different ramp step under a
 * different slot feed). `ToolpathResult` objects come out of
 * `useToolpathGeneration`'s memoized cache, so they are referentially stable
 * between regens: hits cost a WeakMap lookup, misses cost one scan per regen.
 */
const legendStepsCache = new WeakMap<ToolpathResult, CachedLegendSteps>()

export function feedColourLegendSteps(
  toolpath: ToolpathResult,
  slotScale: number,
): readonly FeedColourLegendStep[] {
  const cached = legendStepsCache.get(toolpath)
  if (cached !== undefined && cached.slotScale === slotScale) {
    return cached.steps
  }
  const steps = scanFeedColourLegendSteps(toolpath.moves, slotScale)
  legendStepsCache.set(toolpath, { slotScale, steps })
  return steps
}

/**
 * The union of legend steps across all toolpaths in the preview, sorted by
 * descending scale (full feed first, like the old ladder). Toolpaths with no
 * moves contribute nothing; entries are deduped by (scale, step) so the same
 * scale painted at two different ramp steps by two different operations keeps
 * both entries. Independent of selection — the preview draws every toolpath,
 * so the legend describes every toolpath.
 */
export function unionFeedColourLegendSteps(
  toolpaths: readonly ToolpathResult[],
  slotScaleOf: (operationId: string) => number,
): FeedColourLegendStep[] {
  const byKey = new Map<string, FeedColourLegendStep>()
  for (const toolpath of toolpaths) {
    if (toolpath.moves.length === 0) continue
    for (const step of feedColourLegendSteps(toolpath, slotScaleOf(toolpath.operationId))) {
      const key = `${step.scale}:${step.step}`
      if (!byKey.has(key)) {
        byKey.set(key, step)
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.scale - a.scale || a.step - b.step)
}

/**
 * Legend labels for the given legend scales, full-feed first. Whole percents,
 * escalating decimal places until every distinct scale reads distinctly — on
 * the non-uniform ladder (#591) the fine top rungs collide at high slot feeds
 * (slot 90 % yields two "100 %" entries at whole percents, slot 99 % still
 * collides at one decimal), and a single-shot fallback cannot cover the whole
 * 1–99 % range. Scales repeated across operations' union (the same scale
 * carried at two ramp steps) are supposed to read identically, so
 * distinctness counts distinct scales, not entries.
 */
export function feedLegendStepLabels(scales: ReadonlyArray<number>): string[] {
  const distinct = new Set(scales).size
  for (let decimals = 0; decimals <= 3; decimals += 1) {
    const labels = scales.map((scale) => `${Number((scale * 100).toFixed(decimals))}%`)
    if (new Set(labels).size === distinct) return labels
  }
  return scales.map((scale) => `${Number((scale * 100).toFixed(3))}%`)
}
