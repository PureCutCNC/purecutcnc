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

import type { themeManagerEn } from '../en/themeManager'

/** French theme-manager catalog. */
export const themeManagerFr: Record<keyof typeof themeManagerEn, string> = {
  'themeManager.dialogAria': 'Gérer les thèmes',
  'themeManager.title': 'Gérer les thèmes',
  'themeManager.close': 'Fermer',
  'themeManager.listAria': 'Thèmes',
  'themeManager.builtinBadge': 'Intégré',
  'themeManager.customBadge': 'Personnalisé',
  'themeManager.activeBadge': 'Actif',
  'themeManager.nameLabel': 'Nom du thème',
  'themeManager.saveName': 'Enregistrer le nom',
  'themeManager.familyLabel': 'Famille',
  'themeManager.basedOnLabel': 'Basé sur',
  'themeManager.changedColorsLabel': 'Couleurs modifiées',
  'themeManager.builtinHint': 'Les thèmes intégrés sont en lecture seule. Dupliquez-en un pour créer une copie modifiable.',
  'themeManager.resetNotice': 'Réinitialiser « {name} » à ses couleurs de base {base}.',
  'themeManager.importFailed': 'Échec de l’importation : {error}',
  'themeManager.imported': '« {name} » importé.',
  'themeManager.use': 'Utiliser ce thème',
  'themeManager.edit': 'Modifier',
  'themeManager.duplicateToEdit': 'Dupliquer pour modifier',
  'themeManager.duplicate': 'Dupliquer',
  'themeManager.rename': 'Renommer',
  'themeManager.resetToBase': 'Réinitialiser à la base',
  'themeManager.import': 'Importer un thème',
  'themeManager.export': 'Exporter un thème',
  'themeManager.delete': 'Supprimer le thème',
  'themeManager.systemAria': 'Association au mode système',
  'themeManager.modeTitle': 'Mode',
  'themeManager.fixedMode': 'Thème fixe',
  'themeManager.systemMode': 'Suivre le clair/sombre du système',
  'themeManager.lightSlot': 'Thème clair',
  'themeManager.darkSlot': 'Thème sombre',
  'themeManager.systemPrefersDark': 'Cet appareil préfère actuellement le sombre.',
  'themeManager.systemPrefersLight': 'Cet appareil préfère actuellement le clair.',
  'themeManager.done': 'Terminé',
  'themeEditor.title': 'Modifier le thème',
  'themeEditor.dialogAria': 'Modifier le thème {name}',
  'themeEditor.previewingLive': 'Prévisualisation de vos modifications en direct.',
  'themeEditor.colorsWrong': 'Les couleurs ne semblent pas correctes ?',
  'themeEditor.restoreSaved': 'Restaurer les couleurs enregistrées',
  'themeEditor.basedOn.one': 'Basé sur {base} · {count} couleur modifiée',
  'themeEditor.basedOn.other': 'Basé sur {base} · {count} couleurs modifiées',
  'themeEditor.contrastAria': 'Vérifications du contraste',
  'themeEditor.contrastTitle': 'Vérifications de lisibilité',
  'themeEditor.allChecksPass': 'Les {count} vérifications sont réussies.',
  'themeEditor.blockedLabel': 'Bloqué :',
  'themeEditor.warningLabel': 'Avertissement :',
  'themeEditor.ratioNeeds': '{measured}:1, exige {required}:1',
  'themeEditor.deltaNeeds': 'ΔE {measured}, exige {required}',
  'themeEditor.ratioRecommended': '{measured}:1, recommandé {required}:1',
  'themeEditor.deltaRecommended': 'ΔE {measured}, recommandé {required}',
  'themeEditor.contrastNote': 'Contrôles ponctuels automatisés d’états représentatifs — pas une couverture WCAG complète.',
  'themeEditor.checksFailing.one': '{count} vérification de lisibilité échoue',
  'themeEditor.checksFailing.other': '{count} vérifications de lisibilité échouent',
  'themeEditor.cancel': 'Annuler',
  'themeEditor.apply': 'Appliquer le thème',
  'themeEditor.fixBlockedTitle': 'Corrigez les vérifications de lisibilité bloquantes avant d’appliquer',
  'themeEditor.giveNameTitle': 'Donnez un nom au thème',
  'themeEditor.colorPickerAria': 'Sélecteur de couleur {label}',
  'themeEditor.baseValueTitle': 'Valeur de base : {value}',
  'themeEditor.resetFieldAria': 'Réinitialiser {label} à la valeur de base',
  'themeEditor.resetFieldTitle': 'Réinitialiser à la base ({value})',
  'themePreview.panelTitle': 'Panneau et texte',
  'themePreview.panelText': 'Texte principal sur la surface d’un panneau.',
  'themePreview.panelTextDim': 'Texte d’aide discret pour les indications.',
  'themePreview.controlsTitle': 'Contrôles',
  'themePreview.primary': 'Principal',
  'themePreview.secondary': 'Secondaire',
  'themePreview.disabled': 'Désactivé',
  'themePreview.selectedItem': 'Élément sélectionné',
  'themePreview.focusedControl': 'Contrôle ciblé',
  'themePreview.messagesTitle': 'Messages',
  'themePreview.positive': 'Positif : parcours d’outil généré.',
  'themePreview.warning': 'Avertissement : faible profondeur de passe.',
  'themePreview.danger': 'Danger : collision de bride détectée.',
  'themePreview.canvasTitle': 'Canevas d’esquisse',
  'themePreview.legendLine': 'Ligne',
  'themePreview.legendRegion': 'Région',
  'themePreview.legendConstruction': 'Constr.',
  'themePreview.legendAdd': 'Ajouter',
  'themePreview.legendCut': 'Découper',
}
