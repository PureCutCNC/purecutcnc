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

import type { BarStock, Operation, Project } from '../../types/project'
import { barMaxRadius, barPivotZ, isBarStock } from '../../types/barStock'
import { operationFace } from '../setupTargets'
import { setupForOperation } from '../setupOrientation'
import { resolveFinishModelSurface } from './finishModelSurface'
import { normalizeToolForProject } from './geometry'
import { splitFeatureTargets, buildRegionMask, type SplitFeatureTargets } from './regions'
import { generateRotaryFinish, generateRotaryRough, rotaryAlongRange } from './rotaryModel'
import type { RotaryFinishParams } from './rotaryModel'
import type { NormalizedTool, ToolpathResult } from './types'
import type { ToolpathWarning, ToolpathWarningCode } from './warningCodes'

/**
 * Adapt the saved operation to the rotary generators; the mesh stays in stock
 * space.
 *
 * A square blank is accepted for `rotary_rough` / `rotary_finish` exactly as a
 * round bar is (#1016 C2-S3): both generators sample the actual blank, and the
 * rough clears its corners while the finish only follows the model. Only these
 * two kinds reach here, so 2D engraving wrapped
 * onto a square blank is *not* enabled by this — the wrapped-flat pipeline has
 * its own guards, and the operation-validity and active-face guards still
 * refuse square stock until the authoring slice lands.
 */

interface RotaryContext {
  readonly stock: BarStock
  readonly surface: NonNullable<ReturnType<typeof resolveFinishModelSurface>>
  readonly tool: NormalizedTool
  readonly params: RotaryFinishParams
  /** STL model feature ids this operation targets, in target order. */
  readonly modelIds: string[]
  /** The same models' names, aligned with `modelIds`, for the advisory text. */
  readonly modelNames: string[]
  /** Closed regions this operation's target carries (#1096), split by mode. */
  readonly regions: RotaryRegionFilter
}

function failure(code: ToolpathWarningCode): { code: ToolpathWarningCode } {
  return { code }
}

/** The STL model features among an operation's resolved targets. */
function targetModels(targets: SplitFeatureTargets): SplitFeatureTargets['machiningFeatures'] {
  return targets.machiningFeatures.filter((feature) => feature.kind === 'stl' && feature.operation === 'model')
}

/**
 * The STL model feature ids an operation targets, in target order.
 *
 * Regions and every other target kind are deliberately absent: only the
 * imported models are surfaces a rotary finish cuts, so an id shared with a
 * region mask must never stand in for a model in the preceding-rough advisory
 * (#1045 slice V).
 */
export function rotaryTargetModelIds(project: Project, operation: Operation): string[] {
  if (operation.target.source !== 'features') return []
  return targetModels(splitFeatureTargets(project, operation.target.featureIds)).map((feature) => feature.id)
}

/** One closed region in a rotary target, with the mask mode it carries. */
export interface RotaryRegionEntry {
  readonly id: string
  readonly mode: 'include' | 'exclude'
}

/**
 * A rotary operation's closed regions, in the order its mask is composed
 * (#1096).
 *
 * The ids -- not the geometry -- are what the preceding-rough advisory and the
 * cache compare: the approved rule is "the same region, or no region on the
 * rough, counts as covered", so a geometrically equivalent but differently
 * authored mask is a different region. The **mode** matters too (#1096 review,
 * P2): an exclude removes the same area for every layer, so a rough targeting
 * `include R + exclude E` does not prepare E for a finish on R. An open region
 * contributes nothing to the mask `buildRegionMask` builds, so it is left out
 * here too.
 *
 * `entries` keeps the project-feature order `buildRegionMask` composes the
 * mask in, which is the order the generator's `containsPoint` reads. The
 * sorted id lists below lose that order, and the order decides: `exclude E`
 * before `include R` cuts area outside R that `include R` alone does not
 * (#1096 re-review, P2).
 */
export interface RotaryRegionFilter {
  /** Closed include (positive) region ids, sorted. */
  readonly includeIds: readonly string[]
  /** Closed exclude (negative) region ids, sorted. */
  readonly excludeIds: readonly string[]
  /** The same closed regions in mask-composition order. */
  readonly entries: readonly RotaryRegionEntry[]
}

/** No region at all: the operation cuts the whole bar. */
const ROTARY_WHOLE_BAR: RotaryRegionFilter = { includeIds: [], excludeIds: [], entries: [] }

