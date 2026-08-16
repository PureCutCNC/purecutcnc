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
 * E2E lane-coverage guard (issue #528).
 *
 * CI runs the e2e suite as parallel lanes (`test:e2e:*` in `package.json`) that
 * name their spec files explicitly, so a spec is only ever executed by CI if
 * somebody remembered to add it to a lane. Nothing used to notice when they
 * did not: adding a file to `e2e/` is a complete action locally — Playwright
 * discovers it automatically and the author gets a green run — while CI stays
 * green precisely because the spec is not there to fail.
 *
 * That silence let six of twenty specs go unrun, and two of them accumulated
 * real failures over two weeks (#524, #527) with nobody the wiser.
 *
 * This check fails the build when a spec under `e2e/` belongs to no lane, or
 * when a lane names a spec that does not exist, or when two lanes claim the
 * same spec. It deliberately does not replace the lanes with a bare
 * `playwright test`: the lanes exist so CI can run them as a parallel matrix.
 *
 * Usage: npx tsx scripts/check-e2e-lanes.ts [--list]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const E2E_DIR = join(ROOT, 'e2e')
const PACKAGE_JSON = join(ROOT, 'package.json')

/** Script names that make up the CI matrix. Keep in sync with `pr-check.yml`. */
const LANE_PREFIX = 'test:e2e:'

/** Spec files are the unit CI schedules; helpers and fixtures are not specs. */
const SPEC_SUFFIX = '.spec.ts'

interface Lane {
  name: string
  specs: string[]
}

function readLanes(): Lane[] {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    scripts?: Record<string, string>
  }
  const scripts = pkg.scripts ?? {}
  return Object.entries(scripts)
    .filter(([name]) => name.startsWith(LANE_PREFIX))
    .map(([name, command]) => ({
      name,
      specs: [...command.matchAll(/e2e\/[A-Za-z0-9._-]+\.spec\.ts/g)].map((m) => m[0]),
    }))
}

function readSpecFiles(): string[] {
  return readdirSync(E2E_DIR)
    .filter((entry) => entry.endsWith(SPEC_SUFFIX))
    .map((entry) => `e2e/${entry}`)
    .sort()
}

function main(): void {
  const lanes = readLanes()
  const specs = readSpecFiles()

  if (lanes.length === 0) {
    console.error(`check-e2e-lanes: no "${LANE_PREFIX}*" scripts found in package.json`)
    process.exit(1)
  }

  const owners = new Map<string, string[]>()
  for (const lane of lanes) {
    for (const spec of lane.specs) {
      owners.set(spec, [...(owners.get(spec) ?? []), lane.name])
    }
  }

  if (process.argv.includes('--list')) {
    for (const lane of lanes) {
      console.log(`${lane.name} (${lane.specs.length})`)
      for (const spec of lane.specs) console.log(`  ${spec}`)
    }
  }

  const orphaned = specs.filter((spec) => !owners.has(spec))
  const missing = [...owners.keys()].filter((spec) => !specs.includes(spec))
  const duplicated = [...owners.entries()].filter(([, names]) => names.length > 1)

  const problems: string[] = []

  if (orphaned.length > 0) {
    problems.push(
      `${orphaned.length} spec(s) belong to no CI lane, so CI will never run them:\n`
      + orphaned.map((spec) => `    ${spec}`).join('\n')
      + `\n  Add each to one of: ${lanes.map((lane) => lane.name).join(', ')}`,
    )
  }
  if (missing.length > 0) {
    problems.push(
      `${missing.length} lane entr(ies) name a spec that does not exist:\n`
      + missing.map((spec) => `    ${spec} (in ${owners.get(spec)?.join(', ')})`).join('\n'),
    )
  }
  if (duplicated.length > 0) {
    problems.push(
      `${duplicated.length} spec(s) appear in more than one lane, so CI runs them twice:\n`
      + duplicated.map(([spec, names]) => `    ${spec} (${names.join(', ')})`).join('\n'),
    )
  }

  if (problems.length > 0) {
    console.error('check-e2e-lanes: FAILED\n')
    for (const problem of problems) console.error(`  ${problem}\n`)
    process.exit(1)
  }

  console.log(
    `check-e2e-lanes: OK (${specs.length} specs across ${lanes.length} lanes)`,
  )
}

main()
