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

import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'

const configDir = dirname(fileURLToPath(import.meta.url))
const candidateSharedRoots = [
  resolve(configDir, '..'),
  resolve(configDir, '../..'),
  resolve(configDir, '../../..'),
]

const sharedProjectRoot = candidateSharedRoots.find((candidate) => (
  existsSync(resolve(candidate, 'package.json')) && existsSync(resolve(candidate, 'node_modules'))
)) ?? configDir
const realNodeModulesRoot = (() => {
  const nodeModulesPath = resolve(configDir, 'node_modules')
  if (!existsSync(nodeModulesPath)) {
    return null
  }

  try {
    return realpathSync(nodeModulesPath)
  } catch {
    return null
  }
})()
const realSharedProjectRoot = realNodeModulesRoot ? resolve(realNodeModulesRoot, '..') : null
const realManifoldRoot = realNodeModulesRoot ? resolve(realNodeModulesRoot, 'manifold-3d') : null

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    // The `fonts` chunk is inherently large: the CNC text-to-geometry feature
    // statically bundles 11 typeface glyph-outline JSON files (src/text/index.ts),
    // which dominate the bundle (~3.4 MB). Once vendors are split out (below) the
    // remaining chunks are well-behaved, so we lift the warning above the largest
    // legitimate chunk rather than chasing a number no amount of grouping can
    // bring under 500 kB. Lazy-loading individual fonts on demand is the real
    // size win and is tracked as a separate follow-up.
    chunkSizeWarningLimit: 3500,
    rolldownOptions: {
      output: {
        // Split heavy vendor libraries out of the main app chunk so no single
        // chunk dwarfs the others, and so each caches independently.
        // manifold-3d self-splits via its WASM loader, so it is left alone.
        codeSplitting: {
          groups: [
            // Glyph-outline fonts are the single biggest contributor — keep
            // them in their own chunk so the `three` chunk reflects real code.
            { name: 'fonts', test: /[\\/]node_modules[\\/]three[\\/]examples[\\/]fonts[\\/]/ },
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ },
            { name: 'clipper', test: /[\\/]node_modules[\\/]clipper-lib[\\/]/ },
            {
              name: 'react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            { name: 'vendor', test: /[\\/]node_modules[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    fs: {
      allow: [
        searchForWorkspaceRoot(configDir),
        sharedProjectRoot,
        ...(realSharedProjectRoot ? [realSharedProjectRoot] : []),
        ...(realNodeModulesRoot ? [realNodeModulesRoot] : []),
        ...(realManifoldRoot ? [realManifoldRoot] : []),
      ],
    },
  },
})
