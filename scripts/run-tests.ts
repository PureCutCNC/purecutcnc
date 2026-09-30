/**
 * Test runner — discovers every `src/**\/*.test.ts` and `tools/**\/*.test.ts`
 * file and executes it as a
 * standalone tsx module. Each test file runs its assertions at module top
 * level and throws on failure; this runner executes them in a bounded
 * parallel pool (files are independent processes), buffers each file's
 * output, and prints one file's section at a time so failures stay readable.
 *
 * Concurrency: `RUN_TESTS_JOBS` env var, default `min(10, max(1, cores - 2))`.
 * Set `RUN_TESTS_JOBS=1` for the previous strictly sequential behavior.
 *
 * Wired into `npm run build` and runnable directly via `npm test`.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, freemem, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const srcRoot = join(repoRoot, 'src')
const toolsRoot = join(repoRoot, 'tools')
const tsxCliPath = require.resolve('tsx/cli')
const testExecutable = process.execPath

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

const startedAt = new Date().toISOString()
const startedNs = process.hrtime.bigint()
const testFiles = [srcRoot, toolsRoot].flatMap(findTestFiles)
if (testFiles.length === 0) {
  console.error('run-tests: no .test.ts files found under src/ or tools/')
  process.exit(1)
}

const jobsRaw = Number.parseInt(process.env.RUN_TESTS_JOBS ?? '', 10)
const jobs = Number.isFinite(jobsRaw) && jobsRaw >= 1
  ? Math.min(jobsRaw, 16)
  : Math.min(10, Math.max(1, cpus().length - 2))

console.log(`run-tests: discovered ${testFiles.length} test files (jobs=${jobs})`)

interface FileResult {
  rel: string
  output: string
  exitCode: number
  launchError?: string
  durationMs: number
}

function runOne(file: string): Promise<FileResult> {
  const rel = relative(repoRoot, file)
  const start = process.hrtime.bigint()
  const durationMs = (): number => Math.round(Number(process.hrtime.bigint() - start) / 1e6)
  return new Promise((resolveResult) => {
    const child = spawn(testExecutable, [tsxCliPath, file], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', (error) => {
      resolveResult({ rel, output: Buffer.concat(chunks).toString(), exitCode: 1, launchError: error.message, durationMs: durationMs() })
    })
    child.on('close', (code) => {
      resolveResult({ rel, output: Buffer.concat(chunks).toString(), exitCode: code ?? 1, durationMs: durationMs() })
    })
  })
}

let failed = 0
let skipped = 0
const results: Array<Pick<FileResult, 'rel' | 'exitCode' | 'durationMs' | 'launchError'>> = []
const skippedFiles: string[] = []

// Print skips up front so the parallel section only contains executed files.
const queue: string[] = []
for (const file of testFiles) {
  const rel = relative(repoRoot, file)
  if (KNOWN_FAILING_TESTS.has(rel)) {
    process.stdout.write(`\n── ${rel} ─────────────────────────\n`)
    console.warn(`run-tests: SKIPPED ${rel} (in KNOWN_FAILING_TESTS — fix and re-enable)`)
    skipped += 1
    skippedFiles.push(rel)
  } else {
    queue.push(file)
  }
}

// Bounded pool: each completed file prints its buffered section atomically,
// in completion order — the header names the file, so ordering stays
// unambiguous and the `── rel ──` / `run-tests: FAILED rel (exit N)` markers
// consumed by scripts/build-summary.sh are unchanged.
function reportResult(result: FileResult): void {
  results.push({ rel: result.rel, exitCode: result.exitCode, durationMs: result.durationMs, launchError: result.launchError })
  process.stdout.write(`\n── ${result.rel} ─────────────────────────\n`)
  if (result.output.length > 0) process.stdout.write(result.output)
  console.log(`run-tests: TIMING ${result.rel} ${result.durationMs}ms (exit ${result.exitCode})`)
  if (result.exitCode !== 0) {
    failed += 1
    if (result.launchError) {
      console.error(`run-tests: failed to launch ${testExecutable} ${tsxCliPath}: ${result.launchError}`)
    }
    console.error(`run-tests: FAILED ${result.rel} (exit ${result.exitCode})`)
  }
}

async function runPool(): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < queue.length) {
      const index = next
      next += 1
      const result = await runOne(queue[index])
      reportResult(result)
    }
  }
  const lanes: Promise<void>[] = []
  for (let i = 0; i < Math.min(jobs, queue.length); i += 1) lanes.push(lane())
  await Promise.all(lanes)
}

await runPool()

const wallDurationMs = Math.round(Number(process.hrtime.bigint() - startedNs) / 1e6)
const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10)
console.log(`run-tests: wall ${wallDurationMs}ms, ${jobs} jobs, ${failed} failed, ${skipped} skipped`)
for (const result of slowest) console.log(`run-tests: SLOW ${result.rel} ${result.durationMs}ms`)

const reportPath = process.env.RUN_TESTS_REPORT
if (reportPath) {
  const report = {
    schemaVersion: 1,
    startedAt,
    wallDurationMs,
    sumFileDurationMs: results.reduce((total, result) => total + result.durationMs, 0),
    runner: { platform: process.platform, arch: process.arch, node: process.version, cpuCount: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAtEnd: freemem(), jobs },
    discovered: testFiles.length,
    executed: results.length,
    failed,
    skipped,
    files: results.map(({ rel, exitCode, durationMs, launchError }) => ({ path: rel, exitCode, durationMs, ...(launchError ? { launchError } : {}) })).sort((a, b) => a.path.localeCompare(b.path)),
    skippedFiles,
  }
  mkdirSync(dirname(resolve(reportPath)), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(`run-tests: timing report ${reportPath}`)
}

if (failed > 0) {
  console.error(`\nrun-tests: ${failed} test file(s) failed`)
  process.exit(1)
}

const ran = testFiles.length - skipped
console.log(`\nrun-tests: all ${ran} executed test files passed (${skipped} skipped)`)
