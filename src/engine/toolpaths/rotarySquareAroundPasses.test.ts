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
 * #1045 slice C: rotary passes **around** the bar on a **square** blank.
 *
 * Slice A refused an around pass on a square blank because a ring follows one
 * radius while a square blank's material changes with the angle. Slice C gives the ring the
 * square rules the along pass already had:
 *
 *  - a rough sample is cut only when its layer radius is below
 *    `squareRotaryTouchRadius` at **that sample's own angle**, so no layer is
 *    spent cutting air above a flat;
 *  - every sample is floored at its own exact retained-stub contact (the C2-F6
 *    floor) and the C2-F7 cutter-centre pull-in keeps the cutter body out of a
 *    stubbed end;
 *  - a rough ring never takes more than `stepdown` out of the material standing
 *    at its angle: a layer is exactly one `stepdown` below the layer above, and
 *    that layer either cut there (one stepdown lower) or skipped the sample
 *    because its standing material was already below its radius;
 *  - an around finish only follows the model (2026-10-22 decision): no clearing
 *    layers and no link to a rough. A raw blank, a disabled rough, a rough
 *    later in the list and an along rough over a retained end all generate the
 *    same finish motion; only the advisory `rotaryFinishWithoutRough` warning
 *    changes. The export check does not re-prove coverage from the program; the
 *    generator's safety is proven by `squareAroundGenerator.property.test.ts`.
 *
 * The export check (`motionPipeline.ts`, #1045 slice K) regenerates an
 * around-mode square operation for the current project and requires the motion
 * being posted to equal it move for move (same kinds, points within a relative
 * 1e-9, same order); anything else is `postSquareAroundToolpathStale`. That is
 * what admits a turning cut below `rotaryTravelZ`, where the turn is the cut: a
 * stale, hand-edited or borrowed toolpath is refused, while a turning **rapid**
 * in any mode and a turn on an along-mode operation keep
 * `postRotarySquareTurnBelowEnvelope`. Block 7 exercises the fresh, stale,
 * hand-edited and borrowed paths, the rapid and along-mode refusals, and a
 * non-rotary operation carrying A.
 *
 * The seeded property block builds its material model independently: the
 * blank's cross-section is sampled from the square's own boundary (never
 * `squareRotaryTouchRadius`), and it keeps a **two-dimensional**
 * along-bin by angle-bin standing map, lowered through the cutter footprint at
 * every sample of every move. The emitted rough is asserted never to cut above
 * that standing material or take more than one `stepdown` out of it at any
 * interior point. Since #1045 slice D the block also walks **every** move --
 * cuts, links, rapids and plunges -- at interior points plus both endpoints
 * against the model's independent safe tip, and requires every non-cut move
 * that turns the stock to stay at or above the travel height.
 *
 * Run with: npx tsx src/engine/toolpaths/rotarySquareAroundPasses.test.ts
 */

import assert from 'node:assert/strict'
import { computeMeshBounds, serializeImportedMesh } from '../importedMesh'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { BarStock, Operation, Project, SquareStock, Tool } from '../../types/project'
import { barCentre, barInscribedRadius, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { projectWithFeatures } from '../../test/projectFixtures'
import { aroundFrame, unwrapToolpath } from '../aroundFrame'
import { foldToolpath } from '../aroundFold'
import { computeOperationToolpath } from './generateOperation'
import { normalizeToolForProject } from './geometry'
import { generateRotaryFinish, generateRotaryRough } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import { squareRotaryStubContactFloor, squareRotaryTouchRadius } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove, ToolpathPoint } from './types'
import { applyMoveToGrid } from '../simulation/replay'
import { createSimulationGrid } from '../simulation/grid'
import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition } from '../gcode/types'
import type { MachineDefinition, PostProcessorResult } from '../gcode/types'

const GRBL = validateMachineDefinition(structuredClone(BUNDLED_DEFINITIONS.find((entry) => entry.id === 'grbl')!))
/** The bundled grbl machine with an own-drive rotary axis about the bar. */
const ROTARY = validateMachineDefinition({
  ...structuredClone(GRBL),
  rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
})

const BALL: NormalizedTool = {
  id: 'ball-3', name: '3 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 3, radius: 1.5, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}
const FLAT: NormalizedTool = { ...BALL, id: 'flat-4', name: '4 mm flat end mill', type: 'flat_endmill', diameter: 4, radius: 2 }

/** A closed surface of revolution around the bar's axis, one ring per entry. */
function revolved(stock: BarStock, rings: readonly { along: number; radius: number }[], segments: number): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const ring of rings) {
    for (let j = 0; j < segments; j++) {
      const t = 2 * Math.PI * j / segments
      const across = centre + ring.radius * Math.cos(t)
      const up = pivot + ring.radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(ring.along, across, up)
      else positions.push(across, ring.along, up)
    }
  }
  for (let s = 0; s + 1 < rings.length; s++) {
    for (let j = 0; j < segments; j++) {
      const j2 = (j + 1) % segments
      const a = s * segments + j
      const b = s * segments + j2
      const c = (s + 1) * segments + j2
      const d = (s + 1) * segments + j
      index.push(a, b, c, a, c, d)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/** A coaxial cylinder surface: a square-to-round model inside the blank. */
function cylinder(stock: BarStock, radius: number, from: number, to: number, segments = 96): RotaryModelMesh {
  return revolved(stock, [{ along: from, radius }, { along: to, radius }], segments)
}

/**
 * A closed box inside the blank, offset from the turning axis: material the
 * tool meets near one angle and misses at others, so a ring is genuinely split
 * rather than a full turn (#1093's A-changing link).
 */
function box(
  stock: BarStock,
  alongFrom: number,
  alongTo: number,
  acrossMin: number,
  acrossMax: number,
  upMin: number,
  upMax: number,
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const across = [acrossMin, acrossMax]
  const up = [upMin, upMax]
  const positions: number[] = []
  for (const along of [alongFrom, alongTo]) {
    for (const u of up) {
      for (const v of across) {
        if (stock.axis === 'x') positions.push(along, centre + v, pivot + u)
        else positions.push(centre + v, along, pivot + u)
      }
    }
  }
  // Vertex order: (along index, up index, across index) flattened.
  const vertex = (alongIndex: number, u: number, v: number): number => alongIndex * 4 + u * 2 + v
  const index = new Uint32Array([
    // alongFrom face
    vertex(0, 0, 0), vertex(0, 0, 1), vertex(0, 1, 1), vertex(0, 0, 0), vertex(0, 1, 1), vertex(0, 1, 0),
    // alongTo face
    vertex(1, 0, 0), vertex(1, 1, 1), vertex(1, 0, 1), vertex(1, 0, 0), vertex(1, 1, 0), vertex(1, 1, 1),
    // across faces
    vertex(0, 0, 0), vertex(1, 0, 0), vertex(1, 1, 0), vertex(0, 0, 0), vertex(1, 1, 0), vertex(0, 1, 0),
    vertex(0, 0, 1), vertex(0, 1, 1), vertex(1, 1, 1), vertex(0, 0, 1), vertex(1, 1, 1), vertex(1, 0, 1),
    // up faces
    vertex(0, 0, 0), vertex(0, 1, 0), vertex(1, 1, 0), vertex(0, 0, 0), vertex(1, 1, 0), vertex(1, 0, 0),
    vertex(0, 0, 1), vertex(1, 0, 1), vertex(1, 1, 1), vertex(0, 0, 1), vertex(1, 1, 1), vertex(0, 1, 1),
  ])
  return { positions: new Float32Array(positions), index }
}

/**
 * A closed box with the cross-section corners in one ring and quad side walls
 * (#1093 review). The vertex-pair `box` above left the across-facing sides
 * invisible to the sampler at A0, which hid the split ring whose last run
 * reaches 360; this winding samples every face at every angle.
 */
function boxPrism(
  stock: BarStock,
  alongFrom: number,
  alongTo: number,
  acrossMin: number,
  acrossMax: number,
  upMin: number,
  upMax: number,
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const crossSection: Array<readonly [number, number]> = [
    [acrossMin, upMin], [acrossMax, upMin], [acrossMax, upMax], [acrossMin, upMax],
  ]
  const positions: number[] = []
  for (const along of [alongFrom, alongTo]) {
    for (const [across, up] of crossSection) positions.push(along, centre + across, pivot + up)
  }
  const n = crossSection.length
  const index: number[] = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    index.push(i, j, n + j, i, n + j, n + i)
  }
  for (let i = 1; i < n - 1; i++) index.push(0, i + 1, i, n, n + i, n + i + 1)
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

const SQUARE = squareStock(20, 40, 'x', { x: 0, y: 0 })
const ROUND_RADIUS = 5
const SQUARE_MODEL = cylinder(SQUARE, ROUND_RADIUS, 12, 28)
const SQUARE_BASE = {
  stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 12, alongEnd: 28,
  safeRadius: 30, requestedCellSize: 0.05,
}
const TRAVEL_TIP = barMaxRadius(SQUARE) + 1

const tipOf = (point: ToolpathPoint): number => point.z - barPivotZ(SQUARE)
const angleOf = (point: ToolpathPoint): number => {
  assert.ok(point.a !== undefined, 'every rotary point carries A')
  return point.a
}
/**
 * A #1093 link leg: a cut at one angle. A ring's own vertical step is also one
 * angle; both are excluded from the ring-shape and touch-gate walks, which are
 * about the layer's turning cuts.
 */
const isConstantAngleCut = (move: ToolpathMove): boolean => move.kind === 'cut'
  && move.from.a !== undefined && move.to.a !== undefined && move.from.a === move.to.a

// ---------------------------------------------------------------------------
// 1. The slice-A refusal is gone: a square blank generates around passes.
// ---------------------------------------------------------------------------

console.log('Testing that a square blank generates around passes...')
{
  const rough = generateRotaryRough('square-rough', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, stepdown: 2, passDirection: 'around',
  }, {})
  assert.deepEqual(rough.warnings, [], 'the square around rough has no warning')
  assert.ok(rough.moves.length > 0, 'the square around rough cuts')
  assert.ok(rough.bounds !== null, 'the square around rough has bounds')
  const finish = generateRotaryFinish('square-finish', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, passDirection: 'around',
  }, {})
  assert.deepEqual(finish.warnings, [], 'the square around finish has no warning')
  assert.ok(finish.moves.length > 0, 'the square around finish cuts')
  // #1103 slice ca-d: A never wraps modulo 360 and never rewinds. Commanded A
  // is non-decreasing over the whole program, and it grows past one turn
  // because every ring continues from the angle the last one reached.
  let previousA = 0
  let maxA = 0
  for (const move of rough.moves) {
    const from = angleOf(move.from)
    const to = angleOf(move.to)
    assert.ok(from >= 0 && maxA <= 360 * rough.moves.length, `rough A ${from} is not wrapped`)
    assert.ok(to >= from - 1e-9, `rough A never rewinds (${from.toFixed(3)} -> ${to.toFixed(3)})`)
    previousA = to
    maxA = Math.max(maxA, to)
  }
  assert.ok(previousA > 360, `the rough turns through more than one revolution (A${previousA.toFixed(1)})`)
  // Every ring is one along coordinate and every one of them turns A forward.
  const rings: Array<{ along: number; direction: number }> = []
  for (const move of rough.moves) {
    if (move.kind !== 'cut' || isConstantAngleCut(move)) continue
    // #1103 slice ca-d: an at-layer link is a cut that turns A **and** moves
    // along the bar (the square blank's seam gap, or a round bar's small
    // drift). It is a transition, not a ring cut, so the ring walk skips it.
    if (move.from.x !== move.to.x) continue
    const along = move.from.x
    const last = rings[rings.length - 1]
    const direction = Math.sign(angleOf(move.to) - angleOf(move.from))
    if (last && last.along === along) {
      if (last.direction === 0 && direction !== 0) last.direction = direction
    } else {
      rings.push({ along, direction })
    }
  }
  assert.ok(rings.length > 2, 'the around rough emits many rings')
  for (let i = 0; i < rings.length; i++) {
    assert.notEqual(rings[i].direction, 0, `ring ${i} turns`)
    assert.equal(rings[i].direction, 1, `ring ${i} turns A forward like its predecessor`)
  }
}

