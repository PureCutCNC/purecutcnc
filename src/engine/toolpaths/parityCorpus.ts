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
 * Generation parity corpus (issue #675, slice 1).
 *
 * One list of (project, operation) inputs, shared by two consumers that must
 * never disagree about what they ran:
 *
 * - `scripts/issue-675/capture-baseline.ts` renders the **pre-extraction**
 *   `useToolpathGeneration` hook over this corpus and writes the golden file.
 * - `generateOperationParity.test.ts` runs `computeOperationToolpath` over the
 *   same corpus and asserts it reproduces those goldens byte for byte.
 *
 * The corpus is deliberately node-only test support: it reads `.camj` fixtures
 * from disk and is never imported by application code or re-exported from
 * `index.ts`, so it is not part of the browser bundle.
 *
 * Two properties are load-bearing and must survive any edit here:
 *
 * 1. **Determinism.** Every case must produce identical output on every run,
 *    on any machine. `newProject` stamps `meta.created`/`meta.modified` with
 *    the wall clock, so synthetic cases are date-frozen below. A case that
 *    varies run to run cannot be a parity oracle.
 * 2. **Stability.** Changing a case changes the inputs the goldens describe,
 *    which silently invalidates them. Add cases; do not edit existing ones.
 *    If a case must change, recapture the baseline from a pre-extraction
 *    checkout — never from the extracted implementation.
 */

import { readFileSync, readdirSync } from 'node:fs'
import {
  circleProfile,
  defaultTool,
  newProject,
  rectProfile,
  type Operation,
  type Project,
  type SketchFeature,
  type Tool,
} from '../../types/project'
import { normalizeProject } from '../../store/projectStore'
import { projectWithFeatures } from '../../test/projectFixtures'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition, type MachineDefinition } from '../gcode/types'
import { normalizeToolForProject } from './geometry'
import type { ToolpathResult } from './types'

/** One generation input: a project plus the id of the operation to generate. */
export interface ParityCase {
  /** Stable identity, used as the golden-file key. Never renamed. */
  id: string
  project: Project
  operationId: string
}

const FIXTURE_DIR = new URL('../test-fixtures/', import.meta.url)
const EXAMPLE_DIR = new URL('../../../public/examples/', import.meta.url)

/**
 * A frozen, self-contained machine definition. Deliberately not a builtin from
 * the machine registry: a registry edit would move every G-code hash in the
 * golden file and read as a generation regression.
 */
