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
 * CAM Plan on Around (issue #1112 slice J, decision 3).
 *
 * The planner learns the face the way #1106 taught it Bottom:
 *
 * 1. **Models rough and finish with rotary passes.** Every imported or canned
 *    model (Turn, Polygon) gets one Rotary rough and one Rotary finish, in its
 *    own target, with the finish depending on the rough. Tool choice keeps the
 *    shared rules (preferred type, existing before library, 1/4" ceiling).
 * 2. **Canned Thread/Flutes engrave with a V-bit** at the pattern's own depth,
 *    which comes from the store's existing Follow-line rule, not the 1 mm
 *    default.
 * 3. **Sheet drawings get what they get on Top.** The unrolled sheet is
 *    planned by the same recognition as a block project with the same
 *    geometry.
 * 4. **A square blank keeps its rules.** Models still turn; Thread/Flutes are
 *    not proposed and the coverage row says why.
 * 5. **The plan is transient, then atomic.** Planning does not mutate the
 *    project, and applying the whole plan is one history step.
 *
 * Mutations checked one at a time:
 * - a rotary pass planned with the flat `stock.thickness` reach instead of the
 *   bar's radius → the `requiredCutDepth` assertions fail;
 * - the axis/face setup id not carried onto the drafts → the setupId
 *   assertions and the applied-plan check fail;
 * - Follow line taking the 1 mm default instead of the canned depth → the
 *   `carveDepth` assertion fails;
 * - a flat endmill preferred for the pattern → the V-bit assertion fails;
 * - the square blank still planning sheet/pattern work → the square test's
 *   "no Follow line" and coverage assertions fail;
 * - tabs proposed for an Around edge route → the no-tabs assertion fails;
 * - planning mutating the project, or applying it without one snapshot → the
 *   immutability and history assertions fail.
 */

import assert from 'node:assert/strict'
import {
  circleProfile,
  defaultTool,
  newProject,
  rectProfile,
  roundStock,
  type Project,
  type SketchFeature,
  type Tool,
} from '../../../types/project'
import { projectWithFeatures } from '../../../test/projectFixtures'
import { syncProjectSetups } from '../../../store/helpers/setups'
import { useProjectStore } from '../../../store/projectStore'
import { switchWorkspaceFace } from '../../../store/workspaceFace'
import { activeSetup } from '../../../store/helpers/activeFace'
import { translate } from '../../../i18n/store'
import { rotaryCylinderSegments } from '../../rotaryCylinder'
import { createCamPlan } from './createCamPlan'
import { reconcileCamPlanDownstream } from './reconcileRest'
import { materializeCamPlan } from '../../../store/helpers/camPlanApply'

const store = () => useProjectStore.getState()

function tool(id: string, type: Tool['type'], diameter: number, maxCutDepth = 30): Tool {
  return {
    ...defaultTool('mm', 1),
    id,
    name: id,
    type,
    diameter,
    maxCutDepth,
    vBitAngle: type === 'v_bit' ? 60 : null,
    defaultStepdown: 0.5,
    defaultStepover: 0.4,
  }
}

const BALL = tool('ball-2', 'ball_endmill', 2)
const FLAT = tool('flat-2', 'flat_endmill', 2)
const VBIT = tool('v-bit-3', 'v_bit', 3)
const DRILL = { ...tool('drill-8', 'drill', 8), defaultPlungeFeed: 60 }
const TOOLS = [BALL, FLAT, VBIT, DRILL]

function barProject(tools: Tool[] = TOOLS): Project {
  const base = newProject('Around CAM plan', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(20, 120, 'x')
  base.tools = tools
  return projectWithFeatures(base, [])
}

function loadAround(project: Project): Project {
  store().loadProject(project)
  assert.equal(switchWorkspaceFace('around'), true, 'the fixture enters Around')
  return store().project
}

/** Polygon head + turned shank + one thread, the acceptance bolt made from the drawer actions. */
function bolt(): { project: Project; polygonId: string; turnId: string; threadId: string } {
  loadAround(barProject())
  const polygon = store().addRotarySolid({ kind: 'polygon', start: 10, length: 12, sides: 6, acrossFlats: 15 })
  assert.ok(polygon.ok, `polygon created: ${polygon.ok ? '' : polygon.reason}`)
  const turn = store().addRotarySolid({ kind: 'turn', start: 22, length: 30, diameter: 14 })
  assert.ok(turn.ok, `turn created: ${turn.ok ? '' : turn.reason}`)
  const thread = store().addRotaryPattern({ kind: 'thread', start: 25, length: 20, pitch: 1.5, starts: 1, depth: 0.9 })
  assert.ok(thread.ok, `thread created: ${thread.ok ? '' : thread.reason}`)
  return {
    project: store().project,
    polygonId: polygon.featureId,
    turnId: turn.featureId,
    threadId: thread.featureId,
  }
}

{
  const { project, polygonId, turnId, threadId } = bolt()
  const before = JSON.stringify(project)
  const plan = createCamPlan(project, [])
  assert.equal(JSON.stringify(project), before, 'planning does not mutate the project')
  assert.equal(plan.sourceFingerprint, createCamPlan(project, []).sourceFingerprint, 'the same project fingerprints the same')

  assert.equal(plan.operations.length, 5, `the bolt plans two pairs and one Engrave: ${plan.operations.map((draft) => draft.operation.kind).join(', ')}`)
  assert(plan.operations.every((draft) => draft.hardError === null), JSON.stringify(plan.operations.map((draft) => draft.hardError)))

  const [polygonRough, polygonFinish, turnRough, turnFinish, engrave] = plan.operations
  const apex = activeSetup(project)
  // The hex's flats sit at the apothem (7.5), not at its 8.66 mm corners; the
  // turn's mesh is faceted, so its deepest surface is the chord apothem.
  const polygonReach = 10 - 15 / 2
  const turnReach = 10 - 7 * Math.cos(Math.PI / rotaryCylinderSegments(7, 'mm'))
  for (const [draft, kind, featureId, reach] of [
    [polygonRough, 'rotary_rough', polygonId, polygonReach],
    [polygonFinish, 'rotary_finish', polygonId, polygonReach],
    [turnRough, 'rotary_rough', turnId, turnReach],
    [turnFinish, 'rotary_finish', turnId, turnReach],
  ] as const) {
    assert.equal(draft.operation.kind, kind)
    assert.equal(draft.operation.setupId, apex.id, 'a rotary draft joins the Around setup')
    assert(draft.operation.target.source === 'features' && draft.operation.target.featureIds.length === 1
      && draft.operation.target.featureIds[0] === featureId, 'each model is its own target')
    assert(Math.abs((draft.requiredCutDepth ?? 0) - reach) < 1e-6, `reach is measured from the bar surface: ${draft.requiredCutDepth} vs ${reach}`)
    assert.equal(draft.operation.toolRef, BALL.id, 'the ball endmill is CAM Plan\'s preferred rotary cutter')
  }
  assert.deepEqual(polygonFinish.dependencies, [polygonRough.key], 'the finish depends on its rough')
  assert.deepEqual(turnFinish.dependencies, [turnRough.key], 'the finish depends on its rough')

  assert.equal(engrave.operation.kind, 'follow_line')
  assert.equal(engrave.operation.setupId, apex.id, 'the Engrave joins the Around setup')
  assert(engrave.operation.target.source === 'features' && engrave.operation.target.featureIds.join() === threadId, 'the Engrave targets the thread')
  assert.equal(engrave.operation.toolRef, VBIT.id, 'the pattern engraves with a V-bit')
  assert.equal(engrave.operation.carveDepth, 0.9, 'the depth comes from the canned feature, not the 1 mm default')
  assert.equal(engrave.operation.maxCarveDepth, 0.9, 'and its maximum matches')
  assert.equal(plan.sharedTabs.length, 0, 'Around has no flat-stock tab layout')

  for (const featureId of [polygonId, turnId, threadId]) {
    assert.equal(plan.coverage.find((row) => row.featureId === featureId)?.status, 'planned', `${featureId} is covered`)
  }

  const applied = materializeCamPlan(project, plan)
  assert(applied.ok, `the Around plan applies: ${applied.ok ? '' : applied.message}`)
  if (applied.ok) {
    assert.equal(applied.project.operations.length, 5, 'every proposed operation is created')
    assert(applied.project.operations.every((operation) => operation.setupId === apex.id), 'every created operation joins Around')
    const createdEngrave = applied.project.operations.find((operation) => operation.kind === 'follow_line')
    assert.equal(createdEngrave?.carveDepth, 0.9, 'the applied Engrave keeps the pattern depth')
    assert.equal(createdEngrave?.maxCarveDepth, 0.9, 'and the stored maximum')
    assert.equal(applied.project.tabs.length, 0, 'no flat-stock tabs are created')
  }

  // A correction earlier in the list re-ranks the rest, but the pattern stays on
  // its V-bit: the draft carries its narrower tool family through reconciliation.
  const corrected = {
    ...plan,
    operations: plan.operations.map((draft) => draft.key === polygonRough.key
      ? {
        ...draft,
        operation: { ...draft.operation, toolRef: FLAT.id },
        userOverrides: ['toolRef'] as Array<keyof typeof draft.operation>,
      }
      : draft),
  }
  const reconciled = reconcileCamPlanDownstream(project, corrected as typeof plan, polygonRough.key)
  const reconciledEngrave = reconciled.operations.find((draft) => draft.operation.kind === 'follow_line')
  assert.equal(reconciledEngrave?.operation.toolRef, VBIT.id, 'a downstream re-rank keeps the Engrave on a V-bit')
  assert.deepEqual(reconciledEngrave?.toolOptions, [VBIT.id], 'and offers only V-bits')

  // The store applies the whole plan as one history snapshot.
  store().loadProject(project)
  const historyBefore = store().history.past.length
  const result = store().applyCamPlan(plan)
  assert(result.ok, 'the store applies the Around plan')
  assert.equal(store().history.past.length, historyBefore + 1, 'one undo step creates the whole plan')
  store().undo()
  assert.equal(store().project.operations.length, 0, 'one undo removes it all again')
}

// ── reach is the model surface, not its vertices (issue #1112 J2) ─────
//
// A Ø20 bar with a 15 mm across-flats hex has its corners at 8.66 mm but its
// flats at 7.5 mm. The old vertex measure reported a 1.34 mm reach and accepted
// a 1.5 mm-deep cutter for a cut that is really 2.5 mm deep.

{
  const tiny = tool('ball-1.5', 'ball_endmill', 1.5, 1.5)
  loadAround(barProject([tiny]))
  const polygon = store().addRotarySolid({ kind: 'polygon', start: 10, length: 12, sides: 6, acrossFlats: 15 })
  assert.ok(polygon.ok, `polygon created: ${polygon.ok ? '' : polygon.reason}`)
  const project = store().project
  const plan = createCamPlan(project, [])
  const rotary = plan.operations.filter((draft) => draft.operation.kind === 'rotary_rough' || draft.operation.kind === 'rotary_finish')
  assert.equal(rotary.length, 2, 'the hexagonal head is a rough/finish pair')
  for (const draft of rotary) {
    assert(Math.abs((draft.requiredCutDepth ?? 0) - 2.5) < 1e-6,
      `the reach is the hex apothem, not its corner radius: ${draft.requiredCutDepth}`)
    assert.equal(draft.operation.toolRef, null, 'the 1.5 mm-deep cutter cannot reach the flat')
    assert(Boolean(draft.hardError), 'and the proposal is blocked rather than accepted')
  }
  const applied = materializeCamPlan(project, plan)
  assert.equal(applied.ok, false, 'a plan whose cutter cannot reach the model is not created')
}

// ── one Engrave per pattern depth (issue #1112 J2) ────────────────────
//
// A 0.4 mm thread and a 1.2 mm flute in one Engrave would both cut at the
// store's deepest depth. They are separate operations, each at its own depth.

{
  loadAround(barProject())
  const shallow = store().addRotaryPattern({ kind: 'thread', start: 25, length: 20, pitch: 1.5, starts: 1, depth: 0.4 })
  assert.ok(shallow.ok, 'the first 0.4 mm thread is created')
  const shallowTwin = store().addRotaryPattern({ kind: 'thread', start: 55, length: 20, pitch: 1.5, starts: 1, depth: 0.4 })
  assert.ok(shallowTwin.ok, 'a second 0.4 mm thread is created')
  const deep = store().addRotaryPattern({ kind: 'flutes', start: 25, length: 20, count: 2, twist: 0, depth: 1.2 })
  assert.ok(deep.ok, 'the 1.2 mm flutes are created')
  const project = store().project
  const plan = createCamPlan(project, [])
  const engravings = plan.operations.filter((draft) => draft.operation.kind === 'follow_line')
  assert.equal(engravings.length, 2, `one Engrave per distinct depth: ${engravings.length}`)
  const targetIds = (draft: (typeof engravings)[number]) => draft.operation.target.source === 'features'
    ? draft.operation.target.featureIds
    : []
  const shallowDraft = engravings.find((entry) => targetIds(entry).includes(shallow.featureId))
  const deepDraft = engravings.find((entry) => targetIds(entry).includes(deep.featureId))
  assert(shallowDraft, 'an Engrave targets the shallow threads')
  assert(deepDraft, 'an Engrave targets the deep flutes')
  assert.deepEqual([...targetIds(shallowDraft)].sort(), [shallow.featureId, shallowTwin.featureId].sort(), 'the two 0.4 mm threads share one Engrave')
  assert.equal(shallowDraft.operation.carveDepth, 0.4, 'the shallow group keeps its 0.4 mm depth')
  assert.equal(shallowDraft.operation.maxCarveDepth, 0.4, 'and its maximum')
  assert.equal(deepDraft.operation.carveDepth, 1.2, 'the flutes keep their 1.2 mm depth')
  assert.equal(deepDraft.operation.maxCarveDepth, 1.2, 'and their maximum')
  assert(!targetIds(deepDraft).includes(shallow.featureId), 'no Engrave mixes the two depths')

  const applied = materializeCamPlan(project, plan)
  assert(applied.ok, `the two Engraves apply: ${applied.ok ? '' : applied.message}`)
  if (applied.ok) {
    const created = applied.project.operations.filter((operation) => operation.kind === 'follow_line')
    assert.equal(created.length, 2, 'two Engrave operations are created')
    for (const [featureId, depth, sharedWith] of [
      [shallow.featureId, 0.4, shallowTwin.featureId],
      [deep.featureId, 1.2, null],
    ] as const) {
      const operation = created.find((entry) =>
        entry.target.source === 'features' && entry.target.featureIds.includes(featureId))
      assert.equal(operation?.carveDepth, depth, `${featureId} keeps its own applied depth`)
      if (sharedWith) {
        assert(operation?.target.source === 'features' && operation.target.featureIds.includes(sharedWith),
          'same-depth patterns stay together after applying')
      }
    }
  }
}

// ── a centreline proposal is blocked in Plan, not offered (issue #1112 J2) ──

{
  const deepCut: SketchFeature = {
    id: 'deep-cut',
    name: 'Deep cut',
    kind: 'rect',
    operation: 'subtract',
    folderId: null,
    sketch: {
      profile: rectProfile(10, -5, 30, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    z_top: 20,
    z_bottom: 8,
    visible: true,
    locked: false,
    authoringFace: 'around',
  }
  const project = loadAround(projectWithFeatures(barProject(), [deepCut]))
  const plan = createCamPlan(project, [])
  const drafts = plan.operations.filter((draft) => draft.coveredFeatureIds.includes(deepCut.id))
  assert(drafts.length > 0, 'the deep cut is still shown as a proposal')
  for (const draft of drafts) {
    assert.equal(
      draft.hardError,
      translate('warnings.aroundCentreline', {
        operation: draft.operation.name,
        feature: deepCut.name,
      }),
      'each proposal carries the localized centreline reason',
    )
  }
  const applied = materializeCamPlan(project, plan)
  assert.equal(applied.ok, false, 'a centreline proposal is not created')
}

// ── sheet drawings get what they get on Top ───────────────────────────

{
  const C = Math.PI * 20
  const sheetY = 10 - C / 2
  const draw = (face: 'top' | 'around'): SketchFeature[] => {
    const surface = face === 'around' ? 20 : 10
    const feature = (
      id: string,
      kind: 'rect' | 'circle',
      operation: 'add' | 'subtract',
      profile: SketchFeature['sketch']['profile'],
      bottom: number,
      top = surface,
    ): SketchFeature => ({
      id,
      name: id,
      kind,
      operation,
      folderId: null,
      sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
      z_top: top,
      z_bottom: bottom,
      visible: true,
      locked: false,
      authoringFace: face,
    })
    // Nothing here may reach the centreline: an Around cut that does is
    // refused by generation and is now blocked by the plan (issue #1112 J2).
    // Top's equivalent depths are the unrolled Around ones, so the two plans
    // still describe the same sheet work.
    return [
      feature('ledge', 'rect', 'add', rectProfile(5, 5, 40, 15), surface - 4, surface - 1),
      feature('pocket', 'rect', 'subtract', rectProfile(55, -20, 20, 15), surface - 3),
      feature('hole', 'circle', 'subtract', circleProfile(100, 0, 4), surface - 2),
    ]
  }

  const topBase = newProject('Sheet on Top', 'mm')
  topBase.stock.profile = rectProfile(0, sheetY, 120, C)
  topBase.stock.thickness = 10
  topBase.tools = [FLAT, DRILL]
  const top = projectWithFeatures(topBase, draw('top'))

  const aroundBase = barProject([FLAT, DRILL])
  const aroundSetup = { ...aroundBase.setups[0]!, id: 'around', name: 'Around', kind: 'around' as const, orientation: { axis: 'x' as const, angleDeg: 0 as const } }
  const around = syncProjectSetups({
    ...projectWithFeatures(aroundBase, draw('around')),
    setups: [...aroundBase.setups, aroundSetup],
    activeSetupId: 'around',
  })

  const topPlan = createCamPlan(top, [])
  const aroundPlan = createCamPlan(around, [])
  const signature = (plan: ReturnType<typeof createCamPlan>) => plan.operations.map((draft) =>
    `${draft.operation.kind}:${draft.operation.pass}:${draft.coveredFeatureIds.join('|')}`,
  ).sort()

  assert(aroundPlan.operations.length > 0, 'Around sheet work is planned')
  assert.deepEqual(signature(aroundPlan), signature(topPlan), 'the sheet gets the same operations it gets on Top')
  assert(aroundPlan.operations.every((draft) => draft.operation.setupId === 'around'), 'every sheet operation joins Around')
  assert(aroundPlan.sharedTabs.length === 0, 'no tabs are proposed on the unrolled sheet')

  const applied = materializeCamPlan(around, aroundPlan)
  assert(applied.ok, `the sheet plan applies: ${applied.ok ? '' : applied.message}`)
}

// ── a square blank: models still turn, Thread/Flutes are refused with a reason ──

{
  const { threadId } = bolt()
  store().setStockShape('square')
  const square = store().project
  const plan = createCamPlan(square, [])
  assert(plan.operations.every((draft) => draft.operation.kind !== 'follow_line'), 'a square blank proposes no Follow line')
  assert(plan.operations.some((draft) => draft.operation.kind === 'rotary_rough'), 'models still get a rotary rough')
  assert(plan.operations.some((draft) => draft.operation.kind === 'rotary_finish'), 'models still get a rotary finish')
  const row = plan.coverage.find((entry) => entry.featureId === threadId)
  assert.equal(row?.status, 'unsupported', 'the thread stays visible as needing review')
  assert.equal(row?.detail, translate('cam.plan.aroundNeedsRoundBar'), 'and the reason names the round bar')
  assert(plan.operations.every((draft) => draft.operation.kind.startsWith('rotary_')), 'no sheet operation is proposed on a square blank')
  const applied = materializeCamPlan(square, plan)
  assert(applied.ok, `the square plan still applies: ${applied.ok ? '' : applied.message}`)
}

// ── no V-bit available: the pattern stays a blocking row ──────────────

{
  const loaded = loadAround(barProject([BALL, FLAT]))
  const thread = store().addRotaryPattern({ kind: 'flutes', start: 20, length: 20, count: 2, twist: 0, depth: 0.5 })
  assert.ok(thread.ok, 'flutes created')
  const plan = createCamPlan(store().project, [])
  const draft = plan.operations.find((entry) => entry.operation.kind === 'follow_line')
  assert(draft, 'the pattern is still proposed')
  assert.equal(draft.operation.toolRef, null, 'but it has no tool')
  assert.equal(draft.hardError, translate('cam.plan.vBitRequired'), 'and says a V-bit is required')
  assert.equal(loaded.meta.projectType, 'rotary', 'fixture sanity')
}

console.log('Around CAM Plan tests passed')
