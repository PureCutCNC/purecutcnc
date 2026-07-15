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
 * Converts a medial-axis graph into V-carve toolpath moves.
 *
 * Depth per node follows the V-bit geometry: a bit with half-angle α cutting
 * at depth d exposes a flank radius of d·tan(α), so touching both walls at a
 * point with clearance c requires d = c / tan(α), clamped to the operation's
 * maximum depth (wide areas bottom out flat along the centerline).
 *
 * The graph is decomposed into chains (paths between junctions/leaves plus
 * pure cycles), each chain is simplified with a depth-aware Douglas-Peucker,
 * and chains are ordered greedily: continue at the shared junction node when
 * possible (tool stays down), otherwise retract and rapid to the nearest
 * chain entry.
 */

import type { ToolpathMove, ToolpathPoint } from '../types'
import { pushRapidAndPlunge, retractToSafe } from '../pocket'
import type { MedialGraph } from './medialAxis'

export interface MedialToolpathParams {
  /** Z of the material surface for this band. */
  topZ: number
  /** Maximum cut depth below topZ (positive number). */
  maxDepth: number
  /** tan(half V-bit angle): flank radius per unit depth. */
  slope: number
  safeZ: number
  /** XY-equivalent simplification tolerance (0 disables). */
  simplifyTolerance: number
  /**
   * When true, two chain ends may be bridged with a direct tool-down cut
   * instead of a retract when the connecting segment provably stays inside
   * material the V-carve already removes (see the effective-clearance test in
   * emitMedialToolpath). Disable to always retract between chains.
   */
  enableChainLinks: boolean
  /**
   * Clearance slack for redundant-branch pruning: a leaf branch is dropped
   * when every point's groove protrudes at most this far (in clearance units)
   * below the surface the remaining skeleton already cuts. 0 disables.
   */
  redundancyTolerance: number
  /** Tag emitted on cut moves when the operation has debug enabled. */
  debugSource?: string
}

interface Point3 {
  x: number
  y: number
  z: number
}

const POSITION_EPS = 1e-6
/**
 * Safety margin on the effective-clearance link test. A value below 1 keeps
 * the bridged segment strictly inside the already-carved disk rather than up
 * to its rim, absorbing sampling/float error.
 */
const LINK_CLEARANCE_FRACTION = 0.9

// ---------------------------------------------------------------------------
// Chain extraction
// ---------------------------------------------------------------------------

/**
 * Decompose the graph into node-index chains: every maximal path whose
 * interior nodes have degree 2, plus remaining pure cycles (closed chains
 * repeat their first node at the end), plus isolated single-node chains
 * (plunge points for dot-like regions).
 */
export function extractChains(graph: MedialGraph): number[][] {
  const n = graph.nodes.length
  const degree = graph.adjacency.map((neighbors) => neighbors.length)
  const visited = new Set<number>()
  const key = (a: number, b: number): number => (a < b ? a * n + b : b * n + a)
  const chains: number[][] = []

  const walk = (start: number, next: number): number[] => {
    const chain = [start]
    let prev = start
    let curr = next
    visited.add(key(start, next))
    while (degree[curr] === 2 && curr !== start) {
      chain.push(curr)
      const [a, b] = graph.adjacency[curr]
      const following = a === prev ? b : a
      if (visited.has(key(curr, following))) break
      visited.add(key(curr, following))
      prev = curr
      curr = following
    }
    chain.push(curr)
    return chain
  }

  for (let node = 0; node < n; node += 1) {
    if (degree[node] === 2 || degree[node] === 0) continue
    for (const neighbor of graph.adjacency[node]) {
      if (visited.has(key(node, neighbor))) continue
      chains.push(walk(node, neighbor))
    }
  }

  // Remaining unvisited edges belong to pure degree-2 cycles.
  for (let node = 0; node < n; node += 1) {
    if (degree[node] !== 2) continue
    for (const neighbor of graph.adjacency[node]) {
      if (visited.has(key(node, neighbor))) continue
      chains.push(walk(node, neighbor))
    }
  }

  for (let node = 0; node < n; node += 1) {
    if (degree[node] === 0) chains.push([node])
  }

  return chains
}

// ---------------------------------------------------------------------------
// Redundant-branch pruning
// ---------------------------------------------------------------------------

