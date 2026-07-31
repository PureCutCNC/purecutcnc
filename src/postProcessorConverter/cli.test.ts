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
 * Tests for the CLI's argument parsing and end-to-end file I/O behavior.
 *
 * Run with: npx tsx src/postProcessorConverter/cli.test.ts
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, runCli } from './cli'
import { validateMachineDefinition } from '../engine/gcode/types'
import type { ConversionReport } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// --- parseArgs ---

{
  const missingInput = parseArgs(['--output', 'out.json'])
  assert(missingInput.kind === 'error' && missingInput.message.includes('--input'), `expected a missing --input error, got ${JSON.stringify(missingInput)}`)

  const missingOutput = parseArgs(['--input', 'in.spm'])
  assert(missingOutput.kind === 'error' && missingOutput.message.includes('--output'), `expected a missing --output error, got ${JSON.stringify(missingOutput)}`)

  const help = parseArgs(['--help'])
  assert(help.kind === 'help', `expected help, got ${JSON.stringify(help)}`)

  const unknownFlag = parseArgs(['--input', 'a', '--output', 'b', '--bogus'])
  assert(unknownFlag.kind === 'error', `expected an error for an unrecognized flag, got ${JSON.stringify(unknownFlag)}`)

  const badFormat = parseArgs(['--input', 'a', '--output', 'b', '--format', 'not-a-real-format'])
  assert(badFormat.kind === 'error' && badFormat.message.includes('--format'), `expected a --format validation error, got ${JSON.stringify(badFormat)}`)

  const valid = parseArgs(['--input', 'a.spm', '--output', 'b.json', '--strict', '--force', '--name', 'My Machine'])
  assert(valid.kind === 'run', `expected a valid parse, got ${JSON.stringify(valid)}`)
  if (valid.kind === 'run') {
    assert(valid.options.input === 'a.spm', 'input parsed correctly')
    assert(valid.options.output === 'b.json', 'output parsed correctly')
    assert(valid.options.format === 'auto', 'format defaults to auto')
    assert(valid.options.strict === true, 'strict flag set')
    assert(valid.options.force === true, 'force flag set')
    assert(valid.options.name === 'My Machine', 'name parsed correctly')
  }

  console.log('cli.test: parseArgs assertions passed')
}

// --- runCli end-to-end, against a real temp directory ---

const tempDir = mkdtempSync(join(tmpdir(), 'purecutcnc-cli-test-'))
try {
  const fixturePath = fileURLToPath(new URL('./__fixtures__/visualMill/usbcnc.spm', import.meta.url))
  const inputPath = join(tempDir, 'usbcnc.spm')
  writeFileSync(inputPath, readFileSync(fixturePath, 'utf8'), 'utf8')
  const outputPath = join(tempDir, 'converted.json')
  const reportPath = join(tempDir, 'converted.report.json')

  const messages: string[] = []
  const errors: string[] = []
  const log = (m: string): void => void messages.push(m)
  const logError = (m: string): void => void errors.push(m)

  // Missing input file.
  {
    const code = runCli({ input: join(tempDir, 'nope.spm'), output: outputPath, format: 'auto', strict: false, force: false }, log, logError)
    assert(code === 1, 'missing input file should exit 1')
  }

  // Unknown extension with no explicit --format.
  {
    const unknownPath = join(tempDir, 'mystery.xyz')
    writeFileSync(unknownPath, 'irrelevant content', 'utf8')
    const code = runCli({ input: unknownPath, output: outputPath, format: 'auto', strict: false, force: false }, log, logError)
    assert(code === 1, 'unrecognized extension with no --format should exit 1')
  }

  // Normal conversion.
  {
    errors.length = 0
    const code = runCli({ input: inputPath, output: outputPath, format: 'auto', strict: false, force: false }, log, logError)
    assert(code === 0, `expected exit 0, got ${code}. errors: ${JSON.stringify(errors)}`)
    const definition = validateMachineDefinition(JSON.parse(readFileSync(outputPath, 'utf8')))
    assert(definition.fileExtension === 'txt', `output definition should be the usbcnc.spm conversion, got fileExtension=${definition.fileExtension}`)
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as ConversionReport
    assert(report.sourceFormat === 'visual-mill', `report.sourceFormat: ${report.sourceFormat}`)
    assert(report.findings.length > 5, 'report should have a substantial findings list')
    assert(messages.some((m) => m.includes('Wrote definition')), 'expected a "Wrote definition" log line')
  }

  // Re-running without --force must refuse to clobber the existing files.
  {
    const beforeDefinition = readFileSync(outputPath, 'utf8')
    errors.length = 0
    const code = runCli({ input: inputPath, output: outputPath, format: 'auto', strict: false, force: false }, log, logError)
    assert(code === 1, 'existing output without --force should exit 1')
    assert(errors.some((m) => m.includes('--force')), 'expected a --force guidance message')
    assert(readFileSync(outputPath, 'utf8') === beforeDefinition, 'existing output file must be untouched when refused')
  }

  // --force allows overwriting.
  {
    errors.length = 0
    const code = runCli({ input: inputPath, output: outputPath, format: 'auto', strict: false, force: true }, log, logError)
    assert(code === 0, `--force should allow overwriting, got exit ${code}. errors: ${JSON.stringify(errors)}`)
  }

  console.log('cli.test: normal conversion + --force guard assertions passed')

  // --- --strict refusal, using the ECam lathe fixture, which we already
  // know carries a strict-blocking "wrong machine type" finding. ---
  {
    const lathePath = fileURLToPath(new URL('./__fixtures__/ecam/d6000-edingcnc-drehmaschine-mm.xml', import.meta.url))
    const latheInput = join(tempDir, 'd6000.xml')
    writeFileSync(latheInput, readFileSync(lathePath, 'utf8'), 'utf8')
    const latheOutput = join(tempDir, 'lathe.json')
    const latheReport = join(tempDir, 'lathe.report.json')

    errors.length = 0
    const code = runCli({ input: latheInput, output: latheOutput, format: 'auto', strict: true, force: false }, log, logError)
    assert(code === 1, 'strict mode should refuse a source with strict-blocking findings')
    assert(errors.some((m) => m.includes('Refusing to write')), 'expected a "Refusing to write" message')

    let outputWasWritten = true
    try {
      readFileSync(latheOutput, 'utf8')
    } catch {
      outputWasWritten = false
    }
    assert(!outputWasWritten, 'the main definition file must NOT be written when --strict refuses')

    const report = JSON.parse(readFileSync(latheReport, 'utf8')) as ConversionReport
    assert(report.findings.some((f) => f.blocksStrict), 'the report file must still be written even when --strict refuses the definition')
  }

  console.log('cli.test: --strict refusal assertions passed')
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

console.log('cli.test: all assertions passed')
