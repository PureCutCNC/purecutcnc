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

import ClipperLib from 'clipper-lib'
import type { ToolpathWarning } from './warningCodes'
import type { Operation, OperationKind, Project, SketchFeature } from '../../types/project'
import { getEffectiveStockProfile, rectProfile } from '../../types/project'
import { expandFeatureGeometry, featureHasClosedGeometry } from '../../text'
import { resolveProject, type ResolvedProject } from '../../store/helpers/resolveFeatures'
import type {
  ClipperPath,
  ResolvedFeatureZSpan,
  ResolvedPocketBand,
  ResolvedPocketRegion,
  ResolvedPocketResult,
} from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  fromClipperPath,
  normalizeWinding,
  resolveFeatureZSpan,
  toClipperPath,
} from './geometry'
import { appendAll } from './appendAll'

interface FeatureWithSpan {
  feature: SketchFeature
  span: ResolvedFeatureZSpan
}

interface AdditiveObstacleWithSpan {
  id: string
  path: ClipperPath
  span: {
    min: number
    max: number
  }
}

interface PolyTreeNode {
  IsHole(): boolean
  Contour(): ClipperPath
  Childs?: () => PolyTreeNode[]
  m_Childs?: PolyTreeNode[]
}

function getChildren(node: PolyTreeNode): PolyTreeNode[] {
  return node.Childs ? node.Childs() : (node.m_Childs ?? [])
}

function flattenFeatureToClipperPath(feature: SketchFeature, scale = DEFAULT_CLIPPER_SCALE): ClipperPath {
  const flattened = flattenProfile(feature.sketch.profile)
  return toClipperPath(normalizeWinding(flattened.points, false), scale)
}

function uniqueSortedDepthsFromSpans(spans: Array<{ min: number; max: number }>): number[] {
  return [...new Set(spans.flatMap((span) => [span.min, span.max]))].sort((a, b) => b - a)
}

function activeForBand(features: FeatureWithSpan[], topZ: number, bottomZ: number): FeatureWithSpan[] {
  return features.filter(({ span }) => span.max >= topZ && span.min <= bottomZ)
}

function activeObstaclesForBand(
  obstacles: AdditiveObstacleWithSpan[],
  topZ: number,
  bottomZ: number,
): AdditiveObstacleWithSpan[] {
  return obstacles.filter(({ span }) => span.max >= topZ && span.min <= bottomZ)
}

