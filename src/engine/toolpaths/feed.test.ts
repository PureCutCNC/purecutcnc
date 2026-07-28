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

import { effectiveFeed } from './feed'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    console.error(`FAIL: ${message}`)
  }
}

function approx(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) < epsilon
}

// ── Cut moves: feedScale absent (= 1×) ──

console.log('Testing cut move without feedScale returns cutFeed...')
assert(
  approx(effectiveFeed('cut', undefined, 600, 200), 600),
  'cut × no feedScale should return cutFeed',
)

// ── Cut moves: feedScale present ──

console.log('Testing cut move with feedScale 0.5 returns scaled feed...')
assert(
  approx(effectiveFeed('cut', 0.5, 600, 200), 300),
  'cut × 0.5 feedScale should return 300',
)

console.log('Testing cut move with feedScale 0 returns zero...')
assert(
  approx(effectiveFeed('cut', 0, 600, 200), 0),
  'cut × 0 feedScale should return 0',
)

// ── Lead-in / lead-out: same as cut ──

console.log('Testing lead_in with feedScale...')
assert(
  approx(effectiveFeed('lead_in', 0.25, 400, 150), 100),
  'lead_in × 0.25 feedScale should return 100',
)

console.log('Testing lead_out without feedScale...')
assert(
  approx(effectiveFeed('lead_out', undefined, 400, 150), 400),
  'lead_out × no feedScale should return cutFeed',
)

// ── Plunge: feedScale is always ignored ──

console.log('Testing plunge ignores feedScale...')
assert(
  approx(effectiveFeed('plunge', 0.5, 600, 200), 200),
  'plunge should return plungeFeed, ignoring feedScale',
)

console.log('Testing plunge with undefined feedScale...')
assert(
  approx(effectiveFeed('plunge', undefined, 600, 200), 200),
  'plunge without feedScale should still return plungeFeed',
)

console.log('Testing plunge with feedScale 0...')
assert(
  approx(effectiveFeed('plunge', 0, 600, 200), 200),
  'plunge × 0 feedScale should still return plungeFeed',
)

// ── Rapid: excluded at the type level, not by convention ──
//
// `effectiveFeed` accepts `FedMoveKind`, which is `ToolpathMoveKind` minus
// 'rapid'. A rapid is a positioning move with no feed; before this was
// enforced, passing one fell through to the cut branch and returned a real
// cutting feed. There is deliberately no runtime case here — the guarantee is
// a compile error, and the line below documents it:
//
//   effectiveFeed('rapid', undefined, 600, 200)
//   //            ^^^^^^^ Argument of type '"rapid"' is not assignable to
//   //                    parameter of type 'FedMoveKind'.
//
// Callers (postprocessor, booklet report, playback, viewport readout) all
// branch on rapid before reaching this helper.

// ── Edge: zero or negative cut/plunge feeds ──

console.log('Testing zero cutFeed...')
assert(
  approx(effectiveFeed('cut', 0.5, 0, 200), 0),
  'cut × 0.5 feedScale × 0 cutFeed should return 0',
)

console.log('Testing negative plungeFeed (invalid input, but defined)...')
assert(
  approx(effectiveFeed('plunge', undefined, 600, -1), -1),
  'plunge with negative plungeFeed should return negative plungeFeed',
)

// ── Summary ──

console.log(`\nfeed.ts tests: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) process.exitCode = 1