function regionFilterOf(regionFeatures: SplitFeatureTargets['regionFeatures']): RotaryRegionFilter {
  const closed = regionFeatures.filter((feature) => feature.sketch.profile.closed)
  const entries: RotaryRegionEntry[] = closed.map((feature) => ({
    id: feature.id,
    mode: feature.regionMaskMode === 'exclude' ? 'exclude' : 'include',
  }))
  return {
    includeIds: entries.filter((entry) => entry.mode === 'include').map((entry) => entry.id).sort(),
    excludeIds: entries.filter((entry) => entry.mode === 'exclude').map((entry) => entry.id).sort(),
    entries,
  }
}

/** The closed regions an operation's target carries, split by mask mode. */
export function rotaryTargetRegions(project: Project, operation: Operation): RotaryRegionFilter {
  if (operation.target.source !== 'features') return ROTARY_WHOLE_BAR
  return regionFilterOf(splitFeatureTargets(project, operation.target.featureIds).regionFeatures)
}

/**
 * The generator parameters for one saved operation, or the warning code that
 * says why it cannot run. No other operation's row, result or enabled flag is
 * read here: a finish emits only its model-following passes (2026-10-22
 * decision), and whether a rough precedes it is an advisory warning decided
 * from the project below, not a licence this generator needs.
 */
function rotaryContext(project: Project, operation: Operation): RotaryContext | { code: ToolpathWarningCode } {
  const stock = project.stock
  if (!isBarStock(stock) || operationFace(project, operation) !== 'around'
    || setupForOperation(project, operation)?.orientation.axis !== stock.axis) return failure('aroundStockMismatch')
  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) return failure('finishNeedsModel')
  const targets = splitFeatureTargets(project, operation.target.featureIds)
  if (targets.missingFeatureIds.length > 0) return failure('targetsNotFound')
  const models = targetModels(targets)
  if (models.length === 0) return failure('finishNotMesh')
  const record = project.tools.find((tool) => tool.id === operation.toolRef)
  if (!record) return failure('noToolAssigned')
  const tool = normalizeToolForProject(record, project)
  if (tool.type !== 'ball_endmill' && tool.type !== 'flat_endmill') return failure('rotaryToolUnsupported')
  if (!(tool.diameter > 0) || !Number.isFinite(tool.diameter)) return failure('toolDiameterPositive')
  if (!(operation.stepover > 0) || !Number.isFinite(operation.stepover)) return failure('operationStepoverRatioRange')
  if (operation.kind === 'rotary_rough' && (!(operation.stepdown > 0) || !Number.isFinite(operation.stepdown))) {
    return failure('stepdownPositive')
  }
  const surface = resolveFinishModelSurface(project, models)
  if (!surface) return failure('surface3dLoadFailed')
  let min = Infinity
  let max = -Infinity
  const axisIndex = stock.axis === 'x' ? 0 : 1
  for (let i = axisIndex; i < surface.mesh.positions.length; i += 3) {
    min = Math.min(min, surface.mesh.positions[i])
    max = Math.max(max, surface.mesh.positions[i])
  }
  const range = rotaryAlongRange(stock, project.clamps, { min, max }, tool, {
    chuckEnd: operation.rotaryChuckSupport ?? 0,
    tailEnd: operation.rotaryTailSupport ?? 0,
  })
  if (!range) return failure('rotaryNoRoom')
  // The rapid height is a tip radius from the turning pivot. A saved height
  // below the blank's *largest* radius cannot clear a square blank's corners,
  // so the fallback is one tool diameter above that envelope — the same rule as
  // the round bar's surface, and the same number on a round bar, where the two
  // radii are equal (#1016 C2-S3).
  const pivot = barPivotZ(stock)
  const maxRadius = barMaxRadius(stock)
  const rapidRadius = project.meta.maxTravelZ - pivot
  const safeRadius = rapidRadius > maxRadius ? rapidRadius : maxRadius + tool.diameter
  const stepover = Math.max((operation.stepover ?? 0.5) * tool.diameter, 1e-3)
  // #1096: the target's closed region features limit where this operation may
  // cut. They are built once, in the Around sheet's own coordinates, so both
  // pass directions and both blank shapes read the same area. The geometry is
  // repeated one circumference each way along the across axis: the sheet is one
  // circumference wide and centred on A0, so the same bar surface is reachable
  // at `a`, `a - 360` and `a + 360`. A target with no valid region builds no
  // mask and generates exactly the pre-region motion.
  const region = buildRegionMask(targets.regionFeatures, {
    axis: stock.axis === 'x' ? 'y' : 'x',
    period: Math.PI * stock.thickness,
  })
  const params: RotaryFinishParams = {
    stepover,
    stockToLeave: operation.stockToLeaveRadial,
    sampleSpacing: operation.kind === 'rotary_finish' ? tool.radius / 4 : tool.radius / 2,
    requestedCellSize: Math.min(tool.radius / 3, stepover * 0.5),
    alongStart: range.start, alongEnd: range.end, safeRadius,
    // Missing reads as 'along' inside the generators, so a saved operation keeps
    // the motion it was saved with (#1045 slice A).
    passDirection: operation.rotaryPassDirection,
    ...(region !== null ? { region } : {}),
  }
  return {
    stock, surface, tool, params,
    modelIds: models.map((feature) => feature.id),
    modelNames: models.map((feature) => feature.name),
    regions: regionFilterOf(targets.regionFeatures),
  }
}

