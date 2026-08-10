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
 * Unit tests for the smooth-tab Z profile (issue #414).
 * Run with: npx tsx src/engine/toolpaths/tabProfile.test.ts
 */

import {
  clampCrossingFraction,
  smoothTabHeightFraction,
  smoothTabSampleCount,
  smoothTabSampleFractions,
  smoothTabZAt,
} from './tabProfile'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertClose(actual: number, expected: number, tolerance: number, message: string) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`Assertion failed: ${message} (expected ${expected}, got ${actual})`)
  }
}

// ── Exact endpoint and peak values ───────────────────────────────────
// These are the invariants that made the raised cosine preferable to the
// Gaussian: not "close to", exactly.

function testExactEndpointsAndPeak() {
  assert(smoothTabHeightFraction(0) === 0, 'entry height is exactly 0')
  assert(smoothTabHeightFraction(1) === 0, 'exit height is exactly 0')
  assert(smoothTabHeightFraction(0.5) === 1, 'centre height is exactly 1')

  // And in absolute Z: base at both boundaries, requested top at the centre.
  assert(smoothTabZAt(0, -5, 3) === -5, 'entry Z is exactly the cut Z')
  assert(smoothTabZAt(1, -5, 3) === -5, 'exit Z is exactly the cut Z')
  assert(smoothTabZAt(0.5, -5, 3) === 3, 'centre Z is exactly z_top')
}

// ── Zero-slope joins ─────────────────────────────────────────────────
// The derivative vanishes at both boundaries and at the peak, so Z velocity
// ramps from and to zero and the top of the tab is not a corner.

function testZeroSlopeJoins() {
  const h = 1e-6
  const slopeAt = (u: number) => (smoothTabHeightFraction(u + h) - smoothTabHeightFraction(u - h)) / (2 * h)

  assertClose(slopeAt(h), 0, 1e-4, 'slope at the entry is zero')
  assertClose(slopeAt(1 - h), 0, 1e-4, 'slope at the exit is zero')
  assertClose(slopeAt(0.5), 0, 1e-4, 'slope at the peak is zero')

  // Mid-ramp the slope is decidedly non-zero — the profile really does ramp,
  // it is not a flat function that trivially satisfies the joins above.
  assert(slopeAt(0.25) > 1, 'the rising quarter actually rises')
  assert(slopeAt(0.75) < -1, 'the falling quarter actually falls')
}

// ── Monotonic, bounded ───────────────────────────────────────────────

function testMonotonicAndBounded() {
  const steps = 2000
  let previous = smoothTabHeightFraction(0)
  for (let index = 1; index <= steps / 2; index += 1) {
    const value = smoothTabHeightFraction(index / steps)
    assert(value >= previous - 1e-12, `rising half is monotonic at ${index / steps}`)
    previous = value
  }

  previous = smoothTabHeightFraction(0.5)
  for (let index = steps / 2 + 1; index <= steps; index += 1) {
    const value = smoothTabHeightFraction(index / steps)
    assert(value <= previous + 1e-12, `falling half is monotonic at ${index / steps}`)
    previous = value
  }

  for (let index = 0; index <= steps; index += 1) {
    const value = smoothTabHeightFraction(index / steps)
    assert(value >= 0 && value <= 1, `height stays within [0, 1] at ${index / steps}`)
  }
}

// ── Never below the source cut Z ─────────────────────────────────────

function testNeverBelowCutZ() {
  const baseZ = -4.25
  const topZ = -1
  for (let index = 0; index <= 500; index += 1) {
    const z = smoothTabZAt(index / 500, baseZ, topZ)
    assert(z >= baseZ - 1e-12, `Z never dips below the cut Z at u=${index / 500}`)
    assert(z <= topZ + 1e-12, `Z never rises above z_top at u=${index / 500}`)
  }
}

// ── Degenerate / malformed Z ranges ──────────────────────────────────

function testMalformedRanges() {
  // A tab whose top is at or below the cut Z asks for no lift at all. The
  // profile must return the cut Z rather than an inverted ramp that would
  // plunge the tool.
  assert(smoothTabZAt(0.5, -2, -2) === -2, 'zero rise stays at the cut Z')
  assert(smoothTabZAt(0.5, -2, -6) === -2, 'reversed range never descends')
  assert(smoothTabZAt(0.25, -2, -6) === -2, 'reversed range never descends mid-ramp')
}

// ── Truncated crossings ──────────────────────────────────────────────
// A chain that starts or ends inside a footprint cannot have its missing ramp
// half reconstructed. Holding z_top there is what a rectangular tab already
// does, so the fallback is never less conservative than today's behaviour.

