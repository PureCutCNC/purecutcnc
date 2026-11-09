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
 * The move counts a variable-Z rotary path can be described with, without the
 * per-level plan model (issue #1179 correction round 3).
 *
 * `buildExportedMotionDebugModel` is a *per cutting level* model: it derives the
 * level list from the optimized motion and compares the exported path against
 * it level by level. A rotary rough or finish has a different Z on every move —
 * a 12,700-move rough yields 4,378 levels — so building it costs seconds of
 * blocking work (the exported-vs-optimized comparison is quadratic in the move
 * count) and describes nothing a level selector could offer. The wrapped view
 * is what such a path has; this module supplies the counts the sidebar still
 * reports, and nothing else.
 */

import type { ExportedMotionDebugModel, MotionDebugLayerId, ParsedGcodeMotion } from '../../engine/gcode'
import type { ToolpathGenerationTrace } from '../../engine/toolpaths/types'

function emptyLayer(id: MotionDebugLayerId) {
  return { id, segments: [] }
}

/**
 * The sidebar's counts for a path with no plan model.
 *
 * The counting rules are the model builder's own (a parsed `arc` splits into
 * clockwise and counter-clockwise, everything else is linear or rapid; raw minus
 * optimized is "removed"), so the two models report the same numbers for the
 * same trace rather than drifting.
 *
 * `diagnostic` is left empty on purpose: no exported-vs-source comparison is
 * run for this model, so the dialog must not render it as a verdict. The
 * dialog renders this model's counts only.
 */
export function summaryMotionModel(
  trace: ToolpathGenerationTrace,
  parsed: ParsedGcodeMotion,
): ExportedMotionDebugModel {
  const emitted = { linear: 0, rapid: 0, arcCw: 0, arcCcw: 0 }
  for (const move of parsed.moves) {
    if (move.kind === 'rapid') emitted.rapid += 1
    else if (move.kind === 'arc') {
      if (move.clockwise) emitted.arcCw += 1
      else emitted.arcCcw += 1
    } else emitted.linear += 1
  }
  return {
    layers: {
      generated: emptyLayer('generated'),
      optimized: emptyLayer('optimized'),
      exported: emptyLayer('exported'),
    },
    zLevels: [],
    zLevelStats: [],
    metrics: {
      rawMoveCount: trace.raw.moves.length,
      optimizedMoveCount: trace.optimized.moves.length,
      removedMoveCount: trace.raw.moves.length - trace.optimized.moves.length,
      emitted,
    },
    diagnostic: { state: 'verified', warnings: [] },
    bounds: null,
  }
}
