/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import type { Point, SketchProfile } from '../../types/project'
import { flattenProfile } from '../../engine/toolpaths/geometry'

// =====================================================================
// Split a closed polygon by an open polyline.
//
// Approach: build a planar graph whose nodes are the intersections of
// the polyline with the polygon boundary. Each node has three useful
// outgoing half-edges:
//   - along P going CCW to the next intersection (the "P-CCW" half-edge)
//   - along P going CW to the previous intersection (the "P-CW" half-edge)
//   - along L going INTO the polygon to the partner intersection
//     (the "chord" half-edge). At entry intersections this is the
//     forward-L direction; at exit intersections it is the reverse-L
//     direction.
//
// CCW-face walking rule: when arriving at a node along a half-edge with
// incoming direction d_in, the next outgoing half-edge is the one whose
// outgoing direction makes the smallest CCW turn from the *reverse* of
// d_in (i.e. immediately after -d_in in CCW order). This walks each
// face with its interior on the left.
//
// Each directed half-edge is used by exactly one face cycle. The "outer
// face" cycle (the one that traces the original polygon CCW boundary
// using only P half-edges) is discarded. All others are pieces.
//
// Endpoints of the polyline must lie outside the polygon (validated by
// the caller via `openProfileFullyCrossesClosed`).
// =====================================================================

const EPSILON = 1e-9

interface Crossing {
  point: Point
  // global parameter along P (= pSegIdx + tOnP), monotonic CCW around P
  tP: number
  // global parameter along L (= lSegIdx + tOnL), monotonic along L
  tL: number
  // even index in the L-ordered list means "entry" (L going from outside
  // to inside at this crossing); odd index means "exit"
  isEntry: boolean
  // index of the paired crossing (entry ↔ exit through the polygon interior)
  partner: number
  // outgoing direction along P CCW (toward the next crossing in P-order)
  dP_CCW: Point
  // outgoing direction along P CW (toward the previous crossing in P-order)
  dP_CW: Point
  // outgoing direction along L into the polygon (toward the partner crossing)
  dChord: Point
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

function len(v: Point): number {
  return Math.hypot(v.x, v.y)
}

function normalize(v: Point): Point {
  const m = len(v)
  if (m < EPSILON) return { x: 0, y: 0 }
  return { x: v.x / m, y: v.y / m }
}

// angle in [0, 2π) for a unit vector
function angleOf(v: Point): number {
  const a = Math.atan2(v.y, v.x)
  return a < 0 ? a + 2 * Math.PI : a
}

// CCW signed distance from angle a to angle b in [0, 2π).
function ccwDelta(a: number, b: number): number {
  let d = b - a
  while (d <= EPSILON) d += 2 * Math.PI
  return d
}

// Point-in-polygon (ray cast). Returns true if strictly inside.
function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i]
    const b = poly[j]
    const intersects = (a.y > p.y) !== (b.y > p.y)
      && p.x < ((b.x - a.x) * (p.y - a.y)) / ((b.y - a.y) || EPSILON) + a.x
    if (intersects) inside = !inside
  }
  return inside
}

// Segment-segment intersection treating each segment as a half-open interval
// [start, end) on both parameters. This ensures intersections at shared
// vertices are reported by exactly one segment (the one whose start vertex
// is the intersection), avoiding double-counting.
function segmentIntersect(
  a1: Point, a2: Point, b1: Point, b2: Point,
): { t: number, u: number, point: Point } | null {
  const r = sub(a2, a1)
  const s = sub(b2, b1)
  const denom = r.x * s.y - r.y * s.x
  if (Math.abs(denom) < EPSILON) return null // parallel or collinear
  const qp = sub(b1, a1)
  const t = (qp.x * s.y - qp.y * s.x) / denom
  const u = (qp.x * r.y - qp.y * r.x) / denom
  // Half-open intervals: include start (0), exclude end (1).
  if (t < -EPSILON || t >= 1 - EPSILON) return null
  if (u < -EPSILON || u >= 1 - EPSILON) return null
  return {
    t: Math.max(0, t),
    u: Math.max(0, u),
    point: { x: a1.x + t * r.x, y: a1.y + t * r.y },
  }
}

