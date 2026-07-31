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
 * Standalone CLI for issue #402: converts an external CAM post-processor
 * file into a PureCutCNC MachineDefinition JSON, plus a full conversion
 * report. Node-only (readFileSync/writeFileSync/process.argv) — deliberately
 * isolated to this file so every other module in postProcessorConverter/
 * stays pure and reusable (e.g. by a future in-app importer).
 *
 * Usage: npx tsx src/postProcessorConverter/cli.ts --input <file> --output <file.json> [options]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { SourceFormatId } from './types'
import { isStrictSafe } from './types'
import { convertPostProcessor } from './convert'
import { formatReportText } from './report'
import { ADAPTERS } from './adapters/index'

const FORMAT_IDS = ADAPTERS.map((a) => a.id)

export interface CliOptions {
  input: string
  output: string
  format: SourceFormatId | 'auto'
  strict: boolean
  force: boolean
  name?: string
  vendor?: string
}

export type ParsedArgs =
  | { kind: 'run'; options: CliOptions }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

export const USAGE = `Convert an external CAM post-processor file into a PureCutCNC MachineDefinition JSON.

Usage:
  npx tsx src/postProcessorConverter/cli.ts --input <file> --output <file.json> [options]

Required:
  --input <path>     Source post-processor file to convert.
  --output <path>    Where to write the MachineDefinition JSON.

Options:
  --format <id>      One of: ${FORMAT_IDS.join(', ')}, or "auto" (default; detected from --input's extension).
  --strict           Refuse to write output if any finding would change emitted 3-axis behavior (see the report's [blocks --strict] markers).
  --force            Overwrite --output / the report file if they already exist.
  --name <string>    Machine name (default: --input's filename without extension).
  --vendor <string>  Optional vendor label recorded in the output definition.
  --help             Show this message.

Always writes <output-without-.json>.report.json and prints the report to stdout, whether or not the
definition itself was written. The converter never executes the source file's own scripting/expression
language — see PROJECT.md's CNC safety contract: review the definition and generated G-code before machine use.`

export function parseArgs(argv: string[]): ParsedArgs {
  const options: Partial<CliOptions> = { format: 'auto', strict: false, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} requires a value.`)
      i += 1
      return value
    }
    try {
      switch (arg) {
        case '--input':
          options.input = next()
          break
        case '--output':
          options.output = next()
          break
        case '--format':
          options.format = next() as SourceFormatId | 'auto'
          break
        case '--strict':
          options.strict = true
          break
        case '--force':
          options.force = true
          break
        case '--name':
          options.name = next()
          break
        case '--vendor':
          options.vendor = next()
          break
        case '--help':
        case '-h':
          return { kind: 'help' }
        default:
          return { kind: 'error', message: `Unrecognized argument: ${arg}` }
      }
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  if (!options.input) return { kind: 'error', message: '--input is required.' }
  if (!options.output) return { kind: 'error', message: '--output is required.' }
  if (options.format !== 'auto' && !FORMAT_IDS.includes(options.format as SourceFormatId)) {
    return { kind: 'error', message: `--format must be "auto" or one of: ${FORMAT_IDS.join(', ')}.` }
  }

  return { kind: 'run', options: options as CliOptions }
}

function reportPathFor(outputPath: string): string {
  return /\.json$/i.test(outputPath) ? outputPath.replace(/\.json$/i, '.report.json') : `${outputPath}.report.json`
}

function writeGuarded(path: string, content: string, force: boolean): string | null {
  if (existsSync(path) && !force) {
    return `${path} already exists. Pass --force to overwrite.`
  }
  writeFileSync(path, content, 'utf8')
  return null
}

/** Runs the conversion and performs all filesystem I/O. Returns a process exit code. */
export function runCli(options: CliOptions, log: (message: string) => void = console.log, logError: (message: string) => void = console.error): number {
  if (!existsSync(options.input)) {
    logError(`Input file not found: ${options.input}`)
    return 1
  }

  const fileText = readFileSync(options.input, 'utf8')
  let result: ReturnType<typeof convertPostProcessor>
  try {
    result = convertPostProcessor(fileText, options.input, { format: options.format, name: options.name, vendor: options.vendor })
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err))
    return 1
  }

  log(formatReportText(result.report))

  const reportPath = reportPathFor(options.output)
  const reportError = writeGuarded(reportPath, JSON.stringify(result.report, null, 2) + '\n', options.force)
  if (reportError) {
    logError(reportError)
    return 1
  }
  log(`Wrote report: ${reportPath}`)

  if (options.strict && !isStrictSafe(result.report)) {
    logError(
      `Refusing to write ${options.output}: --strict is set and the following findings would change emitted 3-axis behavior:\n` +
        result.report.findings
          .filter((f) => f.blocksStrict)
          .map((f) => `  - [${f.status}] ${f.sourceField}${f.targetField ? ` -> ${f.targetField}` : ''}: ${f.message}`)
          .join('\n'),
    )
    return 1
  }

  const outputError = writeGuarded(options.output, JSON.stringify(result.definition, null, 2) + '\n', options.force)
  if (outputError) {
    logError(outputError)
    return 1
  }
  log(`Wrote definition: ${options.output}`)
  return 0
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file://').href
if (isMainModule) {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.kind === 'help') {
    console.log(USAGE)
    process.exit(0)
  } else if (parsed.kind === 'error') {
    console.error(parsed.message)
    console.error('')
    console.error(USAGE)
    process.exit(1)
  } else {
    process.exit(runCli(parsed.options))
  }
}
