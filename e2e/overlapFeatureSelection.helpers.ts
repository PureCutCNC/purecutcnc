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

function feature(
  id: string,
  name: string,
  definitionId: string,
  transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
) {
  return {
    id,
    name,
    definitionId,
    transform,
    constraints: [] as unknown[],
    folderId: null,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function buildOverlapFeatureProjectJson(featureCount: number, obviousOutline = false): string {
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
    featureDefinitions: Object.fromEntries(Array.from({ length: featureCount }, (_, index) => {
      const id = `overlap-${index + 1}`
      const isObviousTop = obviousOutline && featureCount === 2 && index === 1
      return [`def-${id}`, definition(`def-${id}`, isObviousTop ? 50 : stockWidth, isObviousTop ? 30 : stockHeight)]
    })),
    features: Array.from({ length: featureCount }, (_, index) => {
      const name = featureCount === 2
        ? (index === 0 ? 'Bottom overlap' : 'Top overlap')
        : `Overlap feature ${index + 1}`
      const id = `overlap-${index + 1}`
      const isObviousTop = obviousOutline && featureCount === 2 && index === 1
      return feature(
        `f-${id}`,
        name,
        `def-${id}`,
        isObviousTop
          ? { a: 1, b: 0, c: 0, d: 1, e: 10, f: 30 }
          : undefined,
      )
    }),
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

export async function seedOverlapFeatureProject(page: Page, featureCount = 2): Promise<void> {
  await seedProject(page, buildOverlapFeatureProjectJson(featureCount))
}

export async function seedObviousOverlapFeatureProject(page: Page): Promise<void> {
  await seedProject(page, buildOverlapFeatureProjectJson(2, true))
}

/**
 * Outer rect drawn on top of a small inner rect (outer is last in the tree).
 * A click near the inner rect's outline still selects the inner rect through
 * the boundary rule, which is exactly the case where the old topmost-only
 * context-menu hit test picked the outer rect instead (issue #521 follow-up).
 */
function buildStackedRectProjectJson(): string {
  const now = '2026-07-13T00:00:00.000Z'
  const stockWidth = 120
  const stockHeight = 90
  const featureRow = (id: string, name: string, definitionId: string) => ({
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
  })
  return JSON.stringify({
    version: '3.0',
    meta: {
      name: 'Stacked rect E2E fixture',
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
      'def-stacked-outer': definition('def-stacked-outer', 100, 80),
      'def-stacked-inner': definition('def-stacked-inner', 20, 10),
    },
    // The outer rect is drawn on top (last in the tree) and fully covers the
    // inner one. The inner rect is translated to world (30,25)-(50,35) so its
    // outline stays clear of the outer rect's edges — a click just inside it
    // indicates exactly one outline.
    features: [
      { ...featureRow('f-stacked-inner', 'Inner rect', 'def-stacked-inner'), transform: { a: 1, b: 0, c: 0, d: 1, e: 30, f: 25 } },
      featureRow('f-stacked-outer', 'Outer rect', 'def-stacked-outer'),
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

/** Seed an outer-on-top stacked rect project and return it for tests. */
export async function seedStackedRectProject(page: Page): Promise<void> {
  await seedProject(page, buildStackedRectProjectJson())
}

export async function clickCanvasCenter(canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox()
  if (!box) throw new Error('sketch canvas did not have a bounding box')

  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } })
}

/**
 * World→canvas-pixel mapping for these fixtures. Same rule as
 * `computeBaseViewTransform` (VIEW_PADDING = 42): the base view fits the
 * 120×90 stock into the canvas.
 */
export async function canvasWorldPoint(
  canvas: Locator,
  worldX: number,
  worldY: number,
): Promise<{ x: number; y: number }> {
  const box = await canvas.boundingBox()
  if (!box) throw new Error('sketch canvas did not have a bounding box')

  const STOCK_W = 120
  const STOCK_H = 90
  const VIEW_PADDING = 42
  const scale = Math.min(
    (box.width - VIEW_PADDING * 2) / STOCK_W,
    (box.height - VIEW_PADDING * 2) / STOCK_H,
  )
  return {
    x: (box.width - STOCK_W * scale) / 2 + worldX * scale,
    y: (box.height - STOCK_H * scale) / 2 + worldY * scale,
  }
}

/** Click the canvas at a world point (button left or right). */
export async function clickCanvasWorld(
  canvas: Locator,
  worldX: number,
  worldY: number,
  button: 'left' | 'right' = 'left',
): Promise<void> {
  await canvas.click({ position: await canvasWorldPoint(canvas, worldX, worldY), button })
}

/**
 * Click just inside the shared left outline of the fixture's coincident
 * full-stock rects (world ~(0.4, 45)). Every feature's outline passes through
 * there, so the click stays ambiguous and opens the overlap picker even though
 * interior clicks now resolve to the topmost feature (issue #521).
 */
export async function clickCanvasSharedEdge(canvas: Locator): Promise<void> {
  await clickCanvasWorld(canvas, 0.4, 45)
}
