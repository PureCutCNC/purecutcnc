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

/**
 * Tests for the SVG entry in the model-export format registry: it is a '2d'
 * text format that renders from the project without an assembled mesh.
 *
 * Run with: npx tsx src/engine/modelExport/svg.test.ts
 */

import { newProject } from '../../types/project'
import { STL_DEFAULT_OPTIONS, stlExportFormat } from './stl'
import { SVG_DEFAULT_OPTIONS, svgExportFormat } from './svg'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Format descriptor ────────────────────────────────────────

assert(svgExportFormat.id === 'svg', 'svg format id')
assert(svgExportFormat.kind === '2d', 'svg is a 2d format')
assert(svgExportFormat.extension === 'svg', 'svg extension')
assert(svgExportFormat.mimeType === 'image/svg+xml', 'svg mime type')
assert(stlExportFormat.kind === '3d', 'stl stays a 3d format')

// ── Export without a mesh ────────────────────────────────────

{
  const project = newProject('SvgFormatTest', 'mm')
  const output = await svgExportFormat.export({ project }, SVG_DEFAULT_OPTIONS)
  assert(output.encoding === 'text', 'svg export is text-encoded')
  assert(typeof output.data === 'string', 'svg export data is a string')
  const data = output.data as string
  assert(data.startsWith('<svg'), 'svg export emits an svg document')
  assert(data.includes('viewBox='), 'svg export carries a viewBox')
}

// ── 3D formats still require the mesh ────────────────────────

{
  const project = newProject('StlGuardTest', 'mm')
  let threw = false
  try {
    await stlExportFormat.export({ project }, STL_DEFAULT_OPTIONS)
  } catch {
    threw = true
  }
  assert(threw, 'stl export without a mesh throws instead of writing garbage')
}

console.log('modelExport svg format tests passed')