// ---------------------------------------------------------------------------
// 2. The per-sample touch radius: no cut point may stand above the blank's own
//    material at its angle. Without the gate a rough spends its first layers
//    cutting air above each flat -- which is exactly what the mutation that
//    skips the gate does.
// ---------------------------------------------------------------------------

console.log('Testing the square touch-radius gate on every cut point...')
{
  let probedTools = 0
  for (const tool of [FLAT, BALL]) {
    const rough = generateRotaryRough('gate-rough', SQUARE_MODEL, SQUARE, tool, {
      ...SQUARE_BASE, stepdown: 2, passDirection: 'around',
    }, {})
    let checked = 0
    for (const move of rough.moves) {
      // A link leg travels above the material this layer already left; the
      // touch gate is about a layer's own turning cut, not about the link.
      if (move.kind !== 'cut' || isConstantAngleCut(move)) continue
      for (const point of [move.from, move.to]) {
        const tip = tipOf(point)
        // The emitter's links are cuts at the travel height, above the blank;
        // a real layer never reaches the corner envelope.
        if (tip >= TRAVEL_TIP - 1e-9) continue
        const material = squareRotaryTouchRadius(SQUARE, angleOf(point), tool.radius, tool.type)
        // `squareRotaryTouchRadius` is the blank's radius along the sample's own
        // ray; the cutter's footprint also reaches material just off that ray
        // (a corner, or the retained stub one radius away), and since #1045
        // slice F the sampler reads that footprint support plus the conservative
        // cell pad, so a grazing cut can sit above the ray radius by that pad.
        // The gate being tested is the per-sample one that would otherwise emit
        // a whole layer (millimetres) above the material; the pad is a fraction
        // of the requested height-map cell.
        assert.ok(tip <= material + 0.06,
          `${tool.type}: cut at A ${angleOf(point).toFixed(2)} reaches ${tip.toFixed(4)}, above the blank material ${material.toFixed(4)}`)
        checked++
      }
    }
    assert.ok(checked > 100, `${tool.type}: the gate probe checked many cut points (${checked})`)
    probedTools++
  }
  assert.equal(probedTools, 2, 'both supported cutters were probed')
}

// ---------------------------------------------------------------------------
// 3. #1093: a split ring cannot stay down, so it retracts. Only a link that
//    joins a run ending at a ring end to a run starting at a ring start may
//    stay down; anything else keeps the old rapid/plunge, and an A-changing
//    link is never emitted by the new surface path (the link callback requires
//    the same physical angle). On a square blank that is also the corner
//    rule: a turn stays at the travel height.
// ---------------------------------------------------------------------------

console.log('Testing that a split square ring retracts instead of linking low...')
{
  // A small box offset above the axis: angle 0 meets it, most angles miss it,
  // so a ring is split into runs and cannot be linked end to end.
  const model = box(SQUARE, 12, 28, -1, 1, 6, 10)
  const finish = generateRotaryFinish('split-link', model, SQUARE, FLAT, {
    ...SQUARE_BASE, passDirection: 'around',
  }, {})
  // The offset box reaches below the turning centre at some angles, which is
  // the advisory this fixture legitimately carries; no other warning is.
  assert.ok(finish.warnings.every((warning) => warning.code === 'rotaryBelowCentreline'),
    'the split-ring finish carries only the below-centreline advisory')
  const plunges = finish.moves.filter((move) => move.kind === 'plunge').length
  assert.ok(plunges > 1,
    `a split ring retracts and plunges again rather than feeding at the surface (${plunges} plunges)`)
  const pivot = barPivotZ(SQUARE)
  // The A-turning rule is live on the rough and the retract path: a ring split
  // by the touch gate has several runs at one along position, and the emitter
  // joins them with a cut at the blank's corner envelope; a split finish
  // retracts and its travel rapid turns there too. Ring cuts also change A, but
  // they are the cut itself -- the rule is about the *turn*, so only non-cut
  // turning moves are asserted and the travel-height cut links are counted
  // (the dead version filtered constant-angle along links and then asked
  // whether their angle was not A0/A360, which was never true).
  const rough = generateRotaryRough('split-link-rough', model, SQUARE, FLAT, {
    ...SQUARE_BASE, stepdown: 2, passDirection: 'around',
  }, {})
  let turningLinks = 0
  let turningTravelLinks = 0
  for (const move of [...finish.moves, ...rough.moves]) {
    if (move.from.a === undefined || move.to.a === undefined || move.from.a === move.to.a) continue
    const low = Math.min(move.from.z, move.to.z) - pivot
    if (move.kind === 'cut') {
      turningLinks++
      if (low >= TRAVEL_TIP - 1e-9) turningTravelLinks++
      continue
    }
    assert.ok(low >= TRAVEL_TIP - 1e-9,
      `a ${move.kind} turns A at the blank's corner envelope (${low.toFixed(4)})`)
  }
  assert.ok(turningLinks > 0,
    `the split-ring fixtures emit A-changing cut links (${turningLinks})`)
  assert.ok(turningTravelLinks > 0,
    `the A-changing cut link turns at the travel height (${turningTravelLinks})`)
}

// ---------------------------------------------------------------------------
// 3b. #1093 review: a split ring whose **last run reaches 360** must not link to
//     the next (backward) ring. The ring's last run ends at the ring end, so
//     `endedAtEnd` alone is true even though the ring is partial arcs; the
//     contract is that a split ring retracts. A prism crossing the ring at A0
//     and A180 but missing it at 90/270 produces exactly that shape.
// ---------------------------------------------------------------------------

console.log('Testing that a split ring whose last run reaches 360 retracts...')
{
  const model = boxPrism(SQUARE, 12, 28, -2, 2, 4, 8)
  const finish = generateRotaryFinish('split-360', model, SQUARE, FLAT, {
    ...SQUARE_BASE, passDirection: 'around',
  }, {})
  assert.ok(finish.warnings.every((warning) => warning.code === 'rotaryBelowCentreline'),
    'the split-360 finish carries only the below-centreline advisory')
  const linksAtEnd = finish.moves.filter((move) => move.kind === 'cut'
    && move.from.a !== undefined && move.to.a !== undefined
    && move.from.a === move.to.a
    && Math.abs(angleOf(move.from) - 360) < 1e-9
    && move.from.x !== move.to.x)
  assert.equal(linksAtEnd.length, 0,
    `the split ring retracts at 360 instead of linking to the next ring (${linksAtEnd.length} links)`)
  const crossBoundary = finish.moves.filter((move) => move.kind === 'cut'
    && Math.abs(move.from.x - 14) < 1e-9 && Math.abs(move.to.x - 16) < 1e-9)
  assert.equal(crossBoundary.length, 0, 'no surface cut spans the split ring boundary')
  const replunge = finish.moves.filter((move) => move.kind === 'plunge'
    && Math.abs(move.from.x - 16) < 1e-9)
  assert.ok(replunge.length > 0, 'the next ring plunges instead of feeding from the split ring')
}

