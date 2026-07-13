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

function buildCamQuickOperationProjectJson(): string {
  const now = '2026-01-01T00:00:00.000Z'
  const stockW = 180
  const stockH = 120
  return JSON.stringify({
    version: '3.0',
    meta: {
      name: 'CAM Quick Operation E2E Fixture',
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
      machineDefinitions: [],
      selectedMachineId: null,
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
        definitionId: 'def-machinable-add',
        transform: { a: 1, b: 0, c: 0, d: 1, e: 30, f: 30 },
        constraints: [],
        folderId: null,
        z_top: 5,
        z_bottom: 0,
        visible: true,
        locked: false,
      },
    ],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  })
}

const CAM_QUICK_OPERATION_FIXTURE_JSON = buildCamQuickOperationProjectJson()

export async function seedCamQuickOperationProject(page: Page): Promise<void> {
  await seedProject(page, CAM_QUICK_OPERATION_FIXTURE_JSON)
}
