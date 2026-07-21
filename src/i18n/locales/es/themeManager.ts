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

import { themeManagerEn } from '../en/themeManager'

/** Spanish themeManager interface text. */
export const themeManagerEs: Record<keyof typeof themeManagerEn, string> = {
  "themeManager.dialogAria": "Administrar temas",
  "themeManager.title": "Administrar temas",
  "themeManager.close": "Cerrar",
  "themeManager.listAria": "Temas",
  "themeManager.builtinBadge": "Integrados",
  "themeManager.customBadge": "Personalizados",
  "themeManager.activeBadge": "Activos",
  "themeManager.nameLabel": "Nombre del tema",
  "themeManager.saveName": "Nombre de guardado",
  "themeManager.familyLabel": "Familia",
  "themeManager.basedOnLabel": "Basado en",
  "themeManager.changedColorsLabel": "Colores cambiados",
  "themeManager.builtinHint": "Los temas integrados son de solo lectura. Duplícalos para crear una copia editable.",
  "themeManager.resetNotice": "Restablecer “{name}” a sus colores base {base}.",
  "themeManager.importFailed": "Error al importar: {error}",
  "themeManager.imported": "Importado “{name}”.",
  "themeManager.use": "Usar este tema",
  "themeManager.edit": "Editar",
  "themeManager.duplicateToEdit": "Duplicar para editar",
  "themeManager.duplicate": "Duplicar",
  "themeManager.rename": "Cambiar nombre",
  "themeManager.resetToBase": "Restablecer a la base",
  "themeManager.import": "Importar tema",
  "themeManager.export": "Exportar tema",
  "themeManager.delete": "Eliminar tema",
  "themeManager.systemAria": "Emparejamiento del modo del sistema",
  "themeManager.modeTitle": "Modo",
  "themeManager.fixedMode": "Tema fijo",
  "themeManager.systemMode": "Seguir el modo claro/oscuro del sistema",
  "themeManager.lightSlot": "Tema claro",
  "themeManager.darkSlot": "Tema oscuro",
  "themeManager.systemPrefersDark": "Este dispositivo prefiere el tema oscuro.",
  "themeManager.systemPrefersLight": "Este dispositivo prefiere el tema claro.",
  "themeManager.done": "Listo",
  "themeEditor.title": "Editar tema",
  "themeEditor.dialogAria": "Editar tema {name}",
  "themeEditor.previewingLive": "Previsualización de las ediciones en tiempo real.",
  "themeEditor.colorsWrong": "¿Los colores no se ven bien?",
  "themeEditor.restoreSaved": "Restaurar colores guardados",
  "themeEditor.basedOn.one": "Se cambió {count} color respecto de {base}",
  "themeEditor.basedOn.other": "Se cambiaron {count} colores respecto de {base}",
  "themeEditor.contrastAria": "Comprobaciones de contraste",
  "themeEditor.contrastTitle": "Comprobaciones de legibilidad",
  "themeEditor.allChecksPass": "Todas las comprobaciones de {count} se superaron.",
  "themeEditor.blockedLabel": "Bloqueado:",
  "themeEditor.warningLabel": "Advertencia:",
  "themeEditor.ratioNeeds": "{measured}:1, requiere {required}:1",
  "themeEditor.deltaNeeds": "ΔE {measured}, requiere {required}",
  "themeEditor.ratioRecommended": "{measured}:1, recomendado {required}:1",
  "themeEditor.deltaRecommended": "ΔE {measured}, recomendado {required}",
  "themeEditor.contrastNote": "Comprobaciones automatizadas de estados representativos; cobertura WCAG incompleta.",
  "themeEditor.checksFailing.one": "{count}: error en la comprobación de legibilidad",
  "themeEditor.checksFailing.other": "{count}: error en las comprobaciones de legibilidad",
  "themeEditor.cancel": "Cancelar",
  "themeEditor.apply": "Aplicar tema",
  "themeEditor.fixBlockedTitle": "Corregir las comprobaciones de legibilidad bloqueadas antes de aplicar",
  "themeEditor.giveNameTitle": "Asignar un nombre al tema",
  "themeEditor.colorPickerAria": "{label}: selector de color",
  "themeEditor.baseValueTitle": "Valor base: {value}",
  "themeEditor.resetFieldAria": "Restablecer {label} al valor base",
  "themeEditor.resetFieldTitle": "Restablecer a la base ({value})",
  "themePreview.panelTitle": "Panel y texto",
  "themePreview.panelText": "Texto principal en la superficie del panel.",
  "themePreview.panelTextDim": "Texto de guía atenuado para sugerencias.",
  "themePreview.controlsTitle": "Controles",
  "themePreview.primary": "Principal",
  "themePreview.secondary": "Secundario",
  "themePreview.disabled": "Deshabilitado",
  "themePreview.selectedItem": "Elemento seleccionado",
  "themePreview.focusedControl": "Control enfocado",
  "themePreview.messagesTitle": "Mensajes",
  "themePreview.positive": "Positivo: trayectoria de herramienta generada.",
  "themePreview.warning": "Advertencia: profundidad de pasada insuficiente.",
  "themePreview.danger": "Peligro: colisión de mordaza detectada.",
  "themePreview.canvasTitle": "Lienzo de croquis",
  "themePreview.legendLine": "Línea",
  "themePreview.legendRegion": "Región",
  "themePreview.legendConstruction": "Construcción",
  "themePreview.legendAdd": "Añadir",
  "themePreview.legendCut": "Cortar",
}
