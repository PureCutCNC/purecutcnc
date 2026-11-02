/**
 * Copyright 2026 Maik Rolf
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
 * WP0 baseline CLI. Read-only: it parses existing `.camj` fixtures, measures
 * JSON/asset/snapshot size and Node serialization cost, and inventories the
 * existing command descriptors by static pattern count.
 *
 * Usage:
 *   npx tsx tools/baseline-metrics/run.ts
 *   npx tsx tools/baseline-metrics/run.ts --json baseline.json --markdown BASELINE.md
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  countCommandPatterns,
  formatBytes,
  measureSerialization,
  summarizeProject,
  type BaselineReport,
  type CommandInventory,
  type CommandSourceMetrics,
  type FixtureMetrics,
} from './metrics'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)

function argValue(name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a path`)
  return value
}

function collectFiles(root: string, suffix: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      found.push(...collectFiles(full, suffix))
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      found.push(full)
    }
  }
  return found
}

function collectFixtures(): string[] {
  const roots = [
    join(repoRoot, 'src', 'engine', 'test-fixtures'),
    join(repoRoot, 'public', 'examples'),
    join(repoRoot, 'scripts'),
  ]
  const files = roots.flatMap((root) => collectFiles(root, '.camj'))
  return [...new Set(files.map((file) => resolve(file)))].sort()
}

function collectCommandInventory(): CommandInventory {
  // Keep the baseline comparable to the pre-WP1 tree: only the original
  // descriptor sources, not the registry/adapter introduced by WP1.
  const files = [
    join(repoRoot, 'src', 'commands', 'creationShapes.ts'),
    join(repoRoot, 'src', 'commands', 'fileCommands.ts'),
    join(repoRoot, 'src', 'commands', 'sketchCommands.ts'),
    join(repoRoot, 'src', 'components', 'canvas', 'canvasShortcuts.ts'),
  ].filter(existsSync)

  const measured: CommandSourceMetrics[] = files.map((file) => ({
    file: relative(repoRoot, file).replaceAll('\\', '/'),
    ...countCommandPatterns(readFileSync(file, 'utf8')),
  }))

  return {
    files: measured,
    totals: measured.reduce(
      (totals, entry) => ({
        labels: totals.labels + entry.labels,
        ids: totals.ids + entry.ids,
        activations: totals.activations + entry.activations,
        shortcuts: totals.shortcuts + entry.shortcuts,
        commandTypes: totals.commandTypes + entry.commandTypes,
      }),
      { labels: 0, ids: 0, activations: 0, shortcuts: 0, commandTypes: 0 },
    ),
  }
}

function measureFixtures(): { fixtures: FixtureMetrics[]; failures: number } {
  const fixtures: FixtureMetrics[] = []
  let failures = 0

  for (const file of collectFixtures()) {
    try {
      const text = readFileSync(file, 'utf8')
      const project: unknown = JSON.parse(text)
      const jsonBytes = new TextEncoder().encode(text).length
      const summary = summarizeProject(project, jsonBytes)
      const timing = measureSerialization(project, 3)
      fixtures.push({
        fileName: relative(repoRoot, file).replaceAll('\\', '/'),
        fileBytes: statSync(file).size,
        ...summary,
        ...timing,
      })
    } catch (error) {
      failures += 1
      console.error(`baseline: failed to measure ${relative(repoRoot, file)}`)
      console.error(error instanceof Error ? error.message : error)
    }
  }

  return { fixtures, failures }
}

function renderMarkdown(report: BaselineReport): string {
  const lines: string[] = [
    '# Baseline metrics — SolidCraft WP0',
    '',
    `Generated: ${report.generatedAt}`,
    `Runtime: Node ${report.node} on ${report.platform}`,
    '',
    '> Timing is Node `JSON.parse` / `JSON.stringify` / `structuredClone`, not a full app load.',
    '> `100-entry history` is `snapshotBytes × 100` — a serialized-size projection, not V8 heap usage.',
    '',
    `## Fixtures (${report.fixtureCount})`,
    '',
    '| Fixture | File | Features | Definitions | Ops | Tools | Embedded assets | Snapshot | 100-entry history | Parse | Stringify | Clone |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.fixtures.map((fixture) => [
      `| ${fixture.fileName.split('/').pop() ?? fixture.fileName}`,
      formatBytes(fixture.fileBytes),
      fixture.featureCount,
      fixture.definitionCount,
      fixture.operationCount,
      fixture.toolCount,
      formatBytes(fixture.embeddedAssetBytes),
      formatBytes(fixture.snapshotBytes),
      formatBytes(fixture.history100Bytes),
      `${fixture.parseMs.toFixed(2)} ms`,
      `${fixture.stringifyMs.toFixed(2)} ms`,
      `${fixture.cloneMs.toFixed(2)} ms |`,
    ].join(' | ')),
    '',
    '## Command inventory',
    '',
    '| Source | Labels | IDs | Activations | Shortcuts | Descriptor types |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.commandInventory.files.map((source) => (
      `| ${source.file} | ${source.labels} | ${source.ids} | ${source.activations} | ${source.shortcuts} | ${source.commandTypes} |`
    )),
    `| **Total** | **${report.commandInventory.totals.labels}** | **${report.commandInventory.totals.ids}** | **${report.commandInventory.totals.activations}** | **${report.commandInventory.totals.shortcuts}** | **${report.commandInventory.totals.commandTypes}** |`,
    '',
    '## Notes',
    '',
    ...report.notes.map((note) => `- ${note}`),
  ]
  return `${lines.join('\n')}\n`
}

const { fixtures, failures } = measureFixtures()
const commandInventory = collectCommandInventory()
const report: BaselineReport = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  fixtureCount: fixtures.length,
  fixtures,
  commandInventory,
  notes: [
    'Fixture sizes come from the checked-in .camj files; duplicate public/dist examples are skipped by scanning distinct roots.',
    'Embedded asset bytes count decoded base64 strings of at least 256 characters.',
    'Command inventory is a static count over descriptor sources, not the runtime registry.',
  ],
}

const jsonPath = argValue('--json')
if (jsonPath) {
  const target = resolve(repoRoot, jsonPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`baseline: wrote ${relative(repoRoot, target)}`)
}

const markdownPath = argValue('--markdown')
if (markdownPath) {
  const target = resolve(repoRoot, markdownPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, renderMarkdown(report))
  console.log(`baseline: wrote ${relative(repoRoot, target)}`)
}

console.log(`baseline: ${fixtures.length} fixtures, ${commandInventory.files.length} command sources`)
for (const fixture of fixtures) {
  console.log(
    `  ${basename(fixture.fileName)}: ${formatBytes(fixture.fileBytes)}, `
    + `${fixture.featureCount} features, ${formatBytes(fixture.embeddedAssetBytes)} assets, `
    + `${formatBytes(fixture.snapshotBytes)} snapshot`,
  )
}
console.log(
  `baseline: command descriptors labels=${commandInventory.totals.labels} `
  + `ids=${commandInventory.totals.ids} activations=${commandInventory.totals.activations}`,
)

if (failures > 0) {
  console.error(`baseline: ${failures} fixture(s) failed`)
  process.exitCode = 1
}
