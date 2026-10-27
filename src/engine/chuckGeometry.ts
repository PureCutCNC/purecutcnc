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

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { getStockBounds, type BarStock, type Clamp } from '../types/project'
import { barCentre, barPivotZ, isSquareStock } from '../types/barStock'

/** Display only. Body/jaws occupy the existing body envelope; CAM never reads this. */
export function buildChuckGeometry(clamp: Clamp, stock: BarStock): THREE.BufferGeometry {
  const diameter = stock.axis === 'x' ? clamp.h : clamp.w
  const length = stock.axis === 'x' ? clamp.w : clamp.h
  const start = stock.axis === 'x' ? clamp.x : clamp.y
  const radius = diameter / 2
  const jawLength = length * 0.22
  const bodyLength = length - jawLength
  // Face the bar, including a Bottom setup that has turned the chuck end over.
  const bounds = getStockBounds(stock)
  const stockMiddle = stock.axis === 'x' ? (bounds.minX + bounds.maxX) / 2 : (bounds.minY + bounds.maxY) / 2
  const direction = start + length / 2 <= stockMiddle ? 1 : -1
  const body = new THREE.CylinderGeometry(radius, radius, bodyLength, 64).toNonIndexed()
  body.translate(0, -direction * jawLength / 2, 0)
  const parts: THREE.BufferGeometry[] = [body]
  const count = clamp.chuck?.jawCount ?? 3
  for (let jaw = 0; jaw < count; jaw++) {
    const angle = jaw * 2 * Math.PI / count
    // Four jaws land on flats; other counts meet the actual square boundary.
    const contact = isSquareStock(stock)
      ? stock.thickness / 2 / Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle)))
      : stock.thickness / 2
    const width = Math.min(radius * 0.18, Math.max(contact * 0.4, radius * 0.06))
    const outer = Math.sqrt(Math.max(0, radius * radius - width * width / 4))
    const reach = Math.max(radius * 0.05, outer - contact)
    const geometry = new THREE.BoxGeometry(reach, jawLength, width).toNonIndexed()
    geometry.translate(contact + reach / 2, direction * bodyLength / 2, 0)
    geometry.rotateY(-angle)
    parts.push(geometry)
  }
  const geometry = mergeGeometries(parts, false)
  parts.forEach((part) => part.dispose())
  if (!geometry) throw new Error('Cannot assemble chuck geometry')
  if (stock.axis === 'x') {
    geometry.rotateZ(-Math.PI / 2)
    geometry.translate(start + length / 2, barCentre(stock), barPivotZ(stock))
  } else {
    geometry.translate(barCentre(stock), start + length / 2, barPivotZ(stock))
  }
  return geometry
}
