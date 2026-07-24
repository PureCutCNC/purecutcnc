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

import type { camEn } from '../en/cam'

/** German CAM operation / tool / add-menu / description translations. */
export const camDe: Record<keyof typeof camEn, string> = {
  // ── Tool type labels ──
  'cam.toolType.flatEndmill': 'Schaftfräser (flach)',
  'cam.toolType.ballEndmill': 'Kugelfräser',
  'cam.toolType.vBit': 'V-Nutfräser',
  'cam.toolType.drill': 'Bohrer',

  // ── Drill type labels ──
  'cam.drillType.simple': 'Einfach (G81)',
  'cam.drillType.peck': 'Tieflochbohren (G83)',
  'cam.drillType.dwell': 'Verweilen (G82)',
  'cam.drillType.chipBreaking': 'Spanbruch (G73)',

  // ── Operation kind labels (full, for the Kind field and operationValidity) ──
  'cam.opLabel.pocket': 'Tasche',
  'cam.opLabel.vCarve': 'V-Gravur Offset',
  'cam.opLabel.vCarveMedial': 'V-Gravur Mittelachse',
  'cam.opLabel.edgeRouteInside': 'Kontur innen',
  'cam.opLabel.edgeRouteOutside': 'Kontur außen',
  'cam.opLabel.surfaceClean': 'Oberfläche säubern',
  'cam.opLabel.roughSurface': '3D-Oberfläche schruppen',
  'cam.opLabel.finishSurface': '3D-Oberfläche schlichten',
  'cam.opLabel.finishSurfaceCleanup': '3D-Oberfläche nacharbeiten',
  'cam.opLabel.followLine': 'Gravieren',
  'cam.opLabel.drilling': 'Bohren',

  // ── Operation button labels (compact, for the Add menu) ──
  'cam.opButton.pocket': 'Tasche',
  'cam.opButton.vCarve': 'V-Gravur Offset',
  'cam.opButton.vCarveMedial': 'V-Gravur Mittelachse',
  'cam.opButton.edgeIn': 'Kontur innen',
  'cam.opButton.edgeOut': 'Kontur außen',
  'cam.opButton.surface': 'Oberfläche',
  'cam.opButton.roughSurface': '3D-Oberfläche schruppen',
  'cam.opButton.finishSurface': '3D-Oberfläche schlichten',
  'cam.opButton.finishSurfaceCleanup': '3D-Oberfläche nacharbeiten',
  'cam.opButton.engrave': 'Gravieren',
  'cam.opButton.drill': 'Bohren',

  // ── Quick operation labels ("Create …") ──
  'cam.quickOp.pocket': 'Tasche erstellen',
  'cam.quickOp.edgeRouteInside': 'Innenkontur erstellen',
  'cam.quickOp.edgeRouteOutside': 'Außenkontur erstellen',
  'cam.quickOp.vCarve': 'V-Gravur (Offset) erstellen',
  'cam.quickOp.vCarveMedial': 'V-Gravur (Mittelachse) erstellen',
  'cam.quickOp.surfaceClean': 'Oberflächensäuberung erstellen',
  'cam.quickOp.followLine': 'Gravur erstellen',
  'cam.quickOp.drilling': 'Bohrung erstellen',
  'cam.quickOp.roughSurface': 'Oberflächenschruppen erstellen',
  'cam.quickOp.finishSurface': 'Oberflächenschlichten erstellen',
  'cam.quickOp.finishSurfaceCleanup': 'Oberflächen-Nacharbeit erstellen',

  // ── Pocket pattern labels ──
  'cam.pocketPattern.offset': 'Offset',
  'cam.pocketPattern.parallel': 'Parallel',
  'cam.pocketPattern.waterline': 'Wasserlinie',

  // ── Pass labels ──
  'cam.pass.rough': 'Schruppen',
  'cam.pass.finish': 'Schlichten',

  // ── Panel chrome ──
  'cam.panel.emptyOperation': 'Wählen Sie eine Operation, um ihre Parameter zu bearbeiten.',
  'cam.panel.emptyTool': 'Wählen Sie ein Werkzeug, um seine Eigenschaften zu bearbeiten.',
  'cam.panel.operations': 'Operationen',
  'cam.panel.tools': 'Werkzeuge',
  'cam.panel.operationsEmpty':
    'Wählen Sie kompatible Geometrie, dann fügen Sie eine Operation hinzu. Tasche und Innenkontur erfordern Abzieh-Features. Außenkontur erfordert Hinzufügen-Features. Oberfläche säubern akzeptiert Hinzufügen-Features.',
  'cam.panel.cam': 'CAM',
  'cam.panel.properties': 'Eigenschaften',
  'cam.panel.export': 'Exportieren',
  'cam.panel.add': 'Hinzufügen',
  'cam.panel.addHint': 'Zuerst Geometrie auswählen, dann einen Operationstyp wählen',
  'cam.panel.showAllToolpaths': 'Alle Werkzeugwege anzeigen',
  'cam.panel.hideAllToolpaths': 'Alle Werkzeugwege ausblenden',
  'cam.panel.exportGcodeForOperation': 'G-Code für diese Operation exportieren',
  'cam.panel.exportGcodeForSelected': 'G-Code für ausgewählte Operation exportieren',
  'cam.panel.exportGcodeFor': 'G-Code für {name} exportieren',
  'cam.panel.expandOperationProps': 'Operationseigenschaften ausklappen',
  'cam.panel.expandToolProps': 'Werkzeugeigenschaften ausklappen',
  'cam.panel.operationProperties': 'Operationseigenschaften',
  'cam.panel.toolProperties': 'Werkzeugeigenschaften',
  'cam.panel.close': 'Schließen',

  // ── Operation property labels ──
  'cam.operation.name': 'Name',
  'cam.operation.description': 'Beschreibung',
  'cam.operation.kind': 'Art',
  'cam.operation.pass': 'Durchgang',
  'cam.operation.maxCarveDepth': 'Max. Gravurtiefe',
  'cam.operation.carveDepth': 'Gravurtiefe',
  'cam.operation.target': 'Ziel',
  'cam.operation.targetSource': 'Zielquelle',
  'cam.operation.useCurrentSelection': 'Aktuelle Auswahl verwenden',
  'cam.operation.targetUpdated': '✓ Ziel aktualisiert',
  'cam.operation.restMachining': 'Restbearbeitung',
  'cam.operation.createRestOp': 'Restoperation erstellen',
  'cam.operation.booklet': 'Broschüre',
  'cam.operation.exportPdf': 'PDF exportieren',
  'cam.operation.exporting': 'Wird exportiert…',
  'cam.operation.toolpathWarnings': 'Werkzeugweg-Warnungen',
  'cam.operation.tool': 'Werkzeug',
  'cam.operation.noTool': 'Kein Werkzeug',
  'cam.operation.enabled': 'Aktiviert',
  'cam.operation.stepdown': 'Zustellung',
  'cam.operation.contourSpacing': 'Konturabstand',
  'cam.operation.stepoverRatio': 'Bahnabstand-Verhältnis',
  'cam.operation.advanced': 'Erweitert',
  'cam.operation.pattern': 'Muster',
  'cam.operation.angle': 'Winkel',
  'cam.operation.cutDirection': 'Schnittrichtung',
  'cam.operation.conventional': 'Gegenlauf',
  'cam.operation.climb': 'Gleichlauf',
  'cam.operation.machiningOrder': 'Bearbeitungsreihenfolge',
  'cam.operation.featureFirst': 'Feature zuerst',
  'cam.operation.levelFirst': 'Ebene zuerst',
  'cam.operation.roundOutsideCorners': 'Ecken abrunden',
  'cam.operation.drillType': 'Bohrtyp',
  'cam.operation.peckDepth': 'Entspantiefe',
  'cam.operation.dwellTime': 'Verweilzeit (s)',
  'cam.operation.retractHeight': 'Rückzugshöhe',
  'cam.operation.finishWalls': 'Wände schlichten',
  'cam.operation.finishFloor': 'Boden schlichten',
  'cam.operation.debugToolpath': 'Werkzeugweg debuggen',
  'cam.operation.feed': 'Vorschub',
  'cam.operation.plungeFeed': 'Eintauchvorschub',
  'cam.operation.slotFeed': 'Nutvorschub (%)',
  'cam.operation.slotFeedTooltip':
    'Vorschub-Prozentsatz für voll im Eingriff befindliche (nutende) Schnitte: die innerste Schleife jedes Abschnitts, ungeräumte Übergänge, der parallele Randdurchgang und die erste Fülllinie. 100 deaktiviert die Reduzierung.',
  'cam.operation.rpm': 'Drehzahl',
  'cam.operation.stockToLeaveRadial': 'Aufmaß radial',
  'cam.operation.stockToLeaveAxial': 'Aufmaß axial',
  'cam.operation.adaptiveRefinement': 'Adaptive Verfeinerung',
  'cam.operation.adaptiveRefinementTooltip':
    'Fügt projizierte Wasserlinien-Ringe auf flachen Neigungen und Modellspitzen hinzu.',
  'cam.operation.adaptiveSpacing': 'Adaptiver Abstand',
  'cam.operation.adaptiveSpacingTooltip': 'Abstand der projizierten Ringe in Projekteinheiten.',
  'cam.operation.maxRingsBand': 'Max. Ringe / Band',
  'cam.operation.maxRingsTooltip':
    'Maximale Anzahl projizierter Ringe in einem Band oder einer Spitze. 0 für die Standardgrenze verwenden.',
  'cam.operation.tabs': 'Haltestege',
  'cam.operation.autoPlaceTabs': 'Haltestege automatisch platzieren',
  'cam.operation.arcFitting': 'Bogenanpassung (G2/G3)',
  'cam.operation.arcFittingTip':
    'Nur Export: Fasst aufeinanderfolgende lineare Bewegungen, die einen Kreisbogen annähern, zu G2/G3-Bögen zusammen, wenn die Steuerung dies unterstützt. Beeinflusst nicht den angezeigten oder simulierten Werkzeugweg.',

  // ── Region note ──
  'cam.regionNote.badge': 'Maske',
  'cam.regionNote.text': 'Bereiche begrenzen, wo diese Operation schneiden darf – keine Formen zum Bearbeiten.',

  // ── Operation target summary ──
  'cam.target.stock': 'Rohteil',
  'cam.target.noFeatures': 'Keine Features',
  'cam.target.noMachiningTarget': 'Kein Bearbeitungsziel',
  'cam.target.filters': '{machiningSummary}; Filter: {regionNames}',

  // ── Tool property labels ──
  'cam.tool.name': 'Name',
  'cam.tool.type': 'Typ',
  'cam.tool.units': 'Einheiten',
  'cam.tool.unitsMm': 'Millimeter',
  'cam.tool.unitsInch': 'Zoll',
  'cam.tool.diameter': 'Durchmesser',
  'cam.tool.vAngle': 'V-Winkel',
  'cam.tool.flutes': 'Schneiden',
  'cam.tool.material': 'Material',
  'cam.tool.materialCarbide': 'Hartmetall',
  'cam.tool.materialHss': 'HSS',
  'cam.tool.defaultRpm': 'Standard-Drehzahl',
  'cam.tool.defaultFeed': 'Standard-Vorschub',
  'cam.tool.plungeFeed': 'Eintauchvorschub',
  'cam.tool.stepdown': 'Zustellung',
  'cam.tool.maxCutDepth': 'Max. Schnitttiefe',
  'cam.tool.stepoverRatio': 'Bahnabstand-Verhältnis',

  // ── Tool panel chrome ──
  'cam.tools.addTool': 'Werkzeug hinzufügen',
  'cam.tools.importFromLibrary': 'Aus Bibliothek importieren',
  'cam.tools.loading': 'Wird geladen…',
  'cam.tools.loadingLibrary': 'Mitgelieferte Werkzeugbibliothek wird geladen…',
  'cam.tools.allTypes': 'Alle Typen',
  'cam.tools.allUnits': 'Alle Einheiten',
  'cam.tools.noFilterMatch': 'Keine Werkzeuge entsprechen den gewählten Filtern.',
  'cam.tools.empty': 'Noch keine Werkzeuge. Fügen Sie das erste Werkzeug hinzu, um die Bibliothek aufzubauen.',
  'cam.tools.imported': 'Importiert',
  'cam.tools.import': 'Importieren',
  'cam.tools.duplicateTool': 'Werkzeug duplizieren',
  'cam.tools.toolUsedByOperation': 'Werkzeug wird von einer Operation verwendet',
  'cam.tools.deleteTool': 'Werkzeug löschen',

  // ── Operation tree row actions ──
  'cam.treeRow.hideToolpath': 'Werkzeugweg ausblenden',
  'cam.treeRow.showToolpath': 'Werkzeugweg anzeigen',
  'cam.treeRow.hide': 'Ausblenden',
  'cam.treeRow.show': 'Anzeigen',
  'cam.treeRow.toolpathFor': 'Werkzeugweg {action} für {name}',
  'cam.treeRow.off': 'Aus',
  'cam.treeRow.duplicateOperation': 'Operation duplizieren',
  'cam.treeRow.deleteOperation': 'Operation löschen',
  'cam.treeRow.dragToReorder': 'Zum Umsortieren ziehen',

  // ── Add operation menu ──
  'cam.addMenu.operation': 'Operation',
  'cam.addMenu.roughPass': 'Schruppen',
  'cam.addMenu.finishPass': 'Schlichten',
  'cam.addMenu.bothPasses': 'Beide',
  'cam.addMenu.roughPassHint': 'Schruppdurchgang ({hint})',
  'cam.addMenu.finishPassHint': 'Schlichtdurchgang ({hint})',
  'cam.addMenu.bothPassesHint': 'Beide Durchgänge ({hint})',
  'cam.addMenu.roughPassTitle': 'Schruppdurchgang',
  'cam.addMenu.finishPassTitle': 'Schlichtdurchgang',
  'cam.addMenu.bothPassesTitle': 'Schrupp- und Schlichtdurchgang',
  'cam.addMenu.add': 'Hinzufügen',
  'cam.addMenu.addHint': '{label} hinzufügen ({hint})',
  'cam.addMenu.addLabel': '{label} hinzufügen',
  'cam.addMenu.selectAll': 'Alle auswählen',
  'cam.addMenu.selectAllHint': 'Alle mit {label} kompatiblen Features auswählen',
  'cam.addMenu.collapseInfo': 'Info zu {label} einklappen',
  'cam.addMenu.expandInfo': 'Info zu {label} ausklappen',
  'cam.addMenu.missingImage': 'Fehlendes Bild:',
  'cam.addMenu.keyPoints': 'Kernpunkte:',
  'cam.addMenu.exampleImage': 'Beispiel für {title}',

  // ── Validation hints: empty selection ──
  'cam.hint.empty.drilling': 'Zuerst ein oder mehrere Kreis-Features auswählen',
  'cam.hint.empty.followLine': 'Zuerst ein oder mehrere offene oder geschlossene Features auswählen; geschlossene Bereiche sind optionale Filter',
  'cam.hint.empty.surfaceClean': 'Zuerst ein oder mehrere Hinzufügen-/Modell-Features auswählen; geschlossene Bereiche sind optionale Filter',
  'cam.hint.empty.vCarve': 'Zuerst ein oder mehrere geschlossene Abzieh- oder Linien-Features auswählen',
  'cam.hint.empty.roughSurface': 'Zuerst ein importiertes Modell-Feature auswählen',
  'cam.hint.empty.default': 'Zuerst ein oder mehrere kompatible Features auswählen',

  // ── Validation hints: construction ──
  'cam.hint.construction': 'Konstruktionsgeometrie wird nie bearbeitet – zuerst Konstruktions-Features abwählen',

  // ── Validation hints: drilling ──
  'cam.hint.drilling': 'Bohren erfordert Kreis-Features; geschlossene Bereiche sind optionale Filter',

  // ── Validation hints: follow_line ──
  'cam.hint.followLine': 'Gravieren erfordert mindestens ein Pfad-Feature; geschlossene Bereiche sind optionale Filter',

  // ── Validation hints: surface_clean ──
  'cam.hint.surfaceCleanNoFeature': 'Oberfläche säubern erfordert mindestens ein Hinzufügen-/Modell-Feature; Bereiche sind nur Filter',
  'cam.hint.surfaceCleanWrongOp': 'Oberfläche säubern akzeptiert nur Hinzufügen-/Modell-Features plus optionale geschlossene Bereiche',
  'cam.hint.surfaceCleanClosedOnly': 'Oberfläche säubern akzeptiert nur geschlossene Profile',

  // ── Validation hints: v_carve / v_carve_medial ──
  'cam.hint.vCarveRequiresClosed': '{kind} erfordert mindestens ein geschlossenes Abzieh- oder Linien-Feature; Bereiche sind nur Filter',
  'cam.hint.vCarveWrongFeature': '{kind} akzeptiert nur geschlossene Abzieh- oder Linien-Features plus optionale geschlossene Bereiche',

  // ── Validation hints: rough_surface ──
  'cam.hint.roughSurfaceNoModel':
    'Oberflächenschruppen erfordert mindestens ein importiertes Modell-Feature; geschlossene Bereiche sind optionale Filter',

  // ── Validation hints: finish_surface / finish_surface_cleanup ──
  'cam.hint.finishSurfaceCount': '{kind} erfordert genau ein importiertes Modell-Feature; geschlossene Bereiche sind optionale Filter',
  'cam.hint.finishSurfaceWrong': '{kind} akzeptiert nur ein importiertes Modell plus optionale geschlossene Bereiche',

  // ── Validation hints: generic (pocket, edge_route) ──
  'cam.hint.noSubtractFeature': 'Mindestens ein Abzieh-Feature auswählen; geschlossene Bereiche sind optionale Filter',
  'cam.hint.noAddFeature': 'Mindestens ein Hinzufügen-Feature auswählen; geschlossene Bereiche sind optionale Filter',
  'cam.hint.noAddModelFeature': 'Mindestens ein Hinzufügen-/Modell-Feature auswählen; geschlossene Bereiche sind optionale Filter',
  'cam.hint.onlySubtract': 'Diese Operation akzeptiert nur Abzieh-Features plus optionale geschlossene Bereiche',
  'cam.hint.onlyAdd': 'Diese Operation akzeptiert nur Hinzufügen-Features plus optionale geschlossene Bereiche',
  'cam.hint.onlyAddModel': 'Diese Operation akzeptiert nur Hinzufügen-/Modell-Features plus optionale geschlossene Bereiche',
  'cam.hint.closedProfilesOnly': '{kind} akzeptiert nur geschlossene Profile',

  // ── Validation hints: shared ──
  'cam.hint.regionNotClosed': 'Bereichsfilter müssen geschlossene Profile sein',
  'cam.hint.featuresNotFound': 'Ein oder mehrere ausgewählte Features nicht gefunden',
  'cam.hint.selectCompatible': 'Wählen Sie ein oder mehrere kompatible Features im Baum oder in der Skizze',
  'cam.hint.notCompatible': 'Aktuelle Auswahl ist mit dieser Operation nicht kompatibel',

  // ── Booklet export ──
  'cam.booklet.building': 'Broschüre wird erstellt…',
  'cam.booklet.exported': 'Broschüre exportiert: {path}',
  'cam.booklet.cancelled': 'Broschüren-Export abgebrochen',
  'cam.booklet.failed': 'Broschüre konnte nicht exportiert werden',

  // ── Rest machining ──
  'cam.restOp.created.one': 'Restoperation mit {count} Bereich erstellt; wählen Sie ein kleineres Werkzeug',
  'cam.restOp.created.other': 'Restoperation mit {count} Bereichen erstellt; wählen Sie ein kleineres Werkzeug',
  'cam.restOp.empty': 'Keine unerreichbaren Taschenbereiche für dieses Werkzeug gefunden',

  // ── Library ──
  'cam.library.failed': 'Werkzeugbibliothek konnte nicht geladen werden.',

  // ── Parameter reference diagram labels ──
  'cam.paramRef.stepdown': 'Referenz für Zustellung',
  'cam.paramRef.stepover': 'Referenz für Bahnabstand',
  'cam.paramRef.maxDepth': 'Referenz für maximale Tiefe',
  'cam.paramRef.retractHeight': 'Referenz für Rückzugshöhe',
  'cam.paramRef.peckDepth': 'Referenz für Entspantiefe',
  'cam.paramRef.feed': 'Referenz für Vorschub',
  'cam.paramRef.plungeFeed': 'Referenz für Eintauchvorschub',
  'cam.paramRef.slotFeed': 'Referenz für Nutvorschub',
  'cam.paramRef.rpm': 'Referenz für Drehzahl',
  'cam.paramRef.dwell': 'Referenz für Verweilzeit',
  'cam.paramRef.cutDirection': 'Referenz für Schnittrichtung',
  'cam.paramRef.pattern': 'Referenz für Muster',
  'cam.paramRef.machiningOrder': 'Referenz für Bearbeitungsreihenfolge',
  'cam.paramRef.rasterAngle': 'Referenz für Rasterwinkel',
  'cam.paramRef.finishWalls': 'Referenz für Wände schlichten',
  'cam.paramRef.finishFloor': 'Referenz für Boden schlichten',
  'cam.paramRef.stockRadial': 'Referenz für radiales Aufmaß',
  'cam.paramRef.stockAxial': 'Referenz für axiales Aufmaß',
  'cam.paramRef.adaptiveSpacing': 'Referenz für adaptiven Abstand',
  'cam.paramRef.adaptiveRefinement': 'Referenz für adaptive Verfeinerung',
  'cam.paramRef.maxRings': 'Referenz für maximale Ringe',
  'cam.paramRef.drillType': 'Referenz für Bohrtyp',

  // ── Operation descriptions (OperationAddMenu expanded cards) ──
  // Pocket
  'cam.opDesc.pocket.title': 'Tasche',
  'cam.opDesc.pocket.fullDescription':
    'Tasche räumt das Innere eines oder mehrerer geschlossener Abzieh-Profile bis zu einem festen Z aus. Wählen Sie zwischen Offset- (konzentrisch, von außen nach innen) oder Parallel-Muster (Scanlinien); Parallel nimmt einen einstellbaren Winkel.',
  'cam.opDesc.pocket.keyPoint.0': 'Erfordert ein oder mehrere geschlossene Abzieh-Profile',
  'cam.opDesc.pocket.keyPoint.1': 'Offset- oder Parallel-Räummuster',
  'cam.opDesc.pocket.keyPoint.2': 'Unterstützt Schrupp- und Schlichtdurchgänge',
  'cam.opDesc.pocket.keyPoint.3': 'Am besten mit Schaftfräsern für saubere Böden',
  'cam.opDesc.pocket.keyPoint.4': 'Optionale geschlossene Bereiche wirken als XY-Filter',

  // V-Carve offset
  'cam.opDesc.vCarve.title': 'V-Gravur Offset',
  'cam.opDesc.vCarve.fullDescription':
    'V-Gravur Offset folgt zunehmend schmaleren, nach innen versetzten Konturen eines geschlossenen Profils und senkt Z bei jedem Durchgang, sodass die schräge Flanke des V-Nutfräsers eine saubere V-Nut fräst, die zur Mittellinie ausläuft. Die Tiefe pro Durchgang ergibt sich aus dem Konturabstand und dem halben V-Winkel.',
  'cam.opDesc.vCarve.keyPoint.0': 'Erfordert ein oder mehrere geschlossene Abzieh-Profile',
  'cam.opDesc.vCarve.keyPoint.1': 'Erfordert einen V-Nutfräser (zuerst den Spitzenwinkel am Werkzeug festlegen)',
  'cam.opDesc.vCarve.keyPoint.2': 'Einzeldurchgang-Operation (keine Schrupp-/Schlicht-Aufteilung)',
  'cam.opDesc.vCarve.keyPoint.3': 'Ideal für Gravuren, Beschilderung und dekorative Kanten',
  'cam.opDesc.vCarve.keyPoint.4': 'Optionale geschlossene Bereiche wirken als XY-Filter',

  // V-Carve medial
  'cam.opDesc.vCarveMedial.title': 'V-Gravur Mittelachse',
  'cam.opDesc.vCarveMedial.fullDescription':
    'V-Gravur Mittelachse berechnet die echte Mittelachse eines geschlossenen Profils aus dem Voronoi-Diagramm seiner Begrenzung und fräst eine V-Nut, deren Tiefe exakt der lokalen halben Breite folgt. Scharfe Ecken erhalten Skelettspitzen, die bis zur Oberfläche ansteigen, für klare Spitzen; glatte Kurven bleiben dank geometrischer Filterung sauber. Die Abtastauflösung passt sich automatisch an die Größe jeder Form an.',
  'cam.opDesc.vCarveMedial.keyPoint.0': 'Erfordert ein oder mehrere geschlossene Abzieh-Profile',
  'cam.opDesc.vCarveMedial.keyPoint.1': 'Erfordert einen V-Nutfräser (zuerst den Spitzenwinkel am Werkzeug festlegen)',
  'cam.opDesc.vCarveMedial.keyPoint.2': 'Exakte Tiefe: Die V-Flanken berühren überall entlang des Skeletts beide Wände',
  'cam.opDesc.vCarveMedial.keyPoint.3': 'Automatische formabhängige Abtastung hält kleine Beschriftungen sauber',
  'cam.opDesc.vCarveMedial.keyPoint.4': 'Klare Spitzen mit Nulltiefe in scharfen Ecken; keine Artefakte auf glatten Kurven',
  'cam.opDesc.vCarveMedial.keyPoint.5': 'Einzeldurchgang-Operation (keine Schrupp-/Schlicht-Aufteilung)',
  'cam.opDesc.vCarveMedial.keyPoint.6': 'Optionale geschlossene Bereiche wirken als XY-Filter',

  // Edge route inside
  'cam.opDesc.edgeRouteInside.title': 'Kontur innen',
  'cam.opDesc.edgeRouteInside.fullDescription':
    'Kontur innen folgt der Innenkante eines oder mehrerer geschlossener Abzieh-Profile, nach innen um den Werkzeugradius versetzt. Nützlich für Nuten, Aushöhlungen und innere Profilschnitte, bei denen das Werkzeug innerhalb der Begrenzung bleiben muss.',
  'cam.opDesc.edgeRouteInside.keyPoint.0': 'Erfordert ein oder mehrere geschlossene Abzieh-Profile',
  'cam.opDesc.edgeRouteInside.keyPoint.1': 'Der Werkzeugweg ist nach innen um den Werkzeugradius versetzt',
  'cam.opDesc.edgeRouteInside.keyPoint.2': 'Unterstützt Schrupp- und Schlichtdurchgänge',
  'cam.opDesc.edgeRouteInside.keyPoint.3': 'Optionale geschlossene Bereiche wirken als XY-Filter',

  // Edge route outside
  'cam.opDesc.edgeRouteOutside.title': 'Kontur außen',
  'cam.opDesc.edgeRouteOutside.fullDescription':
    'Kontur außen folgt der Außenkante eines oder mehrerer geschlossener Hinzufügen- oder Modell-Profile, nach außen um den Werkzeugradius versetzt. Wird verwendet, um Teile aus dem Rohteil auszuprofilieren, saubere Schultern um erhöhte Features zu belassen oder Umrisse zu schneiden.',
  'cam.opDesc.edgeRouteOutside.keyPoint.0': 'Erfordert ein oder mehrere geschlossene Hinzufügen- oder Modell-Profile',
  'cam.opDesc.edgeRouteOutside.keyPoint.1': 'Der Werkzeugweg ist nach außen um den Werkzeugradius versetzt',
  'cam.opDesc.edgeRouteOutside.keyPoint.2': 'Unterstützt Schrupp- und Schlichtdurchgänge',
  'cam.opDesc.edgeRouteOutside.keyPoint.3': 'Optionale geschlossene Bereiche wirken als XY-Filter',

  // Surface clean
  'cam.opDesc.surfaceClean.title': 'Oberfläche säubern',
  'cam.opDesc.surfaceClean.fullDescription':
    'Oberfläche säubern bearbeitet die flache Oberseite eines oder mehrerer Hinzufügen-/Modell-Features im Bereich um alle höheren Hinzufügen-Features, die darauf sitzen. Es erzeugt ein Band von Säuberungsdurchgängen auf jeder Stufenhöhe – nützlich zum Schlichten von Podesten, Terrassen und gestuften Oberflächen. Das Muster kann Offset oder Parallel sein.',
  'cam.opDesc.surfaceClean.keyPoint.0': 'Erfordert ein oder mehrere geschlossene Hinzufügen- oder Modell-Features',
  'cam.opDesc.surfaceClean.keyPoint.1': 'Räumt die Fläche zwischen höheren Features auf jeder Stufenhöhe',
  'cam.opDesc.surfaceClean.keyPoint.2': 'Offset- oder Parallel-Räummuster',
  'cam.opDesc.surfaceClean.keyPoint.3': 'Unterstützt Schrupp- und Schlichtdurchgänge',
  'cam.opDesc.surfaceClean.keyPoint.4': 'Optionale geschlossene Bereiche wirken als XY-Filter',

  // Engrave
  'cam.opDesc.followLine.title': 'Gravieren',
  'cam.opDesc.followLine.fullDescription':
    'Gravieren fährt entlang eines beliebigen Skizzenpfads – offen oder geschlossen – mit fester Gravurtiefe. Das Werkzeug folgt der Mittellinie des Pfads; kein Versatz. Gut für Text, dekorative Linien, Ausrichtungsmarken und das Verfolgen komplexer Kurven auf der Rohteiloberfläche.',
  'cam.opDesc.followLine.keyPoint.0': 'Akzeptiert offene oder geschlossene Pfad-Features',
  'cam.opDesc.followLine.keyPoint.1': 'Werkzeug folgt der Mittellinie des Pfads (kein Versatz)',
  'cam.opDesc.followLine.keyPoint.2': 'Einzeldurchgang-Operation (keine Schrupp-/Schlicht-Aufteilung)',
  'cam.opDesc.followLine.keyPoint.3': 'Meist flach; Zustellung greift, wenn die Gravurtiefe sie überschreitet',
  'cam.opDesc.followLine.keyPoint.4': 'Optionale geschlossene Bereiche wirken als XY-Filter',

  // Drilling
  'cam.opDesc.drilling.title': 'Bohren',
  'cam.opDesc.drilling.fullDescription':
    'Bohren erzeugt ein Loch in der Mitte jedes ausgewählten Kreis-Features mit einem festen Bohrzyklus. Wählen Sie die Bohrmethode (einfach G81, Tiefloch G83, Verweilen G82, Spanbruch G73) und die Tiefe an der Operation.',
  'cam.opDesc.drilling.keyPoint.0': 'Erfordert ein oder mehrere Kreis-Features',
  'cam.opDesc.drilling.keyPoint.1':
    'Vier Zyklustypen: einfach (G81), Tiefloch (G83), Verweilen (G82), Spanbruch (G73)',
  'cam.opDesc.drilling.keyPoint.2': 'Tiefloch- und Spanbruchzyklen verwenden ein Entspan-Inkrement',
  'cam.opDesc.drilling.keyPoint.3': 'Schnell für wiederholte Lochmuster',
  'cam.opDesc.drilling.keyPoint.4': 'Optionale geschlossene Bereiche filtern, welche Löcher gebohrt werden',

  // 3D Surface rough
  'cam.opDesc.roughSurface.title': '3D-Oberfläche schruppen',
  'cam.opDesc.roughSurface.fullDescription':
    'Oberflächenschruppen schneidet das importierte 3D-Modell auf konstanten Z-Ebenen (Wasserlinien-Stil) und räumt jede Ebene mit Offset-Durchgängen aus, wobei radiales und axiales Aufmaß für das Schlichten verbleibt. Verwenden Sie größere Zustellung und größeren Bahnabstand für mehr Tempo; folgen Sie mit einer Schlichtoperation für Genauigkeit.',
  'cam.opDesc.roughSurface.keyPoint.0': 'Erfordert ein importiertes 3D-Modell',
  'cam.opDesc.roughSurface.keyPoint.1': 'Wasserlinien-Ebenenschnitt mit Offset-Räumung pro Ebene',
  'cam.opDesc.roughSurface.keyPoint.2': 'Berücksichtigt radiales und axiales Aufmaß für den Schlichtdurchgang',
  'cam.opDesc.roughSurface.keyPoint.3': 'Einzeldurchgang-Operation (keine Schrupp-/Schlicht-Aufteilung – diese Operation ist das Schruppen)',
  'cam.opDesc.roughSurface.keyPoint.4': 'Optionale geschlossene Bereiche wirken als XY-Filter',

  // 3D Surface finish
  'cam.opDesc.finishSurface.title': '3D-Oberfläche schlichten',
  'cam.opDesc.finishSurface.fullDescription':
    'Oberflächenschlichten erzeugt die endgültige Oberfläche eines importierten 3D-Modells. Wählen Sie Parallel (Scanlinien in einstellbarem Winkel) für flachere Geometrie oder Wasserlinie (Konturen bei konstantem Z) für steilere Wände. Verwenden Sie einen kleinen Bahnabstand für Parallel oder eine kleine Zustellung für Wasserlinie.',
  'cam.opDesc.finishSurface.keyPoint.0': 'Erfordert ein importiertes 3D-Modell',
  'cam.opDesc.finishSurface.keyPoint.1': 'Parallel- (Scanlinie) oder Wasserlinien-Muster (konstantes Z)',
  'cam.opDesc.finishSurface.keyPoint.2': 'Einzeldurchgang-Operation (keine Schrupp-/Schlicht-Aufteilung – diese Operation ist das Schlichten)',
  'cam.opDesc.finishSurface.keyPoint.3': 'Folgt normalerweise auf 3D-Oberfläche schruppen',
  'cam.opDesc.finishSurface.keyPoint.4': 'Optionale geschlossene Bereiche wirken als XY-Filter',

  // 3D Surface cleanup
  'cam.opDesc.finishSurfaceCleanup.title': '3D-Oberfläche nacharbeiten',
  'cam.opDesc.finishSurfaceCleanup.fullDescription':
    'Oberflächen-Nacharbeit gibt reine Schlicht-Durchgänge für Wände und Boden auf dem tiefsten beibehaltenen Z jeder von der 3D-Schruppoperation gelassenen Stufe aus. Es dedupliziert wiederholte Wand-/Boden-Spalten über Ebenen hinweg, sodass jede einmal auf ihrer tiefsten wirksamen Tiefe geschnitten wird – zum Nacharbeiten von Schrupp-Terrassen ohne erneutes Schruppen.',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.0': 'Erfordert ein importiertes 3D-Modell',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.1': 'Unabhängige Schalter für Wände schlichten und Boden schlichten',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.2': 'Offset- oder Parallel-Muster für Böden',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.3': 'Wird normalerweise nach 3D-Oberfläche schruppen als letzter Durchgang ausgeführt',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.4': 'Optionale geschlossene Bereiche wirken als XY-Filter',
}