// Returns the flattened points of a profile. For a closed profile the
// last point is dropped (so points are unique vertices in order) and the
// winding is normalized to CCW — the split algorithm assumes CCW polygons.
function flattenToVertices(profile: SketchProfile): { points: Point[], closed: boolean } {
  const flat = flattenProfile(profile)
  if (!flat.closed) {
    return { points: flat.points, closed: false }
  }
  const points = flat.points.slice()
  if (points.length > 1) {
    const first = points[0]
    const last = points[points.length - 1]
    if (Math.abs(first.x - last.x) < EPSILON && Math.abs(first.y - last.y) < EPSILON) {
      points.pop()
    }
  }
  // Ensure CCW orientation (positive signed area).
  let area = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  if (area < 0) points.reverse()
  return { points, closed: true }
}

// Compute the tangent direction along P at a parameter tP. tP is in
// [0, n) where n = pPoints.length. Tangent direction is from pPoints[i]
// toward pPoints[i+1 mod n], regardless of where within the segment we are.
function tangentAlongP(pPoints: Point[], tP: number): Point {
  const i = Math.floor(tP) % pPoints.length
  const next = (i + 1) % pPoints.length
  return normalize(sub(pPoints[next], pPoints[i]))
}

function tangentAlongL(lPoints: Point[], tL: number): Point {
  // tL in [0, m-1) where m = lPoints.length
  let i = Math.floor(tL)
  if (i >= lPoints.length - 1) i = lPoints.length - 2
  return normalize(sub(lPoints[i + 1], lPoints[i]))
}

// True if the flattened polyline L starts outside the closed flattened
// polygon P, ends outside, and crosses the boundary an even number of times.
export function openCrossesClosedFully(openProfile: SketchProfile, closedProfile: SketchProfile): boolean {
  if (openProfile.closed || !closedProfile.closed) return false
  const L = flattenToVertices(openProfile).points
  const P = flattenToVertices(closedProfile).points
  if (L.length < 2 || P.length < 3) return false

  if (pointInPolygon(L[0], P)) return false
  if (pointInPolygon(L[L.length - 1], P)) return false

  let count = 0
  for (let i = 0; i < L.length - 1; i += 1) {
    for (let j = 0; j < P.length; j += 1) {
      const hit = segmentIntersect(L[i], L[i + 1], P[j], P[(j + 1) % P.length])
      if (hit !== null) count += 1
    }
  }
  return count >= 2 && count % 2 === 0
}

// Walk a P-arc from intersection at tP_start CCW around P until tP_end.
// Returns the interior P vertices traversed (not including the endpoints).
function pArcInteriorVertices(pPoints: Point[], tP_start: number, tP_end: number): Point[] {
  const n = pPoints.length
  const out: Point[] = []
  // Move CCW (increasing tP), wrapping at n. First vertex index to include is
  // the next integer strictly greater than tP_start (mod n).
  const startIdx = (Math.floor(tP_start) + 1) % n
  let idx = startIdx
  // End when idx would be at or past tP_end (handling wrap).
  // We add at most n vertices to avoid infinite loops.
  for (let safety = 0; safety < n; safety += 1) {
    // The "logical" position of vertex idx going CCW from tP_start.
    let logical = idx - tP_start
    if (logical <= 0) logical += n
    const targetLogical = ((tP_end - tP_start) % n + n) % n
    if (logical >= targetLogical - EPSILON) break
    out.push(pPoints[idx])
    idx = (idx + 1) % n
  }
  return out
}

// Walk an L-arc from intersection at tL_start to tL_end (in +L direction
// if tL_end > tL_start, otherwise -L direction). Returns interior L
// vertices traversed (not endpoints).
function lArcInteriorVertices(lPoints: Point[], tL_start: number, tL_end: number): Point[] {
  const out: Point[] = []
  if (tL_end > tL_start) {
    const startIdx = Math.floor(tL_start) + 1
    const endIdx = Math.ceil(tL_end - EPSILON)
    for (let i = startIdx; i < endIdx; i += 1) out.push(lPoints[i])
  } else {
    const startIdx = Math.ceil(tL_start - EPSILON) - 1
    const endIdx = Math.floor(tL_end) + 1
    for (let i = startIdx; i >= endIdx; i -= 1) out.push(lPoints[i])
  }
  return out
}

