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
 *
 * Run with: npx tsx src/engine/toolpaths/crossFaceRelatedFeatures.test.ts
 */

/**
 * A pocket only relates to what its setup's face can reach (issue #1079).
 *
 * Frank's file: "Rect 2 on top and Circle 5 overlap each other when looked
 * from top, however they do not touch each other. the top pocket operation
 * picks up the circle from bottom and messes up that pocket." Circle 5 is a
 * Bottom subtract at Z 0–0.2; the Top pocket floor is Z 1.5. They overlap in
 * plan and nowhere in Z, and the fold followed the circle down through 1.3 of
 * solid stock to the base.
 *
 * Two guards are pinned here, because either one alone would fix that file and
 * only together do they fix the class:
 *
 *  1. **Face** — every related (non-target) subtract a generator reads is
 *     filtered to what the operation's own setup can reach, by the same #946
 *     rule targets follow (drawn on that face, a true through-feature, or an
 *     imported model). `withoutUnreachableSubtracts` is the one gate, applied
 *     in `computeOperationToolpath` before any resolver runs.
 *  2. **Z contiguity** — a same-face subtract must also touch the target in Z,
 *     not merely overlap it in plan. The tolerance is
 *     `NON_TARGET_SUBTRACT_GAP_TOLERANCE` (1e-6 project units: 1 nm in a mm
 *     project, 25.4 nm in an inch one).
 */

import { readFileSync } from 'node:fs'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SetupFace, SketchFeature } from '../../types/project'
import { normalizeProject } from '../../store/projectStore'
import { projectWithFeatures, withBottomSetup } from '../../test/projectFixtures'
import { syncProjectSetups } from '../../store/helpers/setups'
import { withoutUnreachableSubtracts } from '../setupTargets'
import { computeOperationToolpath } from './generateOperation'
import { NON_TARGET_SUBTRACT_GAP_TOLERANCE, resolvePocketRegions } from './resolver'
import type { ResolvedPocketResult, ToolpathMove, ToolpathResult } from './types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; console.log(`   ✓ ${name}`); return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

function approx(left: number, right: number, epsilon = 1e-9): boolean {
  return Math.abs(left - right) <= epsilon
}

const WIDTH = 100
const HEIGHT = 80
const THICKNESS = 20

// ── Fixtures ──────────────────────────────────────────────────

function feature(
  id: string,
  role: SketchFeature['operation'],
  profile: SketchFeature['sketch']['profile'],
  zTop: number,
  zBottom: number,
  authoringFace: SetupFace = 'top',
): SketchFeature {
  return {
    id,
    name: id,
    kind: profile.segments.some((segment) => segment.type === 'circle') ? 'circle' : 'rect',
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: role,
    z_top: zTop,
    z_bottom: zBottom,
    authoringFace,
    visible: true,
    locked: false,
  }
}

function rect(id: string, role: SketchFeature['operation'], x: number, y: number, w: number, h: number, zTop: number, zBottom: number, face: SetupFace = 'top'): SketchFeature {
  return feature(id, role, rectProfile(x, y, w, h), zTop, zBottom, face)
}

function circle(id: string, role: SketchFeature['operation'], x: number, y: number, radius: number, zTop: number, zBottom: number, face: SetupFace = 'top'): SketchFeature {
  return feature(id, role, circleProfile(x, y, radius), zTop, zBottom, face)
}

