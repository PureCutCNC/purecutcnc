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
 * The rotary generation probe's own guards (#1115 slice p-a).
 *
 * The probe is the measuring instrument every later slice of #1115 trusts, so
 * its refusals are tested and not merely written: a wrong operation id, a
 * baseline whose fixture hash, stock/setup axis or settings differ, a changed
 * move or program digest, an output path that aliases the fixture, a program
 * digest that must still notice a date outside the generated header (including
 * the header's own words inside an ordinary comment, a second stamp-shaped
 * comment after the header, and a *project name* that looks like the stamp —
 * GRBL writes the name above the stamp, so the stamp is found by its generation
 * date and not by being the first lookalike), and a pass-direction control
 * built from the loaded operations instead of a saved copy each have to fail.
 * Those are exactly the mutations this slice is checked with (accept a
 * substituted operation, accept mismatched settings, skip the move-hash
 * comparison, normalize every stamp-shaped line, normalize a stamp anywhere in
 * a line, normalize the first lookalike instead of the generated stamp, mutate
 * a saved fixture for the along control, write over the fixture), so each
 * assertion below is what catches its mutation.
 *
 * Run with: npx tsx scripts/rotary-generation-probe.test.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { newProject, defaultTool, rectProfile } from '../src/types/project'
import type { Operation, Project, Tool } from '../src/types/project'
import type { NormalizedTool, ToolpathMove } from '../src/engine/toolpaths/types'
import { barCentre, barPivotZ, squareStock } from '../src/types/barStock'
import { computeMeshBounds, serializeImportedMesh } from '../src/engine/importedMesh'
import { runPostProcessor } from '../src/engine/gcode/postprocessor'
import { validateMachineDefinition } from '../src/engine/gcode/types'
import { BUNDLED_DEFINITIONS } from '../src/engine/gcode/definitions/index'
import { defaultOperationForTarget } from '../src/store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../src/store/helpers/roundWorkholding'
import { projectWithFeatures } from '../src/test/projectFixtures'
import {
  assertOutputIsNotFixture,
  compareReports,
  digestMoves,
  digestProgram,
  isPassDirection,
  median,
  normalizeProgramDate,
  parseProbeArgs,
  pathsAlias,
  ProbeError,
  readBaseline,
  selectOperations,
  sha256,
  stableStringify,
  withPassDirection,
} from './rotary-generation-probe'
import type { OperationReport, ProbeReport } from './rotary-generation-probe'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = join(HERE, 'rotary-generation-probe.ts')

