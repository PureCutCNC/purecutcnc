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

import type { viewportEn } from '../en/viewport'

/** German viewport / simulation / about / error translations. */
export const viewportDe: Record<keyof typeof viewportEn, string> = {
  'viewport.presets.top': 'Draufsicht',
  'viewport.presets.bottom': 'Untersicht',
  'viewport.presets.front': 'Vorderansicht',
  'viewport.presets.back': 'Rückansicht',
  'viewport.presets.right': 'Ansicht rechts',
  'viewport.presets.left': 'Ansicht links',
  'viewport.presets.iso': 'Isometrische Ansicht',

  'viewport.sim.modeLabel': 'Simulationsmodus',
  'viewport.sim.modeSelected': 'Ausgewählt',
  'viewport.sim.modeVisible': 'Sichtbar',
  'viewport.sim.detailLabel': 'Detail',
  'viewport.sim.detailTitle': 'Simulationsdetail',
  'viewport.sim.playTool': 'Werkzeug abspielen',
  'viewport.sim.playToolDisabledMode': 'Zum Modus „Ausgewählt" wechseln, um die Werkzeug-Wiedergabe zu nutzen',
  'viewport.sim.playToolDisabledNoOp': 'Operation mit gültigem Werkzeugweg zum Abspielen auswählen',
  'viewport.sim.playToolToggle': 'Werkzeug-Wiedergabe umschalten',
  'viewport.sim.webglUnavailableTitle': '3D-Simulation ist nicht verfügbar',
  'viewport.sim.webglUnavailableBody': 'Diese Ansicht benötigt WebGL2, das Ihr Browser oder Grafiktreiber nicht bereitgestellt hat. Aktualisieren Sie Ihren Browser oder aktivieren Sie die Hardwarebeschleunigung in dessen Einstellungen.',
  'viewport.sim.webglLostTitle': '3D-Grafikkontext verloren',
  'viewport.sim.webglLostBody': 'Warten auf Wiederherstellung durch den Browser – die Wiedergabe wurde pausiert. Falls diese Meldung bestehen bleibt, laden Sie die App neu.',
  'viewport.sim.play': 'Abspielen',
  'viewport.sim.pause': 'Pause',
  'viewport.sim.stop': 'Stopp & Zurücksetzen',
  'viewport.sim.progressAria': 'Wiedergabefortschritt',
  'viewport.sim.speedLabel': 'Geschwindigkeit',
  'viewport.sim.speedTooltipFeed': 'Geschwindigkeitsfaktor des Operationsvorschubs ({feed} = 1×). Aktuell: {multiplier}',
  'viewport.sim.speedTooltipFallback': 'Geschwindigkeitsfaktor des Ersatzvorschubs ({feed} = 1×). Aktuell: {multiplier}',
  'viewport.sim.speedAria': 'Wiedergabe-Geschwindigkeitsfaktor',
  'viewport.sim.stepLabel': 'Schritt',
  'viewport.sim.stepTooltip': 'Maximale Distanz, die das Werkzeug pro Frame vorrückt. Kleiner = flüssigere Bewegung, größer = schnellere Wiedergabe.',
  'viewport.sim.feedTooltip': 'Schnittvorschub der aktuellen Bewegung. Reduzierte Nutschnitte in Taschen zeigen hier ihren skalierten Vorschub; die Punktfarbe kennzeichnet die Bewegungsart (Eilgänge haben keinen Vorschub).',
  'viewport.sim.moveKindIdle': 'Leerlauf',

  'viewport.about.ariaLabel': 'Über PureCutCNC',
  'viewport.about.title': 'Über',
  'viewport.about.close': 'Schließen',
  'viewport.about.version': 'Version {version}',
  'viewport.about.tagline': '2.5D-CAD/CAM für CNC-Hobbyisten – Skizzieren und Bearbeiten in einem Ablauf, im Web oder auf dem Desktop.',
  'viewport.about.releaseLabel': 'Release',
  'viewport.about.releasedLabel': 'Veröffentlicht',
  'viewport.about.website': 'Website',
  'viewport.about.source': 'Quelltext',
  'viewport.about.releases': 'Releases',
  'viewport.about.license': 'Lizenz (Apache-2.0)',
  'viewport.about.supportText': 'PureCutCNC ist kostenlos und bleibt kostenlos – doch Entwicklung und Pflege kosten echte Zeit und echtes Geld. Wenn es Ihnen hilft, hält ein Kaffee es am Laufen.',
  'viewport.about.buyCoffee': 'Einen Kaffee spendieren',

  'viewport.empty.title': 'Ihr Werkstück beginnen',
  'viewport.empty.subtitle': 'Zeichnen Sie eine Form, importieren Sie eine Datei oder öffnen Sie ein fertiges Beispiel, um den gesamten Ablauf zu sehen.',
  'viewport.empty.drawTitle': 'Form zeichnen',
  'viewport.empty.drawMeta': 'Ein Rechteck auf der Zeichenfläche skizzieren',
  'viewport.empty.importTitle': 'Datei importieren',
  'viewport.empty.importMeta': 'SVG-, DXF-, OBJ-, STL- oder CAMJ-Dateien',
  'viewport.empty.examplesLabel': 'Beispiel öffnen…',

  'viewport.error.eyebrow': 'Etwas ist schiefgelaufen',
  'viewport.error.title': 'Entschuldigung – PureCutCNC konnte auf diesem Gerät nicht starten.',
  'viewport.error.body': 'Das bedeutet meist, dass Ihr Browser oder Betriebssystem die vom Programm benötigten 3D-Grafikfunktionen nicht unterstützt. Versuchen Sie eine aktuelle Version von Chrome, Edge oder Firefox auf einem einigermaßen aktuellen Desktop oder Tablet, oder verwenden Sie eine unserer Desktop-Versionen.',
  'viewport.error.showDetails': 'Technische Details anzeigen',
  'viewport.error.reload': 'Neu laden',
  'viewport.error.desktopDownloads': 'Desktop-Downloads',
  'viewport.error.projectWebsite': 'Projekt-Website',

  'viewport.error.userAgent': 'User-Agent:',
  'viewport.error.timestamp': 'Zeitstempel:',
}
