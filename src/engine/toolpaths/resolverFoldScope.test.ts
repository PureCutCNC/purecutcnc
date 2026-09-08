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
 * Which operations fold non-target subtracts, and which subtracts qualify
 * (issue #739).
 *
 * #526 made both band resolvers fold non-target subtracts into the void they
 * resolve, so a clearing pass would stop machining around material the solid
 * model says is gone. Two limits on that were missing, and together they put
 * toolpath on the shipped `purecutcnc.camj` example that should not be there:
 *
 *  1. The fold does not merely clip the target, it **widens** the region by the
 *     subtract's outline. For a kind that carves along boundaries rather than
 *     clearing area, that is new carving the user never selected — a V-carve on
 *     text inside a pocket folded in the pocket and carved its wall.
 *  2. A subtract that another operation machines is cut by that operation, in
 *     program order. Folding it here makes this pass act on a void that does not
 *     exist yet — the pocket finish ran contours around the counters of glyphs
 *     the V-carves had not carved.
 *
 * `resolverNonTargetSubtract.test.ts` owns #526's own behaviour and is
 * deliberately untouched; this file owns the two limits.
 */

import { newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SketchFeature } from '../../types/project'
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

function makeOperation(id: string, kind: Operation['kind'], featureIds: string[]): Operation {
  return {
    id,
    name: id,
    kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
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
}

function makeProject(features: SketchFeature[], operations: Operation[]): Project {
  // mm explicitly: the inch default's 4 x 3 x 0.75 stock would clip this away.
  const base = projectWithFeatures(newProject('fold-scope', 'mm'), features.map((row) => ({
    ...row,
    definitionId: row.id,
  })))
  return { ...base, operations }
}

/** Total resolved void area across every band — the thing the fold widens. */
function resolvedArea(result: ResolvedPocketResult): number {
  let total = 0
  for (const band of result.bands) {
    for (const region of band.regions) {
      const points = region.outer
      let sum = 0
      for (let index = 0; index < points.length; index += 1) {
        const a = points[index]
        const b = points[(index + 1) % points.length]
        sum += a.x * b.y - b.x * a.y
      }
      total += Math.abs(sum) / 2
    }
  }
  return total
}

const body = (): SketchFeature => feature('body', 'add', 10, 10, 80, 60, 0)
/** The operation's own target: x 20..80, y 20..60, floor at Z 14. */
const pocket = (): SketchFeature => feature('pocket', 'subtract', 20, 20, 60, 40, 14)
/** A second subtract inside the pocket, carved deeper — a glyph, in effect. */
const glyph = (): SketchFeature => feature('glyph', 'subtract', 30, 30, 10, 10, 8)

console.log('\nFold scope: which subtracts, and for which kinds')

// ── 1. #526 preserved: a subtract nothing machines still folds ──────
const unmachined = resolvePocketRegions(
  makeProject([body(), pocket(), glyph()], [makeOperation('op1', 'pocket', ['pocket'])]),
  makeOperation('op1', 'pocket', ['pocket']),
)
const withoutGlyph = resolvePocketRegions(
  makeProject([body(), pocket()], [makeOperation('op1', 'pocket', ['pocket'])]),
  makeOperation('op1', 'pocket', ['pocket']),
)
check(
  'a subtract no operation machines is still folded (#526 intact)',
  Math.abs(resolvedArea(unmachined) - resolvedArea(withoutGlyph)) > 1e-6,
  'the deeper unmachined subtract did not change the resolved region — #526 has been reverted',
)

// ── 2. #739: a subtract another operation machines is not folded ────
const machinedElsewhere = resolvePocketRegions(
  makeProject([body(), pocket(), glyph()], [
    makeOperation('op1', 'pocket', ['pocket']),
    makeOperation('op2', 'v_carve', ['glyph']),
  ]),
  makeOperation('op1', 'pocket', ['pocket']),
)
check(
  'a subtract another operation machines is not folded',
  Math.abs(resolvedArea(machinedElsewhere) - resolvedArea(withoutGlyph)) < 1e-6,
  'the pocket still folded a glyph the V-carve will cut, so it acts on a void that does not exist yet',
)

// ── 3. A disabled operation does not protect its target ─────────────
const disabledOwner = makeOperation('op2', 'v_carve', ['glyph'])
const withDisabled = resolvePocketRegions(
  makeProject([body(), pocket(), glyph()], [
    makeOperation('op1', 'pocket', ['pocket']),
    { ...disabledOwner, enabled: false },
  ]),
  makeOperation('op1', 'pocket', ['pocket']),
)
check(
  'a disabled operation does not keep its target out of the fold',
  Math.abs(resolvedArea(withDisabled) - resolvedArea(unmachined)) < 1e-6,
  'a disabled operation will not cut anything, so its target is unmachined and must fold',
)

// ── 4. #739: boundary-carving kinds do not fold at all ──────────────
const vcarveWithPocket = resolvePocketRegions(
  makeProject([body(), pocket(), glyph()], [makeOperation('op1', 'v_carve', ['glyph'])]),
  makeOperation('op1', 'v_carve', ['glyph']),
)
const vcarveAlone = resolvePocketRegions(
  makeProject([body(), glyph()], [makeOperation('op1', 'v_carve', ['glyph'])]),
  makeOperation('op1', 'v_carve', ['glyph']),
)
check(
  'a V-carve does not widen its region by an overlapping pocket',
  Math.abs(resolvedArea(vcarveWithPocket) - resolvedArea(vcarveAlone)) < 1e-6,
  'the V-carve folded the surrounding pocket and would carve its wall',
)

const medialWithPocket = resolvePocketRegions(
  makeProject([body(), pocket(), glyph()], [makeOperation('op1', 'v_carve_medial', ['glyph'])]),
  makeOperation('op1', 'v_carve_medial', ['glyph']),
)
check(
  'a medial V-carve does not widen its region either',
  Math.abs(resolvedArea(medialWithPocket) - resolvedArea(vcarveAlone)) < 1e-6,
  'the medial V-carve folded the surrounding pocket',
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
