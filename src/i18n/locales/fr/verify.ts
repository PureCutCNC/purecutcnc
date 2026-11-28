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

/** French Verify mode translations (issue #1269). */
export const verifyFr: Record<keyof typeof verifyEn, string> = {
  'verify.mode': 'Vérifier',
  'verify.modeTitle': 'Vérifier la trajectoire : comparer le modèle, la trajectoire interne et le programme exporté',
  'verify.panelLabel': 'Vérifier la trajectoire exportée',
  'verify.comparisonLabel': 'Comparer',
  'verify.comparison.modelInternal': 'Modèle ↔ Interne',
  'verify.comparison.modelExported': 'Modèle ↔ Exportée',
  'verify.comparison.internalExported': 'Interne ↔ Exportée',
  'verify.comparisonHint.modelInternal': 'Brut usiné par les trajectoires générées, comparé au modèle.',
  'verify.comparisonHint.modelExported': 'Brut usiné par le programme exporté, relu, comparé au modèle.',
  'verify.comparisonHint.internalExported': 'Le programme exporté comparé aux trajectoires générées.',
  'verify.scopeUpto': 'Toutes les opérations visibles jusqu’à {operation}',
  'verify.scopeAll': 'Toutes les opérations visibles de {setup}',
  'verify.run': 'Lancer la vérification',
  'verify.cancel': 'Annuler',
  'verify.running': 'Vérification… {done} sur {total}',
  'verify.idle': 'La vérification ne s’exécute qu’à votre demande. Choisissez une comparaison et lancez-la.',
  'verify.failed': 'La vérification n’a pas pu se terminer. Réessayez ; la console contient les détails.',
  'verify.stale.projectEdited': 'Périmé : le projet a changé depuis ce résultat. Relancez la vérification pour le mettre à jour.',
  'verify.stale.requestChanged': 'Périmé : ce résultat concerne une autre comparaison, opération, mise en position ou résolution. Relancez la vérification pour le mettre à jour.',
  'verify.summary': '{verified} vérifiées · {deviation} avec écarts · {unverified} non vérifiées',
  'verify.runUnverified': 'Non vérifié : {reason}',
  'verify.resultsLabel': 'Résultats de la vérification',
  'verify.legendLabel': 'Légende des couleurs',
  'verify.verdict.verified': 'Vérifiée',
  'verify.verdict.deviation': 'Écart',
  'verify.verdict.unverified': 'Non vérifiée',
  'verify.kind.gouge': 'Surcoupe',
  'verify.kind.intendedLeftover': 'Surépaisseur prévue',
  'verify.kind.unintendedLeftover': 'Reste non prévu',
  'verify.kind.missingCut': 'Coupe manquante',
  'verify.kind.extraCut': 'Coupe en trop',
  'verify.kind.feed': 'Avance',
  'verify.kind.unverified': 'Opération non vérifiée',
  'verify.findingRegion': '{area} · max {size}',
  'verify.findingDistance': '{size} de l’autre trajectoire',
  'verify.findingNoCounterpart': 'Aucune coupe correspondante sur l’autre trajectoire',
  'verify.findingFeed': 'Avance {actual} au lieu de {expected}',
  'verify.findingFeedMissing': 'Aucune avance indiquée ; {expected} attendu',
  'verify.moreDeviations': '{count} autres écarts non listés',
  'verify.noFindings': 'Aucun écart',
  'verify.unattributed': 'Matière qu’aucune opération n’a usinée',
  'verify.findingFocus': 'Afficher dans la vue',
  'verify.reasonAtLine': '{reason} (ligne {line})',
  'verify.reason.aroundSetup': 'une mise en position Autour n’est pas encore comparée au modèle',
  'verify.reason.rotaryOperation': 'une opération rotative n’est pas encore comparée au modèle',
  'verify.reason.rotaryMotion': 'un mouvement fait tourner l’axe rotatif pendant la coupe',
  'verify.reason.unsupportedSetup': 'cette orientation de mise en position ne peut pas être usinée',
  'verify.reason.uptoOperationNotFound': 'l’opération sélectionnée n’a rien à rejouer',
  'verify.reason.noModel': 'le projet n’a aucun modèle de comparaison',
  'verify.reason.exportUnsupported': 'le programme exporté contient une construction qui ne peut pas être relue',
  'verify.reason.exportFailed': 'le programme n’a pas pu être produit ni relu',
  'verify.reason.noCutMoves': 'aucune des deux trajectoires n’a de mouvement de coupe',
  'verify.reason.unparsedText': 'le programme contient du texte qui n’est pas du G-code',
  'verify.reason.unsupportedCommand': 'le mouvement de {command} ne peut pas être reconstruit',
  'verify.reason.machineCoordinateRetract': 'un dégagement en coordonnées machine (G53)',
  'verify.reason.machineCoordinateMove': 'un mouvement en coordonnées machine qui n’est pas un dégagement',
  'verify.reason.rapidAfterMachineRetract': 'un rapide après un dégagement G53 n’indique pas Z',
  'verify.reason.workZUnknown': 'un mouvement d’avance après un dégagement G53 n’indique pas Z',
  'verify.reason.motionWithoutMode': 'des coordonnées avant tout mode de déplacement',
  'verify.reason.inverseTimeFeedMissing': 'un mouvement en temps inverse sans son propre F',
  'verify.reason.arcCentreMissing': 'un arc sans centre ni rayon',
  'verify.reason.arcRadiusTooSmall': 'un arc dont le rayon ne relie pas ses extrémités',
  'verify.reason.cannedCycleIncomplete': 'un cycle fixe sans le Z, R ou Q nécessaire',
  'verify.reason.cannedCycleWithRotary': 'un cycle fixe qui fait aussi tourner l’axe rotatif',
  'verify.reason.cannedRetractModeAssumed': 'aucun G98/G99 avant un cycle fixe ; G98 supposé',
  'verify.reason.chipBreakRetractApproximate': 'un dégagement de brise-copeaux est lu de façon approchée',
  'verify.reason.probeMove': 'un mouvement de palpage',
  'verify.reason.touchOffZ': 'une prise d’origine en Z',
  'verify.reason.rotaryZeroed': 'l’axe rotatif est remis à zéro dans le programme',
  'verify.reason.workOffsetChange': 'l’origine pièce change dans le programme',
  'verify.reason.parseFailure': 'le programme n’a pas pu être lu',
  'verify.reason.unsupportedStatement': 'une instruction qui ne peut pas être reconstruite',
  'verify.reason.emptyProgram': 'le post-processeur n’a écrit aucun programme',
  'verify.reason.operationRefused': 'le post-processeur a refusé l’opération',
  'verify.reason.postFailed': 'le post-processeur a échoué',
  'verify.reason.noTool': 'l’opération n’a pas d’outil utilisable',
  'verify.reason.axisNotStated': 'le programme n’indique jamais l’axe {axis}',
  'verify.reason.manualIndexTurnRemoved': 'la rotation initiale d’indexation manuelle a été retirée des angles',
  'verify.reason.noToolpath': 'sa trajectoire n’a pas pu être générée',
  'verify.reason.noMachine': 'aucune machine n’est sélectionnée pour l’export',
  'verify.reason.noOperations': 'aucune opération visible avec trajectoire jusqu’à la sélection',
}