/** The operation fields the preceding-rough advisory reads. */
export type RotaryOrderOperation = Pick<Operation, 'id' | 'setupId' | 'kind' | 'enabled' | 'target'>

/** One enabled rotary rough that precedes a finish, and what it targets. */
export interface RotaryRoughDependency {
  readonly setupId: string | null
  readonly modelIds: readonly string[]
  /** Closed regions the rough's own target carries (#1096), split by mode. */
  readonly regions: RotaryRegionFilter
}

/**
 * The preceding-rough advisory's inputs, for the toolpath cache (#1045 slice V).
 *
 * Every enabled `rotary_rough` earlier in `operations` than `operation`, when
 * it shares the finish's setup, with the STL model ids it targets and the
 * closed region ids its target carries (#1096). Order is operation order. The
 * finish's own models are not here: they are its target, which the cache
 * compares on the operation row itself.
 */
export function rotaryPrecedingRoughs(project: Project, operation: Operation): RotaryRoughDependency[] {
  if (operation.kind !== 'rotary_finish') return []
  const index = project.operations.findIndex((candidate) => candidate.id === operation.id)
  if (index < 0) return []
  const setup = operation.setupId ?? null
  const dependencies: RotaryRoughDependency[] = []
  for (let i = 0; i < index; i++) {
    const candidate = project.operations[i]
    if (!candidate.enabled || candidate.kind !== 'rotary_rough') continue
    if ((candidate.setupId ?? null) !== setup) continue
    // Sorted: the order of a rough's own targets is not something the advisory
    // reads, so reordering them must not invalidate this finish's cache.
    dependencies.push({
      setupId: setup,
      modelIds: rotaryTargetModelIds(project, candidate).sort(),
      regions: rotaryTargetRegions(project, candidate),
    })
  }
  return dependencies
}

/**
 * True when a rough's effective region covers everywhere a finish may cut
 * (#1096).
 *
 * A rough with **no region** cuts the whole bar, so it covers any finish. A
 * finish with no region cuts the whole bar, so only a whole-bar rough covers
 * it. Otherwise the two masks are compared as the predicates the generators
 * read -- `buildRegionMask.containsPoint`, where the last region touching a
 * point wins and the base is "included" when the first region is an exclude --
 * not as sets of ids (#1096 re-review, P2). Comparing include/exclude sets
 * wrongly called two counterexamples covered:
 *
 * - `exclude E` before `include R` on the finish cuts everything outside E,
 *   including area outside R, which a rough on R alone never touches;
 * - a rough with `include R + include S` fully covers a finish on R alone
 *   (the earlier rule demanded equal include sets and warned).
 *
 * The comparison is over region membership, not geometry: two geometrically
 * identical masks authored as different regions are still different regions,
 * the approved simple rule. A membership that cuts in the finish but not the
 * rough can always be reduced to at most two of its regions -- the last region
 * whose geometry contains the point decides each mask -- so checking the empty,
 * single- and paired-region memberships is exact, not an approximation.
 */
function regionMaskCuts(filter: RotaryRegionFilter, present: readonly string[]): boolean {
  const { entries } = filter
  // No region at all: the whole bar is cut.
  if (entries.length === 0) return true
  let included = entries[0].mode === 'exclude'
  for (const entry of entries) {
    if (present.includes(entry.id)) included = entry.mode === 'include'
  }
  return included
}

