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

import { viewportEn } from '../en/viewport'

/** Spanish viewport catalog. */
export const viewportEs: Record<keyof typeof viewportEn, string> = {
  "viewport.presets.top": "Vista superior",
  "viewport.presets.bottom": "Vista inferior",
  "viewport.presets.front": "Vista frontal",
  "viewport.presets.back": "Vista trasera",
  "viewport.presets.right": "Vista derecha",
  "viewport.presets.left": "Vista izquierda",
  "viewport.presets.iso": "Vista isométrica",
  "viewport.sim.modeLabel": "Modo de simulación",
  "viewport.sim.modeSelected": "Seleccionado",
  "viewport.sim.modeVisible": "Visibles",
  "viewport.sim.detailLabel": "Detalle",
  "viewport.sim.detailTitle": "Detalle de simulación",
  "viewport.sim.playTool": "Herramienta de juego",
  "viewport.sim.playToolDisabledMode": "Cambie al modo Seleccionado para usar la reproducción de herramientas",
  "viewport.sim.playToolDisabledNoOp": "Seleccione una operación con una trayectoria de herramienta válida para jugar",
  "viewport.sim.playToolToggle": "Alternar reproducción de herramientas",
  "viewport.sim.webglUnavailableTitle": "La simulación 3D no está disponible",
  "viewport.sim.webglUnavailableBody": "Esta vista requiere WebGL2, que su navegador o controlador de gráficos no proporcionó. Intente actualizar su navegador o habilitar la aceleración de hardware en su configuración.",
  "viewport.sim.webglLostTitle": "Se perdió el contexto de los gráficos 3D",
  "viewport.sim.webglLostBody": "Esperando a que el navegador lo restaure: la reproducción se ha pausado. Si este mensaje persiste, recarga la aplicación.",
  "viewport.sim.play": "Jugar",
  "viewport.sim.pause": "Pausa",
  "viewport.sim.stop": "Detener y restablecer",
  "viewport.sim.progressAria": "Progreso de la reproducción",
  "viewport.sim.speedLabel": "Velocidad",
  "viewport.sim.speedTooltipFeed": "Multiplicador de velocidad de avance de operación ({feed} = 1×). Actual: {multiplier}",
  "viewport.sim.speedTooltipFallback": "Multiplicador de velocidad de alimentación alternativa ({feed} = 1×). Actual: {multiplier}",
  "viewport.sim.speedAria": "Multiplicador de velocidad de reproducción",
  "viewport.sim.stepLabel": "paso",
  "viewport.sim.stepTooltip": "Distancia máxima que avanza la herramienta por cuadro. Más pequeño = movimiento más suave, más grande = reproducción más rápida.",
  "viewport.sim.feedTooltip": "Avance de corte del movimiento actual. Los cortes de bolsillo con ranuras reducidas muestran aquí su avance a escala; el color del punto marca el tipo de movimiento (los rápidos no tienen avance).",
  "viewport.sim.moveKindIdle": "inactivo",
  "viewport.about.ariaLabel": "Acerca de PureCutCNC",
  "viewport.about.title": "Acerca de",
  "viewport.about.close": "Cerrar",
  "viewport.about.version": "Versión {version}",
  "viewport.about.tagline": "CAD/CAM 2.5D para aficionados al CNC: bocetos y mecanizado en un solo flujo de trabajo, en la web o en su escritorio.",
  "viewport.about.releaseLabel": "Lanzamiento",
  "viewport.about.releasedLabel": "liberado",
  "viewport.about.website": "Sitio web",
  "viewport.about.source": "Fuente",
  "viewport.about.releases": "Lanzamientos",
  "viewport.about.license": "Licencia (Apache-2.0)",
  "viewport.about.supportText": "PureCutCNC es gratuito y seguirá siendo gratuito, pero crearlo y mantenerlo requiere tiempo y dinero reales. Si te ayuda, un café lo mantiene activo.",
  "viewport.about.buyCoffee": "Cómprame un café",
  "viewport.empty.title": "Comienza tu parte",
  "viewport.empty.subtitle": "Dibuja una forma, importa un archivo o abre un ejemplo terminado para ver el flujo de trabajo completo.",
  "viewport.empty.drawTitle": "dibujar una forma",
  "viewport.empty.drawMeta": "Dibuja un rectángulo en el lienzo.",
  "viewport.empty.importTitle": "Importar un archivo",
  "viewport.empty.importMeta": "Archivos SVG, DXF, OBJ, STL o CAMJ",
  "viewport.empty.examplesLabel": "Abra un ejemplo...",
  "viewport.error.eyebrow": "algo salió mal",
  "viewport.error.title": "Lo sentimos, PureCutCNC no pudo iniciarse en este dispositivo.",
  "viewport.error.body": "Esto generalmente significa que su navegador o sistema operativo no admite las funciones de gráficos 3D que necesita la aplicación. Pruebe una versión actual de Chrome, Edge o Firefox en una computadora de escritorio o tableta razonablemente reciente, o use una de nuestras versiones de escritorio.",
  "viewport.error.showDetails": "Mostrar detalles técnicos",
  "viewport.error.reload": "recargar",
  "viewport.error.desktopDownloads": "Descargas de escritorio",
  "viewport.error.projectWebsite": "Sitio web del proyecto",
  "viewport.error.userAgent": "Agente de usuario:",
  "viewport.error.timestamp": "Marca de tiempo:"
}
