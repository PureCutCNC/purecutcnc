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
 * Theme manager, theme editor, and editor preview-sample strings. Built-in
 * theme NAMES ("Dark", "Light") and the token/group/contrast-check labels
 * from `src/theme/tokens.ts` / `src/theme/contrast.ts` are registry data and
 * stay English (documented boundary, like canvas-drawn preview labels).
 */
export const themeManagerEn = {
  'themeManager.dialogAria': 'Manage themes',
  'themeManager.title': 'Manage Themes',
  'themeManager.close': 'Close',
  'themeManager.listAria': 'Themes',
  'themeManager.builtinBadge': 'Built-in',
  'themeManager.customBadge': 'Custom',
  'themeManager.activeBadge': 'Active',
  'themeManager.nameLabel': 'Theme name',
  'themeManager.saveName': 'Save name',
  'themeManager.familyLabel': 'Family',
  'themeManager.basedOnLabel': 'Based on',
  'themeManager.changedColorsLabel': 'Changed colors',
  'themeManager.builtinHint': 'Built-in themes are read-only. Duplicate to create an editable copy.',
  'themeManager.resetNotice': 'Reset “{name}” to its {base} base colors.',
  'themeManager.importFailed': 'Import failed: {error}',
  'themeManager.imported': 'Imported “{name}”.',
  'themeManager.use': 'Use this theme',
  'themeManager.edit': 'Edit',
  'themeManager.duplicateToEdit': 'Duplicate to edit',
  'themeManager.duplicate': 'Duplicate',
  'themeManager.rename': 'Rename',
  'themeManager.resetToBase': 'Reset to base',
  'themeManager.import': 'Import theme',
  'themeManager.export': 'Export theme',
  'themeManager.delete': 'Delete theme',
  'themeManager.systemAria': 'System mode pairing',
  'themeManager.modeTitle': 'Mode',
  'themeManager.fixedMode': 'Fixed theme',
  'themeManager.systemMode': 'Follow system light/dark',
  'themeManager.lightSlot': 'Light theme',
  'themeManager.darkSlot': 'Dark theme',
  'themeManager.systemPrefersDark': 'This device currently prefers dark.',
  'themeManager.systemPrefersLight': 'This device currently prefers light.',
  'themeManager.done': 'Done',

  'themeEditor.title': 'Edit Theme',
  'themeEditor.dialogAria': 'Edit theme {name}',
  'themeEditor.previewingLive': 'Previewing your edits live.',
  'themeEditor.colorsWrong': 'Colors look wrong?',
  'themeEditor.restoreSaved': 'Restore saved colors',
  'themeEditor.basedOn.one': 'Based on {base} · {count} color changed',
  'themeEditor.basedOn.other': 'Based on {base} · {count} colors changed',
  'themeEditor.contrastAria': 'Contrast checks',
  'themeEditor.contrastTitle': 'Readability checks',
  'themeEditor.allChecksPass': 'All {count} checks pass.',
  'themeEditor.blockedLabel': 'Blocked:',
  'themeEditor.warningLabel': 'Warning:',
  'themeEditor.ratioNeeds': '{measured}:1, needs {required}:1',
  'themeEditor.deltaNeeds': 'ΔE {measured}, needs {required}',
  'themeEditor.ratioRecommended': '{measured}:1, recommended {required}:1',
  'themeEditor.deltaRecommended': 'ΔE {measured}, recommended {required}',
  'themeEditor.contrastNote': 'Automated spot checks of representative states — not full WCAG coverage.',
  'themeEditor.checksFailing.one': '{count} readability check failing',
  'themeEditor.checksFailing.other': '{count} readability checks failing',
  'themeEditor.cancel': 'Cancel',
  'themeEditor.apply': 'Apply theme',
  'themeEditor.fixBlockedTitle': 'Fix the blocked readability checks before applying',
  'themeEditor.giveNameTitle': 'Give the theme a name',
  'themeEditor.colorPickerAria': '{label} color picker',
  'themeEditor.baseValueTitle': 'Base value: {value}',
  'themeEditor.resetFieldAria': 'Reset {label} to base value',
  'themeEditor.resetFieldTitle': 'Reset to base ({value})',

  'themePreview.panelTitle': 'Panel & text',
  'themePreview.panelText': 'Primary text on a panel surface.',
  'themePreview.panelTextDim': 'Muted guidance text for hints.',
  'themePreview.controlsTitle': 'Controls',
  'themePreview.primary': 'Primary',
  'themePreview.secondary': 'Secondary',
  'themePreview.disabled': 'Disabled',
  'themePreview.selectedItem': 'Selected item',
  'themePreview.focusedControl': 'Focused control',
  'themePreview.messagesTitle': 'Messages',
  'themePreview.positive': 'Positive: toolpath generated.',
  'themePreview.warning': 'Warning: shallow pass depth.',
  'themePreview.danger': 'Danger: clamp collision detected.',
  'themePreview.canvasTitle': 'Sketch canvas',
  'themePreview.legendLine': 'Line',
  'themePreview.legendRegion': 'Region',
  'themePreview.legendConstruction': 'Constr.',
  'themePreview.legendAdd': 'Add',
  'themePreview.legendCut': 'Cut',
} as const satisfies Record<string, string>
