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
 * Generic helpers for PureCutCNC browser smoke tests.
 *
 * These primitives are feature-area agnostic. Domain-specific helpers
 * (e.g. building a linked-fixture project) belong in a per-area module
 * like `featureReferences.helpers.ts`.
 */

import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures'
import { contextMenu as ctxSel, tree as treeSel } from './selectors'

// ── __pcTest seam ───────────────────────────────────────────────────

/** Load a project JSON string into the live store via __pcTest. */
export async function seedProject(page: Page, json: string): Promise<void> {
  await page.evaluate(async ({ json: j }: { json: string }) => {
    const w = window as unknown as { __pcTest: { loadProject: (s: string) => Promise<void> } }
    await w.__pcTest.loadProject(j)
  }, { json })
}

/** Snapshot the live store project via __pcTest. */
export async function getProject(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const w = window as unknown as { __pcTest: { getProject: () => Promise<Record<string, unknown>> } }
    return w.__pcTest.getProject()
  })
}

/** Return the feature currently preview-highlighted by the live store. */
export async function getHoveredFeatureId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const w = window as unknown as { __pcTest: { getHoveredFeatureId: () => Promise<string | null> } }
    return w.__pcTest.getHoveredFeatureId()
  })
}

/** Get the current pending move state (null if idle). */
export async function getPendingMove(
  page: Page,
): Promise<{ mode: string; entityType: string; entityIds: string[] } | null> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __pcTest: { getPendingMove: () => Promise<{ mode: string; entityType: string; entityIds: string[] } | null> }
    }
    return w.__pcTest.getPendingMove()
  })
}

/** Complete a pending copy/move at the given canvas coordinates. */
export async function completePendingMove(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  await page.evaluate(async ({ x: px, y: py }: { x: number; y: number }) => {
    const w = window as unknown as {
      __pcTest: { completePendingMove: (x: number, y: number) => Promise<void> }
    }
    await w.__pcTest.completePendingMove(px, py)
  }, { x, y })
}

/** Arm the rectangle creation tool via the store. */
export async function startAddRectPlacement(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as { __pcTest: { startAddRectPlacement: () => Promise<void> } }
    await w.__pcTest.startAddRectPlacement()
  })
}

/** Set the pending-add anchor point on the canvas. */
export async function setPendingAddAnchor(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(async ({ x: px, y: py }: { x: number; y: number }) => {
    const w = window as unknown as { __pcTest: { setPendingAddAnchor: (x: number, y: number) => Promise<void> } }
    await w.__pcTest.setPendingAddAnchor(px, py)
  }, { x, y })
}

/** Complete a pending-add placement at the given point. */
export async function placePendingAddAt(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(async ({ x: px, y: py }: { x: number; y: number }) => {
    const w = window as unknown as { __pcTest: { placePendingAddAt: (x: number, y: number) => Promise<void> } }
    await w.__pcTest.placePendingAddAt(px, py)
  }, { x, y })
}

/** Cancel the current pending-add draft (Escape equivalent). */
export async function cancelPendingAdd(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as { __pcTest: { cancelPendingAdd: () => Promise<void> } }
    await w.__pcTest.cancelPendingAdd()
  })
}

/** Get the current pending-add shape (or null if idle). */
export async function getPendingAddShape(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const w = window as unknown as { __pcTest: { getPendingAddShape: () => Promise<string | null> } }
    return w.__pcTest.getPendingAddShape()
  })
}

/** Get the current feature count. */
export async function getFeatureCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const w = window as unknown as { __pcTest: { getFeatureCount: () => Promise<number> } }
    return w.__pcTest.getFeatureCount()
  })
}

/** Set the selected sketch features before invoking a visible command control. */
export async function selectFeatures(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(async (featureIds: string[]) => {
    const w = window as unknown as { __pcTest: { selectFeatures: (ids: string[]) => Promise<void> } }
    await w.__pcTest.selectFeatures(featureIds)
  }, ids)
}

/** Select the given features and open the Join workflow panel. */
export async function startJoinFeatures(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(async (featureIds: string[]) => {
    const w = window as unknown as { __pcTest: { startJoinFeatures: (ids: string[]) => Promise<void> } }
    await w.__pcTest.startJoinFeatures(featureIds)
  }, ids)
}

