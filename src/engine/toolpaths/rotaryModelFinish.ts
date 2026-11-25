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

import { barCentre, barPivotZ } from '../../types/barStock'
import type { BarStock } from '../../types/project'
import { convertLength } from '../../utils/units'
import {
  buildContinuousHelix,
  type ContinuousBandInput,
  type ContinuousHelix,
  type ContinuousHelixSpend,
  walkContinuousBand,
} from './rotaryContinuous'
import {
  alongCoordinate,
  boundsOf,
  continuousHelixStepover,
  continuousHelixStubFloor,
  emitRotaryRuns,
  retainedStubStepForced,
  ringRuns,
  type RotaryLinkStep,
  type RotaryRun,
} from './rotaryModelMotion'
import type { RotaryFinishParams } from './rotaryModelParams'
import { continuousPathInsideRegion, rotaryRegionContains, rotaryRegionSegmentContains } from './rotaryModelRegion'
import { AROUND_RAISE_TOLERANCE_MM, mergeCollinearCuts, raiseShortAroundSegments } from './rotaryModelSimplify'
import { usesSquareBlankRules } from './rotaryModelTargetGeometry'
import { CLEANUP_MIN_STEP_DEG, type RotaryTargets } from './rotaryModelTargets'
import { turnAngle } from './rotaryModelTargetSampling'
import type { RotarySampleOptions } from './rotarySampling'
import { rotaryTravelZ } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import type { ToolpathWarning } from './warningCodes'

/**
 * How the continuous helix reads its rows, for the rough and the finish alike
 * (#1173/#1177): the exact footprint maximum, with the flat's lateral pad (see
 * below). #1190: a square blank's around pass reads exactly too; only an along
 * pass keeps the conservative read (`usesSquareBlankRules`).
 */
export function continuousExactRead(
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
): { readExactRows?: true; exactTipPad?: number } {
  if (usesSquareBlankRules(stock, params)) return {}
  return {
    readExactRows: true,
    ...(tool.type === 'ball_endmill' ? {} : { exactTipPad: params.requestedCellSize * 1.25 }),
  }
}

/**
 * The continuous helix's operation-wide input for the finish (#1103 slices ca-c
 * and ca-g).
 *
 * It runs on the prep the ring grid was sampled with -- the same mesh, the
 * stock-to-leave-enlarged tool, the retained-wall metadata, the requested cell
 * size and the one shared workspace -- so the helix reads exactly the surface
 * the rings would and pays no second cross-section, strip plan or raster. `null`
 * when the targets carry no prep (a refusal/cancellation never reaches here),
 * and the band walk then keeps every ring of the band.
 *
 * A **square blank** is admitted since #1103 slice ca-j on the finish's own
 * rules: the band is a whole ring of the model at every angle (the ring grid's
 * eligibility, unchanged), the retained ends are floored per pose with the ring
 * path's own stub contact, and its turns overlap so the blank's corner shell
 * between them is cleared (`continuousHelixStepover`). A round bar has no such
 * floor and no corner shell, so its input is byte for byte what it was.
 *
 * The band, the A cursor and the band's shared spend are left to each attempt:
 * slice ca-g splits a band that cannot be verified everywhere, and each piece
 * opens at the A cursor of the moment it is emitted.
 */
