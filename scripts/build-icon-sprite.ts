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
 * Assemble `public/icons.svg` from the editable per-icon source files in
 * `src/assets/icons/<name>.svg`. This replaces the old camj→sprite converter;
 * the per-icon SVGs are now the source of truth (editable in Inkscape/
 * Illustrator). See src/assets/icons/README.md and issue #176.
 *
 * Run via `npm run sync-icons` (also runs first in `npm run build`).
 * Executed with tsx so it can share the pure assembly logic in
 * `src/components/iconSprite.ts` with the unit test.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { assembleSprite, parseIconSvg, type ParsedIcon } from '../src/components/iconSprite.ts'

const ICONS_DIR = 'src/assets/icons'
const OUTPUT_PATH = 'public/icons.svg'

const files = readdirSync(ICONS_DIR)
  .filter((name) => name.endsWith('.svg'))
  .sort((a, b) => a.localeCompare(b))

if (files.length === 0) {
  console.error(`build-icon-sprite: no .svg files found in ${ICONS_DIR}`)
  process.exit(1)
}

const icons: ParsedIcon[] = files.map((file) => {
  const id = basename(file, '.svg')
  const raw = readFileSync(join(ICONS_DIR, file), 'utf-8')
  return parseIconSvg(id, raw)
})

writeFileSync(OUTPUT_PATH, assembleSprite(icons))
console.log(`build-icon-sprite: wrote ${icons.length} symbols to ${OUTPUT_PATH}`)