function operation(id: string, featureIds: string[], kind: Operation['kind'] = 'pocket'): Operation {
  return {
    id,
    name: id,
    kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
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

function baseProject(features: SketchFeature[], op: Operation): Project {
  const base = newProject('cross-face-related', 'mm')
  base.meta = { ...base.meta, created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z' }
  base.stock = { ...base.stock, profile: rectProfile(0, 0, WIDTH, HEIGHT), thickness: THICKNESS }
  base.origin = { name: 'Origin', x: 0, y: HEIGHT, z: THICKNESS, visible: true }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Flat 6', diameter: 6, maxCutDepth: 25 }]
  const project = projectWithFeatures(base, features)
  return syncProjectSetups({ ...project, operations: [op], tabs: [], clamps: [] })
}

function inBottomSetup(project: Project): Project {
  return withBottomSetup(project, { operationIds: project.operations.map((entry) => entry.id) })
}

function generate(project: Project): ToolpathResult {
  const envelope = computeOperationToolpath(project, project.operations[0])
  if (!envelope) throw new Error('FAIL: the operation kind is generated')
  return envelope.result
}

/** Moves that cut: rapids and plunges travel, they do not machine a floor. */
function cutMoves(result: ToolpathResult): ToolpathMove[] {
  return result.moves.filter((move) => move.kind !== 'rapid' && move.kind !== 'plunge')
}

function cutZRange(result: ToolpathResult): { min: number; max: number } {
  const moves = cutMoves(result)
  return {
    min: Math.min(...moves.map((move) => Math.min(move.from.z, move.to.z))),
    max: Math.max(...moves.map((move) => Math.max(move.from.z, move.to.z))),
  }
}

function hasDepthExtension(result: { warnings: Array<{ code: string }> }): boolean {
  return result.warnings.some((warning) => warning.code === 'regionExtendedBySubtractDepth')
}

function deepestBandBottom(result: ResolvedPocketResult): number {
  return Math.min(...result.bands.map((band) => band.bottomZ))
}

// A Top pocket 20 deep to Z 14, and a Bottom pocket 6 deep to Z 6. They
// overlap in plan over x 30..60, y 30..50 and are 8 apart in Z — Frank's shape
// on a block, with the same-face and cross-face cases below built from them.
const topPocket = (): SketchFeature => rect('top-pocket', 'subtract', 20, 20, 60, 40, THICKNESS, 14, 'top')
const bottomPocket = (): SketchFeature => rect('bottom-pocket', 'subtract', 30, 30, 40, 30, 6, 0, 'bottom')

// ── Frank's file ──────────────────────────────────────────────

console.log("1. Frank's Top/Bottom file: each pocket stops at its own floor...")

{
  const project = normalizeProject(
    JSON.parse(readFileSync(new URL('../../../scripts/fixtures-1079/round-stock-top-bottom.camj', import.meta.url), 'utf8')) as Project,
  )
  const topOperation = project.operations.find((entry) => entry.id === 'op0008')
  const bottomOperation = project.operations.find((entry) => entry.id === 'op0019')
  check('fixture: Top pocket found', topOperation !== undefined, 'op0008 is missing')
  check('fixture: Bottom pocket found', bottomOperation !== undefined, 'op0019 is missing')

  const top = computeOperationToolpath(project, topOperation!)!.result
  // Rect 2's Top subtract is the target; its floor is stock Z 1.5. Before
  // #1079 the folded Circle 5 pulled bands to Z 0 and cuts reached 0.05.
  const topCuts = cutZRange(top)
  check('Top pocket cuts no lower than its floor (Z 1.5)', approx(topCuts.min, 1.5),
    `lowest cut is Z ${topCuts.min}, expected the 1.5 floor`)
  check('Top pocket raises no depth extension', !hasDepthExtension(top),
    `unexpected warnings: ${JSON.stringify(top.warnings)}`)

  // Circle 4/5/6 reach stock Z 0 and Circle 7 stock Z 0.36: the Bottom pocket
  // owns everything below its own floor, and nothing above it.
  const bottom = computeOperationToolpath(project, bottomOperation!)!.result
  const bottomCuts = cutZRange(bottom)
  check('Bottom pocket cuts no higher than its own floor (Z 0.36)', bottomCuts.max <= 0.36 + 1e-9,
    `highest cut is Z ${bottomCuts.max}, expected at or below 0.36`)
  check('Bottom pocket raises no depth extension', !hasDepthExtension(bottom),
    `unexpected warnings: ${JSON.stringify(bottom.warnings)}`)

  console.log(`   ✓ Top cuts stay at ${topCuts.min}..${topCuts.max}, Bottom cuts stay at ${bottomCuts.min}..${bottomCuts.max}`)

  // Frank's file, with the one difference that isolates the face rule: raise
  // Circle 5's top to the pocket floor. No Z gap is left for the contiguity
  // test to reject, so only "drawn on the other face" can keep it out — and
  // without that rule the fold follows it down to the base.
  const contiguous: Project = {
    ...project,
    features: project.features.map((entry) => (
      entry.id === 'f0013' ? { ...entry, z_top: 1.5 } : entry
    )),
  }
  const contiguousOperation = contiguous.operations.find((entry) => entry.id === 'op0008')!
  const contiguousTop = computeOperationToolpath(contiguous, contiguousOperation)!.result
  check('Top pocket ignores the bottom circle even when it reaches the floor',
    approx(cutZRange(contiguousTop).min, 1.5),
    `lowest cut is Z ${cutZRange(contiguousTop).min}, expected the 1.5 floor`)
  check('the contiguous bottom circle raises no depth extension', !hasDepthExtension(contiguousTop),
    `unexpected warnings: ${JSON.stringify(contiguousTop.warnings)}`)
}

// ── Overlapping Top/Bottom subtracts ─────────────────────────

console.log('\n2. Overlapping Top and Bottom subtracts with a gap, both orderings, both setups...')

{
  for (const ordering of [['top', 'bottom'], ['bottom', 'top']] as const) {
    for (const setup of ['top', 'bottom'] as const) {
      // The operation targets the feature on its own face; the feature on the
      // other face is unowned, so `subtractsMachinedElsewhere` cannot hide it.
      const rows = ordering[0] === 'top' ? [topPocket(), bottomPocket()] : [bottomPocket(), topPocket()]
      const targetId = setup === 'top' ? 'top-pocket' : 'bottom-pocket'
      let project = baseProject(rows, operation('op1', [targetId]))
      if (setup === 'bottom') project = inBottomSetup(project)
      const result = generate(project)
      const cuts = cutZRange(result)
      const label = `${setup} setup, ${ordering.join(' then ')} features`
      if (setup === 'top') {
        check(`${label}: cuts stop at the 14 floor`, cuts.min >= 14 - 1e-9,
          `lowest cut is Z ${cuts.min}`)
      } else {
        check(`${label}: cuts stop at the 6 floor`, cuts.max <= 6 + 1e-9,
          `highest cut is Z ${cuts.max}`)
      }
      check(`${label}: no depth extension`, !hasDepthExtension(result),
        `unexpected warnings: ${JSON.stringify(result.warnings)}`)
    }
  }

  // Contiguous across the faces: the bottom cavity's top reaches the Top
  // pocket's floor exactly, so the Z contiguity test cannot be why it is
  // ignored. Only the face rule can keep it out of the Top program.
  const contiguousBottom = rect('bottom-pocket-contiguous', 'subtract', 30, 30, 40, 30, 14, 0, 'bottom')
  const contiguousProject = baseProject([topPocket(), contiguousBottom], operation('op1', ['top-pocket']))
  const contiguousResult = generate(contiguousProject)
  check('contiguous other-face subtract is still ignored',
    cutZRange(contiguousResult).min >= 14 - 1e-9,
    `lowest cut is Z ${cutZRange(contiguousResult).min}`)
  check('contiguous other-face subtract raises no depth extension', !hasDepthExtension(contiguousResult),
    `unexpected warnings: ${JSON.stringify(contiguousResult.warnings)}`)
}

// ── Through subtracts ────────────────────────────────────────

console.log('\n3. A true through subtract is reachable from both faces...')

{
  // The hole reaches both stock faces and is drawn on the *other* face, so only
  // the through exception can keep it; the fold must still extend into it.
  for (const setup of ['top', 'bottom'] as const) {
    const target = setup === 'top' ? topPocket() : bottomPocket()
    // Wide enough for the 6 mm cutter to clear it, and inside both pockets.
    const throughHole = circle(
      'through-hole', 'subtract', 40, 40, 8, THICKNESS, 0,
      setup === 'top' ? 'bottom' : 'top',
    )
    let project = baseProject([target, throughHole], operation('op1', [target.id]))
    if (setup === 'bottom') project = inBottomSetup(project)
    const result = generate(project)
    const cuts = cutZRange(result)
    const expected = setup === 'top' ? 0 : THICKNESS
    const reached = setup === 'top' ? cuts.min : cuts.max
    check(`${setup} setup: through subtract folds to stock Z ${expected}`, approx(reached, expected, 1e-6),
      `cut range is ${cuts.min}..${cuts.max}`)
    check(`${setup} setup: the extension is reported`, hasDepthExtension(result),
      `unexpected warnings: ${JSON.stringify(result.warnings)}`)
  }
}

// ── Same-face contiguity ─────────────────────────────────────

console.log('\n4. Same-face subtracts must touch in Z, not only in plan...')

function sameFaceBands(chipZTop: number): ResolvedPocketResult {
  const project = baseProject([
    rect('pocket', 'subtract', 20, 20, 60, 40, THICKNESS, 14),
    rect('chip', 'subtract', 40, 30, 20, 20, chipZTop, 10),
  ], operation('op1', ['pocket']))
  return resolvePocketRegions(project, project.operations[0])
}

{
  // Abutting the pocket floor exactly: one cavity, the pocket follows it down.
  const contiguous = sameFaceBands(14)
  check('contiguous at the floor: bands reach the chip floor', approx(deepestBandBottom(contiguous), 10),
    `deepest band bottom is ${deepestBandBottom(contiguous)}, expected 10`)
  check('contiguous at the floor: the extension is reported', hasDepthExtension(contiguous),
    `unexpected warnings: ${JSON.stringify(contiguous.warnings)}`)

  // The same footprint 2 below the floor: a separate cavity, left alone.
  const gapped = sameFaceBands(12)
  check('a 2 gap: bands stay at the pocket floor', approx(deepestBandBottom(gapped), 14),
    `deepest band bottom is ${deepestBandBottom(gapped)}, expected 14`)
  check('a 2 gap: no extension warning', !hasDepthExtension(gapped),
    `unexpected warnings: ${JSON.stringify(gapped.warnings)}`)

  // The tolerance is exactly `NON_TARGET_SUBTRACT_GAP_TOLERANCE`: a gap below
  // it is the same cavity, a gap above it is not.
  const insideTolerance = sameFaceBands(14 - NON_TARGET_SUBTRACT_GAP_TOLERANCE / 2)
  check('a sub-tolerance gap still folds', approx(deepestBandBottom(insideTolerance), 10),
    `deepest band bottom is ${deepestBandBottom(insideTolerance)}, expected 10`)
  const outsideTolerance = sameFaceBands(14 - NON_TARGET_SUBTRACT_GAP_TOLERANCE * 2)
  check('a gap twice the tolerance does not fold', approx(deepestBandBottom(outsideTolerance), 14),
    `deepest band bottom is ${deepestBandBottom(outsideTolerance)}, expected 14`)

  console.log(`   ✓ contiguous folds to 10, a 2 gap stays at 14, tolerance ${NON_TARGET_SUBTRACT_GAP_TOLERANCE}`)
}

// ── Adds are material on either face ─────────────────────────

console.log('\n5. An add drawn on the other face still protects its material...')

{
  // A full-height island drawn from the Bottom overlaps the Top pocket. It is
  // solid stock the cutter meets from the top, so it stays a keep-out; only
  // subtracts are face-filtered.
  const boss = rect('bottom-boss', 'add', 40, 30, 20, 20, THICKNESS, 0, 'bottom')
  const project = baseProject([topPocket(), boss], operation('op1', ['top-pocket']))
  const filtered = withoutUnreachableSubtracts(project, 'top')
  check('the face gate keeps the other-face add',
    filtered.features.some((entry) => entry.id === 'bottom-boss'),
    'the add was removed')

  const resolved = resolvePocketRegions(project, project.operations[0])
  check('the island is resolved into the pocket band',
    resolved.bands.some((band) => band.islandFeatureIds.includes('bottom-boss')),
    `band islands: ${JSON.stringify(resolved.bands.map((band) => band.islandFeatureIds))}`)
}

// ── The gate itself ──────────────────────────────────────────

console.log('\n6. The face gate: same face, through and models stay; other-face subtracts go...')

{
  const project = baseProject([
    rect('same-face', 'subtract', 10, 10, 10, 10, THICKNESS, 14, 'top'),
    rect('other-face', 'subtract', 30, 10, 10, 10, 6, 0, 'bottom'),
    rect('through', 'subtract', 50, 10, 10, 10, THICKNESS, 0, 'bottom'),
    rect('island', 'add', 70, 10, 10, 10, THICKNESS, 0, 'bottom'),
  ], operation('op1', ['same-face']))
  const ids = withoutUnreachableSubtracts(project, 'top').features.map((entry) => entry.id)
  check('same-face subtract kept', ids.includes('same-face'), ids.join(','))
  check('other-face blind subtract removed', !ids.includes('other-face'), ids.join(','))
  check('through subtract kept', ids.includes('through'), ids.join(','))
  check('add on the other face kept', ids.includes('island'), ids.join(','))

  // Single-face projects are the norm for blocks: the gate must not even copy
  // the project, which is what keeps their output byte-identical.
  const single = baseProject([
    rect('only', 'subtract', 10, 10, 10, 10, THICKNESS, 14),
  ], operation('op1', ['only']))
  check('a single-face project is returned as the same object', withoutUnreachableSubtracts(single, 'top') === single,
    'the gate copied a project it changed nothing in')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
