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

import type { languageManagerEn } from '../en/languageManager'

/** German language-manager + editor translations. */
export const languageManagerDe: Record<keyof typeof languageManagerEn, string> = {
  'langManager.manageEntry': 'Sprachen verwalten…',
  'langManager.manageDetail': 'Erstellen, bearbeiten, importieren, exportieren',
  'langManager.title': 'Sprachen verwalten',
  'langManager.builtinBadge': 'Integriert',
  'langManager.customBadge': 'Benutzerdefiniert',
  'langManager.progress': '{translated} von {total} übersetzt',
  'langManager.activeBadge': 'Aktiv',
  'langManager.use': 'Diese Sprache verwenden',
  'langManager.duplicate': 'Duplizieren & bearbeiten',
  'langManager.duplicateHint': 'Beim Duplizieren von Englisch beginnt eine neue Sprache von Grund auf; beim Duplizieren jeder anderen Sprache wird von deren Übersetzungen ausgegangen.',
  'langManager.edit': 'Bearbeiten',
  'langManager.rename': 'Umbenennen',
  'langManager.renameLabel': 'Sprachname',
  'langManager.saveName': 'Namen speichern',
  'langManager.export': 'Sprache exportieren',
  'langManager.import': 'Sprache importieren',
  'langManager.delete': 'Sprache löschen',
  'langManager.done': 'Fertig',
  'langManager.close': 'Schließen',
  'langManager.baseLabel': 'Basiert auf',
  'langManager.tagLabel': 'Sprach-Tag',
  'langManager.importFailed': 'Import fehlgeschlagen: {error}',
  'langManager.imported': '„{name}" importiert.',
  'langManager.importPlaceholderIssues.one': '„{name}" mit {count} Platzhalter-Abweichung importiert – zum Prüfen den Editor öffnen.',
  'langManager.importPlaceholderIssues.other': '„{name}" mit {count} Platzhalter-Abweichungen importiert – zum Prüfen den Editor öffnen.',
  'langManager.deleted': '„{name}" gelöscht.',

  'langEditor.title': 'Sprache bearbeiten – {name}',
  'langEditor.nameLabel': 'Sprachname',
  'langEditor.tagLabel': 'BCP-47-Sprach-Tag',
  'langEditor.tagHint': 'Steuert das Dokument-Sprachattribut und die Pluralregeln (z. B. „de", „pt-BR").',
  'langEditor.tagInvalid': 'Geben Sie ein gültiges BCP-47-Tag wie „de" oder „pt-BR" ein.',
  'langEditor.progress': '{translated} / {total} übersetzt',
  'langEditor.searchPlaceholder': 'Schlüssel und Text suchen…',
  'langEditor.filterLabel': 'Anzeigen',
  'langEditor.filterAll': 'Alle Texte',
  'langEditor.filterUntranslated': 'Nur unübersetzte',
  'langEditor.filterEdited': 'Nur bearbeitete',
  'langEditor.sourceLabel': 'Englisch',
  'langEditor.baseLabel': 'Basis ({base})',
  'langEditor.inputPlaceholder': 'Unübersetzt – greift auf die Basissprache zurück',
  'langEditor.placeholderIssue': 'Platzhalter müssen exakt der englischen Quelle entsprechen: erwartet {expected}.',
  'langEditor.placeholderIssuesBlockApply.one': '{count} Übersetzung hat eine Platzhalter-Abweichung – vor dem Anwenden beheben.',
  'langEditor.placeholderIssuesBlockApply.other': '{count} Übersetzungen haben Platzhalter-Abweichungen – vor dem Anwenden beheben.',
  'langEditor.resetKey': 'Zurücksetzen',
  'langEditor.preview': 'In der App ansehen',
  'langEditor.previewing': 'Vorschau – Abbrechen stellt die gespeicherte Version wieder her',
  'langEditor.apply': 'Anwenden',
  'langEditor.cancel': 'Abbrechen',
  'langEditor.noMatches': 'Keine Texte entsprechen der aktuellen Suche und Filterung.',
  'langEditor.sectionCount': '{translated}/{total}',
}