function continuousFinishInput(
  sampling: RotaryTargets,
  params: RotaryFinishParams,
  tool: NormalizedTool,
  warnings: ToolpathWarning[],
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
): ContinuousBandInput | null {
  // #1237: the helix is the operation's choice; off, no band is attempted.
  if (params.continuousHelix !== true) return null
  const prep = sampling.prep
  if (prep === null) return null
  const stubFloor = continuousHelixStubFloor(prep.stock, tool, params, sampling.bandOverrun)
  return {
    prep,
    tool,
    stepover: continuousHelixStepover(prep.stock, tool, params.stepover),
    sampleSpacing: params.sampleSpacing,
    stockToLeave: sampling.stockToLeave,
    // #1173: a round bar's helix reads the exact footprint maximum, the read
    // its wall-foot ring and its neighbour columns already take. The
    // conservative cell rise is one value per angle and saturates at a whole
    // cell on any shoulder, so the helix rode that cell above the target over
    // the whole shank (0.0098 in on Frank's bolt) while the ring beside it sat
    // at target + leave. #1190: a square blank's around pass reads it too; its
    // stub floors are closed-form and never needed the map.
    // #1177: a ball takes that read too. It used to be withheld from every
    // cutter but a flat, and the conservative cell read then over-read a ball by
    // its disc maximum -- 0.21 mm at 25 degrees on Frank's bolt, the same band
    // the exact read removed from the neighbour columns. The pad below is the
    // **flat's** lateral slack, grown on the disc: a ball reads its own sphere,
    // where the pad lifts the tip by the pad itself on a level facet, so a ball
    // takes none. The distance between two samples is covered by the chord
    // instead: a ball's exact envelope is convex in the angle within a facet
    // (and C1 across a vertex), so a straight G1 chord between two exact tips
    // lies at or **above** the envelope -- there is nothing to pad for, and the
    // measured chord at the operation's own step stays inside 0.002 mm.
    ...continuousExactRead(prep.stock, tool, params),
    warnings,
    ...(stubFloor !== undefined ? { stubFloor } : {}),
    ...(hooks.shouldStop !== undefined ? { shouldStop: hooks.shouldStop } : {}),
  }
}

/**
 * The finish's motion from sampled targets (#1115 slice p-d1).
 *
 * Both drivers end here, so the emission -- and therefore the moves, the
 * warnings and the merged output -- cannot differ between them; only how the
 * rows were produced can.
 */
