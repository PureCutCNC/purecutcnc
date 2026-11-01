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
 * Rotary generation probe (#1115 slice p-a). A diagnostic, not a quality gate.
 *
 * #1050 made generation around the bar measurably slower. Optimising it means
 * changing engine code, and the first thing such a change must not do is move
 * the toolpath: the approved decision for #1115 is that output stays
 * byte-identical — same moves, same posted program — while each around rotary
 * operation comes back within 1.5x its pre-#1050 generation time. A suite that
 * asserts what its author expected cannot prove either half against the real
 * benchmark files, so this probe measures the pair together:
 *
 *   - **time**, per operation: one cold run and five warm forced
 *     regenerations, timed around the engine entry alone — never around
 *     loading, simulation or posting;
 *   - **identity**, per operation: the fixture's SHA-256, the operation's id,
 *     kind, axis, tool, feeds and settings, a digest of the generated moves,
 *     and a digest of the posted program with the date line normalised.
 *
 * The engine entry is `computeOperationToolpath` — the same one the app's
 * worker calls (`generateOperation.ts` is the single synchronous entry point,
 * issue #675), so these are the app's numbers and not an adjacent path's.
 *
 * `--root <checkout>` measures another checkout's engine through a dynamic
 * import from that tree, which is how the pre-#1050 reference at
 * `…/worktrees/purecutcnc/ref-pre-1050` is timed. The pre-#1050 tree exposes
 * the same four functions this probe needs (`normalizeProject`,
 * `computeOperationToolpath`, `normalizeToolForProject`, `runPostProcessor`),
 * so no adapter is used; `loadEngineTree` fails loudly if that ever stops being
 * true.
 *
 * `--baseline <json>` compares a run with a stored baseline and fails on any
 * identity mismatch (fixture hash, operation id or settings) or any move or
 * program digest difference. Later #1115 slices keep the head baseline at
 * `work/1115-baseline.json` and run this option against their own engine, so a
 * change that merely looks identical cannot pass.
 *
 * Posting needs a machine definition, and the benchmark projects name none
 * (`meta.selectedMachineId` is null). The probe therefore attaches a
 * documented baseline machine — bundled `grbl` plus an own-drive rotary block
 * about the stock's own axis — and records that it did. The program's *text*
 * is not the point of the hash; its stability across slices is.
 *
 * Usage:
 *   npx tsx scripts/rotary-generation-probe.ts --project <file.camj> --operation <id> [--operation <id>…]
 *       [--out <json>] [--root <checkout>] [--baseline <json>]
 *
 * The result JSON defaults to `work/rotary-generation-probe.json` in this
 * checkout. Nothing is ever written back to the fixture.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { PostProcessorInput, PostProcessorResult } from '../src/engine/gcode/types'
import type { MachineDefinition } from '../src/engine/gcode/types'
import type { NormalizedTool, ToolpathResult } from '../src/engine/toolpaths/types'
import type { Operation, Project, Tool } from '../src/types/project'

/** One cold run plus this many warm forced regenerations, per operation. */
export const WARM_RUNS = 5

const PROBE_NAME = 'rotary-generation-probe'
const PROBE_VERSION = 1
const ENGINE_ENTRY = 'computeOperationToolpath'
/** The bundled definition the probe's baseline machine is built from. */
const BASELINE_MACHINE_BASE = 'grbl'

/** A usage or fixture mistake: reported on stderr, exit code 1, never a crash. */
export class ProbeError extends Error {}

// ── what a run records ───────────────────────────────────────

export interface ProbeArgs {
  /** The `.camj` to read, unchanged. */
  project: string
  /** Operation ids to measure, in the order given. */
  operations: string[]
  /** Where the result JSON goes. */
  out: string
  /** The checkout whose engine is measured. */
  root: string
  /** A stored result to compare against, or null. */
  baseline: string | null
}

export interface OperationIdentity {
  id: string
  kind: string
  /** The axis of rotation the numbers are about, and which way the pass runs. */
  axis: {
    stock: string | null
    setup: string | null
    passDirection: string | null
  }
  tool: NormalizedTool
  feeds: { feed: number; plungeFeed: number; rpm: number }
  /** The settings a human would change, lifted out for reading; the full
   *  operation below is what the baseline actually compares. */
  settings: {
    stepdown: number
    stepover: number
    stockToLeaveRadial: number
    stockToLeaveAxial: number
    rotaryChuckSupport: number | null
    rotaryTailSupport: number | null
    arcFittingEnabled: boolean | null
  }
  /** The whole normalized operation: a settings change anywhere in it is an
   *  identity mismatch, including one a default backfill introduces. */
  operation: Operation
  operationDigest: string
  toolDigest: string
}

export interface OperationReport {
  id: string
  identity: OperationIdentity
  runs: {
    coldMs: number
    warmMs: number[]
    medianMs: number
    minMs: number
    maxMs: number
    /** False when two runs of the same operation produced different moves:
     *  a timing baseline is meaningless over non-deterministic output. */
    digestStable: boolean
  }
  warnings: Array<{ code: string; params?: Record<string, unknown> }>
  moves: { count: number; digest: string }
  program: {
    machineId: string
    machineSource: 'project' | 'probe-baseline'
    lines: number
    moves: number
    digest: string
    warnings: string[]
  }
  /** What a simulation would replay for this operation: its cutter, the stock
   *  it is cut from, the move stream by kind, and how far the bar turns. */
  simulation: {
    stock: { shape: string | null; axis: string | null; thickness: number }
    toolRadius: number
    movesByKind: Record<string, number>
    aRangeDeg: [number, number] | null
    bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null
  }
}

export type BaselineMismatchKind = 'fixture' | 'operation-set' | 'settings' | 'moves' | 'program'

export interface BaselineMismatch {
  kind: BaselineMismatchKind
  operationId: string | null
  detail: string
}

export interface ProbeReport {
  probe: string
  version: number
  generatedAt: string
  engine: { entry: string; root: string; commit: string | null }
  fixture: { path: string; bytes: number; sha256: string; version: string | null; units: string }
  stock: { shape: string | null; axis: string | null; thickness: number }
  warmRuns: number
  operations: OperationReport[]
  baseline?: { path: string; status: 'match' | 'mismatch'; mismatches: BaselineMismatch[] }
}

// ── the measured checkout's engine ───────────────────────────

/** The four functions this probe needs, typed by our own tree's declarations. */
interface EngineTree {
  root: string
  commit: string | null
  normalizeProject(input: unknown): Project
  computeOperationToolpath(
    project: Project,
    operation: Operation,
    options?: { trace?: boolean },
  ): { result: ToolpathResult } | null
  normalizeToolForProject(tool: Tool, project: Project): NormalizedTool
  runPostProcessor(input: PostProcessorInput): PostProcessorResult
  validateMachineDefinition(raw: unknown): MachineDefinition
  bundledDefinitions: MachineDefinition[]
}

/**
 * Load a checkout's engine through dynamic imports from its own tree.
 *
 * A static import would bind this probe's checkout forever, which is the one
 * thing `--root` exists to escape. Every module is imported by absolute file
 * URL, so the reference tree resolves its own dependencies from its own
 * `node_modules`.
 */
export async function loadEngineTree(root: string): Promise<EngineTree> {
  const load = async <T>(path: string): Promise<T> => {
    const url = pathToFileURL(join(root, path)).href
    try {
      return (await import(url)) as T
    } catch (error) {
      throw new ProbeError(
        `cannot load ${path} from ${root}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const projectFormat = await load<{ normalizeProject(input: unknown): Project }>(
    'src/store/helpers/projectFormat.ts',
  )
  const generation = await load<{
    computeOperationToolpath(
      project: Project,
      operation: Operation,
      options?: { trace?: boolean },
    ): { result: ToolpathResult } | null
  }>('src/engine/toolpaths/generateOperation.ts')
  const geometry = await load<{ normalizeToolForProject(tool: Tool, project: Project): NormalizedTool }>(
    'src/engine/toolpaths/geometry.ts',
  )
  const postprocessor = await load<{
    runPostProcessor(input: PostProcessorInput): PostProcessorResult
  }>('src/engine/gcode/postprocessor.ts')
  const types = await load<{ validateMachineDefinition(raw: unknown): MachineDefinition }>(
    'src/engine/gcode/types.ts',
  )
  const definitions = await load<{ BUNDLED_DEFINITIONS: MachineDefinition[] }>(
    'src/engine/gcode/definitions/index.ts',
  )

  for (const [name, value] of [
    ['normalizeProject', projectFormat.normalizeProject],
    ['computeOperationToolpath', generation.computeOperationToolpath],
    ['normalizeToolForProject', geometry.normalizeToolForProject],
    ['runPostProcessor', postprocessor.runPostProcessor],
    ['validateMachineDefinition', types.validateMachineDefinition],
  ] as const) {
    if (typeof value !== 'function') {
      throw new ProbeError(`${root} does not export ${name}; the probe needs a checkout with this API`)
    }
  }
  if (!Array.isArray(definitions.BUNDLED_DEFINITIONS)) {
    throw new ProbeError(`${root} does not export BUNDLED_DEFINITIONS; the probe needs a checkout with this API`)
  }

  return {
    root,
    commit: engineCommit(root),
    normalizeProject: projectFormat.normalizeProject,
    computeOperationToolpath: generation.computeOperationToolpath,
    normalizeToolForProject: geometry.normalizeToolForProject,
    runPostProcessor: postprocessor.runPostProcessor,
    validateMachineDefinition: types.validateMachineDefinition,
    bundledDefinitions: definitions.BUNDLED_DEFINITIONS,
  }
}

/** The measured checkout's HEAD, or null when it is not a git checkout. */
function engineCommit(root: string): string | null {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

// ── argument parsing and operation selection ─────────────────

export interface ProbeDefaults {
  out: string
  root: string
}

/**
 * Parse argv (already sliced past the script name).
 *
 * Strict on purpose: a mistyped flag or a missing value must not silently
 * measure the default checkout with the default output path, because the
 * timings look plausible either way.
 */
export function parseProbeArgs(argv: readonly string[], defaults: ProbeDefaults): ProbeArgs {
  let project: string | null = null
  const operations: string[] = []
  let out = defaults.out
  let root = defaults.root
  let baseline: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new ProbeError(`${flag} needs a value`)
      }
      index += 1
      return next
    }
    switch (flag) {
      case '--project':
        project = value()
        break
      case '--operation': {
        const id = value()
        if (!operations.includes(id)) operations.push(id)
        break
      }
      case '--out':
        out = value()
        break
      case '--root':
        root = value()
        break
      case '--baseline':
        baseline = value()
        break
      default:
        throw new ProbeError(`unknown argument ${flag}`)
    }
  }

  if (project === null) throw new ProbeError('--project <file.camj> is required')
  if (operations.length === 0) throw new ProbeError('--operation <id> is required at least once')
  return {
    project: resolve(project),
    operations,
    out: resolve(out),
    root: resolve(root),
    baseline: baseline === null ? null : resolve(baseline),
  }
}

/**
 * The operations named by id, in the order given.
 *
 * A missing id is a mistyped fixture, not an empty measurement: the message
 * names every operation the file does have, because "op0021 not found" is
 * useless when the file says op0025.
 */
export function selectOperations<T extends { id: string; name?: string }>(
  project: { operations: readonly T[] },
  ids: readonly string[],
): T[] {
  const available = project.operations.map((operation) => operation.id)
  const selected: T[] = []
  for (const id of ids) {
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) {
      const list = available.length === 0 ? '(none)' : available.join(', ')
      throw new ProbeError(`operation ${id} is not in the project; available operations: ${list}`)
    }
    selected.push(operation)
  }
  return selected
}

// ── digests ──────────────────────────────────────────────────

/** SHA-256 of bytes or text, hex. */
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * JSON with object keys sorted, so two equal settings objects always digest
 * the same whatever order they were built in.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    return `{${entries.join(',')}}`
  }
  const serialized = JSON.stringify(value)
  return serialized === undefined ? 'null' : serialized
}

/** One line per move: everything that decides where the tool goes and how fast. */
function moveLine(move: ToolpathResult['moves'][number]): string {
  const point = (value: { x: number; y: number; z: number; a?: number }): string =>
    [value.x, value.y, value.z, value.a ?? ''].join(',')
  return [move.kind, point(move.from), point(move.to), move.source ?? '', move.feedScale ?? ''].join('|')
}

/** A digest of every generated move; `a` (the bar's angle) included. */
export function digestMoves(moves: readonly ToolpathResult['moves'][number][]): string {
  return sha256(moves.map((move) => moveLine(move)).join('\n'))
}

/** The program as posted, with the header's date line collapsed. */
export function normalizeProgramDate(program: string): string {
  return program.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
}

export function digestProgram(program: string): string {
  return sha256(normalizeProgramDate(program))
}

// ── measuring ────────────────────────────────────────────────

function roundMs(value: number): number {
  return Math.round(value * 10) / 10
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new ProbeError('median of no values')
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The machine a program is posted with, and why it was chosen. */
function postMachine(
  tree: EngineTree,
  project: Project,
): { definition: MachineDefinition; id: string; source: 'project' | 'probe-baseline' } {
  const selectedId = project.meta.selectedMachineId
  if (selectedId) {
    const stored = project.meta.machineDefinitions.find((definition) => definition.id === selectedId)
    if (!stored) {
      throw new ProbeError(`the project selects machine ${selectedId}, which it does not carry`)
    }
    return { definition: tree.validateMachineDefinition(stored), id: selectedId, source: 'project' }
  }

  const base = tree.bundledDefinitions.find((definition) => definition.id === BASELINE_MACHINE_BASE)
  if (!base) {
    throw new ProbeError(`${tree.root} bundles no ${BASELINE_MACHINE_BASE} machine definition to post with`)
  }
  const shape = project.stock.shape
  const about = (shape === 'round' || shape === 'square') && project.stock.axis ? project.stock.axis : 'x'
  const definition = tree.validateMachineDefinition({
    ...structuredClone(base),
    rotary: { about, drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  return { definition, id: `${base.id}+${about}-rotary`, source: 'probe-baseline' }
}

function toolFor(tree: EngineTree, project: Project, operation: Operation): NormalizedTool {
  const record = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef)
    : null
  if (!record) {
    throw new ProbeError(`operation ${operation.id} has no tool, so its output has no meaning to hash`)
  }
  return tree.normalizeToolForProject(record, project)
}

function stockAxis(project: Project): string | null {
  const shape = project.stock.shape
  return shape === 'round' || shape === 'square' ? project.stock.axis ?? null : null
}

function operationReport(
  tree: EngineTree,
  project: Project,
  operation: Operation,
): OperationReport {
  const tool = toolFor(tree, project, operation)
  const run = (): ToolpathResult => {
    const envelope = tree.computeOperationToolpath(project, operation)
    if (!envelope) {
      throw new ProbeError(`the engine returned no toolpath for operation ${operation.id}`)
    }
    return envelope.result
  }

  // Cold: the first generation, whatever warm-up it carries. Nothing else is
  // timed — not the load, not the post — because the number #1115 promises is
  // a generation time.
  const coldStart = performance.now()
  let result = run()
  const coldMs = roundMs(performance.now() - coldStart)

  const warmMs: number[] = []
  const digests = new Set<string>([digestMoves(result.moves)])
  for (let index = 0; index < WARM_RUNS; index += 1) {
    const start = performance.now()
    result = run()
    warmMs.push(roundMs(performance.now() - start))
    digests.add(digestMoves(result.moves))
  }

  const machine = postMachine(tree, project)
  const posted = tree.runPostProcessor({
    project,
    operations: [{ operation, tool, toolpath: result }],
    definition: machine.definition,
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  })

  const setup = project.setups?.find((candidate) => candidate.id === operation.setupId) ?? null
  const axis = stockAxis(project)
  const setupAxis = setup && 'orientation' in setup ? setup.orientation.axis : null

  const movesByKind: Record<string, number> = {}
  let aMin = Number.POSITIVE_INFINITY
  let aMax = Number.NEGATIVE_INFINITY
  for (const move of result.moves) {
    movesByKind[move.kind] = (movesByKind[move.kind] ?? 0) + 1
    for (const point of [move.from, move.to]) {
      if (point.a === undefined) continue
      aMin = Math.min(aMin, point.a)
      aMax = Math.max(aMax, point.a)
    }
  }

  return {
    id: operation.id,
    identity: {
      id: operation.id,
      kind: operation.kind,
      axis: {
        stock: axis,
        setup: setupAxis ?? null,
        passDirection: operation.rotaryPassDirection ?? null,
      },
      tool,
      feeds: { feed: operation.feed, plungeFeed: operation.plungeFeed, rpm: operation.rpm },
      settings: {
        stepdown: operation.stepdown,
        stepover: operation.stepover,
        stockToLeaveRadial: operation.stockToLeaveRadial,
        stockToLeaveAxial: operation.stockToLeaveAxial,
        rotaryChuckSupport: operation.rotaryChuckSupport ?? null,
        rotaryTailSupport: operation.rotaryTailSupport ?? null,
        arcFittingEnabled: operation.arcFittingEnabled ?? null,
      },
      operation: structuredClone(operation),
      operationDigest: sha256(stableStringify(operation)),
      toolDigest: sha256(stableStringify(tool)),
    },
    runs: {
      coldMs,
      warmMs,
      medianMs: roundMs(median(warmMs)),
      minMs: Math.min(...warmMs),
      maxMs: Math.max(...warmMs),
      digestStable: digests.size === 1,
    },
    warnings: result.warnings.map((warning) => ({
      code: warning.code,
      ...(warning.params === undefined ? {} : { params: warning.params as Record<string, unknown> }),
    })),
    moves: { count: result.moves.length, digest: digestMoves(result.moves) },
    program: {
      machineId: machine.id,
      machineSource: machine.source,
      lines: posted.stats.lineCount,
      moves: posted.stats.moveCount,
      digest: digestProgram(posted.gcode),
      warnings: posted.warnings.map((warning) => warning.code),
    },
    simulation: {
      stock: {
        shape: project.stock.shape ?? null,
        axis,
        thickness: project.stock.thickness,
      },
      toolRadius: tool.radius,
      movesByKind,
      aRangeDeg: aMin === Number.POSITIVE_INFINITY ? null : [aMin, aMax],
      bounds: result.bounds,
    },
  }
}

// ── baseline comparison ──────────────────────────────────────

function describeValue(value: unknown, limit = 60): string {
  const text = stableStringify(value)
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** Leaf paths whose values differ, with both readings, bounded for reading. */
function diffValues(
  baseline: unknown,
  candidate: unknown,
  prefix: string,
  out: Array<{ path: string; baseline: unknown; candidate: unknown }>,
  limit = 6,
): void {
  if (out.length >= limit) return
  const bothRecords = baseline !== null && candidate !== null
    && typeof baseline === 'object' && typeof candidate === 'object'
    && !Array.isArray(baseline) && !Array.isArray(candidate)
  if (bothRecords) {
    const left = baseline as Record<string, unknown>
    const right = candidate as Record<string, unknown>
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    for (const key of keys) {
      diffValues(left[key], right[key], prefix ? `${prefix}.${key}` : key, out, limit)
      if (out.length >= limit) return
    }
    return
  }
  if (stableStringify(baseline) !== stableStringify(candidate)) {
    out.push({ path: prefix, baseline, candidate })
  }
}

function settingsMismatch(
  operationId: string,
  label: string,
  baseline: unknown,
  candidate: unknown,
): BaselineMismatch | null {
  const differences: Array<{ path: string; baseline: unknown; candidate: unknown }> = []
  diffValues(baseline, candidate, label, differences)
  if (differences.length === 0) {
    // Digests said "different" but the stored objects agree: say so rather than
    // pretending the values explain it.
    return { kind: 'settings', operationId, detail: `${operationId} settings differ (${label})` }
  }
  const described = differences
    .map((entry) => `${entry.path} (baseline ${describeValue(entry.baseline)}, run ${describeValue(entry.candidate)})`)
    .join('; ')
  return { kind: 'settings', operationId, detail: `${operationId} settings differ: ${described}` }
}

/**
 * Everything that must be identical between a run and a stored baseline.
 *
 * Only identity and output: the timings are deliberately not compared here,
 * because a baseline is also the reference for a *later* slice that is meant
 * to be faster.
 */
export function compareReports(baseline: ProbeReport, candidate: ProbeReport): BaselineMismatch[] {
  const mismatches: BaselineMismatch[] = []

  if (baseline.fixture.sha256 !== candidate.fixture.sha256) {
    mismatches.push({
      kind: 'fixture',
      operationId: null,
      detail: `fixture hash differs: baseline ${baseline.fixture.sha256.slice(0, 12)} from ${baseline.fixture.path}, run ${candidate.fixture.sha256.slice(0, 12)} from ${candidate.fixture.path}`,
    })
  }

  const baselineById = new Map(baseline.operations.map((operation) => [operation.id, operation]))
  const candidateById = new Map(candidate.operations.map((operation) => [operation.id, operation]))
  for (const id of candidateById.keys()) {
    if (!baselineById.has(id)) {
      mismatches.push({ kind: 'operation-set', operationId: id, detail: `operation ${id} is not in the baseline` })
    }
  }
  for (const id of baselineById.keys()) {
    if (!candidateById.has(id)) {
      mismatches.push({ kind: 'operation-set', operationId: id, detail: `operation ${id} is missing from the run` })
    }
  }

  for (const operation of candidate.operations) {
    const stored = baselineById.get(operation.id)
    if (!stored) continue

    if (stored.identity.operationDigest !== operation.identity.operationDigest) {
      const mismatch = settingsMismatch(
        operation.id,
        'operation',
        stored.identity.operation,
        operation.identity.operation,
      )
      if (mismatch) mismatches.push(mismatch)
    }
    if (stored.identity.toolDigest !== operation.identity.toolDigest) {
      const mismatch = settingsMismatch(operation.id, 'tool', stored.identity.tool, operation.identity.tool)
      if (mismatch) mismatches.push(mismatch)
    }
    if (stored.moves.digest !== operation.moves.digest) {
      mismatches.push({
        kind: 'moves',
        operationId: operation.id,
        detail: `${operation.id} moves differ: ${stored.moves.count} moves (baseline, ${stored.moves.digest.slice(0, 12)}) vs ${operation.moves.count} moves (run, ${operation.moves.digest.slice(0, 12)})`,
      })
    }
    if (stored.program.digest !== operation.program.digest) {
      mismatches.push({
        kind: 'program',
        operationId: operation.id,
        detail: `${operation.id} posted program differs: ${stored.program.lines} lines (baseline, ${stored.program.digest.slice(0, 12)}) vs ${operation.program.lines} lines (run, ${operation.program.digest.slice(0, 12)})`,
      })
    }
  }

  return mismatches
}

/** Read and lightly validate a stored result before comparing with it. */
export function readBaseline(path: string): ProbeReport {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ProbeError(`cannot read baseline ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ProbeError(`baseline ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const report = parsed as Partial<ProbeReport>
  if (report.probe !== PROBE_NAME || !Array.isArray(report.operations)
    || (report.fixture as { sha256?: unknown } | undefined)?.sha256 === undefined) {
    throw new ProbeError(`${path} is not a ${PROBE_NAME} result`)
  }
  for (const operation of report.operations) {
    const stored = operation as Partial<OperationReport> | undefined
    const complete = stored?.identity !== undefined
      && typeof stored.identity.operationDigest === 'string'
      && typeof stored.identity.toolDigest === 'string'
      && typeof stored.moves?.digest === 'string'
      && typeof stored.program?.digest === 'string'
    if (!complete) {
      throw new ProbeError(`${path} is not a ${PROBE_NAME} result: an operation entry has no id, digests or output hash`)
    }
  }
  return report as ProbeReport
}

// ── the run ──────────────────────────────────────────────────

export async function measure(args: ProbeArgs): Promise<ProbeReport> {
  const tree = await loadEngineTree(args.root)

  const bytes = readFileSync(args.project)
  const fixtureSha256 = sha256(bytes)
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new ProbeError(`${args.project} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  // A fixture this checkout cannot load is a finding, not a crash: the point
  // of `--root` is to find out exactly that about another tree.
  let project: Project
  try {
    project = tree.normalizeProject(raw)
  } catch (error) {
    throw new ProbeError(
      `${args.project} does not load in ${tree.root}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const selected = selectOperations(project, args.operations)

  const operations: OperationReport[] = []
  for (const operation of selected) {
    operations.push(operationReport(tree, project, operation))
  }

  return {
    probe: PROBE_NAME,
    version: PROBE_VERSION,
    generatedAt: new Date().toISOString(),
    engine: { entry: ENGINE_ENTRY, root: tree.root, commit: tree.commit },
    fixture: {
      path: args.project,
      bytes: bytes.length,
      // The bytes on disk, not a re-serialization: the hash has to name the
      // file that was measured even when this tree would normalize it
      // differently from the tree it was saved with.
      sha256: fixtureSha256,
      version: typeof (raw as { version?: unknown }).version === 'string'
        ? (raw as { version: string }).version
        : null,
      units: project.meta.units,
    },
    stock: {
      shape: project.stock.shape ?? null,
      axis: stockAxis(project),
      thickness: project.stock.thickness,
    },
    warmRuns: WARM_RUNS,
    operations,
  }
}

function displayPath(path: string, base: string): string {
  const relativePath = relative(base, path)
  return relativePath === '' || relativePath.startsWith('..') ? path : relativePath
}

function formatTable(report: ProbeReport, base: string): string {
  const rows = report.operations.map((operation) => ({
    id: operation.id,
    kind: operation.identity.kind,
    cold: operation.runs.coldMs.toFixed(1),
    warm: operation.runs.warmMs.map((value) => value.toFixed(1)).join('  '),
    median: operation.runs.medianMs.toFixed(1),
    moves: String(operation.moves.count),
    program: String(operation.program.lines),
  }))
  const header = {
    id: 'operation',
    kind: 'kind',
    cold: 'cold ms',
    warm: 'warm ms (x5)',
    median: 'median ms',
    moves: 'moves',
    program: 'program lines',
  }
  const width = (key: keyof typeof header): number =>
    Math.max(header[key].length, ...rows.map((row) => row[key].length))
  const line = (row: typeof header): string => [
    row.id.padEnd(width('id')),
    row.kind.padEnd(width('kind')),
    row.cold.padStart(width('cold')),
    row.warm.padEnd(width('warm')),
    row.median.padStart(width('median')),
    row.moves.padStart(width('moves')),
    row.program.padStart(width('program')),
  ].join('  ')
  const separator = Object.fromEntries(
    (Object.keys(header) as Array<keyof typeof header>).map((key) => [key, '-'.repeat(width(key))]),
  ) as typeof header

  return [
    `${PROBE_NAME}: fixture ${displayPath(report.fixture.path, base)} (${report.fixture.bytes} bytes, sha256 ${report.fixture.sha256.slice(0, 16)}…)`,
    `engine ${report.engine.root}${report.engine.commit ? ` @ ${report.engine.commit}` : ''}, entry ${report.engine.entry}`,
    `stock ${report.stock.shape ?? 'block'}${report.stock.axis ? ` along ${report.stock.axis}` : ''}, ${report.stock.thickness} ${report.fixture.units}`,
    `runs: 1 cold + ${report.warmRuns} warm forced regenerations per operation`,
    '',
    line(header),
    line(separator),
    ...rows.map(line),
  ].join('\n')
}

const USAGE = `Usage: npx tsx scripts/rotary-generation-probe.ts --project <file.camj> --operation <id> [--operation <id>…]
       [--out <json>] [--root <checkout>] [--baseline <json>]

  --project   the .camj to read (never written)
  --operation operation id to measure; repeat for more than one
  --out       result JSON (default: work/rotary-generation-probe.json in this checkout)
  --root      checkout whose engine is measured (default: this checkout)
  --baseline  stored result to compare with; exits 1 on any identity or output difference`

async function main(argv: readonly string[]): Promise<void> {
  const probeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const defaults: ProbeDefaults = {
    out: join(probeRoot, 'work', `${PROBE_NAME}.json`),
    root: probeRoot,
  }
  if (argv.includes('--help') || argv.length === 0) {
    console.log(USAGE)
    return
  }
  const args = parseProbeArgs(argv, defaults)
  const report = await measure(args)

  if (args.baseline !== null) {
    const baseline = readBaseline(args.baseline)
    const mismatches = compareReports(baseline, report)
    report.baseline = {
      path: args.baseline,
      status: mismatches.length === 0 ? 'match' : 'mismatch',
      mismatches,
    }
  }

  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`)

  console.log(formatTable(report, probeRoot))
  for (const operation of report.operations) {
    if (!operation.runs.digestStable) {
      console.error(
        `${PROBE_NAME}: WARNING operation ${operation.id} produced different moves between runs; a timing baseline over non-deterministic output is meaningless`,
      )
    }
    if (operation.warnings.length > 0) {
      console.log(
        `${operation.id} generation warnings: ${operation.warnings.map((warning) => warning.code).join(', ')}`,
      )
    }
    if (operation.program.warnings.length > 0) {
      console.log(
        `${operation.id} post warnings: ${operation.program.warnings.join(', ')}`,
      )
    }
  }
  console.log(`result ${displayPath(args.out, probeRoot)}`)

  const baselinePath = report.baseline?.path
  if (baselinePath !== undefined && report.baseline) {
    if (report.baseline.status === 'match') {
      console.log(`baseline ${displayPath(baselinePath, probeRoot)}: match`)
    } else {
      console.error(`baseline ${displayPath(baselinePath, probeRoot)}: MISMATCH`)
      for (const mismatch of report.baseline.mismatches) {
        console.error(`  ${mismatch.detail}`)
      }
      process.exitCode = 1
    }
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof ProbeError) {
      console.error(`${PROBE_NAME}: ${error.message}`)
    } else {
      console.error(error)
    }
    process.exitCode = 1
  })
}