function executeClip(
  subjectPaths: ClipperPath[],
  clipPaths: ClipperPath[],
  clipType: number,
): PolyTreeNode {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const polyTree = new ClipperLib.PolyTree()
  clipper.Execute(
    clipType,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return polyTree as PolyTreeNode
}

function executeClipPaths(
  subjectPaths: ClipperPath[],
  clipPaths: ClipperPath[],
  clipType: number,
): ClipperPath[] {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const solution = new ClipperLib.Paths()
  clipper.Execute(
    clipType,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution as ClipperPath[]
}

function unionPaths(paths: ClipperPath[]): ClipperPath[] {
  if (paths.length === 0) {
    return []
  }

  const clipper = new ClipperLib.Clipper()
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
 * Union paths with even-odd fill semantics. When multiple same-winding
 * contours nest, the even-odd rule creates a hole (unlike non-zero, which
 * would fill the inner area). Used for closed Line contours so that nested
 * same-winding Lines produce holes rather than a solid fill (issue #270 S2).
 */
function unionPathsEvenOdd(paths: ClipperPath[]): ClipperPath[] {
  if (paths.length === 0) {
    return []
  }

  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftEvenOdd,
    ClipperLib.PolyFillType.pftEvenOdd,
  )

  return solution as ClipperPath[]
}

function differencePaths(subjectPaths: ClipperPath[], clipPaths: ClipperPath[]): ClipperPath[] {
  if (subjectPaths.length === 0) {
    return []
  }

  if (clipPaths.length === 0) {
    return subjectPaths
  }

  return executeClipPaths(subjectPaths, clipPaths, ClipperLib.ClipType.ctDifference)
}

function pathsIntersect(subjectPaths: ClipperPath[], clipPaths: ClipperPath[]): boolean {
  if (subjectPaths.length === 0 || clipPaths.length === 0) {
    return false
  }

  return executeClipPaths(subjectPaths, clipPaths, ClipperLib.ClipType.ctIntersection).length > 0
}

/**
 * How many separate pieces does this union describe?
 *
 * Outer contours only, so the count does not depend on how Clipper chose to
 * represent a hole.
 *
 * Measured on this clipper-lib: a union that encloses a void comes back as a
 * *single* self-touching contour carrying the net area — both a C-shape closed
 * by a fourth rect and a four-rect ring returned one path of area 1000, not an
 * outer of 1200 plus a hole of 200. So today a raw `paths.length` would give the
 * same answer, and no fixture here can tell the two apart.
 *
 * Filtering anyway, because the two are not equally correct. Were a hole ever
 * returned as its own reversed path, `paths.length` would count it as a second
 * piece and report two shapes that *do* touch as apart — a silent under-fold,
 * the exact bug #751 §2 is about. `Area > 0` is right under either
 * representation, so it does not rest on a library detail that a version bump
 * could change.
 *
 * `Area(path) > 0` rather than `Clipper.Orientation`, which is defined as
 * `Area(path) >= 0` in clipper-lib: identical for real contours, and it drops a
 * degenerate zero-area sliver instead of counting it as a piece.
 */
function connectedComponentCount(paths: ClipperPath[]): number {
  return paths.filter((path) => ClipperLib.Clipper.Area(path) > 0).length
}

/**
 * Does `candidatePaths` touch or overlap `subjectPaths` — a shared boundary
 * counting as contact (#751 §2)?
 *
 * `pathsIntersect` cannot answer this: the intersection of two polygons sharing
 * only an edge has zero area, so a subtract sitting exactly against the pocket
 * wall read as unrelated and was silently dropped from the fold.
 *
 * Connectivity is decided by the union itself — if the two together describe
 * fewer pieces than they do apart, they are joined. That is deliberately the
 * **same** operation the sketch's Join command uses (`mergeSelectedFeatures` →
 * `unionClipperPaths`, both a bare `ctUnion` at `DEFAULT_CLIPPER_SCALE` with no
 * offset or epsilon anywhere). So two shapes this treats as touching are exactly
 * the two shapes Join would merge into one feature, and there is no tolerance
 * constant that can drift from the one the user draws against.
 *
 * The effective floor is therefore the clipper grid, 1/10 000 of a project unit,
 * and a gap of even one unit reads as apart — the same answer Join gives.
 *
 * Contact at a single corner point does **not** count: it shares no boundary
 * length, so folding through it would extend the region across a zero-width
 * join. Clipper leaves such shapes as two pieces under non-zero fill, so this
 * falls out rather than needing a special case.
 */
function pathsTouchOrOverlap(subjectPaths: ClipperPath[], candidatePaths: ClipperPath[]): boolean {
  if (subjectPaths.length === 0 || candidatePaths.length === 0) {
    return false
  }

  const apart = connectedComponentCount(unionPaths(subjectPaths))
    + connectedComponentCount(unionPaths(candidatePaths))
  const together = connectedComponentCount(unionPaths([...subjectPaths, ...candidatePaths]))
  return together < apart
}

function intersectPaths(subjectPaths: ClipperPath[], clipPaths: ClipperPath[]): ClipperPath[] {
  if (subjectPaths.length === 0 || clipPaths.length === 0) {
    return []
  }

  return executeClipPaths(subjectPaths, clipPaths, ClipperLib.ClipType.ctIntersection)
}

/**
 * Subtract features the operation does not target but which carve into the
 * region it does (issue #526).
 *
 * The boolean model folds every add and subtract in feature order, so a
 * subtract that eats part of an island — or opens the region's wall, or
 * reaches below the target's bottom Z — leaves a void the 3D model shows.
 * Before #526 the band loop applied a subtract only when it was a *target*, so
 * the operation machined around those voids and left material that is not
 * there.
 *
 * Discovery mirrors island discovery and is deliberately one hop: a subtract
 * qualifies by overlapping the *target* union, not by overlapping another
 * qualifying subtract. The void is connected, so a transitive closure would be
 * defensible, but one overlap could then walk the whole project and make the
 * area an operation clears unpredictable from the target the user picked.
 *
 * Unlike `relatedSubtractFeatures` (`modelProtection.ts`), a subtract that
 * lives entirely inside an add is NOT excluded here. That rule exists for 3D
 * operations, where such a subtract would drag the whole operation's Z range
 * deeper; here the effect is scoped to one band and one footprint, and a
 * pocket cut into an island is a real void inside the region.
 */
/**
 * Whether an operation kind folds non-target subtracts into the region it
 * resolves (issues #526, #739).
 *
 * #526 introduced the fold so a *clearing* pass would stop machining around
 * material the solid model says is gone. That reasoning does not carry to every
 * kind, because the fold does not merely clip the target — it **widens** the
 * region by the subtract's own outline (see `reachableUnionForDiscovery`). For a
 * kind that clears an area, a wider region means clearing more of what is
 * genuinely void. For a kind that carves *along* boundaries, it means carving
 * boundaries the user never selected.
 *
 * That is what #739 reported: a V-carve targeting text inside a pocket folded
 * in the pocket rectangle — because the pocket overlaps the text — and carved
 * the pocket wall and the island edge. On the shipped `purecutcnc.camj` example
 * that tripled the operation, 4 279 cut moves to 12 879.
 *
 * A `Record<OperationKind, …>` on purpose: a new kind does not compile until it
 * states which side it is on, the same ratchet `pocketPatterns.ts` and
 * `clearingControls.ts` use. Every cell carries its reason, because "false"
 * with no explanation is indistinguishable from an oversight.
 */
const FOLDS_NON_TARGET_SUBTRACTS: Record<OperationKind, boolean> = {
  // Clearing kinds: the fold is the point. A subtract that opens the wall or
  // eats an island leaves void this pass should not machine around.
  pocket: true,
  surface_clean: true,
  rough_surface: true,
  finish_surface: true,
  finish_surface_cleanup: true,
  edge_route_inside: true,
  // Boundary-carving kinds: the carve follows its target's own outline, so a
  // widened region becomes carved geometry the user did not ask for (#739).
  v_carve: false,
  v_carve_medial: false,
  // Kinds that never reach a band resolver. Declared rather than omitted so the
  // table stays a complete statement of the policy.
  edge_route_outside: false,
  follow_line: false,
  drilling: false,
}

/**
 * How many chained non-target subtracts one operation will follow (#751 §3).
 *
 * Not a performance limit. Measured on synthetic chains, resolve time is 0.5 ms
 * with no chain, 11.5 ms at 50 links and 40.7 ms at 100 — every one of those is
 * comfortably inside a frame, and part of the growth is the region genuinely
 * getting bigger rather than discovery working harder.
 *
 * It is a rail against runaway scope. Transitive qualification means an
 * operation's extent is no longer readable from its target: a subtract added on
 * the far side of a part can enlarge a pocket if a chain of touching subtracts
 * happens to connect it. 64 is far past anything real geometry produces, so
 * reaching it says the project is pathological, and `subtractChainLimitReached`
 * says so rather than quietly serving a short region.
 */
const MAX_CHAINED_NON_TARGET_SUBTRACTS = 64

/** Does this operation fold non-target subtracts into its resolved region? */
export function foldsNonTargetSubtracts(operation: Operation): boolean {
  return FOLDS_NON_TARGET_SUBTRACTS[operation.kind]
}

/**
 * Feature ids machined by some *other* enabled operation — the subtracts this
 * operation must leave alone.
 *
 * A subtract another operation machines is not this operation's business
 * (#739). #526's case is a subtract that "changes the model but not the
 * toolpath" — one nothing cuts, so its void is permanent and machining around
 * it leaves material that is not there. A subtract that *is* someone's target
 * is cut by that operation, in program order, and folding it here makes this
 * pass act on a void that does not exist yet: on the shipped example the
 * pocket finish ran contours around the counters of glyphs the V-carves had
 * not carved yet, cutting grooves into solid material.
 *
 * Exported because the toolpath cache has to invalidate on exactly this set
 * (#749). It was inline, and the cache modelled the reads separately and got
 * them wrong — `toolpathDependencies.ts` still asserted there was no live
 * operation-to-operation dependency at all, so adding an operation that
 * claimed a folded subtract left every other operation's path stale. One
 * definition, two callers, no room for the two to drift again.
 *
 * `Pick<Project, 'operations'>` on purpose: the parameter type states that
 * nothing else on the project is read, and it accepts both `Project` (the
 * cache's view) and `ResolvedProject` (the resolver's).
 */
export function subtractsMachinedElsewhere(
  project: Pick<Project, 'operations'>,
  operation: Operation,
): Set<string> {
  return new Set(
    project.operations
      .filter((candidate) => candidate.id !== operation.id && candidate.enabled)
      .flatMap((candidate) => (
        candidate.target.source === 'features' ? candidate.target.featureIds : []
      )),
  )
}

function discoverNonTargetSubtracts(
  project: ResolvedProject,
  operation: Operation,
  targetUnionPaths: ClipperPath[],
  targetIdSet: Set<string>,
  warnings: ToolpathWarning[],
  operationLabel: string,
): FeatureWithSpan[] {
  if (!foldsNonTargetSubtracts(operation)) {
    return []
  }

  const machinedElsewhere = subtractsMachinedElsewhere(project, operation)

  const candidates = project.features
    // Filtered before expansion on purpose: an operation targets a *feature*,
    // while `expandFeatureGeometry` hands back its parts — a text feature
    // becomes one entry per glyph, with derived ids that match no target.
    .filter((feature) => !machinedElsewhere.has(feature.id))
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'subtract' && !targetIdSet.has(feature.id))
    .filter((feature) => featureHasClosedGeometry(feature))
    .map((feature) => ({ feature, path: flattenFeatureToClipperPath(feature) }))

  // Qualification is transitive (#751 §3). A subtract reaching the target only
  // through another subtract is still opening material this operation will
  // machine — the model is folded in feature order, so a subtract of a subtract
  // is void just the same. Testing against the raw target union missed those
  // entirely: measured, a subtract touching only its parent was ignored while
  // the parent folded.
  //
  // Grown to a fixed point rather than one extra level, because the chain has no
  // natural depth limit. Termination is structural, not a guard: `pending` only
  // ever shrinks, a pass that accepts nothing ends the loop, and an accepted
  // subtract is never reconsidered — so this is bounded by the candidate count
  // with no cycle to detect.
  //
  // Contact is the #751 §2 test throughout, so a second-level subtract that
  // merely *touches* its parent qualifies exactly as one touching the target
  // does.
  const accepted: typeof candidates = []
  let pending = candidates
  let reach = targetUnionPaths
  let truncated = false
  for (;;) {
    const joined = pending.filter((candidate) => pathsTouchOrOverlap(reach, [candidate.path]))
    if (joined.length === 0) {
      break
    }
    if (accepted.length + joined.length > MAX_CHAINED_NON_TARGET_SUBTRACTS) {
      truncated = true
      break
    }
    appendAll(accepted, joined)
    const joinedIds = new Set(joined.map(({ feature }) => feature.id))
    pending = pending.filter(({ feature }) => !joinedIds.has(feature.id))
    reach = unionPaths([...reach, ...joined.map(({ path }) => path)])
  }

  if (truncated) {
    warnings.push({
      code: 'subtractChainLimitReached',
      params: { limit: MAX_CHAINED_NON_TARGET_SUBTRACTS, operation: operationLabel },
    })
  }

  return accepted.map(({ feature }) => ({
    feature,
    span: resolveFeatureZSpan(project, feature),
  }))
}

/**
 * The union a band's islands and tabs are discovered against: the target union
 * widened by the qualifying non-target subtracts, which can open the region
 * past its target boundary.
 *
 * Unclipped by the material silhouette on purpose — discovery is conservative
 * across every band, and an add that turns out not to overlap the resolved
 * void differences nothing.
 */
function reachableUnionForDiscovery(
  targetUnionPaths: ClipperPath[],
  nonTargetSubtracts: FeatureWithSpan[],
): ClipperPath[] {
  if (nonTargetSubtracts.length === 0) {
    return targetUnionPaths
  }

  return unionPaths([
    ...targetUnionPaths,
    ...nonTargetSubtracts.map(({ feature }) => flattenFeatureToClipperPath(feature)),
  ])
}

function closedAddFeaturesWithSpans(project: ResolvedProject): FeatureWithSpan[] {
  return project.features
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'add' && featureHasClosedGeometry(feature))
    .map((feature) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))
}

