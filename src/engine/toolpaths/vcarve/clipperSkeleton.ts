/**
 * Clipper-topology skeleton solver for V-carving.
 *
 * Extracts an approximate medial-axis skeleton by tracking contour lineages
 * through a sequence of inward Clipper offsets.
 *
 * Algorithm:
 *  1. Step inward from stepSize → maxRadius, computing Clipper insets from
 *     the original polygon at each step (absolute offset, not incremental).
 *  2. Match contours between consecutive frames by nearest centroid.
 *  3. One contour → two contours: split event → skeleton branch node +
 *     two new child lineages.
 *  4. Contour vanishes: collapse event → skeleton endpoint node.
 *  5. Between events: centroid path of each lineage becomes a skeleton arc.
 *
 * This works well for letter-stroke geometry where strokes are narrow relative
 * to their length. For annular shapes (e.g. letter O) the centroid stays fixed
 * as the annulus shrinks, yielding a single center node rather than a circular
 * arc — this is a known limitation of the centroid approximation.
 */

import ClipperLib from 'clipper-lib'
import type { Point } from '../../../types/project'
import type { ClipperSkeletonOptions, PreparedVCarveRegion, SkeletonGraph } from './types'
import type { ClipperPath } from '../types'
import { DEFAULT_CLIPPER_SCALE, fromClipperPath, normalizeWinding, toClipperPath } from '../geometry'

// ---------------------------------------------------------------------------
// Clipper helpers
// ---------------------------------------------------------------------------

function clipperPathArea(path: ClipperPath): number {
  let area = 0
  const n = path.length
  for (let i = 0; i < n; i++) {
    const a = path[i]
    const b = path[(i + 1) % n]
    area += a.X * b.Y - b.X * a.Y
  }
  return Math.abs(area) / 2
}

function clipperInset(paths: ClipperPath[], deltaClipper: number): ClipperPath[] {
  if (paths.length === 0) return []
  const co = new ClipperLib.ClipperOffset()
  co.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  co.Execute(solution, -deltaClipper)
  return solution as ClipperPath[]
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function computeCentroid(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 }
  let sx = 0
  let sy = 0
  for (const p of points) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / points.length, y: sy / points.length }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// ---------------------------------------------------------------------------
// Skeleton graph helpers
// ---------------------------------------------------------------------------

function pushArc(graph: SkeletonGraph, start: Point, end: Point, r0: number, r1: number): void {
  if (dist(start, end) < 1e-9 && Math.abs(r0 - r1) < 1e-9) return
  graph.arcs.push({ start: { ...start }, end: { ...end }, startRadius: r0, endRadius: r1 })
}

function pushNode(graph: SkeletonGraph, point: Point, radius: number): void {
  graph.nodes.push({ point: { ...point }, radius })
}

/**
 * Emit terminal geometry for a lineage that is ending (collapse or maxRadius).
 *
 * Case A — lineage came from a split (fromSplit=true):
 *   The centroid-path arcs (emitted later from lineage.frames) already trace
 *   the skeleton arm. Just emit a terminal node at the tip.
 *
 * Case B — lineage never split (fromSplit=false):
 *   The centroid barely moves so the arc sequence is nearly a dot. Instead,
 *   emit the last surviving polygon boundary as arcs — this polygon IS the
 *   approximate medial axis for shapes that shrink without splitting (F, T,
 *   rectangle, circle, triangle).
 */
function emitTerminal(graph: SkeletonGraph, lineage: Lineage): void {
  const last = lineage.frames[lineage.frames.length - 1]
  if (lineage.fromSplit) {
    pushNode(graph, last.centroid, last.d)
  } else {
    const pts = last.points
    if (pts.length >= 3) {
      for (let i = 0; i < pts.length; i++) {
        pushArc(graph, pts[i], pts[(i + 1) % pts.length], last.d, last.d)
      }
    } else if (pts.length === 2) {
      pushArc(graph, pts[0], pts[1], last.d, last.d)
    } else {
      pushNode(graph, last.centroid, last.d)
    }
  }
}

// ---------------------------------------------------------------------------
// Lineage types
// ---------------------------------------------------------------------------

interface LineageFrame {
  d: number
  centroid: Point
  points: Point[] // polygon vertices at this frame (for polygon-boundary fallback)
}

interface Lineage {
  id: number
  frames: LineageFrame[]
  fromSplit: boolean // true if this lineage was spawned by a split event
}

// ---------------------------------------------------------------------------
// Main solver
// ---------------------------------------------------------------------------

