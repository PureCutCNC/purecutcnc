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

// ── Appearance ─────────────────────────────────────────────────────

export const appearance = {
  trigger: (page: Page) => page.getByRole('button', { name: /^Appearance:/ }),
  menu: (page: Page) => page.getByRole('menu', { name: 'Appearance theme' }),
  option: (page: Page, label: 'Dark' | 'Light' | 'System') =>
    appearance.menu(page).getByRole('menuitemradio', { name: new RegExp(`^${label}`) }),
  customOption: (page: Page, name: string) =>
    appearance.menu(page).getByRole('menuitemradio').filter({ has: page.getByText(name, { exact: true }) }),
  manageEntry: (page: Page) =>
    appearance.menu(page).getByRole('menuitem', { name: /^Manage themes/ }),
  positiveActionProbe: (page: Page) =>
    page.getByRole('button', { name: 'Positive action contrast probe' }),
}

// ── Language ───────────────────────────────────────────────────────

export const language = {
  // The trigger's accessible name is localized ("Language: English" /
  // "语言：简体中文" / "Sprache: Deutsch" / "Idioma: Español" / "Langue : Français"),
  // so match every shipped locale.
  trigger: (page: Page) => page.getByRole('button', { name: /^(Language:|Idioma:|Sprache:|Langue :|语言：)/ }),
  menu: (page: Page) => page.getByRole('menu', { name: /^(Interface language|Idioma de la interfaz|Oberflächensprache|Langue de l’interface|界面语言)$/ }),
  option: (page: Page, label: string) =>
    language.menu(page).getByRole('menuitemradio', { name: new RegExp(`^${label}`) }),
  manageEntry: (page: Page) =>
    language.menu(page).getByRole('menuitem', { name: /^(Manage languages|Gérer les langues)/ }),
}

// ── Language manager & editor ──────────────────────────────────────

export const languageManager = {
  dialog: (page: Page) => page.getByRole('dialog', { name: 'Manage languages' }),
  localeItem: (page: Page, name: string) =>
    languageManager.dialog(page).getByRole('option')
      .filter({ has: page.getByText(name, { exact: true }) }),
  detailName: (page: Page) =>
    languageManager.dialog(page).locator('.machine-manager-detail-name'),
  progress: (page: Page) =>
    languageManager.dialog(page).locator('.language-manager-progress'),
  useButton: (page: Page) =>
    languageManager.dialog(page).getByRole('button', { name: 'Use this language' }),
  duplicateButton: (page: Page) =>
    languageManager.dialog(page).getByRole('button', { name: 'Duplicate & edit' }),
  editButton: (page: Page) =>
    languageManager.dialog(page).getByRole('button', { name: 'Edit', exact: true }),
  renameButton: (page: Page) =>
    languageManager.dialog(page).getByRole('button', { name: 'Rename' }),
  renameInput: (page: Page) =>
    languageManager.dialog(page).getByRole('textbox', { name: 'Language name' }),
  saveNameButton: (page: Page) =>
    languageManager.dialog(page).getByRole('button', { name: 'Save name' }),
  importButton: (page: Page) =>
    languageManager.dialog(page).getByRole('button', { name: 'Import language' }),
  exportButton: (page: Page) =>
    languageManager.dialog(page).getByRole('button', { name: 'Export language' }),
  deleteButton: (page: Page) =>
    languageManager.dialog(page).getByRole('button', { name: 'Delete language' }),
  notice: (page: Page) =>
    languageManager.dialog(page).locator('.theme-manager-notice'),
  doneButton: (page: Page) =>
    languageManager.dialog(page).getByRole('button', { name: 'Done' }),
}

export const languageEditor = {
  dialog: (page: Page) => page.getByRole('dialog', { name: /^Edit language/ }),
  nameInput: (page: Page) =>
    languageEditor.dialog(page).getByLabel('Language name'),
  tagInput: (page: Page) =>
    languageEditor.dialog(page).getByLabel('BCP-47 language tag'),
  searchInput: (page: Page) =>
    languageEditor.dialog(page).getByRole('searchbox'),
  filterSelect: (page: Page) =>
    languageEditor.dialog(page).getByLabel('Show'),
  section: (page: Page, namespace: string) =>
    languageEditor.dialog(page).locator('.language-editor-section')
      .filter({ has: page.locator('.language-editor-section__name', { hasText: new RegExp(`^${namespace}$`) }) }),
  keyInput: (page: Page, key: string) =>
    languageEditor.dialog(page).getByRole('textbox', { name: key, exact: true }),
  rowIssue: (page: Page) =>
    languageEditor.dialog(page).locator('.language-editor-row__issue'),
  footerBlocked: (page: Page) =>
    languageEditor.dialog(page).locator('.theme-editor-footer-blocked'),
  previewingNote: (page: Page) =>
    languageEditor.dialog(page).locator('.language-editor-footer-note'),
  previewButton: (page: Page) =>
    languageEditor.dialog(page).getByRole('button', { name: 'Preview in app' }),
  applyButton: (page: Page) =>
    languageEditor.dialog(page).getByRole('button', { name: 'Apply', exact: true }),
  cancelButton: (page: Page) =>
    languageEditor.dialog(page).getByRole('button', { name: 'Cancel', exact: true }),
}

// ── Theme manager & editor ─────────────────────────────────────────

