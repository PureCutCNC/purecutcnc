/**
 * Copyright 2026 Franja (Frank) Povazanj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import ClipperLib from 'clipper-lib'
import type { Point } from '../../types/project'
import type { ClipperPath, ToolpathMove } from './types'

type IntPoint = ClipperPath[number]

interface CurveChord {
  to: object
  center: Point
}

// Proof belongs to the pair, so reversing or reseaming a contour keeps its
// original chords. A new connector between two sampled vertices has no proof.
const outgoing = new WeakMap<object, CurveChord[]>()

export function markCurveChord(from: object, to: object, center: Point): void {
  const chords = outgoing.get(from)
  if (chords) {
    if (!chords.some(chord => chord.to === to)) chords.push({ to, center })
  } else {
    outgoing.set(from, [{ to, center }])
  }
}

function chordCenter(from: object, to: object): Point | undefined {
  return outgoing.get(from)?.find(chord => chord.to === to)?.center
    ?? outgoing.get(to)?.find(chord => chord.to === from)?.center
}

export function splitCurveChord(from: Point, to: Point, split: Point): void {
  const center = chordCenter(from, to)
  if (!center) return
  markCurveChord(from, split, center)
  markCurveChord(split, to, center)
}

/**
 * Give a copied chord the evidence of the source chord it replaces, where
 * each end stands for a run of duplicate source points. The latest pair wins.
 */
export function mergeCurveChord(
  fromRun: readonly object[],
  toRun: readonly object[],
  copyFrom: object,
  copyTo: object,
): void {
  for (let i = fromRun.length - 1; i >= 0; i--) {
    for (const to of toRun) {
      const center = chordCenter(fromRun[i], to)
      if (center) {
        markCurveChord(copyFrom, copyTo, center)
        return
      }
    }
  }
}

/** Carry evidence between copies made in contour order, with optional closure. */
export function copyCurveChords(
  source: readonly object[],
  copy: readonly object[],
  centerInCopy: (center: Point) => Point = center => center,
): void {
  const centers = new Map<Point, Point>()
  for (let i = 0; i < copy.length; i++) {
    const j = (i + 1) % copy.length
    const sourceEnd = j === 0 && source.length === copy.length + 1 ? source.length - 1 : j % source.length
    const center = chordCenter(source[i % source.length], source[sourceEnd])
    if (center === undefined) continue
    let converted = centers.get(center)
    if (converted === undefined) {
      converted = centerInCopy(center)
      centers.set(center, converted)
    }
    markCurveChord(copy[i], copy[j], converted)
  }
}

export function curveChordError(from: Point, to: Point): number | undefined {
  const center = chordCenter(from, to)
  if (!center) return undefined
  const ax = from.x - center.x, ay = from.y - center.y
  const bx = to.x - center.x, by = to.y - center.y
  const dx = bx - ax, dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  if (!(lengthSquared > 0)) return undefined
  const nearest = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared))
  const endpointRadius = Math.min(Math.hypot(ax, ay), Math.hypot(bx, by))
  const error = endpointRadius - Math.hypot(ax + nearest * dx, ay + nearest * dy)
  return error > 0 ? error : undefined
}

export function sampledCutMove(from: Point, to: Point, z: number): ToolpathMove {
  const move: ToolpathMove = {
    kind: 'cut',
    from: { x: from.x, y: from.y, z },
    to: { x: to.x, y: to.y, z },
  }
  const chordError = curveChordError(from, to)
  if (chordError !== undefined) move.arcChordError = chordError
  return move
}

interface IntChord {
  from: IntPoint
  to: IntPoint
  center: Point
  /** Supporting line of a shifted source chord, before intersection rounding. */
  offsetLine?: { point: IntPoint; normal: IntPoint }
}

function clipperChords(paths: readonly ClipperPath[]): IntChord[] {
  const chords: IntChord[] = []
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const from = path[i]
      const to = path[(i + 1) % path.length]
      const center = chordCenter(from, to)
      if (center) chords.push({ from, to, center })
    }
  }
  return chords
}

