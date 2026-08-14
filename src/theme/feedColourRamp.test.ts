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
 * Feed-colour ramp contract (issue #498 S4/S5).
 *
 * Load-bearing properties: a move whose feed scale is absent or 1 must render
 * in exactly today's `toolpathCut` colour, and the ramp's ordering must be
 * carried by lightness in both themes (dark goes brighter, light goes darker).
 * Since S5 the ladder is a function of the operation's slot feed — rung k =
 * slot + k·(1−slot)/5 — so the S4-era hardcoded 40% constant is gone, and the
 * rung→step mapping is asserted across slot feeds rather than against a
 * constant. The S4 test passed against the hardcoded version; at a 75% slot
 * feed that version collapsed six rungs into four steps, so the per-rung
 * distinctness assertions below fail against it.
 */

import { THEME_PALETTES, feedColourScales, canvasFeedColour, feedColourStep, threeFeedColour } from './palette'

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
// Exact rung thresholds at 40% plus in-between values: rounding runs toward
// the slower step, and scales below the bottom rung land on the last step.

const BUCKET_CASES_40: Array<[number | undefined, number]> = [
  [undefined, 0],
  [1, 0],
  [1.000001, 0],
  [0.99, 1],
  [0.88, 1],
  [0.77, 2],
  [0.76, 2],
  [0.65, 3],
  [0.53, 4],
  [0.52, 4],
  [0.4, 5],
  [0.3, 5],
  [-1, 5],
]

for (const [scale, expected] of BUCKET_CASES_40) {
  const actual = feedColourStep(scale, 0.4)
  assert(actual === expected, `feedColourStep(${scale}, 0.4) = ${actual}, expected ${expected}`)
}

// Same threshold semantics at a non-40% slot feed, against the derived rungs.
const BUCKET_CASES_75: Array<[number | undefined, number]> = [
  [undefined, 0],
  [1, 0],
  [0.96, 1],
  [0.95, 1],
  [0.925, 2],
  [0.8, 4],
  [0.75, 5],
  [0.7, 5],
]

for (const [scale, expected] of BUCKET_CASES_75) {
  const actual = feedColourStep(scale, 0.75)
  assert(actual === expected, `feedColourStep(${scale}, 0.75) = ${actual}, expected ${expected}`)
}

// --- The ladder is derived from the slot feed -------------------------------
//
// The S4 test pinned a hardcoded `[1, 0.88, 0.76, 0.64, 0.52, 0.4]`, which is
// only correct at a 40% slot feed — a test built on the code's own wrong
// assumption. These assertions pin the derivation itself: at every slot feed
// the six rungs must be slot + k·(1−slot)/5, each must map to its own distinct
// colour step, the top rung must be full feed, and the bottom rung the slot
// scale. A hardcoded 40% ladder fails every one of these at 60% and 75%.

for (const slotPercent of SLOT_PERCENTS) {
  const slotScale = slotPercent / 100
  const scales = feedColourScales(slotScale)

  assert(scales.length === 6, `feedColourScales(${slotScale}) has ${scales.length} rungs, expected 6`)
  assert(scales[0] === 1, `top rung must be full feed at ${slotPercent}%, got ${scales[0]}`)
  assert(
    scales[scales.length - 1] === slotScale,
    `bottom rung must be the slot scale at ${slotPercent}%, got ${scales[scales.length - 1]}`,
  )
  for (let k = 0; k < scales.length; k += 1) {
    const expectedRung = slotScale + (k * (1 - slotScale)) / (scales.length - 1)
    assert(
      Math.abs(scales[scales.length - 1 - k] - expectedRung) < 1e-12,
      `rung ${k} at ${slotPercent}% must be ${expectedRung}, got ${scales[scales.length - 1 - k]}`,
    )
  }

  // Every rung the formula produces maps to its own distinct step. This is
  // the assertion the S4 test could not make: the hardcoded ladder maps 0.95
  // and 0.90 both to step 1, and 0.85 and 0.80 both to step 2, at 75%.
  const steps = scales.map((scale) => feedColourStep(scale, slotScale))
  for (let step = 0; step < steps.length; step += 1) {
    assert(steps[step] === step, `rung ${scales[step]} must map to step ${step} at ${slotPercent}%, got ${steps[step]}`)
  }

  // Absent or full-feed scales render step 0 at every slot feed.
  assert(feedColourStep(undefined, slotScale) === 0, `absent feedScale must map to step 0 at ${slotPercent}%`)
  assert(feedColourStep(1, slotScale) === 0, `feedScale 1 must map to step 0 at ${slotPercent}%`)
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