export const themeManager = {
  dialog: (page: Page) => page.getByRole('dialog', { name: 'Manage themes' }),
  themeItem: (page: Page, name: string) =>
    themeManager.dialog(page).getByRole('option')
      .filter({ has: page.getByText(name, { exact: true }) }),
  detailName: (page: Page) =>
    themeManager.dialog(page).locator('.machine-manager-detail-name'),
  useButton: (page: Page) =>
    themeManager.dialog(page).getByRole('button', { name: 'Use this theme' }),
  duplicateButton: (page: Page) =>
    themeManager.dialog(page).getByRole('button', { name: /^Duplicate/ }),
  editButton: (page: Page) =>
    themeManager.dialog(page).getByRole('button', { name: 'Edit', exact: true }),
  renameButton: (page: Page) =>
    themeManager.dialog(page).getByRole('button', { name: 'Rename' }),
  renameInput: (page: Page) =>
    themeManager.dialog(page).getByRole('textbox', { name: 'Theme name' }),
  saveNameButton: (page: Page) =>
    themeManager.dialog(page).getByRole('button', { name: 'Save name' }),
  resetButton: (page: Page) =>
    themeManager.dialog(page).getByRole('button', { name: 'Reset to base' }),
  importButton: (page: Page) =>
    themeManager.dialog(page).getByRole('button', { name: 'Import theme' }),
  exportButton: (page: Page) =>
    themeManager.dialog(page).getByRole('button', { name: 'Export theme' }),
  deleteButton: (page: Page) =>
    themeManager.dialog(page).getByRole('button', { name: 'Delete theme' }),
  notice: (page: Page) =>
    themeManager.dialog(page).locator('.theme-manager-notice'),
  fixedModeRadio: (page: Page) =>
    themeManager.dialog(page).getByRole('radio', { name: 'Fixed theme' }),
  systemModeRadio: (page: Page) =>
    themeManager.dialog(page).getByRole('radio', { name: 'Follow system light/dark' }),
  systemLightSelect: (page: Page) =>
    themeManager.dialog(page).getByLabel('Light theme'),
  systemDarkSelect: (page: Page) =>
    themeManager.dialog(page).getByLabel('Dark theme'),
  doneButton: (page: Page) =>
    themeManager.dialog(page).getByRole('button', { name: 'Done' }),
}

export const themeEditor = {
  dialog: (page: Page) => page.getByRole('dialog', { name: /^Edit theme/ }),
  nameInput: (page: Page) =>
    themeEditor.dialog(page).getByLabel('Theme name'),
  colorText: (page: Page, label: string) =>
    themeEditor.dialog(page).getByLabel(label, { exact: true }),
  resetField: (page: Page, label: string) =>
    themeEditor.dialog(page).getByRole('button', { name: `Reset ${label} to base value` }),
  restoreButton: (page: Page) =>
    themeEditor.dialog(page).getByRole('button', { name: 'Restore saved colors' }),
  applyButton: (page: Page) =>
    themeEditor.dialog(page).getByRole('button', { name: 'Apply theme' }),
  cancelButton: (page: Page) =>
    themeEditor.dialog(page).getByRole('button', { name: 'Cancel' }),
  blockers: (page: Page) =>
    themeEditor.dialog(page).locator('.theme-editor-contrast__item--block'),
  contrastOk: (page: Page) =>
    themeEditor.dialog(page).locator('.theme-editor-contrast__ok'),
}

// ── Status bar and About dialog ────────────────────────────────────

export const statusBar = {
  root: (page: Page) => page.locator('.app-statusbar'),
  toggle: (page: Page, label: string) =>
    statusBar.root(page).getByRole('button', { name: label, exact: true }),
  about: (page: Page) => statusBar.root(page).locator('.statusbar-about'),
}

export const aboutDialog = {
  root: (page: Page) => page.getByRole('dialog', { name: 'About PureCutCNC' }),
  title: (page: Page) => aboutDialog.root(page).locator('.dialog-title'),
  productName: (page: Page) => aboutDialog.root(page).locator('.about-name'),
}

// ── New Project dialog ─────────────────────────────────────────────

export const newProjectDialog = {
  root: (page: Page) => page.locator('.dialog--new-project'),
  template: (page: Page, label: string) =>
    newProjectDialog.root(page).getByRole('button', { name: new RegExp(`^${label}`) }),
}

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

  /** Feature-folder rows only. */
  folderRows: (page: Page) => page.locator('.tree-row.tree-row--folder'),

  /** A specific feature row by its label text. */
  rowByName: (page: Page, name: string) =>
    page.locator('.tree-row--feature').filter({ hasText: name }),

  /** A specific feature-folder row by its label text. */
  folderRowByName: (page: Page, name: string) =>
    page.locator('.tree-row--folder').filter({ hasText: name }),

  /** Adds a folder to the machining-features section. */
  addFolderButton: (page: Page) => page.getByRole('button', { name: 'Add folder', exact: true }),

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

  /** The "Add" button and menu in the Operations panel header. */
  headerAddButton: (page: Page) =>
    page.locator('.cam-panel .cam-section-toolbar').getByRole('button', { name: 'Add', exact: true }),
  addMenu: (page: Page) => page.locator('.cam-add-menu--vertical'),
  addMenuHint: (page: Page) => page.locator('.cam-add-menu--vertical .cam-operation-hint').first(),

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
  list: (page: Page) => overlapFeaturePicker.root(page).locator('.overlap-feature-picker__list'),
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

  /** Opens the New Project dialog. */
  newProjectButton: (page: Page) => page.getByRole('button', { name: 'New project' }),
}