function testTruncatedCrossings() {
  // Truncated exit: rises normally, then holds the peak to the end.
  assert(smoothTabZAt(0, -5, 3, false, true) === -5, 'truncated exit still enters at the cut Z')
  assert(smoothTabZAt(0.5, -5, 3, false, true) === 3, 'truncated exit reaches z_top')
  assert(smoothTabZAt(1, -5, 3, false, true) === 3, 'truncated exit holds z_top instead of plunging')

  // Truncated entry: starts held at the peak, then falls away normally.
  assert(smoothTabZAt(0, -5, 3, true, false) === 3, 'truncated entry starts at z_top')
  assert(smoothTabZAt(0.5, -5, 3, true, false) === 3, 'truncated entry holds z_top to the centre')
  assert(smoothTabZAt(1, -5, 3, true, false) === -5, 'truncated entry still exits at the cut Z')

  // Both truncated — the chain lives entirely inside one footprint. This is
  // exactly the rectangular envelope, which is the safe degenerate answer.
  for (let index = 0; index <= 20; index += 1) {
    assert(
      smoothTabZAt(index / 20, -5, 3, true, true) === 3,
      `fully enclosed chain rides z_top at u=${index / 20}`,
    )
  }

  // The clamp itself, stated directly.
  assert(clampCrossingFraction(0.1, true, false) === 0.5, 'truncated entry pins below-centre u to the peak')
  assert(clampCrossingFraction(0.9, false, true) === 0.5, 'truncated exit pins above-centre u to the peak')
  assert(clampCrossingFraction(0.9, true, false) === 0.9, 'truncated entry leaves the falling half alone')
  assert(clampCrossingFraction(0.1, false, true) === 0.1, 'truncated exit leaves the rising half alone')
}

// ── Sample count honours the chord tolerance ─────────────────────────

function testSampleCountMeetsTolerance() {
  const cases: Array<{ rise: number; tolerance: number }> = [
    { rise: 3, tolerance: 0.01 },
    { rise: 0.5, tolerance: 0.01 },
    { rise: 12, tolerance: 0.01 },
    { rise: 3, tolerance: 0.001 },
    { rise: 0.12, tolerance: 0.0004 },
  ]

  for (const { rise, tolerance } of cases) {
    const count = smoothTabSampleCount(rise, tolerance)
    assert(count % 2 === 0, `sample count is even for rise=${rise} tol=${tolerance}`)

    // Measure the real deviation between each chord and the curve it spans,
    // rather than trusting the closed-form bound the implementation used.
    let worst = 0
    for (let index = 0; index < count; index += 1) {
      const u0 = index / count
      const u1 = (index + 1) / count
      const z0 = smoothTabZAt(u0, 0, rise)
      const z1 = smoothTabZAt(u1, 0, rise)
      for (let step = 1; step < 32; step += 1) {
        const t = step / 32
        const u = u0 + (u1 - u0) * t
        const chord = z0 + (z1 - z0) * t
        worst = Math.max(worst, Math.abs(smoothTabZAt(u, 0, rise) - chord))
      }
    }
    assert(
      worst <= tolerance,
      `measured chord error ${worst} exceeds tolerance ${tolerance} for rise=${rise} (n=${count})`,
    )
  }
}

function testSampleCountBounds() {
  // A taller tab or a tighter tolerance needs more samples — the count is
  // genuinely derived, not a constant wearing a formula.
  assert(
    smoothTabSampleCount(12, 0.01) > smoothTabSampleCount(3, 0.01),
    'a taller tab needs more samples',
  )
  assert(
    smoothTabSampleCount(3, 0.001) > smoothTabSampleCount(3, 0.01),
    'a tighter tolerance needs more samples',
  )
  // Degenerate inputs fall back to the floor rather than producing NaN or a
  // runaway loop.
  assert(smoothTabSampleCount(0, 0.01) === 4, 'zero rise falls back to the minimum')
  assert(smoothTabSampleCount(3, 0) === 4, 'zero tolerance falls back to the minimum')
  assert(smoothTabSampleCount(1e9, 1e-9) === 512, 'absurd demands are capped')
}

// ── Sample fractions ─────────────────────────────────────────────────

function testSampleFractions() {
  const fractions = smoothTabSampleFractions(3, 0.01)
  assert(fractions[0] === 0, 'first fraction is exactly 0')
  assert(fractions[fractions.length - 1] === 1, 'last fraction is exactly 1')
  assert(fractions.includes(0.5), 'the exact peak is always sampled')

  for (let index = 1; index < fractions.length; index += 1) {
    assert(fractions[index] > fractions[index - 1], `fractions strictly increase at ${index}`)
  }

  // Sampling is uniform in path distance, so the emitted Z profile depends only
  // on the crossing, never on how the source path happened to be split.
  const spacing = fractions[1] - fractions[0]
  for (let index = 1; index < fractions.length; index += 1) {
    assertClose(fractions[index] - fractions[index - 1], spacing, 1e-12, `uniform spacing at ${index}`)
  }
}

const tests: Array<[string, () => void]> = [
  ['exact endpoints and peak', testExactEndpointsAndPeak],
  ['zero-slope joins', testZeroSlopeJoins],
  ['monotonic and bounded', testMonotonicAndBounded],
  ['never below the cut Z', testNeverBelowCutZ],
  ['malformed Z ranges', testMalformedRanges],
  ['truncated crossings', testTruncatedCrossings],
  ['sample count meets the chord tolerance', testSampleCountMeetsTolerance],
  ['sample count bounds', testSampleCountBounds],
  ['sample fractions', testSampleFractions],
]

let failures = 0
for (const [name, run] of tests) {
  try {
    run()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}: ${(error as Error).message}`)
  }
}

if (failures > 0) {
  console.error(`tabProfile: ${failures} failing test(s)`)
  process.exit(1)
}
console.log('tabProfile: all tests passed')
