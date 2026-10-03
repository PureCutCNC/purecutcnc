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
 * QtPlasmaC simulator check (issue #954).
 *
 * Runs every plasma corpus program through LinuxCNC's own QtPlasmaC simulator
 * configuration in a container: QtPlasmaC's load filter, the interpreter, then
 * a real run with the QtPlasmaC GUI, its M190 script and the `plasmac`
 * component live. Nobody on the project owns a plasma table, so until a tester
 * runs files on one this is the only evidence that our plasma output is
 * something QtPlasmaC accepts.
 *
 * The container runtime is optional, like the validators of `check:gcode`: a
 * machine without Podman or Docker gets a plain statement that nothing was
 * verified. Set QTPLASMAC_SIM_REQUIRED=1 (CI does) to make that a failure.
 *
 * Run with: npm run check:gcode:qtplasmac [-- --only <case-name>]
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLASMA_CORPUS } from './corpus'
import type { PlasmaCase, SimMachine } from './corpus'
import { judge, mismatch } from './verdict'
import type { SimProgramReport } from './verdict'

const HERE = import.meta.dirname
const SIM_DIR = join(HERE, 'sim')
const CONTAINERFILE = join(HERE, 'Containerfile')
/** Wiped every run: the programs sent to the simulator and what it reported. */
const OUT_DIR = resolve(process.cwd(), '.gcode-conformance', 'qtplasmac')

/**
 * The LinuxCNC release the image installs (`LINUXCNC_VERSION` in the
 * Containerfile). The simulator reports the version it actually ran, and a
 * difference fails the check: a verdict from some other QtPlasmaC is not the
 * verdict this check claims to give.
 */
const PINNED_LINUXCNC_VERSION = '1:2.9.10'

const RESULT_MARKER = '@@RESULT@@ '
/** Per program, generous: a reference program runs in well under a minute. */
const PROGRAM_TIMEOUT_SECONDS = 120
const BOOT_ALLOWANCE_SECONDS = 240

interface SimResult {
  machine: SimMachine
  linuxcncVersion: string | null
  harnessError: string | null
  programs: SimProgramReport[]
}

function runtimeWorks(runtime: string): boolean {
  // `info` talks to the engine, so it also fails for an installed client
  // whose machine or daemon is not running.
  return spawnSync(runtime, ['info'], { stdio: 'ignore' }).status === 0
}

function findRuntime(): string | null {
  const forced = process.env.QTPLASMAC_SIM_RUNTIME
  const candidates = forced ? [forced] : ['podman', 'docker']
  return candidates.find(runtimeWorks) ?? null
}

/** Tag derived from everything that goes into the image, so an edit rebuilds it. */
function imageTag(): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(CONTAINERFILE))
  for (const name of readdirSync(SIM_DIR).sort()) {
    hash.update(name)
    hash.update(readFileSync(join(SIM_DIR, name)))
  }
  return `purecut-qtplasmac-sim:${hash.digest('hex').slice(0, 12)}`
}

