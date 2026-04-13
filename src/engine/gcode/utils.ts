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

import type { MachineDefinition } from './types'
import type { MachineOrigin } from '../../types/project'
import type { ToolpathPoint } from '../toolpaths/types'

/**
 * Transforms a point from project coordinates to machine coordinates.
 * X/Z follow the usual origin-relative subtraction.
 * Y is inverted because project space increases downward on screen while
 * machine space increases upward from the chosen origin.
 */
export function projectToMachinePoint(
  point: ToolpathPoint,
  origin: MachineOrigin,
  definition: MachineDefinition
): ToolpathPoint {
  // 1. Apply origin offset
  const dx = point.x - origin.x
  const dy = origin.y - point.y
  const dz = point.z - origin.z

  // 2. Map project axes (X=right, Y=forward, Z=up) to machine axes
  // and handle inverted axes (e.g., -X).
  const mapAxis = (axisSpec: MachineDefinition['coordinateSystem']['xAxis']): number => {
    switch (axisSpec) {
      case 'X': return dx
      case 'Y': return dy
      case 'Z': return dz
      case '-X': return -dx
      case '-Y': return -dy
      case '-Z': return -dz
    }
  }

  return {
    x: mapAxis(definition.coordinateSystem.xAxis),
    y: mapAxis(definition.coordinateSystem.yAxis),
    z: mapAxis(definition.coordinateSystem.zAxis),
  }
}

/**
 * Formats a number for G-code output according to machine definition rules.
 */
export function formatGCodeNumber(
  value: number,
  definition: MachineDefinition,
  units: 'mm' | 'inch'
): string {
  const { decimalPlaces, trailingZeros, leadingZero } = definition.numberFormat
  const precision = decimalPlaces[units]
  
  // Basic fixed-point formatting
  let s = value.toFixed(precision)
  
  // Handle trailing zeros: "1.000" -> "1" if false
  if (!trailingZeros && s.includes('.')) {
    s = s.replace(/\.?0+$/, '')
  }
  
  // Handle leading zero: "0.5" -> ".5" if false
  if (!leadingZero) {
    if (s.startsWith('0.')) {
      s = s.substring(1)
    } else if (s.startsWith('-0.')) {
      s = '-' + s.substring(2)
    }
  }
  
  return s
}