// ---------------------------------------------------------------------------
// 3c. #1103 slice ca-d: the at-layer links survive forward-only A on a square.
//
//     This was #1093's operation-level link-window budget fixture, where #1117
//     fix 1 and fix 2 were pinned (a spent at-layer budget must not starve the
//     raised plan, and an accepted candidate still has to pay the raised walk).
//     Forward-only rings change the cost that budget was spending: a square
//     blank's corner-arc transition is now the **seam gap** between the last
//     corner arc and the next ring's first one, the touch gate proves that
//     whole sector air at the layer, and `linkAcrossAngle`'s wide-air branch
//     emits it as one straight cut with no sampled model row at all. Only whole
//     rings below the inscribed radius do at-layer work, and their envelopes are
//     cached per angle row and layer, so this fixture no longer exhausts the
//     operation budget: nine plunges in the whole program instead of 288.
//
//     The counts below are re-recorded from that output (ca-d). The budget
//     mechanism itself stays covered by `linkRowBudget`'s unit block and by the
//     exhaustion fixture in `rotarySquareRingLinks.test.ts`.
// ---------------------------------------------------------------------------

console.log('Testing that forward-only rings keep the square blank\'s at-layer links...')
{
  const stock = squareStock(40, 400, 'x', { x: 0, y: 0 })
  const model = revolved(stock, [{ along: 2, radius: 6 }, { along: 398, radius: 14 }], 96)
  const ball4: NormalizedTool = {
    ...BALL, id: 'ball-4', name: '4 mm ball nose', type: 'ball_endmill',
    diameter: 4, radius: 2,
  }
  const result = generateRotaryRough('window-budget', model, stock, ball4, {
    stepover: 1, sampleSpacing: 1, stockToLeave: 0, alongStart: 2, alongEnd: 398,
    safeRadius: barMaxRadius(stock) * 2, requestedCellSize: 0.5, stepdown: 5,
    passDirection: 'around',
  }, {})
  const pivot = barPivotZ(stock)
  const plunges = result.moves.filter((move) => move.kind === 'plunge')
  // One plunge per layer start and one for the layer whose first rings are
  // skipped, not one per refused boundary.
  assert.equal(plunges.length, 9, `the layer starts are the plunges (${plunges.length})`)
  // #1117 (square links): a boundary is linked either by the raised traverse
  // or, where it qualifies, by the at-layer cut that replaces it.
  const linkMove = (move: ToolpathMove): boolean => move.kind === 'rapid'
    && move.from.a !== undefined && move.to.a !== undefined
    && move.from.a === move.to.a && move.from.z === move.to.z
    && move.to.x > move.from.x
    && move.from.z - pivot < barMaxRadius(stock) + 1 - 1e-9
  const atLayerLink = (move: ToolpathMove): boolean => move.kind === 'cut'
    && move.from.a !== undefined && move.from.a === move.to.a && move.to.x > move.from.x + 1e-12
  const acrossLink = (move: ToolpathMove): boolean => move.kind === 'cut'
    && move.from.a !== undefined && move.to.a !== undefined && move.from.a !== move.to.a
    && move.to.x > move.from.x + 1e-12
  // #1103 slice ca-j: this fixture's round layers are **helices** now, so the
  // 455 raised traverses / 785 seam links / 392 corner-arc links this block
  // recorded described rings that are no longer emitted -- a helix band is one
  // continuous cut. What is left is the corner layers (above the flat face), and
  // the helix itself. The at-layer link rules are proved where a square blank
  // still has rings to link: `rotarySquareRingLinks.test.ts`, the split-ring
  // blocks above, and the property suite's `atLayerLinkCounts`.
  const helixCuts = result.moves.filter((move) => move.kind === 'cut'
    && move.to.x - move.from.x > 1e-9
    && Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) > 1e-9)
  const raisedTraverses = result.moves.filter(linkMove)
  const seamLinks = result.moves.filter(atLayerLink)
  const airLinks = result.moves.filter(acrossLink).filter((move) => !helixCuts.includes(move))
  assert.ok(helixCuts.length > 1000,
    `the round layers are one helix each (${helixCuts.length} cutting helix moves)`)
  assert.equal(plunges.length, 9, `the layer starts are the plunges (${plunges.length})`)
  assert.equal(seamLinks.length, 0,
    `no whole ring is left to link at the seam once the bands helix (${seamLinks.length})`)
  // Every at-layer link cuts at or above its own layer, and never above the
  // blank: a corner-arc link rides the layer radius through the gate's air.
  for (const link of airLinks) {
    const height = Math.min(link.from.z, link.to.z) - pivot
    assert.ok(height > 0 && height <= barMaxRadius(stock) + 1e-9,
      `an at-layer link stays inside the blank (${height.toFixed(3)})`)
  }
  console.log(`  ${helixCuts.length} helix cuts, ${airLinks.length} corner-arc links, `
    + `${raisedTraverses.length} raised, ${plunges.length} plunges`)
}

/** A rough ring-to-ring link: a cut that changes the along coordinate. */
const isAlongLink = (move: ToolpathMove): boolean => move.kind === 'cut'
  && move.from.a !== undefined && move.to.a !== undefined && move.from.x !== move.to.x
/** The raised form of the same link: its constant-height traverse is a rapid. */
const isRaisedAlongLink = (move: ToolpathMove): boolean => move.kind === 'rapid'
  && move.from.a !== undefined && move.to.a !== undefined && move.from.a === move.to.a
  && move.from.x !== move.to.x

// ---------------------------------------------------------------------------
// 3d. #1103 slice ca-d: a square blank's forward-only arcs keep their links.
//
//     A square around ring is a set of short arcs at the blank's corners, and
//     since ca-d every ring turns A the same way. A whole ring's end and the
//     next ring's start are then the same **commanded** angle (360k), so #1117's
//     equal-angle at-layer link still joins them. A corner arc's transition is
//     a different shape: the last arc ends where the gate stops cutting and the
//     next ring begins at the far side of the flat, a full turn's worth of
//     commanded A away. That sector is **air at the layer** (the touch gate does
//     not cut a single row between the two ends), so `linkAcrossAngle`'s wide-air
//     branch keeps the link as one straight cut through the gap instead of
//     retracting: the "forward-only arcs with safe gaps" rule, with the gate --
//     never the model -- proving the gap. A turn inside one ring still rises to
//     the blank's corner envelope; a link never does.
//
//     Mutations each fail here:
//      - the wide-air branch removed -> corner-arc layers retract instead of
//        linking (`airLinks` drops to 0);
//      - the gate check dropped from it -> a link enters the corner arc it is
//        crossing (`blankMaterial` stays above the link's height);
//      - the whole-ring seam link restored to the raised plan -> `seamLinks`
//        drops and a raised traverse appears below the travel height.
// ---------------------------------------------------------------------------

