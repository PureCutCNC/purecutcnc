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

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, resolve } from 'node:path'
import { selectBuildPhases } from './build-phases'

const phases = selectBuildPhases(process.argv.slice(2))

const startedAt = new Date().toISOString()
const startedNs = process.hrtime.bigint()
const results: Array<{ name: string, durationMs: number, exitCode: number }> = []
const reportPath = process.env.BUILD_PHASE_REPORT
const elapsedMs = (start: bigint): number => Math.round(Number(process.hrtime.bigint() - start) / 1e6)

for (const phase of phases) {
  console.log(`build-phase: START ${phase.name}`)
  const start = process.hrtime.bigint()
  const result = spawnSync(phase.command, phase.args, {
    stdio: 'inherit',
    // npm/npx are .cmd wrappers on Windows; fixed arguments contain no shell input.
    shell: process.platform === 'win32',
  })
  const exitCode = result.status ?? 1
  const durationMs = elapsedMs(start)
  results.push({ name: phase.name, durationMs, exitCode })
  console.log(`build-phase: END ${phase.name} ${durationMs}ms (exit ${exitCode})`)
  if (result.error) console.error(`build-phase: ${phase.name}: ${result.error.message}`)
  if (exitCode !== 0) {
    process.exitCode = exitCode
    break
  }
}

const wallDurationMs = elapsedMs(startedNs)
console.log(`build-phase: wall ${wallDurationMs}ms; ${results.length}/${phases.length} phases completed`)
if (reportPath) {
  const path = resolve(reportPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    startedAt,
    wallDurationMs,
    runner: { platform: process.platform, arch: process.arch, node: process.version, cpuCount: cpus().length },
    phases: results,
  }, null, 2) + '\n')
  console.log(`build-phase: timing report ${reportPath}`)
}
