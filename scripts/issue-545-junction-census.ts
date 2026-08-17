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
 * Junction census + tangent-link gate probe for issue #545.
 *
 * One-off diagnostic, not a quality gate. Two measurements over every real
 * offset-pocket operation in the repo:
 *
 *  A. Junction census: cut-to-cut junctions in the emitted move stream,
 *     classified R (ring segment) / L (constant-Z XY link) by whether the
 *     move midpoint lies on a ring polyline built with the same construction
 *     generation uses. Buckets: R→R (corner), R→L (exit), L→R (entry), L→L.
 *
 *  B. Gate probe (review point 1): for every logical link (adjacent link
 *     fragments merged), build the arc-line-arc tangent candidate with the
 *     junction direction on the tangent bisector, then a sampled sweep; gate
 *     it against the band's tool-centre domain (inside wall outers, outside
 *     island boundaries) exactly as the implementation's domain check would.
 *     Reports the tangent-vs-fallback split and the segment-count delta.
 *
 * Usage: npx tsx scripts/issue-545-junction-census.ts [tracked] [nomesh]
 *   tracked — restrict the corpus to git-tracked .camj files
 *   nomesh  — exclude mesh/rest fixtures (stl-test-cat, rest-test,
 *             excluded-region-test, Tele53*)
 */

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

import ClipperLib from 'clipper-lib'
import {
  buildContourLoops,
  buildInsetRegions,
  buildOffsetRegionTree,
  buildOuterContours,
  executeDifference,
  polyTreeToRegions,
  type OffsetRegionNode,
  generatePocketToolpath,
} from '../src/engine/toolpaths/pocket'
import type { ResolvedPocketRegion } from '../src/engine/toolpaths/types'
import {
  applyContourDirection,
  DEFAULT_CLIPPER_SCALE,
  normalizeToolForProject,
  normalizeWinding,
  toClipperPath,
} from '../src/engine/toolpaths/geometry'
import { cornerSmoothingRadius, roundContourCorners } from '../src/engine/toolpaths/offsetSmoothing'
import { isFeatureFirst, perFeatureOperations } from '../src/engine/toolpaths/multiFeature'
import { buildRegionMask, splitFeatureTargets } from '../src/engine/toolpaths/regions'
import { resolveRegionDomainArea } from '../src/engine/toolpaths/regionDomain'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver'
import { unionClipperPaths } from '../src/engine/toolpaths/modelProtection'
import type { ToolpathMove } from '../src/engine/toolpaths/types'
import type { Operation, Project, Tool } from '../src/types/project'
import { normalizeProject } from '../src/store/helpers/projectFormat'

type Pt = { x: number; y: number }
/** Flat XY polyline (undirected). */
type Poly = number[]

function pointOnPolys(x: number, y: number, polys: Poly[]): boolean {
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i += 2) {
      const next = (i + 2) % poly.length
      const ax = poly[i]
      const ay = poly[i + 1]
      const bx = poly[next]
      const by = poly[next + 1]
      const dx = bx - ax
      const dy = by - ay
      const lenSq = dx * dx + dy * dy
      if (lenSq <= 1e-18) continue
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq))
      const qx = ax + dx * t - x
      const qy = ay + dy * t - y
      if (qx * qx + qy * qy <= 1e-12) return true
    }
  }
  return false
}

function minDistToPolys(x: number, y: number, polys: Poly[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const poly of polys) {
    for (let i = 0; i + 2 < poly.length; i += 2) {
      const ax = poly[i]
      const ay = poly[i + 1]
      const bx = poly[i + 2]
      const by = poly[i + 3]
      const dx = bx - ax
      const dy = by - ay
      const lenSq = dx * dx + dy * dy
      const t = lenSq > 1e-18
        ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq))
        : 0
      const qx = ax + dx * t - x
      const qy = ay + dy * t - y
      const d = Math.sqrt(qx * qx + qy * qy)
      if (d < best) best = d
    }
  }
  return best
}

