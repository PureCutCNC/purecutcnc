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
 * Single source of truth for DOM selectors used in browser smoke tests.
 *
 * WHEN THE UI CHANGES: update the selector here — every spec picks it up
 * automatically. Specs MUST NOT inline raw selectors.
 *
 * New feature areas add their own logical groups; nothing else in the
 * harness needs to change.
 */

import type { Locator, Page } from '@playwright/test'

// ── Feature tree ────────────────────────────────────────────────────

export const tree = {
  /** Opens the tablet project drawer. */
  openProjectPanelButton: (page: Page) => page.getByRole('button', { name: 'Open project panel' }),

  /** All tree rows (any kind). */
  rows: (page: Page) => page.locator('.tree-row'),

  /** Project root row. */
  projectRow: (page: Page) => page.locator('.tree-row--project'),

  /** Feature rows only (excludes folders, section headers, etc.). */
  featureRows: (page: Page) => page.locator('.tree-row.tree-row--feature'),

  /** A specific feature row by its label text. */
  rowByName: (page: Page, name: string) =>
    page.locator('.tree-row--feature').filter({ hasText: name }),

  /** Rows that are currently selected. */
  selectedRows: (page: Page) => page.locator('.tree-row--selected'),

  /** The label + badge wrapper inside a row. */
  labelWrap: (row: Locator) => row.locator('.tree-label-wrap'),

  /** The action buttons wrapper inside a row. */
  actions: (row: Locator) => row.locator('.tree-row-actions'),
}

// ── Linked badge ────────────────────────────────────────────────────

export const badge = {
  /** All linked badges on the page. */
  linked: (page: Page) => page.locator('.tree-linked-badge'),

  /** Linked badge within a specific row. */
  linkedInRow: (row: Locator) => row.locator('.tree-linked-badge'),

  /** The SVG <use> element inside a badge (resolves to #link icon). */
  icon: (badgeEl: Locator) => badgeEl.locator('svg use'),
}

// ── Context menu ────────────────────────────────────────────────────

export const contextMenu = {
  /** The open context menu container. */
  container: (page: Page) => page.locator('.feature-context-menu'),

  /** The open context-menu flyout submenu. */
  submenu: (page: Page) => page.locator('.feature-context-menu__submenu'),

  /** A menu item by its label text. */
  item: (menu: Locator, label: string) =>
    menu.locator('.feature-context-menu__item', { hasText: label }),
}

// ── Properties panel ────────────────────────────────────────────────

export const properties = {
  /** The properties panel container. */
  panel: (page: Page) => page.locator('.properties-panel'),

  /** Any element containing the given text within the panel. */
  text: (page: Page, text: string | RegExp) =>
    page.locator('.properties-panel').getByText(text),

  /** Exact text match within the panel. */
  exactText: (page: Page, text: string) =>
    page.locator('.properties-panel').getByText(text, { exact: true }),

  /** Project Units custom-select trigger, visible when the project root is selected. */
  unitsTrigger: (page: Page) =>
    page.locator('.properties-panel .properties-field').filter({ hasText: 'Units' }).locator('.ui-select__trigger'),

  /** An option in the open Project Units custom select. */
  unitsOption: (page: Page, label: string) =>
    page.locator('.properties-panel .properties-field').filter({ hasText: 'Units' }).getByRole('option', { name: label }),
}

// ── Project unit conversion dialog ─────────────────────────────────

export const unitConversionDialog = {
  root: (page: Page) => page.getByRole('dialog', { name: 'Change project units?' }),
  directionArrow: (page: Page) => page.locator('.unit-conversion-route__arrow'),
  convertButton: (page: Page) => page.getByRole('button', { name: /Convert values/ }),
  reinterpretButton: (page: Page) => page.getByRole('button', { name: /Keep numeric values/ }),
  cancelButton: (page: Page) => page.getByRole('button', { name: 'Cancel', exact: true }),
}

// ── CAM operations ──────────────────────────────────────────────────

export const operations = {
  /** Visible operation-count badge in the CAM panel. */
  countBadge: (page: Page) =>
    page.locator('.cam-panel .cam-section--tree .cam-section-header .feature-count'),

  /** Rendered CAM operation rows. */
  rows: (page: Page) => page.locator('.cam-operation-tree .tree-row--feature'),

  /** A specific CAM operation row by its label text. */
  rowByName: (page: Page, name: string) =>
    page.locator('.cam-operation-tree .tree-row--feature').filter({ hasText: name }),

  /** The "Export" button in the Operations panel header (exports the default set). */
  headerExportButton: (page: Page) =>
    page.locator('.cam-panel .cam-section-toolbar').getByRole('button', { name: 'Export', exact: true }),

  /** The Properties-header "Export G-code" action for the selected operation. */
  propertiesExportButton: (page: Page, name: string) =>
    page
      .locator('.cam-section--properties .cam-section-header')
      .getByRole('button', { name: `Export G-code for ${name}` }),
}

// ── Export G-code dialog ────────────────────────────────────────────

export const exportDialog = {
  /** The Export G-code dialog root. */
  root: (page: Page) =>
    page.locator('.dialog').filter({ has: page.locator('.dialog-title', { hasText: 'Export G-code' }) }),

  /** All rows of the operation checklist. */
  operationOptions: (page: Page) =>
    exportDialog.root(page).locator('.export-operation-list .export-option'),

  /** A checklist row by operation name. */
  operationOption: (page: Page, name: string) =>
    exportDialog.operationOptions(page).filter({ hasText: name }),

  /** The checkbox inside a named checklist row. */
  operationCheckbox: (page: Page, name: string) =>
    exportDialog.operationOption(page, name).locator('input[type="checkbox"]'),

  /** The "Select all" / "Deselect all" toggle above the checklist. */
  selectionToggle: (page: Page) =>
    exportDialog.root(page).locator('.export-operations-toggle'),

  /** Warning entries shown in the dialog. */
  warnings: (page: Page) => exportDialog.root(page).locator('.export-warning'),

  /** The primary footer button that performs the export. */
  exportButton: (page: Page) => exportDialog.root(page).locator('.dialog-footer .btn-primary'),
}

// ── Canvas ──────────────────────────────────────────────────────────

export const canvas = {
  /** The sketch (2D) canvas. */
  sketch: (page: Page) => page.locator('canvas.sketch-canvas'),

  /** The first <canvas> on the page (sketch in default tab layout). */
  any: (page: Page) => page.locator('canvas').first(),
}

// ── Overlap feature picker ─────────────────────────────────────────

export const overlapFeaturePicker = {
  root: (page: Page) => page.getByRole('dialog', { name: 'Select feature' }),
  candidates: (page: Page) => overlapFeaturePicker.root(page).locator('.overlap-feature-picker__candidate'),
  candidate: (page: Page, name: string) => overlapFeaturePicker.root(page).getByRole('button', { name: new RegExp(`Select ${name}`) }),
  cancelButton: (page: Page) => overlapFeaturePicker.root(page).getByRole('button', { name: 'Cancel', exact: true }),
}

// ── Toolbar ─────────────────────────────────────────────────────────

export const toolbar = {
  /** All toolbar groups. */
  groups: (page: Page) => page.locator('.toolbar-group'),

  /** Add-point button (visible during sketch edit). */
  addPointButton: (page: Page) => page.locator('button[aria-label="Add point"]'),
}
