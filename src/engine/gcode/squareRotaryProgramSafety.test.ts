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
 * Square-blank program safety (#1016 C2 correction M1, third Codex pass).
 *
 * The planner's turn guard (`trackOperationAngle` + `rotaryTravelZ`) sees only
 * the operation's moves. Two other A words reach a program: the closing unwind,
 * and any A a supplied path carries after a machine template has moved Z behind
 * the emitter's back. That second one is written by *two* emitters — a rapid
 * and a turning feed — so the generator places a turning feed on a G1 as the
 * first rotary motion of an operation a template has just moved Z in front of,
 * not only a rapid. This file proves, on the **emitted text**, that neither can
 * turn a square blank below the generators' travel height.
 *
 * A seeded property test generates a few hundred square programs and posts each
 * whole program through the real postprocessor. An independent modal
 * interpreter written here — deliberately not a postprocessor helper — then
 * replays the text it reads: G0/G1 modal motion, the machine's own rotary word
 * (`A`, or a borrowed motor's X/Y), Z, units, absolute/incremental modes, and
 * G20/G21. Every block that changes the rotary word must execute with Z at or
 * above the emitted travel height (within half a printed decimal). A program
 * the postprocessor refuses may carry no such motion and must name its refusal.
 *
 * Focused tests pin the three cases the property test is built to catch:
 * the unwind retract, the template Z-unknown rule, and the restored
 * whole-operation turning-feed precedence on a round bar. The unwind retract
 * is proven on a square blank and on a round bar, the latter also with a
 * spindle-stop template that lowers Z (mutation: skip non-square unwind
 * retracts → the round assertion fails).
 *
 * Run with: npx tsx src/engine/gcode/squareRotaryProgramSafety.test.ts
 */

import assert from 'node:assert/strict'
import { computeMeshBounds, serializeImportedMesh } from '../importedMesh'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SquareStock, Tool } from '../../types/project'
import { barCentre, barMaxRadius, barPivotZ, isBarStock, squareStock } from '../../types/barStock'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { projectWithFeatures } from '../../test/projectFixtures'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { warningSeverity } from '../toolpaths/warningCodes'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { runPostProcessor } from './postprocessor'
import { rotaryWord, validateMachineDefinition } from './types'
import type { MachineDefinition, PostProcessorResult, RotaryDefinition } from './types'
import { convertLength, MM_PER_INCH } from '../../utils/units'

// ── fixtures ──────────────────────────────────────────────────

type Axis = 'x' | 'y'
type Units = 'mm' | 'inch'
type MachineKind = 'own' | 'borrowed' | 'reversed'

const GRBL = validateMachineDefinition(BUNDLED_DEFINITIONS.find((entry) => entry.id === 'grbl')!)

function machine(kind: MachineKind, axis: Axis): MachineDefinition {
  const rotary: RotaryDefinition = {
    about: axis,
    drive: kind === 'borrowed' ? 'borrowed' : 'own',
    reversed: kind === 'reversed',
    inverseTimeFeed: { on: 'G93', off: 'G94' },
  }
  return validateMachineDefinition({ ...structuredClone(GRBL), id: `${kind}-${axis}`, rotary })
}

/** The same machine with Z-moving template variants layered on. */
function machineWithTemplates(
  kind: MachineKind,
  axis: Axis,
  templates: { header?: string[]; operationHeader?: string[]; toolChange?: string[]; footer?: string[] },
): MachineDefinition {
  const base = machine(kind, axis)
  return {
    ...base,
    program: {
      ...base.program,
      header: [...(templates.header ?? []), ...base.program.header],
      operationHeader: [...(templates.operationHeader ?? []), ...base.program.operationHeader],
      footer: [...base.program.footer, ...(templates.footer ?? [])],
    },
    toolChange: templates.toolChange
      ? { ...base.toolChange, commands: [...templates.toolChange, ...base.toolChange.commands] }
      : base.toolChange,
  }
}

/** The model prism from `rotaryOperationFixture`, scaled and re-centred. */
function modelMesh(axis: Axis, centre: number, scale: number) {
  const raw = [
    3, -2, 4, 27, -2, 4, 27, 2, 4, 3, 2, 4,
    3, -2, 8, 27, -2, 9, 27, 2, 9, 3, 2, 8,
  ]
  const positions = new Float32Array(raw.map((value) => value * scale))
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] += centre
    if (axis === 'y') [positions[i], positions[i + 1]] = [positions[i + 1], positions[i]]
  }
  const index = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  return serializeImportedMesh({ positions, index, bounds: computeMeshBounds(positions) }, 'stl')
}

