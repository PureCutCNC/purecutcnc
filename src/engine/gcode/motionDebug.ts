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
 * Pure helpers for the exported-motion debug view (issue #356): eligibility,
 * the exported-path-vs-source diagnostic, and the planar debug-model builder
 * that turns a generation trace + parsed G-code into the three overlay layers.
 */

import type { MachineOrigin } from '../../types/project'
import type { ToolpathGenerationTrace, ToolpathMove, ToolpathPoint } from '../toolpaths/types'
import type { OperationMotionTrace, MachineDefinition } from './types'
import type { ParsedGcodeMove, ParsedGcodeMotion } from './gcodeMotionParser'
import { machineToProjectPoint, machineToProjectFlipsArcDirection } from './utils'

const Z_EPS = 1e-6

// ── Eligibility ───────────────────────────────────────────────

export type IneligibleReason = 'drilling' | 'noCutMoves' | 'variableZ'

export interface ExportedMotionEligibility {
  eligible: boolean
  reason?: IneligibleReason
}

function roundZ(z: number): number {
  return Math.round(z * 1e6) / 1e6
}

/**
 * Whether an operation's generated motion is viewable in this release: a
 * non-empty planar cutting trace with discrete constant-Z cutting levels.
 * Derived purely from the motion (not an operation-name allow-list), so it
 * admits pockets, edge routes, and constant-depth follow-line work, and
 * excludes drilling (drillCycles), empty paths, and variable-Z cuts (V-carve,
 * ramping surface paths whose cut moves span Z).
 */
export function getExportedMotionEligibility(trace: ToolpathMove[] | { moves: ToolpathMove[]; drillCycles?: unknown[] }): ExportedMotionEligibility {
  const moves = Array.isArray(trace) ? trace : trace.moves
  const drillCycles = Array.isArray(trace) ? undefined : trace.drillCycles
  if (drillCycles && drillCycles.length > 0) {
    return { eligible: false, reason: 'drilling' }
  }
  const cutMoves = moves.filter((m) => m.kind === 'cut')
  if (cutMoves.length === 0) {
    return { eligible: false, reason: 'noCutMoves' }
  }
  for (const m of cutMoves) {
    if (Math.abs(m.from.z - m.to.z) > Z_EPS) {
      return { eligible: false, reason: 'variableZ' }
    }
  }
  const zSet = new Set(cutMoves.map((m) => roundZ(m.from.z)))
  if (zSet.size === 0) {
    return { eligible: false, reason: 'noCutMoves' }
  }
  return { eligible: true }
}

// ── Debug model types ────────────────────────────────────────

export interface XYP {
  x: number
  y: number
}

export interface MotionDebugSegment {
  kind: 'linear' | 'arc'
  from: XYP
  to: XYP
  center?: XYP
  radius?: number
  clockwise?: boolean
  largeArc?: boolean
  /** Cutting Z (project) this segment lies in. */
  z: number
  /** True for cut/plunge/lead moves; false for rapids/retracts. */
  cutting: boolean
}

export type MotionDebugLayerId = 'generated' | 'optimized' | 'exported'

export interface MotionDebugLayer {
  id: MotionDebugLayerId
  segments: MotionDebugSegment[]
}

export interface MotionDebugMetrics {
  rawMoveCount: number
  optimizedMoveCount: number
  removedMoveCount: number
  emitted: { linear: number; rapid: number; arcCw: number; arcCcw: number }
}

export interface MotionDebugDiagnostic {
  state: 'verified' | 'warning'
  warnings: { kind: string; message: string }[]
}

export interface ZLevelStats {
  z: number
  exportedSegs: number
  warnings: MotionDebugDiagnostic['warnings']
}

export interface ExportedMotionDebugModel {
  layers: Record<MotionDebugLayerId, MotionDebugLayer>
  /** Discrete cutting-Z levels in project space, in machine (first-encounter) order. */
  zLevels: number[]
  /** Per-Z-level stats: exported segment count and warnings at each level. */
  zLevelStats: ZLevelStats[]
  metrics: MotionDebugMetrics
  diagnostic: MotionDebugDiagnostic
  bounds: { minX: number; maxX: number; minY: number; maxY: number } | null
}

// ── Segment construction ─────────────────────────────────────

/** Project-coord segment from a ToolpathMove (generated/optimized layers). */
function segmentFromMove(move: ToolpathMove): MotionDebugSegment {
  return {
    kind: 'linear',
    from: { x: move.from.x, y: move.from.y },
    to: { x: move.to.x, y: move.to.y },
    z: move.from.z,
    cutting: move.kind !== 'rapid',
  }
}

/** Project-coord segment from a parsed G-code move (machine → project). */
function segmentFromParsed(move: ParsedGcodeMove, origin: MachineOrigin, definition: MachineDefinition): MotionDebugSegment {
  const fromProj = machineToProjectPoint(move.from, origin, definition)
  const toProj = machineToProjectPoint(move.to, origin, definition)
  const cutting = move.kind !== 'rapid'
  if (move.kind === 'arc') {
    const centerProj = machineToProjectPoint(
      { x: move.center.x, y: move.center.y, z: move.from.z },
      origin,
      definition,
    )
    // An odd machine axis mapping (single mirrored axis, X/Y swap) reverses
    // the arc's visual direction between machine and project space; invert
    // clockwise so the SVG sweep renders the true exported path.
    const clockwise = machineToProjectFlipsArcDirection(definition)
      ? !move.clockwise
      : move.clockwise
    return {
      kind: 'arc',
      from: { x: fromProj.x, y: fromProj.y },
      to: { x: toProj.x, y: toProj.y },
      center: { x: centerProj.x, y: centerProj.y },
      radius: move.radius,
      clockwise,
      largeArc: move.largeArc,
      // z in PROJECT coords (machine→project), so the exported layer aligns
      // with the optimized toolpath's project-Z levels for filtering.
      z: fromProj.z,
      cutting,
    }
  }
  return {
    kind: 'linear',
    from: { x: fromProj.x, y: fromProj.y },
    to: { x: toProj.x, y: toProj.y },
    z: fromProj.z,
    cutting,
  }
}

// ── Diagnostic comparison ────────────────────────────────────

interface RefSegment {
  kind: 'linear' | 'arc'
  from: ToolpathPoint
  to: ToolpathPoint
  center?: { x: number; y: number }
  clockwise?: boolean
}

/** Reference non-rapid segment sequence from the postprocessor trace (machine coords). */
function refSegmentsFromTrace(trace: OperationMotionTrace): RefSegment[] {
  const out: RefSegment[] = []
  if (trace.tryFit) {
    // Linear descriptors only carry their endpoint, so each linear's `from`
    // is the previous emitted point — tracked across rapids (which are
    // excluded from the comparison) so the first non-rapid after a rapid
    // gets the correct start, not its own endpoint.
    let prevPoint: ToolpathPoint | null = null
    for (const d of trace.descriptors) {
      if (d.kind === 'linear') {
        if (d.moveKind === 'rapid') {
          prevPoint = d.point
          continue
        }
        const from = prevPoint ?? d.point
        out.push({ kind: 'linear', from, to: d.point })
        prevPoint = d.point
      } else {
        out.push({
          kind: 'arc',
          from: d.startPoint,
          to: d.endPoint,
          center: { x: d.startPoint.x + d.centerOffsets.i, y: d.startPoint.y + d.centerOffsets.j },
          clockwise: d.clockwise,
        })
        prevPoint = d.endPoint
      }
    }
  } else {
    for (const m of trace.machineMoves) {
      if (m.kind === 'rapid') continue
      out.push({ kind: 'linear', from: m.from, to: m.to })
    }
  }
  return out
}

/** Reference non-rapid segment sequence from the parsed G-code (machine coords). */
function refSegmentsFromParsed(parsed: ParsedGcodeMotion): RefSegment[] {
  const out: RefSegment[] = []
  for (const move of parsed.moves) {
    if (move.kind === 'rapid') continue
    if (move.kind === 'arc') {
      out.push({
        kind: 'arc',
        from: move.from,
        to: move.to,
        center: move.center,
        clockwise: move.clockwise,
      })
    } else {
      out.push({ kind: 'linear', from: move.from, to: move.to })
    }
  }
  return out
}

function ptEqXYZ(a: ToolpathPoint, b: ToolpathPoint, tol: number): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.z - b.z) <= tol
}

