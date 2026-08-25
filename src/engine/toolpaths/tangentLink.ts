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

// Tangential ring-to-ring links for offset pocket clearing (issue #545).
//
// The straight link between two clearing rings leaves one ring and enters the
// next at sharp angles. This module replaces it with an S-shaped tangent
// link: the path departs ring N along its travel tangent, curves out, runs a
// straight diagonal, curves back, and arrives on a vertex of ring N+1 along
// ring N+1's own travel tangent — tangent at both ends, departure and
// arrival. The arrival point is free to slide along the next ring's vertices,
// which is what makes the S feasible where the fixed-endpoint arc-line-arc
// measured for the plan was not (the lateral step between adjacent rings
// needs unequal turn radii).
//
// Shape: arc (signed turn phi1, signed radius rho1) + straight middle + arc
// (signed turn phi2, signed radius rho2). For a candidate arrival vertex Q
// with ring tangent t1, the middle direction m is searched over a sweep and
// the closure D = chord1 + s*m + chord2 is solved with one radius pinned to
// minRadius. The shortest feasible candidate whose path stays inside the
// cleared domain wins; no candidate means the caller keeps today's straight
// link. Feed and engagement classification run downstream on the emitted
// moves, so the S needs no special feed handling.

import type { Point } from '../../types/project'
import { DEFAULT_FLATTEN_ARC_STEP } from './geometry'

// Call-count probes for the S-link solver. Cost assertions count work — never
// wall clocks (AGENTS.md § Build & Verify) — so tests reset and read these
// counters instead of timing generation. Only `slinkProbeCounts` and
// `resetSlinkProbeCounts` are public; the counters advance only inside
// `tangentSLink`.

let slinkArrivalsConsidered = 0
let slinkArrivalsPruned = 0
let slinkCandidatesEvaluated = 0
let slinkDomainChecks = 0
let slinkDomainScans = 0

/** Read the S-link probe counters (arrivals considered, pruned, and candidates evaluated). */
export function slinkProbeCounts(): {
  arrivalsConsidered: number
  arrivalsPruned: number
  candidatesEvaluated: number
  domainChecks: number
  domainScans: number
} {
  return {
    arrivalsConsidered: slinkArrivalsConsidered,
    arrivalsPruned: slinkArrivalsPruned,
    candidatesEvaluated: slinkCandidatesEvaluated,
    domainChecks: slinkDomainChecks,
    domainScans: slinkDomainScans,
  }
}

/** Reset the S-link probe counters. Tests call this before measuring. */
export function resetSlinkProbeCounts(): void {
  slinkArrivalsConsidered = 0
  slinkArrivalsPruned = 0
  slinkCandidatesEvaluated = 0
  slinkDomainChecks = 0
  slinkDomainScans = 0
}

interface Vec {
  x: number
  y: number
}

const sub = (a: Point, b: Point): Vec => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Point, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (v: Vec, k: number): Vec => ({ x: v.x * k, y: v.y * k })
const len = (v: Vec): number => Math.hypot(v.x, v.y)
const norm = (v: Vec): Vec => { const l = len(v); return l > 1e-12 ? { x: v.x / l, y: v.y / l } : { x: 1, y: 0 } }
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y
const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x
const rot = (v: Vec, angle: number): Vec => ({
  x: v.x * Math.cos(angle) - v.y * Math.sin(angle),
  y: v.x * Math.sin(angle) + v.y * Math.cos(angle),
})
const signedAngle = (u: Vec, v: Vec): number => Math.atan2(cross(u, v), dot(u, v))

export interface TangentLinkOptions {
  /** Smallest arc radius worth emitting for the S curves, project units. */
  minRadius: number
  /** Total path length budget for the S, project units. */
  maxLength: number
  /** Angular tessellation step for the arcs, radians. */
  arcStepRadians?: number
  /** True when a tool-centre position lies inside the cleared domain the link
   *  may sweep (inside the wall-adjacent outer, outside island expansions). */
  isInsideDomain: (x: number, y: number) => boolean
}

