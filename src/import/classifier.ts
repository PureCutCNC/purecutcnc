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
 * Pure import classification and nesting helper.
 *
 * Determines feature roles (line / add / subtract) for imported shapes
 * based on geometry mode, source type, and SVG paint intent. Closed
 * profiles eligible for solid classification are nested via strict
 * geometric containment across the entire selected batch.
 */

import ClipperLib from 'clipper-lib'
import { flattenProfile, toClipperPath } from '../engine/toolpaths/geometry'
import type { ClipperPath } from '../engine/toolpaths/types'
import { getProfileBounds } from '../types/project'
import type { Point, SketchProfile } from '../types/project'
import type {
  ClassificationResult,
  ClassifiedShape,
  ImportGeometryMode,
  ImportedShape,
  ImportSourceType,
} from './types'

// ── helpers ────────────────────────────────────────────────────────────

function assertFinite(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v
}

// ── bounding box ───────────────────────────────────────────────────────

interface BBox {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

function bboxFromProfile(profile: SketchProfile): BBox {
  return getProfileBounds(profile)
}

function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.maxX >= inner.maxX &&
    outer.minY <= inner.minY &&
    outer.maxY >= inner.maxY
  )
}

// ── segment geometry ───────────────────────────────────────────────────

/**
 * Orientation of triplet (p, q, r).
 * 0 → collinear, 1 → clockwise, 2 → counter-clockwise.
 */
function orientation(p: Point, q: Point, r: Point): number {
  const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)
  if (Math.abs(val) < 1e-12) return 0
  return val > 0 ? 1 : 2
}

function onSegment(p: Point, q: Point, r: Point): boolean {
  return (
    q.x <= Math.max(p.x, r.x) + 1e-12 &&
    q.x >= Math.min(p.x, r.x) - 1e-12 &&
    q.y <= Math.max(p.y, r.y) + 1e-12 &&
    q.y >= Math.min(p.y, r.y) - 1e-12
  )
}

/**
 * Returns true when closed segments [a1,a2] and [b1,b2] intersect,
 * touch at an endpoint, or overlap collinearly.
 */
function segmentsIntersectOrTouch(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const o1 = orientation(a1, a2, b1)
  const o2 = orientation(a1, a2, b2)
  const o3 = orientation(b1, b2, a1)
  const o4 = orientation(b1, b2, a2)

  // General case: proper intersection
  if (o1 !== o2 && o3 !== o4) return true

  // Collinear cases (touching endpoints or overlapping)
  if (o1 === 0 && onSegment(a1, b1, a2)) return true
  if (o2 === 0 && onSegment(a1, b2, a2)) return true
  if (o3 === 0 && onSegment(b1, a1, b2)) return true
  if (o4 === 0 && onSegment(b1, a2, b2)) return true

  return false
}

// ── Clipper wrappers ───────────────────────────────────────────────────

const CLIPPER_SCALE = 10_000

/** Access PointInPolygon (available at runtime, not in the .d.ts). */
function clipperPointInPolygon(pt: { X: number; Y: number }, path: ClipperPath): number {
  return (ClipperLib.Clipper as unknown as {
    PointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number
  }).PointInPolygon(pt, path)
}


function clipperArea(path: ClipperPath): number {
  return ClipperLib.Clipper.Area(path)
}