function stockFootprintPaths(project: ResolvedProject): ClipperPath[] {
  const flattened = flattenProfile(getEffectiveStockProfile(project.stock))
  if (flattened.points.length === 0) {
    return []
  }

  return [toClipperPath(normalizeWinding(flattened.points, false), DEFAULT_CLIPPER_SCALE)]
}

/**
 * The material a non-target subtract is allowed to carve in this band.
 *
 * Outside the model there is nothing the model says must be gone — that
 * material belongs to an outside profile operation — so a non-target
 * subtract's contribution is clipped to the adds standing in the band rather
 * than followed out into waste stock.
 *
 * `buildBooleanModel` (`csg.ts`) does not include the stock: only the first
 * `add` seeds the solid, so a project of stock plus subtracts has no model
 * silhouette at all. Clipping to an empty silhouette there would silently drop
 * every non-target subtract, so a band with no active add falls back to the
 * stock footprint.
 */
function bandMaterialSilhouette(
  addFeatures: FeatureWithSpan[],
  stockPaths: ClipperPath[],
  topZ: number,
  bottomZ: number,
): ClipperPath[] {
  const activeAdds = activeForBand(addFeatures, topZ, bottomZ)
  if (activeAdds.length === 0) {
    return stockPaths
  }

  return unionPaths(activeAdds.map(({ feature }) => flattenFeatureToClipperPath(feature)))
}

