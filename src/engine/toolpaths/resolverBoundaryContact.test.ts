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
 * A subtract sharing the target's boundary qualifies for the fold (#751 §2).
 *
 * Discovery asked `pathsIntersect`, and the intersection of two polygons sharing
 * only an edge has zero area — so a subtract sitting exactly against the pocket
 * wall read as unrelated and was dropped silently.
 *
 * Connectivity is now decided by the union itself, which is deliberately the
 * **same** operation the sketch's Join command uses (`mergeSelectedFeatures` →
 * `unionClipperPaths`, a bare `ctUnion` at `DEFAULT_CLIPPER_SCALE` with no
 * offset or epsilon). Two shapes this folds are exactly the two shapes Join
 * merges into one feature, so there is no tolerance constant to drift from the
 * one the user draws against — and the cases below pin that equivalence rather
 * than pinning a number.
 *
 * The floor is therefore the clipper grid, 1/10 000 of a project unit. A gap of
 * one unit reads as apart, which is the answer Join gives too.
 *
 * **Known gap.** `connectedComponentCount` filters to outer contours, and no
 * fixture here exercises that filter: on this clipper-lib a union enclosing a
 * void returns one self-touching contour rather than an outer plus a reversed
 * hole (measured on a C-shape closure and a four-rect ring, both one path of net
 * area), so counting raw paths would score identically. The filter is kept
 * because it is correct under either representation while a raw count is not —
 * see `connectedComponentCount`. Mutating it to `paths.length` therefore does
 * **not** redden this suite; that is expected, not an oversight.
 */

import { newProject, rectProfile } from '../../types/project'
import type { Operation, SketchFeature } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { resolvePocketRegions } from './resolver'
import type { ResolvedPocketResult } from './types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; console.log(`   ✓ ${name}`); return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

function feature(
  id: string,
  operation: SketchFeature['operation'],
  x: number,
  y: number,
  w: number,
  h: number,
  zBottom: number,
  zTop = 20,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

const operation: Operation = {
  id: 'op1',
  name: 'Pocket',
  kind: 'pocket',
  pass: 'rough',
  enabled: true,
  showToolpath: true,
  debugToolpath: false,
  target: { source: 'features', featureIds: ['pocket'] },
  toolRef: null,
  stepdown: 2,
  stepover: 0.5,
  feed: 100,
  plungeFeed: 50,
  rpm: 10000,
  pocketPattern: 'offset',
  pocketAngle: 0,
  stockToLeaveRadial: 0,
  stockToLeaveAxial: 0,
  finishWalls: false,
  finishFloor: false,
  carveDepth: 0,
  maxCarveDepth: 0,
}

// mm explicitly: the inch default's 4 x 3 x 0.75 stock would clip this away.
function resolve(features: SketchFeature[]): ResolvedPocketResult {
  const base = projectWithFeatures(
    newProject('boundary-contact', 'mm'),
    features.map((row) => ({ ...row, definitionId: row.id })),
  )
  return resolvePocketRegions({ ...base, operations: [operation] }, operation)
}

function area(result: ResolvedPocketResult): number {
  let total = 0
  for (const band of result.bands) {
    for (const region of band.regions) {
      const ring = (points: { x: number, y: number }[]) => {
        let sum = 0
        for (let index = 0; index < points.length; index += 1) {
          const a = points[index]
          const b = points[(index + 1) % points.length]
          sum += a.x * b.y - b.x * a.y
        }
        return Math.abs(sum) / 2
      }
      total += ring(region.outer) - region.islands.reduce((h, island) => h + ring(island), 0)
    }
  }
  return total
}

// body x 10..90, pocket target x 20..80 y 20..60 — a 60 x 40 = 2400 mm² region.
const body = () => feature('body', 'add', 10, 10, 80, 60, 0)
const pocket = () => feature('pocket', 'subtract', 20, 20, 60, 40, 14)

const BARE = 2400
/** Each probe is 10 x 10 = 100 mm² of body material outside the pocket. */
const BITE = 100

console.log('\nBoundary contact qualifies a subtract for the fold')

// ── 1. Exact shared wall: the case that was silently dropped ────────
{
  // x 80..90 — its left edge IS the pocket's right wall at x = 80.
  const touching = feature('touching', 'subtract', 80, 30, 10, 10, 14)
  check(
    'a subtract sharing the target wall exactly is folded',
    Math.abs(area(resolve([body(), pocket(), touching])) - (BARE + BITE)) < 1e-6,
    `expected ${BARE + BITE}, got ${area(resolve([body(), pocket(), touching]))} — boundary contact still dropped`,
  )
}

// ── 2. Overlap keeps working ────────────────────────────────────────
{
  // x 70..90: 10 wide inside the pocket (already void) and 10 outside.
  const straddling = feature('straddling', 'subtract', 70, 30, 20, 10, 14)
  check(
    'an overlapping subtract is still folded',
    Math.abs(area(resolve([body(), pocket(), straddling])) - (BARE + BITE)) < 1e-6,
    `expected ${BARE + BITE}, got ${area(resolve([body(), pocket(), straddling]))}`,
  )
}

// ── 3. A gap is a gap — no tolerance is being applied ───────────────
{
  // One clipper unit at DEFAULT_CLIPPER_SCALE 10 000 is 0.0001 mm. This is ten
  // of them, and must read as apart — the answer sketch Join gives too.
  const apart = feature('apart', 'subtract', 80.001, 30, 10, 10, 14)
  check(
    'a 0.001 gap is not contact — no epsilon crept in',
    Math.abs(area(resolve([body(), pocket(), apart])) - BARE) < 1e-6,
    `expected ${BARE}, got ${area(resolve([body(), pocket(), apart]))} — something is dilating the test`,
  )
}

// ── 4. Corner-only contact shares no wall, so it must not fold ──────
{
  // Meets the pocket at the single point (80, 60). Folding through a zero-width
  // join would extend the region across geometry with no shared wall at all.
  const corner = feature('corner', 'subtract', 80, 60, 10, 10, 14)
  check(
    'contact at a single corner point does not fold',
    Math.abs(area(resolve([body(), pocket(), corner])) - BARE) < 1e-6,
    `expected ${BARE}, got ${area(resolve([body(), pocket(), corner]))} — a point contact is not a shared boundary`,
  )
}

// ── 5. Control: a distant subtract is untouched ─────────────────────
{
  const far = feature('far', 'subtract', 85, 30, 5, 10, 14)
  check(
    'control - a subtract clear of the target is not folded',
    Math.abs(area(resolve([body(), pocket(), far])) - BARE) < 1e-6,
    `expected ${BARE}, got ${area(resolve([body(), pocket(), far]))}`,
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