function clipperDifference(subject: ClipperPath, clip: ClipperPath): ClipperPath[] {
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths([subject], ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths([clip], ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution as ClipperPath[]
}

// ── precomputed profile data ───────────────────────────────────────────

interface ProfileData {
  index: number
  flattened: Point[]
  clipperPath: ClipperPath
  bbox: BBox
  /** Absolute polygon area (Clipper-computed, always positive). */
  area: number
  /** True when the profile is self-intersecting or otherwise invalid. */
  selfInvalid: boolean
}

function buildProfileData(shapeIndex: number, profile: SketchProfile): ProfileData {
  const flattened = flattenProfile(profile)
  const clipperPath = toClipperPath(flattened.points, CLIPPER_SCALE)
  const bbox = bboxFromProfile(profile)
  const area = Math.abs(assertFinite(clipperArea(clipperPath)))
  const selfInvalid = !isProfileSelfValid(clipperPath)
  return { index: shapeIndex, flattened: flattened.points, clipperPath, bbox, area, selfInvalid }
}

/**
 * A profile is self-valid when Clipper considers it a simple closed polygon.
 * Self-intersecting or degenerate paths cannot reliably participate in nesting.
 */
function isProfileSelfValid(path: ClipperPath): boolean {
  if (path.length < 3) return false
  // A self-intersecting polygon will produce split results under a
  // zero-offset union.  If the union produces >1 path or differs in
  // vertex structure the input is self-intersecting.
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths([path], ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, 0)
  if (solution.length !== 1) return false
  // The cleaned path should have the same area (within tolerance)
  if (solution[0].length < 3) return false
  const origArea = Math.abs(clipperArea(path))
  const cleanedArea = Math.abs(clipperArea(solution[0]))
  if (origArea < 1) return false
  return Math.abs(origArea - cleanedArea) / origArea < 0.01
}

// ── strict containment ─────────────────────────────────────────────────

/**
 * Returns true when `inner` is **strictly** inside `outer`:
 * - All inner vertices are strictly inside outer (no boundary touches).
 * - No edge of inner touches, crosses, or overlaps any edge of outer.
 * - Clipper confirms inner \ outer is empty.
 */
function isStrictlyInside(
  innerData: ProfileData,
  outerData: ProfileData,
): boolean {
  // 1. Quick reject: bbox
  if (!bboxContains(outerData.bbox, innerData.bbox)) return false

  // 2. All inner vertices must be strictly inside outer (Clipper PointInPolygon)
  for (const pt of innerData.clipperPath) {
    if (clipperPointInPolygon(pt, outerData.clipperPath) !== 1) return false
  }

  // 3. No edge of inner may touch or cross any edge of outer
  if (pathsEdgesIntersect(innerData.flattened, outerData.flattened)) return false

  // 4. Clipper difference: inner \ outer must be empty
  const diff = clipperDifference(innerData.clipperPath, outerData.clipperPath)
  if (diff.length > 0) return false

  return true
}

/**
 * Returns true when any edge of `a` touches, crosses, or overlaps any edge of `b`.
 * Paths are closed — the last vertex connects to the first.
 */
function pathsEdgesIntersect(a: Point[], b: Point[]): boolean {
  const nA = a.length
  const nB = b.length
  if (nA < 3 || nB < 3) return false

  for (let i = 0; i < nA; i++) {
    const a1 = a[i]
    const a2 = a[(i + 1) % nA]
    for (let j = 0; j < nB; j++) {
      const b1 = b[j]
      const b2 = b[(j + 1) % nB]
      if (segmentsIntersectOrTouch(a1, a2, b1, b2)) {
        // Shared vertices at same position are expected for perfectly
        // aligned polygons — but for nesting we treat ANY edge contact
        // as ambiguity, including shared vertices. Two distinct shapes
        // should never share a vertex if one is strictly inside the other.
        return true
      }
    }
  }
  return false
}

// ── duplicate / equal-overlap detection ────────────────────────────────

/**
 * Two profiles are duplicates when their Clipper difference is empty
 * in both directions (each is fully contained in the other).
 */
function areProfilesEqual(a: ProfileData, b: ProfileData): boolean {
  const diffAB = clipperDifference(a.clipperPath, b.clipperPath)
  if (diffAB.length > 0) return false
  const diffBA = clipperDifference(b.clipperPath, a.clipperPath)
  return diffBA.length === 0
}

export interface SolidNestingProfile {
  profile: SketchProfile
  operation: 'add' | 'subtract'
}

/**
 * Infer the default solid role for one newly-created closed profile.
 * The smallest strict existing container wins; touching, intersecting,
 * duplicate, open, or invalid geometry does not establish parentage.
 */
export function inferNestedSolidOperation(
  profile: SketchProfile,
  existingSolids: SolidNestingProfile[],
): 'add' | 'subtract' {
  if (!profile.closed) return 'add'
  const inner = buildProfileData(-1, profile)
  if (inner.selfInvalid) return 'add'

  let parentOperation: 'add' | 'subtract' | null = null
  let parentArea = Infinity
  for (let index = 0; index < existingSolids.length; index += 1) {
    const candidate = existingSolids[index]
    if (!candidate.profile.closed) continue
    const outer = buildProfileData(index, candidate.profile)
    if (outer.selfInvalid || outer.area >= parentArea) continue
    if (!isStrictlyInside(inner, outer)) continue
    parentArea = outer.area
    parentOperation = candidate.operation
  }

  return parentOperation === 'add' ? 'subtract' : 'add'
}

// ── nesting tree ───────────────────────────────────────────────────────

interface NestingNode {
  data: ProfileData
  children: NestingNode[]
}

/**
 * Build a nesting tree from eligible closed profiles using strict
 * smallest-container parentage. Ambiguous relationships (touching,
 * intersecting, duplicate, self-invalid) are left at top level
 * and a de-duplicated warning is emitted per shape that hits ambiguity.
 */
function buildNestingTree(
  profiles: ProfileData[],
  warnings: string[],
  nameBySourceIndex: Map<number, string>,
): NestingNode[] {
  const n = profiles.length
  const nodes: NestingNode[] = profiles.map((d) => ({ data: d, children: [] }))
  const ambiguous = new Set<number>()
  // parentOf[i] = j means profile j contains profile i (the chosen parent)
  const parentOf: Array<number | null> = new Array(n).fill(null)

  // De-duplicate helper
  function warn(msg: string) {
    if (!warnings.includes(msg)) warnings.push(msg)
  }

  // Mark self-invalid profiles as ambiguous
  for (let i = 0; i < n; i++) {
    if (profiles[i].selfInvalid) {
      ambiguous.add(i)
      warn(
        `Ambiguous nesting: "${nameBySourceIndex.get(profiles[i].index)}" has self-intersecting or invalid geometry. ` +
        'Imported as a top-level Add feature.',
      )
    }
  }

  // Detect duplicates — mark both as ambiguous (run before edge check
  // so duplicates get their specific warning rather than a generic one).
  for (let i = 0; i < n; i++) {
    if (ambiguous.has(i)) continue
    for (let j = i + 1; j < n; j++) {
      if (ambiguous.has(j)) continue
      if (areProfilesEqual(profiles[i], profiles[j])) {
        ambiguous.add(i)
        ambiguous.add(j)
        warn(
          `Ambiguous nesting: "${nameBySourceIndex.get(profiles[i].index)}" and "${nameBySourceIndex.get(profiles[j].index)}" ` +
          'have identical geometry. Imported as top-level Add features.',
        )
      }
    }
  }

  // Detect touching / intersecting pairs — mark both as ambiguous.
  // This must run before parent assignment so that shapes whose edges
  // touch or cross cannot be nested. Evaluate every eligible pair
  // regardless of prior ambiguity (e.g. duplicates can also touch, and
  // a touching chain A→B→C needs B/C evaluated even though B is already
  // ambiguous from A/B).
  // Track edge-contact shapes separately so duplicate warnings remain
  // specific and the edge warning stays deduplicated.
  const edgeContact = new Set<number>()
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (pathsEdgesIntersect(profiles[i].flattened, profiles[j].flattened)) {
        ambiguous.add(i)
        ambiguous.add(j)
        edgeContact.add(i)
        edgeContact.add(j)
      }
    }
  }
  // Emit a de-duplicated warning for edge-contact shapes
  const edgeNames: string[] = []
  for (const idx of edgeContact) {
    if (!profiles[idx].selfInvalid) {
      const name = nameBySourceIndex.get(profiles[idx].index)!
      // Only include shapes NOT already warned as duplicates
      const isDup = warnings.some((w) => w.includes(name) && w.includes('identical'))
      if (!isDup) {
        edgeNames.push(`"${name}"`)
      }
    }
  }
  if (edgeNames.length > 0) {
    warn(
      `Ambiguous nesting: contours touch or intersect (${edgeNames.join(', ')}). ` +
      'Imported as top-level Add features.',
    )
  }

  // For each profile, find the smallest strict container.
  // Ambiguous shapes are skipped as children but CAN still be parents
  // (their ambiguity is about their own relationship with another shape,
  // not about their ability to contain children cleanly).
  // Self-invalid shapes are excluded as parents.
  for (let i = 0; i < n; i++) {
    // Ambiguous shapes don't get a parent (they stay top-level Add)
    if (ambiguous.has(i)) continue

    let bestParent: number | null = null
    let bestArea = Infinity

    for (let j = 0; j < n; j++) {
      if (i === j) continue
      // Self-invalid profiles can't be parents; others (including
      // edge-contact-ambiguous) are eligible as containers.
      if (profiles[j].selfInvalid) continue

      if (!isStrictlyInside(profiles[i], profiles[j])) continue

      const outerArea = profiles[j].area
      if (outerArea < bestArea) {
        bestArea = outerArea
        bestParent = j
      }
    }

    if (bestParent !== null) {
      // Double-check: inner must not also contain outer
      if (isStrictlyInside(profiles[bestParent], profiles[i])) {
        ambiguous.add(i)
        ambiguous.add(bestParent)
        warn(
          `Ambiguous nesting: "${nameBySourceIndex.get(profiles[i].index)}" and ` +
          `"${nameBySourceIndex.get(profiles[bestParent].index)}" cross-contain each other. ` +
          'Imported as top-level Add features.',
        )
        continue
      }
      parentOf[i] = bestParent
    }
  }

  // Wire up children based on parentOf.
  // Ambiguous children (edge-contact/duplicate) don't get wired up —
  // they stay as roots. Self-invalid parents are excluded.
  for (let i = 0; i < n; i++) {
    if (ambiguous.has(i)) continue
    const p = parentOf[i]
    if (p !== null && !profiles[p].selfInvalid) {
      nodes[p].children.push(nodes[i])
    }
  }

  // Roots: nodes with no parent AND not ambiguous
  // (ambiguous nodes become roots implicitly since no one claims them)
  return nodes.filter((_, idx) => parentOf[idx] === null)
}

