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
 * Feed-colour ramp contract (issue #498 S4).
 *
 * Two load-bearing properties: a move whose feed scale is absent or 1 must
 * render in exactly today's `toolpathCut` colour, and the ramp's ordering must
 * be carried by lightness in both themes (dark goes brighter, light goes
 * darker). This test pins the token values to those properties, so a future
 * palette edit that breaks either fails here rather than in the viewport.
 */

import { THEME_PALETTES, FEED_COLOUR_SCALES, canvasFeedColour, feedColourStep, threeFeedColour } from './palette'

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

// --- Feed-scale bucket mapping ---------------------------------------------

const BUCKET_CASES: Array<[number | undefined, number]> = [
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

for (const [scale, expected] of BUCKET_CASES) {
  const actual = feedColourStep(scale)
  assert(actual === expected, `feedColourStep(${scale}) = ${actual}, expected ${expected}`)
}

assert(
  FEED_COLOUR_SCALES.join(',') === '1,0.88,0.76,0.64,0.52,0.4',
  `FEED_COLOUR_SCALES drifted from the engine's bucket set: ${FEED_COLOUR_SCALES.join(',')}`,
)

// --- Step 0 is toolpathCut, last step is toolpathCutSlow, both reps ---------

for (const theme of ['dark', 'light'] as const) {
  const palette = THEME_PALETTES[theme]

  assert(
    canvasFeedColour(0, palette.canvas) === palette.canvas.toolpathCut,
    `canvas step 0 must be exactly toolpathCut in ${theme}`,
  )
  assert(
    canvasFeedColour(FEED_COLOUR_SCALES.length - 1, palette.canvas) === palette.canvas.toolpathCutSlow,
    `canvas last step must be exactly toolpathCutSlow in ${theme}`,
  )
  assert(
    threeFeedColour(0, palette.three) === palette.three.toolpathCut,
    `three step 0 must be exactly toolpathCut in ${theme}`,
  )
  assert(
    threeFeedColour(FEED_COLOUR_SCALES.length - 1, palette.three) === palette.three.toolpathCutSlow,
    `three last step must be exactly toolpathCutSlow in ${theme}`,
  )

  // --- Ordering carried by lightness, per theme and per representation -------

  const canvasLightness = FEED_COLOUR_SCALES.map((_, step) => {
    const { r, g, b } = channelsOfRgba(canvasFeedColour(step, palette.canvas))
    return hslLightness(r, g, b)
  })
  const threeLightness = FEED_COLOUR_SCALES.map((_, step) => {
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
  for (let step = 0; step < FEED_COLOUR_SCALES.length; step += 1) {
    const canvas = channelsOfRgba(canvasFeedColour(step, palette.canvas))
    const three = channelsOfHex(threeFeedColour(step, palette.three))
    assert(
      canvas.r === three.r && canvas.g === three.g && canvas.b === three.b,
      `canvas and three ramp steps differ at step ${step} in ${theme}`,
    )
  }
}