function pointInPoly(x: number, y: number, poly: Poly): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i]
    const yi = poly[i + 1]
    const xj = poly[j]
    const yj = poly[j + 1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function insideDomain(x: number, y: number, outers: Poly[], islands: Poly[]): boolean {
  if (!outers.some((outer) => pointInPoly(x, y, outer))) return false
  return !islands.some((island) => pointInPoly(x, y, island))
}

function collectRingPolylines(
  node: OffsetRegionNode,
  depth: number,
  smoothRadius: number | null,
  out: Poly[],
  wallOuters: Poly[],
  islandBoundaries: Poly[],
): void {
  const outer = node.region.outer.length >= 3 ? node.region.outer : null
  const smoothedOuter = outer
    ? (smoothRadius !== null && depth > 0 ? roundContourCorners(outer, smoothRadius) : outer)
    : null
  const contours: Pt[][] = []
  if (smoothedOuter) contours.push(smoothedOuter)
  const islands = node.region.islands.filter((island) => island.length >= 3)
  for (const island of islands) contours.push(island)
  for (let c = 0; c < contours.length; c += 1) {
    for (const contour of applyContourDirection([contours[c]], 'conventional')) {
      const poly: number[] = []
      for (const p of contour) poly.push(p.x, p.y)
      out.push(poly)
      if (depth === 0) {
        if (c === 0 && smoothedOuter) wallOuters.push(poly)
        else islandBoundaries.push(poly)
      }
    }
  }
  for (const child of node.children) {
    collectRingPolylines(child, depth + 1, smoothRadius, out, wallOuters, islandBoundaries)
  }
}

function collectRingPolylinesOuterOnly(
  node: OffsetRegionNode,
  depth: number,
  smoothRadius: number | null,
  out: Poly[],
): void {
  const outer = node.region.outer.length >= 3 ? node.region.outer : null
  if (outer) {
    const smoothed = smoothRadius !== null && depth > 0 ? roundContourCorners(outer, smoothRadius) : outer
    for (const contour of applyContourDirection([smoothed], 'conventional')) {
      const poly: number[] = []
      for (const p of contour) poly.push(p.x, p.y)
      out.push(poly)
    }
  }
  for (const child of node.children) collectRingPolylinesOuterOnly(child, depth + 1, smoothRadius, out)
}

interface BandPolys {
  polys: Poly[]
  wallOuters: Poly[]
  islandBoundaries: Poly[]
}

function ringsForBand(
  project: Project,
  operation: Operation,
  band: { topZ: number; bottomZ: number; regions: ResolvedPocketRegion[]; targetFeatureIds: string[]; islandFeatureIds: string[] },
  tool: Tool,
): BandPolys {
  const polys: Poly[] = []
  const wallOuters: Poly[] = []
  const islandBoundaries: Poly[] = []
  const toolRadius = tool.diameter / 2
  const stepoverDistance = tool.diameter * operation.stepover
  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const direction = operation.cutDirection ?? 'conventional'
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)

  // The region-mask rewrite from generatePocketToolpathSingle.
  let regions = band.regions
  const regionMask = operation.target.source === 'features'
    ? buildRegionMask(splitFeatureTargets(project, operation.target.featureIds).regionFeatures)
    : null
  if (regionMask) {
    const centreInset = toolRadius + radialLeave
    const outerPaths = regions.map((r) => toClipperPath(normalizeWinding(r.outer, false), DEFAULT_CLIPPER_SCALE))
    const bandDomain = unionClipperPaths(outerPaths)
    if (bandDomain.length === 0) return { polys, wallOuters, islandBoundaries }
    const maskedDomain = resolveRegionDomainArea(bandDomain, regionMask, centreInset)
    if (maskedDomain.length === 0) return { polys, wallOuters, islandBoundaries }
    const islandPaths = regions.flatMap((r) =>
      r.islands.map((island) => toClipperPath(normalizeWinding(island, false), DEFAULT_CLIPPER_SCALE)),
    )
    const polyTree = executeDifference(maskedDomain, islandPaths)
    regions = polyTreeToRegions(polyTree, band.targetFeatureIds, band.islandFeatureIds, DEFAULT_CLIPPER_SCALE)
    if (regions.length === 0) return { polys, wallOuters, islandBoundaries }
  }

  if (operation.pass === 'finish') {
    const finishDelta = toolRadius + radialLeave
    const finishRegions = regions.flatMap((region) => buildInsetRegions(region, finishDelta))
    // The wall-finish tool-centre path is the domain boundary for floor links.
    for (const region of finishRegions) {
      for (const contour of applyContourDirection([region.outer], direction)) {
        const poly: number[] = []
        for (const p of contour) poly.push(p.x, p.y)
        wallOuters.push(poly)
      }
      for (const island of region.islands) {
        if (island.length < 3) continue
        for (const contour of applyContourDirection([island], direction)) {
          const poly: number[] = []
          for (const p of contour) poly.push(p.x, p.y)
          islandBoundaries.push(poly)
        }
      }
    }
    if (operation.finishFloor && operation.kind === 'pocket' && operation.pocketPattern !== 'parallel') {
      const floorStepover = Math.max(stepoverDistance, minStepover)
      const floorSmoothRadius = cornerSmoothingRadius(operation.roundOutsideCorners, toolRadius, floorStepover)
      const floorTrees = finishRegions
        .flatMap((region) => buildInsetRegions(region, 0))
        .flatMap((region) => buildInsetRegions(region, floorStepover))
        .map((region) => buildOffsetRegionTree(region, floorStepover))
      for (const tree of floorTrees) collectRingPolylinesOuterOnly(tree, 0, floorSmoothRadius, polys)
    }
    if (operation.finishWalls) {
      if (operation.roundOutsideCorners) {
        const roundedWallRegions = regions.flatMap((region) => buildInsetRegions(
          region, finishDelta, ClipperLib.JoinType.jtMiter, ClipperLib.JoinType.jtRound,
        ))
        for (const contour of applyContourDirection(buildOuterContours(roundedWallRegions), direction)) {
          const poly: number[] = []
          for (const p of contour) poly.push(p.x, p.y)
          polys.push(poly)
        }
      } else {
        for (const contour of applyContourDirection(buildContourLoops(finishRegions), direction)) {
          const poly: number[] = []
          for (const p of contour) poly.push(p.x, p.y)
          polys.push(poly)
        }
      }
    }
    return { polys, wallOuters, islandBoundaries }
  }

  if (operation.kind === 'pocket' && operation.pocketPattern === 'parallel') {
    // Parallel pattern has no rings; nothing to classify here.
    return { polys, wallOuters, islandBoundaries }
  }

  const initialInset = toolRadius + radialLeave
  const islandJoinType = operation.roundOutsideCorners
    ? ClipperLib.JoinType.jtRound
    : ClipperLib.JoinType.jtMiter
  const regionTrees = regions
    .flatMap((region) => buildInsetRegions(region, initialInset, ClipperLib.JoinType.jtMiter, islandJoinType))
    .map((region) => buildOffsetRegionTree(region, effectiveStepover, islandJoinType))
  const smoothRadius = cornerSmoothingRadius(operation.roundOutsideCorners, toolRadius, effectiveStepover)
  for (const tree of regionTrees) {
    collectRingPolylines(tree, 0, smoothRadius, polys, wallOuters, islandBoundaries)
  }
  return { polys, wallOuters, islandBoundaries }
}