export function finishFromTargets(
  operationId: string,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
  sampling: RotaryTargets,
  warnings: ToolpathWarning[],
): ToolpathResult {
  if (sampling.refusal) {
    return { operationId, moves: [], warnings: [{ code: sampling.refusal, params: { operation: operationId } }], bounds: null }
  }
  if (sampling.stopped) return { operationId, moves: [], warnings: [], bounds: null }
  const { angles, along } = sampling
  const pivot = barPivotZ(stock)
  const centre = barCentre(stock)
  const tolerance = convertLength(0.001, 'mm', tool.units)
  // Every move between runs -- a turning link, the retract off a run, or the
  // traverse to the next run -- travels at the blank's largest surface plus a
  // clearance, so it always clears the model and the standing stock between two
  // pass angles. The blank's turning envelope reaches its corner radius from
  // the pivot at some angle, so that -- not the inscribed radius -- is the height
  // nothing may travel below; on a round bar the two are equal. `safeRadius`
  // does not cap it: a rapid height only a fifth of a millimetre above the bar
  // would otherwise replace the clearance, and the clearance is the whole
  // reason the between-run moves are safe. The operation's first positioning
  // move and its final retract go to the higher of `safeRadius` and that travel
  // height.
  const travelZ = rotaryTravelZ(stock, tool.units)
  const safeZ = Math.max(pivot + params.safeRadius, travelZ)
  // Sample `i` of a pass sits at `along[rowIndexAt(k, i)]`: even passes run from
  // alongStart to alongEnd, odd ones back, so the row index of position `i` is
  // mirrored on a return pass. Everything that reads a height must use the same
  // index the position uses -- reading `tipRadius[k][i]` on a return pass gives
  // each position the height of its mirror, which only a model symmetric along
  // the bar hides.
  const rowIndexAt = (pass: number, positionIndex: number): number =>
    pass % 2 === 0 ? positionIndex : along.length - 1 - positionIndex
  const tipAt = (pass: number, positionIndex: number): number => sampling.tips[pass][rowIndexAt(pass, positionIndex)]
  const point = (alongPosition: number, tip: number, angle: number): ToolpathPoint => stock.axis === 'x'
    ? { x: alongPosition, y: centre, z: pivot + tip, a: angle }
    : { x: centre, y: alongPosition, z: pivot + tip, a: angle }
  const alongAt = (pass: number, positionIndex: number): number => along[rowIndexAt(pass, positionIndex)]
  const forceStep = retainedStubStepForced(stock, params, tool, sampling.bandOverrun)
  // #1096: a region limits where the tool may cut. Every sample whose tool
  // position falls outside it is dropped before it can become a cut, so a ring
  // or pass splits into the runs that are inside. The mask is null when the
  // operation targets no region, and then nothing below reads it -- the motion
  // is exactly the pre-region output.
  const region = params.region ?? null
  const insideRegion = region === null
    ? null
    : (alongPosition: number, angle: number) => rotaryRegionContains(region, stock, alongPosition, angle)
  // #1093: link consecutive full rings with a feed along the bar at their
  // shared end angle, following the model at that angle through the dense link
  // row. The finish assumes no rough: the height is the model's own safe tip,
  // never the standing blank. A `NaN` anywhere on the span means the link
  // cannot stay down (there is no surface under the tool there), so the old
  // retract/rapid/plunge handles it; the same happens for a split ring (the
  // caller marks a ring that emitted more than one run as not ended at its end),
  // a link that changes A, and an operation whose dense row would exceed the
  // work budget (no row). Only the operation's first positioning move and its
  // final retract go to the rapid height.
  const linkRowAt = sampling.linkRowAt
  const followLink = (from: ToolpathPoint, to: ToolpathPoint): readonly RotaryLinkStep[] | null => {
    if (from.a === undefined || to.a === undefined) return null
    // A surface link keeps one angle *exactly*. A0 and A360 are the same
    // physical rotation, but a move between them is a full commanded turn; an
    // A-changing link stays on the old travel-height cut rule (or its retract).
    if (from.a !== to.a) return null
    const linkRow = linkRowAt(from.a)
    if (!linkRow) return null
    const fromAlong = alongCoordinate(stock, from)
    const toAlong = alongCoordinate(stock, to)
    if (!(toAlong > fromAlong)) return null
    // #1096 review (P2): this link is a **cut** from `fromAlong` to `toAlong`
    // at one angle, so the **whole span** must be inside the region -- not just
    // the dense row's sample points. A 0.02 mm excluded strip between two
    // samples was stepped over by a link that then cut it, because membership
    // was only ever asked at the samples. The mask's own boundary geometry
    // decides the segment; `null` means a hand-built mask with point membership
    // only, which keeps the sample check below.
    const linkAngle = turnAngle(from.a)
    if (region !== null && insideRegion !== null) {
      if (!insideRegion(fromAlong, linkAngle) || !insideRegion(toAlong, linkAngle)) return null
      if (rotaryRegionSegmentContains(region, stock, fromAlong, toAlong, linkAngle) === false) return null
    }
    const points: RotaryLinkStep[] = []
    for (let i = 0; i < linkRow.along.length; i++) {
      const x = linkRow.along[i]
      if (x <= fromAlong + 1e-12 || x >= toAlong - 1e-12) continue
      // A point-only mask still gets the old per-sample test; an exact segment
      // test above already subsumes it.
      if (insideRegion !== null && !insideRegion(x, linkAngle)) return null
      const tip = linkRow.tips[i]
      if (!Number.isFinite(tip)) return null
      points.push({ to: point(x, tip, from.a), kind: 'cut' })
    }
    points.push({ to, kind: 'cut' })
    return points
  }
  const moves: ToolpathMove[] = []
  let here: ToolpathPoint | undefined
  let previousEndedAtEnd = false
  // #1177: the start-face shoulder-cleanup rings, in emission order. Declared
  // here so the merge protection below can see them.
  let startClean: readonly number[] = []
  if (params.passDirection === 'around') {
    // #1103 slice ca-c: A never reverses. Every ring turns the same way, and the
    // next ring continues from the angle the last one reached instead of
    // rewinding -- A grows by 360 per ring (or by the helix's own turns) and is
    // never wrapped modulo 360; the A range is the controller's job (#1091).
    //
    // A **continuous helix** replaces the rings wherever a whole band of rings
    // can be cut without interruption: every sample of the ring is the model
    // under the tool, and the operation's region (when it has one) contains the
    // whole band. `buildContinuousHelix` samples the actual combined (along, A)
    // poses and closes the band with a complete ring at each axial end, so the
    // band is one run with no stop. Everything else -- a partial ring, a model
    // gap, a region that trims the ring, a helix whose budget ran out -- keeps
    // its rings, now forward-only, with the emitter's safe transition between
    // them. A **square blank** is helixed too since #1103 slice ca-j, on the
    // finish's own rule: its band must be a whole ring of the model at every
    // angle, and the builder floors each pose off the retained ends with the
    // ring path's own stub contact and overlaps its turns so the blank's corner
    // shell between them is cleared by the cutter's flank. A finishing pass has
    // no layer, so the blank's material-touch gate does not apply here (the
    // finish follows the model wherever the ring grid does).
    //
    // #1103 slice ca-g splits a band the attempt could not verify everywhere:
    // the rings around the unverifiable spans, a helix on each run between them,
    // all of it charged against the band's one work budget and linked through
    // these same rules (`walkContinuousBand`).
    //
    // Only a full ring whose last angle is A360 and whose next ring starts at
    // A0 of the next turn keeps #1093's surface link: those two commands are
    // numerically equal, which is exactly the link's constant-A precondition. A
    // region-clipped ring, or one the model splits, ends at an interior angle
    // and its next ring starts at the other boundary of the arc -- a full turn
    // apart -- so it falls back to the existing travel-height transition.
    const last = angles.length - 1
    interface AroundRing {
      /** The ring's cut points at the sampled angles, shifted by the A cursor at emission. */
      readonly runs: RotaryRun[]
      /** Every sample is the model under the tool, and the region contains them all. */
      readonly eligible: boolean
    }
    const rings: AroundRing[] = []
    for (let ring = 0; ring < along.length; ring++) {
      if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
      const samples: (ToolpathPoint | null)[] = []
      // #1096 slice D: the region's own membership on this ring, counted apart
      // from the model's `NaN` samples, so a ring the *region boundary* trimmed
      // is not confused with a ring the model split.
      let regionPieces = 0
      let regionStart = -1
      let regionEnd = -1
      let regionGap = false
      let inRegion = false
      let allCovered = true
      for (let step = 0; step <= last; step++) {
        const tip = sampling.tips[step][ring]
        const finite = Number.isFinite(tip)
        const inside = insideRegion === null || insideRegion(along[ring], angles[step])
        if (!finite || !inside) allCovered = false
        if (inside) {
          if (!inRegion) {
            regionPieces++
            if (regionStart < 0) regionStart = step
          }
          inRegion = true
          regionEnd = step
          if (!finite) regionGap = true
        } else {
          inRegion = false
        }
        samples.push(finite && inside ? point(along[ring], tip, angles[step]) : null)
      }
      const runs = ringRuns(samples)
      // A ring the region cuts to **one** contiguous interior arc, with no model
      // gap inside that arc, is the ring trimmed to the region -- not a split
      // ring. Mark its run as both the start and the end of the pass it cuts:
      // the next forward ring also starts at the arc's first boundary angle, one
      // full turn later, so the emitter attempts the surface link and the
      // constant-A check refuses it unless the arc happens to close the turn. A
      // region that wraps the A0/A360 seam arrives as **two** pieces (the arc is
      // split by the ring's own ends) and is deliberately left with today's
      // retract, as is a ring split by a model gap.
      if (regionPieces === 1 && !regionGap && runs.length === 1
        && regionStart > 0 && regionEnd < last) {
        runs[0] = { ...runs[0], atStart: true, atEnd: true }
      }
      rings.push({ runs, eligible: allCovered })
    }
    // The A cursor: the commanded angle every point of the next unit is built
    // from. A ring advances it by one turn, a helix by its own complete turns.
    let angleBase = 0
    // #1155 rn-d: a wall-foot column is cut as its own ring, and no helix band
    // starts, ends or runs through it. The foot is the position from which the
    // tool first follows the target's own surface, so a band crossing it would
    // interpolate its turns across the step -- exactly the stair-step ledge the
    // ring exists to remove.
    const wallFootAt = sampling.ringOnlyIndices.length > 0
      ? new Set(sampling.ringOnlyIndices)
      : null
    // #1177: a shoulder-cleanup ring is cut on **thinned** angular grids: the
    // refined grid's 0.11-0.22 degree steps by the neighbour's corners would be
    // new blocks under 10 ms on top of the first ring's. The ring is also
    // emitted **immediately after the first ring**
    // rather than last: the band face is the innermost along position, so a
    // ring emitted last needs a retract/rapid/plunge back to it (a new G0 Z
    // lift), while the move back from the first ring is a short cut along the
    // neighbour's surface and then straight into the ring at the same angle.
    const cleanAt = sampling.shoulderCleanIndices.length > 0
      ? new Set(sampling.shoulderCleanIndices)
      : null
    // The first ring the operation itself cuts. Every cleanup index below it is
    // a **start** face (the band face the #1177 ring cleans); the ones above are
    // an end face, which keeps the old last-position emission.
    let firstNormal = 0
    while (firstNormal < along.length && cleanAt !== null && cleanAt.has(firstNormal)) firstNormal++
    startClean = sampling.shoulderCleanIndices.filter((index) => index < firstNormal)
    const endClean = sampling.shoulderCleanIndices.filter((index) => index > firstNormal)
    // The cleanup ring's cut points: the start face's own uniform rings when the
    // sampler built them (exact tips at `CLEANUP_MIN_STEP_DEG`, one per spring
    // pass); the refined-grid fallback keeps an end face (and a square blank,
    // which needs its stub floor) as it was.
    const cleanupRuns = (index: number, turnBase: number): RotaryRun[] => {
      const samples: (ToolpathPoint | null)[] = []
      const custom = sampling.shoulderCleanRings.filter((ring) => ring.index === index)
      if (custom.length > 0) {
        // Three spring passes over the column, each on a grid a third of a step
        // on from the last (see `RotaryShoulderCleanRing`). The exact read sets
        // each pose's tip by the **uphill rim** of its disc, so a pass leaves
        // the material its rim could not reach -- and a forward ring can only
        // spend the one pose per angle whose rim reaches furthest, so a pass
        // lowers the shoulder by a single landing step. The passes that follow,
        // on the grids between the last one's samples, spend the poses it could
        // not: three passes come within a third of a step's landing of the
        // flat's plane without shortening a single block.
        //
        // Every turn runs in the same direction as every other ring; each ends
        // where the next begins, so nothing retracts, and the last ends on the
        // turn itself, which is the angle the next unit starts at. The seam
        // between two passes is one and a third steps, never less than one.
        for (const [position, ring] of custom.entries()) {
          const turnAngleBase = turnBase + 360 * position
          for (let k = 0; k < ring.angles.length; k++) {
            const angle = ring.angles[k]
            const tip = ring.tips[k]
            const inside = insideRegion === null || insideRegion(along[index], angle)
            samples.push(Number.isFinite(tip) && inside
              ? point(along[index], tip, angle + turnAngleBase)
              : null)
          }
        }
        return ringRuns(samples)
      }
      let lastAngle = Number.NEGATIVE_INFINITY
      for (let k = 0; k < angles.length; k++) {
        const angle = angles[k]
        if (angle - lastAngle < CLEANUP_MIN_STEP_DEG - 1e-9) continue
        lastAngle = angle
        const tip = sampling.tips[k][index]
        const inside = insideRegion === null || insideRegion(along[index], angle)
        samples.push(Number.isFinite(tip) && inside
          ? point(along[index], tip, angle + turnBase)
          : null)
      }
      return ringRuns(samples)
    }
    // #1177: the cleanup ring is entered **back** from the first ring's end to
    // the band face at one angle. The first ring's own exact read covers the
    // whole span the move steps back over, and both end tips stand at that
    // read, so the straight cut skims the neighbour's flat instead of retracting
    // off it. It is a cut move, not a rapid, so no G0 Z lift is added. The
    // transition **out** of the cleanup ring is forward, so the ordinary surface
    // link (`followLink`) already follows the model from the band face to the
    // next ring -- a lift is only needed when a ring cannot be linked.
    let cleanupEntries = 0
    const cleanupLink = (from: ToolpathPoint, to: ToolpathPoint): readonly RotaryLinkStep[] | null => {
      if (cleanupEntries <= 0) return followLink(from, to)
      // A full cleanup ring starts at the preceding ring's own end angle;
      // anything else (a split ring the region trimmed) keeps the ordinary
      // transition, and the remaining entries stay for the runs still to come.
      if (from.a !== to.a) return followLink(from, to)
      cleanupEntries -= 1
      return [{ to, kind: 'cut' }]
    }
    // One forward-only ring at the cursor's angle. A split ring is partial arcs:
    // its last run can still reach the ring end, but the issue's contract is
    // that a split ring retracts rather than feeding to the next ring. Only a
    // ring that emitted one run may link -- a region-clipped ring's single run
    // is marked above, so it may.
    const emitRing = (index: number, cleanup?: readonly number[]): void => {
      const runs = rings[index].runs.map((run) => ({
        ...run,
        points: run.points.map((sample) => ({ ...sample, a: (sample.a ?? 0) + angleBase })),
      }))
      let combined: RotaryRun[] = runs
      let cleanupTurns = 0
      if (cleanup !== undefined && cleanup.length > 0) {
        // The cleanup points carry their own turn offsets -- one turn per spring
        // pass, starting after the first ring's (`angleBase + 360`); the
        // emitter's base is the first ring's.
        const clean: RotaryRun[] = []
        let turnBase = 360
        for (const cleanupIndex of cleanup) {
          for (const run of cleanupRuns(cleanupIndex, turnBase)) {
            clean.push({
              ...run,
              points: run.points.map((sample) => ({ ...sample, a: (sample.a ?? 0) + angleBase })),
            })
          }
          turnBase += 360 * Math.max(1, sampling.shoulderCleanRings.filter((ring) => ring.index === cleanupIndex).length)
        }
        cleanupEntries = clean.length
        cleanupTurns = turnBase - 360
        combined = [...runs, ...clean]
      }
      // The first run's link is skipped by the emitter itself when there is no
      // position yet; `true` here is what lets the cleanup run that follows the
      // first ring take its cut transition instead of the travel-height one.
      const emitted = emitRotaryRuns(moves, here, combined, safeZ, travelZ,
        cleanup === undefined ? previousEndedAtEnd : true, forceStep, pivot, cleanupLink)
      here = emitted.here
      previousEndedAtEnd = emitted.endedAtEnd && (combined.length <= 1 || cleanup !== undefined)
      // The first ring's turn plus every cleanup ring's spring passes.
      angleBase += 360 + cleanupTurns
      // The entry link is attempted inside the call above; if it was not (a
      // region-split cleanup ring) the count must not leak into the next ring's
      // forward link.
      cleanupEntries = 0
    }
    const finishBand = continuousFinishInput(sampling, params, tool, warnings, hooks)
    let ring = 0
    while (ring < along.length) {
      if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
      // #1155 rn-d: a wall-foot ring is cut as its own ring, never as a helix
      // boundary. The helix samples every pose on the operation's own mesh, and
      // the conservative read lifts a pose at the foot onto the neighbour it is
      // tangent to -- so a helix starting there would ride the wall for one turn
      // and leave exactly the ledge the ring removes.
      if (cleanAt !== null && cleanAt.has(ring)) {
        ring++
        continue
      }
      if (ring === firstNormal && startClean.length > 0) {
        // #1177: the cleanup rings are cut right after the first ring, through
        // the cut transitions above. They are not part of a helix band.
        emitRing(ring, startClean)
        ring++
        continue
      }
      if (wallFootAt !== null && wallFootAt.has(ring)) {
        emitRing(ring)
        ring++
        continue
      }
      if (rings[ring].eligible) {
        let band = ring
        while (band + 1 < along.length && rings[band + 1].eligible
          && (wallFootAt === null || !wallFootAt.has(band + 1))
          && (cleanAt === null || !cleanAt.has(band + 1))) band++
        // A band of one ring is just a ring: a helix needs an axial step to turn
        // into a pitch, and its two complete end rings would otherwise add a
        // full turn over no advance at all.
        if (band > ring) {
          // #1103 slice ca-g: the band is no longer helix-or-nothing. A band the
          // helix can verify everywhere is one helix; a band it cannot verify
          // **everywhere** is split at the unverifiable spans -- rings there,
          // helices on the runs between them -- and only the refusals that say
          // nothing about where to split (a spent budget, cancellation, no model
          // under the tool, the region) keep the whole band's rings. The walk
          // charges every attempt against one shared budget, so the split cannot
          // cost more speculative work than the single attempt did. #1237: a
          // band priced over budget is halved instead, each piece with its own
          // budget and the refinement reserve the walk asks for.
          const walked = walkContinuousBand({
            along,
            attempt: (
              from: number, to: number, spent: ContinuousHelixSpend, reserveRefinement: boolean,
            ): ContinuousHelix | null =>
              finishBand === null ? null : buildContinuousHelix({
                ...finishBand,
                band: { start: along[from], end: along[to] },
                startAngle: angleBase,
                spent,
                ...(reserveRefinement ? { reserveRefinement } : {}),
              }),
            // A region that trims the piece keeps that range's rings: it is not
            // a tolerance refusal, so the walk does not split around it.
            accept: (helix) => region === null
              || continuousPathInsideRegion(region, stock, helix.points, angleBase),
            emitHelix: (helix) => {
              const emitted = emitRotaryRuns(
                moves, here, [{ points: helix.points, atStart: true, atEnd: true }],
                safeZ, travelZ, previousEndedAtEnd, forceStep, pivot, cleanupLink,
              )
              here = emitted.here
              previousEndedAtEnd = emitted.endedAtEnd
              angleBase += 360 * (helix.turns + 2)
            },
            emitRing,
            ...(hooks.shouldStop !== undefined ? { shouldStop: hooks.shouldStop } : {}),
          }, ring, band)
          if (walked.stopped) return { operationId, moves: [], warnings: [], bounds: null }
          ring = band + 1
          continue
        }
      }
      emitRing(ring)
      ring++
    }
    // #1177: an **end**-face cleanup ring (the target ends inside a neighbour's
    // span) keeps the last-position emission: it is the furthest along position,
    // so the move to it is forward and it is the operation's last cut.
    for (const index of endClean) {
      if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
      emitRing(index)
    }
  } else {
    for (let k = 0; k < angles.length; k++) {
      if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
      // A `NaN` sample has no model under the tool: the finish follows the model,
      // and removing waste is the rough's job, so it is not cut. Each pass is the
      // runs of finite samples; a pass with none emits nothing at all. #1096: a
      // sample outside the operation's region is not cut for the same reason.
      const cutsAt = (i: number): boolean => Number.isFinite(tipAt(k, i))
        && (insideRegion === null || insideRegion(alongAt(k, i), angles[k]))
      const runs: RotaryRun[] = []
      let i = 0
      while (i < along.length) {
        if (!cutsAt(i)) { i++; continue }
        const start = i
        while (i + 1 < along.length && cutsAt(i + 1)) i++
        const end = i
        const points: ToolpathPoint[] = []
        for (let j = start; j <= end; j++) points.push(point(alongAt(k, j), tipAt(k, j), angles[k]))
        runs.push({ points, atStart: start === 0, atEnd: end === along.length - 1 })
        i++
      }
      const emitted = emitRotaryRuns(moves, here, runs, safeZ, travelZ, previousEndedAtEnd, forceStep)
      here = emitted.here
      previousEndedAtEnd = emitted.endedAtEnd
    }
  }
  if (here) moves.push({ kind: 'rapid', from: here, to: { ...here, z: safeZ } })
  // An around pass's moves are straight on the controller in (along, A, Z), so
  // the merge may drop the interior points of a ring; along mode keeps the old
  // merge and its byte-identical output (#1045 slice G).
  // #1177: the finish's cleanup rings are cut on their own grids, whose steps
  // are inside the merge's tolerance of one chord; merging them would put the
  // ring back on the coarse path and the scallop above the neighbour's flat back
  // over 0.05 mm. Only those along positions are protected -- every other run
  // merges exactly as before.
  const cleanFaces = new Set(startClean.map((index) => along[index]))
  const protectedPoint = cleanFaces.size > 0
    ? (candidate: ToolpathPoint): boolean => cleanFaces.has(alongCoordinate(stock, candidate))
    : undefined
  const merged = mergeCollinearCuts(moves, tolerance,
    params.passDirection === 'around' ? pivot : undefined, protectedPoint)
  const finalMoves = params.passDirection === 'around'
    ? raiseShortAroundSegments(merged.moves, sampling.baseAngleStep,
      convertLength(AROUND_RAISE_TOLERANCE_MM, 'mm', tool.units), convertLength(0.001, 'mm', tool.units),
      protectedPoint)
    : merged.moves
  return { operationId, moves: finalMoves, warnings, bounds: boundsOf(finalMoves) }
}