/**
 * Flatten tree: parent before children, siblings in source order.
 * Ambiguous nodes appear at depth 0 (Add).
 */
function flattenTree(
  nodes: NestingNode[],
): Array<{ data: ProfileData; depth: number }> {
  const out: Array<{ data: ProfileData; depth: number }> = []

  function visit(nodeList: NestingNode[], depth: number) {
    // Sort children by source index for stable sibling order
    const sorted = [...nodeList].sort((a, b) => a.data.index - b.data.index)
    for (const node of sorted) {
      out.push({ data: node.data, depth })
      if (node.children.length > 0) {
        visit(node.children, depth + 1)
      }
    }
  }

  visit(nodes, 0)
  return out
}

// ── SVG paint intent ───────────────────────────────────────────────────

/**
 * In SVG Auto mode, a closed profile is a solid candidate only when it
 * has visible fill paint. Stroke-only closed profiles become Line.
 */
function isSvgSolidCandidate(shape: ImportedShape): boolean {
  return shape.hasFill === true
}

// ── public API ─────────────────────────────────────────────────────────

/**
 * Classify a batch of imported shapes into feature roles.
 *
 * Open profiles are always Line in every mode.
 *
 * - **Paths:** every closed profile is Line.
 * - **Solid regions:** all closed profiles are nesting-aware solids.
 * - **Auto (DXF):** same as Solid regions.
 * - **Auto (SVG):** stroke-only closed → Line; filled closed → solid candidate.
 *
 * Nesting uses strict smallest-container parentage across the complete
 * batch (cross-layer). Depth 0 → Add, depth 1 → Subtract, alternating.
 * Ambiguous relationships are left at top-level Add with a warning.
 *
 * Output order: parent before children, siblings in stable source order.
 */