function ensureImage(runtime: string, tag: string): void {
  if (spawnSync(runtime, ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0) {
    console.log(`Simulator image ${tag} already built.`)
    return
  }
  console.log(`Building simulator image ${tag} (LinuxCNC ${PINNED_LINUXCNC_VERSION}); the first build produces an image of about 1.7 GB.`)
  const started = Date.now()
  // The sim is amd64 only: linuxcnc.org publishes no arm64 uspace build for
  // bookworm, so on Apple Silicon this runs under emulation.
  execFileSync(runtime, ['build', '--platform', 'linux/amd64', '-t', tag, '-f', CONTAINERFILE, HERE], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  console.log(`Built in ${seconds(Date.now() - started)}.`)
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} s`
}

function runSimulator(runtime: string, tag: string, machine: SimMachine, cases: PlasmaCase[]): SimResult {
  const request = JSON.stringify({
    machine,
    timeoutSeconds: PROGRAM_TIMEOUT_SECONDS,
    programs: cases.map((entry) => ({ name: entry.name, gcode: entry.program() })),
  })
  // LinuxCNC's realtime helper and its GUI processes run as different users
  // and share memory through SysV segments; IPC_OWNER is what lets them. It is
  // the one capability the default container set lacks for this.
  const done = spawnSync(runtime, ['run', '--rm', '-i', '--platform', 'linux/amd64', '--cap-add=IPC_OWNER', tag], {
    input: request,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
    timeout: (BOOT_ALLOWANCE_SECONDS + cases.length * PROGRAM_TIMEOUT_SECONDS) * 1000,
  })
  const line = (done.stdout ?? '').split('\n').find((candidate) => candidate.startsWith(RESULT_MARKER))
  if (!line) {
    return {
      machine,
      linuxcncVersion: null,
      harnessError: `the simulator container produced no result (exit ${done.status ?? done.signal})`,
      programs: [],
    }
  }
  return JSON.parse(line.slice(RESULT_MARKER.length)) as SimResult
}

function describeRun(report: SimProgramReport): string {
  const run = report.run
  if (!run) return 'rejected on load, not run'
  const loaded = run.firstTorchOn
    ? `material ${run.firstTorchOn.material} at feed ${run.firstTorchOn.cutFeedRate}`
    : 'torch never fired'
  return `ran ${run.seconds} s, ${loaded}`
}

function selectCases(): PlasmaCase[] {
  const names = PLASMA_CORPUS.map((entry) => entry.name)
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate) throw new Error(`plasma corpus has two cases named "${duplicate}"`)

  const only = process.argv.indexOf('--only')
  if (only === -1) return PLASMA_CORPUS
  const wanted = process.argv[only + 1]
  const selected = PLASMA_CORPUS.filter((entry) => entry.name === wanted)
  if (selected.length === 0) throw new Error(`no plasma corpus case named "${wanted}"; have: ${names.join(', ')}`)
  return selected
}

function main(): void {
  const cases = selectCases()
  const required = process.env.QTPLASMAC_SIM_REQUIRED === '1'

  const runtime = findRuntime()
  if (!runtime) {
    console.log('SKIP QtPlasmaC simulator check — no working container runtime (podman or docker).')
    console.log(`     ${cases.length} plasma programs were NOT run. Nothing was verified.`)
    console.log('     See scripts/gcode-conformance/qtplasmac/README.md to set one up.')
    if (required) {
      console.error('\nQTPLASMAC_SIM_REQUIRED=1: a skipped check is a failure here.')
      process.exit(1)
    }
    return
  }

  const started = Date.now()
  const tag = imageTag()
  ensureImage(runtime, tag)

  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  let problems = 0
  let passed = 0
  let rejected = 0
  const machines = [...new Set(cases.map((entry) => entry.machine))]
  for (const machine of machines) {
    const group = cases.filter((entry) => entry.machine === machine)
    const groupStarted = Date.now()
    console.log(`\n── QtPlasmaC sim, ${machine} machine (${group.length} program(s)) ─────────────────────`)
    const result = runSimulator(runtime, tag, machine, group)
    writeFileSync(join(OUT_DIR, `result-${machine}.json`), JSON.stringify(result, null, 1), 'utf8')

    if (result.linuxcncVersion && result.linuxcncVersion !== PINNED_LINUXCNC_VERSION) {
      problems += 1
      console.error(`  FAIL the simulator ran LinuxCNC ${result.linuxcncVersion}, not the pinned ${PINNED_LINUXCNC_VERSION}.`)
    }
    // A simulator that broke is never a pass and never a skip: the programs
    // were meant to be checked and were not.
    if (result.harnessError) {
      problems += 1
      console.error(`  FAIL the simulator itself failed: ${result.harnessError}`)
    }

    for (const entry of group) {
      const report = result.programs.find((candidate) => candidate.name === entry.name)
      if (!report) {
        problems += 1
        console.error(`  FAIL ${entry.name}: the simulator returned no report for it`)
        continue
      }
      writeFileSync(join(OUT_DIR, `${entry.name}.ngc`), entry.program(), 'utf8')
      writeFileSync(join(OUT_DIR, `${entry.name}.filtered.ngc`), `${report.filtered.join('\n')}\n`, 'utf8')

      const findings = judge(report)
      const wrong = mismatch(entry.expect, findings)
      if (wrong) {
        problems += 1
        console.error(`  FAIL ${entry.name}: ${wrong} (${describeRun(report)})`)
        console.error(`       covers: ${entry.covers}`)
        for (const finding of findings) console.error(`       [${finding.rule}] ${finding.message}`)
      } else if (entry.expect === 'pass') {
        passed += 1
        console.log(`  ok   ${entry.name} — ${describeRun(report)}`)
      } else {
        rejected += 1
        console.log(`  ok   ${entry.name} — rejected as it must be (${describeRun(report)})`)
        for (const finding of findings) console.log(`       [${finding.rule}] ${finding.message}`)
      }
    }
    console.log(`  (${machine} machine: ${seconds(Date.now() - groupStarted)})`)
  }

  console.log(`\nPrograms and simulator reports: ${OUT_DIR}`)
  if (problems > 0) {
    console.error(`\n${problems} problem(s) in the QtPlasmaC simulator check.`)
    process.exit(1)
  }
  console.log(`\n${passed} program(s) accepted by QtPlasmaC (LinuxCNC ${PINNED_LINUXCNC_VERSION}); `
    + `${rejected} defective program(s) rejected as required. Total ${seconds(Date.now() - started)}.`)
}

main()