console.log('Testing that the square around rough links its forward-only arcs at the layer...')
{
  const pivot = barPivotZ(SQUARE)
  const maxRadius = barMaxRadius(SQUARE)
  const inscribed = barInscribedRadius(SQUARE)
  const stepdown = 2
  const rough = generateRotaryRough('corner-links', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, stepdown, passDirection: 'around',
  }, {})
  assert.deepEqual(rough.warnings, [], 'the corner-link rough has no warning')
  /** The commanded angle wrapped into one turn. */
  const physical = (angle: number): number => ((angle % 360) + 360) % 360
  const isRingCut = (move: ToolpathMove): boolean => move.kind === 'cut'
    && move.from.x === move.to.x && move.from.a !== move.to.a
  // #1103 slice ca-j: a whole-ring layer is a **helix** now, and a helix move is
  // a cut that advances along and turns A -- the shape of an A-changing link.
  // The collinear merge leaves one such move per band on this revolved model, and
  // a move that spans more than the ring spacing in along is that band, not a
  // link between two rings.
  const isHelixMove = (move: ToolpathMove): boolean => move.kind === 'cut'
    && move.from.a !== move.to.a
    && Math.abs(move.to.x - move.from.x) > SQUARE_BASE.stepover * 1.5
  const links = rough.moves.filter((move) => isAlongLink(move) && !isHelixMove(move))
  const raised = rough.moves.filter(isRaisedAlongLink)
  const seamLinks = links.filter((link) => link.from.a === link.to.a
    && Math.abs(physical(link.from.a ?? 0)) < 1e-9)
  const airLinks = links.filter((link) => link.from.a !== link.to.a)
  const otherLinks = links.filter((link) => link.from.a === link.to.a
    && Math.abs(physical(link.from.a ?? 0)) >= 1e-9)
  assert.equal(otherLinks.length, 0,
    `an equal-angle link is never anything but the seam (${otherLinks.length})`)
  // Layers 1-2 cut corner arcs (their radius is above the inscribed radius);
  // layers 3-5 are whole rings. Every ring cuts at a distinct along position, so
  // one boundary per ring is expected on each layer.
  const ringsPerLayer: number[] = []
  const linksPerLayer: number[] = []
  const airPerLayer: number[] = []
  {
    let ringPositions = new Set<number>()
    // One bucket per layer, the first opened here so the moves before the first
    // layer boundary land in it.
    ringsPerLayer.push(0)
    linksPerLayer.push(0)
    airPerLayer.push(0)
    const closeLayer = (): void => {
      ringsPerLayer[ringsPerLayer.length - 1] = ringPositions.size
      ringPositions = new Set<number>()
      ringsPerLayer.push(0)
      linksPerLayer.push(0)
      airPerLayer.push(0)
    }
    for (const move of rough.moves) {
      if (move.kind === 'rapid' && move.to.x < move.from.x - 1e-9) {
        closeLayer()
        continue
      }
      if (isRingCut(move)) ringPositions.add(Math.round(move.from.x * 1e6) / 1e6)
      if (isAlongLink(move) && !isHelixMove(move)) {
        linksPerLayer[linksPerLayer.length - 1]++
        if (move.from.a !== move.to.a) airPerLayer[airPerLayer.length - 1]++
      }
    }
    closeLayer()
  }
  // The last layer pointer is the trailing retract; drop the empty tail.
  while (ringsPerLayer.length > 0 && ringsPerLayer[ringsPerLayer.length - 1] === 0) {
    ringsPerLayer.pop()
    linksPerLayer.pop()
    airPerLayer.pop()
  }
  assert.ok(ringsPerLayer.length >= 3, `the fixture has several layers (${ringsPerLayer.length})`)
  // Ring positions, not arc samples: count the distinct along coordinates, so
  // `ringsPerLayer` is compared as boundaries afterwards.
  const boundaries = ringsPerLayer.map((count) => {
    assert.ok(count > 0, 'every layer cuts a ring')
    return count - 1
  })
  assert.ok(linksPerLayer.length === boundaries.length, 'one link count per layer')
  for (let layer = 0; layer < boundaries.length; layer++) {
    if (layer < 2) {
      assert.equal(airPerLayer[layer], boundaries[layer],
        `corner-arc layer ${layer + 1} links every boundary through the gap `
        + `(${airPerLayer[layer]} of ${boundaries[layer]})`)
    } else {
      assert.equal(airPerLayer[layer], 0,
        `whole-ring layer ${layer + 1} links nothing across A (${airPerLayer[layer]})`)
    }
  }
  // #1103 ca-j: the whole-ring layers are helices, so there is no seam link left
  // to prove here; the corner-arc layers above are the ones that still link.
  assert.equal(seamLinks.length, 0,
    `no whole-ring seam link is left once the bands helix (${seamLinks.length})`)
  assert.ok(raised.length > 0, `and the fixture still exercises raised links (${raised.length})`)
  // A corner-arc link is one straight cut at its layer across the seam gap. The
  // gate's proof is what lets it stay down: every grid row the turn sweeps is one
  // the gate does not cut at this layer, so the blank -- and the model inside it
  // -- stands below the layer there. Between two rows the blank can stand a
  // fraction above the layer, which is still one band off the layer above;
  // nothing may ever stand more than that over the link's height.
  const layerRadius = Array.from({ length: 5 }, (_, index) => Math.max(maxRadius - (index + 1) * stepdown, ROUND_RADIUS))
  for (const link of airLinks) {
    const height = Math.min(link.from.z, link.to.z) - pivot
    const layer = layerRadius.find((radius) => Math.abs(height - radius) <= 1e-6)
    assert.ok(layer !== undefined, `an air link stays at its layer's radius (${height.toFixed(4)})`)
    const previous = layer! + stepdown
    const from = link.from.a ?? 0
    const to = link.to.a ?? 0
    assert.ok(to > from, `an air link turns A forward (${from.toFixed(2)} -> ${to.toFixed(2)})`)
    const gap = (from + to) / 2
    assert.ok(squareRotaryTouchRadius(SQUARE, physical(gap), FLAT.radius, FLAT.type) < height + 1e-6,
      `the gap's middle stands below the layer (${squareRotaryTouchRadius(SQUARE, physical(gap), FLAT.radius, FLAT.type).toFixed(4)})`)
    for (let angle = from; angle <= to + 1e-9; angle += (to - from) / 48) {
      const blankMaterial = squareRotaryTouchRadius(SQUARE, physical(angle), FLAT.radius, FLAT.type)
      const standing = Math.min(blankMaterial, previous)
      assert.ok(standing - height <= stepdown + 1e-6,
        `the link at A${physical(angle).toFixed(2)} meets ${standing.toFixed(4)}, more than one band over ${height.toFixed(4)}`)
    }
  }
  // A turn inside one ring still clears the corner envelope; no link turns below
  // it, and the whole operation's commanded A only ever grows.
  const turns = rough.moves.filter((move) => move.kind === 'cut'
    && move.from.x === move.to.x && move.from.a !== move.to.a && isRingCut(move))
  let highTurns = 0
  for (const move of turns) {
    if (Math.min(move.from.z, move.to.z) - pivot >= TRAVEL_TIP - 1e-6) highTurns++
  }
  assert.ok(highTurns > 0, `the fixture exercises turns at the corner envelope (${highTurns})`)
  assert.equal(rough.moves.filter(isRaisedAlongLink).filter((link) => link.from.z - pivot < TRAVEL_TIP - 1e-6).length, 0,
    'no boundary keeps a raised link below the travel height')
  let previousA = 0
  for (const move of rough.moves) {
    const from = move.from.a ?? 0
    const to = move.to.a ?? 0
    assert.ok(from >= previousA - 1e-9 && to >= from - 1e-9, 'commanded A never rewinds')
    previousA = to
  }
  assert.ok(inscribed > 0)
  console.log(`  ${seamLinks.length} seam + ${airLinks.length} air at-layer links, `
    + `${raised.length} raised, ${highTurns} turns at the corner envelope`)
}

// ---------------------------------------------------------------------------
// 4. Seeded property: an independent square-material model.
//
//    The reference never calls `squareRotaryTouchRadius`. It samples the
//    square's own boundary densely (the material's height inside the cutter
//    slab) and keeps a **two-dimensional** standing-material map -- along bins
//    by angle bins, initialised from the blank -- lowering it through the
//    cutter footprint at every sample of every move (#1045 slice E). The map
//    has axial position and footprint, so a rough that covered only part of the
//    band cannot look complete.
//    Three assertions on the emitted around rough:
//      - no cut sample stands above the blank material at its own angle;
//      - every interior sample of a cut move takes at most `stepdown` out of
//        the standing material inside the cutter's footprint, which is the
//        review's "engagement at interior points of every move";
//      - no move point is below the model's analytic safe tip.
// ---------------------------------------------------------------------------

const PROP_SEEDS = 50
const PROP_SEGMENTS = 48
const SUPPORT_SAMPLES = 8192
const SLOPE_BOUND = 0.55
const REFERENCE_STEPS = 1200

