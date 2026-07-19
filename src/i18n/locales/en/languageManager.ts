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

/** Language manager + custom-language editor strings. */
export const languageManagerEn = {
  'langManager.manageEntry': 'Manage languages…',
  'langManager.manageDetail': 'Create, edit, import, export',
  'langManager.title': 'Manage languages',
  'langManager.builtinBadge': 'Built-in',
  'langManager.customBadge': 'Custom',
  'langManager.progress': '{translated} of {total} translated',
  'langManager.activeBadge': 'Active',
  'langManager.use': 'Use this language',
  'langManager.duplicate': 'Duplicate & edit',
  'langManager.duplicateHint': 'Duplicating English starts a new language from scratch; duplicating any other language starts from its translations.',
  'langManager.edit': 'Edit',
  'langManager.rename': 'Rename',
  'langManager.renameLabel': 'Language name',
  'langManager.saveName': 'Save name',
  'langManager.export': 'Export language',
  'langManager.import': 'Import language',
  'langManager.delete': 'Delete language',
  'langManager.done': 'Done',
  'langManager.close': 'Close',
  'langManager.baseLabel': 'Based on',
  'langManager.tagLabel': 'Language tag',
  'langManager.importFailed': 'Import failed: {error}',
  'langManager.imported': 'Imported “{name}”.',
  'langManager.importPlaceholderIssues.one': 'Imported “{name}” with {count} placeholder mismatch — open the editor to review it.',
  'langManager.importPlaceholderIssues.other': 'Imported “{name}” with {count} placeholder mismatches — open the editor to review them.',
  'langManager.deleted': 'Deleted “{name}”.',

  'langEditor.title': 'Edit language — {name}',
  'langEditor.nameLabel': 'Language name',
  'langEditor.tagLabel': 'BCP-47 language tag',
  'langEditor.tagHint': 'Drives the document language attribute and plural rules (e.g. "de", "pt-BR").',
  'langEditor.tagInvalid': 'Enter a valid BCP-47 tag such as "de" or "pt-BR".',
  'langEditor.progress': '{translated} / {total} translated',
  'langEditor.searchPlaceholder': 'Search keys and text…',
  'langEditor.filterLabel': 'Show',
  'langEditor.filterAll': 'All strings',
  'langEditor.filterUntranslated': 'Untranslated only',
  'langEditor.filterEdited': 'Edited only',
  'langEditor.sourceLabel': 'English',
  'langEditor.baseLabel': 'Base ({base})',
  'langEditor.inputPlaceholder': 'Untranslated — falls back to the base language',
  'langEditor.placeholderIssue': 'Placeholders must match the English source exactly: expected {expected}.',
  'langEditor.placeholderIssuesBlockApply.one': '{count} translation has a placeholder mismatch — fix it before applying.',
  'langEditor.placeholderIssuesBlockApply.other': '{count} translations have placeholder mismatches — fix them before applying.',
  'langEditor.resetKey': 'Reset',
  'langEditor.preview': 'Preview in app',
  'langEditor.previewing': 'Previewing — Cancel restores the saved version',
  'langEditor.apply': 'Apply',
  'langEditor.cancel': 'Cancel',
  'langEditor.noMatches': 'No strings match the current search and filter.',
  'langEditor.sectionCount': '{translated}/{total}',
} as const satisfies Record<string, string>
