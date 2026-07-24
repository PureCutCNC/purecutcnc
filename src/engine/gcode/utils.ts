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
 * Inverse of `projectToMachinePoint`: maps a machine-coordinate point back
 * into project coordinates. Used by the exported-motion debug view (issue #356)
 * to render the parsed G-code layer in the same project space as the Generated
 * and Optimized layers. Like the forward transform, this performs no unit
 * conversion — G-code numeric values are emitted in project units (the machine
 * is only *told* the units via G20/G21 in the header), so the parsed numbers
 * are already in project units.
 */
export function machineToProjectPoint(
  point: ToolpathPoint,
  origin: MachineOrigin,
  definition: MachineDefinition
): ToolpathPoint {
  const { xAxis, yAxis, zAxis } = definition.coordinateSystem

  // Reverse the signed-permutation axis mapping. For each machine axis we
  // know which project delta (dx/dy/dz) and sign produced it, so we invert
  // by assigning that signed machine value back to its project delta.
  const projectDelta: { dx: number | null; dy: number | null; dz: number | null } = {
    dx: null, dy: null, dz: null,
  }
  const assign = (axisSpec: MachineDefinition['coordinateSystem']['xAxis'], machineAxisValue: number) => {
    switch (axisSpec) {
      case 'X': projectDelta.dx = machineAxisValue; break
      case 'Y': projectDelta.dy = machineAxisValue; break
      case 'Z': projectDelta.dz = machineAxisValue; break
      case '-X': projectDelta.dx = -machineAxisValue; break
      case '-Y': projectDelta.dy = -machineAxisValue; break
      case '-Z': projectDelta.dz = -machineAxisValue; break
    }
  }
  assign(xAxis, point.x)
  assign(yAxis, point.y)
  assign(zAxis, point.z)
  const dx = projectDelta.dx ?? 0
  const dy = projectDelta.dy ?? 0
  const dz = projectDelta.dz ?? 0

  // Reverse the origin offset applied by projectToMachinePoint:
  //   dx = x - origin.x   =>   x = dx + origin.x
  //   dy = origin.y - y   =>   y = origin.y - dy
  //   dz = z - origin.z   =>   z = dz + origin.z
  return {
    x: dx + origin.x,
    y: origin.y - dy,
    z: dz + origin.z,
  }
}

/**
 * Whether an arc's CW/CCW direction flips when mapped from machine space back
 * to project space by `machineToProjectPoint`. The mapping is a signed axis
 * permutation composed with the project Y-flip; for odd permutations in the
 * machine plane (a single mirrored axis like '-X', or an X/Y swap) the planar
 * part is orientation-preserving, so a machine-CW arc renders CCW in project
 * space and callers must invert `clockwise` before drawing. The common
 * identity mapping (and 180° mappings like -X/-Y) need no flip.
 */
export function machineToProjectFlipsArcDirection(definition: MachineDefinition): boolean {
  // Column of the machine→project XY Jacobian contributed by each machine
  // axis: px = origin.x + dx, py = origin.y - dy, where dx/dy are recovered
  // from the machine axis values with their signs.
  const column = (axisSpec: MachineDefinition['coordinateSystem']['xAxis']): [number, number] => {
    switch (axisSpec) {
      case 'X': return [1, 0]
      case '-X': return [-1, 0]
      case 'Y': return [0, -1]
      case '-Y': return [0, 1]
      default: return [0, 0]   // Z / -Z: no planar contribution
    }
  }
  const cx = column(definition.coordinateSystem.xAxis)
  const cy = column(definition.coordinateSystem.yAxis)
  const det = cx[0] * cy[1] - cx[1] * cy[0]
  return det > 0
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