// Clipper creates new point objects. Reattach only an observed source chord
// (in either direction), never extrapolate across two sampled chords.
function matchClipperChords(paths: ClipperPath[], chords: IntChord[], gridTolerance = 0): void {
  if (chords.length === 0) return
  const width = Math.max(gridTolerance, 1)
  // A colliding cell only adds candidates, which the endpoint check rejects.
  const buckets = new Map<number, IntChord[]>()
  const key = (x: number, y: number): number => Math.imul(x, 73856093) ^ Math.imul(y, 19349663)
  for (const chord of chords) {
    for (const directed of [chord, { ...chord, from: chord.to, to: chord.from }]) {
      const cell = key(Math.floor(directed.from.X / width), Math.floor(directed.from.Y / width))
      const bucket = buckets.get(cell)
      if (bucket) bucket.push(directed)
      else buckets.set(cell, [directed])
    }
  }
  const range = gridTolerance > 0 ? 1 : 0
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const from = path[i]
      const to = path[(i + 1) % path.length]
      const ix = Math.floor(from.X / width), iy = Math.floor(from.Y / width)
      let best: IntChord | undefined
      let bestError = Infinity
      for (let x = ix - range; x <= ix + range; x++) {
        for (let y = iy - range; y <= iy + range; y++) {
          const bucket = buckets.get(key(x, y))
          if (!bucket) continue
          for (const candidate of bucket) {
            const error = Math.max(
              Math.abs(candidate.from.X - from.X), Math.abs(candidate.from.Y - from.Y),
              Math.abs(candidate.to.X - to.X), Math.abs(candidate.to.Y - to.Y),
            )
            if (error > gridTolerance || error > bestError) continue
            const line = candidate.offsetLine
            if (line) {
              // The intersection can move along a shallow chord, but both
              // endpoints must still lie on the same shifted source edge.
              const gap = (point: IntPoint): number => Math.abs(
                (point.X - line.point.X) * line.normal.X + (point.Y - line.point.Y) * line.normal.Y,
              )
              const span = Math.hypot(candidate.to.X - candidate.from.X, candidate.to.Y - candidate.from.Y)
              if (gap(from) > 2 || gap(to) > 2 || error > span / 32) continue
            }
            if (error < bestError) {
              best = candidate
              bestError = error
            } else if (best && (best.center.x !== candidate.center.x || best.center.y !== candidate.center.y)) {
              best = undefined
            }
          }
        }
      }
      if (best) markCurveChord(from, to, best.center)
    }
  }
}

interface ClosedNode {
  Contour(): ClipperPath
  Childs?(): ClosedNode[]
  m_Childs?: ClosedNode[]
}

function treePaths(node: ClosedNode, paths: ClipperPath[]): void {
  paths.push(node.Contour())
  for (const child of node.Childs?.() ?? node.m_Childs ?? []) treePaths(child, paths)
}

/** The shared closed-path Clipper adapter keeps evidence through boolean folds. */
export function createCurveClipper(): InstanceType<typeof ClipperLib.Clipper> {
  const clipper = new ClipperLib.Clipper()
  const chords: IntChord[] = []
  const add = clipper.AddPaths.bind(clipper)
  const execute = clipper.Execute.bind(clipper)
  clipper.AddPaths = (paths, type, closed) => {
    if (closed) {
      for (const chord of clipperChords(paths)) chords.push(chord)
    }
    add(paths, type, closed)
  }
  clipper.Execute = (operation, solution, subjectFill, clipFill) => {
    const result = execute(operation, solution, subjectFill, clipFill)
    if (result && chords.length > 0) {
      if (Array.isArray(solution)) {
        matchClipperChords(solution as ClipperPath[], chords)
      } else {
        const paths: ClipperPath[] = []
        treePaths(solution as ClosedNode, paths)
        matchClipperChords(paths, chords)
      }
    }
    return result
  }
  return clipper
}

