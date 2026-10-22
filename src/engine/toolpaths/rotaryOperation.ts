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
import { splitFeatureTargets, type SplitFeatureTargets } from './regions'
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
  const params: RotaryFinishParams = {
    stepover,
    stockToLeave: operation.stockToLeaveRadial,
    sampleSpacing: operation.kind === 'rotary_finish' ? tool.radius / 4 : tool.radius / 2,
    requestedCellSize: Math.min(tool.radius / 3, stepover * 0.5),
    alongStart: range.start, alongEnd: range.end, safeRadius,
    // Missing reads as 'along' inside the generators, so a saved operation keeps
    // the motion it was saved with (#1045 slice A).
    passDirection: operation.rotaryPassDirection,
  }
  return { stock, surface, tool, params, modelIds: models.map((feature) => feature.id) }
}

/** The operation fields the preceding-rough advisory reads. */
export type RotaryOrderOperation = Pick<Operation, 'id' | 'setupId' | 'kind' | 'enabled' | 'target'>

/** One enabled rotary rough that precedes a finish, and the STL models it targets. */
export interface RotaryRoughDependency {
  readonly setupId: string | null
  readonly modelIds: readonly string[]
}

/**
 * The preceding-rough advisory's inputs, for the toolpath cache (#1045 slice V).
 *
 * Every enabled `rotary_rough` earlier in `operations` than `operation`, when
 * it shares the finish's setup, with the STL model ids it targets. Order is
 * operation order. The finish's own models are not here: they are its target,
 * which the cache compares on the operation row itself.
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
    dependencies.push({ setupId: setup, modelIds: rotaryTargetModelIds(project, candidate).sort() })
  }
  return dependencies
}

/**
 * True when any STL model this finish targets has no enabled rotary rough on
 * that same model earlier in the same setup's operation order (2026-10-22
 * decision).
 *
 * The rule is advisory only: it decides a warning, never motion. Order is the
 * project's own `operations` array, which is the order the program is posted
 * in. A rough in another setup, a disabled rough, a rough on another model and
 * a rough after the finish all leave the finish unprotected, so each of them
 * counts as no rough. The rule is per model: a rough on B does not protect A
 * when the finish cuts both. `modelIds` must already be the target's **STL
 * models**, so a region mask id shared with the operation target cannot stand
 * in for a model.
 */
export function rotaryFinishWithoutRough(
  operations: readonly RotaryOrderOperation[],
  operation: RotaryOrderOperation,
  modelIds: readonly string[],
): boolean {
  if (operation.kind !== 'rotary_finish') return false
  const models = new Set(modelIds)
  if (models.size === 0) return false
  const index = operations.findIndex((candidate) => candidate.id === operation.id)
  if (index < 0) return false
  const setup = operation.setupId ?? null
  const covered = new Set<string>()
  for (let i = 0; i < index; i++) {
    const candidate = operations[i]
    if (!candidate.enabled || candidate.kind !== 'rotary_rough') continue
    if ((candidate.setupId ?? null) !== setup) continue
    if (candidate.target.source !== 'features') continue
    for (const featureId of candidate.target.featureIds) {
      if (models.has(featureId)) covered.add(featureId)
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
  const { stock, surface, tool, params, modelIds } = built
  const result = operation.kind === 'rotary_rough'
    ? generateRotaryRough(operation.id, surface.mesh, stock, tool, { ...params, stepdown: operation.stepdown }, {})
    : generateRotaryFinish(operation.id, surface.mesh, stock, tool, params, {})
  const warnings = result.warnings.map((warning) => ({
    ...warning, params: { ...warning.params, operation: operation.name },
  }))
  // Advisory only: the finish still emits exactly the model-following motion
  // above, and this warning changes nothing about it.
  if (operation.kind === 'rotary_finish' && rotaryFinishWithoutRough(project.operations, operation, modelIds)) {
    warnings.push({ code: 'rotaryFinishWithoutRough', params: { operation: operation.name } })
  }
  return { ...result, warnings }
}