/**
 * Compare the parsed exported motion against the postprocessor source trace.
 * Endpoint continuity per non-rapid segment plus arc-centre/radius/direction
 * agreement, assessed against the configured export tolerance. The parser's own
 * unsupported/failed status is carried through so a partial parse is never
 * reported as verified.
 */
export function compareMotionTraces(
  parsed: ParsedGcodeMotion,
  postprocessorTrace: OperationMotionTrace,
  tolerance: number,
): MotionDebugDiagnostic {
  const warnings: MotionDebugDiagnostic['warnings'] = []
  if (parsed.status === 'unsupported') {
    warnings.push({ kind: 'unsupported', message: parsed.warnings.join('; ') || 'unsupported emitted motion construct' })
  }
  if (parsed.status === 'failed') {
    warnings.push({ kind: 'failed', message: parsed.warnings.join('; ') || 'parser failure' })
  }

  const ref = refSegmentsFromTrace(postprocessorTrace)
  const got = refSegmentsFromParsed(parsed)

  if (ref.length !== got.length) {
    warnings.push({
      kind: 'countMismatch',
      message: `non-rapid segment count differs (source ${ref.length}, exported ${got.length})`,
    })
  }

  const n = Math.min(ref.length, got.length)
  for (let i = 0; i < n; i++) {
    const r = ref[i]
    const g = got[i]
    if (r.kind !== g.kind) {
      warnings.push({ kind: 'segmentKind', message: `segment ${i + 1}: source ${r.kind} vs exported ${g.kind}` })
      continue
    }
    // Compare the segment END point only, not `from`. The first non-rapid
    // segment's `from` is the machine's pre-program initial position, which the
    // literal G-code does not encode (there is often no positioning rapid
    // before the first cut), so it cannot be reconstructed and comparing it
    // would be meaningless. For later segments `from` is the previous `to`
    // (continuity), which is redundant with the end-point check. Arc geometry
    // is validated via centre + direction below.
    if (!ptEqXYZ(r.to, g.to, tolerance)) {
      warnings.push({ kind: 'endpoint', message: `segment ${i + 1}: end point deviates beyond tolerance` })
    }
    if (r.kind === 'arc' && g.kind === 'arc') {
      if (r.center && g.center) {
        const dc = Math.hypot(r.center.x - g.center.x, r.center.y - g.center.y)
        if (dc > tolerance) {
          warnings.push({ kind: 'arcCenter', message: `segment ${i + 1}: arc centre deviates by ${dc.toFixed(4)}` })
        }
      }
      if (r.clockwise !== g.clockwise) {
        warnings.push({ kind: 'arcDir', message: `segment ${i + 1}: arc direction mismatch` })
      }
    }
  }

  return { state: warnings.length > 0 ? 'warning' : 'verified', warnings }
}

