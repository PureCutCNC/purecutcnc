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

import type { ExportTriangleMesh, ModelExportFormat, ModelExportInput, ModelExportOutput } from './types'

export interface STLExportOptions {
  /** Binary STL is ~6× smaller and faster to read; ASCII is human-inspectable. */
  format: 'binary' | 'ascii'
  /** When false, features rendered as visual overlays (`operation: 'model'`) are excluded. */
  includeImportedMeshes: boolean
}

export const STL_DEFAULT_OPTIONS: STLExportOptions = {
  format: 'binary',
  includeImportedMeshes: true,
}

const BINARY_HEADER_BYTES = 80
const BINARY_TRIANGLE_BYTES = 50

/** Estimated file size in bytes for the given mesh under the given STL format. */
export function estimateStlFileSize(mesh: ExportTriangleMesh, format: STLExportOptions['format']): number {
  const triCount = mesh.index.length / 3
  if (format === 'binary') {
    return BINARY_HEADER_BYTES + 4 + triCount * BINARY_TRIANGLE_BYTES
  }
  // ASCII average per facet ≈ 145 bytes (rough but useful for the dialog hint).
  return Math.round(20 + triCount * 145)
}

export function writeBinaryStl(mesh: ExportTriangleMesh): Uint8Array {
  const { positions, index } = mesh
  const triCount = index.length / 3
  const buffer = new ArrayBuffer(BINARY_HEADER_BYTES + 4 + triCount * BINARY_TRIANGLE_BYTES)
  const view = new DataView(buffer)

  // The 80-byte header is informational only — most parsers ignore it.
  const header = `PureCutCNC STL export`
  for (let i = 0; i < Math.min(header.length, BINARY_HEADER_BYTES); i += 1) {
    view.setUint8(i, header.charCodeAt(i))
  }

  view.setUint32(BINARY_HEADER_BYTES, triCount, true)

  let offset = BINARY_HEADER_BYTES + 4
  for (let t = 0; t < triCount; t += 1) {
    const ia = index[t * 3] * 3
    const ib = index[t * 3 + 1] * 3
    const ic = index[t * 3 + 2] * 3

    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2]
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2]
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2]

    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) {
      nx /= len
      ny /= len
      nz /= len
    }

    view.setFloat32(offset, nx, true); offset += 4
    view.setFloat32(offset, ny, true); offset += 4
    view.setFloat32(offset, nz, true); offset += 4
    view.setFloat32(offset, ax, true); offset += 4
    view.setFloat32(offset, ay, true); offset += 4
    view.setFloat32(offset, az, true); offset += 4
    view.setFloat32(offset, bx, true); offset += 4
    view.setFloat32(offset, by, true); offset += 4
    view.setFloat32(offset, bz, true); offset += 4
    view.setFloat32(offset, cx, true); offset += 4
    view.setFloat32(offset, cy, true); offset += 4
    view.setFloat32(offset, cz, true); offset += 4
    view.setUint16(offset, 0, true); offset += 2
  }

  return new Uint8Array(buffer)
}

export function writeAsciiStl(mesh: ExportTriangleMesh, solidName = 'model'): string {
  const { positions, index } = mesh
  const triCount = index.length / 3
  const lines: string[] = [`solid ${solidName}`]

  for (let t = 0; t < triCount; t += 1) {
    const ia = index[t * 3] * 3
    const ib = index[t * 3 + 1] * 3
    const ic = index[t * 3 + 2] * 3

    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2]
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2]
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2]

    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) {
      nx /= len; ny /= len; nz /= len
    }

    lines.push(`  facet normal ${fmt(nx)} ${fmt(ny)} ${fmt(nz)}`)
    lines.push('    outer loop')
    lines.push(`      vertex ${fmt(ax)} ${fmt(ay)} ${fmt(az)}`)
    lines.push(`      vertex ${fmt(bx)} ${fmt(by)} ${fmt(bz)}`)
    lines.push(`      vertex ${fmt(cx)} ${fmt(cy)} ${fmt(cz)}`)
    lines.push('    endloop')
    lines.push('  endfacet')
  }

  lines.push(`endsolid ${solidName}`)
  return lines.join('\n') + '\n'
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return '0'
  // 6 decimals is enough for typical CAD precision and keeps files compact.
  return value.toFixed(6)
}

function sanitizeSolidName(name: string): string {
  return name.replace(/[^A-Za-z0-9_\-]+/g, '_') || 'model'
}

export const stlExportFormat: ModelExportFormat<STLExportOptions> = {
  id: 'stl',
  name: 'STL (Stereolithography)',
  extension: 'stl',
  mimeType: 'model/stl',
  defaultOptions: STL_DEFAULT_OPTIONS,
  renderOptions: () => null, // Provided by the dialog itself (avoids React import in this file).
  export(input: ModelExportInput, options: STLExportOptions): ModelExportOutput {
    if (options.format === 'ascii') {
      return {
        data: writeAsciiStl(input.mesh, sanitizeSolidName(input.project.meta.name)),
        encoding: 'text',
      }
    }
    return {
      data: writeBinaryStl(input.mesh),
      encoding: 'binary',
    }
  },
}