// The bundled ClipperOffset emits raw offset points before a boolean cleanup.
// Observe those primitives on this instance so we can record actual round
// joins, plus exact analytic shifts of chords that already have curve proof.
interface OffsetSampling {
  m_srcPoly: ClipperPath
  m_destPoly: ClipperPath
  m_normals: IntPoint[]
  m_delta: number
  OffsetPoint(j: number, k: number, joinType: number): number
  DoRound(j: number, k: number): void
}

function roundInt(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

function shifted(point: IntPoint, normal: IntPoint, delta: number): IntPoint {
  return { X: roundInt(point.X + delta * normal.X), Y: roundInt(point.Y + delta * normal.Y) }
}

function mitered(point: IntPoint, incoming: IntPoint, outgoing: IntPoint, delta: number): IntPoint | undefined {
  const denom = 1 + incoming.X * outgoing.X + incoming.Y * outgoing.Y
  if (denom < 0.5) return undefined
  return shifted(point, { X: incoming.X + outgoing.X, Y: incoming.Y + outgoing.Y }, delta / denom)
}

function offsetCurveChords(source: ClipperPath, normals: IntPoint[], delta: number, chords: IntChord[]): void {
  for (let i = 0; i < source.length; i++) {
    const j = (i + 1) % source.length
    const from = source[i], to = source[j]
    const center = chordCenter(from, to)
    if (!center) continue
    const normal = normals[i]
    const radial = (from.X - center.x) * normal.X + (from.Y - center.y) * normal.Y
    if (radial * (radial + delta) <= 0) continue // the offset crosses the curve centre
    const offsetFrom = shifted(from, normal, delta)
    const offsetLine = { point: offsetFrom, normal }
    chords.push({ from: offsetFrom, to: shifted(to, normal, delta), center, offsetLine })
    const miterFrom = mitered(from, normals[(i + source.length - 1) % source.length], normal, delta)
    const miterTo = mitered(to, normal, normals[j], delta)
    if (miterFrom && miterTo) chords.push({ from: miterFrom, to: miterTo, center, offsetLine })
  }
}

export function offsetPathsWithCurves(
  paths: ClipperPath[],
  delta: number,
  joinType: number,
  arcTolerance?: number,
): ClipperPath[] {
  if (paths.length === 0) return []
  const offset = new ClipperLib.ClipperOffset()
  if (arcTolerance !== undefined) offset.ArcTolerance = arcTolerance
  const roundChords: IntChord[] = []
  const shiftedChords: IntChord[] = []
  const sampler = offset as unknown as Partial<OffsetSampling>
  const { OffsetPoint: offsetPoint, DoRound: doRound } = sampler
  if (typeof offsetPoint === 'function') {
    let previousPath: ClipperPath | undefined
    sampler.OffsetPoint = function (this: OffsetSampling, j, k, type) {
      if (this.m_srcPoly !== previousPath) {
        previousPath = this.m_srcPoly
        offsetCurveChords(this.m_srcPoly, this.m_normals, this.m_delta, shiftedChords)
      }
      return offsetPoint.call(this, j, k, type)
    }
  }
  if (joinType === ClipperLib.JoinType.jtRound && typeof doRound === 'function') {
    sampler.DoRound = function (this: OffsetSampling, j, k) {
      const start = this.m_destPoly.length
      const vertex = this.m_srcPoly[j]
      doRound.call(this, j, k)
      const center = { x: vertex.X, y: vertex.Y }
      for (let i = start + 1; i < this.m_destPoly.length; i++) {
        roundChords.push({ from: this.m_destPoly[i - 1], to: this.m_destPoly[i], center })
      }
    }
  }
  offset.AddPaths(paths, joinType, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  // A zero offset still runs Clipper's cleanup, but emits no shifted spans.
  if (delta === 0) matchClipperChords(solution, clipperChords(paths))
  matchClipperChords(solution, roundChords)
  // Intersecting rounded lines at a shallow angle amplifies grid error
  // along the chord. At 5°, two grid units can move a vertex by about 23.
  // The matcher also requires both output points on the shifted source line.
  matchClipperChords(solution, shiftedChords, 32)
  return solution
}
