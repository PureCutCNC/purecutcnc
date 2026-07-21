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

/** French viewport catalog. */
export const viewportFr: Record<keyof typeof viewportEn, string> = {
  'viewport.presets.top': 'Vue de dessus',
  'viewport.presets.bottom': 'Vue de dessous',
  'viewport.presets.front': 'Vue de face',
  'viewport.presets.back': 'Vue arrière',
  'viewport.presets.right': 'Vue de droite',
  'viewport.presets.left': 'Vue de gauche',
  'viewport.presets.iso': 'Vue isométrique',
  'viewport.sim.modeLabel': 'Mode de simulation',
  'viewport.sim.modeSelected': 'Sélectionné',
  'viewport.sim.modeVisible': 'Visible',
  'viewport.sim.detailLabel': 'Détail',
  'viewport.sim.detailTitle': 'Détail de la simulation',
  'viewport.sim.playTool': 'Lire l’outil',
  'viewport.sim.playToolDisabledMode': 'Passez au mode Sélectionné pour lire l’outil',
  'viewport.sim.playToolDisabledNoOp': 'Sélectionnez une opération avec un parcours d’outil valide à lire',
  'viewport.sim.playToolToggle': 'Basculer la lecture de l’outil',
  'viewport.sim.webglUnavailableTitle': 'La simulation 3D n’est pas disponible',
  'viewport.sim.webglUnavailableBody': 'Cette vue nécessite WebGL2, que votre navigateur ou pilote graphique ne fournit pas. Essayez de mettre à jour votre navigateur ou d’activer l’accélération matérielle dans ses paramètres.',
  'viewport.sim.webglLostTitle': 'Contexte graphique 3D perdu',
  'viewport.sim.webglLostBody': 'En attente de sa restauration par le navigateur — la lecture est en pause. Si ce message persiste, rechargez l’application.',
  'viewport.sim.play': 'Lire',
  'viewport.sim.pause': 'Pause',
  'viewport.sim.stop': 'Arrêter et réinitialiser',
  'viewport.sim.progressAria': 'Progression de la lecture',
  'viewport.sim.speedLabel': 'Vitesse',
  'viewport.sim.speedTooltipFeed': 'Multiplicateur de vitesse de l’avance de l’opération ({feed} = 1×). Actuel : {multiplier}',
  'viewport.sim.speedTooltipFallback': 'Multiplicateur de vitesse de l’avance de secours ({feed} = 1×). Actuel : {multiplier}',
  'viewport.sim.speedAria': 'Multiplicateur de vitesse de lecture',
  'viewport.sim.stepLabel': 'Pas',
  'viewport.sim.stepTooltip': 'Distance maximale parcourue par l’outil par image. Plus petit = mouvement plus fluide, plus grand = lecture plus rapide.',
  'viewport.sim.feedTooltip': 'Avance de coupe du mouvement actuel. Les coupes de poche en rainurage réduit affichent ici leur avance ajustée ; la couleur du point indique le type de mouvement (les rapides n’ont pas d’avance).',
  'viewport.sim.moveKindIdle': 'Inactif',
  'viewport.about.ariaLabel': 'À propos de PureCutCNC',
  'viewport.about.title': 'À propos',
  'viewport.about.close': 'Fermer',
  'viewport.about.version': 'Version {version}',
  'viewport.about.tagline': 'CAO/FAO 2,5D pour les amateurs de CNC — esquisse et usinage dans un seul flux de travail, sur le web ou sur votre bureau.',
  'viewport.about.releaseLabel': 'Version',
  'viewport.about.releasedLabel': 'Publié',
  'viewport.about.website': 'Site web',
  'viewport.about.source': 'Source',
  'viewport.about.releases': 'Versions',
  'viewport.about.license': 'Licence (Apache-2.0)',
  'viewport.about.supportText': 'PureCutCNC est gratuit et le restera — mais sa création et sa maintenance demandent du temps et de l’argent. S’il vous aide, un café permet de continuer.',
  'viewport.about.buyCoffee': 'M’offrir un café',
  'viewport.empty.title': 'Commencez votre pièce',
  'viewport.empty.subtitle': 'Dessinez une forme, importez un fichier ou ouvrez un exemple terminé pour voir le flux de travail complet.',
  'viewport.empty.drawTitle': 'Dessiner une forme',
  'viewport.empty.drawMeta': 'Esquissez un rectangle sur le canevas',
  'viewport.empty.importTitle': 'Importer un fichier',
  'viewport.empty.importMeta': 'Fichiers SVG, DXF, OBJ, STL ou CAMJ',
  'viewport.empty.examplesLabel': 'Ouvrir un exemple…',
  'viewport.error.eyebrow': 'Un problème est survenu',
  'viewport.error.title': 'Désolé — PureCutCNC n’a pas pu démarrer sur cet appareil.',
  'viewport.error.body': 'Cela signifie généralement que votre navigateur ou système d’exploitation ne prend pas en charge les fonctions graphiques 3D nécessaires. Essayez une version récente de Chrome, Edge ou Firefox sur un ordinateur ou une tablette relativement récente, ou utilisez une de nos versions de bureau.',
  'viewport.error.showDetails': 'Afficher les détails techniques',
  'viewport.error.reload': 'Recharger',
  'viewport.error.desktopDownloads': 'Téléchargements de bureau',
  'viewport.error.projectWebsite': 'Site du projet',
  'viewport.error.userAgent': 'Agent utilisateur :',
  'viewport.error.timestamp': 'Horodatage :',
}