/**
 * Raised when qualifying non-target subtracts pulled the resolved bands below
 * the deepest target — the one consequence of #526 a user cannot predict from
 * the operation's own target. Eating an island or widening the boundary is the
 * operation simply being correct and stays quiet, or every project with an
 * overlapping subtract would carry a permanent warning.
 */
function appendDepthExtensionWarning(
  warnings: ToolpathWarning[],
  operationLabel: string,
  closedTargetFeatures: FeatureWithSpan[],
  nonTargetSubtracts: FeatureWithSpan[],
  bands: ResolvedPocketBand[],
): void {
  if (closedTargetFeatures.length === 0 || bands.length === 0) {
    return
  }

  const targetBottomZ = Math.min(...closedTargetFeatures.map(({ span }) => span.min))
  const deepestBandBottomZ = Math.min(...bands.map((band) => band.bottomZ))
  if (deepestBandBottomZ >= targetBottomZ) {
    return
  }

  const deepeningNames = nonTargetSubtracts
    .filter(({ span }) => span.min < targetBottomZ)
    .map(({ feature }) => feature.name)
  if (deepeningNames.length === 0) {
    return
  }

  warnings.push({
    code: 'regionExtendedBySubtractDepth',
    params: {
      operation: operationLabel,
      features: deepeningNames.join(', '),
      bottomZ: deepestBandBottomZ,
    },
  })
}

function polyTreeToRegions(
  node: PolyTreeNode,
  targetFeatureIds: string[],
  islandFeatureIds: string[],
  scale = DEFAULT_CLIPPER_SCALE,
): ResolvedPocketRegion[] {
  const regions: ResolvedPocketRegion[] = []
  const contour = node.Contour()

  if (contour.length > 0 && !node.IsHole()) {
    const children = getChildren(node)
    const islands = children
      .filter((child) => child.IsHole())
      .map((child) => fromClipperPath(child.Contour(), scale))

    regions.push({
      outer: fromClipperPath(contour, scale),
      islands,
      targetFeatureIds,
      islandFeatureIds,
    })
  }

  for (const child of getChildren(node)) {
    appendAll(regions, polyTreeToRegions(child, targetFeatureIds, islandFeatureIds, scale))
  }

  return regions
}

function bandHasThickness(topZ: number, bottomZ: number): boolean {
  return Math.abs(topZ - bottomZ) > Number.EPSILON
}

/**
 * Do two resolved band subjects cover the same area?
 *
 * Compared by symmetric difference rather than by the active feature ids
 * (#751 §5). Adjacent bands always differ in some feature's activity — that is
 * why the boundary exists — so an id comparison merges nothing. The case worth
 * merging is precisely the one where the activity differs and the area does
 * not: lift a restricted subtract's bite out of the main subject and the bands
 * either side of its floor become the same shape. Clipper works in scaled
 * integers, and both sides come from the same construction, so identical
 * subjects difference to nothing exactly.
 */
function bandSubjectsEquivalent(left: ClipperPath[], right: ClipperPath[]): boolean {
  return differencePaths(left, right).length === 0
    && differencePaths(right, left).length === 0
}

/**
 * Merge adjacent entries that cover the same area into one taller band.
 *
 * A band boundary exists to mark where the outline changes. Once a restricted
 * subtract no longer contributes to the main subject, the boundary at its floor
 * marks nothing, and leaving it splits the pocket into two passes where one
 * would do — on `complex-pocket-test.camj` that is the difference between
 * cutting 5.5 in² twice and cutting it once.
 */
function mergeEquivalentBands(entries: BandDraft[]): BandDraft[] {
  const merged: BandDraft[] = []
  for (const entry of entries) {
    const previous = merged[merged.length - 1]
    if (
      previous
      && Math.abs(previous.bottomZ - entry.topZ) <= Number.EPSILON
      && bandSubjectsEquivalent(previous.subject, entry.subject)
    ) {
      merged[merged.length - 1] = {
        ...previous,
        bottomZ: entry.bottomZ,
        targetFeatureIds: [...new Set([...previous.targetFeatureIds, ...entry.targetFeatureIds])],
        islandFeatureIds: [...new Set([...previous.islandFeatureIds, ...entry.islandFeatureIds])],
      }
      continue
    }
    merged.push(entry)
  }
  return merged
}

/** A band before its subject is turned into regions, so subjects stay comparable. */
interface BandDraft {
  topZ: number
  bottomZ: number
  subject: ClipperPath[]
  targetFeatureIds: string[]
  islandFeatureIds: string[]
}

