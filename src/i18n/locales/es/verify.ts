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

/** Spanish Verify mode translations (issue #1269). */
export const verifyEs: Record<keyof typeof verifyEn, string> = {
  'verify.mode': 'Verificar',
  'verify.modeTitle': 'Verificar la trayectoria: comparar el modelo, la trayectoria interna y el programa exportado',
  'verify.panelLabel': 'Verificar la trayectoria exportada',
  'verify.comparisonLabel': 'Comparar',
  'verify.comparison.modelInternal': 'Modelo ↔ Interna',
  'verify.comparison.modelExported': 'Modelo ↔ Exportada',
  'verify.comparison.internalExported': 'Interna ↔ Exportada',
  'verify.comparisonHint.modelInternal': 'Material cortado por las trayectorias generadas, frente al modelo.',
  'verify.comparisonHint.modelExported': 'Material cortado por el programa exportado, releído, frente al modelo.',
  'verify.comparisonHint.internalExported': 'El programa exportado frente a las trayectorias generadas.',
  'verify.scopeUpto': 'Todas las operaciones visibles hasta {operation}',
  'verify.scopeAll': 'Todas las operaciones visibles de {setup}',
  'verify.run': 'Ejecutar verificación',
  'verify.cancel': 'Cancelar',
  'verify.running': 'Verificando… {done} de {total}',
  'verify.idle': 'La verificación solo se ejecuta cuando la pide. Elija una comparación y ejecútela.',
  'verify.failed': 'La verificación no pudo terminar. Inténtelo de nuevo; la consola tiene los detalles.',
  'verify.stale.projectEdited': 'Desactualizado: el proyecto cambió desde este resultado. Ejecute la verificación de nuevo para actualizarlo.',
  'verify.stale.requestChanged': 'Desactualizado: este resultado es de otra comparación, operación, configuración o detalle. Ejecute la verificación de nuevo para actualizarlo.',
  'verify.summary': '{verified} verificadas · {deviation} con desviaciones · {unverified} sin verificar',
  'verify.runUnverified': 'Sin verificar: {reason}',
  'verify.resultsLabel': 'Resultados de la verificación',
  'verify.legendLabel': 'Leyenda de colores',
  'verify.verdict.verified': 'Verificada',
  'verify.verdict.deviation': 'Desviación',
  'verify.verdict.unverified': 'Sin verificar',
  'verify.kind.gouge': 'Corte excesivo',
  'verify.kind.intendedLeftover': 'Sobrante previsto',
  'verify.kind.unintendedLeftover': 'Sobrante no previsto',
  'verify.kind.missingCut': 'Corte que falta',
  'verify.kind.extraCut': 'Corte adicional',
  'verify.kind.feed': 'Avance',
  'verify.kind.unverified': 'Operación sin verificar',
  'verify.findingRegion': '{area} · máx. {size}',
  'verify.findingDistance': '{size} de la otra trayectoria',
  'verify.findingNoCounterpart': 'Ningún corte coincidente en la otra trayectoria',
  'verify.findingFeed': 'Avance {actual} en lugar de {expected}',
  'verify.findingFeedMissing': 'Sin avance indicado; se esperaba {expected}',
  'verify.moreDeviations': '{count} desviaciones más no listadas',
  'verify.noFindings': 'Sin desviaciones',
  'verify.unattributed': 'Material que ninguna operación cortó',
  'verify.findingFocus': 'Mostrar en la vista',
  'verify.reasonAtLine': '{reason} (línea {line})',
  'verify.reason.aroundSetup': 'una configuración Alrededor aún no se compara con el modelo',
  'verify.reason.rotaryOperation': 'una operación rotativa aún no se compara con el modelo',
  'verify.reason.rotaryMotion': 'un movimiento gira el eje rotativo mientras corta',
  'verify.reason.unsupportedSetup': 'esta orientación de configuración no se puede mecanizar',
  'verify.reason.uptoOperationNotFound': 'la operación seleccionada no tiene nada que reproducir',
  'verify.reason.noModel': 'el proyecto no tiene un modelo con el que comparar',
  'verify.reason.exportUnsupported': 'el programa exportado tiene una construcción que no se puede releer',
  'verify.reason.exportFailed': 'el programa no se pudo producir ni releer',
  'verify.reason.noCutMoves': 'ninguna de las dos trayectorias tiene un movimiento de corte',
  'verify.reason.unparsedText': 'el programa tiene texto que no es código G',
  'verify.reason.unsupportedCommand': 'no se puede reconstruir el movimiento de {command}',
  'verify.reason.machineCoordinateRetract': 'una retracción en coordenadas de máquina (G53)',
  'verify.reason.machineCoordinateMove': 'un movimiento en coordenadas de máquina que no es una retracción',
  'verify.reason.rapidAfterMachineRetract': 'un rápido tras una retracción G53 no indica Z',
  'verify.reason.workZUnknown': 'un movimiento de avance tras una retracción G53 no indica Z',
  'verify.reason.motionWithoutMode': 'coordenadas antes de cualquier modo de movimiento',
  'verify.reason.inverseTimeFeedMissing': 'un movimiento en tiempo inverso sin su propio F',
  'verify.reason.arcCentreMissing': 'un arco sin centro ni radio',
  'verify.reason.arcRadiusTooSmall': 'un arco cuyo radio no abarca sus extremos',
  'verify.reason.cannedCycleIncomplete': 'un ciclo fijo sin el Z, R o Q que necesita',
  'verify.reason.cannedCycleWithRotary': 'un ciclo fijo que también gira el eje rotativo',
  'verify.reason.cannedRetractModeAssumed': 'sin G98/G99 antes de un ciclo fijo; se supuso G98',
  'verify.reason.chipBreakRetractApproximate': 'una retracción de rotura de viruta se lee de forma aproximada',
  'verify.reason.probeMove': 'un movimiento de palpado',
  'verify.reason.touchOffZ': 'un toque de Z',
  'verify.reason.rotaryZeroed': 'el eje rotativo se pone a cero en el programa',
  'verify.reason.workOffsetChange': 'el origen de trabajo cambia en el programa',
  'verify.reason.parseFailure': 'no se pudo leer el programa',
  'verify.reason.unsupportedStatement': 'una instrucción que no se puede reconstruir',
  'verify.reason.emptyProgram': 'el posprocesador no escribió ningún programa',
  'verify.reason.operationRefused': 'el posprocesador rechazó la operación',
  'verify.reason.postFailed': 'el posprocesador falló',
  'verify.reason.noTool': 'la operación no tiene una herramienta utilizable',
  'verify.reason.axisNotStated': 'el programa nunca indica el eje {axis}',
  'verify.reason.manualIndexTurnRemoved': 'el giro inicial de indexado manual se quitó de los ángulos',
  'verify.reason.noToolpath': 'no se pudo generar su trayectoria',
  'verify.reason.noMachine': 'no hay ninguna máquina seleccionada para exportar',
  'verify.reason.noOperations': 'ninguna operación visible con trayectoria hasta la selección',
}
