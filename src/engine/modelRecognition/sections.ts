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
 * Mesh sections as nested loops, and the plan-view area arithmetic the
 * detector is built on (issue #1206).
 *
 * A section is the material the mesh has at one height. Its contours nest:
 * an outer contour is material, a contour inside it is a void (a **hole
 * loop**), a contour inside that is material again (an island). Recognition
 * only ever asks area questions about these — how much of this outline is
 * material at that height, do these two loops cover the same region — so all
 * of it goes through Clipper with the even-odd rule, which gives the right
 * region whatever way the slicer happened to wind a contour.
 */

import ClipperLib from 'clipper-lib'
import type { Point } from '../../types/project'
import { DEFAULT_CLIPPER_SCALE } from '../clipperScale'
import type { ClipperPath } from '../toolpaths/types'
import { simplifyClosedRing } from '../toolpaths/arcReconstruction'
import { sliceMeshAtZDetailed, type MeshSliceIndex } from '../toolpaths/meshSlicing'

const SCALE = DEFAULT_CLIPPER_SCALE
const AREA_SCALE = SCALE * SCALE
const EVEN_ODD = ClipperLib.PolyFillType.pftEvenOdd

export interface SectionLoop {
  path: ClipperPath
  /** True for a void inside material, false for material. */
  hole: boolean
  /** Index of the enclosing loop in `Section.loops`, or -1 at the top. */
  parent: number
  children: number[]
  /** Unsigned area of the loop's own contour, ignoring what is inside it. */
  area: number
  perimeter: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface Section {
  z: number
  loops: SectionLoop[]
  /** Every contour of the section; with the even-odd rule this is the material. */
  material: ClipperPath[]
  /** Unclosed chains in the slice. Non-zero means the mesh is open at this height. */
  openChainCount: number
}

interface PolyNode {
  IsHole(): boolean
  Contour(): ClipperPath
  Childs?: () => PolyNode[]
  m_Childs?: PolyNode[]
}

function nodeChildren(node: PolyNode): PolyNode[] {
  return node.Childs ? node.Childs() : (node.m_Childs ?? [])
}

export function toPath(points: readonly Point[]): ClipperPath {
  return points.map((point) => ({ X: Math.round(point.x * SCALE), Y: Math.round(point.y * SCALE) }))
}

export function fromPath(path: ClipperPath): Point[] {
  return path.map((point) => ({ x: point.X / SCALE, y: point.Y / SCALE }))
}

export function pathArea(path: ClipperPath): number {
  return Math.abs(ClipperLib.Clipper.Area(path)) / AREA_SCALE
}

function pathPerimeter(path: ClipperPath): number {
  let total = 0
  for (let i = 0; i < path.length; i += 1) {
    const a = path[i]
    const b = path[(i + 1) % path.length]
    total += Math.hypot(b.X - a.X, b.Y - a.Y)
  }
  return total / SCALE
}

function describeLoop(path: ClipperPath, hole: boolean, parent: number): SectionLoop {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of path) {
    if (point.X < minX) minX = point.X
    if (point.X > maxX) maxX = point.X
    if (point.Y < minY) minY = point.Y
    if (point.Y > maxY) maxY = point.Y
  }
  return {
    path,
    hole,
    parent,
    children: [],
    area: pathArea(path),
    perimeter: pathPerimeter(path),
    minX: minX / SCALE,
    maxX: maxX / SCALE,
    minY: minY / SCALE,
    maxY: maxY / SCALE,
  }
}

/**
 * One section through the mesh. `simplifyTolerance` drops the points a slicer
 * leaves along a straight facet edge, so a faceted circle comes back as its
 * corners and two sections of the same wall compare equal.
 */
export function sectionAt(index: MeshSliceIndex, z: number, simplifyTolerance: number): Section {
  const slice = sliceMeshAtZDetailed(index, z)
  const contours = slice.polygons
    .filter((polygon) => polygon.length >= 3)
    .map((polygon) => toPath(simplifyClosedRing(polygon.map(([x, y]) => ({ x, y })), simplifyTolerance).points))
    .filter((path) => path.length >= 3)

  const loops: SectionLoop[] = []
  if (contours.length > 0) {
    const clipper = new ClipperLib.Clipper()
    clipper.AddPaths(contours, ClipperLib.PolyType.ptSubject, true)
    const tree = new ClipperLib.PolyTree()
    clipper.Execute(ClipperLib.ClipType.ctUnion, tree, EVEN_ODD, EVEN_ODD)

    const visit = (node: PolyNode, parent: number): void => {
      for (const child of nodeChildren(node)) {
        const path = child.Contour()
        if (path.length < 3) continue
        const loopIndex = loops.length
        loops.push(describeLoop(path, child.IsHole(), parent))
        if (parent >= 0) loops[parent].children.push(loopIndex)
        visit(child, loopIndex)
      }
    }
    visit(tree as unknown as PolyNode, -1)
  }

  return {
    z,
    loops,
    material: loops.map((loop) => loop.path),
    openChainCount: slice.openChainCount,
  }
}

function execute(clipType: number, subject: ClipperPath[], clip: ClipperPath[]): ClipperPath[] {
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true)
  if (clip.length > 0) clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(clipType, solution, EVEN_ODD, EVEN_ODD)
  return solution as ClipperPath[]
}