interface Fixture {
  project: Project
  operation: Operation
  stock: SquareStock
  tool: Tool
}

/** A real square (or round) rotary project with an Around setup and a model. */
function fixture(options: { axis: Axis; units: Units; round?: boolean }): Fixture {
  const { axis, units, round = false } = options
  const scale = units === 'mm' ? 1 : 1 / MM_PER_INCH
  const square = squareStock(12 * scale, 30 * scale, axis, { x: 0, y: 0 })
  const stock = round ? { ...square, shape: 'round' as const } : square
  const base = newProject(`Square safety ${axis} ${units}`, units)
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 25 * scale
  base.stock = stock
  // A real Z origin on the blank's top, so the emitted frame and the project
  // frame differ by exactly one documented offset.
  base.origin = { name: 'Origin', x: 0, y: 0, z: stock.thickness, visible: true }
  const tool: Tool = {
    ...defaultTool(units, 1),
    id: 't1',
    name: 'Ball 2',
    units,
    type: 'ball_endmill',
    diameter: 2 * scale,
    defaultStepover: 0.8,
    defaultStepdown: 1 * scale,
  }
  base.tools = [tool]
  base.modelAssets = { asset: modelMesh(axis, barCentre(square), scale) }
  const profile = axis === 'x'
    ? rectProfile(3 * scale, 4 * scale, 24 * scale, 4 * scale)
    : rectProfile(4 * scale, 3 * scale, 4 * scale, 24 * scale)
  const model = {
    id: 'model', name: 'Model', kind: 'stl' as const, operation: 'model' as const, authoringFace: 'top' as const,
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    stl: { format: 'stl' as const, meshAssetId: 'asset', scale: 1, axisSwap: 'none' as const },
    z_top: 9 * scale, z_bottom: 4 * scale, visible: true, locked: false,
  }
  const project = projectWithFeatures(base, [model])
  project.setups.push({ ...project.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis, angleDeg: 0 } })
  project.activeSetupId = 'around'
  project.clamps = [{ ...defaultRoundWorkholding('chuck', square, units), id: 'chuck', name: 'Chuck', visible: true }]
  project.operations = [{
    ...defaultOperationForTarget(project, 'rotary_finish', 'finish', { source: 'features', featureIds: ['model'] }, 0),
    setupId: 'around',
    stockToLeaveRadial: 0,
  }]
  return { project, operation: project.operations[0], stock: square, tool }
}

function toolpathOf(operation: Operation, moves: ToolpathMove[]): ToolpathResult {
  return { operationId: operation.id, moves, warnings: [], bounds: null }
}

interface PostableOperation {
  operation: Operation
  tool: NormalizedTool
  moves: ToolpathMove[]
}

/** Post a whole program, exactly as the export path would. */
function post(
  project: Project,
  definition: MachineDefinition,
  entries: PostableOperation[],
  emitToolChanges = false,
): PostProcessorResult {
  return runPostProcessor({
    project,
    definition,
    operations: entries.map(({ operation, tool, moves }) => ({
      operation,
      tool,
      toolpath: toolpathOf(operation, moves),
    })),
    options: { emitToolChanges, emitCoolant: false, programName: project.meta.name },
  })
}

function normalizedTool(project: Project, operation: Operation): NormalizedTool {
  return normalizeToolForProject(
    project.tools.find((entry) => entry.id === operation.toolRef)!,
    project,
  )
}