interface SplitHalfEdge {
  // 0 = P-CCW, 1 = P-CW, 2 = chord
  kind: 0 | 1 | 2
  from: number // crossing index
  to: number // crossing index
}

function buildHalfEdges(crossings: Crossing[], pOrder: number[]): SplitHalfEdge[] {
  const k = crossings.length
  const halfEdges: SplitHalfEdge[] = []
  // P-CCW and P-CW edges (between consecutive crossings in P CCW order).
  for (let i = 0; i < k; i += 1) {
    const from = pOrder[i]
    const to = pOrder[(i + 1) % k]
    halfEdges.push({ kind: 0, from, to })
    halfEdges.push({ kind: 1, from: to, to: from })
  }
  // Chord edges (each partner pair contributes two half-edges).
  const chordSeen = new Set<string>()
  for (let i = 0; i < k; i += 1) {
    const partner = crossings[i].partner
    const key = i < partner ? `${i}-${partner}` : `${partner}-${i}`
    if (chordSeen.has(key)) continue
    chordSeen.add(key)
    halfEdges.push({ kind: 2, from: i, to: partner })
    halfEdges.push({ kind: 2, from: partner, to: i })
  }
  return halfEdges
}

// Outgoing direction at half-edge's `from` crossing.
function outgoingDir(he: SplitHalfEdge, crossings: Crossing[]): Point {
  const c = crossings[he.from]
  if (he.kind === 0) return c.dP_CCW
  if (he.kind === 1) return c.dP_CW
  return c.dChord
}

// Incoming direction at half-edge's `to` crossing (= direction of the
// last segment of the half-edge arriving at `to`).
function incomingDir(he: SplitHalfEdge, crossings: Crossing[], pPoints: Point[], lPoints: Point[]): Point {
  const cTo = crossings[he.to]
  if (he.kind === 0) {
    // P-CCW from `from` to `to`. Arriving at `to` going in P CCW direction.
    // The arriving tangent is along P at parameter just below cTo.tP, i.e.
    // tangent of segment that ends at cTo.point. That segment goes from
    // pPoints[floor(cTo.tP)] to pPoints[ceil(cTo.tP) mod n] if cTo.tP isn't
    // an integer. If cTo lies on segment j→j+1 then the arriving tangent
    // direction is normalize(pPoints[j+1] - pPoints[j]) = tangent at cTo.tP
    // going CCW.
    return tangentAlongP(pPoints, cTo.tP)
  }
  if (he.kind === 1) {
    // P-CW: arriving at `to` going CW. Tangent is -CCW tangent at cTo.tP-ε.
    // Use the segment just before cTo.tP in CCW order, then negate.
    const eps = 1e-12
    const tBefore = (cTo.tP - eps + pPoints.length) % pPoints.length
    const ccwTangent = tangentAlongP(pPoints, tBefore)
    return { x: -ccwTangent.x, y: -ccwTangent.y }
  }
  // chord: arriving at `to` from `from` via L. Direction is +L if from-tL < to-tL else -L.
  const cFrom = crossings[he.from]
  const sign = cTo.tL > cFrom.tL ? 1 : -1
  // The arriving tangent at cTo is the L tangent at parameter just before
  // cTo.tL (in the direction we're moving).
  const eps = 1e-12
  const tBefore = sign > 0 ? cTo.tL - eps : cTo.tL + eps
  const ccwL = tangentAlongL(lPoints, Math.max(0, Math.min(lPoints.length - 2 + 0.999, tBefore)))
  return sign > 0 ? ccwL : { x: -ccwL.x, y: -ccwL.y }
}

