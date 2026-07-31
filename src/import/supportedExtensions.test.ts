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
 * Supported import extensions — constants and detection.
 *
 * Run with: npx tsx src/import/supportedExtensions.test.ts
 */

import { SUPPORTED_IMPORT_EXTENSIONS, SUPPORTED_IMPORT_ACCEPT, detectImportSourceType } from './types'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('FAIL: ' + msg)
}

// ── Constants ──

assert(
  SUPPORTED_IMPORT_EXTENSIONS.length === 5,
  'SUPPORTED_IMPORT_EXTENSIONS has 5 entries'
)
assert(
  SUPPORTED_IMPORT_EXTENSIONS[0] === 'svg' &&
  SUPPORTED_IMPORT_EXTENSIONS[1] === 'dxf' &&
  SUPPORTED_IMPORT_EXTENSIONS[2] === 'stl' &&
  SUPPORTED_IMPORT_EXTENSIONS[3] === 'obj' &&
  SUPPORTED_IMPORT_EXTENSIONS[4] === 'camj',
  'SUPPORTED_IMPORT_EXTENSIONS contains svg,dxf,stl,obj,camj in order'
)

assert(
  SUPPORTED_IMPORT_ACCEPT === '.svg,.dxf,.stl,.obj,.camj',
  'SUPPORTED_IMPORT_ACCEPT equals .svg,.dxf,.stl,.obj,.camj'
)

// ── detectImportSourceType ──

assert(detectImportSourceType('part.svg') === 'svg', 'part.svg → svg')
assert(detectImportSourceType('part.dxf') === 'dxf', 'part.dxf → dxf')
assert(detectImportSourceType('model.stl') === 'stl', 'model.stl → stl')
assert(detectImportSourceType('mesh.obj') === 'obj', 'mesh.obj → obj')
assert(detectImportSourceType('project.camj') === 'camj', 'project.camj → camj')

// Case-insensitive
assert(detectImportSourceType('PART.SVG') === 'svg', 'PART.SVG → svg')
assert(detectImportSourceType('Model.StL') === 'stl', 'Model.StL → stl')

// Rejected extensions
assert(detectImportSourceType('image.png') === null, 'image.png → null')
assert(detectImportSourceType('doc.txt') === null, 'doc.txt → null')
assert(detectImportSourceType('nofile') === null, 'no extension → null')
assert(detectImportSourceType('') === null, 'empty → null')

console.log('supportedExtensions.test.ts: all tests passed')