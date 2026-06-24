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

import type { Point } from '../../types/project'

export type LineSeg = { kind: 'line'; p0: Point; p1: Point }
export type ArcSeg = {
  kind: 'arc'
  center: Point
  radius: number
  a0: number
  a1: number
  ccw: boolean
}
export type ResolvedSeg = LineSeg | ArcSeg

export interface SegIntersection {
  point: Point
  tA: number
  tB: number
}

const EPS = 1e-9
const TWO_PI = 2 * Math.PI

function normAngle(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

// ── helpers for line segment t ────────────────────────────────────────

function tOnSegment(t: number, rayA: boolean): boolean {
  if (rayA) return t >= -EPS
  return t >= -EPS && t <= 1 + EPS
}

// ── angle-in-sweep helper ─────────────────────────────────────────────

function angleInSweep(
  angle: number,
  a0: number,
  a1: number,
  ccw: boolean,
  rayA: boolean,
): number | null {
  const na = normAngle(angle)
  const nA0 = normAngle(a0)

  let sweepAngle: number
  let distToAngle: number

  if (ccw) {
    const rawDiff = a1 - a0
    sweepAngle = rawDiff
    while (sweepAngle < 0) sweepAngle += TWO_PI
    sweepAngle %= TWO_PI
    // Full circle: raw diff is ~2π but modulo gives 0
    if (sweepAngle < EPS && Math.abs(rawDiff) + EPS >= TWO_PI) sweepAngle = TWO_PI
    if (sweepAngle < EPS) return null

    distToAngle = normAngle(na - nA0)
    if (TWO_PI - distToAngle < EPS) distToAngle = 0
  } else {
    const rawDiff = a0 - a1
    sweepAngle = rawDiff
    while (sweepAngle < 0) sweepAngle += TWO_PI
    sweepAngle %= TWO_PI
    if (sweepAngle < EPS && Math.abs(rawDiff) + EPS >= TWO_PI) sweepAngle = TWO_PI
    if (sweepAngle < EPS) return null

    distToAngle = normAngle(nA0 - na)
    if (TWO_PI - distToAngle < EPS) distToAngle = 0
  }

  const t = distToAngle / sweepAngle

  if (rayA) return t
  if (distToAngle <= sweepAngle + EPS) return Math.min(Math.max(t, 0), 1)
  return null
}

// ── line–line ─────────────────────────────────────────────────────────

function lineLineParams(
  a: LineSeg,
  b: LineSeg,
): { tA: number; tB: number } | null {
  const d1x = a.p1.x - a.p0.x
  const d1y = a.p1.y - a.p0.y
  const d2x = b.p1.x - b.p0.x
  const d2y = b.p1.y - b.p0.y

  const det = d1x * d2y - d1y * d2x
  if (Math.abs(det) < EPS) return null

  const dx = b.p0.x - a.p0.x
  const dy = b.p0.y - a.p0.y

  const tA = (dx * d2y - dy * d2x) / det
  const tB = (dx * d1y - dy * d1x) / det

  return { tA, tB }
}

function pointOnLine(a: LineSeg, t: number): Point {
  return {
    x: a.p0.x + t * (a.p1.x - a.p0.x),
    y: a.p0.y + t * (a.p1.y - a.p0.y),
  }
}

// ── line–arc ──────────────────────────────────────────────────────────

function lineArcCandidates(
  line: LineSeg,
  arc: ArcSeg,
): { tLine: number; point: Point; angle: number }[] {
  const dx = line.p1.x - line.p0.x
  const dy = line.p1.y - line.p0.y
  const vx = line.p0.x - arc.center.x
  const vy = line.p0.y - arc.center.y

  const a = dx * dx + dy * dy
  if (a < EPS) return []

  const b = 2 * (dx * vx + dy * vy)
  const c = vx * vx + vy * vy - arc.radius * arc.radius

  const disc = b * b - 4 * a * c
  if (disc < -EPS) return []

  const sqrtDisc = Math.sqrt(Math.max(0, disc))
  const results: { tLine: number; point: Point; angle: number }[] = []

  for (const sign of [-1, 1]) {
    const t = (-b + sign * sqrtDisc) / (2 * a)
    const point: Point = {
      x: line.p0.x + t * dx,
      y: line.p0.y + t * dy,
    }
    const angle = Math.atan2(point.y - arc.center.y, point.x - arc.center.x)
    results.push({ tLine: t, point, angle })
  }

  // Deduplicate when tangent (single solution)
  if (disc <= EPS && results.length === 2) {
    results.pop()
  }

  return results
}

// ── arc–arc ───────────────────────────────────────────────────────────

function arcArcCandidates(
  arc1: ArcSeg,
  arc2: ArcSeg,
): { point: Point; angle1: number; angle2: number }[] {
  const dx = arc2.center.x - arc1.center.x
  const dy = arc2.center.y - arc1.center.y
  const d = Math.hypot(dx, dy)

  if (d < EPS) return []
  if (d > arc1.radius + arc2.radius + EPS) return []
  if (d < Math.abs(arc1.radius - arc2.radius) - EPS) return []

  const a = (arc1.radius * arc1.radius - arc2.radius * arc2.radius + d * d) / (2 * d)
  const h2 = arc1.radius * arc1.radius - a * a

  if (h2 < -EPS) return []

  const h = Math.sqrt(Math.max(0, h2))
  const px = arc1.center.x + (a / d) * dx
  const py = arc1.center.y + (a / d) * dy

  const perpX = -dy * (h / d)
  const perpY = dx * (h / d)

  const results: { point: Point; angle1: number; angle2: number }[] = []

  for (const sign of [-1, 1]) {
    const x = px + sign * perpX
    const y = py + sign * perpY
    const angle1 = Math.atan2(y - arc1.center.y, x - arc1.center.x)
    const angle2 = Math.atan2(y - arc2.center.y, x - arc2.center.x)
    results.push({ point: { x, y }, angle1, angle2 })
  }

  // Deduplicate when tangent (single solution)
  if (h2 <= EPS && results.length === 2) {
    results.pop()
  }

  return results
}

// ── public API ────────────────────────────────────────────────────────

export function segmentIntersections(
  a: ResolvedSeg,
  b: ResolvedSeg,
  opts?: { rayA?: boolean },
): SegIntersection[] {
  const rayA = opts?.rayA ?? false
  const results: SegIntersection[] = []

  // ── line × line ───────────────────────────────────────────────
  if (a.kind === 'line' && b.kind === 'line') {
    const tt = lineLineParams(a, b)
    if (!tt) return []
    if (tOnSegment(tt.tA, rayA) && tOnSegment(tt.tB, false)) {
      results.push({
        point: pointOnLine(a, tt.tA),
        tA: tt.tA,
        tB: tt.tB,
      })
    }
    return results
  }

  // ── line × arc ────────────────────────────────────────────────
  if (a.kind === 'line' && b.kind === 'arc') {
    for (const cand of lineArcCandidates(a, b)) {
      if (!tOnSegment(cand.tLine, rayA)) continue
      const tB = angleInSweep(cand.angle, b.a0, b.a1, b.ccw, false)
      if (tB === null) continue
      results.push({ point: cand.point, tA: cand.tLine, tB })
    }
    return results
  }

  // ── arc × line ────────────────────────────────────────────────
  if (a.kind === 'arc' && b.kind === 'line') {
    for (const cand of lineArcCandidates(b, a)) {
      if (!tOnSegment(cand.tLine, false)) continue
      const tA = angleInSweep(cand.angle, a.a0, a.a1, a.ccw, rayA)
      if (tA === null) continue
      results.push({ point: cand.point, tA, tB: cand.tLine })
    }
    return results
  }

  // ── arc × arc ────────────────────────────────────────────────
  // Narrowing: earlier branches cover line-line, line-arc, arc-line and return.
  const arcA = a as ArcSeg
  const arcB = b as ArcSeg
  for (const cand of arcArcCandidates(arcA, arcB)) {
    const tA = angleInSweep(cand.angle1, arcA.a0, arcA.a1, arcA.ccw, rayA)
    if (tA === null) continue
    const tB = angleInSweep(cand.angle2, arcB.a0, arcB.a1, arcB.ccw, false)
    if (tB === null) continue
    results.push({ point: cand.point, tA, tB })
  }
  return results
}