/** The emitted travel height for a square blank, independent of any helper. */
function emittedTravelZ(stock: SquareStock, units: Units, definition: MachineDefinition, project: Project): number {
  assert.equal(definition.coordinateSystem.zAxis, 'Z', 'fixture: the emitted Z runs up')
  const projectTravel = barPivotZ(stock) + barMaxRadius(stock) + convertLength(1, 'mm', units)
  return projectTravel - project.origin.z
}

function emittedHalfStep(definition: MachineDefinition, units: Units): number {
  return 0.5 * 10 ** -definition.numberFormat.decimalPlaces[units]
}

// ── independent modal interpreter ─────────────────────────────

interface Audit {
  blocks: number
  turns: number
  /** Every rotary change whose execution Z was not proven clear. */
  violations: string[]
  units: Units | null
}

/**
 * Replay emitted G-code and prove every block that changes the machine's rotary
 * word executes with Z at or above `safeZ - tolerance`. Nothing here imports a
 * postprocessor or motion-planning helper: it reads the text only.
 *
 * A block that changes the rotary word at the same time it moves Z is judged on
 * both ends of the move — the A word changes across the whole move, so a start
 * below the height is just as unsafe as an end below it. A rotary change with
 * no known Z at all is a violation (there is nothing to prove).
 *
 * A `G53` block is in machine coordinates (#1054 fix 3), so its Z is not a work
 * height and is not compared with `safeZ`. It is taken as the top of travel, the
 * documented assumption of `motion.machineSafeZ` (the machine is homed with Z at
 * the top), so a later rotary change stays clear.
 */
