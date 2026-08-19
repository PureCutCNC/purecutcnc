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
 * Tests for the declared CAM operation field order and grouping (issue #559).
 *
 * The registry's whole value is that it is the *only* place a field's position
 * is decided, so these tests assert the structural properties that claim
 * depends on: one row per field id, every row in a declared group, no field
 * that can never be reached, and no operation kind that renders an empty panel.
 *
 * Run with: npx tsx src/components/cam/operationFields.test.ts
 */

import {
  OPERATION_FIELDS,
  OPERATION_FIELD_GROUPS,
  OPERATION_FIELD_GROUP_IDS,
  OPERATION_FIELD_IDS,
  operationFieldsForGroup,
  resolvedEntryStrategy,
  type OperationFieldId,
} from './operationFields'
import {
  type DrillType,
  type EntryStrategy,
  type Operation,
  type OperationKind,
  type OperationPass,
  type PocketPattern,
} from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const ALL_KINDS: OperationKind[] = [
  'pocket',
  'v_carve',
  'v_carve_medial',
  'edge_route_inside',
  'edge_route_outside',
  'surface_clean',
  'rough_surface',
  'finish_surface',
  'finish_surface_cleanup',
  'follow_line',
  'drilling',
]

const ALL_PASSES: OperationPass[] = ['rough', 'finish']
const ALL_PATTERNS: PocketPattern[] = ['offset', 'parallel', 'waterline']
const ALL_DRILL_TYPES: DrillType[] = ['simple', 'peck', 'dwell', 'chip_breaking', 'helical', 'countersink']
const ALL_ENTRY_STRATEGIES: EntryStrategy[] = ['plunge', 'helix', 'ramp']

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op',
    name: 'op',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f1'] },
    toolRef: null,
    stepdown: 1,
    stepover: 0.5,
    feed: 100,
    plungeFeed: 50,
    rpm: 10000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 1,
    maxCarveDepth: 3,
    ...overrides,
  }
}

/**
 * Every operation shape the panel can be shown for. Small enough to enumerate
 * exhaustively, which is the point: a coverage claim over a sampled space would
 * not prove that a field is reachable.
 */
function everyOperationShape(): Operation[] {
  const shapes: Operation[] = []
  for (const kind of ALL_KINDS) {
    for (const pass of ALL_PASSES) {
      for (const pocketPattern of ALL_PATTERNS) {
        for (const drillType of ALL_DRILL_TYPES) {
          for (const entryStrategy of ALL_ENTRY_STRATEGIES) {
            for (const edgeStrategy of ['contour', 'trochoidal'] as const) {
              for (const carveStrategy of ['direct', 'trochoidal'] as const) {
                for (const flags of [false, true]) {
                  shapes.push(makeOperation({
                    kind,
                    pass,
                    pocketPattern,
                    drillType,
                    entryStrategy,
                    edgeStrategy,
                    carveStrategy,
                    finishFloor: flags,
                    roundOutsideCorners: flags,
                    waterlineAdaptiveRefinement: flags,
                  }))
                }
              }
            }
          }
        }
      }
    }
  }
  return shapes
}

function testEveryDeclaredIdHasExactlyOneRow() {
  const seen = new Map<OperationFieldId, number>()
  for (const field of OPERATION_FIELDS) {
    seen.set(field.id, (seen.get(field.id) ?? 0) + 1)
  }
  for (const id of OPERATION_FIELD_IDS) {
    assert(seen.get(id) === 1, `field '${id}' must appear exactly once, saw ${seen.get(id) ?? 0}`)
  }
  assert(
    seen.size === OPERATION_FIELD_IDS.length,
    `registry has ${seen.size} distinct ids but ${OPERATION_FIELD_IDS.length} are declared`,
  )
  assert(
    OPERATION_FIELDS.length === OPERATION_FIELD_IDS.length,
    'no field may be rendered from more than one row',
  )
}

function testEveryFieldNamesADeclaredGroup() {
  const groupIds = new Set<string>(OPERATION_FIELD_GROUP_IDS)
  for (const field of OPERATION_FIELDS) {
    assert(groupIds.has(field.group), `field '${field.id}' names unknown group '${field.group}'`)
  }
  const specIds = OPERATION_FIELD_GROUPS.map((group) => group.id)
  assert(
    specIds.length === new Set(specIds).size,
    'each group renders once, so the group order may not repeat an id',
  )
  for (const id of OPERATION_FIELD_GROUP_IDS) {
    assert(specIds.includes(id), `group '${id}' is declared but never rendered`)
  }
}