export function resolvePocketRegions(authoritativeProject: Project, operation: Operation): ResolvedPocketResult {
  const project = resolveProject(authoritativeProject)
  const warnings: ToolpathWarning[] = []
  const isPocketLike =
    operation.kind === 'pocket' || operation.kind === 'v_carve' || operation.kind === 'v_carve_medial'
  const operationLabel =
    operation.kind === 'pocket'
      ? 'Pocket'
      : operation.kind === 'v_carve_medial'
        ? 'V-carve medial'
        : 'V-carve'

  if (!isPocketLike) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [{ code: 'resolverOnlyPocketVcarve' }],
    }
  }

  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [{ code: 'resolverNoTargets', params: { operation: operationLabel } }],
    }
  }

  const selectedTargetFeatures = operation.target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature) => feature !== null)
  const regionFeatures = selectedTargetFeatures
    .filter((feature) => feature.operation === 'region')

  const isVCarve = operation.kind === 'v_carve' || operation.kind === 'v_carve_medial'
  const validTargetSourceFeatures = selectedTargetFeatures
    .filter((feature) => isVCarve
      ? (feature.operation === 'subtract' || feature.operation === 'line')
      : feature.operation === 'subtract')

  const subtractSourceFeatures = validTargetSourceFeatures.filter((f) => f.operation === 'subtract')
  const lineSourceFeatures = validTargetSourceFeatures.filter((f) => f.operation === 'line')

  const subtractTargetFeatures = subtractSourceFeatures
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'subtract')
    .map((feature) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))

  const lineTargetFeatures = lineSourceFeatures
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'line')
    .map((feature) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))

  const targetFeatures = [...subtractTargetFeatures, ...lineTargetFeatures]

  if (validTargetSourceFeatures.length + regionFeatures.length !== operation.target.featureIds.length) {
    const expectedRoles = isVCarve ? 'subtract/line/region' : 'subtract/region'
    warnings.push({ code: 'targetsMissingOrWrongRole', params: { roles: expectedRoles } })
  }

  const closedSubtractFeatures = subtractTargetFeatures.filter(({ feature }) => featureHasClosedGeometry(feature))
  const closedLineFeatures = lineTargetFeatures.filter(({ feature }) => featureHasClosedGeometry(feature))
  const closedTargetFeatures = [...closedSubtractFeatures, ...closedLineFeatures]

  if (closedTargetFeatures.length !== targetFeatures.length) {
    warnings.push({ code: 'closedProfilesOnly', params: { operation: operationLabel } })
  }

  if (closedTargetFeatures.length === 0) {
    const targetKindLabel = isVCarve ? 'subtract or line' : 'subtract'
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [...warnings, { code: 'resolverNoValidKindTargets', params: { kind: targetKindLabel, operation: operationLabel.toLowerCase() } }],
    }
  }

  // Candidate island/tab discovery must be conservative across all depth
  // bands: union every target path with non-zero fill so an obstacle
  // inside any target contour is discovered regardless of which bands it
  // overlaps.  Even-odd topology for closed Lines belongs inside each
  // band (below) where we know which Lines are simultaneously active.
  const allTargetPathsForDiscovery = [
    ...closedSubtractFeatures.map(({ feature }) => flattenFeatureToClipperPath(feature)),
    ...closedLineFeatures.map(({ feature }) => flattenFeatureToClipperPath(feature)),
  ]
  const targetUnionPaths = unionPaths(allTargetPathsForDiscovery)

  const targetIdSet = new Set(closedSubtractFeatures.map(({ feature }) => feature.id))
  const nonTargetSubtracts = discoverNonTargetSubtracts(project, operation, targetUnionPaths, targetIdSet, warnings, operationLabel)
  const nonTargetSubtractIdSet = new Set(nonTargetSubtracts.map(({ feature }) => feature.id))
  // A folded subtract that bottoms out at or above the target's own floor gets
  // its own band over its own footprint, instead of splitting the whole pocket
  // at its floor (#751 §5). Measured on `complex-pocket-test.camj`: a 0.098 in²
  // circle inside an island was forcing a third full-region pass over 5.6 in²,
  // and holding the rough to 0.05/0.05/0.06 bands against a 0.125 stepdown.
  //
  // One deeper than the target floor is excluded: whether the pocket should
  // follow it down at all is #751 §6, undecided, and restricting it here would
  // answer that question by accident.
  const targetFloorZ = Math.min(...closedTargetFeatures.map(({ span }) => span.min))
  //
  // Either end counts. A subtract whose span stops short of the target's at the
  // top splits the whole region just as surely as one that stops short at the
  // bottom: measured, a bite spanning 14..17 inside a 14..20 target cut the main
  // 2000 region into 20..17 and 17..14 to accommodate a 200 bite.
  //
  // Strictly inside, and by a real amount, at whichever end: one whose span
  // covers the target's needs no band of its own, because the main band already
  // starts and ends where it does. Restricting that would split the region for
  // nothing — caught by #526's own suite, which asserts a bite at pocket depth
  // adds no band.
  const targetTopZ = Math.max(...closedTargetFeatures.map(({ span }) => span.max))
  const restrictedSubtractIdSet = new Set(
    nonTargetSubtracts
      .filter(({ span }) => (
        (span.min > targetFloorZ && bandHasThickness(span.min, targetFloorZ))
        || (span.max < targetTopZ && bandHasThickness(span.max, targetTopZ))
      ))
      .map(({ feature }) => feature.id),
  )
  const reachableUnionPaths = reachableUnionForDiscovery(targetUnionPaths, nonTargetSubtracts)
  const closedAddFeatures = nonTargetSubtracts.length > 0 ? closedAddFeaturesWithSpans(project) : []
  const stockPaths = nonTargetSubtracts.length > 0 ? stockFootprintPaths(project) : []

  const candidateIslands = project.features
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'add' && featureHasClosedGeometry(feature))
    .filter((feature) => pathsIntersect(reachableUnionPaths, [flattenFeatureToClipperPath(feature)]))
    .map((feature) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))
  const candidateTabIslands: AdditiveObstacleWithSpan[] = project.tabs
    .map((tab) => ({
      id: tab.id,
      path: toClipperPath(normalizeWinding(flattenProfile(rectProfile(tab.x, tab.y, tab.w, tab.h)).points, false), DEFAULT_CLIPPER_SCALE),
      span: {
        min: Math.min(tab.z_bottom, tab.z_top),
        max: Math.max(tab.z_bottom, tab.z_top),
      },
    }))
    .filter((tab) => pathsIntersect(reachableUnionPaths, [tab.path]))

  const depths = uniqueSortedDepthsFromSpans([
    ...closedTargetFeatures.map(({ span }) => span),
    ...nonTargetSubtracts.map(({ span }) => span),
    ...candidateIslands.map(({ span }) => span),
    ...candidateTabIslands.map(({ span }) => span),
  ])
  const bands: ResolvedPocketBand[] = []
  const mainDrafts: BandDraft[] = []
  /** Keyed by subtract id: each restricted subtract's bite gets its own band run. */
  const restrictedDrafts = new Map<string, BandDraft[]>()
  const lineIdSet = new Set(closedLineFeatures.map(({ feature }) => feature.id))
  const expandedFeaturesInOrder = project.features.flatMap((feature) => expandFeatureGeometry(feature))

  for (let index = 0; index < depths.length - 1; index += 1) {
    const topZ = depths[index]
    const bottomZ = depths[index + 1]
    if (!bandHasThickness(topZ, bottomZ)) {
      continue
    }

    const activeTargets = activeForBand(closedTargetFeatures, topZ, bottomZ)
    const activeNonTargetSubtracts = activeForBand(nonTargetSubtracts, topZ, bottomZ)
    if (activeTargets.length === 0 && activeNonTargetSubtracts.length === 0) {
      continue
    }
    const activeRestrictedSubtracts = activeNonTargetSubtracts
      .filter(({ feature }) => restrictedSubtractIdSet.has(feature.id))
    const activeFoldedSubtracts = activeNonTargetSubtracts
      .filter(({ feature }) => !restrictedSubtractIdSet.has(feature.id))

    const activeIslands = activeForBand(candidateIslands, topZ, bottomZ)
    const activeTabIslands = activeObstaclesForBand(candidateTabIslands, topZ, bottomZ)
    const activeBandFeatureIds = new Set([
      ...activeTargets.map(({ feature }) => feature.id),
      ...activeNonTargetSubtracts.map(({ feature }) => feature.id),
      ...activeIslands.map(({ feature }) => feature.id),
    ])
    const bandSilhouettePaths = activeNonTargetSubtracts.length > 0
      ? bandMaterialSilhouette(closedAddFeatures, stockPaths, topZ, bottomZ)
      : []
    let resolvedPaths: ClipperPath[] = []

    for (const feature of expandedFeaturesInOrder) {
      if (!activeBandFeatureIds.has(feature.id)) {
        continue
      }

      // Skip line features in the subtract/add loop — they are resolved
      // separately with even-odd semantics below.
      if (feature.operation === 'line' && lineIdSet.has(feature.id)) {
        continue
      }

      const featurePath = flattenFeatureToClipperPath(feature)
      if (feature.operation === 'subtract') {
        if (targetIdSet.has(feature.id)) {
          resolvedPaths = unionPaths([...resolvedPaths, featurePath])
          continue
        }

        // A non-target subtract carves only where there is material to carve,
        // so its contribution is clipped to the band's material silhouette
        // rather than followed out into waste stock (issue #526).
        if (nonTargetSubtractIdSet.has(feature.id) && !restrictedSubtractIdSet.has(feature.id)) {
          const carvedPaths = intersectPaths([featurePath], bandSilhouettePaths)
          if (carvedPaths.length > 0) {
            resolvedPaths = unionPaths([...resolvedPaths, ...carvedPaths])
          }
        }
        continue
      }

      if (feature.operation === 'add' && resolvedPaths.length > 0) {
        resolvedPaths = differencePaths(resolvedPaths, [featurePath])
      }
    }

    // Resolve closed Line targets with even-odd fill semantics (issue #270 S2).
    // Nested same-winding Lines create holes; disjoint Lines remain separate.
    const activeLineTargetsForBand = activeForBand(closedLineFeatures, topZ, bottomZ)
    let lineAreas: ClipperPath[] = []
    if (activeLineTargetsForBand.length > 0) {
      const lineEntries = activeLineTargetsForBand.map(({ feature }) => ({
        feature,
        path: flattenFeatureToClipperPath(feature),
      }))
      lineAreas = unionPathsEvenOdd(lineEntries.map((entry) => entry.path))

      // Subtract add islands from line areas so islands protect material
      // from line targets as they do from subtract targets. But an add that
      // fully encloses a line target is parent material the line carves into
      // — it is not an island there and must not be subtracted from that
      // line's fill (issue #340). A single add can be parent for the lines
      // it encloses and a true island elsewhere, so subtract only the part
      // of the add that lies outside the even-odd fill of the lines it
      // encloses (empty when it encloses none; the whole add when it
      // encloses all, which then removes nothing).
      for (const island of activeIslands) {
        if (lineAreas.length > 0) {
          const islandPath = flattenFeatureToClipperPath(island.feature)
          const enclosedLinePaths = lineEntries
            .filter((entry) => differencePaths([entry.path], [islandPath]).length === 0)
            .map((entry) => entry.path)
          const effectiveIsland = enclosedLinePaths.length > 0
            ? differencePaths([islandPath], unionPathsEvenOdd(enclosedLinePaths))
            : [islandPath]
          if (effectiveIsland.length > 0) {
            lineAreas = differencePaths(lineAreas, effectiveIsland)
          }
        }
      }

      resolvedPaths = unionPaths([...resolvedPaths, ...lineAreas])
    }

    if (resolvedPaths.length > 0 && activeTabIslands.length > 0) {
      resolvedPaths = differencePaths(
        resolvedPaths,
        activeTabIslands.map((tab) => tab.path),
      )
    }

    const bandIslandFeatureIds = [
      ...activeIslands.map(({ feature }) => feature.id),
      ...activeTabIslands.map((tab) => tab.id),
    ]

    // Each restricted subtract's bite: the part of it standing in material the
    // main subject has not already voided (#751 §5). Differenced against the
    // main subject on purpose — the two must not overlap, or the pocket cuts
    // the same area twice at two depths.
    for (const { feature } of activeRestrictedSubtracts) {
      const carved = intersectPaths([flattenFeatureToClipperPath(feature)], bandSilhouettePaths)
      if (carved.length === 0) {
        continue
      }
      let bite = differencePaths(carved, resolvedPaths)
      if (bite.length > 0 && activeTabIslands.length > 0) {
        bite = differencePaths(bite, activeTabIslands.map((tab) => tab.path))
      }
      if (bite.length === 0) {
        continue
      }

      // A bite sharing the main void is not a pocket of its own (#751 §5).
      //
      // Restricting it hands the generator two closed regions that meet along an
      // edge which is not a wall. Each is inset by the tool radius from its own
      // boundary, including that edge, so material is left standing along the
      // seam — visible in the 3D preview as a thin wall between two pockets, and
      // reported from a real file where a shallower adjacent pocket ridged
      // against its neighbour.
      //
      // So it folds into the main subject instead, and the band splits at its
      // floor as it did before #751 §5. That split is not waste: above and below
      // that Z really are different shapes. What stays restricted is the bite
      // enclosed by material — a pocket inside an island, walls all round — which
      // is where the saving was measured and is unaffected by this.
      //
      // Contact is the #751 §2 test, so this asks the same question of the seam
      // that discovery asks of the target. Tabs are already out of `bite`, so
      // folding it back cannot reintroduce them.
      if (pathsTouchOrOverlap(resolvedPaths, bite)) {
        resolvedPaths = unionPaths([...resolvedPaths, ...bite])
        continue
      }

      const drafts = restrictedDrafts.get(feature.id) ?? []
      drafts.push({
        topZ,
        bottomZ,
        subject: bite,
        targetFeatureIds: [feature.id],
        islandFeatureIds: [],
      })
      restrictedDrafts.set(feature.id, drafts)
    }

    if (resolvedPaths.length === 0) {
      warnings.push({ code: 'bandEmptySubject', params: { topZ, bottomZ } })
      continue
    }

    mainDrafts.push({
      topZ,
      bottomZ,
      subject: resolvedPaths,
      targetFeatureIds: [
        ...activeTargets.map(({ feature }) => feature.id),
        ...activeFoldedSubtracts.map(({ feature }) => feature.id),
      ],
      islandFeatureIds: bandIslandFeatureIds,
    })
  }

  // Deepest-topped first, and where two share a top the shallower floor first,
  // so a bite is cut before the main band that reaches past it.
  const orderedDrafts = [
    ...mergeEquivalentBands(mainDrafts),
    ...[...restrictedDrafts.values()].flatMap((drafts) => mergeEquivalentBands(drafts)),
  ].sort((left, right) => (right.topZ - left.topZ) || (right.bottomZ - left.bottomZ))

  for (const draft of orderedDrafts) {
    const polyTree = executeClip(draft.subject, [], ClipperLib.ClipType.ctUnion)
    const regions = polyTreeToRegions(polyTree, draft.targetFeatureIds, draft.islandFeatureIds)
    if (regions.length === 0) {
      warnings.push({ code: 'bandNoRegions', params: { topZ: draft.topZ, bottomZ: draft.bottomZ } })
      continue
    }
    bands.push({
      topZ: draft.topZ,
      bottomZ: draft.bottomZ,
      targetFeatureIds: draft.targetFeatureIds,
      islandFeatureIds: draft.islandFeatureIds,
      regions,
    })
  }

  if (bands.length === 0) {
    warnings.push({ code: 'resolverNoBands', params: { operation: operationLabel } })
  }

  appendDepthExtensionWarning(warnings, operationLabel, closedTargetFeatures, nonTargetSubtracts, bands)

  return {
    operationId: operation.id,
    units: project.meta.units,
    bands,
    warnings,
  }
}