export function solveClipperSkeleton(
  region: PreparedVCarveRegion,
  options: ClipperSkeletonOptions = {},
): SkeletonGraph {
  const stepSize = Math.max(0.001, options.stepSize ?? 0.05)
  const maxRadius = Math.max(stepSize * 2, options.maxRadius ?? 10)
  const scale = DEFAULT_CLIPPER_SCALE
  const graph: SkeletonGraph = { arcs: [], nodes: [] }

  // Build initial Clipper paths: outer CCW, holes CW.
  const outerCCW = normalizeWinding(region.outer, false)
  const initialPaths: ClipperPath[] = [
    toClipperPath(outerCCW, scale),
    ...region.holes.map(h => toClipperPath(normalizeWinding(h, true), scale)),
  ]

  // Contours whose area falls below this threshold (in Clipper integer units²)
  // are considered collapsed / sliver artifacts and are ignored.
  const minAreaClipper = stepSize * stepSize * scale * scale

  function getValidContours(d: number): Array<{ centroid: Point; points: Point[] }> {
    const inset = clipperInset(initialPaths, Math.round(d * scale))
    return inset
      .filter(path => clipperPathArea(path) > minAreaClipper)
      .map((path) => {
        const points = fromClipperPath(path, scale)
        return { centroid: computeCentroid(points), points }
      })
  }

  // -------------------------------------------------------------------------
  // Bootstrap: first frame at d = stepSize
  // -------------------------------------------------------------------------
  const firstContours = getValidContours(stepSize)
  if (firstContours.length === 0) return graph

  let nextId = 0

  let aliveLineages: Lineage[] = firstContours.map(({ centroid, points }) => ({
    id: nextId++,
    frames: [{ d: stepSize, centroid, points }],
    fromSplit: false,
  }))

  // allLineages accumulates every lineage ever created so we can emit arcs at
  // the end in one pass, after all frames have been processed.
  const allLineages: Lineage[] = [...aliveLineages]

  // -------------------------------------------------------------------------
  // Step through frames
  // -------------------------------------------------------------------------
  const maxSteps = Math.ceil(maxRadius / stepSize) + 1

  for (let step = 2; step <= maxSteps; step++) {
    const d = Math.min(step * stepSize, maxRadius)
    const currContours = getValidContours(d)

    if (currContours.length === 0) {
      // Every region collapsed in this step.
      for (const lineage of aliveLineages) {
        const last = lineage.frames[lineage.frames.length - 1]
        pushNode(graph, last.centroid, last.d)
      }
      aliveLineages = []
      break
    }

    // Assign each current contour to the alive lineage whose last centroid is
    // nearest.  This is an O(curr × alive) nearest-neighbour match which is
    // fine for the small contour counts produced by Clipper offsets.
    const assignment: number[] = currContours.map(({ centroid: cc }) => {
      let bestId = -1
      let bestDist = Infinity
      for (const lin of aliveLineages) {
        const prev = lin.frames[lin.frames.length - 1].centroid
        const d2 = dist(cc, prev)
        if (d2 < bestDist) {
          bestDist = d2
          bestId = lin.id
        }
      }
      return bestId
    })

    // Invert: lineageId → [indices of curr contours assigned to it]
    const parentToChildren = new Map<number, number[]>()
    for (let ci = 0; ci < assignment.length; ci++) {
      const pid = assignment[ci]
      if (pid < 0) continue
      const existing = parentToChildren.get(pid)
      if (existing) {
        existing.push(ci)
      } else {
        parentToChildren.set(pid, [ci])
      }
    }

    const nextAlive: Lineage[] = []

    for (const lineage of aliveLineages) {
      const children = parentToChildren.get(lineage.id)

      if (!children || children.length === 0) {
        // ── Collapse: this contour disappeared ──────────────────────────────
        emitTerminal(graph, lineage)
        continue
      }

      if (children.length === 1) {
        // ── Continuation: one-to-one match ──────────────────────────────────
        const { centroid, points } = currContours[children[0]]
        lineage.frames.push({ d, centroid, points })
        nextAlive.push(lineage)
        continue
      }

      // ── Split: one region became multiple ─────────────────────────────────
      // The parent lineage ends here; a branch node is emitted at its last
      // known centroid.  Each child starts a new lineage from that same point
      // so the graph is properly connected.
      const splitFrame = lineage.frames[lineage.frames.length - 1]
      pushNode(graph, splitFrame.centroid, splitFrame.d)

      for (const ci of children) {
        const { centroid, points } = currContours[ci]
        const child: Lineage = {
          id: nextId++,
          frames: [
            { d: splitFrame.d, centroid: splitFrame.centroid, points: splitFrame.points },
            { d, centroid, points },
          ],
          fromSplit: true,
        }
        allLineages.push(child)
        nextAlive.push(child)
      }
    }

    aliveLineages = nextAlive
    if (aliveLineages.length === 0 || d >= maxRadius) break
  }

  // Lineages still alive when we hit maxRadius: emit terminal geometry.
  for (const lineage of aliveLineages) {
    emitTerminal(graph, lineage)
  }

  // -------------------------------------------------------------------------
  // Emit skeleton arcs from lineage frame sequences
  // -------------------------------------------------------------------------
  for (const lineage of allLineages) {
    for (let i = 0; i + 1 < lineage.frames.length; i++) {
      const f0 = lineage.frames[i]
      const f1 = lineage.frames[i + 1]
      pushArc(graph, f0.centroid, f1.centroid, f0.d, f1.d)
    }
  }

  return graph
}

// ---------------------------------------------------------------------------
// Utility: convert a PreparedVCarveRegion to Clipper paths (for callers that
// need direct access to the offset geometry).
// ---------------------------------------------------------------------------

export function regionToClipperPaths(region: PreparedVCarveRegion, scale = DEFAULT_CLIPPER_SCALE): ClipperPath[] {
  const outerPath = toClipperPath(normalizeWinding(region.outer, false), scale)
  const holePaths = region.holes.map(h => toClipperPath(normalizeWinding(h, true), scale))
  return [outerPath, ...holePaths]
}