function testEveryFieldIsReachable() {
  const shapes = everyOperationShape()
  for (const field of OPERATION_FIELDS) {
    assert(
      shapes.some((operation) => field.appliesTo(operation)),
      `field '${field.id}' applies to no operation shape — it can never render`,
    )
  }
}

function testEveryKindRendersAtLeastOneGroup() {
  for (const kind of ALL_KINDS) {
    const operation = makeOperation({ kind })
    const nonEmpty = OPERATION_FIELD_GROUPS.filter(
      (group) => operationFieldsForGroup(group.id, operation).length > 0,
    )
    assert(nonEmpty.length > 0, `operation kind '${kind}' renders no group at all`)
  }
}

/**
 * Golden render order for two representative kinds. This is the regression net
 * the registry exists to make possible: reordering the table, retagging a field
 * into another group, or dropping a row all show up here as a diff, instead of
 * silently moving a control in the panel.
 */
function testGoldenRenderOrder() {
  const visibleFor = (operation: Operation) => OPERATION_FIELD_GROUPS
    .flatMap((group) => operationFieldsForGroup(group.id, operation))
    .map((field) => field.id)

  const roughPocket = visibleFor(makeOperation({ kind: 'pocket', pass: 'rough', pocketPattern: 'offset' }))
  assert(
    roughPocket.join(',') === [
      'name', 'description', 'kind', 'pass', 'enabled',
      'target', 'targetSource', 'restMachining',
      'tool',
      'stepdown', 'stockToLeaveRadial', 'stockToLeaveAxial',
      'feed', 'plungeFeed', 'slotFeed', 'engagementMode', 'rpm',
      'pattern', 'cutDirection', 'machiningOrder', 'stepover',
      'entryStrategy',
      'roundOutsideCorners', 'roundLinkCorners', 'cornerRelief',
      'arcFitting',
    ].join(','),
    `rough pocket render order changed: ${roughPocket.join(',')}`,
  )

  const drilling = visibleFor(makeOperation({ kind: 'drilling', drillType: 'simple' }))
  assert(
    drilling.join(',') === [
      'name', 'description', 'kind', 'enabled',
      'target', 'targetSource',
      'tool',
      'feed', 'plungeFeed', 'rpm',
      'retractHeight',
      'drillType',
      'arcFitting',
    ].join(','),
    `drilling render order changed: ${drilling.join(',')}`,
  )
}

/**
 * The inversion the regrouping exists to fix: the parameters changed on every
 * material change were buried in "Advanced", while a G-code output detail set
 * once per machine sat always-visible above them.
 */
function testSpeedsAndFeedsSitAboveTheFold() {
  const groupOf = (id: OperationFieldId) => {
    const field = OPERATION_FIELDS.find((candidate) => candidate.id === id)
    assert(field, `'${id}' must be declared`)
    return OPERATION_FIELD_GROUPS.find((group) => group.id === field.group)
  }

  for (const id of ['feed', 'plungeFeed', 'slotFeed', 'rpm'] as const) {
    const group = groupOf(id)
    assert(group?.defaultOpen === true, `'${id}' must be visible without opening a section`)
  }
  assert(groupOf('arcFitting')?.defaultOpen === false, 'arc fitting is set once per machine, not per job')
}

function testGroupsWithNothingToShowDoNotRender() {
  const rendered = (operation: Operation) => OPERATION_FIELD_GROUPS
    .filter((group) => operationFieldsForGroup(group.id, operation).length > 0)
    .map((group) => group.id)

  const pocket = rendered(makeOperation({ kind: 'pocket' }))
  assert(!pocket.includes('drilling'), 'a pocket must not render an empty Drilling group')

  const drilling = rendered(makeOperation({ kind: 'drilling' }))
  assert(!drilling.includes('corners'), 'drilling has no corners to relieve')
  assert(!drilling.includes('strategy'), 'drilling has no 2D covering strategy')
  assert(!drilling.includes('depth'), 'drilling depth comes from the target circles, not this group')
  assert(drilling.includes('drilling'), 'a drilling operation renders its own group')
}