/**
 * Drop leaf chains that deepen the carved surface nowhere by more than
 * `tolerance` (clearance units): a V-groove at q covers the groove tip at p
 * exactly when dist(p,q) ≤ q.clearance − p.clearance, so with the slack a
 * branch is pruned when its groove everywhere protrudes at most
 * tolerance/tan(halfAngle) below what the remaining skeleton already cuts.
 * This is what terminal micro-branches (Voronoi wobble around stroke ends
 * and junctions) look like. Zero-clearance corner tips are exempt — they
 * exist to make the surface corner crisp, not to remove volume — and genuine
 * corner branches survive on their own because clearance falls steeply along
 * them.
 */
function pruneRedundantLeafChains(graph: MedialGraph, chains: number[][], tolerance: number): number[][] {
  if (chains.length <= 1 || tolerance <= 0) return chains
  const removed = new Set<number>()
  const alive = chains.map(() => true)

  const contained = (p: number, chainNodes: Set<number>): boolean => {
    const node = graph.nodes[p]
    for (let q = 0; q < graph.nodes.length; q += 1) {
      if (q === p || removed.has(q) || chainNodes.has(q)) continue
      const other = graph.nodes[q]
      const slack = other.clearance - node.clearance + tolerance
      if (slack <= 0) continue
      if (Math.hypot(node.x - other.x, node.y - other.y) <= slack) return true
    }
    return false
  }

  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false
    for (let index = 0; index < chains.length; index += 1) {
      if (!alive[index]) continue
      if (alive.filter(Boolean).length <= 1) break
      const chain = chains[index]
      const first = chain[0]
      const last = chain[chain.length - 1]
      const firstIsLeaf = graph.adjacency[first].length === 1
      const lastIsLeaf = graph.adjacency[last].length === 1
      if (firstIsLeaf === lastIsLeaf) continue // interior chain or floating segment
      const leaf = firstIsLeaf ? first : last
      if (graph.nodes[leaf].clearance < 1e-9) continue // corner tip — keep

      // The junction endpoint stays part of the remaining skeleton; only the
      // chain's own body may not vouch for itself.
      const junction = firstIsLeaf ? last : first
      const body = new Set(chain.filter((n) => n !== junction))
      if (chain.every((n) => n === junction || contained(n, body))) {
        alive[index] = false
        for (const n of body) removed.add(n)
        changed = true
      }
    }
    if (!changed) break
  }
  return chains.filter((_, index) => alive[index])
}

// ---------------------------------------------------------------------------
// Depth-aware simplification
// ---------------------------------------------------------------------------

/**
 * Douglas-Peucker where the deviation of a dropped point counts both its XY
 * distance to the chord and its Z error scaled by `slope` (a depth error of
 * dz is as visible as an XY error of dz·slope on the carved wall).
 */
function simplifyChain(points: Point3[], tolerance: number, slope: number): Point3[] {
  if (tolerance <= 0 || points.length <= 2) return points

  const deviation = (p: Point3, a: Point3, b: Point3): number => {
    const abx = b.x - a.x
    const aby = b.y - a.y
    const lenSq = abx * abx + aby * aby
    const t = lenSq > 1e-18
      ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq))
      : 0
    const xyDev = Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
    const zDev = Math.abs(p.z - (a.z + (b.z - a.z) * t)) * slope
    return Math.max(xyDev, zDev)
  }

  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number]
    if (hi - lo < 2) continue
    let worst = -1
    let worstDev = tolerance
    for (let i = lo + 1; i < hi; i += 1) {
      const dev = deviation(points[i], points[lo], points[hi])
      if (dev > worstDev) {
        worstDev = dev
        worst = i
      }
    }
    if (worst >= 0) {
      keep[worst] = true
      stack.push([lo, worst], [worst, hi])
    }
  }
  return points.filter((_, i) => keep[i])
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function samePointXY(a: Point3 | ToolpathPoint, b: Point3): boolean {
  return Math.abs(a.x - b.x) < POSITION_EPS && Math.abs(a.y - b.y) < POSITION_EPS
}

/**
 * Emit the toolpath for one region's medial graph. Returns the tool position
 * after the final retract (all region toolpaths end retracted at safeZ).
 */