// ── Tangent gate probe (review point 1) ─────────────────────────────────────────────────────

interface Vec { x: number; y: number }

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y })
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

/** Tessellate arc from A (start tangent t, signed turn δ, signed radius ρ) to B. */
function tessArc(pts: Pt[], a: Pt, t: Vec, delta: number, rho: number, b: Pt): void {
  const center: Pt = { x: a.x - rho * t.y, y: a.y + rho * t.x }
  const chordTol = Math.max(1e-3, Math.abs(rho) * 0.01)
  const dTheta = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - chordTol / Math.abs(rho))))
  const n = Math.max(1, Math.ceil(Math.abs(delta) / dTheta))
  for (let k = 1; k < n; k += 1) {
    const dir = rot(t, (delta * k) / n)
    pts.push({ x: center.x + rho * dir.y, y: center.y - rho * dir.x })
  }
  pts.push(b)
}

type GateOutcome =
  | 'already-tangent'
  | 'fits-D'
  | 'fits-2.5D'
  | 'too-long'
  | 'domain-wall'
  | 'domain-island'
  | 'infeasible'
  | 'cross-region'
  | 'no-context'

interface Candidate {
  pts: Pt[]
  length: number
}

/**
 * Arc-line-arc solver v2. For a junction direction m: arc1 (signed turn
 * φ1, signed radius σ1·r1) from P along t0, straight middle s·m, arc2
 * (signed turn φ2, signed radius σ2·r2) ending at Q along t1. Closure
 * d = c1 + s·m + c2 leaves one free parameter; two canonicals pin one radius
 * to rMin each and solve the other radius plus s. Direction candidates: the
 * tangent bisector plus a ±120° sweep around t0 in 7.5° steps, because the
 * lateral-step S-link bows OUT of the t0/t1 cone. Returns the feasible
 * candidate with the shortest path length up to maxLen, or null.
 */
function tangentCandidate(
  p: Pt, t0: Vec, q: Pt, t1: Vec, rMin: number, maxLen: number,
): Candidate | null {
  const d = sub(q, p)
  const straightLen = len(d)
  if (straightLen <= 1e-9) return null

  const candidates: Vec[] = [norm(add(t0, t1))]
  for (let k = -16; k <= 16; k += 1) {
    if (k === 0) continue
    candidates.push(rot(t0, (k * 7.5 * Math.PI) / 180))
  }

  let best: Candidate | null = null
  for (const m of candidates) {
    const phi1 = signedAngle(t0, m)
    const phi2 = signedAngle(m, t1)
    if (Math.abs(phi1) > Math.PI - 1e-6 || Math.abs(phi2) > Math.PI - 1e-6) continue
    if (Math.abs(phi1) < 1e-9 && Math.abs(phi2) < 1e-9) continue
    const sigma1 = phi1 >= 0 ? 1 : -1
    const sigma2 = phi2 >= 0 ? 1 : -1
    const a1 = mul(rot(t0, phi1 / 2), 2 * sigma1 * Math.sin(phi1 / 2))
    const a2 = mul(rot(m, phi2 / 2), 2 * sigma2 * Math.sin(phi2 / 2))
    const trySolve = (r1Pin: number, r2Pin: number): Candidate | null => {
      let r1 = r1Pin
      let r2 = r2Pin
      if (r1Pin > 0) {
        const denom = cross(m, a2)
        if (Math.abs(denom) < 1e-12) return null
        r2 = cross(m, sub(d, mul(a1, r1Pin))) / denom
        if (r2 < rMin) return null
      } else {
        const denom = cross(m, a1)
        if (Math.abs(denom) < 1e-12) return null
        r1 = cross(m, sub(d, mul(a2, r2Pin))) / denom
        if (r1 < rMin) return null
      }
      const s = dot(m, sub(d, add(mul(a1, r1), mul(a2, r2))))
      if (s < 0) return null
      const end1 = add(p, mul(a1, r1))
      const start2 = sub(q, mul(a2, r2))
      const pts: Pt[] = [p]
      if (Math.abs(phi1) > 1e-9) tessArc(pts, p, t0, phi1, sigma1 * r1, end1)
      else pts.push(end1)
      if (s > 1e-9) pts.push(start2)
      if (Math.abs(phi2) > 1e-9) tessArc(pts, start2, m, phi2, sigma2 * r2, q)
      else pts.push(q)
      pts[pts.length - 1] = q
      const pathLen = pts.slice(1).reduce(
        (sum, pt, index) => sum + Math.hypot(pt.x - pts[index].x, pt.y - pts[index].y),
        0,
      )
      if (pathLen > maxLen) return null
      return { pts, length: pathLen }
    }
    const found = trySolve(rMin, -1) ?? trySolve(-1, rMin)
    if (found && (best === null || found.length < best.length)) best = found
  }
  return best
}

// ── Tangent lead-out probe (family B: movable entry point) ────────────────

type LeadOutcome =
  | 'leadout-smooth'
  | 'leadout-45'
  | 'leadout-90'
  | 'leadout-miss'
  | 'leadout-domain'
  | 'leadout-no-target'

interface LeadResult {
  outcome: LeadOutcome
  lambda: number
  entryAngleDeg: number
}

/**
 * Family B: leave ring N straight along its exit tangent t0 and enter ring
 * N+1 where that line first hits it. The exit junction becomes 0° by
 * construction; the entry junction becomes the angle between t0 and the
 * ring's tangent at the hit point (typically ~30-45° instead of ~90° radial).
 * Returns the first hit with λ ≤ maxLambda that stays inside the domain, or
 * the failure reason.
 */