function auditProgram(gcode: string, rotaryLetter: 'A' | 'X' | 'Y', safeZ: number, tolerance: number): Audit {
  type Motion = 'G0' | 'G1' | 'G2' | 'G3'
  let motion: Motion | null = null
  let absolute = true
  let units: Units | null = null
  let z: number | null = null
  let rotary: number | null = null
  let blocks = 0
  let turns = 0
  const violations: string[] = []

  for (const [lineIndex, raw] of gcode.split(/\r?\n/).entries()) {
    let line = raw.replace(/\([^)]*\)/g, ' ')
    const semicolon = line.indexOf(';')
    if (semicolon >= 0) line = line.slice(0, semicolon)
    line = line.trim()
    if (line.length === 0 || line === '%') continue

    const words: Array<{ letter: string; value: number | null }> = []
    for (const match of line.matchAll(/([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)) {
      words.push({ letter: match[1].toUpperCase(), value: Number(match[2]) })
    }
    if (words.length === 0) continue

    let blockMotion: Motion | null = motion
    let blockZ: number | null = z
    let blockRotary: number | null = rotary
    let blockMachineCoordinate = false
    let blockHasZ = false
    let hasMotionWord = false
    let hasAxisWord = false
    for (const word of words) {
      switch (word.letter) {
        case 'G': {
          const code = Math.trunc(word.value ?? -1)
          if (code === 0 || code === 1 || code === 2 || code === 3) {
            blockMotion = `G${code}` as Motion
            hasMotionWord = true
          } else if (code === 20) {
            units = 'inch'
          } else if (code === 21) {
            units = 'mm'
          } else if (code === 53) {
            blockMachineCoordinate = true
          } else if (code === 90) {
            absolute = true
          } else if (code === 91) {
            absolute = false
          }
          break
        }
        case 'X':
        case 'Y': {
          // A borrowed motor's rotary word rides the X/Y letter; that word is
          // an angle, not a linear coordinate, so it is handled here.
          if (word.letter === rotaryLetter) {
            hasAxisWord = true
            blockRotary = absolute ? (word.value ?? 0) : (blockRotary ?? 0) + (word.value ?? 0)
          }
          break
        }
        case 'A': {
          if (rotaryLetter === 'A') {
            hasAxisWord = true
            blockRotary = absolute ? (word.value ?? 0) : (blockRotary ?? 0) + (word.value ?? 0)
          }
          break
        }
        case 'Z': {
          hasAxisWord = true
          blockHasZ = true
          blockZ = absolute ? (word.value ?? 0) : (blockZ ?? 0) + (word.value ?? 0)
          break
        }
        default:
          break
      }
    }

    if (blockMachineCoordinate && blockHasZ) {
      // G53 is a machine coordinate, so this Z is not a work height. Taken as
      // the top of travel (the machineSafeZ assumption), it proves the next
      // rotary change clear.
      blockZ = Number.POSITIVE_INFINITY
    }

    if (blockMotion !== null && (hasMotionWord || hasAxisWord)) {
      blocks += 1
      const changesRotary = blockRotary !== rotary
      if (changesRotary) {
        turns += 1
        const startZ = z
        const endZ = blockZ
        const low = startZ === null || endZ === null ? null : Math.min(startZ, endZ)
        if (low === null) {
          violations.push(`line ${lineIndex + 1}: rotary change with no known Z (${raw.trim()})`)
        } else if (low < safeZ - tolerance) {
          violations.push(
            `line ${lineIndex + 1}: rotary ${String(rotary)} -> ${String(blockRotary)} at Z${low.toFixed(4)}`
            + ` below ${safeZ.toFixed(4)} (${raw.trim()})`,
          )
        }
      }
    }

    motion = blockMotion
    z = blockZ
    rotary = blockRotary
  }

  return { blocks, turns, violations, units }
}

// ── seeded generator ─────────────────────────────────────────

const SEED = 1016
const PROGRAM_COUNT = 300

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type TemplateVariant = 'none' | 'header' | 'operationHeader' | 'toolChange' | 'footer' | 'all'

interface Generated {
  label: string
  definition: MachineDefinition
  entries: PostableOperation[]
  project: Project
  stock: SquareStock
  units: Units
  kind: MachineKind
  unsafe: boolean
  endsLow: boolean
  template: TemplateVariant
  /** True when some operation after a Z-moving template starts by turning on a G1. */
  feedFirst: boolean
  emitToolChanges: boolean
}

/**
 * One seeded program. A path is built as a chain of moves in project
 * coordinates: a safe turn, a constant-angle descent, an A-only rapid whose
 * endpoints agree while the controller is at another angle, and the deliberate
 * low turn an unsafe program ends on. The template variants put a Z move in the
 * header, an operation header, a tool change or the footer.
 */
function generate(rand: () => number, index: number): Generated {
  const axis: Axis = rand() < 0.5 ? 'x' : 'y'
  const units: Units = rand() < 0.5 ? 'mm' : 'inch'
  const kind: MachineKind = rand() < 0.5 ? 'own' : rand() < 0.5 ? 'borrowed' : 'reversed'
  const unsafe = rand() < 0.28
  const templateRoll = rand()
  const template: TemplateVariant = templateRoll < 0.2 ? 'none'
    : templateRoll < 0.38 ? 'header'
      : templateRoll < 0.56 ? 'operationHeader'
        : templateRoll < 0.74 ? 'toolChange'
          : templateRoll < 0.86 ? 'footer'
            : 'all'
  const multiOperation = !unsafe && (template === 'operationHeader' || template === 'toolChange' || template === 'all' || rand() < 0.3)
  const { project, operation, stock, tool } = fixture({ axis, units })
  const secondTool: Tool = { ...tool, id: 't2', name: 'Ball 2 second' }
  project.tools = [tool, secondTool]

  const travelZ = barPivotZ(stock) + barMaxRadius(stock) + convertLength(1, 'mm', units)
  const pivotZ = barPivotZ(stock)
  const lowZ = pivotZ + convertLength(1, 'mm', units)
  const halfStep = emittedHalfStep(machine(kind, axis), units)
  const travelEmitted = emittedTravelZ(stock, units, machine(kind, axis), project)
  const centre = barCentre(stock)
  const alongMin = units === 'mm' ? 4 : 4 / MM_PER_INCH
  const alongMax = units === 'mm' ? 26 : 26 / MM_PER_INCH
  const lowTemplateZ = travelEmitted - convertLength(2, 'mm', units)

  const templates = {
    header: template === 'header' || template === 'all' ? [`G0 Z${lowTemplateZ.toFixed(6)}`] : undefined,
    operationHeader: template === 'operationHeader' || template === 'all' ? [`G0 Z${lowTemplateZ.toFixed(6)}`] : undefined,
    toolChange: template === 'toolChange' || template === 'all' ? [`G0 Z${lowTemplateZ.toFixed(6)}`] : undefined,
    footer: template === 'footer' || template === 'all' ? [`G0 Z${lowTemplateZ.toFixed(6)}`] : undefined,
  }
  const definition = machineWithTemplates(kind, axis, templates)
  assert.ok(halfStep > 0 && Number.isFinite(travelEmitted), 'fixture: a finite travel height')

  type RotaryPoint = ToolpathPoint & { a: number }
  const point = (along: number, z: number, a: number): RotaryPoint => axis === 'x'
    ? { x: along, y: centre, z, a }
    : { x: centre, y: along, z, a }

  const operationsCount = multiOperation ? (template === 'none' ? 2 : 2 + Math.trunc(rand() * 2)) : 1
  const entries: PostableOperation[] = []
  let carryA = 0
  let carryAlong = alongMin + rand() * (alongMax - alongMin)
  let endsLow = false
  let feedFirst = false

  for (let opIndex = 0; opIndex < operationsCount; opIndex += 1) {
    const op: Operation = opIndex === 0
      ? operation
      : { ...operation, id: `op${opIndex + 1}`, name: `Operation ${opIndex + 1}`, toolRef: 't2' }
    const moves: ToolpathMove[] = []
    let current: RotaryPoint = point(carryAlong, travelZ, carryA)
    const push = (kind_: 'rapid' | 'cut', to: RotaryPoint) => {
      moves.push({ kind: kind_, from: current, to })
      current = to
    }
    const ensureTravel = () => {
      if (current.z !== travelZ) push('rapid', { ...current, z: travelZ })
    }
    const ensureLow = () => {
      if (current.z !== lowZ) push(rand() < 0.5 ? 'rapid' : 'cut', { ...current, z: lowZ })
    }
    const nextAlong = () => alongMin + rand() * (alongMax - alongMin)
    const stepTurn = (delta: number, kind_: 'rapid' | 'cut') => {
      ensureTravel()
      push(kind_, point(nextAlong(), travelZ, current.a + delta))
    }
    const stepDescent = () => push(rand() < 0.5 ? 'rapid' : 'cut', point(current.x === centre ? nextAlong() : current.x, lowZ + rand() * (travelZ - lowZ), current.a))
    const staleAOnly = (z: number, delta: number) => {
      const to = point(current.x === centre ? nextAlong() : current.x, z, current.a + delta)
      moves.push({ kind: 'rapid', from: { ...current, a: to.a }, to })
      current = to
    }

    // Operation entry at travel height establishes the carried angle. With a
    // Z-moving template before the second operation's moves, the first block
    // that turns must not depend on the stale tracked Z. Half of those entries
    // turn on a feed instead of a rapid, so the *feed* emitter's own unknown-Z
    // repair is exercised too: the cut starts at the angle the previous
    // operation ended on and changes it at travel height, which the planner
    // admits because the turn itself is at the travel height.
    if (opIndex > 0 && (template === 'operationHeader' || template === 'toolChange' || template === 'all')) {
      const angle = current.a + 17
      const along = current.x === centre ? nextAlong() : current.x
      if (rand() < 0.5) {
        push('cut', point(nextAlong(), travelZ, angle))
        feedFirst = true
      } else {
        push('rapid', point(along, travelZ, angle))
      }
    } else {
      push('rapid', point(current.x === centre ? nextAlong() : current.x, travelZ, current.a))
    }

    const segments = 2 + Math.trunc(rand() * 5)
    for (let segment = 0; segment < segments; segment += 1) {
      const roll = rand()
      if (roll < 0.4) {
        stepTurn((rand() < 0.5 ? 1 : -1) * (10 + rand() * 50), rand() < 0.5 ? 'rapid' : 'cut')
      } else if (roll < 0.62) {
        stepDescent()
      } else if (roll < 0.78) {
        ensureTravel()
        staleAOnly(travelZ, (rand() < 0.5 ? 1 : -1) * (10 + rand() * 50))
      } else {
        ensureTravel()
        push(rand() < 0.5 ? 'rapid' : 'cut', point(nextAlong(), travelZ, current.a))
      }
    }

    // The last operation may legitimately finish below the travel height: a
    // constant-angle descent is not a turn, and the closing unwind must then
    // retract before it turns. Earlier operations end clear so the next
    // template exposure starts from a known height.
    const last = opIndex === operationsCount - 1
    if (last && !unsafe && rand() < 0.55) {
      ensureLow()
      endsLow = true
    } else {
      ensureTravel()
    }

    if (unsafe && last) {
      // Two deliberate violations, only one of which the old endpoint test
      // also saw: a normal low turn (from.a !== to.a) and a rapid whose
      // endpoints agree but whose controller angle is elsewhere.
      ensureLow()
      if (rand() < 0.5) {
        push('rapid', point(current.x === centre ? nextAlong() : current.x, lowZ, current.a + 33))
      } else {
        staleAOnly(lowZ, current.a + 33)
      }
      ensureTravel()
    }

    carryA = current.a
    carryAlong = current.x === centre ? nextAlong() : current.x
    entries.push({ operation: op, tool: normalizedTool(project, op), moves })
  }

  // Warnings and labels carry only deterministic fixture facts.
  const label = `#${index} ${axis}/${units}/${kind}/${template}${multiOperation ? '/multi' : ''}${unsafe ? '/unsafe' : ''}`
  assert.ok(Number.isFinite(travelZ) && Number.isFinite(lowZ), `${label}: finite fixture heights`)
  return {
    label,
    definition,
    entries,
    project,
    stock,
    units,
    kind,
    unsafe,
    endsLow,
    template,
    feedFirst,
    emitToolChanges: multiOperation && entries.length > 1,
  }
}

// ── 1. seeded property: every emitted A change is clear ──────

console.log(`Testing ${PROGRAM_COUNT} seeded square programs (seed ${SEED})...`)
{
  const rand = random(SEED)
  let refused = 0
  let audited = 0
  let turns = 0
  let lowEndings = 0
  let templated = 0
  let unsafePrograms = 0
  let feedFirstAccepted = 0
  const feedFirstCoverage = new Set<string>()

  for (let index = 0; index < PROGRAM_COUNT; index += 1) {
    const program = generate(rand, index)
    const { project, stock, units, definition } = program
    if (program.unsafe) unsafePrograms += 1
    if (program.endsLow) lowEndings += 1
    if (program.template !== 'none') templated += 1
    const result = post(project, definition, program.entries, program.emitToolChanges)
    const errors = result.warnings.filter((warning) => warningSeverity(warning.code) === 'error')
    const refusedProgram = errors.length > 0
    if (refusedProgram) {
      refused += 1
      assert.ok(result.warnings.length > 0, `${program.label}: a refused program carries a refusal code`)
      continue
    }

    audited += 1
    if (program.feedFirst) {
      feedFirstAccepted += 1
      feedFirstCoverage.add(`${program.kind}/${program.units}`)
    }
    const letter = rotaryWord(definition)
    assert.ok(letter !== null, `${program.label}: an accepted program has a rotary word`)
    if (letter === null) throw new Error('unreachable')
    const safeZ = emittedTravelZ(stock, units, definition, project)
    const audit = auditProgram(result.gcode, letter, safeZ, emittedHalfStep(definition, units))
    assert.equal(audit.units, units, `${program.label}: the program declares its own unit system`)
    assert.deepEqual(audit.violations, [], `${program.label}: every rotary change executes above the travel height`)
    assert.ok(audit.turns > 0, `${program.label}: an accepted turning program actually turns`)
    turns += audit.turns
  }

  // The generator must actually exercise both hazards and both remedies.
  assert.ok(audited > 120, `fixture: most programs are accepted (${audited})`)
  assert.ok(refused > 40, `fixture: unsafe paths are refused (${refused})`)
  assert.ok(unsafePrograms > 40, `fixture: deliberate low turns are generated (${unsafePrograms})`)
  assert.ok(lowEndings > 50, `fixture: many accepted programs finish below travel height (${lowEndings})`)
  assert.ok(templated > 80, `fixture: Z-moving templates are generated (${templated})`)
  assert.ok(turns > 500, `fixture: the interpreter proves many rotary changes (${turns})`)
  // The feed emitter's own repair is only load-bearing if accepted programs
  // reach it: a turning feed that is the first motion after a template. Cover
  // every drive/unit pair so a mutation of that call cannot pass on one
  // machine configuration alone.
  assert.ok(feedFirstAccepted > 20, `fixture: accepted programs turn on a feed first after a template (${feedFirstAccepted})`)
  assert.equal(
    feedFirstCoverage.size,
    6,
    `fixture: feed-first entries cover own/borrowed/reversed in mm and inch (${[...feedFirstCoverage].sort().join(', ')})`,
  )
  console.log(`   ${audited} accepted, ${refused} refused, ${turns} rotary changes proven, ${lowEndings} low endings, ${templated} templated`)
  console.log(`   ${feedFirstAccepted} accepted feed-first turns (${[...feedFirstCoverage].sort().join(', ')})`)
}

// ── 2. the closing unwind retracts a square blank ─────────────

console.log('Testing the closing unwind retract on a square blank...')
{
  const { project, operation, stock } = fixture({ axis: 'x', units: 'mm' })
  const definition = machine('own', 'x')
  const centre = barCentre(stock)
  const travelZ = barPivotZ(stock) + barMaxRadius(stock) + convertLength(1, 'mm', 'mm')
  const lowZ = barPivotZ(stock) + 1
  const point = (z: number, a: number): ToolpathPoint => ({ x: 15, y: centre, z, a })
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: point(travelZ, 0), to: point(travelZ, 0) },
    { kind: 'cut', from: point(travelZ, 0), to: point(travelZ, 45) },
    { kind: 'rapid', from: point(travelZ, 45), to: point(lowZ, 45) },
  ]
  const result = post(project, definition, [{ operation, tool: normalizedTool(project, operation), moves }])
  assert.deepEqual(result.warnings, [], 'the safe turn plus a constant-angle descent is accepted')
  const letter = rotaryWord(definition)!
  const audit = auditProgram(result.gcode, letter, emittedTravelZ(stock, 'mm', definition, project), emittedHalfStep(definition, 'mm'))
  assert.deepEqual(audit.violations, [], 'the closing unwind does not turn at the descent height')
  assert.ok(audit.turns >= 2, 'the probe actually turns twice: to A45 and back to A0')
  assert.match(result.gcode, /A0/, 'the program still unwinds the bar')
  // The round bar gets the same closing retract (#1054 fix 1, finding 2): its
  // travel height is the crown plus 1 mm, emitted above the blank's top.
  const round = fixture({ axis: 'x', units: 'mm', round: true })
  const roundResult = post(round.project, machine('own', 'x'), [{
    operation: round.operation,
    tool: normalizedTool(round.project, round.operation),
    moves,
  }])
  const roundBar = round.project.stock
  assert.ok(isBarStock(roundBar), 'fixture: the round project has bar stock')
  // GRBL applies no tool-length compensation, so the retract is the machine
  // definition's own Safe Z (#1054 fix 3), not the work-coordinate travel
  // height and not the project's Safe Z mapped through the origin.
  const roundSafe = machine('own', 'x').motion.machineSafeZ.toFixed(3)
  assert.match(
    roundResult.gcode,
    new RegExp(`G53 G0 Z${roundSafe}\\nG0 A0`),
    'a round bar also retracts to the machine Safe Z before the closing unwind',
  )

  // The reviewer's repro (#1054 fix 1, finding 2): a spindle-stop template that
  // lowers Z into cleared space behind the emitter's back. The template's Z is
  // unknown, so the unwind must retract to the bar's travel height even though
  // the last tracked motion ended high.
  const base = machine('own', 'x')
  const dropping = {
    ...base,
    feedSpeed: { ...base.feedSpeed, spindleOff: 'M5\nG0 Z-2' },
  }
  const droppingResult = post(round.project, dropping, [{
    operation: round.operation,
    tool: normalizedTool(round.project, round.operation),
    moves,
  }])
  assert.match(
    droppingResult.gcode,
    new RegExp(`G0 Z-2\\nG53 G0 Z${roundSafe}\\nG0 A0`),
    'the template Z move is repaired before the unwind turns the bar',
  )
  assert.match(droppingResult.gcode, /G0 Z-2/, 'the template line is still written')
}

