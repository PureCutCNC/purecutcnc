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

/** French sketch catalog. */
export const sketchFr: Record<keyof typeof sketchEn, string> = {
  'sketch.target.createFeatures': 'Créer des entités',
  'sketch.target.createLines': 'Créer des lignes',
  'sketch.target.createRegions': 'Créer des régions',
  'sketch.target.createConstruction': 'Créer une géométrie de construction',
  'sketch.target.feature': 'entité',
  'sketch.target.line': 'ligne',
  'sketch.target.region': 'région',
  'sketch.target.construction': 'construction',
  'sketch.shape.rectangle': 'rectangle',
  'sketch.shape.circle': 'cercle',
  'sketch.shape.ellipse': 'ellipse',
  'sketch.shape.polygon': 'polygone',
  'sketch.shape.spline': 'spline',
  'sketch.shape.composite': 'composite',
  'sketch.shape.text': 'texte',
  'sketch.shape.slot': 'lumière',
  'sketch.shape.regularPolygon': 'polygone régulier',
  'sketch.shape.gear': 'engrenage',
  'sketch.shape.roundedRect': 'rectangle arrondi',
  'sketch.shape.chamferedRect': 'rectangle chanfreiné',
  'sketch.creation.addShape': 'Ajouter {target} {shape}',
  'sketch.creation.cancel': 'Annuler {shape}',
  'sketch.creation.cancelTool': 'Annuler l’outil {shape}',
  'sketch.creation.chooseTarget': 'Choisir la forme {target}',
  'sketch.creation.closeDrawer': 'Fermer le tiroir des formes',
  'sketch.transform.copy': 'Copier les entités sélectionnées',
  'sketch.transform.cancelCopy': 'Annuler la copie',
  'sketch.transform.move': 'Déplacer les entités sélectionnées',
  'sketch.transform.cancelMove': 'Annuler le déplacement',
  'sketch.transform.delete': 'Supprimer les entités sélectionnées',
  'sketch.transform.resize': 'Redimensionner les entités sélectionnées',
  'sketch.transform.cancelResize': 'Annuler le redimensionnement',
  'sketch.transform.rotate': 'Faire pivoter les entités sélectionnées',
  'sketch.transform.cancelRotate': 'Annuler la rotation',
  'sketch.transform.mirror': 'Symétrie des entités sélectionnées',
  'sketch.transform.cancelMirror': 'Annuler la symétrie',
  'sketch.boolean.join': 'Joindre les entités fermées',
  'sketch.boolean.cancelJoin': 'Annuler la jonction',
  'sketch.boolean.cut': 'Découper les entités',
  'sketch.boolean.cancelCut': 'Annuler la découpe',
  'sketch.boolean.offset': 'Créer une entité décalée',
  'sketch.boolean.cancelOffset': 'Annuler le décalage',
  'sketch.arrange.align': 'Aligner les entités sélectionnées',
  'sketch.arrange.distribute': 'Répartir les entités sélectionnées',
  'sketch.arrange.closeAlignMenu': 'Fermer le menu d’alignement',
  'sketch.arrange.closeDistributeMenu': 'Fermer le menu de répartition',
  'sketch.edit.addPoint': 'Ajouter un point',
  'sketch.edit.cancelAddPoint': 'Annuler l’ajout de point',
  'sketch.edit.deletePoint': 'Supprimer le point',
  'sketch.edit.cancelDeletePoint': 'Annuler la suppression du point',
  'sketch.edit.deleteSegment': 'Supprimer le segment',
  'sketch.edit.cancelDeleteSegment': 'Annuler la suppression du segment',
  'sketch.edit.disconnect': 'Dissocier le point',
  'sketch.edit.cancelDisconnect': 'Annuler la dissociation',
  'sketch.edit.fillet': 'Arrondir le coin / congé',
  'sketch.edit.cancelFillet': 'Annuler le congé',
  'sketch.edit.chamfer': 'Chanfreiner le coin',
  'sketch.edit.cancelChamfer': 'Annuler le chanfrein',
  'sketch.edit.trim': 'Ajuster à l’arête de coupe',
  'sketch.edit.cancelTrim': 'Annuler l’ajustage',
  'sketch.edit.trimDisabled': 'Ajuster — profils ouverts seulement',
  'sketch.edit.extend': 'Prolonger jusqu’à la cible',
  'sketch.edit.cancelExtend': 'Annuler le prolongement',
  'sketch.edit.extendDisabled': 'Prolonger — profils ouverts seulement',
  'sketch.constraint.add': 'Ajouter une contrainte',
  'sketch.constraint.cancel': 'Annuler la contrainte',
  'sketch.align.left': 'Aligner à gauche',
  'sketch.align.centerHorizontal': 'Centrer horizontalement',
  'sketch.align.right': 'Aligner à droite',
  'sketch.align.top': 'Aligner en haut',
  'sketch.align.centerVertical': 'Centrer verticalement',
  'sketch.align.bottom': 'Aligner en bas',
  'sketch.distribute.horizontalGaps': 'Répartir horizontalement (espaces égaux)',
  'sketch.distribute.horizontalCenters': 'Répartir horizontalement (centres égaux)',
  'sketch.distribute.verticalGaps': 'Répartir verticalement (espaces égaux)',
  'sketch.distribute.verticalCenters': 'Répartir verticalement (centres égaux)',
  'sketch.backdrop.move': 'Déplacer l’arrière-plan',
  'sketch.backdrop.cancelMove': 'Annuler le déplacement de l’arrière-plan',
  'sketch.backdrop.delete': 'Supprimer l’arrière-plan',
  'sketch.backdrop.resize': 'Redimensionner l’arrière-plan',
  'sketch.backdrop.cancelResize': 'Annuler le redimensionnement de l’arrière-plan',
  'sketch.backdrop.rotate': 'Faire pivoter l’arrière-plan',
  'sketch.backdrop.cancelRotate': 'Annuler la rotation de l’arrière-plan',
}
