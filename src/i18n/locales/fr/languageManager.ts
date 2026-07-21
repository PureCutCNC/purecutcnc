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

import type { languageManagerEn } from '../en/languageManager'

/** French language-manager catalog. */
export const languageManagerFr: Record<keyof typeof languageManagerEn, string> = {
  'langManager.manageEntry': 'Gérer les langues…',
  'langManager.manageDetail': 'Créer, modifier, importer, exporter',
  'langManager.title': 'Gérer les langues',
  'langManager.builtinBadge': 'Intégrée',
  'langManager.customBadge': 'Personnalisée',
  'langManager.progress': '{translated} sur {total} traduites',
  'langManager.activeBadge': 'Active',
  'langManager.use': 'Utiliser cette langue',
  'langManager.duplicate': 'Dupliquer et modifier',
  'langManager.duplicateHint': 'Dupliquer l’anglais crée une nouvelle langue vierge ; dupliquer une autre langue reprend ses traductions.',
  'langManager.edit': 'Modifier',
  'langManager.rename': 'Renommer',
  'langManager.renameLabel': 'Nom de la langue',
  'langManager.saveName': 'Enregistrer le nom',
  'langManager.export': 'Exporter la langue',
  'langManager.import': 'Importer une langue',
  'langManager.delete': 'Supprimer la langue',
  'langManager.done': 'Terminé',
  'langManager.close': 'Fermer',
  'langManager.baseLabel': 'Basée sur',
  'langManager.tagLabel': 'Balise de langue',
  'langManager.importFailed': 'Échec de l’importation : {error}',
  'langManager.imported': '« {name} » importée.',
  'langManager.importPlaceholderIssues.one': '« {name} » importée avec {count} paramètre de remplacement non concordant — ouvrez l’éditeur pour le vérifier.',
  'langManager.importPlaceholderIssues.other': '« {name} » importée avec {count} paramètres de remplacement non concordants — ouvrez l’éditeur pour les vérifier.',
  'langManager.deleted': '« {name} » supprimée.',
  'langEditor.title': 'Modifier la langue — {name}',
  'langEditor.nameLabel': 'Nom de la langue',
  'langEditor.tagLabel': 'Balise de langue BCP-47',
  'langEditor.tagHint': 'Détermine l’attribut de langue du document et les règles de pluriel (p. ex. « de », « pt-BR »).',
  'langEditor.tagInvalid': 'Saisissez une balise BCP-47 valide, comme « de » ou « pt-BR ».',
  'langEditor.progress': '{translated} / {total} traduites',
  'langEditor.searchPlaceholder': 'Rechercher des clés et du texte…',
  'langEditor.filterLabel': 'Afficher',
  'langEditor.filterAll': 'Toutes les chaînes',
  'langEditor.filterUntranslated': 'Non traduites seulement',
  'langEditor.filterEdited': 'Modifiées seulement',
  'langEditor.sourceLabel': 'Anglais',
  'langEditor.baseLabel': 'Base ({base})',
  'langEditor.inputPlaceholder': 'Non traduit — revient à la langue de base',
  'langEditor.placeholderIssue': 'Les paramètres de remplacement doivent correspondre exactement à la source anglaise : {expected}.',
  'langEditor.placeholderIssuesBlockApply.one': '{count} traduction a un paramètre de remplacement non concordant — corrigez-la avant d’appliquer.',
  'langEditor.placeholderIssuesBlockApply.other': '{count} traductions ont des paramètres de remplacement non concordants — corrigez-les avant d’appliquer.',
  'langEditor.resetKey': 'Réinitialiser',
  'langEditor.preview': 'Prévisualiser dans l’application',
  'langEditor.previewing': 'Prévisualisation — Annuler restaure la version enregistrée',
  'langEditor.apply': 'Appliquer',
  'langEditor.cancel': 'Annuler',
  'langEditor.noMatches': 'Aucune chaîne ne correspond à la recherche et au filtre actuels.',
  'langEditor.sectionCount': '{translated}/{total}',
}
