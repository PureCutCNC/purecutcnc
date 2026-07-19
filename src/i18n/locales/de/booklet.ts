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

import type { bookletEn } from '../en/booklet'

/**
 * German operation-booklet content. Rendered into the PDF, whose Unicode font
 * (hardened in #321) carries ä/ö/ü/ß — do not ASCII-fold German umlauts here.
 */
export const bookletDe: Record<keyof typeof bookletEn, string> = {
  'booklet.operation.pocket': 'Tasche',
  'booklet.operation.vCarve': 'V-Gravur',
  'booklet.operation.vCarveMedial': 'V-Gravur Mittelachse',
  'booklet.operation.insideEdgeRoute': 'Kontur innen',
  'booklet.operation.outsideEdgeRoute': 'Kontur außen',
  'booklet.operation.surfaceClean': 'Oberfläche säubern',
  'booklet.operation.roughSurface': 'Oberfläche schruppen',
  'booklet.operation.finishSurface': 'Oberfläche schlichten',
  'booklet.operation.finishSurfaceCleanup': 'Oberfläche nacharbeiten',
  'booklet.operation.followLine': 'Gravieren',
  'booklet.operation.drilling': 'Bohren',
  'booklet.pass.finish': 'Schlichten',
  'booklet.pass.rough': 'Schruppen',
  'booklet.cutDirection.climb': 'Gleichlauf',
  'booklet.cutDirection.conventional': 'Gegenlauf',
  'booklet.machiningOrder.featureFirst': 'Feature zuerst',
  'booklet.machiningOrder.levelFirst': 'Ebene zuerst',
  'booklet.target.stock': 'Rohteil',
  'booklet.target.missingFeature': 'Fehlendes Feature {id}',
  'booklet.units.inch': 'Zoll',
  'booklet.units.millimeter': 'Millimeter',
  'booklet.duration.seconds': '{seconds} s',
  'booklet.duration.minutesSeconds': '{minutes} min {seconds} s',
  'booklet.duration.hoursMinutesSeconds': '{hours} h {minutes} min {seconds} s',
  'booklet.value.unavailable': 'Nicht verfügbar',
  'booklet.value.noToolSelected': 'Kein Werkzeug ausgewählt',
  'booklet.value.enabled': 'Aktiviert',
  'booklet.value.notGenerated': 'Nicht erzeugt',
  'booklet.value.slotFeed': '{percent} % des Vorschubs',
  'booklet.value.unavailableInvalidFeed': 'Nicht verfügbar (ungültiger Vorschub)',
  'booklet.value.estimatedFeedTime': '{duration} (ohne G0-Eilgangzeit)',
  'booklet.value.feedTravel': '{distance} (Vorschub- und Eintauchbewegungen)',
  'booklet.value.rapidTravel': '{distance} (G0-Geschwindigkeit maschinendefiniert)',
  'booklet.label.tool': 'Werkzeug',
  'booklet.label.name': 'Name',
  'booklet.label.type': 'Typ',
  'booklet.label.diameter': 'Durchmesser',
  'booklet.label.vBitAngle': 'V-Nutfräser-Winkel',
  'booklet.label.flutes': 'Schneiden',
  'booklet.label.material': 'Material',
  'booklet.label.maxCutDepth': 'Max. Schnitttiefe',
  'booklet.label.kind': 'Art',
  'booklet.label.pass': 'Durchgang',
  'booklet.label.target': 'Ziel',
  'booklet.label.feed': 'Vorschub',
  'booklet.label.plungeFeed': 'Eintauchvorschub',
  'booklet.label.rpm': 'Drehzahl',
  'booklet.label.stepdown': 'Zustellung',
  'booklet.label.stepover': 'Bahnabstand',
  'booklet.label.cutDirection': 'Schnittrichtung',
  'booklet.label.machiningOrder': 'Bearbeitungsreihenfolge',
  'booklet.label.roundOutsideCorners': 'Außenecken abrunden',
  'booklet.label.pattern': 'Muster',
  'booklet.label.pocketAngle': 'Taschenwinkel',
  'booklet.label.slotFeed': 'Nutvorschub',
  'booklet.label.drillType': 'Bohrtyp',
  'booklet.label.peckDepth': 'Entspantiefe',
  'booklet.label.dwellTime': 'Verweilzeit',
  'booklet.label.retractHeight': 'Rückzugshöhe',
  'booklet.label.carveDepth': 'Gravurtiefe',
  'booklet.label.stockToLeaveRadial': 'Aufmaß radial',
  'booklet.label.stockToLeaveAxial': 'Aufmaß axial',
  'booklet.label.toolpath': 'Werkzeugweg',
  'booklet.label.moves': 'Bewegungen',
  'booklet.label.cutMoves': 'Schnittbewegungen',
  'booklet.label.rapidMoves': 'Eilgangbewegungen',
  'booklet.label.plungeMoves': 'Eintauchbewegungen',
  'booklet.label.estimatedFeedTime': 'Geschätzte Vorschubzeit',
  'booklet.label.feedTravel': 'Vorschubweg',
  'booklet.label.rapidTravel': 'Eilgangweg',
  'booklet.label.topZ': 'Oberes Z',
  'booklet.label.bottomZ': 'Unteres Z',
  'booklet.label.project': 'Projekt',
  'booklet.label.generated': 'Erzeugt',
  'booklet.label.units': 'Einheiten',
  'booklet.label.stockSize': 'Rohteilgröße',
  'booklet.label.originZ': 'Nullpunkt Z',
  'booklet.pdf.title': 'Operations-Broschüre',
  'booklet.pdf.snapshot': 'Operations-Momentaufnahme',
  'booklet.pdf.page': 'Seite {page} von {total}',
  'booklet.section.overview': 'Übersicht',
  'booklet.section.tool': 'Werkzeug',
  'booklet.section.operationSettings': 'Operationseinstellungen',
  'booklet.section.toolpath': 'Werkzeugweg',
  'booklet.section.warnings': 'Warnungen',
}