/** Net area of a boolean result: Clipper winds its holes the other way. */
function netArea(paths: ClipperPath[]): number {
  let total = 0
  for (const path of paths) total += ClipperLib.Clipper.Area(path)
  return Math.abs(total) / AREA_SCALE
}

export function intersectionArea(a: ClipperPath[], b: ClipperPath[]): number {
  if (a.length === 0 || b.length === 0) return 0
  return netArea(execute(ClipperLib.ClipType.ctIntersection, a, b))
}

export function differenceArea(a: ClipperPath[], b: ClipperPath[]): number {
  if (a.length === 0) return 0
  if (b.length === 0) return netArea(execute(ClipperLib.ClipType.ctUnion, a, []))
  return netArea(execute(ClipperLib.ClipType.ctDifference, a, b))
}

/** Union of triangles (or any simple polygons) as one region. */
export function unionRegion(polygons: readonly Point[][]): ClipperPath[] {
  if (polygons.length === 0) return []
  const clipper = new ClipperLib.Clipper()
  // Each polygon is wound the same way so the non-zero rule unions them; the
  // even-odd rule would cancel wherever two of them overlap.
  const paths = polygons.map((polygon) => {
    const path = toPath(polygon)
    return ClipperLib.Clipper.Area(path) < 0 ? path.reverse() : path
  })
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution as ClipperPath[]
}

/**
 * Do two loops enclose the same region? They do when the area between them is
 * no more than a strip `tolerance` wide along the outline — the same test at
 * every size, so a long slot and a small hole are held to the same wall error.
 */
export function loopsMatch(a: SectionLoop, b: SectionLoop, tolerance: number): boolean {
  if (a.hole !== b.hole) return false
  const slack = tolerance * 2
  if (
    Math.abs(a.minX - b.minX) > slack || Math.abs(a.maxX - b.maxX) > slack
    || Math.abs(a.minY - b.minY) > slack || Math.abs(a.maxY - b.maxY) > slack
  ) return false
  const allowed = Math.max(a.perimeter, b.perimeter) * tolerance
  if (Math.abs(a.area - b.area) > allowed) return false
  return netArea(execute(ClipperLib.ClipType.ctXor, [a.path], [b.path])) <= allowed
}

export function intersectionPaths(a: ClipperPath[], b: ClipperPath[]): ClipperPath[] {
  if (a.length === 0 || b.length === 0) return []
  return execute(ClipperLib.ClipType.ctIntersection, a, b)
}
