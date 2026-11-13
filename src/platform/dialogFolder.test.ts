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
 * The desktop dialogs' remembered folder (issue #1144).
 *
 * Mutations checked: splitting on `/` only → the Windows assertions fail;
 * dropping the root special case → the "/" and "C:\" assertions fail;
 * storing one folder for both kinds → the separate-kinds assertion fails.
 *
 * Run with: npx tsx src/platform/dialogFolder.test.ts
 */

const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem'> }).localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => { store.set(key, value) },
}

const { fileNameOf, folderOf, joinFolder, rememberFolderOf, rememberedFolder, saveDefaultPath } = await import('./dialogFolder')

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`Assertion failed: ${message} (got ${String(actual)}, expected ${String(expected)})`)
}

equal(folderOf('/data/u/parts/a.camj'), '/data/u/parts', 'posix folder')
equal(folderOf('C:\\Users\\u\\parts\\a.camj'), 'C:\\Users\\u\\parts', 'windows folder')
equal(folderOf('/a.camj'), '/', 'posix root keeps its separator')
equal(folderOf('C:\\a.camj'), 'C:\\', 'windows drive root keeps its separator')
equal(folderOf('a.camj'), null, 'a bare name has no folder')

equal(fileNameOf('/data/u/parts/a.dxf'), 'a.dxf', 'posix name')
equal(fileNameOf('C:\\Users\\u\\parts\\a.dxf'), 'a.dxf', 'windows name')
equal(fileNameOf('a.dxf'), 'a.dxf', 'bare name')

equal(joinFolder('/data/u', 'a.nc'), '/data/u/a.nc', 'posix join')
equal(joinFolder('C:\\Users\\u', 'a.nc'), 'C:\\Users\\u\\a.nc', 'windows join')
equal(joinFolder('/', 'a.nc'), '/a.nc', 'root join')

// Nothing remembered: today's behaviour (the bare suggested name).
equal(rememberedFolder('project'), null, 'nothing remembered yet')
equal(saveDefaultPath('project', 'a.camj'), 'a.camj', 'save falls back to the bare name')

rememberFolderOf('project', '/data/u/projects/a.camj')
rememberFolderOf('file', '/data/u/gcode/a.nc')
equal(rememberedFolder('project'), '/data/u/projects', 'project folder remembered')
equal(rememberedFolder('file'), '/data/u/gcode', 'an export does not move the project folder')
equal(saveDefaultPath('project', 'b.camj'), '/data/u/projects/b.camj', 'save starts in the remembered folder')

console.log('dialogFolder: ok')
