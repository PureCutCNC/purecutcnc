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

import type { themeManagerEn } from '../en/themeManager'

/**
 * German theme-manager / editor / preview translations. Built-in theme NAMES
 * ("Dark", "Light") and the token/group/contrast labels are registry data and
 * stay English, exactly as in the English catalog. "Theme" is rendered as
 * "Farbschema" to avoid clashing with "Design" (the drawing).
 */
export const themeManagerDe: Record<keyof typeof themeManagerEn, string> = {
  'themeManager.dialogAria': 'Farbschemata verwalten',
  'themeManager.title': 'Farbschemata verwalten',
  'themeManager.close': 'Schließen',
  'themeManager.listAria': 'Farbschemata',
  'themeManager.builtinBadge': 'Integriert',
  'themeManager.customBadge': 'Benutzerdefiniert',
  'themeManager.activeBadge': 'Aktiv',
  'themeManager.nameLabel': 'Name des Farbschemas',
  'themeManager.saveName': 'Namen speichern',
  'themeManager.familyLabel': 'Familie',
  'themeManager.basedOnLabel': 'Basiert auf',
  'themeManager.changedColorsLabel': 'Geänderte Farben',
  'themeManager.builtinHint': 'Integrierte Farbschemata sind schreibgeschützt. Duplizieren Sie eines, um eine bearbeitbare Kopie zu erstellen.',
  'themeManager.resetNotice': '„{name}" auf die Basisfarben von {base} zurückgesetzt.',
  'themeManager.importFailed': 'Import fehlgeschlagen: {error}',
  'themeManager.imported': '„{name}" importiert.',
  'themeManager.use': 'Dieses Farbschema verwenden',
  'themeManager.edit': 'Bearbeiten',
  'themeManager.duplicateToEdit': 'Zum Bearbeiten duplizieren',
  'themeManager.duplicate': 'Duplizieren',
  'themeManager.rename': 'Umbenennen',
  'themeManager.resetToBase': 'Auf Basis zurücksetzen',
  'themeManager.import': 'Farbschema importieren',
  'themeManager.export': 'Farbschema exportieren',
  'themeManager.delete': 'Farbschema löschen',
  'themeManager.systemAria': 'System-Modus-Kopplung',
  'themeManager.modeTitle': 'Modus',
  'themeManager.fixedMode': 'Festes Farbschema',
  'themeManager.systemMode': 'System-Hell/Dunkel folgen',
  'themeManager.lightSlot': 'Helles Farbschema',
  'themeManager.darkSlot': 'Dunkles Farbschema',
  'themeManager.systemPrefersDark': 'Dieses Gerät bevorzugt derzeit Dunkel.',
  'themeManager.systemPrefersLight': 'Dieses Gerät bevorzugt derzeit Hell.',
  'themeManager.done': 'Fertig',

  'themeEditor.title': 'Farbschema bearbeiten',
  'themeEditor.dialogAria': 'Farbschema {name} bearbeiten',
  'themeEditor.previewingLive': 'Ihre Änderungen werden live in der Vorschau angezeigt.',
  'themeEditor.colorsWrong': 'Sehen die Farben falsch aus?',
  'themeEditor.restoreSaved': 'Gespeicherte Farben wiederherstellen',
  'themeEditor.basedOn.one': 'Basiert auf {base} · {count} Farbe geändert',
  'themeEditor.basedOn.other': 'Basiert auf {base} · {count} Farben geändert',
  'themeEditor.contrastAria': 'Kontrastprüfungen',
  'themeEditor.contrastTitle': 'Lesbarkeitsprüfungen',
  'themeEditor.allChecksPass': 'Alle {count} Prüfungen bestanden.',
  'themeEditor.blockedLabel': 'Blockiert:',
  'themeEditor.warningLabel': 'Warnung:',
  'themeEditor.ratioNeeds': '{measured}:1, benötigt {required}:1',
  'themeEditor.deltaNeeds': 'ΔE {measured}, benötigt {required}',
  'themeEditor.ratioRecommended': '{measured}:1, empfohlen {required}:1',
  'themeEditor.deltaRecommended': 'ΔE {measured}, empfohlen {required}',
  'themeEditor.contrastNote': 'Automatische Stichproben repräsentativer Zustände – keine vollständige WCAG-Abdeckung.',
  'themeEditor.checksFailing.one': '{count} Lesbarkeitsprüfung fehlgeschlagen',
  'themeEditor.checksFailing.other': '{count} Lesbarkeitsprüfungen fehlgeschlagen',
  'themeEditor.cancel': 'Abbrechen',
  'themeEditor.apply': 'Farbschema anwenden',
  'themeEditor.fixBlockedTitle': 'Beheben Sie die blockierten Lesbarkeitsprüfungen vor dem Anwenden',
  'themeEditor.giveNameTitle': 'Geben Sie dem Farbschema einen Namen',
  'themeEditor.colorPickerAria': 'Farbwähler für {label}',
  'themeEditor.baseValueTitle': 'Basiswert: {value}',
  'themeEditor.resetFieldAria': '{label} auf Basiswert zurücksetzen',
  'themeEditor.resetFieldTitle': 'Auf Basis zurücksetzen ({value})',

  'themePreview.panelTitle': 'Bereich & Text',
  'themePreview.panelText': 'Primärtext auf einer Bereichsfläche.',
  'themePreview.panelTextDim': 'Gedämpfter Hinweistext für Tipps.',
  'themePreview.controlsTitle': 'Bedienelemente',
  'themePreview.primary': 'Primär',
  'themePreview.secondary': 'Sekundär',
  'themePreview.disabled': 'Deaktiviert',
  'themePreview.selectedItem': 'Ausgewähltes Element',
  'themePreview.focusedControl': 'Fokussiertes Bedienelement',
  'themePreview.messagesTitle': 'Meldungen',
  'themePreview.positive': 'Positiv: Werkzeugweg erzeugt.',
  'themePreview.warning': 'Warnung: geringe Zustelltiefe.',
  'themePreview.danger': 'Gefahr: Kollision mit Spannzwinge erkannt.',
  'themePreview.canvasTitle': 'Skizzen-Zeichenfläche',
  'themePreview.legendLine': 'Linie',
  'themePreview.legendRegion': 'Bereich',
  'themePreview.legendConstruction': 'Konstr.',
  'themePreview.legendAdd': 'Hinzufügen',
  'themePreview.legendCut': 'Schnitt',
}