/** Open the Rotate workflow panel on a feature, before any reference is picked. */
export async function startRotateFeature(page: Page, featureId: string): Promise<void> {
  await page.evaluate(async (id: string) => {
    const w = window as unknown as { __pcTest: { startRotateFeature: (featureId: string) => Promise<void> } }
    await w.__pcTest.startRotateFeature(id)
  }, featureId)
}

/** Read keep-originals off whichever workflow currently owns it. */
export async function getKeepOriginals(
  page: Page,
): Promise<{ shapeAction: boolean | null; transform: boolean | null }> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __pcTest: { getKeepOriginals: () => Promise<{ shapeAction: boolean | null; transform: boolean | null }> }
    }
    return w.__pcTest.getKeepOriginals()
  })
}

/** Enter the sketch edit session for a feature (issue #556). */
export async function enterSketchEdit(page: Page, featureId: string): Promise<void> {
  await page.evaluate(async (id: string) => {
    const w = window as unknown as { __pcTest: { enterSketchEdit: (featureId: string) => Promise<void> } }
    await w.__pcTest.enterSketchEdit(id)
  }, featureId)
}

/** Snapshot the sketch edit session's tool state. */
export async function getSketchEditState(
  page: Page,
): Promise<{ mode: string; tool: string | null; pending: { tool: string; phase: string } | null }> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __pcTest: { getSketchEditState: () => Promise<{ mode: string; tool: string | null; pending: { tool: string; phase: string } | null }> }
    }
    return w.__pcTest.getSketchEditState()
  })
}

/** Simulates the segment click an add-point tool would dispatch. */
export async function insertFeaturePointAt(
  page: Page,
  featureId: string,
  segmentIndex: number,
  x: number,
  y: number,
  t: number,
): Promise<void> {
  await page.evaluate(async (args: { featureId: string; segmentIndex: number; x: number; y: number; t: number }) => {
    const w = window as unknown as {
      __pcTest: { insertFeaturePointAt: (featureId: string, segmentIndex: number, x: number, y: number, t: number) => Promise<void> }
    }
    await w.__pcTest.insertFeaturePointAt(args.featureId, args.segmentIndex, args.x, args.y, args.t)
  }, { featureId, segmentIndex, x, y, t })
}

/** Arms a segment control so Tab opens its dimension inspector. */
export async function setActiveSegmentControl(page: Page, index: number): Promise<void> {
  await page.evaluate(async (segmentIndex: number) => {
    const w = window as unknown as { __pcTest: { setActiveSegmentControl: (index: number) => Promise<void> } }
    await w.__pcTest.setActiveSegmentControl(segmentIndex)
  }, index)
}

/** Picks a trim/extend subject as a canvas click would (mid-pick state). */
export async function setPendingSketchSubject(
  page: Page,
  subject: { featureId: string; segmentIndex: number; x: number; y: number; t: number },
): Promise<void> {
  await page.evaluate(async (next: { featureId: string; segmentIndex: number; x: number; y: number; t: number }) => {
    const w = window as unknown as {
      __pcTest: { setPendingSketchSubject: (subject: { featureId: string; segmentIndex: number; x: number; y: number; t: number }) => Promise<void> }
    }
    await w.__pcTest.setPendingSketchSubject(next)
  }, subject)
}

// ── Feature tree ────────────────────────────────────────────────────

/** Count feature rows currently rendered. */
export function featureRowCount(page: Page): Locator {
  return treeSel.featureRows(page)
}

/** Return a feature row by its label text. */
export function rowByName(page: Page, name: string): Locator {
  return treeSel.rowByName(page, name)
}

// ── Context menu ────────────────────────────────────────────────────

/** Right-click a tree row and return the open context menu locator. */
export async function openRowContextMenu(
  page: Page,
  row: Locator,
): Promise<Locator> {
  await row.click({ button: 'right' })
  const menu = ctxSel.container(page)
  await expect(menu).toBeVisible()
  return menu
}

/** Click a visible context-menu item by its label. */
export async function clickMenuItem(
  menu: Locator,
  label: string,
): Promise<void> {
  const item = ctxSel.item(menu, label)
  await item.click()
}

// ── Assertions ──────────────────────────────────────────────────────

/** Fail if the provided error list is non-empty. */
export function assertNoConsoleErrors(errors: string[]): void {
  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0)
}