export function resolveInsideEdgeRegions(authoritativeProject: Project, operation: Operation): ResolvedPocketResult {
  const project = resolveProject(authoritativeProject)
  const warnings: ToolpathWarning[] = []
  const operationLabel = 'Inside edge route'

  if (operation.kind !== 'edge_route_inside') {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [{ code: 'resolverOnlyInsideEdge' }],
    }
  }

  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [{ code: 'resolverNoTargets', params: { operation: operationLabel } }],
    }
  }

  const selectedTargetFeatures = operation.target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature) => feature !== null)
  const regionFeatures = selectedTargetFeatures
    .filter((feature) => feature.operation === 'region')
  const validTargetSourceFeatures = selectedTargetFeatures
    .filter((feature) => feature.operation === 'subtract')

  const targetFeatures = validTargetSourceFeatures
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'subtract')
    .map((feature) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))

  if (validTargetSourceFeatures.length + regionFeatures.length !== operation.target.featureIds.length) {
    warnings.push({ code: 'targetsMissingOrWrongRole', params: { roles: 'subtract/region' } })
  }

  const closedTargetFeatures = targetFeatures.filter(({ feature }) => featureHasClosedGeometry(feature))
  if (closedTargetFeatures.length !== targetFeatures.length) {
    warnings.push({ code: 'closedProfilesOnly', params: { operation: operationLabel } })
  }

  if (closedTargetFeatures.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [...warnings, { code: 'resolverNoValidSubtracts', params: { operation: operationLabel.toLowerCase() } }],
    }
  }

  const targetUnionPaths = unionPaths(closedTargetFeatures.map(({ feature }) => flattenFeatureToClipperPath(feature)))

  const targetIdSet = new Set(closedTargetFeatures.map(({ feature }) => feature.id))
  const nonTargetSubtracts = discoverNonTargetSubtracts(project, operation, targetUnionPaths, targetIdSet, warnings, operationLabel)
  const nonTargetSubtractIdSet = new Set(nonTargetSubtracts.map(({ feature }) => feature.id))
  const reachableUnionPaths = reachableUnionForDiscovery(targetUnionPaths, nonTargetSubtracts)
  const closedAddFeatures = nonTargetSubtracts.length > 0 ? closedAddFeaturesWithSpans(project) : []
  const stockPaths = nonTargetSubtracts.length > 0 ? stockFootprintPaths(project) : []

  const candidateIslands = project.features
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'add' && featureHasClosedGeometry(feature))
    .map((feature) => ({
      feature,
      path: flattenFeatureToClipperPath(feature),
    }))
    .filter(({ path }) => pathsIntersect(reachableUnionPaths, [path]))
    .filter(({ path }) => differencePaths([path], reachableUnionPaths).length > 0)
    .map(({ feature }) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))

  const depths = uniqueSortedDepthsFromSpans([
    ...closedTargetFeatures.map(({ span }) => span),
    ...nonTargetSubtracts.map(({ span }) => span),
    ...candidateIslands.map(({ span }) => span),
  ])
  const bands: ResolvedPocketBand[] = []
  const expandedFeaturesInOrder = project.features.flatMap((feature) => expandFeatureGeometry(feature))

  for (let index = 0; index < depths.length - 1; index += 1) {
    const topZ = depths[index]
    const bottomZ = depths[index + 1]
    if (!bandHasThickness(topZ, bottomZ)) {
      continue
    }

    const activeTargets = activeForBand(closedTargetFeatures, topZ, bottomZ)
    const activeNonTargetSubtracts = activeForBand(nonTargetSubtracts, topZ, bottomZ)
    if (activeTargets.length === 0 && activeNonTargetSubtracts.length === 0) {
      continue
    }

    const activeIslands = activeForBand(candidateIslands, topZ, bottomZ)
    const activeBandFeatureIds = new Set([
      ...activeTargets.map(({ feature }) => feature.id),
      ...activeNonTargetSubtracts.map(({ feature }) => feature.id),
      ...activeIslands.map(({ feature }) => feature.id),
    ])
    const bandSilhouettePaths = activeNonTargetSubtracts.length > 0
      ? bandMaterialSilhouette(closedAddFeatures, stockPaths, topZ, bottomZ)
      : []
    let resolvedPaths: ClipperPath[] = []

    for (const feature of expandedFeaturesInOrder) {
      if (!activeBandFeatureIds.has(feature.id)) {
        continue
      }

      const featurePath = flattenFeatureToClipperPath(feature)
      if (feature.operation === 'subtract') {
        if (targetIdSet.has(feature.id)) {
          resolvedPaths = unionPaths([...resolvedPaths, featurePath])
          continue
        }

        // A non-target subtract carves only where there is material to carve,
        // so its contribution is clipped to the band's material silhouette
        // rather than followed out into waste stock (issue #526).
        if (nonTargetSubtractIdSet.has(feature.id)) {
          const carvedPaths = intersectPaths([featurePath], bandSilhouettePaths)
          if (carvedPaths.length > 0) {
            resolvedPaths = unionPaths([...resolvedPaths, ...carvedPaths])
          }
        }
        continue
      }

      if (feature.operation === 'add' && resolvedPaths.length > 0) {
        resolvedPaths = differencePaths(resolvedPaths, [featurePath])
      }
    }

    if (resolvedPaths.length === 0) {
      warnings.push({ code: 'bandEmptySubject', params: { topZ, bottomZ } })
      continue
    }

    const polyTree = executeClip(resolvedPaths, [], ClipperLib.ClipType.ctUnion)

    const bandTargetFeatureIds = [
      ...activeTargets.map(({ feature }) => feature.id),
      ...activeNonTargetSubtracts.map(({ feature }) => feature.id),
    ]
    const regions = polyTreeToRegions(
      polyTree,
      bandTargetFeatureIds,
      activeIslands.map(({ feature }) => feature.id),
    )

    if (regions.length === 0) {
      warnings.push({ code: 'bandNoRegions', params: { topZ, bottomZ } })
      continue
    }

    bands.push({
      topZ,
      bottomZ,
      targetFeatureIds: bandTargetFeatureIds,
      islandFeatureIds: activeIslands.map(({ feature }) => feature.id),
      regions,
    })
  }

  if (bands.length === 0) {
    warnings.push({ code: 'resolverNoBands', params: { operation: operationLabel } })
  }

  appendDepthExtensionWarning(warnings, operationLabel, closedTargetFeatures, nonTargetSubtracts, bands)

  return {
    operationId: operation.id,
    units: project.meta.units,
    bands,
    warnings,
  }
}