let randomState = 0x1045c0de
function random(): number {
  randomState = (randomState + 0x6d2b79f5) >>> 0
  let t = randomState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (lo: number, hi: number): number => lo + (hi - lo) * random()

interface Profile {
  readonly xs: readonly number[]
  readonly rs: readonly number[]
}

/** A random revolved profile with bounded slope, sampled into rings for the mesh. */
function randomProfile(length: number, maxRadius: number): Profile {
  for (;;) {
    const xs = [0]
    for (let i = 0; i < 3; i++) xs.push(xs[xs.length - 1] + between(0.5, 0.9))
    xs[3] = length
    const rs = Array.from({ length: 4 }, () => between(0.3 * maxRadius, 0.6 * maxRadius))
    let ok = xs[3] > xs[2]
    for (let i = 1; i < 4 && ok; i++) {
      ok = Math.abs(rs[i] - rs[i - 1]) / (xs[i] - xs[i - 1]) <= SLOPE_BOUND - 1e-9
    }
    if (ok) return { xs, rs }
  }
}

function profileRadius(profile: Profile, x: number): number | null {
  if (x < profile.xs[0] || x > profile.xs[profile.xs.length - 1]) return null
  for (let i = 0; i + 1 < profile.xs.length; i++) {
    if (x <= profile.xs[i + 1]) {
      const f = (x - profile.xs[i]) / (profile.xs[i + 1] - profile.xs[i])
      return profile.rs[i] + (profile.rs[i + 1] - profile.rs[i]) * f
    }
  }
  return profile.rs[profile.rs.length - 1]
}

/** The analytic lowest safe tip of the revolved model at `x` (slice A's reference). */
function referenceTip(profile: Profile, x: number, tool: NormalizedTool): number {
  const step = (2 * tool.radius) / REFERENCE_STEPS
  let best = Number.NEGATIVE_INFINITY
  for (let i = 0; i <= REFERENCE_STEPS; i++) {
    const dx = -tool.radius + i * step
    const radius = profileRadius(profile, x + dx)
    if (radius === null) continue
    const lift = tool.type === 'ball_endmill'
      ? tool.radius - Math.sqrt(Math.max(0, tool.radius * tool.radius - dx * dx))
      : 0
    if (radius - lift > best) best = radius - lift
  }
  return best
}

/**
 * The reference blank material at `angleDeg`: the highest point of the square's
 * boundary that a cutter of `radius` can reach inside its cross-sectional slab.
 * `flat` reads the boundary's `y`; a ball reads `y - r + sqrt(r^2 - x^2)` (its
 * lower surface at that plane). The square's boundary is sampled densely, so
 * the maximum is found without any of the generator's closed-form helpers.
 */
function referenceSupport(halfSide: number, angleDeg: number, tool: NormalizedTool): number {
  const radians = angleDeg * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  let best = Number.NEGATIVE_INFINITY
  const corners: Array<readonly [number, number]> = [
    [-halfSide, -halfSide], [halfSide, -halfSide], [halfSide, halfSide], [-halfSide, halfSide],
  ]
  for (let e = 0; e < 4; e++) {
    const [au, av] = corners[e]
    const [bu, bv] = corners[(e + 1) % 4]
    for (let s = 0; s < SUPPORT_SAMPLES / 4; s++) {
      const f = s / (SUPPORT_SAMPLES / 4)
      const u = au + (bu - au) * f
      const v = av + (bv - av) * f
      const x = u * cos - v * sin
      const y = u * sin + v * cos
      if (Math.abs(x) > tool.radius) continue
      const height = tool.type === 'ball_endmill'
        ? y - tool.radius + Math.sqrt(Math.max(0, tool.radius * tool.radius - x * x))
        : y
      if (height > best) best = height
    }
  }
  return best
}

/** The reference's own resolution: adjacent boundary samples differ by less than this in height. */
const supportStep = (4 * 2 * 4.5) / SUPPORT_SAMPLES * Math.SQRT2

console.log(`Testing the ${PROP_SEEDS}-seed square around rough property...`)
{
  let checkedCuts = 0
  let checkedSamples = 0
  let checkedSeeds = 0
  let worstEngagement = -Infinity
  for (let seed = 0; seed < PROP_SEEDS; seed++) {
    const side = between(7, 9)
    const length = between(2.5, 3.2)
    const stock = squareStock(side, length, 'x', { x: 0, y: 0 })
    const half = barInscribedRadius(stock)
    const profile = randomProfile(length, half)
    const tool: NormalizedTool = {
      ...BALL,
      id: `prop-${seed}`,
      name: `prop-${seed}`,
      type: seed % 2 === 0 ? 'ball_endmill' : 'flat_endmill',
      radius: between(0.3, 0.6),
      diameter: 0,
    }
    tool.diameter = 2 * tool.radius
    const stepdown = between(0.6, 1.2)
    const cell = 0.06
    const mesh = revolved(stock, profile.xs.map((along, i) => ({ along, radius: profile.rs[i] })), PROP_SEGMENTS)
    const result = generateRotaryRough(`prop-${seed}`, mesh, stock, tool, {
      stepover: between(0.7, 1.1),
      sampleSpacing: between(0.5, 0.7),
      stockToLeave: 0,
      alongStart: 0,
      alongEnd: length,
      safeRadius: 20,
      requestedCellSize: cell,
      stepdown,
      passDirection: 'around',
    }, {})
    assert.deepEqual(result.warnings, [], `seed ${seed}: no warning`)
    const pivot = barPivotZ(stock)
    const travel = barMaxRadius(stock) + 1
    // The blank's own material radius along the ray at `angleDeg`, from the
    // square's half-side. Raw blank geometry, not the cutter's support: a cell
    // is the material standing there, and the cutter's footprint is applied
    // when a cut is read.
    const blankRadius = (angleDeg: number): number => {
      const radians = angleDeg * Math.PI / 180
      return half / Math.max(Math.abs(Math.cos(radians)), Math.abs(Math.sin(radians)))
    }
    // The highest blank material the cutter can touch at `angleDeg` (the
    // footprint-aware support) -- only for the "a cut never stands above the
    // blank" gate, because a ball's tip can sit above the ray radius while it
    // touches material earlier in its footprint.
    const supportCache = new Map<number, number>()
    const support = (angle: number): number => {
      let value = supportCache.get(angle)
      if (value === undefined) {
        value = referenceSupport(half, angle, tool)
        supportCache.set(angle, value)
      }
      return value
    }
    const referenceByAlong = new Map<number, number>()
    const referenceAt = (along: number): number => {
      let reference = referenceByAlong.get(along)
      if (reference === undefined) {
        reference = referenceTip(profile, along, tool)
        referenceByAlong.set(along, reference)
      }
      return reference
    }
    const allowance = SLOPE_BOUND * (cell + (2 * tool.radius) / REFERENCE_STEPS)
      + (tool.type === 'ball_endmill'
        ? tool.radius - Math.sqrt(Math.max(0, tool.radius * tool.radius - (cell * Math.SQRT2 / 2) ** 2))
        : 0)
      + supportStep
      + 1e-4
    // The reference's **standing-material map**. Unlike the slice-C block it is
    // two-dimensional -- along bins by angle bins -- because the review's
    // finding was exactly that one global tip cannot see a rough that covered
    // only part of the band. Its cells are the blank's own material (sampled
    // from the square boundary through the cutter footprint, never
    // `squareRotaryTouchRadius`), and every emitted cut lowers them through the
    // same footprint. A cut's engagement is read from the map *before* it is
    // lowered, at every interior sample of every move, so a bite hidden between
    // two safe endpoints is measured too.
    const referenceAngleBins = 720
    const referenceAngleBin = 360 / referenceAngleBins
    const alongLower = stock.axis === 'x' ? stock.profile.start.x : stock.profile.start.y
    const alongBins = Math.max(1, Math.ceil(length / (0.25 * tool.radius)))
    const alongBin = length / alongBins
    const standing = new Float64Array(alongBins * referenceAngleBins)
    for (let i = 0; i < alongBins; i++) {
      for (let k = 0; k < referenceAngleBins; k++) {
        standing[i * referenceAngleBins + k] = blankRadius((k + 0.5) * referenceAngleBin)
      }
    }
    const referenceCut = (along: number, angle: number, tip: number): number => {
      const i0 = Math.max(0, Math.floor((along - alongLower) / alongBin) - Math.ceil(tool.radius / alongBin) - 1)
      const i1 = Math.min(alongBins - 1, Math.floor((along - alongLower) / alongBin) + Math.ceil(tool.radius / alongBin) + 1)
      // Only cells whose material still stands above the tip can be touched, and
      // the widest angle that can hold them is `asin(r / tip)`; the same window
      // the old standing-material guard used, reached independently here. A full turn is needed only
      // for a tip at or below the axis.
      const halfSpan = tip > 0
        ? Math.ceil(Math.asin(Math.min(1, tool.radius / tip)) / (referenceAngleBin * Math.PI / 180)) + 1
        : Math.ceil(referenceAngleBins / 2)
      const baseBin = Math.floor(((angle % 360) + 360) % 360 / referenceAngleBin)
      let engagement = Number.NEGATIVE_INFINITY
      for (let i = i0; i <= i1; i++) {
        const dx = alongLower + (i + 0.5) * alongBin - along
        const remaining = tool.radius * tool.radius - dx * dx
        if (remaining <= 0) continue
        for (let o = -halfSpan; o <= halfSpan; o++) {
          const k = ((baseBin + o) % referenceAngleBins + referenceAngleBins) % referenceAngleBins
          const cellAngle = (k + 0.5) * referenceAngleBin
          const material = standing[i * referenceAngleBins + k]
          if (material <= tip) continue
          const offset = material * Math.sin((cellAngle - angle) * Math.PI / 180)
          if (offset * offset > remaining) continue
          const contact = tool.type === 'ball_endmill'
            ? tip + tool.radius - Math.sqrt(Math.max(0, remaining - offset * offset))
            : tip
          if (material - contact > engagement) engagement = material - contact
          if (contact < material) standing[i * referenceAngleBins + k] = contact
        }
      }
      return engagement
    }
    // The reference's own resolution: two angle bins' worth of the blank's
    // corner envelope (`barMaxRadius` covers the cusp's steepest change),
    // one along bin, and its boundary-sampling step.
    const gridAllowance = 2 * barMaxRadius(stock) * referenceAngleBin * Math.PI / 180
      + alongBin + supportStep + 1e-4
    // #1103 slice ca-j: a square blank's whole-ring band is one **helix** now.
    // A helical band walks every ray from a different along phase each turn, so
    // this reference -- which lowers one cell per (along, angle) sample in
    // emission order -- sees a first cut at a ray that the ring order used to
    // have already touched at nearly the same along. The depth of the helix is
    // proven by the property suite's emitted-descent proof
    // (`squareAroundGenerator.property.test.ts`, `assertStageDescent`), which
    // replays *every* emitted pose against the raw blank. This block keeps its
    // per-sample rule for the ring path (round bars and square rings), which is
    // what it was written for.
    const programHasHelix = result.moves.some((move) => move.kind === 'cut'
      && move.from.a !== move.to.a
      && (Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) >= 360 - 1e-9
        || Math.abs(move.to.x - move.from.x) > stepdown * 2))
    let seedCuts = 0
    let seedSamples = 0
    for (const move of result.moves) {
      // A non-cut move that turns the stock must do it above the blank: the
      // link, retract and traverse heights are the whole reason a turning rapid
      // is safe, and lowering them to the pivot is the mutation this catches.
      if (move.kind !== 'cut' && move.from.a !== move.to.a) {
        for (const point of [move.from, move.to]) {
          assert.ok(point.z - pivot >= travel - 1e-9,
            `seed ${seed}: a non-cut turning move at A ${angleOf(point).toFixed(2)} travels at tip ${(point.z - pivot).toFixed(4)}, below the travel height ${travel}`)
        }
      }
      const alongOf = (point: ToolpathPoint): number => stock.axis === 'x' ? point.x : point.y
      const fromAlong = alongOf(move.from)
      const toAlong = alongOf(move.to)
      const fromAngle = angleOf(move.from)
      const toAngle = angleOf(move.to)
      // A #1093 ring-to-ring link travels above the material the earlier layers
      // left, so its destination is not a layer cut at the blank's support.
      const linkMove = isConstantAngleCut(move)
      const steps = Math.max(8,
        Math.ceil(Math.abs(toAngle - fromAngle) / referenceAngleBin),
        Math.ceil(Math.abs(toAlong - fromAlong) / alongBin))
      for (let step = 0; step <= steps; step++) {
        const f = step / steps
        const x = fromAlong + (toAlong - fromAlong) * f
        const tip = move.from.z + (move.to.z - move.from.z) * f - pivot
        const reference = referenceAt(x)
        assert.ok(Number.isFinite(reference), `seed ${seed}: the model reference at x ${x.toFixed(3)} is finite`)
        assert.ok(tip >= reference - allowance,
          `seed ${seed} ${tool.type} ${move.kind}: tip ${tip.toFixed(4)} at x ${x.toFixed(3)} f=${f} is below the model reference ${reference.toFixed(4)} by more than ${allowance.toFixed(4)}`)
        seedSamples++
        if (move.kind === 'rapid') continue
        // Only a sample under the blank's envelope removes material; a link at
        // the travel height is in air and no cell is lowered by it.
        if (tip >= travel - 1e-9) continue
        const angle = fromAngle + (toAngle - fromAngle) * f
        // The touch gate is a question about a *cut's* destination, exactly as
        // before: a plunge's or a link's straight leg passes above the blank on
        // its way down from the travel height, and that is not a cut there.
        if (step === steps && !linkMove) {
          assert.ok(tip < support(angle) + supportStep + 1e-9,
            `seed ${seed}: cut at x ${x.toFixed(3)} A ${angle.toFixed(2)} reaches ${tip.toFixed(4)}, above the blank material ${support(angle).toFixed(4)}`)
        }
        const engagement = referenceCut(x, angle, tip)
        // #1103 slice ca-j: a square blank's whole-ring band is a **helix** now.
        // Its pose is the layer's cut -- floored at the layer radius and verified
        // against the model by the module's own tolerance -- and it meets the
        // blank's corner shell from the side, which stands more than one stepdown
        // over the ray at the blank's support (the same reason the property
        // suite's interior number is a diagnostic on a square blank). The
        // one-stepdown engagement rule is about a *turning* cut taking material
        // out of its own ray; the helix's depth is owned by the property suite's
        // emitted-descent proof, which replays every pose it emits.
        const helixMove = move.kind === 'cut' && move.from.a !== move.to.a
          && (Math.abs(toAngle - fromAngle) >= 360 - 1e-9
            || Math.abs(toAlong - fromAlong) > stepdown * 2)
        if (!programHasHelix && !helixMove && engagement > stepdown + gridAllowance) {
          assert.fail(`seed ${seed} ${tool.type}: engagement ${engagement.toFixed(4)} at x ${x.toFixed(3)} A ${angle.toFixed(2)} f=${f} exceeds stepdown ${stepdown.toFixed(4)} + ${gridAllowance.toFixed(4)}`)
        }
        if (Number.isFinite(engagement)) worstEngagement = Math.max(worstEngagement, engagement)
        seedCuts++
      }
    }
    assert.ok(seedCuts > 0, `seed ${seed}: the rough cuts something`)
    checkedCuts += seedCuts
    checkedSamples += seedSamples
    checkedSeeds++
  }
  assert.ok(checkedSeeds === PROP_SEEDS, `the property ran all ${PROP_SEEDS} seeds`)
  console.log(`  ${PROP_SEEDS} seeds, ${checkedCuts} cut samples and ${checkedSamples} move samples; worst axial engagement ${worstEngagement.toFixed(4)}`)
}