function tangentLeadOut(
  p: Pt,
  t0: Vec,
  q: Pt,
  targetRing: Poly,
  outers: Poly[],
  islands: Poly[],
  maxLambda: number,
): LeadResult {
  let bestLambda = Number.POSITIVE_INFINITY
  let bestTangent: Vec | null = null
  for (let i = 0; i + 2 < targetRing.length; i += 2) {
    const ax = targetRing[i]
    const ay = targetRing[i + 1]
    const bx = targetRing[i + 2]
    const by = targetRing[i + 3]
    const dx = bx - ax
    const dy = by - ay
    // P + λ·t0 = A + μ·(B−A)
    const denom = t0.x * dy - t0.y * dx
    if (Math.abs(denom) < 1e-12) continue
    const px = ax - p.x
    const py = ay - p.y
    const lambda = (px * dy - py * dx) / denom
    const mu = (px * t0.y - py * t0.x) / denom
    if (lambda <= 1e-9 || lambda > maxLambda) continue
    if (mu < -1e-9 || mu > 1 + 1e-9) continue
    if (lambda < bestLambda) {
      bestLambda = lambda
      bestTangent = norm({ x: dx, y: dy })
    }
  }
  if (bestTangent === null) return { outcome: 'leadout-miss', lambda: 0, entryAngleDeg: 0 }
  // Domain check along the straight lead-out.
  for (let s = 1; s <= 4; s += 1) {
    const t = s / 4
    const x = p.x + t0.x * bestLambda * t
    const y = p.y + t0.y * bestLambda * t
    if (!insideDomain(x, y, outers, islands)) return { outcome: 'leadout-domain', lambda: bestLambda, entryAngleDeg: 0 }
  }
  const entryAngleDeg = (Math.abs(signedAngle(t0, bestTangent)) * 180) / Math.PI
  const outcome: LeadOutcome = entryAngleDeg <= 15
    ? 'leadout-smooth'
    : entryAngleDeg <= 45
      ? 'leadout-45'
      : 'leadout-90'
  return { outcome, lambda: bestLambda, entryAngleDeg }
}

// ── Junction-fillet probe (family D: corridor-bounded corner rounding) ──────

/**
 * Family D: fillet the two link junctions with the largest radius that keeps
 * the fillet arc inside the cleared domain. A fillet is tangent to the ring
 * at the junction and tangent to the link, so each junction becomes a
 * tessellated arc (the same mechanism offsetSmoothing already uses for ring
 * corners) instead of one sharp turn. Returns the max fitting radius.
 */
// ── File census ──────────────────────────────────────────────────────────

interface FileRow {
  file: string
  ops: number
  parallelJunctions: number
  cuts: number
  ringCuts: number
  linkCuts: number
  rl: number
  lr: number
  rr: number
  ll: number
  onRl: number
  onLr: number
  onRr: number
  linkLenMean: number
  linkLenMax: number
  entryTurnP50: number
  entryTurnP95: number
  wallAdjacentLinks: number
  meanClearance: number
  gate: Record<GateOutcome, number>
  gateLinks: number
  extraSegments: number
  addedLength: number
  straightLength: number
  leadout: Record<LeadOutcome, number>
  leadoutLambdaMean: number
  leadoutAngleP50: number
  leadoutAngleP95: number
  fillet: Record<FilletBucket, number>
  filletSegments: number
}

const THRESHOLD = 60

interface ClassifiedCut { move: ToolpathMove; cls: 'ring' | 'link' }

