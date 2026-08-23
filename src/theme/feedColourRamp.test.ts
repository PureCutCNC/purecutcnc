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
 * Feed-colour ramp contract (issue #498 S4/S5; ladder reshaped by issue #591).
 *
 * Load-bearing properties: a move whose feed scale is absent or 1 must render
 * in exactly today's `toolpathCut` colour, and the ramp's ordering must be
 * carried by lightness in both themes (dark goes brighter, light goes darker).
 * Since S5 the ladder is a function of the operation's slot feed; since #591
 * the rungs ARE the engine's non-uniform ladder, consumed via
 * `engagementFeedRungs` rather than re-derived here — so the ramp cannot
 * drift from what the generator emits, and these assertions check the mapping
 * semantics (own step per rung, slower rounding between rungs, bottom-clamp)
 * across slot feeds instead of any hardcoded ladder shape.
 */

import { THEME_PALETTES, feedColourScales, canvasFeedColour, feedColourStep, threeFeedColour } from './palette'
import { engagementFeedRungs } from '../engine/toolpaths/engagement'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** HSL lightness (0..1) from 0..255 channels — the canonical "lightness" ordering. */
function hslLightness(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  return (max + min) / 2
}

function channelsOfRgba(color: string): { r: number; g: number; b: number } {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color)
  if (!match) throw new Error(`Expected rgba() colour, got: ${color}`)
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
}

function channelsOfHex(color: number): { r: number; g: number; b: number } {
  return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff }
}

// The slot feeds the ladder must be falsifiable across (issue #498 S5).
const SLOT_PERCENTS = [40, 60, 75] as const

// --- Feed-scale bucket mapping ---------------------------------------------
//
// Semantics under test: absent or >= 1 maps to step 0, scales below the
// bottom rung clamp to the last step, every rung maps to its own distinct
// step, and a value between two rungs rounds toward the slower one. The
// table below is a deliberate independent oracle: it pins actual rung values
// at a 40% slot feed (ladder 1 / .97 / .94 / .88 / .76 / .64 / .52 / .4), so
// swapping FEED_RUNG_DROP_FRACTIONS for any other table fails here even
// though every derived assertion below would still agree with itself.

const BUCKET_CASES_40: Array<[number | undefined, number]> = [
  [undefined, 0],
  [1, 0],
  [1.000001, 0],
  [0.99, 1],
  [0.97, 1],
  [0.96, 2],
  [0.88, 3],
  [0.87, 4],
  [0.76, 4],
  [0.75, 5],
  [0.64, 5],
  [0.63, 6],
  [0.52, 6],
  [0.51, 7],
  [0.4, 7],
  [0.3, 7],
  [-1, 7],
]

for (const [scale, expected] of BUCKET_CASES_40) {
  const actual = feedColourStep(scale, 0.4)
  assert(actual === expected, `feedColourStep(${scale}, 0.4) = ${actual}, expected ${expected}`)
}

for (const slotPercent of SLOT_PERCENTS) {
  const slotScale = slotPercent / 100
  const rungs = feedColourScales(slotScale)
  const last = rungs.length - 1

  assert(feedColourStep(undefined, slotScale) === 0, `absent feedScale must map to step 0 at ${slotPercent}%`)
  assert(feedColourStep(1, slotScale) === 0, `feedScale 1 must map to step 0 at ${slotPercent}%`)
  assert(feedColourStep(1.000001, slotScale) === 0, `feedScale above 1 must map to step 0 at ${slotPercent}%`)
  assert(
    feedColourStep(slotScale - 0.1, slotScale) === last && feedColourStep(-1, slotScale) === last,
    `scales below the bottom rung must clamp to the last step at ${slotPercent}%`,
  )
  for (let i = 0; i < rungs.length; i += 1) {
    // The top rung is full feed and maps to step 0 by the contract above;
    // every reduced rung owns one distinct slower step.
    if (i > 0) {
      assert(
        feedColourStep(rungs[i], slotScale) === i,
        `rung ${rungs[i]} must map to its own step ${i} at ${slotPercent}%, got ${feedColourStep(rungs[i], slotScale)}`,
      )
      const between = (rungs[i] + rungs[i - 1]) / 2
      assert(
        feedColourStep(between, slotScale) === i,
        `between-rung ${between.toFixed(4)} must round to the slower step ${i} at ${slotPercent}%, got ${feedColourStep(between, slotScale)}`,
      )
    }
  }
}