function roughCoversFinishRegion(
  rough: RotaryRegionFilter,
  finish: RotaryRegionFilter,
): boolean {
  // Every region either mask names, in first-appearance order. Ids outside
  // both masks cannot change either predicate, so they need no membership.
  const ids = [...new Set([...rough.entries, ...finish.entries].map((entry) => entry.id))]
  const uncovered = (present: readonly string[]): boolean =>
    regionMaskCuts(finish, present) && !regionMaskCuts(rough, present)
  if (uncovered([])) return false
  for (let i = 0; i < ids.length; i++) {
    if (uncovered([ids[i]])) return false
    for (let j = i + 1; j < ids.length; j++) {
      if (uncovered([ids[i], ids[j]])) return false
    }
  }
  return true
}

/**
 * The STL models of `modelIds` that no preceding rough covers, in target order
 * and deduplicated (#1112 decision 7.11).
 *
 * This is the same rule `rotaryFinishWithoutRough` states, returning the
 * models themselves so the advisory can name them ("no earlier rough for Turn
 * 2") instead of saying "this model". `modelIds` must already be the target's
 * **STL models**, and `regions` its closed regions, so a region mask id can
 * never stand in for a model and a model id can never stand in for a region.
 */
export function rotaryUncoveredModelIds(
  roughs: readonly RotaryRoughDependency[],
  modelIds: readonly string[],
  regions: RotaryRegionFilter = ROTARY_WHOLE_BAR,
): string[] {
  const models = new Set(modelIds)
  if (models.size === 0) return []
  const covered = new Set<string>()
  for (const rough of roughs) {
    if (!roughCoversFinishRegion(rough.regions, regions)) continue
    for (const modelId of rough.modelIds) {
      if (models.has(modelId)) covered.add(modelId)
    }
  }
  const seen = new Set<string>()
  const uncovered: string[] = []
  for (const modelId of modelIds) {
    if (seen.has(modelId)) continue
    seen.add(modelId)
    if (!covered.has(modelId)) uncovered.push(modelId)
  }
  return uncovered
}

/**
 * True when any STL model this finish targets has no preceding enabled rotary
 * rough in the same setup that both targets that model **and** covers the
 * finish's region (2026-10-22 decision, #1096).
 *
 * The rule is advisory only: it decides a warning, never motion. `roughs` is
 * the ordered dependency the cache already captures -- every enabled
 * `rotary_rough` before the finish in the same setup -- so the advisory and the
 * cache can never disagree about what precedes the finish. The rule is per
 * model: a rough on B does not protect A when the finish cuts both.
 * `modelIds` must already be the target's **STL models**, and `regions` its
 * closed regions, so a region mask id can never stand in for a model and a
 * model id can never stand in for a region.
 */
export function rotaryFinishWithoutRough(
  roughs: readonly RotaryRoughDependency[],
  modelIds: readonly string[],
  regions: RotaryRegionFilter = ROTARY_WHOLE_BAR,
): boolean {
  return rotaryUncoveredModelIds(roughs, modelIds, regions).length > 0
}

export function generateRotaryOperation(project: Project, operation: Operation): ToolpathResult {
  const empty = (code: ToolpathWarningCode): ToolpathResult => ({
    operationId: operation.id, moves: [], bounds: null,
    warnings: [{ code, params: { operation: operation.name } }],
  })
  const built = rotaryContext(project, operation)
  if ('code' in built) return empty(built.code)
  const { stock, surface, tool, params, modelIds, modelNames, regions } = built
  const result = operation.kind === 'rotary_rough'
    ? generateRotaryRough(operation.id, surface.mesh, stock, tool, { ...params, stepdown: operation.stepdown }, {})
    : generateRotaryFinish(operation.id, surface.mesh, stock, tool, params, {})
  const warnings: ToolpathWarning[] = result.warnings.map((warning) => ({
    ...warning, params: { ...warning.params, operation: operation.name },
  }))
  // Advisory only: the finish still emits exactly the model-following motion
  // above, and this warning changes nothing about it. The message names the
  // models left uncovered (#1112 decision 7.11), in target order; the names
  // stay a list so presentation joins them in the active language (#1112 C2).
  if (operation.kind === 'rotary_finish') {
    const uncovered = rotaryUncoveredModelIds(rotaryPrecedingRoughs(project, operation), modelIds, regions)
    if (uncovered.length > 0) {
      const names = uncovered.map((modelId) => modelNames[modelIds.indexOf(modelId)])
      warnings.push({ code: 'rotaryFinishWithoutRough', params: { operation: operation.name, model: names } })
    }
  }
  return { ...result, warnings }
}
