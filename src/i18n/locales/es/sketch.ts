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

import { sketchEn } from '../en/sketch'

/** Spanish sketch catalog. */
export const sketchEs: Record<keyof typeof sketchEn, string> = {
  "sketch.target.createFeatures": "Crear funciones",
  "sketch.target.createLines": "Crear lineas",
  "sketch.target.createRegions": "Crear regiones",
  "sketch.target.createConstruction": "Crear geometría de construcción",
  "sketch.target.feature": "característica",
  "sketch.target.line": "linea",
  "sketch.target.region": "región",
  "sketch.target.construction": "construcción",
  "sketch.shape.rectangle": "rectángulo",
  "sketch.shape.circle": "circulo",
  "sketch.shape.ellipse": "elipse",
  "sketch.shape.polygon": "polígono",
  "sketch.shape.spline": "estría",
  "sketch.shape.composite": "compuesto",
  "sketch.shape.text": "texto",
  "sketch.shape.slot": "ranura",
  "sketch.shape.regularPolygon": "polígono regular",
  "sketch.shape.gear": "engranaje",
  "sketch.shape.roundedRect": "rectángulo redondeado",
  "sketch.shape.chamferedRect": "rectángulo biselado",
  "sketch.creation.addShape": "Agregar {target} {shape}",
  "sketch.creation.cancel": "Cancelar {shape}",
  "sketch.creation.cancelTool": "Cancelar herramienta {shape}",
  "sketch.creation.chooseTarget": "Elija la forma {target}",
  "sketch.creation.closeDrawer": "Cajón de forma cerrada",
  "sketch.transform.copy": "Copiar características seleccionadas",
  "sketch.transform.cancelCopy": "Cancelar copia",
  "sketch.transform.move": "Mover funciones seleccionadas",
  "sketch.transform.cancelMove": "Cancelar movimiento",
  "sketch.transform.delete": "Eliminar funciones seleccionadas",
  "sketch.transform.resize": "Cambiar el tamaño de las funciones seleccionadas",
  "sketch.transform.cancelResize": "Cancelar cambio de tamaño",
  "sketch.transform.rotate": "Rotar entidades seleccionadas",
  "sketch.transform.cancelRotate": "Cancelar rotación",
  "sketch.transform.mirror": "Reflejar características seleccionadas",
  "sketch.transform.cancelMirror": "Cancelar espejo",
  "sketch.boolean.join": "Unirse a funciones cerradas",
  "sketch.boolean.cancelJoin": "Cancelar unirse",
  "sketch.boolean.cut": "Cortar características",
  "sketch.boolean.cancelCut": "Cancelar corte",
  "sketch.boolean.offset": "Crear función de compensación",
  "sketch.boolean.cancelOffset": "Cancelar compensación",
  "sketch.arrange.align": "Alinear características seleccionadas",
  "sketch.arrange.distribute": "Distribuir funciones seleccionadas",
  "sketch.arrange.closeAlignMenu": "Cerrar menú de alineación",
  "sketch.arrange.closeDistributeMenu": "Cerrar menú distribuir",
  "sketch.edit.addPoint": "Agregar punto",
  "sketch.edit.cancelAddPoint": "Cancelar agregar punto",
  "sketch.edit.deletePoint": "Eliminar punto",
  "sketch.edit.cancelDeletePoint": "Cancelar punto de eliminación",
  "sketch.edit.deleteSegment": "Eliminar segmento",
  "sketch.edit.cancelDeleteSegment": "Cancelar eliminar segmento",
  "sketch.edit.disconnect": "Punto de desconexión",
  "sketch.edit.cancelDisconnect": "Cancelar desconexión",
  "sketch.edit.fillet": "Esquina redondeada/filete",
  "sketch.edit.cancelFillet": "Cancelar filete",
  "sketch.edit.chamfer": "Esquina de chaflán",
  "sketch.edit.cancelChamfer": "Cancelar chaflán",
  "sketch.edit.trim": "Recortar hasta el borde de corte",
  "sketch.edit.cancelTrim": "Cancelar recorte",
  "sketch.edit.trimDisabled": "Recortar: solo perfiles abiertos",
  "sketch.edit.extend": "Extender al objetivo",
  "sketch.edit.cancelExtend": "Cancelar extender",
  "sketch.edit.extendDisabled": "Ampliar: solo perfiles abiertos",
  "sketch.constraint.add": "Agregar restricción",
  "sketch.constraint.cancel": "Cancelar restricción",
  "sketch.align.left": "Alinear a la izquierda",
  "sketch.align.centerHorizontal": "Alinear el centro horizontalmente",
  "sketch.align.right": "Alinear a la derecha",
  "sketch.align.top": "Alinear arriba",
  "sketch.align.centerVertical": "Alinear el centro verticalmente",
  "sketch.align.bottom": "Alinear abajo",
  "sketch.distribute.horizontalGaps": "Distribuir horizontalmente (espacios iguales)",
  "sketch.distribute.horizontalCenters": "Distribuir horizontalmente (centros iguales)",
  "sketch.distribute.verticalGaps": "Distribuir verticalmente (espacios iguales)",
  "sketch.distribute.verticalCenters": "Distribuir verticalmente (centros iguales)",
  "sketch.backdrop.move": "Mover fondo",
  "sketch.backdrop.cancelMove": "Cancelar mover fondo",
  "sketch.backdrop.delete": "Eliminar fondo",
  "sketch.backdrop.resize": "Cambiar el tamaño del fondo",
  "sketch.backdrop.cancelResize": "Cancelar cambiar el tamaño del fondo",
  "sketch.backdrop.rotate": "Girar fondo",
  "sketch.backdrop.cancelRotate": "Cancelar rotar fondo"
}
