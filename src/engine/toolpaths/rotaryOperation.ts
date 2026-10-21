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
import { splitFeatureTargets } from './regions'
import { generateRotaryFinish, generateRotaryRough, rotaryAlongRange } from './rotaryModel'
import type { RotaryFinishParams } from './rotaryModel'
import type { NormalizedTool, ToolpathResult } from './types'
import type { ToolpathWarningCode } from './warningCodes'

/**
 * Adapt the saved operation to the rotary generators; the mesh stays in stock
 * space.
 *
 * A square blank is accepted for `rotary_rough` / `rotary_finish` exactly as a
 * round bar is (#1016 C2-S3): both generators sample the actual blank and
 * clear its corners. Only these two kinds reach here, so 2D engraving wrapped
 * onto a square blank is *not* enabled by this — the wrapped-flat pipeline has
 * its own guards, and the operation-validity and active-face guards still
 * refuse square stock until the authoring slice lands.
 */

interface RotaryContext {
  readonly stock: BarStock
  readonly surface: NonNullable<ReturnType<typeof resolveFinishModelSurface>>
  readonly tool: NormalizedTool
  readonly params: RotaryFinishParams
}

function failure(code: ToolpathWarningCode): { code: ToolpathWarningCode } {
  return { code }
}

/**
 * The generator parameters for one saved operation, or the warning code that
 * says why it cannot run. A square around finish needs no licence from an
 * earlier operation since #1045 slice M: it clears its own standing material in
 * stepdown layers before it follows the model, so this adapter hands the
 * generators nothing but the operation's own settings.
 */
function rotaryContext(project: Project, operation: Operation): RotaryContext | { code: ToolpathWarningCode } {
  const stock = project.stock
  if (!isBarStock(stock) || operationFace(project, operation) !== 'around'
    || setupForOperation(project, operation)?.orientation.axis !== stock.axis) return failure('aroundStockMismatch')
  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) return failure('finishNeedsModel')
  const targets = splitFeatureTargets(project, operation.target.featureIds)
  if (targets.missingFeatureIds.length > 0) return failure('targetsNotFound')
  const models = targets.machiningFeatures.filter((feature) => feature.kind === 'stl' && feature.operation === 'model')
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
    stepover, stepdown: operation.stepdown,
    stockToLeave: operation.stockToLeaveRadial,
    sampleSpacing: operation.kind === 'rotary_finish' ? tool.radius / 4 : tool.radius / 2,
    requestedCellSize: Math.min(tool.radius / 3, stepover * 0.5),
    alongStart: range.start, alongEnd: range.end, safeRadius,
    // Missing reads as 'along' inside the generators, so a saved operation keeps
    // the motion it was saved with (#1045 slice A).
    passDirection: operation.rotaryPassDirection,
  }
  return { stock, surface, tool, params }
}

export function generateRotaryOperation(project: Project, operation: Operation): ToolpathResult {
  const empty = (code: ToolpathWarningCode): ToolpathResult => ({
    operationId: operation.id, moves: [], bounds: null,
    warnings: [{ code, params: { operation: operation.name } }],
  })
  const built = rotaryContext(project, operation)
  if ('code' in built) return empty(built.code)
  const { stock, surface, tool, params } = built
  const result = operation.kind === 'rotary_rough'
    ? generateRotaryRough(operation.id, surface.mesh, stock, tool, { ...params, stepdown: params.stepdown ?? 0 }, {})
    : generateRotaryFinish(operation.id, surface.mesh, stock, tool, params, {})
  return {
    ...result,
    warnings: result.warnings.map((warning) => ({
      ...warning, params: { ...warning.params, operation: operation.name },
    })),
  }
}
