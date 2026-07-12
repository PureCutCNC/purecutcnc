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

import type { Page } from '@playwright/test'
import { seedProject } from './helpers'

function resolvedRectProfile(cx: number, cy: number, w: number, h: number) {
  return {
    start: { x: cx, y: cy },
    segments: [
      { type: 'line' as const, to: { x: cx + w, y: cy } },
      { type: 'line' as const, to: { x: cx + w, y: cy + h } },
      { type: 'line' as const, to: { x: cx, y: cy + h } },
      { type: 'line' as const, to: { x: cx, y: cy } },
    ],
    closed: true,
  }
}

function outsideRouteOperation(id: string, name: string) {
  return {
    id,
    name,
    kind: 'edge_route_outside',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f-machinable-add'] },
    toolRef: 'tool-1',
    stepdown: 0.1,
    stepover: 0.125,
    feed: 60,
    plungeFeed: 30,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
  }
}

/**
 * Project with one machinable add feature, one tool, two toolpath-producing
 * outside-route operations ("Route A", "Route B"), and the bundled GRBL
 * machine selected (legacy `machineId` meta — load-time normalization seeds
 * the bundled definitions and keeps the selection).
 */
function buildGcodeExportProjectJson(): string {
  const now = '2026-01-01T00:00:00.000Z'
  const stockW = 180
  const stockH = 120

  return JSON.stringify({
    version: '2.0',
    meta: {
      name: 'Gcode Export E2E Fixture',
      created: now,
      modified: now,
      units: 'inch',
      showFeatureInfo: true,
      showDimensions: true,
      copyMode: 'reference',
      maxTravelZ: 2,
      operationClearanceZ: 0.2,
      clampClearanceXY: 0.5,
      clampClearanceZ: 0.2,
      machineId: 'grbl',
    },
    grid: {
      extent: 200,
      majorSpacing: 1,
      minorSpacing: 0.25,
      snapEnabled: false,
      snapIncrement: 0.25,
      visible: true,
    },
    stock: {
      profile: resolvedRectProfile(0, 0, stockW, stockH),
      thickness: 2,
      material: 'aluminum_6061',
      color: '#b9a83c',
      visible: true,
      origin: { x: 0, y: 0 },
    },
    origin: { name: 'Origin', x: stockW / 2, y: stockH / 2, z: 2, visible: true },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {
      'def-machinable-add': {
        id: 'def-machinable-add',
        kind: 'rect',
        profile: resolvedRectProfile(0, 0, 60, 40),
        dimensions: [],
        text: null,
        stl: null,
        operation: 'add',
      },
    },
    features: [
      {
        id: 'f-machinable-add',
        name: 'Machinable Add',
        kind: 'rect',
        folderId: null,
        sketch: {
          profile: resolvedRectProfile(30, 30, 60, 40),
          origin: { x: 0, y: 0 },
          orientationAngle: 0,
          dimensions: [],
          constraints: [],
        },
        operation: 'add',
        z_top: 2,
        z_bottom: 0,
        visible: true,
        locked: false,
        definitionId: 'def-machinable-add',
        transform: { a: 1, b: 0, c: 0, d: 1, e: 30, f: 30 },
      },
    ],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [
      {
        id: 'tool-1',
        name: 'Quarter Inch Endmill',
        units: 'inch',
        type: 'flat_endmill',
        diameter: 0.25,
        vBitAngle: null,
        flutes: 2,
        material: 'carbide',
        defaultRpm: 18000,
        defaultFeed: 60,
        defaultPlungeFeed: 30,
        defaultStepdown: 0.1,
        defaultStepover: 0.125,
        maxCutDepth: 1,
      },
    ],
    operations: [
      outsideRouteOperation('op-route-a', 'Route A'),
      outsideRouteOperation('op-route-b', 'Route B'),
    ],
    tabs: [],
    clamps: [],
    ai_history: [],
  })
}

const GCODE_EXPORT_FIXTURE_JSON = buildGcodeExportProjectJson()

export async function seedGcodeExportProject(page: Page): Promise<void> {
  await seedProject(page, GCODE_EXPORT_FIXTURE_JSON)
}
