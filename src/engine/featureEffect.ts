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
 * "No effect on the final shape" analysis (issue #1112 slice N, decision 12).
 *
 * A flat feature can be folded, added and then completely erased by features
 * later in the tree. The model is then exactly what it would be without the
 * feature, so its tree row earns a warning — never a reorder, delete, disable
 * or setting. Tree-order folding is unchanged.
 *
 * The claim is deliberately narrow, because a wrong warning is worse than a
 * missing one:
 *
 * - Only a flat feature with closed outlines and a Z span can be the earlier
 *   feature. Models, Lines, Regions and construction geometry never warn.
 *   A canned model (Turn, Polygon) carries a mesh, not outlines, so it never
 *   reaches this module as an add/subtract row.
 * - Every outer outline of the earlier feature must be covered in plan view
 *   (an exact Clipper difference is empty) by the outer outlines of later
 *   features whose Z span contains the earlier feature's whole span. A hole
 *   inside a later feature does not weaken that: the later feature's outer
 *   add/subtract normalises the material in that region before its own hole
 *   and island pieces are applied, so the result there is the same with or
 *   without the earlier feature. Only the outer, matching-operation outlines
 *   are therefore used as cover.
 * - Top and Bottom share one plan/stock space, so they cover each other
 *   exactly as the real fold does. Around compares only with Around, in its
 *   unrolled sheet coordinates. A shape across the seam is not matched to one
 *   on the other side of the seam — the same known limit as the nesting rule
 *   (#1108), and an under-claim in the safe direction.
 * - Hidden features are not folded, so they neither warn nor cover.
 *
 * Performance: a box pre-filter runs before any Clipper work, and the result
 * is cached per feature. A changed feature only dirties itself and the
 * earlier features whose boxes it overlaps, so an ordinary edit rechecks a
 * handful of rows instead of the whole tree. The module is pure and holds no
 * store, React or DOM reference, which is what lets the worker own the cache
 * across edits.
 */

import ClipperLib from 'clipper-lib'
import { DEFAULT_CLIPPER_SCALE } from './clipperScale'
import type { ClipperPath } from './toolpaths/types'
import {
  sampleProfilePoints,
  type Bounds2D,
  type FeatureOperation,
  type Point,
  type SetupFace,
  type SketchProfile,
} from '../types/project'

/** One resolved outline of a feature and the role the folding gives it. */
export interface FeatureEffectShape {
  profile: SketchProfile
  operation: FeatureOperation
}

/**
 * What the analysis needs from a feature row, already resolved to world space.
 * The app builds this from `resolveFeatureGeometryShapes`, so Text and canned
 * flat shapes contribute their real outlines rather than a placement frame.
 */
export interface FeatureEffectFeature {
  id: string
  operation: FeatureOperation
  face: SetupFace
  zTop: number
  zBottom: number
  visible: boolean
  shapes: readonly FeatureEffectShape[]
}

export interface FeatureEffectAnalysisOptions {
  /**
   * Called once for every feature whose verdict this pass recomputed. Lets a
   * caller (and the tests) see that an edit rechecked only the rows the cache
   * marked dirty, without exposing the cache itself.
   */
  onEvaluate?: (featureId: string) => void
}

/** The ids of the features whose contribution later features erase. */
export type FeatureEffectWarnings = ReadonlySet<string>

type Domain = 'flat' | 'around'

interface PreparedShape {
  path: ClipperPath
  bounds: Bounds2D
}

interface CacheEntry {
  id: string
  signature: string
  index: number
  domain: Domain
  operation: FeatureOperation
  visible: boolean
  zMin: number
  zMax: number
  /** Every closed outline, so an overlap test cannot miss a piece. */
  bounds: Bounds2D | null
  /** The earlier feature's own outlines: what has to be covered. */
  outer: PreparedShape[]
  /** The same outer outlines, used as a later coverer (see the header). */
  cover: PreparedShape[]
  result: boolean
}

/** Z spans come from the same model; this only absorbs arithmetic noise. */
const Z_EPSILON = 1e-9

function domainOf(face: SetupFace): Domain {
  return face === 'around' ? 'around' : 'flat'
}

function oppositeOperation(operation: FeatureOperation): FeatureOperation | null {
  if (operation === 'add') return 'subtract'
  if (operation === 'subtract') return 'add'
  return null
}

function isShapeOperation(operation: FeatureOperation): boolean {
  return operation === 'add' || operation === 'subtract'
}

function unionBounds(a: Bounds2D | null, b: Bounds2D | null): Bounds2D | null {
  if (!a) return b
  if (!b) return a
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

function boundsOverlap(a: Bounds2D | null, b: Bounds2D | null): boolean {
  if (!a || !b) return false
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY
}

function boundsOfPath(path: ClipperPath): Bounds2D {
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
    minX: minX / DEFAULT_CLIPPER_SCALE,
    maxX: maxX / DEFAULT_CLIPPER_SCALE,
    minY: minY / DEFAULT_CLIPPER_SCALE,
    maxY: maxY / DEFAULT_CLIPPER_SCALE,
  }
}

/**
 * The same sampling `toolpaths/geometry.flattenProfile` uses. Copied rather
 * than imported for one measured reason: that module reaches `utils/units` →
 * `cannedShapes`, which pulls Three.js into this worker, and a warning pass
 * has no use for it. The values only set curve precision; both the earlier
 * and later outline go through this one function.
 */
const CURVE_SAMPLES = 24
const ARC_STEP_RADIANS = Math.PI / 36

function ensureClosedPath(points: Point[]): Point[] {
  if (points.length === 0) return []
  const first = points[0]
  const last = points[points.length - 1]
  if (first.x === last.x && first.y === last.y) return points
  return [...points, first]
}

function signedArea(points: Point[]): number {
  const closed = ensureClosedPath(points)
  let area = 0
  for (let index = 0; index < closed.length - 1; index += 1) {
    const a = closed[index]
    const b = closed[index + 1]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

function normalizeWinding(points: Point[], wantClockwise: boolean): Point[] {
  const closed = ensureClosedPath(points)
  if ((signedArea(closed) < 0) === wantClockwise) return closed
  const reversed = [...closed].reverse()
  const first = reversed[0]
  const last = reversed[reversed.length - 1]
  if (first.x !== last.x || first.y !== last.y) reversed.push(first)
  return reversed
}

function toClipper(points: Point[]): ClipperPath {
  return ensureClosedPath(points).map((point) => ({
    X: Math.round(point.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE),
  }))
}

/** One closed profile as a normalized Clipper path, or null when degenerate. */
function pathOf(profile: SketchProfile): ClipperPath | null {
  if (!profile.closed) return null
  const points = sampleProfilePoints(profile, CURVE_SAMPLES, ARC_STEP_RADIANS)
  if (points.length < 3) return null
  const path = toClipper(normalizeWinding(points, false))
  return path.length >= 3 ? path : null
}

function prepareShape(profile: SketchProfile): PreparedShape | null {
  const path = pathOf(profile)
  if (!path) return null
  return { path, bounds: boundsOfPath(path) }
}

function executeClip(subject: ClipperPath[], clip: ClipperPath[], clipType: number): ClipperPath[] {
  if (subject.length === 0) return []
  if (clip.length === 0 && clipType === ClipperLib.ClipType.ctDifference) return subject
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true)
  if (clip.length > 0) {
    clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true)
  }
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    clipType,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution
}

/**
 * One feature's outer outlines are both what can be covered and what covers a
 * later row's opposite-type contribution. Its holes and islands do not enter
 * the coverage test: the later feature's own outer piece has already
 * normalised the material in that region before they are applied (see the
 * module header), so they cannot rescue an earlier feature's contribution.
 */
function signatureOf(feature: FeatureEffectFeature, index: number): string {
  // Index is part of the identity: a reorder changes what is "later", so the
  // cache must not reuse a verdict computed against the old order.
  return JSON.stringify({
    index,
    operation: feature.operation,
    face: feature.face,
    zTop: feature.zTop,
    zBottom: feature.zBottom,
    visible: feature.visible,
    shapes: feature.shapes.map((shape) => ({ operation: shape.operation, profile: shape.profile })),
  })
}

function prepareEntry(feature: FeatureEffectFeature, index: number, signature: string): CacheEntry {
  const shapes: Array<{ prepared: PreparedShape; operation: FeatureOperation }> = []
  for (const shape of feature.shapes) {
    const prepared = prepareShape(shape.profile)
    if (prepared) shapes.push({ prepared, operation: shape.operation })
  }
  const outer = shapes
    .filter((shape) => shape.operation === feature.operation)
    .map((shape) => shape.prepared)
  const bounds = shapes.reduce<Bounds2D | null>(
    (accumulated, shape) => unionBounds(accumulated, shape.prepared.bounds),
    null,
  )
  return {
    id: feature.id,
    signature,
    index,
    domain: domainOf(feature.face),
    operation: feature.operation,
    visible: feature.visible,
    zMin: Math.min(feature.zBottom, feature.zTop),
    zMax: Math.max(feature.zBottom, feature.zTop),
    bounds,
    outer,
    cover: isShapeOperation(feature.operation) ? outer : [],
    result: false,
  }
}

/** True when later `cover` shapes remove all of one outer outline. */
function outlineCovered(outline: PreparedShape, cover: readonly PreparedShape[]): boolean {
  const relevant = cover.filter((shape) => boundsOverlap(outline.bounds, shape.bounds))
  if (relevant.length === 0) return false
  let remaining = [outline.path]
  for (const shape of relevant) {
    remaining = executeClip(remaining, [shape.path], ClipperLib.ClipType.ctDifference)
    if (remaining.length === 0) return true
  }
  return false
}

/**
 * The verdict for one feature against everything later in the tree. It never
 * looks earlier than its own row: an earlier feature cannot erase this one.
 */
function evaluate(entries: readonly CacheEntry[], index: number): boolean {
  const entry = entries[index]
  if (!entry.visible || !isShapeOperation(entry.operation)) return false
  if (entry.outer.length === 0 || !entry.bounds) return false
  if (!Number.isFinite(entry.zMin) || !Number.isFinite(entry.zMax)) return false

  const coverOperation = oppositeOperation(entry.operation)
  if (!coverOperation) return false

  const cover: PreparedShape[] = []
  for (let later = index + 1; later < entries.length; later += 1) {
    const candidate = entries[later]
    if (!candidate.visible || candidate.operation !== coverOperation) continue
    if (candidate.domain !== entry.domain) continue
    if (!Number.isFinite(candidate.zMin) || !Number.isFinite(candidate.zMax)) continue
    // "At least as deep": the later feature's span must contain the whole
    // earlier span, or material survives above/below the cut.
    if (candidate.zMin > entry.zMin + Z_EPSILON || candidate.zMax < entry.zMax - Z_EPSILON) continue
    if (!boundsOverlap(entry.bounds, candidate.bounds)) continue
    cover.push(...candidate.cover)
  }
  if (cover.length === 0) return false

  for (const outline of entry.outer) {
    if (!outlineCovered(outline, cover)) return false
  }
  return true
}

/**
 * Caches one verdict per feature and recomputes only what a change can affect.
 *
 * One instance lives in the analysis worker for the life of the document's
 * worker. Creating a new instance discards the cache (a fresh document), which
 * is the only invalidation that is not driven by a feature signature.
 */
export class FeatureEffectAnalyzer {
  private readonly cache = new Map<string, CacheEntry>()

  /**
   * Analyze the features in tree-fold order and return the ids that should
   * carry the "no effect" warning. The returned set is a fresh snapshot, safe
   * to post to the main thread.
   */
  analyze(
    features: readonly FeatureEffectFeature[],
    options: FeatureEffectAnalysisOptions = {},
  ): FeatureEffectWarnings {
    const entries: CacheEntry[] = []
    const changed: Array<{ id: string; before: CacheEntry | null; after: CacheEntry | null }> = []
    const currentIds = new Set<string>()

    for (let index = 0; index < features.length; index += 1) {
      const feature = features[index]
      currentIds.add(feature.id)
      const signature = signatureOf(feature, index)
      const cached = this.cache.get(feature.id)
      if (cached && cached.signature === signature) {
        entries.push(cached)
        continue
      }
      const entry = prepareEntry(feature, index, signature)
      changed.push({ id: feature.id, before: cached ?? null, after: entry })
      entries.push(entry)
    }
    for (const [id, cached] of this.cache) {
      if (!currentIds.has(id)) changed.push({ id, before: cached, after: null })
    }

    // Only a later change can invalidate an earlier verdict. A reorder can put
    // a feature on either side of a row, so both its old and new positions are
    // considered (the extra recheck is safe; missing one is not).
    const dirty = new Set<string>()
    for (const change of changed) dirty.add(change.id)
    if (changed.length > 0) {
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        if (dirty.has(entry.id) || !entry.bounds) continue
        const wanted = oppositeOperation(entry.operation)
        if (!wanted) continue
        for (const change of changed) {
          if (change.id === entry.id) continue
          // A face change can move a feature between the flat and Around
          // domains, so both sides of the edit have to be considered.
          const domains = new Set<Domain>()
          if (change.before) domains.add(change.before.domain)
          if (change.after) domains.add(change.after.domain)
          if (!domains.has(entry.domain)) continue
          const laterIndex = Math.max(
            change.before?.index ?? -1,
            change.after?.index ?? -1,
          )
          if (laterIndex <= index) continue
          const changeBounds = unionBounds(change.before?.bounds ?? null, change.after?.bounds ?? null)
          if (!boundsOverlap(entry.bounds, changeBounds)) continue
          const operations = [change.before?.operation, change.after?.operation]
          if (!operations.some((operation) => operation === wanted)) continue
          dirty.add(entry.id)
          break
        }
      }
    }

    const warnings = new Set<string>()
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      let result: boolean
      if (dirty.has(entry.id)) {
        options.onEvaluate?.(entry.id)
        result = evaluate(entries, index)
        entry.result = result
      } else {
        result = entry.result
      }
      this.cache.set(entry.id, entry)
      if (result) warnings.add(entry.id)
    }
    for (const change of changed) {
      if (!change.after) this.cache.delete(change.id)
    }
    return warnings
  }
}