// Find the next half-edge in the CCW face after arriving via `incoming`.
// Standard DCEL rule: next-in-face(h) = the half-edge immediately CW from
// twin(h) in the cyclic ordering of outgoing half-edges around the
// destination. We compute this as: among outgoing half-edges at the
// destination (excluding twin), pick the one with the smallest CCW angle
// from its direction to the twin's direction.
function nextHalfEdge(
  incoming: SplitHalfEdge,
  halfEdges: SplitHalfEdge[],
  crossings: Crossing[],
  pPoints: Point[],
  lPoints: Point[],
): SplitHalfEdge | null {
  const arrivalDir = incomingDir(incoming, crossings, pPoints, lPoints)
  const twinAngle = angleOf({ x: -arrivalDir.x, y: -arrivalDir.y })

  const candidates = halfEdges.filter((he) => he.from === incoming.to
    && !isTwinOf(he, incoming))

  if (candidates.length === 0) return null

  let best: SplitHalfEdge | null = null
  let bestDelta = Infinity
  for (const c of candidates) {
    const outDir = outgoingDir(c, crossings)
    const outAngle = angleOf(outDir)
    const delta = ccwDelta(outAngle, twinAngle)
    if (delta < bestDelta) {
      bestDelta = delta
      best = c
    }
  }
  return best
}

function isTwinOf(a: SplitHalfEdge, b: SplitHalfEdge): boolean {
  if (a.from !== b.to || a.to !== b.from) return false
  if (a.kind === 2 && b.kind === 2) return true
  if ((a.kind === 0 && b.kind === 1) || (a.kind === 1 && b.kind === 0)) return true
  return false
}

function keyOf(he: SplitHalfEdge): string {
  return `${he.kind}:${he.from}->${he.to}`
}

// Materialize the geometry of a half-edge as a sequence of points
// (excluding the starting crossing point, including the ending crossing point).
function materializeHalfEdge(
  he: SplitHalfEdge,
  crossings: Crossing[],
  pPoints: Point[],
  lPoints: Point[],
): Point[] {
  if (he.kind === 0) {
    return [
      ...pArcInteriorVertices(pPoints, crossings[he.from].tP, crossings[he.to].tP),
      crossings[he.to].point,
    ]
  }
  if (he.kind === 1) {
    // CW: walk P in reverse direction from `from` to `to`. We can compute by
    // going CCW from `to` to `from` and reversing.
    const ccwInterior = pArcInteriorVertices(pPoints, crossings[he.to].tP, crossings[he.from].tP)
    return [
      ...ccwInterior.reverse(),
      crossings[he.to].point,
    ]
  }
  // chord
  return [
    ...lArcInteriorVertices(lPoints, crossings[he.from].tL, crossings[he.to].tL),
    crossings[he.to].point,
  ]
}

