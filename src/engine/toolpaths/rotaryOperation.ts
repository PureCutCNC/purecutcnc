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
import type { ToolpathWarningCode } from './warningCodes'

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
  /** Closed region feature ids this operation's target carries (#1096), sorted. */
  readonly regionIds: string[]
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

/**
 * The closed region feature ids an operation's target carries (#1096), sorted.
 *
 * The ids -- not the geometry -- are what the preceding-rough advisory and the
 * cache compare: the approved rule is "the same region, or no region on the
 * rough, counts as covered", so a geometrically equivalent but differently
 * authored mask is a different region. An open region contributes nothing to
 * the mask `buildRegionMask` builds, so it is left out here too.
 */
export function rotaryTargetRegionIds(project: Project, operation: Operation): string[] {
  if (operation.target.source !== 'features') return []
  return splitFeatureTargets(project, operation.target.featureIds).regionFeatures
    .filter((feature) => feature.sketch.profile.closed)
    .map((feature) => feature.id)
    .sort()
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
    regionIds: targets.regionFeatures
      .filter((feature) => feature.sketch.profile.closed)
      .map((feature) => feature.id)
      .sort(),
  }
}

/** The operation fields the preceding-rough advisory reads. */
export type RotaryOrderOperation = Pick<Operation, 'id' | 'setupId' | 'kind' | 'enabled' | 'target'>

/** One enabled rotary rough that precedes a finish, and what it targets. */
export interface RotaryRoughDependency {
  readonly setupId: string | null
  readonly modelIds: readonly string[]
  /** Closed region ids the rough's own target carries (#1096), sorted. */
  readonly regionIds: readonly string[]
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
      regionIds: rotaryTargetRegionIds(project, candidate),
    })
  }
  return dependencies
}

/**
 * True when a rough's own region covers the area a finish cuts (#1096).
 *
 * A rough with **no region** cuts the whole bar, so it covers any finish. A
 * rough with a region covers only a finish whose region ids it also carries:
 * "the same region", compared by feature id, which is the approved simple
 * rule -- two geometrically identical masks authored separately are not the
 * same region. A finish with no region cuts the whole bar and is covered only
 * by a rough that also has no region.
 */
function roughCoversFinishRegion(
  roughRegionIds: readonly string[],
  finishRegionIds: readonly string[],
): boolean {
  if (roughRegionIds.length === 0) return true
  if (finishRegionIds.length === 0) return false
  return finishRegionIds.every((id) => roughRegionIds.includes(id))
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
 * `modelIds` must already be the target's **STL models**, and `regionIds` its
 * closed regions, so a region mask id can never stand in for a model and a
 * model id can never stand in for a region.
 */
export function rotaryFinishWithoutRough(
  roughs: readonly RotaryRoughDependency[],
  modelIds: readonly string[],
  regionIds: readonly string[] = [],
): boolean {
  const models = new Set(modelIds)
  if (models.size === 0) return false
  const covered = new Set<string>()
  for (const rough of roughs) {
    if (!roughCoversFinishRegion(rough.regionIds, regionIds)) continue
    for (const modelId of rough.modelIds) {
      if (models.has(modelId)) covered.add(modelId)
    }
  }
  return [...models].some((modelId) => !covered.has(modelId))
}

export function generateRotaryOperation(project: Project, operation: Operation): ToolpathResult {
  const empty = (code: ToolpathWarningCode): ToolpathResult => ({
    operationId: operation.id, moves: [], bounds: null,
    warnings: [{ code, params: { operation: operation.name } }],
  })
  const built = rotaryContext(project, operation)
  if ('code' in built) return empty(built.code)
  const { stock, surface, tool, params, modelIds, regionIds } = built
  const result = operation.kind === 'rotary_rough'
    ? generateRotaryRough(operation.id, surface.mesh, stock, tool, { ...params, stepdown: operation.stepdown }, {})
    : generateRotaryFinish(operation.id, surface.mesh, stock, tool, params, {})
  const warnings = result.warnings.map((warning) => ({
    ...warning, params: { ...warning.params, operation: operation.name },
  }))
  // Advisory only: the finish still emits exactly the model-following motion
  // above, and this warning changes nothing about it.
  if (operation.kind === 'rotary_finish'
    && rotaryFinishWithoutRough(rotaryPrecedingRoughs(project, operation), modelIds, regionIds)) {
    warnings.push({ code: 'rotaryFinishWithoutRough', params: { operation: operation.name } })
  }
  return { ...result, warnings }
}