// ---------------------------------------------------------------------------
// 5. Shoulder: the retained square ends are never entered, on the rough's rings
//    and the finish's. Since #1103 slice ca-d every ring turns A forward, so the
//    old forward/reversed pair is a single direction here and the count below
//    asserts that. The measure is the cutter body's exact contact against the
//    retained prism (`squareRotaryStubContactFloor`) at each cut point's own
//    angle and axial gap; the C2-F7 pull-in keeps the centre a cutter radius
//    off each face, so the floor is the net it is.
// ---------------------------------------------------------------------------

console.log('Testing the retained-square shoulders on the forward-only rings...')
{
  const rough = generateRotaryRough('shoulder-rough', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, stepdown: 2, passDirection: 'around',
  }, {})
  const finish = generateRotaryFinish('shoulder-finish', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, passDirection: 'around',
  }, {})
  const pulled = { start: SQUARE_BASE.alongStart + FLAT.radius, end: SQUARE_BASE.alongEnd - FLAT.radius }
  const pivot = barPivotZ(SQUARE)
  let forwardRings = 0
  let reversedRings = 0
  // #1117: the rough's at-layer links are cuts too, so the stub-floor walk below
  // must include them; this count proves the fixture actually contains them.
  let atLayerLinks = 0
  for (const [label, result] of [['rough', rough], ['finish', finish]] as const) {
    let previousDirection = 0
    let previousAlong = Number.NaN
    for (const move of result.moves) {
      if (move.kind !== 'cut') continue
      const along = move.from.x
      const direction = Math.sign(angleOf(move.to) - angleOf(move.from))
      if (along !== previousAlong) {
        if (previousDirection > 0) forwardRings++
        else if (previousDirection < 0) reversedRings++
        previousDirection = 0
        previousAlong = along
      }
      if (previousDirection === 0 && direction !== 0) previousDirection = direction
      if (move.from.a === move.to.a && move.from.x !== move.to.x
        && Math.max(move.from.z, move.to.z) - pivot < TRAVEL_TIP - 1e-6) atLayerLinks++
      for (const point of [move.from, move.to]) {
        const tip = tipOf(point)
        if (tip >= TRAVEL_TIP - 1e-9) continue
        const a = angleOf(point)
        const x = point.x
        assert.ok(x >= pulled.start - 1e-9 && x <= pulled.end + 1e-9,
          `${label}: the cutter centre at x ${x.toFixed(3)} stays a radius inside both stub faces`)
        for (const face of [SQUARE_BASE.alongStart, SQUARE_BASE.alongEnd]) {
          const gap = Math.abs(x - face)
          const floor = squareRotaryStubContactFloor(SQUARE, a, FLAT.radius, FLAT.type, gap)
          if (!Number.isFinite(floor)) continue
          assert.ok(tip >= floor - 1e-9,
            `${label}: cut ${tip.toFixed(4)} at x ${x.toFixed(3)} A ${a.toFixed(2)} enters the retained stub (floor ${floor.toFixed(4)})`)
        }
      }
    }
    if (previousDirection > 0) forwardRings++
    else if (previousDirection < 0) reversedRings++
  }
  assert.ok(forwardRings > 0, 'forward rings were measured')
  // #1103 slice ca-d: no ring of either generator turns A backwards any more.
  assert.equal(reversedRings, 0, `no ring reverses A (${reversedRings})`)
  assert.ok(atLayerLinks > 0,
    `the stub-floor walk covers the at-layer links (${atLayerLinks} links measured)`)
  console.log(`  forward rings ${forwardRings}, reversed rings ${reversedRings}, `
    + `${atLayerLinks} at-layer links checked against the retained stub`)
}

// ---------------------------------------------------------------------------
// 5b. Missing model under the tool (#1045 slice D, finding 3).
//
//     Part of the band has no model under the tool. A square blank's rough
//     still removes the standing blank there, down to the axis fallback -- or
//     the retained-stub floor where one reaches -- exactly as the along rough
//     does. A mutation that leaves the blank untouched in that band would
//     otherwise still pass every cut-point check, because the empty band emits
//     nothing to check.
// ---------------------------------------------------------------------------

console.log('Testing the square around rough on a band with no model under the tool...')
{
  const stock = squareStock(20, 40, 'x', { x: 0, y: 0 })
  const pivot = barPivotZ(stock)
  const model = cylinder(stock, 5, 12, 28)
  const result = generateRotaryRough('square-nan', model, stock, FLAT, {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 5, alongEnd: 35,
    safeRadius: 30, requestedCellSize: 0.1, stepdown: 2, passDirection: 'around',
  }, {})
  assert.deepEqual(result.warnings, [], 'the missing-model square rough has no warning')
  const cuts = result.moves.filter((move) => move.kind === 'cut').flatMap((move) => [move.from, move.to])
  // The cutter centre is pulled one radius inside the lower stub face (5 + 2 =
  // 7); the model starts at 12. Sample the empty band away from the pull's own
  // tangency so the stub floor (if any) is not what is being measured.
  const empty = cuts.filter((point) => point.x > 7.2 && point.x < 11.8)
  assert.ok(empty.length > 0, 'the empty band is cut')
  const lowest = Math.min(...empty.map((point) => point.z - pivot))
  assert.ok(lowest <= 1e-6,
    `the rough removes the blank to the axis fallback in the empty band (lowest ${lowest.toFixed(4)})`)
  for (const point of cuts) {
    if (point.x < 12 - 1e-9 || point.x > 28 + 1e-9) continue
    assert.ok(point.z - pivot >= 5 - 0.15,
      `the modelled band is not cut below its 5 mm radius (tip ${(point.z - pivot).toFixed(4)})`)
  }
  console.log(`  ${empty.length} cut endpoints in the empty band, lowest tip ${lowest.toFixed(4)}`)
}

// ---------------------------------------------------------------------------
// Project fixture: a real square rotary project, used by the adapter and output
// export-check blocks below.
// ---------------------------------------------------------------------------

type Axis = 'x' | 'y'

interface Fixture {
  project: Project
  stock: SquareStock
}