export function classifyImportShapes(
  shapes: ImportedShape[],
  mode: ImportGeometryMode,
  sourceType: ImportSourceType,
): { classified: ClassifiedShape[]; result: ClassificationResult } {
  const warnings: string[] = []
  const classified: ClassifiedShape[] = []

  // Determine solid-eligible indices based on mode
  const solidCandidateIndices: number[] = []
  const closedLineIndices: number[] = []

  const effectiveMode = mode === 'auto' && sourceType === 'dxf' ? 'solid-regions' : mode

  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i]
    if (!shape.profile.closed) {
      // Open profiles always Line
      classified.push({
        name: shape.name,
        sourceType: shape.sourceType,
        layerName: shape.layerName,
        profile: shape.profile,
        operation: 'line',
        sourceIndex: i,
      })
      continue
    }

    // Closed profile
    if (effectiveMode === 'paths') {
      closedLineIndices.push(i)
      continue
    }

    // Solid regions mode (or DXF auto)
    if (effectiveMode === 'solid-regions') {
      solidCandidateIndices.push(i)
      continue
    }

    // SVG auto mode: use paint intent
    if (sourceType === 'svg' && isSvgSolidCandidate(shape)) {
      solidCandidateIndices.push(i)
    } else {
      closedLineIndices.push(i)
    }
  }

  // Closed Line shapes (no nesting)
  for (const idx of closedLineIndices) {
    const shape = shapes[idx]
    classified.push({
      name: shape.name,
      sourceType: shape.sourceType,
      layerName: shape.layerName,
      profile: shape.profile,
      operation: 'line',
      sourceIndex: idx,
    })
  }

  // Nesting for solid candidates
  if (solidCandidateIndices.length > 0) {
    const profiles = solidCandidateIndices.map((idx) =>
      buildProfileData(idx, shapes[idx].profile),
    )
    const nameBySourceIndex = new Map(
      solidCandidateIndices.map((idx) => [idx, shapes[idx].name]),
    )

    const roots = buildNestingTree(profiles, warnings, nameBySourceIndex)
    const flat = flattenTree(roots)

    for (const { data, depth } of flat) {
      const shape = shapes[data.index]
      const operation = depth % 2 === 0 ? 'add' : 'subtract'
      classified.push({
        name: shape.name,
        sourceType: shape.sourceType,
        layerName: shape.layerName,
        profile: shape.profile,
        operation,
        sourceIndex: data.index,
      })
    }
  }

  // Build result summary
  let openLineCount = 0
  let closedLineCount = 0
  let addCount = 0
  let subtractCount = 0

  for (const c of classified) {
    if (c.operation === 'line') {
      if (c.profile.closed) {
        closedLineCount += 1
      } else {
        openLineCount += 1
      }
    } else if (c.operation === 'add') {
      addCount += 1
    } else if (c.operation === 'subtract') {
      subtractCount += 1
    }
  }

  return {
    classified,
    result: {
      totalImportable: classified.length,
      openLineCount,
      closedLineCount,
      addCount,
      subtractCount,
      warnings,
    },
  }
}