// ── Exported-vs-optimized sampled deviation ──────────────────

interface RefSeg { from: XYP; to: XYP }

function buildRefPolyline(moves: ToolpathMove[]): RefSeg[] {
  const segs: RefSeg[] = []
  for (const m of moves) {
    if (m.kind === 'rapid') continue
    segs.push({ from: { x: m.from.x, y: m.from.y }, to: { x: m.to.x, y: m.to.y } })
  }
  return segs
}

function distToSegment(p: XYP, seg: RefSeg): number {
  const dx = seg.to.x - seg.from.x
  const dy = seg.to.y - seg.from.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-12) return Math.hypot(p.x - seg.from.x, p.y - seg.from.y)
  let t = ((p.x - seg.from.x) * dx + (p.y - seg.from.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (seg.from.x + t * dx), p.y - (seg.from.y + t * dy))
}

function minDistToRef(p: XYP, ref: RefSeg[]): number {
  let min = Infinity
  for (const seg of ref) {
    const d = distToSegment(p, seg)
    if (d < min) min = d
  }
  return min
}

function sampleSegment(seg: MotionDebugSegment, n: number): XYP[] {
  const points: XYP[] = []
  if (seg.kind === 'arc' && seg.center && seg.radius !== undefined && seg.clockwise !== undefined) {
    const cx = seg.center.x, cy = seg.center.y, r = seg.radius
    const startAngle = Math.atan2(seg.from.y - cy, seg.from.x - cx)
    const endAngle = Math.atan2(seg.to.y - cy, seg.to.x - cx)
    // Compute the directed sweep in (-π, π]. For CW arcs the sweep is negative
    // (decreasing angle); for CCW arcs it is positive. This matches the SVG
    // sweep-flag convention (sweep=1 → CW in Y-down space) and the
    // signedSweep helper in arcFitting.ts.
    let sweep = endAngle - startAngle
    if (seg.clockwise && sweep > 0) sweep -= Math.PI * 2
    else if (!seg.clockwise && sweep < 0) sweep += Math.PI * 2
    // Normalise to (-π, π] so the short-arc sweep is used (large-arc is
    // already handled by the SVG A command flags; for sampling we just need
    // the directed angle from start to end).
    if (sweep > Math.PI) sweep -= Math.PI * 2
    else if (sweep <= -Math.PI) sweep += Math.PI * 2
    for (let i = 0; i <= n; i++) {
      const angle = startAngle + sweep * (i / n)
      points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
    }
  } else {
    points.push(seg.from, seg.to)
  }
  return points
}

