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

/**
 * Tangent fillet for one link↔ring junction, exact on the actual segments
 * (issue #545).
 *
 * The link is a single straight segment; the ring side is a polyline of
 * tessellated chords. A fillet tangent to a straight line (the link) and to
 * the ring polyline is constructed per candidate ring vertex: the arc is the
 * circle tangent to the link's line AND to the chord line at the chosen ring
 * vertex, so both tangent points lie exactly on the emitted segments — the
 * ring-side tangent point is a ring vertex (the caller consumes whole chords,
 * never interpolates) and the link-side tangent point truncates the link
 * move. This replaces the earlier straight-extension construction, whose
 * tangent points drifted off curved ring runs and disconnected the stream.
 *
 * Returns the tessellated arc from the link-side tangent point to the
 * ring-side tangent vertex, plus the two consumption distances — or null when
 * no candidate fits (radius floor, domain, or the link segment is too short).
 */
export interface JunctionFilletResult {
  points: Point[]
  /** Distance from the corner toward the link's far end of the link-side tangent point. */
  linkTangent: number
  /** Number of whole ring chords consumed (the ring-side tangent point is a ring vertex). */
  ringChordsConsumed: number
}

export function linkJunctionFillet(
  corner: Point,
  linkEnd: Point,
  linkLength: number,
  ringVertices: Point[],
  options: LinkFilletOptions,
): JunctionFilletResult | null {
  if (linkLength <= EPS || ringVertices.length < 2) return null
  // ringVertices[0] must be the corner; the list follows the ring's travel
  // direction away from the corner.
  if (
    Math.abs(ringVertices[0].x - corner.x) > 1e-9
    || Math.abs(ringVertices[0].y - corner.y) > 1e-9
  ) {
    return null
  }
  const linkDirX = (linkEnd.x - corner.x) / linkLength
  const linkDirY = (linkEnd.y - corner.y) / linkLength
  const minDeflection = options.minDeflectionRadians
    ?? (DEFAULT_MIN_DEFLECTION_DEG * Math.PI) / 180
  const runCap = Math.min(linkLength, options.toolRadius / 2)
  const arcStep = Math.max(options.arcStepRadians ?? DEFAULT_FLATTEN_ARC_STEP, 1e-3)

  // Walk the ring vertices within the collinear run and the cap.
  const vertexDistances: number[] = [0]
  let accumulated = 0
  for (let index = 1; index < ringVertices.length; index += 1) {
    const chord = Math.hypot(
      ringVertices[index].x - ringVertices[index - 1].x,
      ringVertices[index].y - ringVertices[index - 1].y,
    )
    if (chord <= 1e-9) break
    if (index >= 2) {
      const baseX = ringVertices[1].x - ringVertices[0].x
      const baseY = ringVertices[1].y - ringVertices[0].y
      const baseLen = Math.hypot(baseX, baseY)
      if (baseLen > 1e-9) {
        const dirX = (ringVertices[index].x - ringVertices[index - 1].x) / chord
        const dirY = (ringVertices[index].y - ringVertices[index - 1].y) / chord
        const cross = (baseX / baseLen) * dirY - (baseY / baseLen) * dirX
        const dot = Math.max(-1, Math.min(1, (baseX / baseLen) * dirX + (baseY / baseLen) * dirY))
        const deviation = Math.abs(Math.atan2(cross, dot))
        if (deviation >= minDeflection) break
      }
    }
    if (accumulated + chord > runCap) break
    accumulated += chord
    vertexDistances.push(accumulated)
  }
  const candidates = vertexDistances.length - 1
  if (candidates === 0) return null

  const insideArc = (points: Point[]): boolean => {
    if (!options.isInsideDomain(points[0].x, points[0].y)) return false
    if (!options.isInsideDomain(points[points.length - 1].x, points[points.length - 1].y)) return false
    const step = Math.max(1, Math.floor((points.length - 2) / DOMAIN_SAMPLES))
    for (let index = step; index < points.length - 1; index += step) {
      if (!options.isInsideDomain(points[index].x, points[index].y)) return false
    }
    return true
  }

  // Largest tangent span first.
  for (let k = candidates; k >= 1; k -= 1) {
    const ringTangentPoint = ringVertices[k]
    if (k + 1 >= ringVertices.length) continue
    const chordAfterX = ringVertices[k + 1].x - ringTangentPoint.x
    const chordAfterY = ringVertices[k + 1].y - ringTangentPoint.y
    const chordAfterLen = Math.hypot(chordAfterX, chordAfterY)
    if (chordAfterLen <= 1e-9) continue
    const ringDirX = chordAfterX / chordAfterLen
    const ringDirY = chordAfterY / chordAfterLen

    // The junction turn uses the direction heading INTO the corner (the
    // travel direction), not the away direction the link coordinate uses.
    const turn = Math.atan2(-linkDirX * ringDirY + linkDirY * ringDirX, -linkDirX * ringDirX - linkDirY * ringDirY)
    const deflection = Math.abs(turn)
    if (deflection < minDeflection) continue
    if (Math.PI - deflection <= EPS) continue

    // Circle tangent to the link line at T1 and to the ring chord line at the
    // ring tangent vertex: the centre sits on the perpendicular to the ring
    // chord at the vertex, at radius r, and its distance to the link line is
    // also r. Solve r from the signed tangency equation a + b·r = r (or the
    // mirrored branch), where a = cross(ringVertex - corner, linkDir) and
    // b = cross(ringNormal, linkDir).
    const interiorNormalX = turn >= 0 ? -ringDirY : ringDirY
    const interiorNormalY = turn >= 0 ? ringDirX : -ringDirX
    const a = (ringTangentPoint.x - corner.x) * linkDirY - (ringTangentPoint.y - corner.y) * linkDirX
    const b = interiorNormalX * linkDirY - interiorNormalY * linkDirX
    let radius = Number.NaN
    for (const candidateRadius of [a / (1 - b), -a / (1 + b)]) {
      if (!(candidateRadius > 0)) continue
      const residual = a + b * candidateRadius
      if (Math.abs(Math.abs(residual) - candidateRadius) <= 1e-9 * Math.max(1, candidateRadius)) {
        radius = candidateRadius
        break
      }
    }
    if (!(radius > 0) || !(radius >= options.minRadius) || radius > options.maxRadius) continue

    const centreX = ringTangentPoint.x + interiorNormalX * radius
    const centreY = ringTangentPoint.y + interiorNormalY * radius
    // Foot of the centre on the link line: the link-side tangent point, at a
    // positive distance along the link segment from the corner.
    const linkTangent = (centreX - corner.x) * linkDirX + (centreY - corner.y) * linkDirY
    if (!(linkTangent >= 0) || linkTangent > linkLength + 1e-9) continue
    const tangent1: Point = {
      x: corner.x + linkTangent * linkDirX,
      y: corner.y + linkTangent * linkDirY,
    }
    const distT1 = Math.hypot(tangent1.x - centreX, tangent1.y - centreY)
    if (Math.abs(distT1 - radius) > 1e-9 * Math.max(1, radius)) continue

    // Tessellate the arc from T1 to the ring vertex around the centre.
    const startAngle = Math.atan2(tangent1.y - centreY, tangent1.x - centreX)
    const endAngle = Math.atan2(ringTangentPoint.y - centreY, ringTangentPoint.x - centreX)
    let sweep = endAngle - startAngle
    while (sweep > Math.PI) sweep -= 2 * Math.PI
    while (sweep <= -Math.PI) sweep += 2 * Math.PI
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / arcStep))
    const points: Point[] = [tangent1]
    for (let step = 1; step < steps; step += 1) {
      const angle = startAngle + (sweep * step) / steps
      points.push({
        x: centreX + radius * Math.cos(angle),
        y: centreY + radius * Math.sin(angle),
      })
    }
    points.push(ringTangentPoint)
    if (!insideArc(points)) continue
    return { points, linkTangent, ringChordsConsumed: k }
  }
  return null
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
