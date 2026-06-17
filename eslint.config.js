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

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Rest-sibling destructuring (`const { a, b, ...rest } = obj`) is the
      // idiomatic way to drop keys from an object — the named siblings exist
      // only to be excluded from `rest`. This narrow option exempts exactly
      // that pattern; all other unused-var detection keeps its defaults (much
      // narrower than a blanket `^_` ignore). See
      // planning/archive/LINT_BATCH_E_LEFTOVERS_Plan.md.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['src/App.tsx', 'src/app/**/*.{ts,tsx}'],
    rules: {
      'max-lines': ['error', { max: 530, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['src/store/projectStore.ts'],
    rules: {
      'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['src/store/**/*.{ts,tsx}'],
    rules: {
      'max-lines': ['error', { max: 1200, skipBlankLines: true, skipComments: true }],
    },
  },
  // P6 anti-regrowth guard for the SketchCanvas module. The `**` block bounds
  // each extracted interaction hook; the SketchCanvas.tsx block (listed AFTER,
  // so it wins for that file) bounds the shell itself — the shell legitimately
  // retains the `draw` renderer + JSX + imperative handle (not interaction
  // machines), so its limit reflects the achieved post-extraction size rather
  // than the aspirational <600. See CORE_STATE_CANVAS_REFACTOR_Plan.md P6 DoD.
  {
    files: ['src/components/canvas/**/*.{ts,tsx}'],
    rules: {
      'max-lines': ['error', { max: 1200, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['src/components/canvas/SketchCanvas.tsx'],
    rules: {
      'max-lines': ['error', { max: 3800, skipBlankLines: true, skipComments: true }],
    },
  },
])
