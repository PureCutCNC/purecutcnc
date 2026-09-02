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
 * Toolpath-cache invalidation guards (issue #601).
 *
 * 1. Field-classification guards: every field of `Operation` and
 *    `FeatureInstance` must carry an explicit compare/ignore classification
 *    mirroring the cache predicates — a future unclassified field fails the
 *    build via `Record<keyof T, ...>`, and each classification is verified
 *    behaviourally against the live predicate.
 *
 * 2. G-code byte-identity through the cache path: for every committed engine
 *    fixture, G-code served from a production-shaped cache entry must be
 *    byte-identical to fresh generation.
 *
 * Run with: npx tsx src/app/toolpathCacheGuards.test.ts
 */

import { readFileSync } from 'node:fs'
import type { FeatureInstance, Operation, Project } from '../types/project'
import { newProject } from '../types/project'
import { normalizeProject } from '../store/projectStore'
import { projectWithFeatures } from '../test/projectFixtures'
import {
  buildToolpathCacheEntry,
  isCacheHit,
  operationComputationEquals,
} from './useToolpathGeneration'
import {
  generateFinishSurfaceCleanupToolpath,
  generateFinishSurfaceToolpath,
  generateRoughSurfaceToolpath,
  generateVCarveMedialToolpath,
  optimizeLinearMoves,
} from '../engine/toolpaths'
import { featureInstanceComputationEquals } from '../engine/toolpaths/toolpathDependencies'
import { runPostProcessor } from '../engine/gcode/postprocessor'
import { validateMachineDefinition, type MachineDefinition } from '../engine/gcode/types'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import type { ToolpathResult } from '../engine/toolpaths'
import type { SketchFeature } from '../types/project'
import { rectProfile } from '../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// =====================================================================
// 1. Field-classification guards (#601)
//
// `operationComputationEquals` and `featureInstanceComputationEquals`
// compare an explicit list of fields; anything unlisted is silently
// ignored by the cache. These maps force every field of both types to
// be classified explicitly: adding a field without classifying it here
// is a compile error (`Record<keyof T, ...>` rejects the missing key),
// which is exactly the "any new field must be listed" guard #518 asked
// for and #601 requires.
// =====================================================================

type FieldClass = 'compare' | 'ignore'

const OPERATION_FIELD_CLASSIFICATION: Record<keyof Operation, FieldClass> = {
  // display / lifecycle only — never read by a resolver
  id: 'ignore',
  name: 'ignore',
  description: 'ignore',
  enabled: 'ignore', // filtering happens upstream of the cache
  showToolpath: 'ignore',
  // export-only preference (see types/project.ts): read by the postprocessor,
  // never by a generator, so cached raw moves stay valid when it flips
  arcFittingEnabled: 'ignore',
  // computation-relevant — mirrored from operationComputationEquals
  kind: 'compare',
  pass: 'compare',
  target: 'compare',
  toolRef: 'compare',
  stepdown: 'compare',
  stepover: 'compare',
  feed: 'compare',
  plungeFeed: 'compare',
  rpm: 'compare',
  pocketPattern: 'compare',
  pocketAngle: 'compare',
  edgeStrategy: 'compare',
  carveStrategy: 'compare',
  trochoidalCutWidth: 'compare',
  trochoidalAdvance: 'compare',
  entryStrategy: 'compare',
  entryRampAngle: 'compare',
  entryHelixDiameterPercent: 'compare',
  xyLeadStrategy: 'compare',
  pocketSlotFeedPercent: 'compare',
  pocketFeedReduction: 'compare',
  roundOutsideCorners: 'compare',
  roundLinkCorners: 'compare',
  cleanWallCorners: 'compare',
  cornerRelief: 'compare',
  stockToLeaveRadial: 'compare',
  stockToLeaveAxial: 'compare',
  finishWalls: 'compare',
  finishFloor: 'compare',
  carveDepth: 'compare',
  maxCarveDepth: 'compare',
  cutDirection: 'compare',
  machiningOrder: 'compare',
  drillType: 'compare',
  peckDepth: 'compare',
  dwellTime: 'compare',
  countersinkDiameter: 'compare',
  retractHeight: 'compare',
  debugToolpath: 'compare',
  debugShowRejectedCorners: 'compare',
  finishSlopeMin: 'compare',
  finishSlopeMax: 'compare',
  waterlineAdaptiveRefinement: 'compare',
  waterlineMicroStepover: 'compare',
  waterlineRefinementThreshold: 'compare',
  waterlineMaxRingsPerBand: 'compare',
  waterlineTipStepdown: 'compare',
}

const FEATURE_FIELD_CLASSIFICATION: Record<keyof FeatureInstance, FieldClass> = {
  id: 'ignore', // diff key, not compared
  folderId: 'ignore', // machining role lives on the definition; see toolpathDependencies.ts
  visible: 'ignore',
  locked: 'ignore',
  name: 'compare', // deliberately compared today — flipping this is a design change
  definitionId: 'compare',
  transform: 'compare',
  constraints: 'compare',
  z_top: 'compare',
  z_bottom: 'compare',
}

/** A copy of `base` with exactly one field changed to a different value.
 *  Objects get fresh references (matching identity comparisons); scalars
 *  get value changes; arrays get a content change (constraints deep-compare,
 *  so a same-content clone would legitimately stay "equal"). */
function objectWithFieldChanged<T extends object>(base: T, field: keyof T): T {
  const record: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  const current = record[field as string]
  if (current === null || current === undefined) record[field as string] = 1
  else if (typeof current === 'number') record[field as string] = current + 1
  else if (typeof current === 'boolean') record[field as string] = !current
  else if (typeof current === 'string') record[field as string] = `${current}#guard`
  else if (Array.isArray(current)) {
    const copy = structuredClone(current) as Array<Record<string, unknown>>
    if (copy.length > 0) copy[0] = { ...copy[0], __classificationGuard__: true }
    else copy.push({ __classificationGuard__: true })
    record[field as string] = copy
  } else record[field as string] = structuredClone(current)
  return record as unknown as T
}

/** Feature rows need one field-specific override on top of the generic
 *  mutator: `transform` is compared component-wise, so a fresh reference
 *  holding equal numbers is legitimately equal — nudge a component instead. */
function featureWithFieldChanged(base: FeatureInstance, field: keyof FeatureInstance): FeatureInstance {
  const b = objectWithFieldChanged(base, field)
  if (field === 'transform') {
    b.transform = { ...b.transform, e: b.transform.e + 1 }
  }
  return b
}

function testFieldClassificationGuards() {
  console.log('Testing cache predicate field-classification guards...')

  for (const field of Object.keys(OPERATION_FIELD_CLASSIFICATION) as Array<keyof Operation>) {
    const classification = OPERATION_FIELD_CLASSIFICATION[field]
    const a = makeGuardOperation()
    const b = objectWithFieldChanged(a, field)
    const equal = operationComputationEquals(a, b)
    if (classification === 'compare') {
      assert(!equal, `Operation.${String(field)} is classified compare but operationComputationEquals ignores it`)
    } else {
      assert(equal, `Operation.${String(field)} is classified ignore but operationComputationEquals reacts to it`)
    }
  }

  for (const field of Object.keys(FEATURE_FIELD_CLASSIFICATION) as Array<keyof FeatureInstance>) {
    const classification = FEATURE_FIELD_CLASSIFICATION[field]
    const base = projectWithFeatures(
      { ...newProject('classification-guard', 'mm'), operations: [makeGuardOperation()] },
      [guardDraft('f1')],
    ).features[0]
    assert(base !== undefined, 'fixture project should contain the drafted feature')
    const b = featureWithFieldChanged(base, field)
    const equal = featureInstanceComputationEquals(base, b)
    if (classification === 'compare') {
      assert(!equal, `FeatureInstance.${String(field)} is classified compare but featureInstanceComputationEquals ignores it`)
    } else {
      assert(equal, `FeatureInstance.${String(field)} is classified ignore but featureInstanceComputationEquals reacts to it`)
    }
  }

  console.log('cache predicate field-classification guards: PASSED')
}

function makeGuardOperation(): Operation {
  return {
    id: 'guard-op',
    name: 'Guard operation',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f1'] },
    toolRef: null,
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 2,
    retractHeight: 3,
  }
}

/** Minimal machinable rect row, shaped like the store drafts them. */
function guardDraft(id: string): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: { profile: rectProfile(0, 0, 20, 10), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

// =====================================================================
// 2. G-code byte-identity through the cache path (#601)
//
// For every committed engine fixture and every enabled operation in it:
// generate fresh, write the production-shaped cache entry, flip a
// display-only flag (the documented empty-diff hit path), serve from the
// entry, and post both through the real postprocessor. The two programs
// must be byte-identical; a real parameter change must MISS.
//
// Mutation-verified during #601: deleting a comparison line from
// `operationComputationEquals` or `featureInstanceComputationEquals`
// makes this suite fail (either the semantic-tweak assertion below or
// the classification guards), and restoring it goes green again.
// =====================================================================

const SWEEP_FIXTURES = [
  '3d-imported-block-test3.camj',
  'issue-401-cone-finish.camj',
  'model-in-pocket.camj',
  'v-carve-noise-test.camj',
] as const

const SWEEP_GENERATORS: Partial<Record<Operation['kind'], (project: Project, operation: Operation) => ToolpathResult>> = {
  rough_surface: generateRoughSurfaceToolpath,
  finish_surface: generateFinishSurfaceToolpath,
  finish_surface_cleanup: generateFinishSurfaceCleanupToolpath,
  v_carve_medial: generateVCarveMedialToolpath,
}

function sweepMachineDefinition(): MachineDefinition {
  return validateMachineDefinition({
    id: 'test',
    name: 'Test',
    description: 'Test controller',
    builtin: false,
    fileExtension: 'nc',
    coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
    numberFormat: {
      decimalPlaces: { mm: 3, inch: 4 },
      trailingZeros: false,
      leadingZero: true,
    },
    units: { mmCommand: 'G21', inchCommand: 'G20' },
    program: {
      header: ['; {programName}'],
      footer: [],
      commentPrefix: ';',
      commentSuffix: '',
      lineNumbers: false,
      lineNumberIncrement: 10,
    },
    workCoordinates: { selectCommand: null },
    motion: {
      rapidCommand: 'G0',
      linearCommand: 'G1',
      cwArcCommand: 'G2',
      ccwArcCommand: 'G3',
      arcFormat: 'ij',
      modalMotion: true,
    },
    feedSpeed: {
      feedCommand: 'F',
      rpmCommand: 'S',
      spindleOnCW: 'M3',
      spindleOnCCW: 'M4',
      spindleOff: 'M5',
      inlineWithMotion: true,
      modalFeedSpeed: true,
    },
    toolChange: {
      commands: ['M0 ; Tool change: {toolName}'],
      stopSpindleFirst: true,
      pauseAfterChange: false,
      pauseCommand: 'M0',
    },
    cannedCycles: null,
    coolant: null,
    stop: { programEndCommand: 'M30' },
  })
}

/** Post a toolpath through the real postprocessor (mirrors camOperationSmoke). */
function sweepPost(project: Project, operation: Operation, toolpath: ToolpathResult): string {
  const toolRecord = project.tools.find((tool) => tool.id === operation.toolRef)
  assert(toolRecord !== undefined, `fixture should contain the operation's tool ${String(operation.toolRef)}`)
  const optimized = optimizeLinearMoves(toolpath)
  const result = runPostProcessor({
    project,
    definition: sweepMachineDefinition(),
    operations: [{
      operation,
      tool: normalizeToolForProject(toolRecord, project),
      toolpath: optimized,
    }],
    options: {
      emitToolChanges: true,
      emitCoolant: false,
      programName: project.meta.name,
    },
  })
  return result.gcode
}

function loadSweepFixture(name: string): Project {
  const raw = readFileSync(new URL('../engine/test-fixtures/' + name, import.meta.url), 'utf8')
  return normalizeProject(JSON.parse(raw))
}

function testFixtureCacheGcodeIdentity() {
  console.log('Testing G-code byte-identity through the cache-hit path across fixtures...')
  let swept = 0

  for (const fixtureName of SWEEP_FIXTURES) {
    const project = loadSweepFixture(fixtureName)

    for (const operation of project.operations) {
      const generate = SWEEP_GENERATORS[operation.kind]
      if (!generate || operation.enabled === false) continue

      // Fresh generation + the production-shaped cache entry.
      const fresh = generate(project, operation)
      assert(fresh !== null && fresh.moves.length > 0, `${fixtureName}:${operation.id} should produce moves`)
      const gFresh = sweepPost(project, operation, fresh)
      const entry = buildToolpathCacheEntry(project, operation, fresh)

      // The production hit path after an unrelated UI toggle: flip a
      // display-only flag on the first feature row. Immutable update keeps
      // every input by reference except that row; the documented contract is
      // an empty diff, a HIT, and served bytes identical to fresh.
      const targetFeature = project.features[0]
      assert(targetFeature !== undefined, `${fixtureName} should contain at least one feature`)
      const reloaded = {
        ...project,
        features: project.features.map((feature) => (
          feature.id === targetFeature.id ? { ...feature, visible: !feature.visible } : feature
        )),
      }
      const servedOperation = reloaded.operations.find((candidate) => candidate.id === operation.id)
      assert(servedOperation !== undefined, `${fixtureName}:${operation.id} missing after display-only edit`)

      assert(isCacheHit(entry, servedOperation, reloaded),
        `${fixtureName}:${operation.id}: a display-only edit must not invalidate the entry`)
      const gServed = sweepPost(reloaded, servedOperation, entry.result)
      assert(gServed === gFresh,
        `${fixtureName}:${operation.id}: G-code served through the cache diverges from fresh generation`)

      // A real parameter change must MISS: serving here would be staleness.
      const tweakedOperation = { ...servedOperation, stepover: (servedOperation.stepover ?? 0.4) + 0.01 }
      const tweakedProject: Project = {
        ...reloaded,
        operations: reloaded.operations.map((candidate) => (candidate.id === operation.id ? tweakedOperation : candidate)),
      }
      assert(!isCacheHit(entry, tweakedOperation, tweakedProject),
        `${fixtureName}:${operation.id}: a changed stepover must invalidate the entry`)

      swept += 1
    }
  }

  assert(swept >= 6, `expected to sweep at least 6 fixture operations, covered ${swept}`)
  console.log(`G-code byte-identity through the cache path: PASSED (${swept} fixture operations)`)
}

try {
  testFieldClassificationGuards()
  testFixtureCacheGcodeIdentity()
  console.log('\nAll toolpathCacheGuards tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