function censusFile(file: string): FileRow | null {
  let project: Project
  try {
    project = normalizeProject(JSON.parse(readFileSync(file, 'utf8')) as Project)
  } catch {
    return null
  }
  const ops = project.operations.filter((op) => op.kind === 'pocket' && op.enabled !== false)
  if (ops.length === 0) return null

  let cuts = 0
  let ringCuts = 0
  let linkCuts = 0
  let rl = 0
  let lr = 0
  let rr = 0
  let ll = 0
  const linkLengths: number[] = []
  const entryTurns: number[] = []

  let parallelJunctions = 0
  let wallAdjacentLinks = 0
  let nonWallMinClearanceSum = 0
  let nonWallClearanceCount = 0
  const gate: Record<GateOutcome, number> = {
    'already-tangent': 0,
    'fits-D': 0,
    'fits-2.5D': 0,
    'too-long': 0,
    'domain-wall': 0,
    'domain-island': 0,
    infeasible: 0,
    'cross-region': 0,
    'no-context': 0,
  }
  let gateLinks = 0
  let extraSegments = 0
  let addedLength = 0
  let straightLength = 0
  const leadout: Record<LeadOutcome, number> = {
    'leadout-smooth': 0,
    'leadout-45': 0,
    'leadout-90': 0,
    'leadout-miss': 0,
    'leadout-domain': 0,
    'leadout-no-target': 0,
  }
  const leadoutLambdas: number[] = []
  const leadoutAngles: number[] = []
  const fillet: Record<FilletBucket, number> = {
    'exit-fillet': 0,
    'exit-fallback': 0,
    'entry-fillet': 0,
    'entry-fallback': 0,
    'no-context': 0,
  }
  let filletSegments = 0

  for (const op of ops) {
    if (op.kind === 'pocket' && op.pocketPattern === 'parallel') {
      const parallelResult = generatePocketToolpath(project, op)
      const pCuts = parallelResult.moves.filter((m) => m.kind === 'cut')
      for (let i = 0; i + 1 < pCuts.length; i += 1) {
        const a = pCuts[i]
        const b = pCuts[i + 1]
        if (Math.abs(a.to.x - b.from.x) > 1e-6 || Math.abs(a.to.y - b.from.y) > 1e-6) continue
        const inX = a.to.x - a.from.x
        const inY = a.to.y - a.from.y
        const outX = b.to.x - b.from.x
        const outY = b.to.y - b.from.y
        const inLen = Math.hypot(inX, inY)
        const outLen = Math.hypot(outX, outY)
        if (inLen < 1e-9 || outLen < 1e-9) continue
        const cos = Math.max(-1, Math.min(1, (inX * outX + inY * outY) / (inLen * outLen)))
        const turn = (Math.acos(cos) * 180) / Math.PI
        if (turn >= THRESHOLD) parallelJunctions += 1
      }
      continue
    }
    const result = generatePocketToolpath(project, { ...op, roundLinkCorners: undefined })
    const subOps = isFeatureFirst(op, project) ? perFeatureOperations(op, project) : [op]
    const polys: Poly[] = []
    const wallOuters: Poly[] = []
    const islandBoundaries: Poly[] = []
    const toolRecord = project.tools.find((t) => t.id === op.toolRef)
    if (!toolRecord) continue
    const tool = normalizeToolForProject(toolRecord, project)
    const stepoverDistance = tool.diameter * op.stepover
    const rMin = stepoverDistance
    const budgetD = tool.diameter
    const budget2_5D = tool.diameter * 2.5
    for (const subOp of subOps) {
      const resolved = resolvePocketRegions(project, subOp)
      for (const band of resolved.bands) {
        const bandPolys = ringsForBand(project, subOp, band, tool)
        polys.push(...bandPolys.polys)
        wallOuters.push(...bandPolys.wallOuters)
        islandBoundaries.push(...bandPolys.islandBoundaries)
      }
    }

    const classify = (move: ToolpathMove): 'ring' | 'link' | 'other' => {
      if (move.kind !== 'cut') return 'other'
      if (Math.abs(move.to.z - move.from.z) > 1e-9) return 'other'
      const midX = (move.from.x + move.to.x) / 2
      const midY = (move.from.y + move.to.y) / 2
      return pointOnPolys(midX, midY, polys) ? 'ring' : 'link'
    }

    const cutsArr: ClassifiedCut[] = []
    for (const move of result.moves) {
      if (move.kind !== 'cut') continue
      const cls = classify(move)
      if (cls === 'other') continue
      cuts += 1
      if (cls === 'ring') {
        ringCuts += 1
      } else {
        linkCuts += 1
        linkLengths.push(Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y))
        const endOnWall = pointOnPolys(move.to.x, move.to.y, wallOuters)
        if (endOnWall) {
          wallAdjacentLinks += 1
        } else {
          const midX = (move.from.x + move.to.x) / 2
          const midY = (move.from.y + move.to.y) / 2
          nonWallMinClearanceSum += minDistToPolys(midX, midY, polys)
          nonWallClearanceCount += 1
        }
      }
      cutsArr.push({ move, cls })
    }

    for (let i = 0; i + 1 < cutsArr.length; i += 1) {
      const a = cutsArr[i]
      const b = cutsArr[i + 1]
      if (Math.abs(a.move.to.x - b.move.from.x) > 1e-6 || Math.abs(a.move.to.y - b.move.from.y) > 1e-6) continue
      const inX = a.move.to.x - a.move.from.x
      const inY = a.move.to.y - a.move.from.y
      const outX = b.move.to.x - b.move.from.x
      const outY = b.move.to.y - b.move.from.y
      const inLen = Math.hypot(inX, inY)
      const outLen = Math.hypot(outX, outY)
      if (inLen < 1e-9 || outLen < 1e-9) continue
      const cos = Math.max(-1, Math.min(1, (inX * outX + inY * outY) / (inLen * outLen)))
      const turn = (Math.acos(cos) * 180) / Math.PI
      if (turn < THRESHOLD) continue
      if (a.cls === 'ring' && b.cls === 'link') {
        rl += 1
        entryTurns.push(turn)
      } else if (a.cls === 'link' && b.cls === 'ring') {
        lr += 1
        entryTurns.push(turn)
      } else if (a.cls === 'ring' && b.cls === 'ring') {
        rr += 1
      } else if (a.cls === 'link' && b.cls === 'link') {
        ll += 1
      }
    }

    // Gate probe: merge adjacent link fragments into logical links and try the
    // tangent candidate against the band domain.
    for (let i = 0; i < cutsArr.length; ) {
      if (cutsArr[i].cls !== 'link') {
        i += 1
        continue
      }
      let end = i
      while (
        end + 1 < cutsArr.length
        && cutsArr[end + 1].cls === 'link'
        && Math.abs(cutsArr[end].move.to.x - cutsArr[end + 1].move.from.x) <= 1e-6
        && Math.abs(cutsArr[end].move.to.y - cutsArr[end + 1].move.from.y) <= 1e-6
      ) {
        end += 1
      }
      const from = cutsArr[i].move.from
      const to = cutsArr[end].move.to
      const prev = i > 0 ? cutsArr[i - 1] : null
      const next = end + 1 < cutsArr.length ? cutsArr[end + 1] : null
      const prevConnects = prev !== null
        && Math.abs(prev.move.to.x - from.x) <= 1e-6
        && Math.abs(prev.move.to.y - from.y) <= 1e-6
      const nextConnects = next !== null
        && Math.abs(next.move.from.x - to.x) <= 1e-6
        && Math.abs(next.move.from.y - to.y) <= 1e-6
      const straightLen = Math.hypot(to.x - from.x, to.y - from.y)
      gateLinks += 1
      straightLength += straightLen
      let outcome: GateOutcome = 'no-context'
      let segments = end - i + 1
      if (prevConnects && nextConnects && prev!.cls === 'ring' && next!.cls === 'ring') {
        const t0 = norm(sub(prev!.move.to, prev!.move.from))
        const t1 = norm(sub(next!.move.to, next!.move.from))
        const linkDir = norm(sub(to, from))
        // Tangency is measured against the straight link direction, not t0 vs
        // t1: the common lateral-step link has t0 ≈ t1 but a radial direction.
        const exitTurn = (Math.abs(signedAngle(t0, linkDir)) * 180) / Math.PI
        const entryTurn = (Math.abs(signedAngle(linkDir, t1)) * 180) / Math.PI
        const pInside = insideDomain(from.x, from.y, wallOuters, islandBoundaries)
        const qInside = insideDomain(to.x, to.y, wallOuters, islandBoundaries)
        if (!pInside || !qInside) {
          outcome = 'cross-region'
        } else if (exitTurn <= 1 && entryTurn <= 1) {
          outcome = 'already-tangent'
        } else {
          const candidate = tangentCandidate(from, t0, to, t1, rMin, budget2_5D)
          if (candidate === null) {
            outcome = 'infeasible'
          } else {
            let wallViolation = false
            let islandViolation = false
            for (const pt of candidate.pts) {
              if (!insideDomain(pt.x, pt.y, wallOuters, islandBoundaries)) {
                if (islandBoundaries.some((island) => pointInPoly(pt.x, pt.y, island))) islandViolation = true
                else wallViolation = true
              }
            }
            if (wallViolation) {
              outcome = 'domain-wall'
            } else if (islandViolation) {
              outcome = 'domain-island'
            } else if (candidate.length <= budgetD) {
              outcome = 'fits-D'
            } else {
              outcome = 'fits-2.5D'
            }
            if (outcome === 'fits-D' || outcome === 'fits-2.5D') {
              segments = candidate.pts.length - 1
              extraSegments += Math.max(0, segments - (end - i + 1))
              addedLength += candidate.length - straightLen
            }
          }
        }
      }
      gate[outcome] += 1

      // Family B probe: tangent lead-out with movable entry point.
      if (prevConnects && nextConnects && prev!.cls === 'ring' && next!.cls === 'ring') {
        const t0 = norm(sub(prev!.move.to, prev!.move.from))
        const targetRing = polys.find((poly) =>
          pointOnPolys(to.x, to.y, [poly])
          && pointOnPolys((next!.move.from.x + next!.move.to.x) / 2, (next!.move.from.y + next!.move.to.y) / 2, [poly]),
        )
        if (targetRing === undefined) {
          leadout['leadout-no-target'] += 1
        } else {
          const result = tangentLeadOut(from, t0, to, targetRing, wallOuters, islandBoundaries, budget2_5D)
          leadout[result.outcome] += 1
          if (result.outcome !== 'leadout-miss' && result.outcome !== 'leadout-no-target') {
            leadoutLambdas.push(result.lambda)
            if (result.outcome !== 'leadout-domain') leadoutAngles.push(result.entryAngleDeg)
          }
        }
      } else {
        leadout['leadout-no-target'] += 1
      }

      i = end + 1
    }
  }

  // Production comparison: the same ops with roundLinkCorners on — the
  // authoritative acceptance measurement (the family-D probe above is an
  // approximation; the generated stream is the truth).
  let onRl = 0
  let onLr = 0
  let onRr = 0
  for (const op of ops) {
    if (op.kind === 'pocket' && op.pocketPattern === 'parallel') continue
    const onResult = generatePocketToolpath(project, { ...op, roundLinkCorners: true })
    const onPolys: Poly[] = []
    const toolRecord2 = project.tools.find((t) => t.id === op.toolRef)
    if (!toolRecord2) continue
    const tool2 = normalizeToolForProject(toolRecord2, project)
    for (const subOp of isFeatureFirst(op, project) ? perFeatureOperations(op, project) : [op]) {
      const resolved2 = resolvePocketRegions(project, subOp)
      for (const band of resolved2.bands) {
        const bandPolys2 = ringsForBand(project, subOp, band, tool2)
        onPolys.push(...bandPolys2.polys)
      }
    }
    const onCuts = onResult.moves
      .filter((move) => move.kind === 'cut' && Math.abs(move.to.z - move.from.z) <= 1e-9)
      .map((move) => ({
        move,
        cls: pointOnPolys((move.from.x + move.to.x) / 2, (move.from.y + move.to.y) / 2, onPolys) ? 'ring' as const : 'link' as const,
      }))
    for (let index = 0; index + 1 < onCuts.length; index += 1) {
      const a = onCuts[index]
      const b = onCuts[index + 1]
      if (Math.abs(a.move.to.x - b.move.from.x) > 1e-6 || Math.abs(a.move.to.y - b.move.from.y) > 1e-6) continue
      const inX = a.move.to.x - a.move.from.x
      const inY = a.move.to.y - a.move.from.y
      const outX = b.move.to.x - b.move.from.x
      const outY = b.move.to.y - b.move.from.y
      const inLen = Math.hypot(inX, inY)
      const outLen = Math.hypot(outX, outY)
      if (inLen < 1e-9 || outLen < 1e-9) continue
      const cos = Math.max(-1, Math.min(1, (inX * outX + inY * outY) / (inLen * outLen)))
      const turn = (Math.acos(cos) * 180) / Math.PI
      if (turn < THRESHOLD) continue
      if (a.cls === 'ring' && b.cls === 'link') onRl += 1
      else if (a.cls === 'link' && b.cls === 'ring') onLr += 1
      else if (a.cls === 'ring' && b.cls === 'ring') onRr += 1
    }
  }

  const median = (arr: number[]): number => {
    if (arr.length === 0) return NaN
    const sorted = [...arr].sort((x, y) => x - y)
    return sorted[Math.floor(sorted.length / 2)]
  }
  const p95 = (arr: number[]): number => {
    if (arr.length === 0) return NaN
    const sorted = [...arr].sort((x, y) => x - y)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
  }

  return {
    file,
    ops: ops.length,
    parallelJunctions,
    cuts,
    ringCuts,
    linkCuts,
    rl,
    lr,
    rr,
    ll,
    linkLenMean: linkLengths.length ? linkLengths.reduce((s, v) => s + v, 0) / linkLengths.length : 0,
    linkLenMax: linkLengths.length ? Math.max(...linkLengths) : 0,
    entryTurnP50: median(entryTurns),
    entryTurnP95: p95(entryTurns),
    onRl,
    onLr,
    onRr,
    wallAdjacentLinks,
    meanClearance: nonWallClearanceCount > 0 ? nonWallMinClearanceSum / nonWallClearanceCount : 0,
    gate,
    gateLinks,
    extraSegments,
    addedLength,
    straightLength,
    leadout,
    leadoutLambdaMean: leadoutLambdas.length
      ? leadoutLambdas.reduce((s, v) => s + v, 0) / leadoutLambdas.length
      : 0,
    leadoutAngleP50: median(leadoutAngles),
    leadoutAngleP95: p95(leadoutAngles),
    fillet,
    filletSegments,
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

const trackedOnly = process.argv.includes('tracked')
const noMesh = process.argv.includes('nomesh')
const ROOT = '/Users/frankp/Projects/purecutcnc'
const allFiles = execSync("find . -path ./node_modules -prune -o -name '*.camj' -print", { cwd: ROOT })
  .toString().trim().split('\n')
  .filter((f) => f.includes('work/') || f.includes('public/examples') || f.includes('src/engine/test-fixtures'))
  .map((f) => ROOT + '/' + f.replace(/^\.\//, ''))
const trackedFiles = new Set(execSync("git ls-files '*.camj'", { cwd: ROOT })
  .toString().trim().split('\n').map((f) => ROOT + '/' + f))
const meshNoise = ['stl-test-cat', 'rest-test', 'excluded-region-test', 'Tele53']
const files = allFiles.filter((f) => {
  if (trackedOnly && !trackedFiles.has(f)) return false
  if (noMesh && meshNoise.some((name) => f.includes(name))) return false
  return true
})

const rows: FileRow[] = []
for (const file of files) {
  const row = censusFile(file)
  if (row) rows.push(row)
}

const fmt = (v: number, digits = 1): string => (Number.isFinite(v) ? v.toFixed(digits) : '  –')
const headers = ['file', 'ops', 'cuts', 'ring', 'link', 'RL≥60', 'LR≥60', 'RR≥60', 'LL≥60', 'lenMean', 'lenMax', 'tP50', 'tP95', 'exitF', 'entryF']
console.log(headers.map((h, i) => h.padStart(i < 2 ? 38 : 8)).join(''))
for (const row of rows) {
  const exitTotal = row.fillet['exit-fillet'] + row.fillet['exit-fallback']
  const entryTotal = row.fillet['entry-fillet'] + row.fillet['entry-fallback']
  const cells = [
    row.file.replace(ROOT + '/', '').slice(0, 37),
    row.ops, row.cuts, row.ringCuts, row.linkCuts, row.rl, row.lr, row.rr, row.ll,
    fmt(row.linkLenMean, 3), fmt(row.linkLenMax, 3), fmt(row.entryTurnP50, 0), fmt(row.entryTurnP95, 0),
    exitTotal > 0 ? Math.round((100 * row.fillet['exit-fillet']) / exitTotal) + '%' : '–',
    entryTotal > 0 ? Math.round((100 * row.fillet['entry-fillet']) / entryTotal) + '%' : '–',
  ]
  console.log(cells.map((v, i) => String(v).padStart(i < 2 ? 38 : 8)).join(''))
}

const totals = rows.reduce((acc, row) => {
  acc.ops += row.ops
  acc.cuts += row.cuts
  acc.ringCuts += row.ringCuts
  acc.linkCuts += row.linkCuts
  acc.rl += row.rl
  acc.lr += row.lr
  acc.rr += row.rr
  acc.ll += row.ll
  acc.onRl += row.onRl
  acc.onLr += row.onLr
  acc.onRr += row.onRr
  acc.maxLen = Math.max(acc.maxLen, row.linkLenMax)
  acc.wallAdjacent += row.wallAdjacentLinks
  acc.clearanceSum += row.meanClearance * row.linkCuts
  acc.gateLinks += row.gateLinks
  for (const key of Object.keys(row.gate) as GateOutcome[]) acc.gate[key] += row.gate[key]
  for (const key of Object.keys(row.leadout) as LeadOutcome[]) acc.leadout[key] += row.leadout[key]
  for (const key of Object.keys(row.fillet) as FilletBucket[]) acc.fillet[key] += row.fillet[key]
  acc.filletSegments += row.filletSegments
  acc.extraSegments += row.extraSegments
  acc.addedLength += row.addedLength
  acc.straightLength += row.straightLength
  acc.leadoutLambdaSum += row.leadoutLambdaMean * row.gateLinks
  acc.leadoutAngles.push(row.leadoutAngleP50, row.leadoutAngleP95)
  return acc
}, {
  ops: 0, cuts: 0, ringCuts: 0, linkCuts: 0, rl: 0, lr: 0, rr: 0, ll: 0, onRl: 0, onLr: 0, onRr: 0, maxLen: 0,
  wallAdjacent: 0, clearanceSum: 0, gateLinks: 0,
  gate: {
    'already-tangent': 0,
    'fits-D': 0,
    'fits-2.5D': 0,
    'too-long': 0,
    'domain-wall': 0,
    'domain-island': 0,
    infeasible: 0,
    'cross-region': 0,
    'no-context': 0,
  } as Record<GateOutcome, number>,
  leadout: {
    'leadout-smooth': 0,
    'leadout-45': 0,
    'leadout-90': 0,
    'leadout-miss': 0,
    'leadout-domain': 0,
    'leadout-no-target': 0,
  } as Record<LeadOutcome, number>,
  fillet: {
    'exit-fillet': 0,
    'exit-fallback': 0,
    'entry-fillet': 0,
    'entry-fallback': 0,
    'no-context': 0,
  } as Record<FilletBucket, number>,
  filletSegments: 0,
  extraSegments: 0, addedLength: 0, straightLength: 0,
  leadoutLambdaSum: 0,
  leadoutAngles: [] as number[],
})
console.log('—'.repeat(150))
console.log(
  ['TOTAL', totals.ops, totals.cuts, totals.ringCuts, totals.linkCuts, totals.rl, totals.lr, totals.rr, totals.ll, '', fmt(totals.maxLen, 3), '', '']
    .map((v, i) => String(v).padStart(i < 2 ? 38 : 8)).join(''),
)
console.log('ring-to-ring link junctions (RL+LR) at >=60°: ' + (totals.rl + totals.lr))
console.log('PRODUCTION roundLinkCorners=on: sharp exit ' + totals.onRl + ' (was ' + totals.rl + '), sharp entry ' + totals.onLr + ' (was ' + totals.lr + '), corners ' + totals.onRr + ' (was ' + totals.rr + ')')
console.log('ring corner junctions (RR) at >=60°: ' + totals.rr)
console.log('parallel-pattern slot reversals at >=60°: ' + rows.reduce((s, r) => s + r.parallelJunctions, 0))
console.log('links ending on a wall-adjacent ring: ' + totals.wallAdjacent + ' of ' + totals.linkCuts)
console.log('mean corridor clearance at non-wall links (midpoint to nearest ring): ' + (totals.clearanceSum / Math.max(1, totals.linkCuts)).toFixed(4))
console.log('link cuts: ' + totals.linkCuts + ' of ' + totals.cuts + ' cuts (' + ((100 * totals.linkCuts) / Math.max(1, totals.cuts)).toFixed(1) + '%)')
console.log('')
console.log('── Tangent gate probe (logical links: ' + totals.gateLinks + ') ──')
for (const key of Object.keys(totals.gate) as GateOutcome[]) {
  const count = totals.gate[key]
  console.log('  ' + key.padEnd(16) + String(count).padStart(6) + '  ' + ((100 * count) / Math.max(1, totals.gateLinks)).toFixed(1) + '%')
}
const fitted = totals.gate['fits-D'] + totals.gate['fits-2.5D'] + totals.gate['already-tangent']
console.log('tangent-emitted links (already-tangent + fits-D + fits-2.5D): ' + fitted + ' of ' + totals.gateLinks + ' (' + ((100 * fitted) / Math.max(1, totals.gateLinks)).toFixed(1) + '%)')
console.log('  of which within today\'s 1\u00d7D budget: ' + (totals.gate['fits-D'] + totals.gate['already-tangent']))
console.log('  of which need the relaxed 2.5\u00d7D budget: ' + totals.gate['fits-2.5D'])
console.log('segment delta for fitted links: +' + totals.extraSegments + ' moves')
console.log('path length delta for fitted links: +' + totals.addedLength.toFixed(2) + ' units (straight total ' + totals.straightLength.toFixed(2) + ')')
console.log('')
console.log('── Tangent lead-out probe (family B: movable entry point, 2.5\u00d7D budget) ──')
for (const key of Object.keys(totals.leadout) as LeadOutcome[]) {
  const count = totals.leadout[key]
  console.log('  ' + key.padEnd(16) + String(count).padStart(6) + '  ' + ((100 * count) / Math.max(1, totals.gateLinks)).toFixed(1) + '%')
}
const leadoutEmitted = totals.leadout['leadout-smooth'] + totals.leadout['leadout-45'] + totals.leadout['leadout-90']
console.log('lead-out links emitted: ' + leadoutEmitted + ' of ' + totals.gateLinks + ' (' + ((100 * leadoutEmitted) / Math.max(1, totals.gateLinks)).toFixed(1) + '%)')
console.log('mean lead-out lambda: ' + (totals.leadoutLambdaSum / Math.max(1, totals.gateLinks)).toFixed(3) + ' (straight links total ' + totals.straightLength.toFixed(2) + ')')
const angles = totals.leadoutAngles.filter((v) => Number.isFinite(v))
if (angles.length > 0) {
  const sorted = [...angles].sort((x, y) => x - y)
  console.log('entry angle at hit: p50 ' + sorted[Math.floor(sorted.length / 2)].toFixed(1) + '°, p95 ' + sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)].toFixed(1) + '°')
}
