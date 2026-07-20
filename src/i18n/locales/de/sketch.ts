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

import type { sketchEn } from '../en/sketch'

/** German sketch-surface translations. See `src/i18n/GLOSSARY.md`. */
export const sketchDe: Record<keyof typeof sketchEn, string> = {
  'sketch.target.createFeatures': 'Features erstellen',
  'sketch.target.createLines': 'Linien erstellen',
  'sketch.target.createRegions': 'Bereiche erstellen',
  'sketch.target.createConstruction': 'Konstruktionsgeometrie erstellen',
  'sketch.target.feature': 'Feature',
  'sketch.target.line': 'Linie',
  'sketch.target.region': 'Bereich',
  'sketch.target.construction': 'Konstruktion',

  'sketch.shape.rectangle': 'Rechteck',
  'sketch.shape.circle': 'Kreis',
  'sketch.shape.ellipse': 'Ellipse',
  'sketch.shape.polygon': 'Polygon',
  'sketch.shape.spline': 'Spline',
  'sketch.shape.composite': 'Verbund',
  'sketch.shape.text': 'Text',
  'sketch.shape.slot': 'Langloch',
  'sketch.shape.regularPolygon': 'regelmäßiges Polygon',
  'sketch.shape.gear': 'Zahnrad',
  'sketch.shape.roundedRect': 'abgerundetes Rechteck',
  'sketch.shape.chamferedRect': 'angefastes Rechteck',

  'sketch.creation.addShape': '{target} {shape} hinzufügen',
  'sketch.creation.cancel': '{shape} abbrechen',
  'sketch.creation.cancelTool': '{shape}-Werkzeug abbrechen',
  'sketch.creation.chooseTarget': '{target}-Form wählen',
  'sketch.creation.closeDrawer': 'Formen-Schublade schließen',

  'sketch.transform.copy': 'Ausgewählte Features kopieren',
  'sketch.transform.cancelCopy': 'Kopieren abbrechen',
  'sketch.transform.move': 'Ausgewählte Features verschieben',
  'sketch.transform.cancelMove': 'Verschieben abbrechen',
  'sketch.transform.delete': 'Ausgewählte Features löschen',
  'sketch.transform.resize': 'Größe der ausgewählten Features ändern',
  'sketch.transform.cancelResize': 'Größenänderung abbrechen',
  'sketch.transform.rotate': 'Ausgewählte Features drehen',
  'sketch.transform.cancelRotate': 'Drehen abbrechen',
  'sketch.transform.mirror': 'Ausgewählte Features spiegeln',
  'sketch.transform.cancelMirror': 'Spiegeln abbrechen',

  'sketch.boolean.join': 'Geschlossene Features vereinigen',
  'sketch.boolean.cancelJoin': 'Vereinigen abbrechen',
  'sketch.boolean.cut': 'Features abziehen',
  'sketch.boolean.cancelCut': 'Abziehen abbrechen',
  'sketch.boolean.offset': 'Offset-Feature erstellen',
  'sketch.boolean.cancelOffset': 'Offset abbrechen',

  'sketch.arrange.align': 'Ausgewählte Features ausrichten',
  'sketch.arrange.distribute': 'Ausgewählte Features verteilen',
  'sketch.arrange.closeAlignMenu': 'Ausrichtungsmenü schließen',
  'sketch.arrange.closeDistributeMenu': 'Verteilungsmenü schließen',

  'sketch.edit.addPoint': 'Punkt hinzufügen',
  'sketch.edit.cancelAddPoint': 'Punkt hinzufügen abbrechen',
  'sketch.edit.deletePoint': 'Punkt löschen',
  'sketch.edit.cancelDeletePoint': 'Punkt löschen abbrechen',
  'sketch.edit.deleteSegment': 'Segment löschen',
  'sketch.edit.cancelDeleteSegment': 'Segment löschen abbrechen',
  'sketch.edit.disconnect': 'Punkt trennen',
  'sketch.edit.cancelDisconnect': 'Trennen abbrechen',
  'sketch.edit.fillet': 'Ecke verrunden',
  'sketch.edit.cancelFillet': 'Verrundung abbrechen',
  'sketch.edit.chamfer': 'Ecke anfasen',
  'sketch.edit.cancelChamfer': 'Fase abbrechen',
  'sketch.edit.trim': 'Auf Schnittkante stutzen',
  'sketch.edit.cancelTrim': 'Stutzen abbrechen',
  'sketch.edit.trimDisabled': 'Stutzen – nur offene Profile',
  'sketch.edit.extend': 'Auf Ziel dehnen',
  'sketch.edit.cancelExtend': 'Dehnen abbrechen',
  'sketch.edit.extendDisabled': 'Dehnen – nur offene Profile',

  'sketch.constraint.add': 'Bedingung hinzufügen',
  'sketch.constraint.cancel': 'Bedingung abbrechen',

  'sketch.align.left': 'Links ausrichten',
  'sketch.align.centerHorizontal': 'Horizontal zentrieren',
  'sketch.align.right': 'Rechts ausrichten',
  'sketch.align.top': 'Oben ausrichten',
  'sketch.align.centerVertical': 'Vertikal zentrieren',
  'sketch.align.bottom': 'Unten ausrichten',

  'sketch.distribute.horizontalGaps': 'Horizontal verteilen (gleiche Abstände)',
  'sketch.distribute.horizontalCenters': 'Horizontal verteilen (gleiche Zentren)',
  'sketch.distribute.verticalGaps': 'Vertikal verteilen (gleiche Abstände)',
  'sketch.distribute.verticalCenters': 'Vertikal verteilen (gleiche Zentren)',

  'sketch.backdrop.move': 'Hintergrund verschieben',
  'sketch.backdrop.cancelMove': 'Hintergrund verschieben abbrechen',
  'sketch.backdrop.delete': 'Hintergrund löschen',
  'sketch.backdrop.resize': 'Hintergrundgröße ändern',
  'sketch.backdrop.cancelResize': 'Größenänderung des Hintergrunds abbrechen',
  'sketch.backdrop.rotate': 'Hintergrund drehen',
  'sketch.backdrop.cancelRotate': 'Hintergrund drehen abbrechen',
}