export function emitMedialToolpath(
  graph: MedialGraph,
  params: MedialToolpathParams,
  moves: ToolpathMove[],
  startPosition: ToolpathPoint | null,
): ToolpathPoint | null {
  const depthOf = (clearance: number): number => Math.min(clearance / params.slope, params.maxDepth)
  // Radius of the V-bit's carved footprint at the material surface for a
  // skeleton point of the given clearance: the cone opens to depth·slope, and
  // depth is clamped by maxDepth, so the surface disk is
  // min(clearance, maxDepth·slope) — NOT the raw clearance. Using the raw
  // clearance would treat clamped wide areas as fully cleared and let a link
  // gouge across material the shallow groove never reaches.
  const carvedRadius = (clearance: number): number => depthOf(clearance) * params.slope
  const toPoint3 = (node: number): Point3 => ({
    x: graph.nodes[node].x,
    y: graph.nodes[node].y,
    z: params.topZ - depthOf(graph.nodes[node].clearance),
  })

  const chains = pruneRedundantLeafChains(graph, extractChains(graph), params.redundancyTolerance)
    .map((chain) => ({
      pts: simplifyChain(chain.map(toPoint3), params.simplifyTolerance, params.slope),
      startClearance: graph.nodes[chain[0]].clearance,
      endClearance: graph.nodes[chain[chain.length - 1]].clearance,
    }))
    .filter((chain) => chain.pts.length > 0)

  let position = startPosition
  // Clearance of the medial node the tool currently rests on (0 when the
  // position is not on the skeleton, e.g. the caller's starting point).
  let positionClearance = 0
  const remaining = new Set<number>(chains.keys())

  while (remaining.size > 0) {
    let bestChain = -1
    let bestReversed = false
    let bestCost = Infinity
    for (const index of remaining) {
      const { pts } = chains[index]
      const forward = position ? Math.hypot(pts[0].x - position.x, pts[0].y - position.y) : 0
      const backward = position
        ? Math.hypot(pts[pts.length - 1].x - position.x, pts[pts.length - 1].y - position.y)
        : 0
      const reversed = backward < forward
      const cost = Math.min(forward, backward)
      if (cost < bestCost) {
        bestCost = cost
        bestChain = index
        bestReversed = reversed
      }
      if (cost < POSITION_EPS) break
    }

    remaining.delete(bestChain)
    const picked = chains[bestChain]
    const chain = bestReversed ? [...picked.pts].reverse() : picked.pts
    const entryClearance = bestReversed ? picked.endClearance : picked.startClearance
    const exitClearance = bestReversed ? picked.startClearance : picked.endClearance
    const entry = chain[0]

    const gap = position ? Math.hypot(entry.x - position.x, entry.y - position.y) : Infinity
    // Safe to bridge only when the whole segment stays inside the surface disk
    // already carved at the tool's current point: that disk has radius
    // carvedRadius(positionClearance), so any target within it (and, kept
    // symmetric, within the destination's own carved disk) is over cleared
    // material. This uses the clamped effective clearance, so a shallow groove
    // in a wide region no longer authorises a wide cut across raw material.
    const linkReach = LINK_CLEARANCE_FRACTION
      * Math.min(carvedRadius(positionClearance), carvedRadius(entryClearance))
    const linkable = params.enableChainLinks
      && position !== null
      && position.z < params.safeZ - 1e-6
      && gap <= linkReach

    if (position === null) {
      position = pushRapidAndPlunge(moves, null, entry, params.safeZ)
    } else if (samePointXY(position, entry)) {
      // Continuing through a shared junction node — adjust Z in place if the
      // simplification left a small discrepancy.
      if (Math.abs(position.z - entry.z) > POSITION_EPS) {
        moves.push({ kind: entry.z < position.z ? 'plunge' : 'cut', from: position, to: entry })
      }
      position = entry
    } else if (linkable) {
      moves.push({
        kind: 'cut',
        from: position,
        to: entry,
        ...(params.debugSource ? { source: params.debugSource } : {}),
      })
      position = entry
    } else {
      position = retractToSafe(moves, position, params.safeZ)
      position = pushRapidAndPlunge(moves, position, entry, params.safeZ)
    }

    for (let i = 1; i < chain.length; i += 1) {
      moves.push({
        kind: 'cut',
        from: chain[i - 1],
        to: chain[i],
        ...(params.debugSource ? { source: params.debugSource } : {}),
      })
      position = chain[i]
    }
    positionClearance = exitClearance
  }

  return retractToSafe(moves, position, params.safeZ)
}