let failures = 0
function check(name: string, run: () => void): void {
  try {
    run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}`)
    console.error(`     ${error instanceof Error ? error.message.split('\n').join('\n     ') : String(error)}`)
  }
}

// ── fixtures ─────────────────────────────────────────────────

function operationFixture(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op0021',
    name: 'Rotary rough',
    kind: 'rotary_rough',
    setupId: 'su0020',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['model-a'] },
    toolRef: 't0019',
    stepdown: 0.075,
    stepover: 0.16,
    feed: 26,
    plungeFeed: 10,
    rpm: 16000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0.02,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 0,
    maxCarveDepth: 0,
    rotaryPassDirection: 'around',
    ...overrides,
  }
}

function toolFixture(overrides: Partial<NormalizedTool> = {}): NormalizedTool {
  return {
    id: 't0019',
    name: '1/4" Ball Endmill',
    sourceUnits: 'inch',
    units: 'inch',
    type: 'ball_endmill',
    diameter: 0.25,
    radius: 0.125,
    vBitAngle: null,
    flutes: 2,
    material: 'carbide',
    defaultRpm: 16000,
    defaultFeed: 26,
    defaultPlungeFeed: 10,
    defaultStepdown: 0.075,
    defaultStepover: 0.16,
    maxCutDepth: 0.5,
    ...overrides,
  }
}

function movesFixture(count = 3): ToolpathMove[] {
  return Array.from({ length: count }, (_unused, index) => ({
    kind: 'cut' as const,
    from: { x: index, y: 0.5, z: -0.1, a: index * 15 },
    to: { x: index + 1, y: 0.5, z: -0.1, a: (index + 1) * 15 },
    feedScale: 1,
  }))
}

/**
 * A small, real square-bar rotary project whose generation is fast enough to
 * run end to end (#1115 slice p-a). Purpose-built so the CLI test below can
 * measure an actual along control instead of asserting a helper in isolation:
 * one rough and one finish around a square blank, the shape the handoff's
 * busto-rect fixture has.
 */
function squareRotaryProject(direction: 'around' | 'along'): Project {
  const stock = squareStock(20, 40, 'x', { x: 0, y: 0 })
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const radius = 5
  const segments = 96
  // One cylinder of revolution around the bar: a square-to-round model.
  const positions: number[] = []
  const index: number[] = []
  for (const along of [12, 28]) {
    for (let j = 0; j < segments; j += 1) {
      const angle = 2 * Math.PI * j / segments
      positions.push(along, centre + radius * Math.cos(angle), pivot + radius * Math.sin(angle))
    }
  }
  for (let ring = 0; ring + 1 < 2; ring += 1) {
    for (let j = 0; j < segments; j += 1) {
      const next = (j + 1) % segments
      const a = ring * segments + j
      const b = ring * segments + next
      const c = (ring + 1) * segments + next
      const d = (ring + 1) * segments + j
      index.push(a, b, c, a, c, d)
    }
  }

  const base = newProject('Square rotary control', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 25
  base.stock = stock
  base.origin = { name: 'Origin', x: 0, y: 0, z: stock.thickness, visible: true }
  const tool: Tool = {
    ...defaultTool('mm', 1),
    id: 't1',
    name: 'Flat 4',
    units: 'mm',
    type: 'flat_endmill',
    diameter: 4,
    defaultStepover: 0.5,
    defaultStepdown: 1,
  }
  base.tools = [tool]
  const mesh = { positions: new Float32Array(positions), index: new Uint32Array(index) }
  base.modelAssets = { asset: serializeImportedMesh({ ...mesh, bounds: computeMeshBounds(mesh.positions) }, 'stl') }
  const project = projectWithFeatures(base, [{
    id: 'model',
    name: 'Model',
    kind: 'stl',
    operation: 'model',
    authoringFace: 'top',
    folderId: null,
    sketch: {
      profile: rectProfile(12, centre - radius, 16, 2 * radius),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' },
    z_top: pivot + radius,
    z_bottom: pivot - radius,
    visible: true,
    locked: false,
  }])
  project.setups.push({
    ...project.setups[0],
    id: 'around',
    name: 'Around',
    kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  })
  project.activeSetupId = 'around'
  project.clamps = [{ ...defaultRoundWorkholding('chuck', stock, 'mm'), id: 'chuck', name: 'Chuck', visible: true }]
  const target = { source: 'features' as const, featureIds: ['model'] }
  const rough: Operation = {
    ...defaultOperationForTarget(project, 'rotary_rough', 'rough', target, 0),
    setupId: 'around',
    rotaryPassDirection: direction,
    stockToLeaveRadial: 0,
    stepdown: 2,
    stepover: 0.5,
  }
  const finish: Operation = {
    ...defaultOperationForTarget(project, 'rotary_finish', 'finish', target, 1),
    setupId: 'around',
    rotaryPassDirection: direction,
    stockToLeaveRadial: 0,
    stepover: 0.5,
  }
  project.operations = [rough, finish]
  return project
}

function measureControl(
  fixture: string,
  operations: readonly string[],
  out: string,
  extra: readonly string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(
    process.execPath,
    [
      '--import', 'tsx', PROBE,
      '--project', fixture,
      ...operations.flatMap((id) => ['--operation', id]),
      '--out', out,
      ...extra,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  )
  return { status: child.status, stdout: child.stdout, stderr: child.stderr }
}

const PROGRAM = [
  '; probe-fixture',
  '; Generated by PureCutCNC on 2026-11-01',
  'G20',
  'G1 X1.0000 Y0.5000 A15.0000 F26',
  'M30',
].join('\n')

/** The day `PROGRAM` was generated on, as the probe reads it from the post. */
const GENERATED_ON = '2026-11-01'

function operationReportFixture(
  operation: Operation = operationFixture(),
  options: { moves?: ToolpathMove[]; program?: string } = {},
): OperationReport {
  const tool = toolFixture()
  const moves = options.moves ?? movesFixture()
  const program = options.program ?? PROGRAM
  return {
    id: operation.id,
    identity: {
      id: operation.id,
      kind: operation.kind,
      axis: { stock: 'x', setup: 'x', passDirection: operation.rotaryPassDirection ?? null },
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
      operation,
      operationDigest: sha256(stableStringify(operation)),
      toolDigest: sha256(stableStringify(tool)),
    },
    runs: { coldMs: 30000, warmMs: [30000, 30000, 30000, 30000, 30000], medianMs: 30000, minMs: 30000, maxMs: 30000, digestStable: true },
    warnings: [],
    moves: { count: moves.length, digest: digestMoves(moves) },
    program: {
      machineId: 'grbl+x-rotary',
      machineSource: 'probe-baseline',
      lines: program.split('\n').length,
      moves: moves.length,
      digest: digestProgram(program, GENERATED_ON),
      warnings: [],
    },
    simulation: {
      stock: { shape: 'square', axis: 'x', thickness: 2 },
      toolRadius: tool.radius,
      movesByKind: { cut: moves.length },
      aRangeDeg: [0, 45],
      bounds: null,
    },
  }
}

function reportFixture(
  operations: OperationReport[] = [operationReportFixture()],
  fixtureSha: string = 'a'.repeat(64),
): ProbeReport {
  return {
    probe: 'rotary-generation-probe',
    version: 1,
    generatedAt: '2026-11-01T00:00:00.000Z',
    engine: { entry: 'computeOperationToolpath', root: join(tmpdir(), 'checkout'), commit: '1020be40' },
    fixture: { path: join(tmpdir(), 'fixture.camj'), bytes: 10, sha256: fixtureSha, version: '3.3', units: 'inch' },
    stock: { shape: 'square', axis: 'x', thickness: 2 },
    warmRuns: 5,
    operations,
    control: null,
  }
}

// ── the probe refuses what it must ───────────────────────────

check('a wrong operation id is refused, naming the ids that do exist', () => {
  const project = { operations: [operationFixture(), operationFixture({ id: 'op0022', name: 'Rotary finish' })] }
  assert.deepEqual(selectOperations(project, ['op0022']).map((operation) => operation.id), ['op0022'])
  assert.throws(
    () => selectOperations(project, ['op0099']),
    (error: unknown) => error instanceof ProbeError
      && /op0099 is not in the project/.test(error.message)
      && /op0021, op0022/.test(error.message),
    'a substituted operation id must not be measured silently',
  )
})

check('a baseline whose fixture hash differs is a mismatch', () => {
  const baseline = reportFixture()
  const candidate = reportFixture([operationReportFixture()], 'b'.repeat(64))
  const mismatches = compareReports(baseline, candidate)
  assert.equal(mismatches.length, 1)
  assert.equal(mismatches[0].kind, 'fixture')
  assert.match(mismatches[0].detail, /fixture hash differs/)
})

check('a baseline whose settings differ is a mismatch that names the field', () => {
  const baseline = reportFixture([operationReportFixture(operationFixture())])
  const changed = operationFixture({ stepover: 0.17 })
  const candidate = reportFixture([operationReportFixture(changed)])
  const mismatches = compareReports(baseline, candidate)
  assert.equal(mismatches.length, 1)
  assert.equal(mismatches[0].kind, 'settings')
  assert.match(mismatches[0].detail, /stepover \(baseline 0\.16, run 0\.17\)/)
})

check('a baseline whose tool differs is a settings mismatch', () => {
  const entry = operationReportFixture()
  const candidateEntry: OperationReport = {
    ...entry,
    identity: { ...entry.identity, tool: toolFixture({ diameter: 0.125, radius: 0.0625 }) },
  }
  candidateEntry.identity.toolDigest = sha256(stableStringify(candidateEntry.identity.tool))
  const mismatches = compareReports(reportFixture([entry]), reportFixture([candidateEntry]))
  assert.equal(mismatches.length, 1)
  assert.equal(mismatches[0].kind, 'settings')
  assert.match(mismatches[0].detail, /tool\.diameter/)
})

check('a baseline whose move digest differs is a mismatch', () => {
  const baseline = reportFixture([operationReportFixture()])
  const moved = movesFixture()
  moved[1] = { ...moved[1], to: { ...moved[1].to, a: 999 } }
  const candidate = reportFixture([operationReportFixture(operationFixture(), { moves: moved })])
  const mismatches = compareReports(baseline, candidate)
  assert.equal(mismatches.length, 1, `expected one mismatch, got ${JSON.stringify(mismatches)}`)
  assert.equal(mismatches[0].kind, 'moves')
  assert.match(mismatches[0].detail, /op0021 moves differ/)
})

check('a baseline whose posted program differs is a mismatch', () => {
  const baseline = reportFixture([operationReportFixture()])
  const candidate = reportFixture([
    operationReportFixture(operationFixture(), { program: PROGRAM.replace('F26', 'F30') }),
  ])
  const mismatches = compareReports(baseline, candidate)
  assert.equal(mismatches.length, 1)
  assert.equal(mismatches[0].kind, 'program')
})

check('a baseline whose operation set differs is a mismatch', () => {
  const baseline = reportFixture([operationReportFixture()])
  const candidate = reportFixture([operationReportFixture(operationFixture({ id: 'op0022' }))])
  const kinds = compareReports(baseline, candidate).map((mismatch) => mismatch.kind)
  assert.deepEqual(kinds, ['operation-set', 'operation-set'])
})

check('a baseline whose recorded stock axis differs is a mismatch', () => {
  const candidate = reportFixture()
  candidate.stock = { ...candidate.stock, axis: 'y' }
  const mismatches = compareReports(reportFixture(), candidate)
  assert.equal(mismatches.length, 1, `expected one mismatch, got ${JSON.stringify(mismatches)}`)
  assert.equal(mismatches[0].kind, 'stock')
  // The stock axis is not inside the operation object, so the settings digest
  // alone would have called this identical.
  assert.match(mismatches[0].detail, /stock differ: axis \(baseline "x", run "y"\)/)
})

check('a baseline whose recorded setup axis differs is a mismatch', () => {
  const candidate = reportFixture()
  candidate.operations[0].identity.axis = { ...candidate.operations[0].identity.axis, setup: 'y' }
  const mismatches = compareReports(reportFixture(), candidate)
  assert.equal(mismatches.length, 1, `expected one mismatch, got ${JSON.stringify(mismatches)}`)
  assert.equal(mismatches[0].kind, 'axis')
  assert.match(mismatches[0].detail, /axis\.setup \(baseline "x", run "y"\)/)
})

check('an identical run matches even when its timings differ', () => {
  const baseline = reportFixture()
  const rerun = reportFixture()
  rerun.generatedAt = '2026-11-02T12:00:00.000Z'
  rerun.operations = rerun.operations.map((operation) => ({
    ...operation,
    runs: { ...operation.runs, coldMs: 9000, warmMs: [8000, 8000, 8000, 8000, 8000], medianMs: 8000, minMs: 8000, maxMs: 8000 },
  }))
  assert.deepEqual(compareReports(baseline, rerun), [], 'timings are not identity: a faster run is still the same output')
})

check('a malformed baseline is refused before it can be compared', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rotary-probe-baseline-'))
  const path = join(directory, 'baseline.json')
  try {
    writeFileSync(path, JSON.stringify({ probe: 'something-else', operations: [] }))
    assert.throws(() => readBaseline(path), /is not a rotary-generation-probe result/)
    writeFileSync(path, JSON.stringify({ ...reportFixture(), operations: [{ id: 'op0021' }] }))
    assert.throws(() => readBaseline(path), /an operation entry has no id, digests or output hash/)
    writeFileSync(path, '{not json')
    assert.throws(() => readBaseline(path), /is not JSON/)
    assert.throws(() => readBaseline(join(directory, 'missing.json')), /cannot read baseline/)
    writeFileSync(path, JSON.stringify(reportFixture()))
    assert.deepEqual(readBaseline(path).operations.map((operation) => operation.id), ['op0021'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// ── digests are sensitive to what matters ────────────────────

check('the move digest follows an angle, a coordinate and a feed scale', () => {
  const base = movesFixture()
  const digest = digestMoves(base)
  assert.equal(digestMoves(structuredClone(base)), digest, 'the same moves digest the same')
  const angle = structuredClone(base)
  angle[0].to.a = 90
  assert.notEqual(digestMoves(angle), digest, 'a changed rotary angle is a changed move')
  const coordinate = structuredClone(base)
  coordinate[2].from.z = -0.11
  assert.notEqual(digestMoves(coordinate), digest, 'a changed Z is a changed move')
  const feed = structuredClone(base)
  feed[1].feedScale = 0.5
  assert.notEqual(digestMoves(feed), digest, 'a changed feed scale is a changed move')
})

check('the program digest ignores the generated date line and nothing else', () => {
  assert.equal(normalizeProgramDate(PROGRAM, GENERATED_ON).includes('2026-11-01'), false)
  assert.match(
    normalizeProgramDate(PROGRAM, GENERATED_ON),
    /Generated by PureCutCNC on <date>/,
    'the generator line is collapsed where it is written',
  )
  assert.equal(
    digestProgram(PROGRAM.replace('2026-11-01', '2027-03-09'), '2027-03-09'),
    digestProgram(PROGRAM, GENERATED_ON),
    'only the date may differ between two runs of the same output',
  )
  // The same program with a date in an ordinary comment: moving *that* date
  // alone must move the hash, which is what normalizing every date-shaped
  // string would hide.
  const withCommentDate = PROGRAM.replace('; probe-fixture', '; probe-fixture, drawn 2026-11-01')
  assert.notEqual(withCommentDate, PROGRAM, 'the comment date is really in the fixture program')
  assert.notEqual(
    digestProgram(withCommentDate.replace('drawn 2026-11-01', 'drawn 2027-03-09'), GENERATED_ON),
    digestProgram(withCommentDate, GENERATED_ON),
    'a date-shaped string anywhere but the generated line is program text and must move the hash',
  )
  // Review round 2: the header stamp's own words in an ordinary comment are not
  // the header. The unanchored global regex collapsed them, so changing a job
  // note's date left the hash unchanged.
  const jobNote = (date: string): string =>
    PROGRAM.replace('G20', `; job note: Generated by PureCutCNC on ${date}\nG20`)
  assert.notEqual(
    digestProgram(jobNote('2020-01-01'), GENERATED_ON),
    digestProgram(jobNote('2026-11-01'), GENERATED_ON),
    'changing the date in an ordinary comment that repeats the stamp must move the hash',
  )
  assert.equal(
    digestProgram(jobNote('2020-01-01').replace('2026-11-01', '2027-03-09'), '2027-03-09'),
    digestProgram(jobNote('2020-01-01'), GENERATED_ON),
    'the real header date still collapses when an ordinary comment repeats the stamp',
  )
  // A stamp-shaped comment carrying another date is not the generated line, no
  // matter where it sits: its date is program text.
  const decoy = PROGRAM.replace('G20', '; Generated by PureCutCNC on 2020-01-01\nG20')
  assert.notEqual(decoy, PROGRAM, 'the decoy stamp is really in the program')
  assert.notEqual(
    digestProgram(decoy.replace('on 2020-01-01', 'on 2021-01-01'), GENERATED_ON),
    digestProgram(decoy, GENERATED_ON),
    'a second stamp-shaped comment after the header is program text and must move the hash',
  )
  assert.notEqual(
    digestProgram(PROGRAM.replace('G20', 'G21'), GENERATED_ON),
    digestProgram(PROGRAM, GENERATED_ON),
  )
})

check('the stamp is identified by the generation date, not by being first', () => {
  // Round 3 finding: GRBL writes `; {programName}` immediately before its
  // `; Generated by PureCutCNC on {date}` line, so this project name is a whole
  // stamp-shaped line that is not the stamp. Collapsing the first lookalike
  // hid the name's date and left the generation date in the hash.
  const program = (nameDate: string, generatedOn: string): string => [
    `; Generated by PureCutCNC on ${nameDate}`,
    `; Generated by PureCutCNC on ${generatedOn}`,
    'G90',
    'G17',
    'G21',
    'M30',
  ].join('\n')
  const run = program('2020-01-01', GENERATED_ON)
  // The name is program text: renaming the project must move the hash.
  assert.notEqual(
    digestProgram(program('2021-01-01', GENERATED_ON), GENERATED_ON),
    digestProgram(run, GENERATED_ON),
    'a project name that looks like the stamp must still be part of the hash',
  )
  // The generated line is the one carrying the generation date, so moving that
  // date between runs must not.
  assert.equal(
    digestProgram(program('2020-01-01', '2027-03-09'), '2027-03-09'),
    digestProgram(run, GENERATED_ON),
    'the generated date is normalised even when the name above it looks like a stamp',
  )
  const normalized = normalizeProgramDate(run, GENERATED_ON).split('\n')
  assert.equal(normalized[0], '; Generated by PureCutCNC on 2020-01-01', 'the name line stays as program text')
  assert.equal(normalized[1], '; Generated by PureCutCNC on <date>', 'the generated stamp is collapsed')
})

check('the real GRBL postprocessor cannot hide a renamed project behind its stamp', () => {
  // The reproduction from review round 3, against the engine itself rather
  // than hand-written lines: `programName` is what a project is called, and it
  // is emitted above the stamp.
  const base = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl')
  assert.ok(base, 'the bundled grbl definition is available')
  const definition = validateMachineDefinition(structuredClone(base))
  const project = newProject('name-that-looks-like-the-stamp', 'mm')
  const post = (programName: string): string => runPostProcessor({
    project,
    operations: [],
    definition,
    options: { emitToolChanges: true, emitCoolant: false, programName },
  }).gcode

  const posted = post('Generated by PureCutCNC on 2020-01-01')
  const [nameLine, stampLine] = posted.split('\n')
  assert.equal(nameLine, '; Generated by PureCutCNC on 2020-01-01', 'GRBL writes the project name first')
  assert.match(stampLine, /^; Generated by PureCutCNC on \d{4}-\d{2}-\d{2}$/, 'the stamp is the line below it')
  const generatedOn = stampLine.replace('; Generated by PureCutCNC on ', '')
  assert.notEqual(generatedOn, '2020-01-01', 'the stamp carries the day it was posted, not the name copy')

  // A renamed project moves the digest, even though both are stamp-shaped.
  const renamed = post('Generated by PureCutCNC on 2021-01-01')
  assert.notEqual(digestProgram(renamed, generatedOn), digestProgram(posted, generatedOn), 'a rename must move the hash')

  // The generated date does not: the same program posted on another day, with
  // that day passed in, is the same output.
  const nextDay = posted.replace(stampLine, `; Generated by PureCutCNC on 2099-12-31`)
  assert.notEqual(nextDay, posted, 'the generated stamp is really in the posted program')
  assert.equal(
    digestProgram(nextDay, '2099-12-31'),
    digestProgram(posted, generatedOn),
    'only the generation date may differ between two runs of the same output',
  )
})

check('the header date still collapses in every bundled comment dialect', () => {
  // Narrowing the match to the header must not stop it matching the header:
  // these are the shapes the bundled definitions and the OpenSBP emitter write.
  for (const line of [
    '; Generated by PureCutCNC on 2026-11-01',
    '( Generated by PureCutCNC on 2026-11-01 )',
    "' Generated by PureCutCNC on 2026-11-01",
    'N10 ; Generated by PureCutCNC on 2026-11-01',
  ]) {
    const program = `${line}\nG20\nG1 X1.0 F26\n`
    assert.equal(
      normalizeProgramDate(program, GENERATED_ON),
      `${line.replace('2026-11-01', '<date>')}\nG20\nG1 X1.0 F26\n`,
      `the header line ${line} must still collapse`,
    )
  }
})

check('median of five', () => {
  assert.equal(median([5, 1, 4, 2, 3]), 3)
})

// ── the fixture cannot be overwritten ────────────────────────

check('an output path that aliases the fixture is refused', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rotary-probe-alias-'))
  const fixture = join(directory, 'fixture.camj')
  const report = join(directory, 'report.json')
  const viaSymlink = join(directory, 'fixture-link.camj')
  const viaHardlink = join(directory, 'fixture-hard.camj')
  const linkedDirectory = join(directory, 'linked')
  try {
    writeFileSync(fixture, '{"version":"3.3"}')
    symlinkSync(fixture, viaSymlink)
    linkSync(fixture, viaHardlink)
    symlinkSync(directory, linkedDirectory)

    assert.equal(pathsAlias(fixture, fixture), true, 'the same path is the same file')
    assert.equal(pathsAlias(viaSymlink, fixture), true, 'a symlink to the fixture is the fixture')
    assert.equal(pathsAlias(viaHardlink, fixture), true, 'a hardlink to the fixture is the fixture')
    assert.equal(
      pathsAlias(join(linkedDirectory, 'fixture.camj'), fixture),
      true,
      'a path through a symlinked directory resolves to the fixture',
    )
    assert.equal(pathsAlias(report, fixture), false, 'a result file beside the fixture is not the fixture')

    assert.throws(
      () => assertOutputIsNotFixture(fixture, fixture),
      (error: unknown) => error instanceof ProbeError && /never writes it/.test(error.message),
    )
    assert.doesNotThrow(() => assertOutputIsNotFixture(report, fixture))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// ── the pass-direction control is built in memory ────────────

check('an along control copies the operation in memory and never needs a saved fixture', () => {
  const around = operationFixture()
  const control = withPassDirection([around], 'along')
  assert.deepEqual(control.map((operation) => operation.rotaryPassDirection), ['along'])
  assert.equal(around.rotaryPassDirection, 'around', 'the loaded operation is never mutated')
  assert.notEqual(control[0], around, 'the control is a copy, so generation cannot touch the loaded record')
  assert.equal(
    withPassDirection([around, operationFixture({ id: 'op0022', name: 'Rotary finish' })], 'along').length,
    2,
    'every selected operation is copied',
  )
  assert.throws(
    () => withPassDirection([operationFixture({ kind: 'pocket', rotaryPassDirection: undefined })], 'along'),
    (error: unknown) => error instanceof ProbeError
      && /not a rotary operation/.test(error.message)
      && /op0021/.test(error.message),
    'a non-rotary operation has no pass direction to control',
  )
  // A saved rotary operation may omit the field (the generators read that as
  // 'along'), and it is still controllable.
  assert.equal(
    withPassDirection([operationFixture({ rotaryPassDirection: undefined })], 'around')[0].rotaryPassDirection,
    'around',
  )
  assert.equal(isPassDirection('along'), true)
  assert.equal(isPassDirection('around'), true)
  assert.equal(isPassDirection('sideways'), false)
})

check('the CLI measures an along control in memory and leaves the fixture bytes alone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rotary-probe-control-'))
  const fixture = join(directory, 'square-rotary.camj')
  const alongOut = join(directory, 'along.json')
  const aroundOut = join(directory, 'around.json')
  try {
    const project = squareRotaryProject('around')
    const ids = project.operations.map((operation) => operation.id)
    assert.equal(ids.length, 2)
    const saved = JSON.stringify(project)
    writeFileSync(fixture, saved)
    const before = sha256(readFileSync(fixture))

    const along = measureControl(fixture, ids, alongOut, ['--pass-direction', 'along'])
    assert.equal(along.status, 0, `expected a measured control; stdout ${along.stdout} stderr ${along.stderr}`)
    assert.match(along.stdout, /control: pass direction along, built in memory \(fixture unchanged\)/)
    assert.equal(sha256(readFileSync(fixture)), before, 'the control reads the fixture, never rewrites it')
    assert.equal(readFileSync(fixture, 'utf8'), saved, 'the fixture on disk is still the saved project')

    const alongReport = JSON.parse(readFileSync(alongOut, 'utf8')) as ProbeReport
    assert.deepEqual(alongReport.control, { passDirection: 'along' })
    assert.deepEqual(
      alongReport.operations.map((operation) => operation.identity.axis.passDirection),
      ['along', 'along'],
      'both selected operations were copied with the control direction',
    )
    assert.equal(alongReport.fixture.sha256, before, 'the result names the untouched fixture')

    const around = measureControl(fixture, ids, aroundOut)
    assert.equal(around.status, 0, `expected the saved direction to measure; stdout ${around.stdout} stderr ${around.stderr}`)
    const aroundReport = JSON.parse(readFileSync(aroundOut, 'utf8')) as ProbeReport
    assert.equal(aroundReport.control, null)
    assert.deepEqual(
      aroundReport.operations.map((operation) => operation.identity.axis.passDirection),
      ['around', 'around'],
    )
    // The override reached generation, not only the report: an along pass is a
    // different toolpath from the saved around one on the same fixture.
    for (const [index, operation] of alongReport.operations.entries()) {
      assert.notEqual(
        operation.moves.digest,
        aroundReport.operations[index].moves.digest,
        `${operation.id}'s along control must generate along moves`,
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// ── argument parsing ─────────────────────────────────────────

check('arguments are parsed strictly', () => {
  const defaults = { out: join(tmpdir(), 'out.json'), root: join(tmpdir(), 'checkout') }
  const args = parseProbeArgs(
    ['--project', 'fixture.camj', '--operation', 'op0021', '--operation', 'op0022', '--operation', 'op0021', '--baseline', 'base.json'],
    defaults,
  )
  assert.deepEqual(args.operations, ['op0021', 'op0022'], 'repeated ids keep their order and are not duplicated')
  assert.equal(args.out, defaults.out)
  assert.equal(args.root, defaults.root)
  assert.equal(args.passDirection, null, 'a run without the flag measures the fixture as saved')
  assert.match(args.baseline ?? '', /base\.json$/)
  const control = parseProbeArgs(
    ['--project', 'fixture.camj', '--operation', 'op0021', '--pass-direction', 'along'],
    defaults,
  )
  assert.equal(control.passDirection, 'along')
  assert.throws(
    () => parseProbeArgs(['--project', 'fixture.camj', '--operation', 'op0021', '--pass-direction', 'sideways'], defaults),
    /--pass-direction must be one of around, along/,
  )
  assert.throws(() => parseProbeArgs(['--operation', 'op0021'], defaults), /--project/)
  assert.throws(() => parseProbeArgs(['--project', 'fixture.camj'], defaults), /--operation/)
  assert.throws(() => parseProbeArgs(['--project'], defaults), /needs a value/)
  assert.throws(() => parseProbeArgs(['--project', 'f', '--operation', 'o', '--nope', 'x'], defaults), /unknown argument --nope/)
})

// ── the CLI refuses it too, and leaves the fixture alone ─────

check('the CLI exits 1 on an unknown operation id or an output that is the fixture, and never writes it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rotary-probe-'))
  const fixture = join(directory, 'probe-fixture.camj')
  try {
    const project = newProject('probe-fixture', 'mm')
    project.tools = [{ ...project.tools[0], id: 't0019' }]
    project.operations = [{ ...operationFixture(), setupId: project.setups[0].id }]
    writeFileSync(fixture, JSON.stringify(project))
    const before = sha256(readFileSync(fixture))

    const help = spawnSync(process.execPath, ['--import', 'tsx', PROBE, '--help'], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /Usage:/)

    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', PROBE, '--project', fixture, '--operation', 'op0099'],
      { encoding: 'utf8', timeout: 60_000 },
    )
    assert.equal(child.status, 1, `expected a refusal; stdout ${child.stdout} stderr ${child.stderr}`)
    assert.match(child.stderr, /op0099 is not in the project/)
    assert.match(child.stderr, /available operations: op0021/)

    const overwrite = spawnSync(
      process.execPath,
      ['--import', 'tsx', PROBE, '--project', fixture, '--operation', 'op0021', '--out', fixture],
      { encoding: 'utf8', timeout: 60_000 },
    )
    assert.equal(overwrite.status, 1, `expected the fixture to be protected; stdout ${overwrite.stdout} stderr ${overwrite.stderr}`)
    assert.match(overwrite.stderr, /is the fixture/)
    assert.match(overwrite.stderr, /never writes it/)

    assert.equal(sha256(readFileSync(fixture)), before, 'the probe reads the fixture, never writes it')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

if (failures > 0) {
  console.error(`\n${failures} probe test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall rotary-generation-probe tests passed')
}
