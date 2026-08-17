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

// Tangential ring-to-ring link junctions for offset pocket clearing (issue
// #545).
//
// The straight link between two clearing rings makes two abrupt direction
// changes — one leaving the ring just cut, one picking up the next. This
// module replaces each junction's sharp corner with a tangent circular-arc
// fillet, tessellated to line segments (the toolpath move model is
// polyline-only). A fillet is tangent to the ring at the junction and tangent
// to the link, so the tool eases onto the next ring in the direction of travel
// instead of turning onto it — and leaves the ring just cut the same way. It is
// the same emit-time mechanism offsetSmoothing uses for ring corners, whose
// per-corner tessellated fillets were measured as the cycle-time winner in
// #546.
//
// The radius is bounded three ways, each of which keeps the fillet safe:
//
//  - domain: every point of the arc must lie inside the cleared domain (the
//    band's tool-centre region: inside the wall-adjacent outer, outside island
//    expansions) — otherwise the corner stays sharp. The wall-adjacent ring
//    has the tightest outward budget, and a bulge past it would enter
//    wall-side stock.
//  - coverage: the tangent setback is capped at half the tool radius, which
//    keeps the trimmed corner wedge inside the disk sweep of the truncated
//    adjacent segment — the fillet can never leave material behind. (The
//    wedge's points lie within 2·tangent of the tangent point, and
//    2·tangent ≤ tool radius.)
//  - segment fit: the tangent points never extend past the actual segment
//    lengths, so fillets at neighbouring junctions cannot overlap.
//
// The straight link itself is unchanged: the rings' own swaths already cover
// the strip between them (stepover ≤ tool diameter, validated at generation),
// so the link is a positioning move and reshaping its ends cannot leave
// material. Feed classification runs downstream on the emitted moves and needs
// no change.

import type { Point } from '../../types/project'
import { DEFAULT_FLATTEN_ARC_STEP } from './geometry'

const EPS = 1e-9
const DEFAULT_MIN_DEFLECTION_DEG = 20
const DOMAIN_SAMPLES = 6

export interface LinkFilletOptions {
  /** Upper bound on the fillet radius, in project units. */
  maxRadius: number
  /** Smallest radius worth emitting; a corner that cannot fit at least this
   *  stays sharp (today's behaviour). */
  minRadius: number
  /** Tool radius — caps the tangent setback so the trimmed corner wedge stays
   *  inside the sweep of the truncated adjacent segment. */
  toolRadius: number
  /** Angular tessellation step for the fillet arc, in radians. */
  arcStepRadians?: number
  /** Only turns whose deflection exceeds this get a fillet; gentler turns are
   *  already smooth enough for the machine. */
  minDeflectionRadians?: number
  /** True when a tool-centre position lies inside the cleared domain the link
   *  may sweep (inside the wall-adjacent outer, outside island expansions). */
  isInsideDomain: (x: number, y: number) => boolean
}

function signedTurn(uIn: Point, uOut: Point): number {
  return Math.atan2(uIn.x * uOut.y - uIn.y * uOut.x, uIn.x * uOut.x + uIn.y * uOut.y)
}

/**
 * Tangent fillet points for one link↔ring junction.
 *
 * corner is the junction point, incomingDir the unit direction of the segment
 * ending there (pointing along the direction of travel), outgoingDir the unit
 * direction of the segment leaving it, and incomingLength / outgoingLength the
 * full lengths of those two segments.
 *
 * Returns [tangentOnIncoming, …, tangentOnOutgoing] — the tessellated arc
 * starting where the truncated incoming segment ends and ending where the
 * truncated outgoing segment begins — or null when the junction stays sharp
 * (too gentle to matter, degenerate, or no radius ≥ minRadius fits the domain).
 */
