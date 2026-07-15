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
