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

import type { warningsEn } from '../en/warnings'

/**
 * German toolpath/postprocessor warnings, one key per `ToolpathWarningCode`,
 * plus the `warnings.moveKind.*` words injected by `warningText.ts` (used as a
 * standalone noun in the clamp warnings). `warnings.debug` is a developer
 * passthrough and stays `{text}`.
 */
export const warningsDe: Record<keyof typeof warningsEn, string> = {
  'warnings.debug': '{text}',
  // resolver
  'warnings.targetsMissingOrWrongRole': 'Einige ausgewählte Ziel-Features fehlen oder sind keine {roles}-Features',
  'warnings.closedProfilesOnly': '{operation}-Operationen unterstützen nur geschlossene Ziel-Profile',
  'warnings.bandEmptySubject': 'Band {topZ} -> {bottomZ} ergab leere Subjektgeometrie',
  'warnings.bandNoRegions': 'Band {topZ} -> {bottomZ} ergab keine bearbeitbaren Bereiche',
  'warnings.resolverNoBands': '{operation}-Resolver erzeugte keine Tiefenbänder',
  'warnings.resolverOnlyInsideEdge': 'Nur Innenkontur-Operationen können von diesem Bereichs-Resolver aufgelöst werden',
  'warnings.resolverOnlyPocketVcarve': 'Nur Tasche- und V-Gravur-Operationen können von diesem Bereichs-Resolver aufgelöst werden',
  'warnings.resolverNoValidKindTargets': 'Keine gültigen {kind}-Features für diese {operation}-Operation gefunden',
  'warnings.resolverNoValidSubtracts': 'Keine gültigen Abzieh-Features für diese {operation}-Operation gefunden',
  'warnings.resolverNoTargets': '{operation}-Operation hat keine Feature-Ziele',
  // shared
  'warnings.cutDepthExceedsToolMax': 'Schnitttiefe {depth} {units} überschreitet die max. Schnitttiefe des Werkzeugs {max} {units}',
  'warnings.cutDepthExceedsToolMaxForFeature': '{name}: Schnitttiefe {depth} {units} überschreitet die max. Schnitttiefe des Werkzeugs {max} {units}',
  'warnings.noToolAssigned': 'Dieser Operation ist kein Werkzeug zugewiesen',
  'warnings.vBitAngleRange': 'Der V-Nutfräser-Winkel muss zwischen 0 und 180 Grad liegen',
  'warnings.maxCarveDepthPositive': 'Max. Gravurtiefe muss größer als null sein',
  'warnings.toolDiameterPositive': 'Werkzeugdurchmesser muss größer als null sein',
  'warnings.stepdownPositive': 'Operations-Zustellung muss größer als null sein',
  'warnings.targetsNotFound': 'Ein oder mehrere Ziel-Features nicht gefunden',
  'warnings.targetsMissing': 'Einige ausgewählte Ziel-Features fehlen',
  'warnings.stepoverRatioRange': 'Bahnabstand-Verhältnis muss zwischen 0 und 1 liegen',
  'warnings.operationStepoverRatioRange': 'Operations-Bahnabstand-Verhältnis muss zwischen 0 und 1 liegen',
  // v-carve medial
  'warnings.vcarveMedialWrongKind': 'Nur V-Gravur-Mittelachse-Operationen können vom Mittelachsen-Generator aufgelöst werden',
  'warnings.vcarveMedialNeedsVBit': 'V-Gravur Mittelachse erfordert einen V-Nutfräser',
  'warnings.vcarveBandNoDepth': 'Band {topZ} -> {bottomZ} lässt keine nutzbare V-Gravur-Tiefe',
  'warnings.vcarveDegenerateRegion': 'Ein Bereich hat entartete XY-Grenzen und ergab keine Mittelachse',
  'warnings.vcarveSamplingBudget': 'Abtastauflösung auf {resolution} auf großen Bereichen erhöht, um die Berechnung zu begrenzen',
  'warnings.vcarveNoMedialAxis': 'Ein Bereich ergab keine Mittelachse (Feature ist möglicherweise dünner als die Schrittweite)',
  'warnings.vcarveMedialNoMoves': 'V-Gravur-Mittelachsen-Generator erzeugte keine Werkzeugweg-Bewegungen',
  // v-carve (offset)
  'warnings.vcarveWrongKind': 'Nur V-Gravur-Operationen können vom V-Gravur-Generator aufgelöst werden',
  'warnings.vcarveNeedsVBit': 'V-Gravur erfordert einen V-Nutfräser',
  'warnings.contourSpacingPositive': 'Konturabstand muss größer als null sein',
  'warnings.vBitInvalidSlope': 'Der V-Nutfräser-Winkel ergibt eine ungültige Gravurneigung',
  'warnings.vcarveNoMoves': 'V-Gravur-Generator erzeugte keine Werkzeugweg-Bewegungen',
  // edge route
  'warnings.edgeRouteWrongKind': 'Nur Kontur-Operationen können vom Kontur-Generator aufgelöst werden',
  'warnings.edgeRouteNoTargets': 'Kontur-Operation hat keine Feature-Ziele',
  'warnings.edgeRouteNoValidTargets': 'Keine gültigen Ziel-Features für diese Kontur-Operation gefunden',
  'warnings.edgeMixedDepthSpans': 'Ausgewählte Außenkontur-Ziele haben unterschiedliche wirksame Tiefenspannen. Kombinierte Außenkontur wird für Ziele mit gemischter Tiefe noch nicht unterstützt; das Erzeugen separater Konturen kann innere Überlappungen schneiden. Teilen Sie die Operation nach Tiefe auf oder richten Sie Ober-/Unterseiten der Ziele aus.',
  'warnings.edgeNoCombinedContour': 'Für die ausgewählten Außenkontur-Ziele konnte keine gültige kombinierte Außenkontur erzeugt werden',
  'warnings.edgeFeatureNoCutDepth': '{name} lässt nach axialem Aufmaß keine Schnitttiefe',
  'warnings.edgeBandNoCutDepth': 'Band {topZ} -> {bottomZ} lässt nach axialem Aufmaß keine Schnitttiefe',
  'warnings.edgeNoContourForFeature': 'Für {name} konnte keine gültige Kontur erzeugt werden',
  'warnings.edgeNoInsideContour': 'Für Band {topZ} -> {bottomZ} konnte keine gültige Innenkontur erzeugt werden',
  'warnings.edgeClosedProfilesOnly': 'Kontur-Operationen unterstützen nur geschlossene Ziel-Profile',
  // 3D surface roughing (stepdown)
  'warnings.surface3dNeedsModel': '{operation} erfordert die Auswahl eines Modell-Features',
  'warnings.surface3dNotMesh': 'Modell-Feature muss ein importiertes Netzmodell sein',
  'warnings.surface3dLoadFailed': 'Modellgeometrie konnte nicht geladen werden',
  'warnings.surface3dStockToLeaveTooLarge': 'Axiales Aufmaß überschreitet die Modellhöhe – nichts zu schneiden',
  'warnings.surface3dDegenerateBoundary': 'Berechnete Außenbegrenzung ist entartet – Modellsilhouette ist möglicherweise zu klein',
  'warnings.surface3dNoDepthInPocket': 'Umschließendes Abzieh-Feature lässt keine Bearbeitungstiefe für dieses Modell',
  'warnings.surface3dNoStepLevels': 'Keine Stufenebenen erzeugt',
  'warnings.surface3dOpenMesh': 'Modell hat offene/nicht wasserdichte Schnitte; das Schruppen verwendete konservativen Silhouettenschutz',
  'warnings.surface3dFloorCollapsed': 'Kritischer Nacharbeitsboden bei Z={z} kollabierte nach Versatz und wurde übersprungen',
  'warnings.surface3dNoLevels': 'Keine bearbeitbaren 3D-Oberflächenebenen gefunden',
  // tabs
  'warnings.tabOnlyEdgeRoute': 'Haltesteg „{name}" ist für diese Operation relevant, aber Haltestege werden derzeit nur bei Kontur-Operationen angewendet.',
  'warnings.tabsOverlapAmbiguous': 'Haltestege „{a}" und „{b}" überlappen sich auf eine Weise, die zu mehrdeutiger Ausgabe führen kann.',
  'warnings.tabNoIntersect': 'Haltesteg „{name}" schneidet den ausgewählten Operations-Werkzeugweg nicht.',
  'warnings.tabAboveStockTop': 'Haltesteg „{name}" ragt über die Rohteiloberseite hinaus (Z oben {zTop}, Rohteiloberseite {stockTop}).',
  'warnings.tabBelowStockBottom': 'Haltesteg „{name}" ragt unter die Rohteilunterseite hinaus (Z unten {zBottom}).',
  'warnings.tabInvalidZRange': 'Haltesteg „{name}" hat einen ungültigen Z-Bereich ({zBottom} -> {zTop}).',
  'warnings.tabOutsideCutZ': 'Naher Haltesteg {name} überlappt die Werkzeugweg-Grundfläche, liegt aber außerhalb des Schnitt-Z-Bereichs ({minZ} -> {maxZ}).',
  'warnings.tabsOutsideCutZ': '{count} nahe Haltestege überlappen die Werkzeugweg-Grundfläche, liegen aber außerhalb des Schnitt-Z-Bereichs ({minZ} -> {maxZ}).',
  'warnings.tabsOutsideCutZList': '{count} nahe Haltestege überlappen die Werkzeugweg-Grundfläche, liegen aber außerhalb des Schnitt-Z-Bereichs ({minZ} -> {maxZ}): {names}.',
  'warnings.tabsOutsideCutZListMore': '{count} nahe Haltestege überlappen die Werkzeugweg-Grundfläche, liegen aber außerhalb des Schnitt-Z-Bereichs ({minZ} -> {maxZ}): {names} und {more} weitere.',
  // surface clean / finish bands
  'warnings.surfaceNoCleanupRegion': 'Kein bearbeitbarer paralleler Säuberungsbereich für Band {topZ} -> {bottomZ}',
  'warnings.surfaceNoCleanupSegments': 'Keine bearbeitbaren parallelen Säuberungssegmente für Band {topZ} -> {bottomZ}',
  'warnings.surfaceNoOffsetContours': 'Keine bearbeitbaren Offset-Konturen für Band {topZ} -> {bottomZ}',
  'warnings.surfaceFinishBothDisabled': 'Schlichtoperation hat sowohl Wände schlichten als auch Boden schlichten deaktiviert',
  'warnings.surfaceCleanWrongKind': 'Nur Oberfläche-säubern-Operationen können vom Oberfläche-säubern-Resolver aufgelöst werden',
  'warnings.surfaceCleanNoTargets': 'Oberfläche-säubern-Operation hat keine Feature-Ziele',
  'warnings.surfaceCleanNoValidTargets': 'Keine gültigen Hinzufügen-Features für diese Oberfläche-säubern-Operation gefunden',
  'warnings.surfaceBandNoFinishDepth': 'Band {topZ} -> {bottomZ} lässt nach axialem Aufmaß keine Schlichttiefe',
  'warnings.surfaceBandNoRoughDepth': 'Band {topZ} -> {bottomZ} lässt nach axialem Aufmaß keine Schrupptiefe',
  'warnings.surfaceNoFinishContours': 'Keine Schlichtkonturen für Band {topZ} -> {bottomZ} verfügbar',
  'warnings.surfaceTargetsWrongRole': 'Einige ausgewählte Ziel-Features fehlen oder sind keine Hinzufügen-/Modell-Features',
  'warnings.surfaceClosedProfilesOnly': 'Oberfläche-säubern-Operationen unterstützen nur geschlossene Ziel-Profile',
  'warnings.surfaceNoBands': 'Oberfläche-säubern-Resolver erzeugte keine Tiefenbänder',
  // drilling
  'warnings.drillBottomAboveTop': '{name} unteres Z liegt nicht unter dem oberen Z; wird übersprungen',
  'warnings.drillNoCenter': '{name} ist als Kreis markiert, hat aber kein auflösbares Zentrum',
  'warnings.drillNoTargets': 'Bohroperation hat keine Feature-Ziele',
  'warnings.drillWrongKind': 'Nur Bohroperationen können vom Bohr-Generator aufgelöst werden',
  'warnings.drillNoValidCircles': 'Keine gültigen Kreis-Features für diese Bohroperation gefunden',
  'warnings.drillPeckDepthPositive': 'Entspantiefe muss beim Tiefloch-/Spanbruchbohren größer als null sein; Rückfall auf einen einzelnen Eintauchvorgang',
  'warnings.drillNotDrillBit': 'Das ausgewählte Werkzeug ist kein Bohrer – Bohrzyklen erfordern in der Regel ein Bohrwerkzeug',
  'warnings.drillTargetsNotCircles': 'Einige ausgewählte Ziel-Features sind keine Kreise und wurden übersprungen',
  // carving (follow-line)
  'warnings.carveDepthClamped': '{name} Gravurtiefe überschreitet die Rohteilunterseite; auf Z 0 begrenzt',
  'warnings.carveNotEnoughGeometry': '{name} enthält nicht genug Geometrie für die Gravur entlang der Linie',
  'warnings.carveDepthPositive': 'Gravurtiefe muss größer als null sein',
  'warnings.carveNoTargets': 'Gravur-Operation hat keine Feature-Ziele',
  'warnings.carveWrongKind': 'Nur Gravur-Operationen können vom Gravur-Generator aufgelöst werden',
  'warnings.carveNoValidTargets': 'Keine gültigen Ziel-Features für diese Gravur-Operation gefunden',
  // rest regions
  'warnings.restOnlyEdgeRoute': 'Restbereiche können nur für Kontur-Operationen erzeugt werden',
  'warnings.restOnlyPocket': 'Restbereiche können nur für Tasche-Operationen erzeugt werden',
  'warnings.restNoValidOutsideTargets': 'Keine gültigen Hinzufügen-/Modell-Features für diese Außenkontur-Operation gefunden',
  // clamps / regions
  'warnings.clampCrossedOne': 'Spannzwinge „{name}" wird von {count} Bewegung des Typs {moveKind} unterhalb der erforderlichen Freiraumhöhe gekreuzt (min. Z {minZ}, erforderliches Z {requiredZ}).',
  'warnings.clampCrossedMany': 'Spannzwinge „{name}" wird von {count} Bewegungen des Typs {moveKind} unterhalb der erforderlichen Freiraumhöhe gekreuzt (min. Z {minZ}, erforderliches Z {requiredZ}).',
  'warnings.clampTravelLimitExceeded': 'Spannzwinge „{name}" erfordert Freiraum-Z {requiredZ}, was das maximale Verfahr-Z {maxZ} des Projekts überschreitet.',
  'warnings.regionClippedOne': 'Bereichsfilter beschnitt {count} Schnittbewegung.',
  'warnings.regionClippedMany': 'Bereichsfilter beschnitt {count} Schnittbewegungen.',
  'warnings.moveKind.rapid': 'Eilgang',
  'warnings.moveKind.plunge': 'Eintauchen',
  'warnings.moveKind.lead_in': 'Anfahren',
  'warnings.moveKind.lead_out': 'Abfahren',
  'warnings.moveKind.cut': 'Schnitt',
  // finish surface
  'warnings.finishNeedsModel': 'Oberflächenschlichten erfordert ein Modell-Feature und optional ein oder mehrere Bereichs-Features',
  'warnings.finishNotMesh': 'Oberflächenschlichten erfordert ein importiertes Netzmodell-Feature',
  'warnings.finishNoDepthInPocket': 'Umschließendes Abzieh-Feature lässt keine Schlichttiefe für dieses Modell',
  'warnings.surfaceHeightMapReduced': 'Höhenkarte des Oberflächenschlichtens von {from} auf etwa {to} Zellen für die Leistung reduziert',
  'warnings.surfaceSilhouetteDegenerate': 'Modellsilhouette ist entartet – keine Oberflächenschlicht-Abdeckung erzeugt',
  'warnings.cleanupStockToLeaveOffsets': '3D-Oberflächen-Nacharbeit verwendet Aufmaß-Werte; von null verschiedene radiale oder axiale Aufmaße versetzen die Nacharbeit von der endgültigen Oberfläche',
  'warnings.cleanupNoContours': 'Keine Nacharbeitskonturen für diese 3D-Oberflächenoperation verfügbar',
  // pocket floors
  'warnings.pocketNoFloorRegion': 'Kein bearbeitbarer paralleler Bodenbereich für Band {topZ} -> {bottomZ}',
  'warnings.pocketNoFloorSegments': 'Keine bearbeitbaren parallelen Bodensegmente für Band {topZ} -> {bottomZ}',
  // postprocessor
  'warnings.postWcsNullSelect': 'Maschinendefinition fordert {wcsCommand} in der Kopfzeile an, aber selectCommand ist null.',
  'warnings.postToolChangesDisabled': 'Operation „{operation}" verwendet ein anderes Werkzeug („{tool}") als das vorherige, aber Werkzeugwechsel sind deaktiviert.',
  'warnings.postNoCoolantCommands': 'Kühlmittelausgabe angefordert, aber die Maschinendefinition hat keine Kühlmittelbefehle.',
  'warnings.postCannedCycleUnsupported': 'Operation „{operation}": {drillType}-Festzyklus wird von Maschine „{machine}" nicht unterstützt; erweiterte Bewegungen werden ausgegeben.',
  'warnings.postArcNoCapability': 'Operation „{operation}" enthält kreisförmige Werkzeugwegsegmente, aber die ausgewählte Maschine unterstützt keine Kreisinterpolation (G2/G3). Stattdessen werden lineare Bewegungen ausgegeben.',
  // simulation replay / booklet report
  'warnings.replayNoTool': 'Der ausgewählten Operation ist kein Werkzeug zugewiesen.',
  'warnings.bookletNoTool': 'Für diese Operation ist kein Werkzeug ausgewählt.',
  'warnings.bookletNoToolpath': 'Für diese Operation konnte kein Werkzeugweg erzeugt werden.',
  'warnings.restOperationNotFound': 'Operation nicht gefunden',
  'warnings.restOnlyPocketEdgeTargets': 'Restoperationen können nur aus Tasche- oder Kontur-Operationen mit Feature-Zielen erstellt werden',
}