export function parityMachineDefinition(): MachineDefinition {
  return validateMachineDefinition({
    id: 'parity',
    name: 'Parity',
    description: 'Fixed controller for issue #675 parity capture',
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

/**
 * Post one generated toolpath through the real postprocessor. The toolpath is
 * posted as-is: unlike the smoke suite's helper this does **not** re-run
 * `optimizeLinearMoves`, because the result handed in has already been through
 * the optimizer inside the generation pipeline. Optimizing twice would post a
 * program the app never emits.
 */
export function postParityCase(
  project: Project,
  operation: Operation,
  toolpath: ToolpathResult,
): string {
  const toolRecord = project.tools.find((tool) => tool.id === operation.toolRef)
  if (!toolRecord) {
    throw new Error(`parity corpus: operation ${operation.id} references missing tool ${operation.toolRef}`)
  }
  return runPostProcessor({
    project,
    definition: parityMachineDefinition(),
    operations: [{
      operation,
      tool: normalizeToolForProject(toolRecord, project),
      toolpath,
    }],
    options: {
      emitToolChanges: true,
      emitCoolant: false,
      programName: project.meta.name,
    },
  }).gcode
}

/** Strip the wall-clock stamps `newProject` writes, so synthetic cases are reproducible. */
function frozen(project: Project): Project {
  return {
    ...project,
    meta: {
      ...project.meta,
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
    },
  }
}

function tool(id: string, overrides: Partial<Tool>): Tool {
  return { ...defaultTool('mm', 1), id, ...overrides }
}

function rectFeature(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  zTop: number,
  zBottom: number,
  role: SketchFeature['operation'] = 'subtract',
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: role,
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function circleFeature(
  id: string,
  cx: number,
  cy: number,
  r: number,
  zTop: number,
  zBottom: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: circleProfile(cx, cy, r),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function operation(
  overrides: Partial<Operation> & Pick<Operation, 'kind' | 'target' | 'toolRef'>,
): Operation {
  return {
    id: 'op1',
    name: 'op',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
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
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    ...overrides,
  }
}

function syntheticCase(
  id: string,
  tools: Tool[],
  features: SketchFeature[],
  op: Operation,
  units: 'mm' | 'inch' = 'mm',
): ParityCase {
  const base = projectWithFeatures({ ...frozen(newProject('parity', units)), tools }, features)
  return {
    id,
    project: { ...base, operations: [op] },
    operationId: op.id,
  }
}

/**
 * Real saved projects, every operation in each. These carry the inputs no
 * hand-built fixture reproduces: imported meshes, ordered regions, trochoidal
 * paths, feed-reduction metadata, and the parameter combinations that shipped
 * bugs were found on.
 */
function loadFixture(stem: string): Project {
  return normalizeProject(
    JSON.parse(readFileSync(new URL(`${stem}.camj`, FIXTURE_DIR), 'utf8')) as Project,
  )
}

function fixtureCases(): ParityCase[] {
  const cases: ParityCase[] = []
  const files = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.camj')).sort()
  for (const file of files) {
    const stem = file.replace(/\.camj$/, '')
    const project = loadFixture(stem)
    for (const op of project.operations) {
      cases.push({ id: `fixture/${stem}/${op.id}`, project, operationId: op.id })
    }
  }
  return cases
}

/**
 * The two finish branches each run `applyTabWarnings` then
 * `applyTabsToEdgeRoute`, and no saved fixture carries a tab — so without these
 * variants, deleting either call from either branch changes nothing the corpus
 * can see.
 *
 * What is actually observable here is narrower than it looks, and worth writing
 * down. Measured across tab sizes 4-8 and depths 0.4-0.7 on both fixtures, the
 * finish generators plan their own tab motion — like trochoidal roughing does —
 * so `applyTabsToEdgeRoute` returns their output unchanged in every
 * configuration tried; the move counts are identical with the call and without
 * it. The stage that *does* change the result is `applyTabWarnings`, and only
 * when the tab is large enough to warn. These two cases are therefore sized to
 * produce a `tabOutsideCutZ` warning rather than to be tidy machining setups:
 * a smaller tab is handled entirely inside the generator and pins nothing.
 *
 * The positions are fixed values, not derived at runtime: a tab whose placement
 * is recomputed from the path it is meant to constrain would move whenever the
 * path moves, which is the one thing a baseline must not do.
 */
function tabbedFinishCases(): ParityCase[] {
  const cleanup = loadFixture('model-in-pocket')
  const finish = loadFixture('3d-imported-block-test3')
  return [
    {
      id: 'variant/model-in-pocket-tabbed/op6792442',
      project: {
        ...cleanup,
        tabs: [{ id: 'tab1', name: 'tab1', x: -2, y: -2.5, w: 8, h: 8, z_top: 0.55, z_bottom: 0, visible: true }],
      },
      operationId: 'op6792442',
    },
    {
      // rough_surface is not a tab-supporting kind, but its branch still runs
      // applyTabWarnings — which is how the user is told the tab will not be
      // honoured. That message is behaviour, so it is pinned like any other.
      id: 'variant/3d-imported-block-test3-tabbed/op6792423',
      project: {
        ...finish,
        tabs: [{ id: 'tab1', name: 'tab1', x: -2, y: -2.4, w: 8, h: 8, z_top: 0.7, z_bottom: 0, visible: true }],
      },
      operationId: 'op6792423',
    },
    {
      id: 'variant/3d-imported-block-test3-tabbed/op6792424',
      project: {
        ...finish,
        tabs: [{ id: 'tab1', name: 'tab1', x: -2, y: -2.4, w: 8, h: 8, z_top: 0.55, z_bottom: 0, visible: true }],
      },
      operationId: 'op6792424',
    },
  ]
}

/**
 * The example projects shipped in the app.
 *
 * Added after #739, where a resolver change put extra toolpath on
 * `purecutcnc.camj` and nothing caught it. Both that change's own verification
 * and this corpus drew from `test-fixtures/`, where every fixture happened to
 * short-circuit the new code path — so the files a user is most likely to open
 * were the only ones not regression-tested. These are shipped assets: if their
 * output moves, someone's first experience of the app moves with it.
 */
function exampleCases(): ParityCase[] {
  const cases: ParityCase[] = []
  const files = readdirSync(EXAMPLE_DIR).filter((name) => name.endsWith('.camj')).sort()
  for (const file of files) {
    const project = normalizeProject(
      JSON.parse(readFileSync(new URL(file, EXAMPLE_DIR), 'utf8')) as Project,
    )
    const stem = file.replace(/\.camj$/, '')
    for (const op of project.operations) {
      cases.push({ id: `example/${stem}/${op.id}`, project, operationId: op.id })
    }
  }
  return cases
}

/**
 * Hand-built cases for the operation kinds no `.camj` fixture exercises —
 * `v_carve`, `surface_clean`, `edge_route_inside`, and all five drill types —
 * plus an inch project, a tabbed pocket, and a clamped pocket so the tab and
 * clamp post-processing stages appear in the corpus.
 */
function syntheticCases(): ParityCase[] {
  const endmill = tool('t1', { name: '4 mm endmill', diameter: 4, defaultStepdown: 2 })
  const vbit = tool('tv', { name: 'V-bit 60', type: 'v_bit', diameter: 6, vBitAngle: 60 })
  const drill = tool('td', { name: '3 mm drill', type: 'drill', diameter: 3, defaultStepdown: 5, defaultStepover: 0 })

  const cases: ParityCase[] = [
    syntheticCase('synthetic/v_carve', [vbit], [rectFeature('a', 0, 0, 20, 20, 0, -4)], operation({
      kind: 'v_carve', target: { source: 'features', featureIds: ['a'] }, toolRef: 'tv',
    })),
    syntheticCase('synthetic/surface_clean', [endmill], [rectFeature('a', 0, 0, 30, 30, 18, 0, 'add')], operation({
      kind: 'surface_clean', target: { source: 'features', featureIds: ['a'] }, toolRef: 't1',
    })),
    syntheticCase('synthetic/edge_route_inside', [endmill], [rectFeature('a', 0, 0, 30, 30, 0, -4)], operation({
      kind: 'edge_route_inside', target: { source: 'features', featureIds: ['a'] }, toolRef: 't1',
    })),
    syntheticCase('synthetic/edge_route_outside', [endmill], [rectFeature('a', 0, 0, 30, 30, 0, -4, 'add')], operation({
      kind: 'edge_route_outside', target: { source: 'features', featureIds: ['a'] }, toolRef: 't1',
    })),
    syntheticCase('synthetic/follow_line', [endmill], [circleFeature('c', 20, 20, 8, 0, -3)], operation({
      kind: 'follow_line', target: { source: 'features', featureIds: ['c'] }, toolRef: 't1', carveDepth: 1.5,
    })),
    syntheticCase('synthetic/pocket_inch', [tool('t1', { units: 'inch', diameter: 0.25 })],
      [rectFeature('a', 0, 0, 1, 1, 0, -0.2)], operation({
        kind: 'pocket', target: { source: 'features', featureIds: ['a'] }, toolRef: 't1',
        stepdown: 0.1, feed: 30, plungeFeed: 12,
      }), 'inch'),
  ]

  for (const drillType of ['simple', 'peck', 'dwell', 'chip_breaking', 'helical'] as const) {
    const bit = drillType === 'helical' ? endmill : drill
    cases.push(syntheticCase(`synthetic/drilling_${drillType}`, [bit],
      [circleFeature('c1', 20, 20, 2.5, 0, -6)], operation({
        kind: 'drilling', target: { source: 'features', featureIds: ['c1'] }, toolRef: bit.id,
        stepdown: 2, drillType, peckDepth: 2, dwellTime: drillType === 'dwell' ? 0.5 : undefined,
      })))
  }

  // Tabs and clamps: the two post-processing stages that wrap every generator
  // branch. Without these the corpus would never execute applyTabWarnings,
  // applyEdgeRouteTabs, or applyClampWarnings on a non-empty input.
  const tabbed = syntheticCase('synthetic/edge_route_tabs', [endmill],
    [rectFeature('a', 0, 0, 30, 30, 20, 0, 'add')], operation({
      kind: 'edge_route_outside', target: { source: 'features', featureIds: ['a'] }, toolRef: 't1',
    }))
  cases.push({
    ...tabbed,
    project: {
      ...tabbed.project,
      // Straddles the part's lower edge (the feature spans (0,0)-(30,30)), so
      // the route has to lift over it rather than passing it by. Tab Z is
      // measured from the stock bottom (0) up, not from the stock top.
      tabs: [{ id: 'tab1', name: 'tab1', x: 12, y: -2, w: 6, h: 4, z_top: 3, z_bottom: 0, visible: true }],
    },
  })

  // Trochoidal roughing plans its own tab motion, so `applyEdgeRouteTabs` returns
  // its input by identity while `applyTabsToEdgeRoute` would tab it a second
  // time. That is the *only* input class on which the two differ, so without it
  // swapping one for the other in the dispatch is invisible.
  //
  // The configuration is not arbitrary. The two passes expand the tab footprint
  // by different clearances — tool radius plus radial stock-to-leave in the
  // shared pass, orbit-derived in the generator — so the divergence only appears
  // once `stockToLeaveRadial` pushes the shared pass's expansion past the
  // generator's own clearance. Mirrors the fixture in `tabs.test.ts`
  // ('applyEdgeRouteTabs leaves trochoidal output untouched'), which pins the
  // same distinction at the unit level; a zero stock-to-leave version of this
  // case generates fine and proves nothing.
  const trochTool = tool('t1', { name: 'em6', diameter: 6 })
  const trochBase = projectWithFeatures(
    { ...frozen(newProject('parity', 'mm')), stock: { ...frozen(newProject('parity', 'mm')).stock, thickness: 12 }, tools: [trochTool] },
    [circleFeature('f1', 60, 60, 15, 12, 0)],
  )
  const trochOperation = operation({
    kind: 'edge_route_inside', target: { source: 'features', featureIds: ['f1'] }, toolRef: 't1',
    pass: 'rough', stepdown: 4, carveDepth: 1, maxCarveDepth: 1, roundOutsideCorners: false,
    edgeStrategy: 'trochoidal', trochoidalCutWidth: 9, trochoidalAdvance: 0.1,
    entryStrategy: 'helix', entryRampAngle: 5, stockToLeaveRadial: 0.4,
  })
  cases.push({
    id: 'synthetic/edge_route_trochoidal_tabs',
    project: {
      ...trochBase,
      operations: [trochOperation],
      tabs: [{ id: 'tab1', name: 'Tab tab1', x: 56, y: 41, w: 8, h: 8, z_top: 3, z_bottom: 0, visible: true }],
    },
    operationId: trochOperation.id,
  })

  // Pocket is a tab-supporting kind, and its branch runs applyTabWarnings before
  // the optimizer. Every other pocket in the corpus has no tabs at all, which
  // makes that stage a no-op — so this is the only case that can notice the
  // warning pass moving to the wrong side of the seam.
  const pocketTabbed = syntheticCase('synthetic/pocket_tabs', [endmill],
    [rectFeature('a', 0, 0, 30, 30, 20, 8)], operation({
      kind: 'pocket', target: { source: 'features', featureIds: ['a'] }, toolRef: 't1',
    }))
  cases.push({
    ...pocketTabbed,
    project: {
      ...pocketTabbed.project,
      tabs: [{ id: 'tab1', name: 'tab1', x: 12, y: 12, w: 6, h: 6, z_top: 10, z_bottom: 0, visible: true }],
    },
  })

  // surface_clean is the third tab-supporting kind whose branch runs
  // applyTabWarnings, and the plain surface_clean case above has no tabs.
  const surfaceTabbed = syntheticCase('synthetic/surface_clean_tabs', [endmill],
    [rectFeature('a', 0, 0, 30, 30, 18, 0, 'add')], operation({
      kind: 'surface_clean', target: { source: 'features', featureIds: ['a'] }, toolRef: 't1',
    }))
  cases.push({
    ...surfaceTabbed,
    project: {
      ...surfaceTabbed.project,
      tabs: [{ id: 'tab1', name: 'tab1', x: 12, y: 12, w: 8, h: 8, z_top: 2, z_bottom: 0, visible: true }],
    },
  })

  // A tab the user placed below the cut, which makes applyTabWarnings emit
  // rather than pass through. That is what pins the *position of the raw
  // capture seam*: the final path is the same whichever side of the optimizer
  // the warning pass runs on, but the raw trace only carries the warning when
  // the seam is where it is today (issue #356). Without a warning-producing
  // tab, moving the seam is undetectable.
  const pocketWarnTab = syntheticCase('synthetic/pocket_tabs_outside_cut_z', [endmill],
    [rectFeature('a', 0, 0, 30, 30, 20, 8)], operation({
      kind: 'pocket', target: { source: 'features', featureIds: ['a'] }, toolRef: 't1',
    }))
  cases.push({
    ...pocketWarnTab,
    project: {
      ...pocketWarnTab.project,
      tabs: [{ id: 'tab1', name: 'tab1', x: 12, y: 12, w: 6, h: 6, z_top: 2, z_bottom: 0, visible: true }],
    },
  })

  // Clamp post-processing needs a path that actually *collides*, and since #458
  // the strategies that avoid clamps at generation time no longer produce one —
  // their `clampBlockedCut` warning comes from the generator, so the post-pass
  // contributes nothing and removing it is invisible. A trochoidal edge route
  // whose orbits cross a clamp is the case that still populates
  // `collidingClampIds` and `collidingMoveIndices`.
  cases.push({
    id: 'synthetic/edge_route_clamp_collision',
    project: {
      ...trochBase,
      operations: [trochOperation],
      // The tab is part of the collision configuration, not decoration: it
      // constrains the orbits enough that generation-time avoidance cannot
      // route clear, which is what leaves colliding moves for the post-pass to
      // find. Without it the generator simply avoids the clamp and the case
      // proves nothing.
      tabs: [{ id: 'tab1', name: 'Tab tab1', x: 56, y: 41, w: 8, h: 8, z_top: 3, z_bottom: 0, visible: true }],
      clamps: [{ id: 'clamp1', name: 'clamp1', type: 'step_clamp', x: 53.5, y: 64.5, w: 12, h: 12, height: 30, visible: true }],
    },
    operationId: trochOperation.id,
  })

  const clamped = syntheticCase('synthetic/pocket_clamps', [endmill],
    [rectFeature('a', 0, 0, 30, 30, 0, -4)], operation({
      kind: 'pocket', target: { source: 'features', featureIds: ['a'] }, toolRef: 't1',
    }))
  cases.push({
    ...clamped,
    project: {
      ...clamped.project,
      // Overlaps the pocket's top-right corner, so clamp handling has real
      // geometry to act on instead of trivially passing the path through.
      clamps: [{ id: 'clamp1', name: 'clamp1', type: 'step_clamp', x: 25, y: 25, w: 10, h: 10, height: 10, visible: true }],
    },
  })

  return cases
}

/** The full corpus, in a stable order. */
export function buildParityCorpus(): ParityCase[] {
  return [...fixtureCases(), ...exampleCases(), ...tabbedFinishCases(), ...syntheticCases()]
}