function signedAreaOf(points: Point[]): number {
  let area = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

export interface SplitResult {
  pieces: Point[][] // each piece is a closed polygon as a list of vertices (no repeated last vertex)
}

export function splitClosedByOpen(
  closedProfile: SketchProfile,
  openProfile: SketchProfile,
): SplitResult | null {
  if (!closedProfile.closed || openProfile.closed) return null

  const pPoints = flattenToVertices(closedProfile).points
  const lPoints = flattenToVertices(openProfile).points
  if (pPoints.length < 3 || lPoints.length < 2) return null

  // Endpoints of L must lie outside P.
  if (pointInPolygon(lPoints[0], pPoints)) return null
  if (pointInPolygon(lPoints[lPoints.length - 1], pPoints)) return null

  // Compute all proper crossings of L segments with P segments.
  type RawCrossing = { point: Point, tP: number, tL: number }
  const raw: RawCrossing[] = []
  for (let i = 0; i < lPoints.length - 1; i += 1) {
    const a1 = lPoints[i]
    const a2 = lPoints[i + 1]
    for (let j = 0; j < pPoints.length; j += 1) {
      const b1 = pPoints[j]
      const b2 = pPoints[(j + 1) % pPoints.length]
      const hit = segmentIntersect(a1, a2, b1, b2)
      if (!hit) continue
      raw.push({ point: hit.point, tP: j + hit.u, tL: i + hit.t })
    }
  }
  if (raw.length < 2 || raw.length % 2 !== 0) return null

  // Pair crossings: sort by tL, then alternate entry/exit.
  const lSorted = raw.slice().sort((a, b) => a.tL - b.tL)
  // Validate alternation by point-in-polygon midpoint test for each
  // (entry, exit) pair: the segment midpoint should lie inside the polygon.
  // Catches degenerate tangent cases.
  for (let i = 0; i < lSorted.length; i += 2) {
    const a = lSorted[i]
    const b = lSorted[i + 1]
    const mid = { x: (a.point.x + b.point.x) / 2, y: (a.point.y + b.point.y) / 2 }
    if (!pointInPolygon(mid, pPoints)) return null
  }

  // Now build Crossing entries with partner indices and directions.
  const crossings: Crossing[] = lSorted.map((r, idx) => {
    const partner = (idx % 2 === 0) ? idx + 1 : idx - 1
    return {
      point: r.point,
      tP: r.tP,
      tL: r.tL,
      isEntry: (idx % 2 === 0),
      partner,
      // tangents filled in after sorting by P
      dP_CCW: { x: 0, y: 0 },
      dP_CW: { x: 0, y: 0 },
      dChord: { x: 0, y: 0 },
    }
  })

  // Compute outgoing tangents.
  for (const c of crossings) {
    const ccw = tangentAlongP(pPoints, c.tP)
    c.dP_CCW = ccw
    c.dP_CW = { x: -ccw.x, y: -ccw.y }
    const lDir = tangentAlongL(lPoints, c.tL)
    // chord goes into polygon: at entry, +L; at exit, -L.
    c.dChord = c.isEntry ? lDir : { x: -lDir.x, y: -lDir.y }
  }

  // Order crossings around P CCW (by tP).
  const pOrder = crossings
    .map((_, idx) => idx)
    .sort((a, b) => crossings[a].tP - crossings[b].tP)

  // Build half-edges.
  const halfEdges = buildHalfEdges(crossings, pOrder)

  // Face walking.
  const used = new Set<string>()
  const faces: SplitHalfEdge[][] = []
  for (const start of halfEdges) {
    if (used.has(keyOf(start))) continue
    const cycle: SplitHalfEdge[] = []
    let current: SplitHalfEdge | null = start
    let safety = 0
    while (current && safety < halfEdges.length + 2) {
      const k = keyOf(current)
      if (used.has(k)) break
      used.add(k)
      cycle.push(current)
      const next = nextHalfEdge(current, halfEdges, crossings, pPoints, lPoints)
      if (!next) break
      if (keyOf(next) === keyOf(start)) {
        break
      }
      current = next
      safety += 1
    }
    if (cycle.length > 0) faces.push(cycle)
  }

  // Materialize each face as a polygon. The outer face has negative signed
  // area (it wraps the polygon clockwise) and is discarded.
  const pieces: Point[][] = []
  for (const face of faces) {
    if (face.length < 2) continue
    const verts: Point[] = [crossings[face[0].from].point]
    for (const he of face) {
      const mat = materializeHalfEdge(he, crossings, pPoints, lPoints)
      verts.push(...mat)
    }
    // Remove repeated last vertex (it equals the start by construction).
    if (verts.length > 1) {
      const first = verts[0]
      const last = verts[verts.length - 1]
      if (Math.abs(first.x - last.x) < EPSILON && Math.abs(first.y - last.y) < EPSILON) {
        verts.pop()
      }
    }
    // Drop coincident neighbors and collinear interior vertices. Collinear
    // vertices (e.g. when a chord passes through interior polyline vertices
    // that lie on the chord line) create zero-width folds that confuse
    // downstream boolean operations.
    let cleaned: Point[] = []
    for (const p of verts) {
      const prev = cleaned[cleaned.length - 1]
      if (!prev || Math.abs(prev.x - p.x) > EPSILON || Math.abs(prev.y - p.y) > EPSILON) {
        cleaned.push(p)
      }
    }
    // Repeatedly strip collinear vertices (a, b, c) where b lies on segment a→c.
    let changed = true
    while (changed && cleaned.length >= 3) {
      changed = false
      const next: Point[] = []
      for (let i = 0; i < cleaned.length; i += 1) {
        const a = cleaned[(i - 1 + cleaned.length) % cleaned.length]
        const b = cleaned[i]
        const c = cleaned[(i + 1) % cleaned.length]
        const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
        if (Math.abs(cross) < EPSILON) {
          changed = true
          continue
        }
        next.push(b)
      }
      cleaned = next
    }
    if (cleaned.length < 3) continue
    if (signedAreaOf(cleaned) <= EPSILON) continue // outer face or degenerate
    pieces.push(cleaned)
  }

  if (pieces.length === 0) return null
  return { pieces }
}