/**
 * Compare the exported (arc-fitted) path against the optimized (linear) toolpath
 * using sampled planar deviation. This catches arc-fitting bulges where G2/G3
 * arcs deviate from the straight lines they replaced — the diagnostic the issue
 * spec calls "a reconstructed exported path that exceeds the configured tolerance
 * from its source geometry." The "source geometry" here is the optimized toolpath,
 * not the postprocessor trace (which is also arc-fitted and would agree).
 */
function compareExportedVsOptimized(
  exportedSegments: MotionDebugSegment[],
  optimizedMoves: ToolpathMove[],
  sourceMachineMoves: ToolpathMove[],
  tolerance: number,
): MotionDebugDiagnostic {
  const warnings: MotionDebugDiagnostic['warnings'] = []
  const ref = buildRefPolyline(optimizedMoves)
  if (ref.length === 0) return { state: 'verified', warnings }
  for (let i = 0; i < exportedSegments.length; i++) {
    const seg = exportedSegments[i]
    // Parsed G-code has only G0/G1/G2/G3 motion kinds: it cannot distinguish
    // a plunge G1 from a cutting G1. Keep the postprocessor trace's source
    // classification so an initial plunge with an implicit machine start
    // position is not compared as a planar cut.
    const sourceKind = sourceMachineMoves[i]?.kind
    if (sourceKind != null && sourceKind !== 'cut') continue
    if (!seg.cutting) continue
    const samples = sampleSegment(seg, seg.kind === 'arc' ? 8 : 2)
    for (const p of samples) {
      const d = minDistToRef(p, ref)
      if (d > tolerance) {
        warnings.push({
          kind: 'arcDeviation',
          message: `Z=${seg.z.toFixed(4)}: segment ${i + 1} deviates by ${d.toFixed(4)} (tolerance ${tolerance.toFixed(4)})`,
        })
        break
      }
    }
  }
  return { state: warnings.length > 0 ? 'warning' : 'verified', warnings }
}

// ── Model builder ────────────────────────────────────────────

export interface BuildExportedMotionDebugModelArgs {
  trace: ToolpathGenerationTrace
  parsed: ParsedGcodeMotion
  postprocessorTrace: OperationMotionTrace
  origin: MachineOrigin
  definition: MachineDefinition
  tolerance: number
}

