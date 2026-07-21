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

import { bookletEn } from '../en/booklet'

/** Spanish operation-booklet catalog. */
export const bookletEs: Record<keyof typeof bookletEn, string> = {
  "booklet.operation.pocket": "Cajera",
  "booklet.operation.vCarve": "V-carve",
  "booklet.operation.vCarveMedial": "V-carve medial",
  "booklet.operation.insideEdgeRoute": "Fresado de borde interior",
  "booklet.operation.outsideEdgeRoute": "Fresado de borde exterior",
  "booklet.operation.surfaceClean": "Limpieza de superficie",
  "booklet.operation.roughSurface": "Desbaste de superficie",
  "booklet.operation.finishSurface": "Acabado de superficie",
  "booklet.operation.finishSurfaceCleanup": "Limpieza de acabado superficial",
  "booklet.operation.followLine": "Seguir línea",
  "booklet.operation.drilling": "Taladrado",
  "booklet.pass.finish": "Acabado",
  "booklet.pass.rough": "Desbaste",
  "booklet.cutDirection.climb": "En concordancia",
  "booklet.cutDirection.conventional": "En oposición",
  "booklet.machiningOrder.featureFirst": "Primero por elemento",
  "booklet.machiningOrder.levelFirst": "Primero por nivel",
  "booklet.target.stock": "Material en bruto",
  "booklet.target.missingFeature": "Elemento faltante {id}",
  "booklet.units.inch": "Pulgada",
  "booklet.units.millimeter": "Milímetro",
  "booklet.duration.seconds": "{seconds} s",
  "booklet.duration.minutesSeconds": "{minutes} min {seconds} s",
  "booklet.duration.hoursMinutesSeconds": "{hours} h {minutes} min {seconds} s",
  "booklet.value.unavailable": "No disponible",
  "booklet.value.noToolSelected": "No se ha seleccionado ninguna herramienta",
  "booklet.value.enabled": "Activado",
  "booklet.value.notGenerated": "No generado",
  "booklet.value.slotFeed": "{percent} % de avance",
  "booklet.value.unavailableInvalidFeed": "No disponible (avance no válido)",
  "booklet.value.estimatedFeedTime": "{duration} (no incluye el tiempo de rápidos G0)",
  "booklet.value.feedTravel": "{distance} (movimientos de avance y penetración)",
  "booklet.value.rapidTravel": "{distance} (velocidad G0 definida por la máquina)",
  "booklet.label.tool": "Herramienta",
  "booklet.label.name": "Nombre",
  "booklet.label.type": "Tipo",
  "booklet.label.diameter": "Diámetro",
  "booklet.label.vBitAngle": "Ángulo de fresa en V",
  "booklet.label.flutes": "Estrías",
  "booklet.label.material": "Material",
  "booklet.label.maxCutDepth": "Profundidad máxima de corte",
  "booklet.label.kind": "Tipo",
  "booklet.label.pass": "Pasada",
  "booklet.label.target": "Objetivo",
  "booklet.label.feed": "Avance",
  "booklet.label.plungeFeed": "Avance de penetración",
  "booklet.label.rpm": "RPM",
  "booklet.label.stepdown": "Profundidad de pasada",
  "booklet.label.stepover": "Paso lateral",
  "booklet.label.cutDirection": "Dirección de corte",
  "booklet.label.machiningOrder": "Orden de mecanizado",
  "booklet.label.roundOutsideCorners": "Esquinas exteriores redondeadas",
  "booklet.label.pattern": "Patrón",
  "booklet.label.pocketAngle": "Ángulo de la cajera",
  "booklet.label.slotFeed": "Avance de ranura",
  "booklet.label.drillType": "Tipo de taladrado",
  "booklet.label.peckDepth": "Profundidad de picoteo",
  "booklet.label.dwellTime": "Tiempo de permanencia",
  "booklet.label.retractHeight": "Altura de retracción",
  "booklet.label.carveDepth": "Profundidad de tallado",
  "booklet.label.stockToLeaveRadial": "Material a dejar radial",
  "booklet.label.stockToLeaveAxial": "Material a dejar axial",
  "booklet.label.toolpath": "Trayectoria de herramienta",
  "booklet.label.moves": "Movimientos",
  "booklet.label.cutMoves": "Movimientos de corte",
  "booklet.label.rapidMoves": "Movimientos rápidos",
  "booklet.label.plungeMoves": "Movimientos de penetración",
  "booklet.label.estimatedFeedTime": "Tiempo de avance estimado",
  "booklet.label.feedTravel": "Recorrido con avance",
  "booklet.label.rapidTravel": "Recorrido rápido",
  "booklet.label.topZ": "Z superior",
  "booklet.label.bottomZ": "Z inferior",
  "booklet.label.project": "Proyecto",
  "booklet.label.generated": "Generado",
  "booklet.label.units": "Unidades",
  "booklet.label.stockSize": "Tamaño del material",
  "booklet.label.originZ": "Z de origen",
  "booklet.pdf.title": "Cuaderno de operaciones",
  "booklet.pdf.snapshot": "Resumen de la operación",
  "booklet.pdf.page": "Página {page} de {total}",
  "booklet.section.overview": "Descripción general",
  "booklet.section.tool": "Herramienta",
  "booklet.section.operationSettings": "Configuración de la operación",
  "booklet.section.toolpath": "Trayectoria de la herramienta",
  "booklet.section.warnings": "Advertencias"
}