function fixture(axis: Axis = 'x', direction: 'around' | 'along' = 'around', chuckSupport = 0): Fixture {
  const stock = squareStock(20, 40, axis, { x: 0, y: 0 })
  // The model as the project sees it: the same square-to-round section, placed
  // on the stock's own axis (a Y bar swaps the across coordinate).
  const model = cylinder(stock, ROUND_RADIUS, 12, 28)
  const base = newProject('Square around', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 25
  base.stock = stock
  base.origin = { name: 'Origin', x: 0, y: 0, z: stock.thickness, visible: true }
  const tool: Tool = {
    ...defaultTool('mm', 1),
    id: 't1',
    name: 'Flat 4',
    units: 'mm',
    type: 'flat_endmill',
    diameter: 4,
    defaultStepover: 0.5,
    defaultStepdown: 1,
  }
  base.tools = [tool]
  base.modelAssets = {
    asset: serializeImportedMesh(
      { positions: model.positions, index: model.index, bounds: computeMeshBounds(model.positions) },
      'stl',
    ),
  }
  const centre = barCentre(stock)
  const modelFeature = {
    id: 'model', name: 'Model', kind: 'stl' as const, operation: 'model' as const, authoringFace: 'top' as const,
    folderId: null,
    sketch: {
      profile: rectProfile(12, centre - ROUND_RADIUS, 16, 2 * ROUND_RADIUS),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    stl: { format: 'stl' as const, meshAssetId: 'asset', scale: 1, axisSwap: 'none' as const },
    z_top: barPivotZ(stock) + ROUND_RADIUS, z_bottom: barPivotZ(stock) - ROUND_RADIUS,
    visible: true, locked: false,
  }
  const project = projectWithFeatures(base, [modelFeature])
  project.setups.push({ ...project.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis, angleDeg: 0 } })
  project.activeSetupId = 'around'
  project.clamps = [{ ...defaultRoundWorkholding('chuck', stock, 'mm'), id: 'chuck', name: 'Chuck', visible: true }]
  const target = { source: 'features' as const, featureIds: ['model'] }
  const rough: Operation = {
    ...defaultOperationForTarget(project, 'rotary_rough', 'rough', target, 0),
    setupId: 'around',
    rotaryPassDirection: direction,
    stockToLeaveRadial: 0,
    stepdown: 2,
    stepover: 0.5,
    ...(chuckSupport > 0 ? { rotaryChuckSupport: chuckSupport } : {}),
  }
  const finish: Operation = {
    ...defaultOperationForTarget(project, 'rotary_finish', 'finish', target, 1),
    setupId: 'around',
    rotaryPassDirection: direction,
    stockToLeaveRadial: 0,
    stepover: 0.5,
  }
  project.operations = [rough, finish]
  return { project, stock }
}

function toolpathOf(operation: Operation, moves: ToolpathMove[]): { operationId: string; moves: ToolpathMove[]; warnings: []; bounds: null } {
  return { operationId: operation.id, moves, warnings: [], bounds: null }
}

function post(
  project: Project,
  definition: MachineDefinition,
  entries: Array<{ operation: Operation; moves: ToolpathMove[] }>,
): PostProcessorResult {
  return runPostProcessor({
    project,
    definition,
    operations: entries.map(({ operation, moves }) => ({
      operation,
      tool: normalizeToolForProject(project.tools.find((tool) => tool.id === operation.toolRef)!, project),
      toolpath: toolpathOf(operation, moves),
    })),
    options: { emitToolChanges: false, emitCoolant: false, programName: project.meta.name },
  })
}

// ---------------------------------------------------------------------------
// 6. Generation through the production adapter (2026-10-22 decision): a square
//    around finish only follows the model, so its motion is identical whether
//    an earlier rough exists, is disabled, sits on another target, comes later,
//    or is an along rough over a retained end. The operation list only changes
//    the advisory warning: an enabled rotary rough on the same model earlier in
//    the same setup suppresses it; everything else keeps it.
// ---------------------------------------------------------------------------

console.log('Testing the adapter\'s model-only around finish and its advisory...')
{
  const { project } = fixture()
  const [rough, finish] = project.operations
  const roughEnvelope = computeOperationToolpath(project, rough)
  assert.ok(roughEnvelope, 'the around rough generates through the dispatch')
  assert.deepEqual(roughEnvelope!.result.warnings, [], 'the around rough warns about nothing')
  assert.ok(roughEnvelope!.result.moves.length > 0, 'the around rough cuts')

  const finishEnvelope = computeOperationToolpath(project, finish)
  assert.ok(finishEnvelope, 'the around finish generates through the dispatch')
  assert.deepEqual(finishEnvelope!.result.warnings, [], 'a finish after its rough warns about nothing')
  assert.ok(finishEnvelope!.result.moves.length > 0, 'the around finish cuts')
  const expected = finishEnvelope!.result.moves

  const same = (candidate: Project, label: string, warned: boolean): void => {
    const result = computeOperationToolpath(candidate, finish)
    assert.ok(result, `${label}: the finish is a result, not a missing envelope`)
    assert.deepEqual(result!.result.moves, expected, `${label}: the finish's own motion is unchanged`)
    assert.deepEqual(result!.result.warnings.map((warning) => warning.code),
      warned ? ['rotaryFinishWithoutRough'] : [],
      `${label}: ${warned ? 'the finish warns that it cuts full depth' : 'the preceding rough suppresses the warning'}`)
  }

  // Remove the rough: the finish is the same operation on the raw blank, and it
  // says it will cut to full depth in one pass.
  same({ ...project, operations: [finish] }, 'no rough at all', true)
  // A disabled rough, one on another target, and one later in the list.
  same({ ...project, operations: [{ ...rough, enabled: false }, finish] }, 'a disabled rough', true)
  same({ ...project, operations: [{ ...rough, target: { source: 'stock' } }, finish] }, 'a rough on another target', true)
  same({ ...project, operations: [finish, rough] }, 'a rough later in the list', true)
  // An **along** rough over the retained end still precedes the finish on the
  // same model, so the advisory is suppressed even though the finish motion is
  // the same either way.
  same({ ...project, operations: [{ ...rough, rotaryPassDirection: 'along' as const }, finish] },
    'an along rough over a retained end', false)
  const supported = fixture('x', 'around', 20)
  same({ ...supported.project, operations: [supported.project.operations[1]] }, 'a rough held back by its chuck support', true)
  // An enabled rough with a zero stepdown still precedes the finish; the
  // advisory is about the operation list, not about whether the rough emitted
  // motion.
  same({ ...project, operations: [{ ...rough, stepdown: 0 }, finish] }, 'a zero-stepdown rough', false)
  same({ ...project, operations: [{ ...rough, stockToLeaveRadial: 5 }, { ...finish, stockToLeaveRadial: 0 }] },
    'a rough leaving 5 mm above a zero-allowance finish', false)
}

// ---------------------------------------------------------------------------
// 7. The export check (#1045 slice K): around mode turns below the blank's
//    corner envelope because the turn is the cut, so the threat the check
//    exists for is a stale or hand-edited toolpath, not a safe program the
//    generator emitted. An around-mode square operation regenerates its own
//    motion for the current project and must match it move for move; a turning
//    rapid in any mode, and a turn on an along-mode operation, keep the old
//    height refusal.
// ---------------------------------------------------------------------------

console.log('Testing the square around export check...')
{
  const { project, stock } = fixture()
  const [rough, finish] = project.operations
  const roughResult = computeOperationToolpath(project, rough)!.result
  const finishResult = computeOperationToolpath(project, finish)!.result
  assert.deepEqual(roughResult.warnings, [])
  assert.deepEqual(finishResult.warnings, [])
  const codesOf = (result: PostProcessorResult): string[] => result.warnings.map((warning) => warning.code)

  // The freshly generated rough and rough+finish both post.
  const roughProgram = post(project, ROTARY, [{ operation: rough, moves: roughResult.moves }])
  assert.deepEqual(roughProgram.warnings, [], 'the freshly generated around rough posts')
  assert.ok(/A-?\d/.test(roughProgram.gcode), 'and carries A words')
  // #1103 slice ca-d: commanded A is never wrapped, so the posted program grows
  // past one revolution and never rewinds inside the operation (#1091).
  const aWords = [...roughProgram.gcode.matchAll(/A(-?\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]))
  let postedA = 0
  for (const a of aWords) {
    assert.ok(a >= 0, `posted A ${a} is not negative`)
    assert.ok(a >= postedA - 1e-9, `posted A never rewinds (${postedA} -> ${a})`)
    postedA = a
  }
  assert.ok(postedA > 360, `the posted program turns through more than one revolution (A${postedA})`)
  const both = post(project, ROTARY, [
    { operation: rough, moves: roughResult.moves },
    { operation: finish, moves: finishResult.moves },
  ])
  assert.deepEqual(both.warnings, [], 'the freshly generated around rough followed by its finish posts')

  // A **stale** path: the project's stepdown changed after this toolpath was
  // generated, so regenerating now produces different layers than the moves
  // being posted. Refused, naming the stale path rather than the geometry.
  const steeperProject: Project = {
    ...project,
    operations: project.operations.map((entry) =>
      entry.id === rough.id ? { ...entry, stepdown: entry.stepdown + 0.5 } : entry),
  }
  const steeperRough = steeperProject.operations[0]
  assert.deepEqual(
    codesOf(post(steeperProject, ROTARY, [{ operation: steeperRough, moves: roughResult.moves }])),
    ['postSquareAroundToolpathStale'],
    'a toolpath generated before a stepdown change is refused as stale',
  )

  // A **hand-edited** path: one cut point moved 0.5 mm deeper.
  const edited: ToolpathMove[] = structuredClone(roughResult.moves)
  let editedOne = false
  for (const move of edited) {
    if (move.kind !== 'cut' || move.from.a === move.to.a) continue
    move.from = { ...move.from, z: move.from.z - 0.5 }
    editedOne = true
    break
  }
  assert.ok(editedOne, 'the fixture edited one cut point')
  assert.deepEqual(codesOf(post(project, ROTARY, [{ operation: rough, moves: edited }])),
    ['postSquareAroundToolpathStale'], 'a hand-edited around toolpath is refused as stale')

  // **Another operation's** toolpath posted as this one.
  assert.deepEqual(codesOf(post(project, ROTARY, [{ operation: rough, moves: finishResult.moves }])),
    ['postSquareAroundToolpathStale'], "another operation's toolpath is refused as stale")

  // #1045 slice L, finding 4: the comparison is exact. A coordinate edited by
  // 1e-9 mm must not pass; at a number-format rounding boundary such an edit
  // changes the emitted word.
  const nudged = structuredClone(roughResult.moves)
  const nudgedCut = nudged.find((move) => move.kind === 'cut')
  assert.ok(nudgedCut, 'the fixture has a cut to nudge')
  nudgedCut.from = { ...nudgedCut.from, z: nudgedCut.from.z + 1e-9 }
  assert.deepEqual(codesOf(post(project, ROTARY, [{ operation: rough, moves: nudged }])),
    ['postSquareAroundToolpathStale'], 'a 1e-9 mm coordinate edit is refused as stale')

  // The finish now only follows the model, so exporting it without its rough
  // (or with the rough after it) is a legitimate program; the post carries no
  // warning of its own. Regenerate-and-match still proves each posted path is
  // the generator's own current motion.
  assert.deepEqual(codesOf(post(project, ROTARY, [{ operation: finish, moves: finishResult.moves }])),
    [], 'the finish without its rough posts')
  assert.deepEqual(codesOf(post(project, ROTARY, [
    { operation: finish, moves: finishResult.moves },
    { operation: rough, moves: roughResult.moves },
  ])), [], 'a rough exported after the finish posts too')

  // An along-mode operation is never regenerate-and-matched: its turns are all
  // at the travel height. Its generated moves post unchanged.
  const alongFixture = fixture('x', 'along')
  const alongOp = alongFixture.project.operations[0]
  const alongResult = computeOperationToolpath(alongFixture.project, alongOp)!.result
  assert.deepEqual(
    post(alongFixture.project, ROTARY, [{ operation: alongOp, moves: alongResult.moves }]).warnings,
    [],
    'the generated along-mode square rough posts',
  )

  // An along rough followed by an around finish over the retained end: the
  // finish only follows the model, so the mixed program posts both operations.
  const mixedProject: Project = {
    ...project,
    operations: [{ ...rough, rotaryPassDirection: 'along' as const }, finish],
  }
  const mixedFinish = computeOperationToolpath(mixedProject, finish)
  assert.deepEqual(mixedFinish!.result.warnings, [], 'an enabled rough before the finish suppresses the advisory')
  assert.ok(mixedFinish!.result.moves.length > 0, 'and cuts')

  // A turning **rapid** below the travel height is refused in every mode: it
  // removes nothing and swings the standing corner into the cutter.
  const centre = barCentre(stock)
  const travel = barPivotZ(stock) + barMaxRadius(stock) + 1
  const lowTurn: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 20, y: centre, z: travel + 2, a: 0 }, to: { x: 20, y: centre, z: travel + 2, a: 0 } },
    { kind: 'rapid', from: { x: 20, y: centre, z: travel - 2, a: 0 }, to: { x: 20, y: centre, z: travel - 2, a: 30 } },
  ]
  assert.deepEqual(codesOf(post(project, ROTARY, [{ operation: rough, moves: lowTurn }])),
    ['postRotarySquareTurnBelowEnvelope'], 'a turning rapid below the height is refused in around mode')
  assert.deepEqual(codesOf(post(alongFixture.project, ROTARY, [{ operation: alongOp, moves: lowTurn }])),
    ['postRotarySquareTurnBelowEnvelope'], 'a turning rapid below the height is refused in along mode')

  // The same turn as a **cut** on an along-mode operation is refused: only an
  // around-mode cut may turn below the height, and only with the generator's
  // own current motion.
  const alongStock = alongFixture.stock
  const alongCentre = barCentre(alongStock)
  const alongCut: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 20, y: alongCentre, z: travel + 2, a: 0 }, to: { x: 20, y: alongCentre, z: travel + 2, a: 0 } },
    { kind: 'cut', from: { x: 20, y: alongCentre, z: travel - 2, a: 0 }, to: { x: 20, y: alongCentre, z: travel - 2, a: 3 } },
  ]
  assert.deepEqual(codesOf(post(alongFixture.project, ROTARY, [{ operation: alongOp, moves: alongCut }])),
    ['postRotarySquareTurnBelowEnvelope'], 'an along-mode turning cut below the height is refused')

  // A non-rotary operation carrying A keeps its semantic refusal.
  const engrave: Operation = { ...rough, kind: 'follow_line' }
  assert.deepEqual(codesOf(post(project, ROTARY, [{ operation: engrave, moves: roughResult.moves }])),
    ['postSetupOperationRefused'], 'a non-rotary operation carrying A is refused')
}