export interface TangentLinkResult {
  /** Tessellated path from the exit point to the arrival vertex, tangent to
   *  the exit tangent at the start and to the ring at the end. */
  points: Point[]
  /** Index into ringVertices of the arrival vertex (the ring re-seams there). */
  arrivalIndex: number
}

function buildS(
  exit: Point,
  t0: Vec,
  phi1: number,
  rho1: number,
  m: Vec,
  s: number,
  phi2: number,
  rho2: number,
  arrival: Point,
  arcStep: number,
): Point[] {
  const pts: Point[] = [exit]
  const tess = (from: Point, tangent: Vec, turn: number, radius: number, to: Point): void => {
    const centre: Point = { x: from.x - radius * tangent.y, y: from.y + radius * tangent.x }
    const steps = Math.max(1, Math.ceil(Math.abs(turn) / arcStep))
    for (let step = 1; step < steps; step += 1) {
      const dir = rot(tangent, (turn * step) / steps)
      pts.push({ x: centre.x + radius * dir.y, y: centre.y - radius * dir.x })
    }
    pts.push(to)
  }
  if (Math.abs(phi1) > 1e-9) {
    const end1 = add(exit, mul(rot(t0, phi1 / 2), 2 * rho1 * Math.sin(phi1 / 2)))
    tess(exit, t0, phi1, rho1, end1)
  }
  if (s > 1e-9) {
    pts.push(add(pts[pts.length - 1], mul(m, s)))
  }
  if (Math.abs(phi2) > 1e-9) {
    tess(pts[pts.length - 1], m, phi2, rho2, arrival)
  }
  pts[pts.length - 1] = arrival
  return pts
}

/**
 * Tangent S-link from exit (leaving along exitTangent) to a vertex of the
 * directed arrival ring. Searches arrival vertices within the length budget
 * and middle directions across the turn sweep; the shortest feasible path
 * that stays inside the cleared domain wins. Returns null when no tangent S
 * fits — the caller keeps today's straight link.
 */
