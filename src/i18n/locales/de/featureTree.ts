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

import type { featureTreeEn } from '../en/featureTree'

/** German feature-tree / properties / context-menu translations. */
export const featureTreeDe: Record<keyof typeof featureTreeEn, string> = {
  // ── Tree section labels ──
  'featureTree.tree.project': 'Projekt',
  'featureTree.tree.grid': 'Raster',
  'featureTree.tree.stock': 'Rohteil',
  'featureTree.tree.origin': 'Nullpunkt',
  'featureTree.tree.backdrop': 'Hintergrund',
  'featureTree.tree.features': 'Features',
  'featureTree.tree.regions': 'Bereiche',
  'featureTree.tree.construction': 'Konstruktion',
  'featureTree.tree.tabs': 'Haltestege',
  'featureTree.tree.clamps': 'Spannzwingen',

  // ── Tree branch abbreviations ──
  'featureTree.tree.branch.project': 'proj',
  'featureTree.tree.branch.grid': 'rast',
  'featureTree.tree.branch.stock': 'root',
  'featureTree.tree.branch.origin': 'null',
  'featureTree.tree.branch.backdrop': 'hint',
  'featureTree.tree.branch.features': 'feat',
  'featureTree.tree.branch.regions': 'ber',
  'featureTree.tree.branch.construction': 'knst',
  'featureTree.tree.branch.tabs': 'root',
  'featureTree.tree.branch.clamps': 'span',
  'featureTree.tree.branch.tab': 'node',
  'featureTree.tree.branch.clamp': 'node',
  'featureTree.tree.branch.feature': 'node',

  // ── Tree empty states ──
  'featureTree.tree.empty.features': 'Noch keine Feature-Knoten.',
  'featureTree.tree.empty.regions': 'Noch keine Bereiche.',
  'featureTree.tree.empty.construction': 'Noch keine Konstruktionsgeometrie.',
  'featureTree.tree.empty.tabs': 'Noch keine Haltestege.',
  'featureTree.tree.empty.clamps': 'Noch keine Spannzwingen.',
  'featureTree.tree.empty.folder': 'Leerer Ordner.',

  // ── Tree warning ──
  'featureTree.tree.warning.firstFeaturePrefix': '⚠ Erstes 2.5D-Feature muss ',
  'featureTree.tree.warning.firstFeatureSuffix': ' sein. Das 3D-Modell wird erst erstellt, wenn dies behoben ist.',

  // ── TreeRow: folder chevron ──
  'featureTree.treeRow.folder.expand': 'Ordner ausklappen',
  'featureTree.treeRow.folder.collapse': 'Ordner einklappen',

  // ── TreeRow: drag grip ──
  'featureTree.treeRow.grip.dragToReorder': 'Zum Umsortieren ziehen',

  // ── TreeRow: region badge ──
  'featureTree.treeRow.badge.region.include': 'inkl.',
  'featureTree.treeRow.badge.region.exclude': 'exkl.',
  'featureTree.treeRow.badge.region.includeTooltip': 'Bereich einschließen – fügt diese Fläche zur aktiven Bereichsmaske hinzu.',
  'featureTree.treeRow.badge.region.excludeTooltip': 'Bereich ausschließen – zieht diese Fläche von der aktiven Bereichsmaske ab.',

  // ── TreeRow: construction badge ──
  'featureTree.treeRow.badge.construction.label': 'Ref',
  'featureTree.treeRow.badge.construction.tooltip': 'Konstruktion – Skizzen-Referenzgeometrie. Daran fangen, spiegeln und bemaßen; wird nie bearbeitet.',

  // ── TreeRow: linked-instance badge ──
  'featureTree.treeRow.badge.linked': 'Verknüpft – {count} Instanzen teilen sich diese Definition',

  // ── TreeRow: show / hide all ──
  'featureTree.treeRow.showAll.features': 'Alle Features anzeigen',
  'featureTree.treeRow.showAll.regions': 'Alle Bereiche anzeigen',
  'featureTree.treeRow.showAll.construction': 'Gesamte Konstruktionsgeometrie anzeigen',
  'featureTree.treeRow.showAll.tabs': 'Alle Haltestege anzeigen',
  'featureTree.treeRow.showAll.clamps': 'Alle Spannzwingen anzeigen',
  'featureTree.treeRow.hideAll.features': 'Alle Features ausblenden',
  'featureTree.treeRow.hideAll.regions': 'Alle Bereiche ausblenden',
  'featureTree.treeRow.hideAll.construction': 'Gesamte Konstruktionsgeometrie ausblenden',
  'featureTree.treeRow.hideAll.tabs': 'Alle Haltestege ausblenden',
  'featureTree.treeRow.hideAll.clamps': 'Alle Spannzwingen ausblenden',

  // ── TreeRow: add folder ──
  'featureTree.treeRow.addFolder.default': 'Ordner hinzufügen',
  'featureTree.treeRow.addFolder.regions': 'Bereichsordner hinzufügen',
  'featureTree.treeRow.addFolder.construction': 'Konstruktionsordner hinzufügen',

  // ── TreeRow: add entry (tab / clamp) ──
  'featureTree.treeRow.addEntry.tab': 'Haltesteg hinzufügen',
  'featureTree.treeRow.addEntry.clamp': 'Spannzwinge hinzufügen',

  // ── TreeRow: operation button tooltips ──
  'featureTree.treeRow.operation.lineClosedTooltip': 'Linie – geschlossener Pfad, nutzbar für Gravieren, Kontur und V-Gravur',
  'featureTree.treeRow.operation.lineOpenTooltip': 'Linie – offenes Profil (nur Linie ↔ Konstruktion)',
  'featureTree.treeRow.operation.modelTooltip': 'Modell – importiertes 3D-Objekt (gesperrt)',
  'featureTree.treeRow.operation.addFirstSolidTooltip': 'Hinzufügen – erster Körper (Abziehen nicht verfügbar; in eine Nicht-Körper-Rolle umwandeln, um es freizugeben)',
  'featureTree.treeRow.operation.addTooltip': 'Feature fügt Material hinzu',
  'featureTree.treeRow.operation.subtractTooltip': 'Feature zieht Material ab',
  'featureTree.treeRow.operation.constructionTooltip': 'Konstruktion – Skizzen-Referenzgeometrie (wird nie bearbeitet)',
  'featureTree.treeRow.operation.regionTooltip': 'Bereich – begrenzt, wo Operationen schneiden dürfen (wird nicht bearbeitet)',
  'featureTree.treeRow.operation.modelLockedAria': 'Modell – Operation gesperrt',
  'featureTree.treeRow.operation.changeAria': 'Operation ändern',

  // ── TreeRow: operation menu item labels ──
  'featureTree.operation.add': 'Hinzufügen',
  'featureTree.operation.subtract': 'Abziehen',
  'featureTree.operation.line': 'Linie',
  'featureTree.operation.region': 'Bereichsmaske',
  'featureTree.operation.construction': 'Konstruktion',

  // ── TreeRow: operation menu item tooltips ──
  'featureTree.treeRow.operation.menuLineOpenTooltip': 'Linie – offener Pfad, bearbeitet durch Gravier-Operationen',
  'featureTree.treeRow.operation.menuAddTooltip': 'Hinzufügen – Feature fügt Material hinzu',
  'featureTree.treeRow.operation.menuSubtractTooltip': 'Abziehen – Feature entfernt Material',
  'featureTree.treeRow.operation.menuSubtractDisabledTooltip': 'Abziehen nicht verfügbar – der erste Körper muss „Hinzufügen" sein oder in eine Nicht-Körper-Rolle umgewandelt werden',
  'featureTree.treeRow.operation.menuLineClosedTooltip': 'Linie – geschlossener Pfad, bearbeitet durch Gravier-/Kontur-Operationen',
  'featureTree.treeRow.operation.menuRegionTooltip': 'Bereichsmaske – Feature filtert Bearbeitungsoperationen',
  'featureTree.treeRow.operation.menuConstructionTooltip': 'Konstruktion – Skizzen-Referenzgeometrie, wird nie bearbeitet',

  // ── TreeRow: other buttons ──
  'featureTree.treeRow.selectAllInFolder': 'Alle Features im Ordner auswählen',
  'featureTree.treeRow.group': 'Features gruppieren',
  'featureTree.treeRow.ungroup': 'Gruppierung der Features aufheben',
  'featureTree.treeRow.editSketch': 'Skizze bearbeiten',
  'featureTree.treeRow.moreActions': 'Weitere Aktionen',
  'featureTree.treeRow.hideEntry': 'Eintrag ausblenden',
  'featureTree.treeRow.showEntry': 'Eintrag anzeigen',

  // ── Properties: common field labels ──
  'featureTree.properties.name': 'Name',
  'featureTree.properties.units': 'Einheiten',
  'featureTree.properties.width': 'Breite',
  'featureTree.properties.height': 'Höhe',
  'featureTree.properties.thickness': 'Dicke',
  'featureTree.properties.color': 'Farbe',
  'featureTree.properties.visible': 'Sichtbar',
  'featureTree.properties.locked': 'Gesperrt',
  'featureTree.properties.z': 'Z',
  'featureTree.properties.zTop': 'Z oben',
  'featureTree.properties.zBottom': 'Z unten',
  'featureTree.properties.zRange': 'Z-Bereich',
  'featureTree.properties.image': 'Bild',
  'featureTree.properties.opacity': 'Deckkraft',
  'featureTree.properties.angle': 'Winkel',
  'featureTree.properties.folder': 'Ordner',
  'featureTree.properties.folders': 'Ordner',
  'featureTree.properties.features': 'Features',
  'featureTree.properties.clamps': 'Spannzwingen',
  'featureTree.properties.tabs': 'Haltestege',
  'featureTree.properties.operation': 'Operation',
  'featureTree.properties.selection': 'Auswahl',
  'featureTree.properties.editSketch': 'Skizze bearbeiten',
  'featureTree.properties.text': 'Text',
  'featureTree.properties.style': 'Stil',
  'featureTree.properties.font': 'Schriftart',
  'featureTree.properties.sourceFeature': 'Quell-Feature',
  'featureTree.properties.expanded': 'Erweitert',

  // ── Properties: project-specific ──
  'featureTree.properties.safeZ': 'Sicheres Z',
  'featureTree.properties.opClearZ': 'Op-Freifahr-Z',
  'featureTree.properties.clampClearXY': 'Spannzwingen-Freiraum XY',
  'featureTree.properties.clampClearZ': 'Spannzwingen-Freiraum Z',
  'featureTree.properties.machine': 'Maschine',
  'featureTree.properties.gridExtent': 'Rasterausdehnung',
  'featureTree.properties.majorLines': 'Hauptlinien',
  'featureTree.properties.minorLines': 'Nebenlinien',
  'featureTree.properties.snapIncrement': 'Fangschritt',
  'featureTree.properties.showFeatureInfo': 'Feature-Infos in Skizze anzeigen',

  // ── Properties: units ──
  'featureTree.properties.units.mm': 'Millimeter',
  'featureTree.properties.units.inch': 'Zoll',

  // ── Properties: machine ──
  'featureTree.properties.machine.none': 'Keine',
  'featureTree.properties.machine.refresh': 'Maschinendefinitionen aktualisieren',
  'featureTree.properties.machine.manage': 'Maschinen verwalten…',
  'featureTree.properties.machine.builtin': 'Integriert',
  'featureTree.properties.machine.custom': 'Benutzerdefiniert',
  'featureTree.properties.machine.duplicateHint': 'zum Bearbeiten duplizieren',

  // ── Properties: origin ──
  'featureTree.properties.origin.placeOrigin': 'Nullpunkt setzen',
  'featureTree.properties.origin.presets': 'Voreinstellungen',
  'featureTree.properties.origin.topLeft': 'Oben links',
  'featureTree.properties.origin.centerTop': 'Oben Mitte',
  'featureTree.properties.origin.bottomLeft': 'Unten links',

  // ── Properties: stock ──
  'featureTree.properties.stock.editSketch': 'Skizze bearbeiten',
  'featureTree.properties.stock.resetToRect': 'Auf Rechteck zurücksetzen',
  'featureTree.properties.stock.nameDisabled': 'Rohteil',

  // ── Properties: backdrop ──
  'featureTree.properties.backdrop.noImage': 'Kein Bild geladen',
  'featureTree.properties.backdrop.loadImage': 'Bild laden',
  'featureTree.properties.backdrop.replaceImage': 'Bild ersetzen',
  'featureTree.properties.backdrop.loading': 'Bild wird geladen…',
  'featureTree.properties.backdrop.move': 'Verschieben',
  'featureTree.properties.backdrop.resize': 'Größe ändern',
  'featureTree.properties.backdrop.rotate': 'Drehen',
  'featureTree.properties.backdrop.delete': 'Löschen',
  'featureTree.properties.backdrop.decoding': 'Hintergrundbild wird dekodiert…',
  'featureTree.properties.backdrop.mustBeImage': 'Der Hintergrund muss ein PNG- oder JPEG-Bild sein.',
  'featureTree.properties.backdrop.readFailed': 'Hintergrundbild konnte nicht gelesen werden.',
  'featureTree.properties.backdrop.decodeFailed': 'Hintergrundbild konnte nicht dekodiert werden.',

  // ── Properties: single feature ──
  'featureTree.properties.shape': 'Form',
  'featureTree.properties.shapeShared.one': 'Form (geteilt mit {count} Instanz)',
  'featureTree.properties.shapeShared.other': 'Form (geteilt mit {count} Instanzen)',
  'featureTree.properties.instance': 'Instanz',
  'featureTree.properties.expandText': 'Text in Features umwandeln',
  'featureTree.properties.makeUnique': 'Eindeutig machen',
  'featureTree.properties.deleteFeature': 'Feature löschen',
  'featureTree.properties.deleteSelected': 'Auswahl löschen',
  'featureTree.properties.editSketchDisabledMulti': 'Bei Mehrfachauswahl deaktiviert',

  // ── Properties: multi-select ──
  'featureTree.properties.multi.group': 'Gruppieren',
  'featureTree.properties.multi.ungroup': 'Gruppierung aufheben',
  'featureTree.properties.multi.deleteGroup': 'Gruppe löschen',
  'featureTree.properties.multi.featuresCount': '{count} Features',
  'featureTree.properties.multi.editSketchDisabled': 'Skizze bearbeiten ist nur für ein einzelnes Feature verfügbar',
  'featureTree.properties.multi.openProfiles': 'Offene Profile',
  'featureTree.properties.multi.containsModel': 'Enthält Modell-Features',
  'featureTree.properties.multi.modelLockedTooltip': 'Modell-Einträge können hier den Operationstyp nicht ändern',

  // ── Properties: select values ──
  'featureTree.properties.select.mixedFolders': 'Gemischte Ordner',
  'featureTree.properties.select.root': 'Wurzel',
  'featureTree.properties.select.mixedOperations': 'Gemischte Operationen',
  'featureTree.properties.select.mixedModes': 'Gemischte Modi',
  'featureTree.properties.select.mixedValues': 'Gemischte Werte',

  // ── Properties: operation select ──
  'featureTree.properties.operation.subtract': 'Abziehen',
  'featureTree.properties.operation.add': 'Hinzufügen',
  'featureTree.properties.operation.line': 'Linie',
  'featureTree.properties.operation.region': 'Bereichsmaske',
  'featureTree.properties.operation.construction': 'Konstruktion',
  'featureTree.properties.operation.model': 'Modell',
  'featureTree.properties.operation.modelLockedTooltip': 'Modell-Features sind importierte 3D-Objekte und können den Operationstyp nicht ändern',

  // ── Properties: mask mode ──
  'featureTree.properties.maskMode': 'Maskenmodus',
  'featureTree.properties.maskMode.include': 'Einschließen',
  'featureTree.properties.maskMode.exclude': 'Ausschließen',

  // ── Properties: text feature ──
  'featureTree.properties.text.skeleton': 'Skelett',
  'featureTree.properties.text.outline': 'Umriss',

  // ── Properties: Z locked fields ──
  'featureTree.properties.z.notMachined': 'Wird nicht bearbeitet',
  'featureTree.properties.z.notMachinedTooltip': 'Konstruktionsgeometrie ist eine Skizzenreferenz – sie hat keine Bearbeitungstiefe',
  'featureTree.properties.z.followsStock': 'Folgt dem Rohteil ({thickness} bis 0)',
  'featureTree.properties.z.followsStockTooltip': 'Bereiche sind vertikale Filter durch das Rohteil; ihr Z-Bereich folgt automatisch dem Rohteil',

  // ── Properties: role notes ──
  'featureTree.properties.regionNote.badge': 'Maske',
  'featureTree.properties.regionNote.text': 'Ein Bereich ist ein Filter: Er begrenzt, wo Operationen schneiden dürfen – keine Form zum Bearbeiten.',
  'featureTree.properties.constructionNote.badge': 'Ref',
  'featureTree.properties.constructionNote.text': 'Konstruktionsgeometrie ist eine Skizzenreferenz: Daran fangen, spiegeln und bemaßen. Sie wird nie bearbeitet.',

  // ── Properties: warnings ──
  'featureTree.properties.warning.selfIntersect': 'Dieses Profil schneidet sich selbst. 3D-/CAM-Ergebnisse können ungültig sein.',
  'featureTree.properties.warning.exceedsStock': 'Dieses Profil ragt über die Rohteilgrenze hinaus.',

  // ── Properties: constraints ──
  'featureTree.properties.constraints.title': 'Bedingungen',
  'featureTree.properties.constraints.delete': 'Bedingung löschen',
  'featureTree.properties.constraints.type.intersect': 'Schnitt',
  'featureTree.properties.constraints.type.perp': 'Lot',
  'featureTree.properties.constraints.type.line': 'Linie',
  'featureTree.properties.constraints.type.midpt': 'Mitte',
  'featureTree.properties.constraints.type.center': 'Zentr.',
  'featureTree.properties.constraints.type.point': 'Punkt',
  'featureTree.properties.constraints.tooltip.distanceIntersection': 'Abstand zum Schnittpunkt',
  'featureTree.properties.constraints.tooltip.perpendicularSegment': 'Senkrechter Abstand zum Segment',
  'featureTree.properties.constraints.tooltip.pointOnSegment': 'Abstand zum Punkt auf dem Segment ({percent} %)',
  'featureTree.properties.constraints.tooltip.segmentMidpoint': 'Abstand zum Segmentmittelpunkt',
  'featureTree.properties.constraints.tooltip.featureCenter': 'Abstand zum Feature-Zentrum',
  'featureTree.properties.constraints.tooltip.distanceVertex': 'Abstand zum Scheitelpunkt',
  'featureTree.properties.constraints.tooltip.invalid': 'Ungültig',
  'featureTree.properties.constraints.world': 'Welt',

  // ── Properties: empty state ──
  'featureTree.properties.empty': 'Wählen Sie Projekt, Raster, Rohteil oder ein Feature im Baum, um dessen Eigenschaften zu bearbeiten.',

  // ── Properties: name disabled placeholders ──
  'featureTree.properties.name.grid': 'Raster',
  'featureTree.properties.name.features': 'Features',
  'featureTree.properties.name.clamps': 'Spannzwingen',
  'featureTree.properties.name.tabs': 'Haltestege',

  // ── Properties: actions (folder/clamp/tab) ──
  'featureTree.properties.actions.addFolder': 'Ordner hinzufügen',
  'featureTree.properties.actions.addTab': 'Haltesteg hinzufügen',
  'featureTree.properties.actions.addClamp': 'Spannzwinge hinzufügen',
  'featureTree.properties.actions.deleteFolder': 'Ordner löschen',
  'featureTree.properties.actions.deleteClamp': 'Spannzwinge löschen',
  'featureTree.properties.actions.deleteTab': 'Haltesteg löschen',

  // ── Context menu: top-level items ──
  'featureTree.contextMenu.makeUnique': 'Eindeutig machen',
  'featureTree.contextMenu.selectLinked': 'Verknüpfte Instanzen auswählen',
  'featureTree.contextMenu.createOperation': 'Operation erstellen',
  'featureTree.contextMenu.editSketch': 'Skizze bearbeiten',
  'featureTree.contextMenu.addConstraint': 'Bedingung hinzufügen',
  'featureTree.contextMenu.copy': 'Kopieren',
  'featureTree.contextMenu.copySelected': 'Auswahl kopieren',
  'featureTree.contextMenu.copyGroup': 'Gruppe kopieren',
  'featureTree.contextMenu.move': 'Verschieben',
  'featureTree.contextMenu.moveSelected': 'Auswahl verschieben',
  'featureTree.contextMenu.moveGroup': 'Gruppe verschieben',
  'featureTree.contextMenu.resize': 'Größe ändern',
  'featureTree.contextMenu.rotate': 'Drehen',
  'featureTree.contextMenu.mirror': 'Spiegeln',
  'featureTree.contextMenu.offset': 'Offset',
  'featureTree.contextMenu.addToFolder': 'Zu Ordner hinzufügen',
  'featureTree.contextMenu.createNewFolder': 'Neu erstellen…',
  'featureTree.contextMenu.group': 'Gruppieren',
  'featureTree.contextMenu.join': 'Vereinigen',
  'featureTree.contextMenu.cut': 'Abziehen',
  'featureTree.contextMenu.useAsStock': 'Als Rohteil verwenden',
  'featureTree.contextMenu.delete': 'Löschen',
  'featureTree.contextMenu.deleteSelected': 'Auswahl löschen',
  'featureTree.contextMenu.deleteGroup': 'Gruppe löschen',

  // ── Context menu: tooltips ──
  'featureTree.contextMenu.lockedTooltip': 'Gesperrte Features können nicht verschoben werden',
  'featureTree.contextMenu.groupDisabledTooltip': 'Wählen Sie zwei oder mehr Features zum Gruppieren aus',
  'featureTree.contextMenu.sectionsMixedTooltip': 'Features, Bereiche und Konstruktionsgeometrie lassen sich nur mit ihrer eigenen Art gruppieren',
  'featureTree.contextMenu.addToFolderMixedTooltip': 'Features, Bereiche und Konstruktionsgeometrie behalten getrennte Ordner – wählen Sie eine Art',
  'featureTree.contextMenu.joinDisabledTooltip': 'Wählen Sie zwei oder mehr Features zum Vereinigen aus',
  'featureTree.contextMenu.useAsStockDisabledTooltip': 'Feature muss eine Hinzufügen-Operation mit geschlossenem Profil sein',

  // ── Z-range slider ──
  'featureTree.zRange.zTop': 'Z oben',
  'featureTree.zRange.zBottom': 'Z unten',
  'featureTree.zRange.handleTopAria': 'Griff Z oben',
  'featureTree.zRange.handleBottomAria': 'Griff Z unten',
}