function testTrochoidalPredicatesMatchTheEnginesOwn() {
  // A trochoidal path has no ramp; a stale 'ramp' must read back as a helix so
  // the panel never offers a mode the generator does not implement.
  const trochoidalEdge = makeOperation({
    kind: 'edge_route_outside',
    pass: 'rough',
    edgeStrategy: 'trochoidal',
    entryStrategy: 'ramp',
  })
  assert(resolvedEntryStrategy(trochoidalEdge) === 'helix', 'trochoidal ramp must resolve to helix')

  const contourPocket = makeOperation({ kind: 'pocket', entryStrategy: 'ramp' })
  assert(resolvedEntryStrategy(contourPocket) === 'ramp', 'a contour pocket keeps its ramp')

  const untouched = makeOperation({ kind: 'pocket' })
  assert(resolvedEntryStrategy(untouched) === 'plunge', 'an unset entry strategy is a plunge')
}

function testRampAngleRendersFromExactlyOnePlace() {
  // It serves both a ramping/helical entry and helical drilling. Those must be
  // disjoint, or the single row would have two positions again.
  const rampAngle = OPERATION_FIELDS.find((field) => field.id === 'entryRampAngle')
  assert(rampAngle, 'entryRampAngle must be declared')

  const helicalDrill = makeOperation({ kind: 'drilling', drillType: 'helical' })
  assert(rampAngle.appliesTo(helicalDrill), 'helical drilling shows the ramp angle')

  const simpleDrill = makeOperation({ kind: 'drilling', drillType: 'simple' })
  assert(!rampAngle.appliesTo(simpleDrill), 'simple drilling has no ramp angle')

  const helixPocket = makeOperation({ kind: 'pocket', entryStrategy: 'helix' })
  assert(rampAngle.appliesTo(helixPocket), 'a helical pocket entry shows the ramp angle')

  const plungePocket = makeOperation({ kind: 'pocket', entryStrategy: 'plunge' })
  assert(!rampAngle.appliesTo(plungePocket), 'a plunging pocket has no ramp angle')

  // Helix diameter deliberately stays off helical drilling (issue #412).
  const helixDiameter = OPERATION_FIELDS.find((field) => field.id === 'entryHelixDiameter')
  assert(helixDiameter, 'entryHelixDiameter must be declared')
  assert(!helixDiameter.appliesTo(helicalDrill), 'helical drilling bores to the circle, not a percentage')
}

function testStockToLeaveFollowsTheSurfacePattern() {
  const radial = OPERATION_FIELDS.find((field) => field.id === 'stockToLeaveRadial')
  const axial = OPERATION_FIELDS.find((field) => field.id === 'stockToLeaveAxial')
  assert(radial && axial, 'both stock-to-leave fields must be declared')

  const waterline = makeOperation({ kind: 'finish_surface', pocketPattern: 'waterline' })
  assert(radial.appliesTo(waterline), 'waterline rings are walls, so radial stock applies')

  const parallelFinish = makeOperation({ kind: 'finish_surface', pocketPattern: 'parallel' })
  assert(!radial.appliesTo(parallelFinish), 'a parallel surface finish has only a floor')
  assert(axial.appliesTo(parallelFinish), 'axial stock applies to every surface finish')

  for (const kind of ['follow_line', 'v_carve', 'v_carve_medial', 'drilling'] as const) {
    const operation = makeOperation({ kind })
    assert(!radial.appliesTo(operation), `'${kind}' leaves no radial stock`)
    assert(!axial.appliesTo(operation), `'${kind}' leaves no axial stock`)
  }
}

function testDrillingHidesTheTwoDimensionalStrategyFields() {
  const drilling = makeOperation({ kind: 'drilling' })
  for (const id of ['stepdown', 'stepover', 'cutDirection', 'machiningOrder', 'pattern'] as const) {
    const field = OPERATION_FIELDS.find((candidate) => candidate.id === id)
    assert(field, `'${id}' must be declared`)
    assert(!field.appliesTo(drilling), `drilling must not offer '${id}'`)
  }
}

testEveryDeclaredIdHasExactlyOneRow()
testEveryFieldNamesADeclaredGroup()
testEveryFieldIsReachable()
testEveryKindRendersAtLeastOneGroup()
testGoldenRenderOrder()
testSpeedsAndFeedsSitAboveTheFold()
testGroupsWithNothingToShowDoNotRender()
testTrochoidalPredicatesMatchTheEnginesOwn()
testRampAngleRendersFromExactlyOnePlace()
testStockToLeaveFollowsTheSurfacePattern()
testDrillingHidesTheTwoDimensionalStrategyFields()

console.log('operationFields tests passed')