export function tangentSLink(
  exit: Point,
  exitTangent: Vec,
  ringVertices: Point[],
  options: TangentLinkOptions,
): TangentLinkResult | null {
  const count = ringVertices.length
  if (count < 3 || !(options.maxLength > 0)) return null
  const arcStep = Math.max(options.arcStepRadians ?? DEFAULT_FLATTEN_ARC_STEP, 1e-3)
  const rMin = options.minRadius

  let best: TangentLinkResult | null = null
  let bestLength = Number.POSITIVE_INFINITY

  for (let index = 0; index < count; index += 1) {
    const arrival = ringVertices[index]
    const straightDist = Math.hypot(arrival.x - exit.x, arrival.y - exit.y)
    if (straightDist > options.maxLength || straightDist <= 1e-9) continue
    slinkArrivalsConsidered += 1
    // Exact prune (issue #609). Any arc-line-arc path from `exit` to `arrival`
    // is at least the straight-line distance between them, so an arrival whose
    // straight distance already matches the best length found cannot produce a
    // shorter path. The winner is chosen with a strict `<`, so a candidate that
    // merely ties never replaces the incumbent either — skipping these cannot
    // change which S is selected, only how long it takes to find it. Iteration
    // order is untouched, so first-found tie-breaking is preserved.
    if (straightDist >= bestLength) { slinkArrivalsPruned += 1; continue }
    const nextVertex = ringVertices[(index + 1) % count]
    const arrivalTangent = norm(sub(nextVertex, arrival))

    const D = sub(arrival, exit)
    const phi = signedAngle(exitTangent, arrivalTangent)
    const bisector = norm(add(exitTangent, arrivalTangent))
    const middleCandidates: Vec[] = []
    if (len(add(exitTangent, arrivalTangent)) > 1e-9) middleCandidates.push(bisector)
    // Interpolated sweep between the two tangents, plus an ABSOLUTE sweep
    // around the bisector: parallel tangents collapse the interpolation onto
    // one direction, and the S that crosses a parallel step must bow out of
    // the tangent cone, which only the absolute sweep can reach.
    for (let k = -20; k <= 20; k += 1) {
      if (k === 0) continue
      middleCandidates.push(rot(exitTangent, (phi * k) / 20))
      middleCandidates.push(rot(bisector, (k * 9 * Math.PI) / 180))
    }

    for (const m of middleCandidates) {
      const phi1 = signedAngle(exitTangent, m)
      const phi2 = signedAngle(m, arrivalTangent)
      if (Math.abs(phi1) > Math.PI - 1e-6 || Math.abs(phi2) > Math.PI - 1e-6) continue
      if (Math.abs(phi1) < 1e-9 && Math.abs(phi2) < 1e-9) continue
      const sigma1 = phi1 >= 0 ? 1 : -1
      const sigma2 = phi2 >= 0 ? 1 : -1
      const a1 = mul(rot(exitTangent, phi1 / 2), 2 * sigma1 * Math.sin(phi1 / 2))
      const a2 = mul(rot(m, phi2 / 2), 2 * sigma2 * Math.sin(phi2 / 2))

      const candidates: Point[][] = []
      const denom2 = cross(m, a2)
      if (Math.abs(denom2) > 1e-12) {
        const r2 = cross(m, sub(D, mul(a1, rMin))) / denom2
        if (r2 >= rMin) {
          const s = dot(m, sub(D, add(mul(a1, rMin), mul(a2, r2))))
          if (s >= 0) candidates.push(buildS(exit, exitTangent, phi1, sigma1 * rMin, m, s, phi2, sigma2 * r2, arrival, arcStep))
        }
      }
      const denom1 = cross(m, a1)
      if (Math.abs(denom1) > 1e-12) {
        const r1 = cross(m, sub(D, mul(a2, rMin))) / denom1
        if (r1 >= rMin) {
          const s = dot(m, sub(D, add(mul(a1, r1), mul(a2, rMin))))
          if (s >= 0) candidates.push(buildS(exit, exitTangent, phi1, sigma1 * r1, m, s, phi2, sigma2 * rMin, arrival, arcStep))
        }
      }

      // The domain gate must see what lies BETWEEN the path vertices: the
      // straight middle is a single segment up to the whole length budget, so
      // sample every candidate segment at the floor-radius chord budget the
      // arcs use. A concavity straddling the middle must reject the path.
      // Absolute floor so a degenerate minRadius cannot explode the samples.
      const chordBudget = Math.max(2 * rMin * Math.sin(arcStep / 2), 1e-6)
      for (const candidate of candidates) {
        slinkCandidatesEvaluated += 1
        let pathLength = 0
        let domainOk = true
        for (let step = 0; step + 1 < candidate.length && domainOk; step += 1) {
          const a = candidate[step]
          const b = candidate[step + 1]
          const segLen = Math.hypot(b.x - a.x, b.y - a.y)
          pathLength += segLen
          if (!options.isInsideDomain(a.x, a.y)) {
            domainOk = false
            break
          }
          const samples = Math.max(1, Math.ceil(segLen / chordBudget))
          for (let sample = 1; sample < samples; sample += 1) {
            const t = sample / samples
            if (!options.isInsideDomain(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) {
              domainOk = false
              break
            }
          }
        }
        if (!domainOk || pathLength > options.maxLength) continue
        // The last segment must be tangent to the arrival ring's direction.
        const lastDir = norm(sub(candidate[candidate.length - 1], candidate[candidate.length - 2]))
        if (Math.abs(signedAngle(lastDir, arrivalTangent)) > 0.1) continue
        if (pathLength < bestLength) {
          bestLength = pathLength
          best = { points: candidate, arrivalIndex: index }
        }
      }
    }
  }

  return best
}

function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x
    const yi = polygon[i].y
    const xj = polygon[j].x
    const yj = polygon[j].y
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Is the point on an edge of the polygon, within float dust? The ring paths
 *  are cut exactly ON the domain boundary (the wall-adjacent ring IS the
 *  domain polygon, the island rings ride the island expansions), so boundary
 *  points are legitimate and the ray-cast's parity must not decide them. */
function pointOnPolygonEdge(x: number, y: number, polygon: Point[]): boolean {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const ax = polygon[i].x
    const ay = polygon[i].y
    const bx = polygon[j].x
    const by = polygon[j].y
    const dx = bx - ax
    const dy = by - ay
    const lenSq = dx * dx + dy * dy
    if (lenSq <= 1e-18) continue
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq))
    const qx = ax + dx * t - x
    const qy = ay + dy * t - y
    if (qx * qx + qy * qy <= 1e-12) return true
  }
  return false
}