export function buildExportedMotionDebugModel(args: BuildExportedMotionDebugModelArgs): ExportedMotionDebugModel {
  const { trace, parsed, postprocessorTrace, origin, definition, tolerance } = args

  const generatedSegments = trace.raw.moves.map(segmentFromMove)
  const optimizedSegments = trace.optimized.moves.map(segmentFromMove)
  const exportedSegments = parsed.moves.map((m) => segmentFromParsed(m, origin, definition))

  // Discrete cutting Z levels in machine (first-encounter) order from the
  // optimized toolpath — the order the .nc file writes them.
  const zSeen = new Set<number>()
  const zLevels: number[] = []
  for (const m of trace.optimized.moves) {
    if (m.kind === 'cut') {
      const z = roundZ(m.from.z)
      if (!zSeen.has(z)) {
        zSeen.add(z)
        zLevels.push(m.from.z)
      }
    }
  }

  // The exported layer's project-Z comes from parsing G-code numbers, which are
  // rounded to the machine's decimalPlaces — so an exported cut's Z won't exactly
  // equal the optimized toolpath's Z. Snap each exported segment's Z to the
  // nearest discrete level (within a tolerance that absorbs the rounding) so
  // the Z-level selector shows the exported layer at the same level as the
  // generated/optimized layers. Levels are far enough apart (stepdowns) that
  // this never blurs two levels together.
  const zSnapTol = Math.max(tolerance * 4, 1e-3)
  if (zLevels.length > 0) {
    for (const seg of exportedSegments) {
      let best = zLevels[0]
      let bestD = Math.abs(seg.z - best)
      for (let i = 1; i < zLevels.length; i++) {
        const d = Math.abs(seg.z - zLevels[i])
        if (d < bestD) { bestD = d; best = zLevels[i] }
      }
      if (bestD <= zSnapTol) seg.z = best
    }
  }

  const metrics: MotionDebugMetrics = {
    rawMoveCount: trace.raw.moves.length,
    optimizedMoveCount: trace.optimized.moves.length,
    removedMoveCount: trace.raw.moves.length - trace.optimized.moves.length,
    emitted: { linear: 0, rapid: 0, arcCw: 0, arcCcw: 0 },
  }
  for (const m of parsed.moves) {
    if (m.kind === 'rapid') metrics.emitted.rapid += 1
    else if (m.kind === 'arc') {
      if (m.clockwise) metrics.emitted.arcCw += 1
      else metrics.emitted.arcCcw += 1
    } else metrics.emitted.linear += 1
  }

  // Compare parsed G-code against the postprocessor source (detects parse errors)
  // AND the exported arc-fitted path against the optimized linear toolpath
  // (detects arc-fitting bulges that exceed tolerance).
  const sourceDiag = compareMotionTraces(parsed, postprocessorTrace, tolerance)
  const deviationDiag = compareExportedVsOptimized(
    exportedSegments,
    trace.optimized.moves,
    postprocessorTrace.machineMoves,
    tolerance,
  )
  const diagnostic: MotionDebugDiagnostic = {
    state: sourceDiag.state === 'warning' || deviationDiag.state === 'warning' ? 'warning' : 'verified',
    warnings: [...sourceDiag.warnings, ...deviationDiag.warnings],
  }

  // Bounds across all three layers (project coords).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const acc = (p: XYP) => {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  for (const seg of [...generatedSegments, ...optimizedSegments, ...exportedSegments]) {
    acc(seg.from); acc(seg.to)
  }
  const bounds = Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null

  // Per-Z-level stats: exported segment count and warnings at each level.
  const zLevelStats: ZLevelStats[] = zLevels.map((z) => {
    const segs = exportedSegments.filter((s) => s.cutting && Math.abs(s.z - z) < 1e-6)
    const warns = diagnostic.warnings.filter((w) => w.message.startsWith(`Z=${z.toFixed(4)}`))
    return { z, exportedSegs: segs.length, warnings: warns }
  })

  return {
    layers: {
      generated: { id: 'generated', segments: generatedSegments },
      optimized: { id: 'optimized', segments: optimizedSegments },
      exported: { id: 'exported', segments: exportedSegments },
    },
    zLevels,
    zLevelStats,
    metrics,
    diagnostic,
    bounds,
  }
}
