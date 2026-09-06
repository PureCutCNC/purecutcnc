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

/** Minimal fixtures for the service suites. No geometry: these tests are about scheduling. */

import { newProject, type Operation, type Project } from '../../types/project'
import type { ToolpathResult } from '../../engine/toolpaths'

export type { GenerationOutcome } from './types'
export type { ToolpathResult }

export function makeOperation(id: string): Operation {
  return {
    id,
    name: id,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: [id] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
}

/**
 * Operations are swapped onto a single shared base project, so every field the
 * cache compares by identity — stock, tools, tabs, clamps — stays identical
 * across contexts unless a test changes it deliberately.
 */
const BASE: Project = newProject('service-test', 'mm')

export function projectWith(operations: Operation[]): Project {
  return { ...BASE, operations }
}

export function makeResult(operationId: string, moveCount: number): ToolpathResult {
  return {
    operationId,
    moves: Array.from({ length: moveCount }, () => ({
      kind: 'cut' as const,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 1, y: 0, z: 0 },
    })),
    warnings: [],
    bounds: null,
  }
}