// ── 3. a Z-moving template cannot hide the cutter height ──────

console.log('Testing the template Z-unknown rule...')
{
  const { project, operation, stock } = fixture({ axis: 'x', units: 'mm' })
  const travelZ = barPivotZ(stock) + barMaxRadius(stock) + convertLength(1, 'mm', 'mm')
  const emittedTravel = emittedTravelZ(stock, 'mm', machine('own', 'x'), project)
  const centre = barCentre(stock)
  const point = (along: number, z: number, a: number): ToolpathPoint => ({ x: along, y: centre, z, a })
  const first: PostableOperation = {
    operation,
    tool: normalizedTool(project, operation),
    moves: [
      { kind: 'rapid', from: point(15, travelZ, 0), to: point(15, travelZ, 0) },
      { kind: 'cut', from: point(15, travelZ, 0), to: point(15, travelZ, 30) },
    ],
  }
  const secondOp: Operation = { ...operation, id: 'op2', name: 'Operation 2' }
  const second: PostableOperation = {
    operation: secondOp,
    tool: normalizedTool(project, secondOp),
    // The first block of the second operation turns with no Z word: under the
    // stale-Z bug it executes at the header's low Z.
    moves: [
      { kind: 'rapid', from: point(15, travelZ, 30), to: point(15, travelZ, 60) },
      { kind: 'cut', from: point(15, travelZ, 60), to: point(15, travelZ, 75) },
    ],
  }
  const definition = machineWithTemplates('own', 'x', {
    operationHeader: [`G0 Z${(emittedTravel - 2).toFixed(6)}`],
  })
  const result = post(project, definition, [first, second])
  assert.deepEqual(result.warnings, [], 'the program is recoverable, so it is not refused')
  const audit = auditProgram(result.gcode, 'A', emittedTravel, emittedHalfStep(definition, 'mm'))
  assert.deepEqual(audit.violations, [], 'the template Z move is repaired before the next A word')
  assert.ok(audit.turns >= 3, 'the probe turns to A30, then establishes A60 and A75')
  // The template line is still emitted: the program did not silently drop it.
  assert.match(result.gcode, new RegExp(`G0 Z${(emittedTravel - 2).toFixed(6)}`), 'the template Z move is written')
}

