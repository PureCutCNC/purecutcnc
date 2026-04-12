import { existsSync } from 'node:fs'
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(configDir),
        sharedProjectRoot,
      ],
    },
  },
})