export function linkJunctionFillet(
  corner: Point,
  incomingDir: Point,
  outgoingDir: Point,
  incomingLength: number,
  outgoingLength: number,
  options: LinkFilletOptions,
): Point[] | null {
  const turn = signedTurn(incomingDir, outgoingDir)
  const deflection = Math.abs(turn)
  const minDeflection = options.minDeflectionRadians
    ?? (DEFAULT_MIN_DEFLECTION_DEG * Math.PI) / 180
  if (deflection < minDeflection) return null

  const interior = Math.PI - deflection
  if (interior <= EPS) return null
  const tanHalf = Math.tan(interior / 2)
  const sinHalf = Math.sin(interior / 2)
  if (!(tanHalf > EPS) || !(sinHalf > EPS)) return null

  // Away-vectors: the interior bisector lies between them (mirrors
  // offsetSmoothing's corner construction).
  const vIn = { x: -incomingDir.x, y: -incomingDir.y }
  const vOut = outgoingDir
  const bisector = { x: vIn.x + vOut.x, y: vIn.y + vOut.y }
  const bisectorLen = Math.hypot(bisector.x, bisector.y)
  if (bisectorLen <= EPS) return null
  const unitBisector = { x: bisector.x / bisectorLen, y: bisector.y / bisectorLen }

  // Tangent setback cap: the two segment lengths and half the tool radius
  // (the wedge-coverage bound).
  const tangentCap = Math.min(incomingLength, outgoingLength, options.toolRadius / 2)
  if (!(tangentCap > EPS)) return null

  const maxRadius = Math.min(options.maxRadius, tangentCap / tanHalf)
  if (maxRadius < options.minRadius) return null

  const arcStep = Math.max(options.arcStepRadians ?? DEFAULT_FLATTEN_ARC_STEP, 1e-3)
  const buildArc = (radius: number): Point[] => {
    const tangent = radius * tanHalf
    const entry = { x: corner.x + vIn.x * tangent, y: corner.y + vIn.y * tangent }
    const exit = { x: corner.x + vOut.x * tangent, y: corner.y + vOut.y * tangent }
    const centreDistance = radius / sinHalf
    const centre = {
      x: corner.x + unitBisector.x * centreDistance,
      y: corner.y + unitBisector.y * centreDistance,
    }
    const startAngle = Math.atan2(entry.y - centre.y, entry.x - centre.x)
    const endAngle = Math.atan2(exit.y - centre.y, exit.x - centre.x)
    let sweep = endAngle - startAngle
    while (sweep > Math.PI) sweep -= 2 * Math.PI
    while (sweep <= -Math.PI) sweep += 2 * Math.PI
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / arcStep))
    const points: Point[] = [entry]
    for (let step = 1; step < steps; step += 1) {
      const angle = startAngle + (sweep * step) / steps
      points.push({
        x: centre.x + radius * Math.cos(angle),
        y: centre.y + radius * Math.sin(angle),
      })
    }
    points.push(exit)
    return points
  }

  const insideArc = (points: Point[]): boolean => {
    if (!options.isInsideDomain(points[0].x, points[0].y)) return false
    if (!options.isInsideDomain(points[points.length - 1].x, points[points.length - 1].y)) return false
    const step = Math.max(1, Math.floor((points.length - 2) / DOMAIN_SAMPLES))
    for (let index = step; index < points.length - 1; index += step) {
      if (!options.isInsideDomain(points[index].x, points[index].y)) return false
    }
    return true
  }

  // Largest radius ≤ maxRadius whose arc stays inside the cleared domain.
  let lo = 0
  let hi = maxRadius
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const mid = (lo + hi) / 2
    if (insideArc(buildArc(mid))) lo = mid
    else hi = mid
  }
  if (lo < options.minRadius) return null
  return buildArc(lo)
}

/**
 * Length of the collinear run from the corner along a closed contour: the
 * distance from cornerIndex to the first vertex where the contour direction
 * deviates from the corner's own segment direction by at least
 * minDeflectionRadians, capped at maxLength. Tessellated arcs consist of
 * near-collinear chords (5 degree steps); their junction fillets must be
 * allowed to consume the run of chords up to the next real corner rather than
 * just the single adjacent chord. The cap keeps the run within the tangent
 * bound the coverage argument needs.
 */
export function collinearRunLength(
  points: Point[],
  cornerIndex: number,
  step: 1 | -1,
  maxLength: number,
  minDeflectionRadians: number,
): number {
  const count = points.length
  if (count < 2 || !(maxLength > 0)) return 0
  const next = (index: number): number => (index + count) % count
  const a = points[cornerIndex]
  const b = points[next(cornerIndex + step)]
  const baseDx = b.x - a.x
  const baseDy = b.y - a.y
  const baseLen = Math.hypot(baseDx, baseDy)
  if (baseLen <= 1e-9) return 0
  const baseDirX = baseDx / baseLen
  const baseDirY = baseDy / baseLen
  let total = 0
  let index = cornerIndex
  let previous = a
  for (let walked = 0; walked < count - 1; walked += 1) {
    const current = points[next(index + step)]
    const dx = current.x - previous.x
    const dy = current.y - previous.y
    const len = Math.hypot(dx, dy)
    // Near-zero-length chords are tessellation noise: their direction is
    // arbitrary and must not end the run (nor contribute length).
    if (len <= 1e-9) {
      previous = current
      index = next(index + step)
      continue
    }
    const dirX = dx / len
    const dirY = dy / len
    const cross = baseDirX * dirY - baseDirY * dirX
    const dot = Math.max(-1, Math.min(1, baseDirX * dirX + baseDirY * dirY))
    const deviation = Math.abs(Math.atan2(cross, dot))
    if (deviation >= minDeflectionRadians) break
    if (total + len > maxLength) {
      return maxLength
    }
    total += len
    previous = current
    index = next(index + step)
  }
  return total
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

/** Region roots at tool-centre offset: the cleared-domain boundary for links. */
export interface LinkFilletDomainRegion {
  outer: Point[]
  islands: Point[][]
}

/**
 * Point-in-cleared-domain predicate for the band's tool-centre regions: inside
 * at least one outer and outside every island expansion.
 */
export function buildOffsetDomainCheck(
  regions: LinkFilletDomainRegion[],
): (x: number, y: number) => boolean {
  return (x: number, y: number): boolean => {
    if (!regions.some((region) => pointInPolygon(x, y, region.outer))) return false
    return !regions.some((region) => region.islands.some((island) => pointInPolygon(x, y, island)))
  }
}

/**
 * Link-fillet options for one pocket pass (issue #545). Returns undefined when
 * disabled or degenerate so callers can pass the result straight through —
 * undefined = today's exact, unsmoothed link junctions.
 */
export function pocketLinkFilletOptions(
  enabled: boolean | undefined,
  toolRadius: number,
  stepover: number,
  domainRegions: LinkFilletDomainRegion[],
): LinkFilletOptions | undefined {
  if (!enabled) return undefined
  const toolDiameter = toolRadius * 2
  const maxRadius = toolDiameter * 0.4
  const minRadius = Math.max(stepover * 0.5, 1e-9)
  if (!(maxRadius > 0) || !(toolRadius > 0) || domainRegions.length === 0) return undefined
  return {
    maxRadius,
    minRadius,
    toolRadius,
    isInsideDomain: buildOffsetDomainCheck(domainRegions),
  }
}