// ── 4. restored round-bar turning-feed precedence ─────────────

console.log('Testing round-bar refusal precedence with an unestablished feed...')
{
  const { project, operation, stock } = fixture({ axis: 'x', units: 'mm', round: true })
  const definition = validateMachineDefinition({
    ...structuredClone(GRBL),
    id: 'no-inverse',
    rotary: {
      about: 'x',
      drive: 'own',
      reversed: false,
      inverseTimeFeed: null,
    },
  })
  const centre = barCentre(stock)
  const high = stock.thickness + 5
  const at = (a: number): ToolpathPoint => ({ x: 15, y: centre, z: high, a })
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: at(0), to: at(0) },
    // A feed that starts before the controller is at A45: the tracker stops
    // here. The later feed turns (A45 -> A90) and must still select the
    // inverse-time refusal, not the unestablished-angle one.
    { kind: 'cut', from: at(45), to: at(45) },
    { kind: 'cut', from: at(45), to: at(90) },
  ]
  const result = post(project, definition, [{
    operation,
    tool: normalizedTool(project, operation),
    moves,
  }])
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['postRotaryNoInverseTime'],
    'the later turning feed decides the round-bar refusal, as before M1G',
  )
}

console.log('engine/gcode/squareRotaryProgramSafety.test.ts: all assertions passed')