// ---------------------------------------------------------------------------
// 8. Round bars stay frozen: an around finish on a round bar is not given the
//    square export check, and the same kind of low turning cut still posts there.
// ---------------------------------------------------------------------------

console.log('Testing that round-bar output is untouched...')
{
  const { project, stock } = fixture()
  const roundStock = { ...stock, shape: 'round' as const } as unknown as Project['stock']
  const roundProject: Project = { ...project, stock: roundStock }
  // The round copy drops the square's Around-specific physical guard.
  const operation = roundProject.operations[0]
  const centre = barCentre(roundStock as SquareStock)
  const travel = barPivotZ(roundStock as SquareStock) + 20
  const lowTurn: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 20, y: centre, z: travel + 2, a: 0 }, to: { x: 20, y: centre, z: travel + 2, a: 0 } },
    { kind: 'cut', from: { x: 20, y: centre, z: travel - 2, a: 0 }, to: { x: 20, y: centre, z: travel - 2, a: 3 } },
  ]
  const result = post(roundProject, ROTARY, [{ operation, moves: lowTurn }])
  assert.ok(!result.warnings.some((warning) => warning.code === 'postRotarySquareTurnBelowEnvelope'),
    'a round bar is not given the square turn guard')
}

// ---------------------------------------------------------------------------
// 9. Simulation: the square material path renders around-mode rings (turning
//    cuts). The replay is the same returned-heightfield kernel every blank uses;
//    what is specific here is that a ring's cut moves change A while their
//    along is constant, so the sheet-space replay must lower the cells the ring
//    sweeps and never raise one.
// ---------------------------------------------------------------------------

console.log('Testing the square simulation path on around-mode rings...')
{
  const side = 20
  const frame = aroundFrame(SQUARE)
  const circumference = Math.PI * side
  const sheet = newProject('square around sim', 'mm')
  sheet.stock = {
    ...sheet.stock,
    profile: rectProfile(0, frame.zero - circumference / 2, 40, circumference),
    thickness: side / 2,
  }
  const grid = createSimulationGrid(sheet, { squareBar: { side, frame }, targetLongAxisCells: 96 })
  const rough = generateRotaryRough('sim-rough', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, stepdown: 2, passDirection: 'around',
  }, {})
  // #1103 slice ca-d: commanded A is one-way, so the rough's path runs over many
  // turns. The sheet's own fold (`foldToolpath`, what the app's simulation does)
  // lands every turn back on the first circumference; an unfold-alone replay
  // would walk off the grid.
  const folded = foldToolpath(unwrapToolpath(rough, frame), frame)
  let removed = 0
  for (const move of folded.moves) {
    if (move.kind !== 'cut' && move.kind !== 'plunge') continue
    const result = applyMoveToGrid(grid, move, FLAT.radius, FLAT.type, null)
    removed += result.changedCount
  }
  assert.ok(removed > 0, 'the around rough lowers cells in the square replay')
  let raised = 0
  const baseline = grid.initialTopZ!
  let changed = 0
  for (let i = 0; i < grid.topZ.length; i++) {
    if (grid.topZ[i] > baseline[i] + 1e-9) raised++
    if (baseline[i] - grid.topZ[i] > 1e-9) changed++
  }
  assert.equal(raised, 0, 'no square replay cell is raised')
  assert.ok(changed > 0, 'the replay changed cells')
  // The machined band is lowered and the retained ends keep the blank. The
  // sheet's along coordinate is the project X, offset by the grid origin.
  const alongOrigin = grid.originX
  const alongCount = grid.cols
  const bandCell = Math.min(alongCount - 1, Math.round((20 - alongOrigin) / grid.cellSize - 0.5))
  const endCell = Math.max(0, Math.round((2 - alongOrigin) / grid.cellSize - 0.5))
  const row = Math.floor(grid.rows / 2)
  const bandZ = grid.topZ[row * grid.cols + bandCell]
  const endZ = grid.topZ[row * grid.cols + endCell]
  assert.ok(bandZ < endZ - 0.5, `the machined band is lower than the retained end (${bandZ} < ${endZ})`)
  console.log(`  around replay lowered ${changed} cells, none raised; band ${bandZ.toFixed(3)} vs end ${endZ.toFixed(3)}`)
}

console.log('rotary square around passes tests passed')
