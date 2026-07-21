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

import { languageManagerEn } from '../en/languageManager'

/** Spanish languageManager interface text. */
export const languageManagerEs: Record<keyof typeof languageManagerEn, string> = {
  "langManager.manageEntry": "Gestionar idiomas…",
  "langManager.manageDetail": "Crear, editar, importar, exportar",
  "langManager.title": "Gestionar idiomas",
  "langManager.builtinBadge": "Integrados",
  "langManager.customBadge": "Personalizados",
  "langManager.progress": "{translated} de {total} traducidos",
  "langManager.activeBadge": "Activos",
  "langManager.use": "Usar este idioma",
  "langManager.duplicate": "Duplicar y editar",
  "langManager.duplicateHint": "Duplicar el inglés crea un nuevo idioma desde cero; duplicar cualquier otro idioma comienza con sus traducciones.",
  "langManager.edit": "Editar",
  "langManager.rename": "Cambiar nombre",
  "langManager.renameLabel": "Nombre del idioma",
  "langManager.saveName": "Guardar nombre",
  "langManager.export": "Exportar idioma",
  "langManager.import": "Importar idioma",
  "langManager.delete": "Eliminar idioma",
  "langManager.done": "Listo",
  "langManager.close": "Cerrar",
  "langManager.baseLabel": "Basado en",
  "langManager.tagLabel": "Etiqueta de idioma",
  "langManager.importFailed": "Importación fallida: {error}",
  "langManager.imported": "Importado “{name}”.",
  "langManager.importPlaceholderIssues.one": "Se importó “{name}” con un marcador de posición incorrecto en {count}. Abra el editor para revisarlo.",
  "langManager.importPlaceholderIssues.other": "Se importó “{name}” con marcadores de posición incorrectos en {count}. Abra el editor para revisarlos.",
  "langManager.deleted": "Se eliminó “{name}”.",
  "langEditor.title": "Editar idioma — {name}",
  "langEditor.nameLabel": "Nombre del idioma",
  "langEditor.tagLabel": "Etiqueta de idioma BCP-47",
  "langEditor.tagHint": "Controla el atributo de idioma del documento y las reglas de plural (p. ej., \"de\", \"pt-BR\").",
  "langEditor.tagInvalid": "Introduzca una etiqueta BCP-47 válida, como \"de\" o \"pt-BR\".",
  "langEditor.progress": "{translated} / {total} traducido",
  "langEditor.searchPlaceholder": "Buscar claves y texto…",
  "langEditor.filterLabel": "Mostrar",
  "langEditor.filterAll": "Todas las cadenas",
  "langEditor.filterUntranslated": "Solo sin traducir",
  "langEditor.filterEdited": "Solo editado",
  "langEditor.sourceLabel": "Inglés",
  "langEditor.baseLabel": "Inglés ({base})",
  "langEditor.inputPlaceholder": "Sin traducir: se utiliza el idioma base",
  "langEditor.placeholderIssue": "Los marcadores de posición deben coincidir exactamente con el texto en inglés: se esperaba {expected}.",
  "langEditor.placeholderIssuesBlockApply.one": "{count} tiene un error de coincidencia en los marcadores de posición; corríjalo antes de aplicar.",
  "langEditor.placeholderIssuesBlockApply.other": "{count} tiene errores de coincidencia en los marcadores de posición; corríjalos antes de aplicar.",
  "langEditor.resetKey": "Restablecer",
  "langEditor.preview": "Vista previa en la aplicación",
  "langEditor.previewing": "Vista previa: Cancelar restaura la versión guardada",
  "langEditor.apply": "Aplicar",
  "langEditor.cancel": "Cancelar",
  "langEditor.noMatches": "No se encontraron cadenas que coincidan con la búsqueda y el filtro actuales.",
  "langEditor.sectionCount": "{translated}/{total}",
}
