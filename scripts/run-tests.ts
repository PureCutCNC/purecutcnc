/**
 * Test runner — discovers every `src/**\/*.test.ts` file and executes it as a
 * standalone tsx module. Each test file runs its assertions at module top
 * level and throws on failure; this runner imports them in sequence and
 * surfaces the first failure.
 *
 * Wired into `npm run build` and runnable directly via `npm test`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const srcRoot = join(repoRoot, 'src')
const npxExecutable = process.platform === 'win32' ? 'npx.cmd' : 'npx'

// Tests that are known-failing for reasons unrelated to the build's freshness.
// Each entry should be paired with a follow-up issue/task tracking its fix.
// Paths are relative to repo root.
const KNOWN_FAILING_TESTS = new Set<string>([])

function findTestFiles(root: string): string[] {
  const results: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stats = statSync(full)
      if (stats.isDirectory()) {
        walk(full)
      } else if (stats.isFile() && entry.endsWith('.test.ts')) {
        results.push(full)
      }
    }
  }
  if (existsSync(root)) walk(root)
  return results.sort()
}

const testFiles = findTestFiles(srcRoot)
if (testFiles.length === 0) {
  console.error('run-tests: no .test.ts files found under src/')
  process.exit(1)
}

console.log(`run-tests: discovered ${testFiles.length} test files`)

let failed = 0
let skipped = 0
for (const file of testFiles) {
  const rel = relative(repoRoot, file)
  if (KNOWN_FAILING_TESTS.has(rel)) {
    process.stdout.write(`\n── ${rel} ─────────────────────────\n`)
    console.warn(`run-tests: SKIPPED ${rel} (in KNOWN_FAILING_TESTS — fix and re-enable)`)
    skipped += 1
    continue
  }
  process.stdout.write(`\n── ${rel} ─────────────────────────\n`)
  const result = spawnSync(npxExecutable, ['tsx', file], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    failed += 1
    if (result.error) {
      console.error(`run-tests: failed to launch ${npxExecutable}: ${result.error.message}`)
    }
    console.error(`run-tests: FAILED ${rel} (exit ${result.status})`)
  }
}

if (failed > 0) {
  console.error(`\nrun-tests: ${failed} test file(s) failed`)
  process.exit(1)
}

const ran = testFiles.length - skipped
console.log(`\nrun-tests: all ${ran} executed test files passed (${skipped} skipped)`)
