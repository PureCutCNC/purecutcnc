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

import type { Operation, OperationKind, Project, Tool } from './types/project'

/** #957 owns the operation itself; this boundary is ready for its working name. */
export function isToolCompatibleWithOperation(tool: Pick<Tool, 'type'>, kind: OperationKind | 'plasma_profile'): boolean {
  if (kind === 'plasma_profile') return tool.type === 'plasma'
  if (tool.type === 'plasma') return false
  return true
}

/** Resolve only tools belonging to the operation's machining family. */
export function findOperationTool(project: Project, operation: Operation): Tool | null {
  const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
  return tool && isToolCompatibleWithOperation(tool, operation.kind) ? tool : null
}

/** Unconfigured consumables carry zeroes, never an invented cut chart. */
export function plasmaToolDefaults(units: Tool['units']): Omit<Tool, 'id' | 'name'> {
  return {
    units, type: 'plasma', diameter: 0, defaultFeed: 0,
    pierceHeight: 0, cutHeight: 0, pierceDelay: 0,
    vBitAngle: null, flutes: 0, material: 'carbide', defaultRpm: 0,
    defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
  }
}

/** Missing fields migrate independently of the 3.3 format number. */
export function normalizePlasmaTool(tool: Tool): Tool {
  const normalized = {
    ...plasmaToolDefaults(tool.units), ...tool,
    pierceHeight: tool.pierceHeight === undefined ? 0 : tool.pierceHeight,
    cutHeight: tool.cutHeight === undefined ? 0 : tool.cutHeight,
    pierceDelay: tool.pierceDelay === undefined ? 0 : tool.pierceDelay,
  }
  for (const field of ['diameter', 'defaultFeed', 'pierceHeight', 'cutHeight', 'pierceDelay'] as const) {
    const value = normalized[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid plasma tool ${tool.id}: ${field} must be finite and non-negative.`)
    }
  }
  if (normalized.qtplasmacMaterialNumber !== undefined
    && (!Number.isSafeInteger(normalized.qtplasmacMaterialNumber) || normalized.qtplasmacMaterialNumber < 0)) {
    throw new Error(`Invalid plasma tool ${tool.id}: QtPlasmaC material number must be a non-negative integer.`)
  }
  return normalized
}

export function samePlasmaParameters(a: Omit<Tool, 'id'>, b: Omit<Tool, 'id'>): boolean {
  return a.name === b.name && a.units === b.units && a.type === b.type
    && a.diameter === b.diameter && a.defaultFeed === b.defaultFeed
    && a.pierceHeight === b.pierceHeight && a.cutHeight === b.cutHeight
    && a.pierceDelay === b.pierceDelay && a.qtplasmacMaterialNumber === b.qtplasmacMaterialNumber
}
