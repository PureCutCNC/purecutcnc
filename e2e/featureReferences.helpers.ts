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

/**
 * Feature-references–specific helpers.
 *
 * Built on top of the generic primitives in `helpers.ts`.  A new
 * feature-area smoke (e.g. CAM operations) would get its own
 * `camOperations.helpers.ts` following the same pattern.
 */

import type { Page } from '@playwright/test'
import { seedProject } from './helpers'

// ── Linked-fixture project builder ──────────────────────────────────

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

function rectDef(id: string, cx: number, cy: number, w: number, h: number) {
  return {
    id,
    kind: 'rect' as const,
    profile: resolvedRectProfile(cx, cy, w, h),
    dimensions: [] as unknown[],
    text: null,
    stl: null,
    operation: 'add' as const,
  }
}

function linkedFeature(
  id: string,
  name: string,
  definitionId: string,
  tx: number,
  ty: number,
  defCx: number,
  defCy: number,
  defW: number,
  defH: number,
) {
  const rx = defCx + tx
  const ry = defCy + ty
  return {
    id,
    name,
    kind: 'rect' as const,
    folderId: null,
    sketch: {
      profile: resolvedRectProfile(rx, ry, defW, defH),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [] as unknown[],
      constraints: [] as unknown[],
    },
    operation: 'add' as const,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
    definitionId,
    transform: [1, 0, 0, 1, tx, ty] as [number, number, number, number, number, number],
  }
}

/**
 * Build a project JSON with:
 *  - 2 linked rects sharing def-linked
 *  - 1 independent rect (own definition)
 *  - 1 made-unique rect (own definition, simulating prior makeUnique)
 */
export function buildLinkedProjectJson(): string {
  const defs: Record<string, unknown> = {}
  defs['def-linked'] = rectDef('def-linked', 0, 0, 60, 40)
  defs['def-independent'] = rectDef('def-independent', 0, 0, 60, 40)
  defs['def-unique'] = rectDef('def-unique', 0, 0, 60, 40)

  const features = [
    linkedFeature('f-linked-a', 'Linked A', 'def-linked', 0, 0, 0, 0, 60, 40),
    linkedFeature('f-linked-b', 'Linked B', 'def-linked', 80, 0, 0, 0, 60, 40),
    linkedFeature('f-independent', 'Independent', 'def-independent', 0, 80, 0, 0, 60, 40),
    linkedFeature('f-unique', 'Former Link', 'def-unique', 80, 80, 0, 0, 60, 40),
  ]

  const stockW = 200
  const stockH = 160
  return JSON.stringify({
    version: '2.0',
    meta: {
      name: 'E2E Smoke Fixture',
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
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
    featureDefinitions: defs,
    features,
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

const LINKED_FIXTURE_JSON = buildLinkedProjectJson()

/**
 * Seed the store with the linked-fixture project.
 *
 * Usage:
 *   await seedLinkedProject(app.page)
 */
export async function seedLinkedProject(page: Page): Promise<void> {
  await seedProject(page, LINKED_FIXTURE_JSON)
}
