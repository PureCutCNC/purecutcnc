/**
 * Structural test for the bundled example projects.
 *
 * Asserts that every entry in `public/examples/manifest.json` resolves to a
 * file that exists, parses, and normalizes through the same `normalizeProject`
 * path used by `openProjectFromText` — so a broken manifest fails the build
 * rather than 404ing at runtime in the empty-state / New Project flows.
 *
 * Run with: npx tsx src/components/project/exampleManifest.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { normalizeProject } from '../../store/projectStore'
import type { Project } from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

interface ManifestEntry {
  id: string
  title: string
  description: string
  file: string
  thumbnail?: string
}

const examplesDir = fileURLToPath(new URL('../../../public/examples/', import.meta.url))

const manifest = JSON.parse(readFileSync(join(examplesDir, 'manifest.json'), 'utf8')) as ManifestEntry[]

assert(Array.isArray(manifest), 'manifest.json should be an array')
assert(manifest.length > 0, 'manifest should list at least one example')

const seenIds = new Set<string>()

for (const entry of manifest) {
  assert(typeof entry.id === 'string' && entry.id.length > 0, 'each entry needs an id')
  assert(!seenIds.has(entry.id), `duplicate example id: ${entry.id}`)
  seenIds.add(entry.id)
  assert(typeof entry.title === 'string' && entry.title.length > 0, `entry ${entry.id} needs a title`)
  assert(typeof entry.description === 'string' && entry.description.length > 0, `entry ${entry.id} needs a description`)
  assert(typeof entry.file === 'string' && entry.file.endsWith('.camj'), `entry ${entry.id} needs a .camj file`)

  // Throws if the file is missing — locking the manifest against dangling refs.
  const raw = readFileSync(join(examplesDir, entry.file), 'utf8')
  const parsed = JSON.parse(raw) as Project
  const normalized = normalizeProject(parsed)

  assert(Array.isArray(normalized.features), `example ${entry.file} should normalize to a project with features`)
  assert(normalized.features.length > 0, `example ${entry.file} should contain at least one feature`)

  if (entry.thumbnail) {
    // Throws if the referenced thumbnail is missing.
    readFileSync(join(examplesDir, entry.thumbnail))
  }
}

console.log(`exampleManifest tests passed (${manifest.length} examples)`)
