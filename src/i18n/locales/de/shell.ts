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

import type { shellEn } from '../en/shell'

/**
 * German app-shell translations. Typed as a complete record of the English
 * shell module's keys, so adding an English key without its German translation
 * is a compile error. Terminology follows `src/i18n/GLOSSARY.md`; German
 * inflects, so `.one` (count === 1) and `.other` take distinct plural forms.
 */
export const shellDe: Record<keyof typeof shellEn, string> = {
  'file.newProject': 'Neues Projekt',
  'file.openProject': 'Projekt öffnen',
  'file.importGeometry': 'Geometrie importieren',
  'file.exportModel': 'Modell exportieren',
  'file.printDesign': 'Design drucken',
  'file.saveProject': 'Projekt speichern',
  'file.saveProjectDirty': 'Projekt mit nicht gespeicherten Änderungen speichern',
  'file.undo': 'Rückgängig',
  'file.redo': 'Wiederholen',

  'shell.topBar.openProjectPanel': 'Projektbereich öffnen',
  'shell.topBar.openOperationsPanel': 'Operationsbereich öffnen',
  'shell.topBar.operations': 'Operationen',
  'shell.topBar.renameProject': 'Projekt umbenennen',
  'shell.topBar.saved': 'Gespeichert',
  'shell.topBar.unsaved': 'Nicht gespeichert',
  'shell.topBar.savedTitle': 'Projekt ist gespeichert',
  'shell.topBar.unsavedTitle': 'Projekt hat nicht gespeicherte Änderungen',
  'shell.topBar.projectLabel': 'Projekt',
  'shell.topBar.tabSketch': 'Skizze',
  'shell.topBar.tab3d': '3D',
  'shell.topBar.tabSim': 'Sim',
  'shell.topBar.zoomToModel': 'Auf Modell zoomen',
  'shell.topBar.zoomSelected': 'Auswahl zoomen',
  'shell.topBar.cancelZoomSelected': 'Auswahl-Zoom abbrechen',

  'shell.snap.enable': 'Fang aktivieren',
  'shell.snap.disable': 'Fang deaktivieren',
  'shell.snap.settingsTooltip': 'Fang-Einstellungen',
  'shell.snap.enabledAria.one': 'Fang aktiviert ({count} Modus)',
  'shell.snap.enabledAria.other': 'Fang aktiviert ({count} Modi)',
  'shell.snap.disabledAria': 'Fang deaktiviert',
  'shell.snap.enabledButton': 'Aktiviert',
  'shell.snap.disabledButton': 'Deaktiviert',
  'shell.snap.grid': 'Am Raster fangen',
  'shell.snap.gridShort': 'Raster',
  'shell.snap.point': 'An Punkt fangen',
  'shell.snap.pointShort': 'Punkt',
  'shell.snap.line': 'An Linie fangen',
  'shell.snap.lineShort': 'Linie',
  'shell.snap.midpoint': 'An Mittelpunkt fangen',
  'shell.snap.midpointShort': 'Mittelpunkt',
  'shell.snap.center': 'An Zentrum fangen',
  'shell.snap.centerShort': 'Zentrum',
  'shell.snap.intersection': 'An Schnittpunkt fangen',
  'shell.snap.intersectionShort': 'Schnittpunkt',
  'shell.snap.perpendicular': 'Lot fangen',
  'shell.snap.perpendicularShort': 'Lot',

  'shell.measure.tooltip': 'Messen & Bemaßung',
  'shell.measure.aria': 'Messen und Bemaßung',
  'shell.measure.tapeMeasure': 'Maßband',
  'shell.measure.tapeMeasureOn': 'Maßband (aktiv)',
  'shell.measure.stopTapeMeasure': 'Maßband beenden',
  'shell.measure.addDimension': 'Bemaßung hinzufügen',
  'shell.measure.closeDimensionMenu': 'Bemaßungsmenü schließen',
  'shell.measure.cancelDimension': '{dimension} abbrechen',
  'shell.measure.dimAligned': 'Ausgerichtete Bemaßung',
  'shell.measure.dimHorizontal': 'Horizontale Bemaßung',
  'shell.measure.dimVertical': 'Vertikale Bemaßung',
  'shell.measure.dimRadius': 'Radiusbemaßung',
  'shell.measure.dimDiameter': 'Durchmesserbemaßung',
  'shell.measure.dimAngle': 'Winkelbemaßung',
  'shell.measure.deleteDimension': 'Bemaßung löschen',
  'shell.measure.deleteDimensionArmed': 'Bemaßung löschen (eine anklicken)',
  'shell.measure.deleteDimensionClickOne': 'Bemaßung zum Löschen anklicken',
  'shell.measure.showHideDimensions': 'Bemaßungen ein-/ausblenden',
  'shell.measure.showOrHideAria': 'Bemaßungen ein- oder ausblenden',
  'shell.measure.showDimensionsCount.one': 'Bemaßungen anzeigen ({count})',
  'shell.measure.showDimensionsCount.other': 'Bemaßungen anzeigen ({count})',
  'shell.measure.hideDimensionsCount.one': 'Bemaßungen ausblenden ({count})',
  'shell.measure.hideDimensionsCount.other': 'Bemaßungen ausblenden ({count})',

  'appearance.tooltip': 'Darstellung',
  'appearance.heading': 'Darstellung',
  'appearance.menuAria': 'Farbschema der Darstellung',
  'appearance.current': 'Darstellung: {name}',
  'appearance.darkLabel': 'Dunkel',
  'appearance.darkDetail': 'Werkstatt bei wenig Licht',
  'appearance.lightLabel': 'Hell',
  'appearance.lightDetail': 'Zeichenpapier',
  'appearance.systemLabel': 'System',
  'appearance.systemDetail': 'An dieses Gerät anpassen',
  'appearance.customThemesHeading': 'Eigene Farbschemata',
  'appearance.darkFamily': 'Dunkle Familie',
  'appearance.lightFamily': 'Helle Familie',
  'appearance.manageThemes': 'Farbschemata verwalten…',
  'appearance.manageThemesDetail': 'Erstellen, bearbeiten, importieren, exportieren',

  'language.tooltip': 'Sprache',
  'language.heading': 'Sprache',
  'language.menuAria': 'Oberflächensprache',
  'language.current': 'Sprache: {name}',
  'language.customHeading': 'Eigene Sprachen',

  'mobileBlocker.eyebrow': 'Nur Desktop-Browser',
  'mobileBlocker.title': 'PureCutCNC wird auf Telefonen nicht unterstützt.',
  'mobileBlocker.body': 'Die Browser-App ist für einen Arbeitsbereich in Desktop-Größe ausgelegt und funktioniert auf Telefon-Bildschirmen nicht gut. Verwenden Sie einen Desktop-Browser oder installieren Sie eine Desktop-Version für macOS, Windows oder Linux.',
  'mobileBlocker.downloads': 'Desktop-Downloads',
  'mobileBlocker.website': 'Projekt-Website',

  'platform.confirmDiscard': 'Sie haben nicht gespeicherte Änderungen. Verwerfen und fortfahren?',
  'platform.readProjectFailed': 'Projektdatei konnte nicht gelesen werden.',
  'platform.openProjectFailed': 'Projektdatei konnte nicht geöffnet werden.',
  'platform.readFileError': '„{name}" konnte nicht gelesen werden. Die Datei ist möglicherweise zu groß oder nicht zugänglich.',
}