/** Region roots at tool-centre offset: the cleared-domain boundary for links. */
export interface TangentLinkDomainRegion {
  outer: Point[]
  islands: Point[][]
}

/**
 * Point-in-cleared-domain predicate for the band's tool-centre regions: inside
 * at least one outer and outside every island expansion.
 */
interface BoxedLoop {
  points: Point[]
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** Axis-aligned bounds, computed once so the per-sample scan can be skipped. */
function boxLoop(points: Point[]): BoxedLoop {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { points, minX, maxX, minY, maxY }
}

// `pointOnPolygonEdge` accepts a point within 1e-6 of an edge (it compares a
// squared distance against 1e-12), so a point marginally outside the bounds can
// still legitimately test as on-boundary. The box is inflated by exactly that
// tolerance before rejecting, which is what makes the prefilter conservative
// rather than merely plausible — an uninflated box changed the emitted program
// on three fixtures.
const EDGE_TOLERANCE = 1e-6

const outsideBox = (box: BoxedLoop, x: number, y: number): boolean =>
  x < box.minX - EDGE_TOLERANCE || x > box.maxX + EDGE_TOLERANCE
  || y < box.minY - EDGE_TOLERANCE || y > box.maxY + EDGE_TOLERANCE

export function buildOffsetDomainCheck(
  regions: TangentLinkDomainRegion[],
): (x: number, y: number) => boolean {
  // Bounds are precomputed per loop and rejected before any vertex scan. A
  // point outside a loop's bounding box cannot be inside the loop or on its
  // edge, so this cannot change an answer — only how many of the O(vertices)
  // scans run. The scan is the S-link solver's dominant cost: it runs twice
  // per loop per sample (containment, then edge), thousands of times per link.
  const boxed = regions.map((region) => ({
    outer: boxLoop(region.outer),
    islands: region.islands.map(boxLoop),
  }))
  return (x: number, y: number): boolean => {
    slinkDomainChecks += 1
    // Inside or ON an outer boundary (the ring paths ride the boundary);
    // rejected only when STRICTLY inside an island expansion — the island
    // rings themselves also ride that boundary, so boundary points pass.
    const inOuter = boxed.some((region) => !outsideBox(region.outer, x, y)
      && (slinkDomainScans += 1) > 0
      && (pointInPolygon(x, y, region.outer.points) || pointOnPolygonEdge(x, y, region.outer.points)))
    if (!inOuter) return false
    return !boxed.some((region) => region.islands.some((island) => !outsideBox(island, x, y)
      && (slinkDomainScans += 1) > 0
      && pointInPolygon(x, y, island.points) && !pointOnPolygonEdge(x, y, island.points)))
  }
}

/**
 * Tangent-link options for one pocket pass (issue #545). Returns undefined
 * when disabled or degenerate — undefined = today's straight links.
 */
export function pocketTangentLinkOptions(
  enabled: boolean | undefined,
  toolDiameter: number,
  domainRegions: TangentLinkDomainRegion[],
): TangentLinkOptions | undefined {
  if (!enabled) return undefined
  if (!(toolDiameter > 0) || domainRegions.length === 0) return undefined
  return {
    minRadius: toolDiameter * 0.25,
    maxLength: toolDiameter * 2.5,
    isInsideDomain: buildOffsetDomainCheck(domainRegions),
  }
}
