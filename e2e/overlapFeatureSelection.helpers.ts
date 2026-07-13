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

import type { Locator, Page } from '@playwright/test'
import { seedProject } from './helpers'

function rectProfile(x: number, y: number, width: number, height: number) {
  return {
    start: { x, y },
    segments: [
      { type: 'line' as const, to: { x: x + width, y } },
      { type: 'line' as const, to: { x: x + width, y: y + height } },
      { type: 'line' as const, to: { x, y: y + height } },
      { type: 'line' as const, to: { x, y } },
    ],
    closed: true,
  }
}

function definition(id: string, width: number, height: number) {
  return {
    id,
    kind: 'rect' as const,
    profile: rectProfile(0, 0, width, height),
    dimensions: [] as unknown[],
    text: null,
    stl: null,
    operation: 'add' as const,
  }
}

function feature(id: string, name: string, definitionId: string) {
  return {
    id,
    name,
    definitionId,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    constraints: [] as unknown[],
    folderId: null,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function buildOverlapFeatureProjectJson(): string {
  const now = '2026-07-13T00:00:00.000Z'
  const stockWidth = 120
  const stockHeight = 90

  return JSON.stringify({
    version: '3.0',
    meta: {
      name: 'Overlap selection E2E fixture',
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
      profile: rectProfile(0, 0, stockWidth, stockHeight),
      thickness: 2,
      material: 'aluminum_6061',
      color: '#b9a83c',
      visible: true,
      origin: { x: 0, y: 0 },
    },
    origin: { name: 'Origin', x: stockWidth / 2, y: stockHeight / 2, z: 2, visible: true },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {
      'def-overlap-bottom': definition('def-overlap-bottom', stockWidth, stockHeight),
      'def-overlap-top': definition('def-overlap-top', stockWidth, stockHeight),
    },
    features: [
      feature('f-overlap-bottom', 'Bottom overlap', 'def-overlap-bottom'),
      feature('f-overlap-top', 'Top overlap', 'def-overlap-top'),
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

const OVERLAP_FEATURE_PROJECT_JSON = buildOverlapFeatureProjectJson()

export async function seedOverlapFeatureProject(page: Page): Promise<void> {
  await seedProject(page, OVERLAP_FEATURE_PROJECT_JSON)
}

export async function clickCanvasCenter(canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox()
  if (!box) throw new Error('sketch canvas did not have a bounding box')

  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } })
}
