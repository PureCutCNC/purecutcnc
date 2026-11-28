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

import type { verifyEn } from '../en/verify'

/** German Verify mode translations (issue #1269). */
export const verifyDe: Record<keyof typeof verifyEn, string> = {
  'verify.mode': 'Prüfen',
  'verify.modeTitle': 'Bahn prüfen: Modell, interne Werkzeugbahn und exportiertes Programm vergleichen',
  'verify.panelLabel': 'Exportierte Bahn prüfen',
  'verify.comparisonLabel': 'Vergleich',
  'verify.comparison.modelInternal': 'Modell ↔ Intern',
  'verify.comparison.modelExported': 'Modell ↔ Exportiert',
  'verify.comparison.internalExported': 'Intern ↔ Exportiert',
  'verify.comparisonHint.modelInternal': 'Von den erzeugten Werkzeugbahnen bearbeitetes Rohteil, verglichen mit dem Modell.',
  'verify.comparisonHint.modelExported': 'Vom exportierten, zurückgelesenen Programm bearbeitetes Rohteil, verglichen mit dem Modell.',
  'verify.comparisonHint.internalExported': 'Das exportierte Programm, verglichen mit den erzeugten Werkzeugbahnen.',
  'verify.scopeUpto': 'Alle sichtbaren Operationen bis {operation}',
  'verify.scopeAll': 'Alle sichtbaren Operationen von {setup}',
  'verify.run': 'Prüfung starten',
  'verify.cancel': 'Abbrechen',
  'verify.running': 'Prüfung läuft… {done} von {total}',
  'verify.idle': 'Die Prüfung läuft nur auf Anforderung. Wählen Sie einen Vergleich und starten Sie ihn.',
  'verify.failed': 'Die Prüfung konnte nicht abgeschlossen werden. Versuchen Sie es erneut; Details stehen in der Konsole.',
  'verify.stale.projectEdited': 'Veraltet: Das Projekt wurde seit diesem Ergebnis geändert. Starten Sie die Prüfung erneut.',
  'verify.stale.requestChanged': 'Veraltet: Dieses Ergebnis gilt für einen anderen Vergleich, eine andere Operation, Aufspannung oder Detailstufe. Starten Sie die Prüfung erneut.',
  'verify.summary': '{verified} geprüft · {deviation} mit Abweichungen · {unverified} nicht geprüft',
  'verify.runUnverified': 'Nicht geprüft: {reason}',
  'verify.resultsLabel': 'Prüfergebnisse',
  'verify.legendLabel': 'Farblegende',
  'verify.verdict.verified': 'Geprüft',
  'verify.verdict.deviation': 'Abweichung',
  'verify.verdict.unverified': 'Nicht geprüft',
  'verify.kind.gouge': 'Fehlschnitt',
  'verify.kind.intendedLeftover': 'Beabsichtigtes Aufmaß',
  'verify.kind.unintendedLeftover': 'Unbeabsichtigter Rest',
  'verify.kind.missingCut': 'Fehlender Schnitt',
  'verify.kind.extraCut': 'Zusätzlicher Schnitt',
  'verify.kind.feed': 'Vorschub',
  'verify.kind.unverified': 'Nicht geprüfte Operation',
  'verify.findingRegion': '{area} · max. {size}',
  'verify.findingDistance': '{size} von der anderen Bahn',
  'verify.findingNoCounterpart': 'Kein passender Schnitt auf der anderen Bahn',
  'verify.findingFeed': 'Vorschub {actual} statt {expected}',
  'verify.findingFeedMissing': 'Kein Vorschub angegeben; {expected} erwartet',
  'verify.moreDeviations': '{count} weitere Abweichungen nicht aufgeführt',
  'verify.noFindings': 'Keine Abweichungen',
  'verify.unattributed': 'Material, das keine Operation bearbeitet hat',
  'verify.findingFocus': 'Im Ansichtsfenster zeigen',
  'verify.reasonAtLine': '{reason} (Zeile {line})',
  'verify.reason.aroundSetup': 'eine Rundum-Aufspannung wird noch nicht mit dem Modell verglichen',
  'verify.reason.rotaryOperation': 'eine Rotationsoperation wird noch nicht mit dem Modell verglichen',
  'verify.reason.rotaryMotion': 'eine Bewegung dreht die Drehachse während des Schneidens',
  'verify.reason.unsupportedSetup': 'diese Aufspannungsausrichtung kann nicht bearbeitet werden',
  'verify.reason.uptoOperationNotFound': 'die ausgewählte Operation hat nichts abzuspielen',
  'verify.reason.noModel': 'das Projekt hat kein Modell zum Vergleichen',
  'verify.reason.exportUnsupported': 'das exportierte Programm enthält ein Konstrukt, das nicht zurückgelesen werden kann',
  'verify.reason.exportFailed': 'das Programm konnte nicht erzeugt oder zurückgelesen werden',
  'verify.reason.noCutMoves': 'keine der beiden Bahnen hat eine Schnittbewegung',
  'verify.reason.unparsedText': 'das Programm enthält Text, der kein G-Code ist',
  'verify.reason.unsupportedCommand': 'die Bewegung von {command} kann nicht rekonstruiert werden',
  'verify.reason.machineCoordinateRetract': 'ein Rückzug in Maschinenkoordinaten (G53)',
  'verify.reason.machineCoordinateMove': 'eine Bewegung in Maschinenkoordinaten, die kein Rückzug ist',
  'verify.reason.rapidAfterMachineRetract': 'ein Eilgang nach einem G53-Rückzug gibt kein Z an',
  'verify.reason.workZUnknown': 'eine Vorschubbewegung nach einem G53-Rückzug gibt kein Z an',
  'verify.reason.motionWithoutMode': 'Koordinaten vor jedem Bewegungsmodus',
  'verify.reason.inverseTimeFeedMissing': 'eine Vorschubbewegung im Kehrzeitmodus ohne eigenes F',
  'verify.reason.arcCentreMissing': 'ein Bogen ohne Mittelpunkt oder Radius',
  'verify.reason.arcRadiusTooSmall': 'ein Bogen, dessen Radius seine Endpunkte nicht überspannt',
  'verify.reason.cannedCycleIncomplete': 'ein Bohrzyklus ohne das benötigte Z, R oder Q',
  'verify.reason.cannedCycleWithRotary': 'ein Bohrzyklus, der auch die Drehachse dreht',
  'verify.reason.cannedRetractModeAssumed': 'kein G98/G99 vor einem Bohrzyklus; G98 angenommen',
  'verify.reason.chipBreakRetractApproximate': 'ein Spanbruch-Rückzug wird näherungsweise gelesen',
  'verify.reason.probeMove': 'eine Antastbewegung',
  'verify.reason.touchOffZ': 'ein Z-Antasten',
  'verify.reason.rotaryZeroed': 'die Drehachse wird im Programm genullt',
  'verify.reason.workOffsetChange': 'der Werkstücknullpunkt ändert sich im Programm',
  'verify.reason.parseFailure': 'das Programm konnte nicht gelesen werden',
  'verify.reason.unsupportedStatement': 'eine Anweisung, die nicht rekonstruiert werden kann',
  'verify.reason.emptyProgram': 'der Postprozessor hat kein Programm geschrieben',
  'verify.reason.operationRefused': 'der Postprozessor hat die Operation abgelehnt',
  'verify.reason.postFailed': 'der Postprozessor ist fehlgeschlagen',
  'verify.reason.noTool': 'die Operation hat kein verwendbares Werkzeug',
  'verify.reason.axisNotStated': 'das Programm gibt die {axis}-Achse nie an',
  'verify.reason.manualIndexTurnRemoved': 'die anfängliche Drehung der manuellen Teilung wurde aus den Winkeln entfernt',
  'verify.reason.noToolpath': 'ihre Werkzeugbahn konnte nicht erzeugt werden',
  'verify.reason.noMachine': 'für den Export ist keine Maschine ausgewählt',
  'verify.reason.noOperations': 'keine sichtbare Operation mit Werkzeugbahn bis zur Auswahl',
}