// --- The ladder mirrors the engine ------------------------------------------
//
// The S4 test pinned a hardcoded `[1, 0.88, 0.76, 0.64, 0.52, 0.4]`; the S5
// test pinned the uniform formula. Both were the code's own assumption
// written back as an oracle. What must hold instead: the ramp exposes exactly
// the engine's rung set — full feed on top, the slot scale at the bottom, one
// distinct colour step per rung (#591 made the set non-uniform).

for (const slotPercent of SLOT_PERCENTS) {
  const slotScale = slotPercent / 100
  const scales = feedColourScales(slotScale)
  const engineRungs = engagementFeedRungs(slotScale)

  assert(scales.length === engineRungs.length, `ramp must expose all ${engineRungs.length} engine rungs at ${slotPercent}%, got ${scales.length}`)
  assert(scales.every((value, i) => value === engineRungs[i]), `ramp rungs must equal the engine ladder at ${slotPercent}%`)
  assert(scales[0] === 1, `top rung must be full feed at ${slotPercent}%, got ${scales[0]}`)
  assert(
    scales[scales.length - 1] === slotScale,
    `bottom rung must be the slot scale at ${slotPercent}%, got ${scales[scales.length - 1]}`,
  )

  // Every rung maps to its own distinct step — the property the S4-era
  // hardcoded ladder could not hold at 75%.
  const steps = scales.map((scale) => feedColourStep(scale, slotScale))
  for (let step = 0; step < steps.length; step += 1) {
    assert(steps[step] === step, `rung ${scales[step]} must map to step ${step} at ${slotPercent}%, got ${steps[step]}`)
  }
}

// --- Step 0 is toolpathCut, last step is toolpathCutSlow, both reps ---------

for (const theme of ['dark', 'light'] as const) {
  const palette = THEME_PALETTES[theme]

  for (const slotPercent of SLOT_PERCENTS) {
    const scales = feedColourScales(slotPercent / 100)
    const last = scales.length - 1

    assert(
      canvasFeedColour(0, palette.canvas) === palette.canvas.toolpathCut,
      `canvas step 0 must be exactly toolpathCut in ${theme}`,
    )
    assert(
      canvasFeedColour(last, palette.canvas) === palette.canvas.toolpathCutSlow,
      `canvas last step must be exactly toolpathCutSlow in ${theme} at ${slotPercent}%`,
    )
    assert(
      threeFeedColour(0, palette.three) === palette.three.toolpathCut,
      `three step 0 must be exactly toolpathCut in ${theme}`,
    )
    assert(
      threeFeedColour(last, palette.three) === palette.three.toolpathCutSlow,
      `three last step must be exactly toolpathCutSlow in ${theme} at ${slotPercent}%`,
    )

    // --- Ordering carried by lightness, per theme and per representation -------

    const canvasLightness = scales.map((_, step) => {
      const { r, g, b } = channelsOfRgba(canvasFeedColour(step, palette.canvas))
      return hslLightness(r, g, b)
    })
    const threeLightness = scales.map((_, step) => {
      const { r, g, b } = channelsOfHex(threeFeedColour(step, palette.three))
      return hslLightness(r, g, b)
    })

    for (const [label, lightness] of [['canvas', canvasLightness], ['three', threeLightness]] as const) {
      for (let step = 1; step < lightness.length; step += 1) {
        if (theme === 'dark') {
          assert(
            lightness[step] > lightness[step - 1],
            `dark ${label} ramp must strictly brighten: step ${step - 1} (${lightness[step - 1].toFixed(4)}) -> step ${step} (${lightness[step].toFixed(4)})`,
          )
        } else {
          assert(
            lightness[step] < lightness[step - 1],
            `light ${label} ramp must strictly darken: step ${step - 1} (${lightness[step - 1].toFixed(4)}) -> step ${step} (${lightness[step].toFixed(4)})`,
          )
        }
      }
    }

    // The two representations must describe the same ramp per theme.
    for (let step = 0; step < scales.length; step += 1) {
      const canvas = channelsOfRgba(canvasFeedColour(step, palette.canvas))
      const three = channelsOfHex(threeFeedColour(step, palette.three))
      assert(
        canvas.r === three.r && canvas.g === three.g && canvas.b === three.b,
        `canvas and three ramp steps differ at step ${step} in ${theme}`,
      )
    }
  }
}
