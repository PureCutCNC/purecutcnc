/**
 * Unit tests for open-profile joining.
 *
 * Run with: npx tsx src/store/openProfileJoin.test.ts
 */

import { newProject, polygonProfile, profileVertices, type Point, type SketchFeature, type SketchProfile } from '../types/project'
import type { OpenProfileEndpoint } from './types'
import { joinOpenProfiles, useProjectStore } from './projectStore'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function pointsApprox(left: Point, right: Point, epsilon = 1e-9): boolean {
  return Math.abs(left.x - right.x) <= epsilon && Math.abs(left.y - right.y) <= epsilon
}

function openPolyline(points: Point[]): SketchProfile {
  const start = points[0] ?? { x: 0, y: 0 }
  return {
    start,
    segments: points.slice(1).map((point) => ({ type: 'line' as const, to: point })),
    closed: false,
  }
}

function makeFeature(id: string, points: Point[]): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: openPolyline(points),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function endpoint(profile: SketchProfile, which: OpenProfileEndpoint): Point {
  const vertices = profileVertices(profile)
  return which === 'start' ? vertices[0] : vertices[vertices.length - 1]
}

function testJoinOpenProfilesOrientsSelectedEndpointsTogether(): void {
  console.log('Testing open profile join orientation...')
  const upper = openPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }])
  const lower = openPolyline([{ x: 0, y: 10 }, { x: 10, y: 10 }])
  const joined = joinOpenProfiles(upper, 'start', lower, 'start')

  if (!joined) throw new Error('Assertion failed: expected joined open profile')
  assert(!joined.closed, 'one endpoint join should leave the profile open')
  assert(pointsApprox(endpoint(joined, 'start'), { x: 10, y: 0 }), 'joined path should start at unjoined upper endpoint')
  assert(pointsApprox(endpoint(joined, 'end'), { x: 10, y: 10 }), 'joined path should end at unjoined lower endpoint')
  assert(joined.segments.length === 3, `expected two source lines plus one bridge, got ${joined.segments.length}`)
}

function testStoreJoinAbsorbsFeatureThenClosesPath(): void {
  console.log('Testing store open join absorbs and closes...')
  const upper = makeFeature('upper', [{ x: 0, y: 0 }, { x: 10, y: 0 }])
  const lower = makeFeature('lower', [{ x: 0, y: 10 }, { x: 10, y: 10 }])
  const project = {
    ...newProject('open join', 'mm'),
    features: [upper, lower],
    featureTree: [
      { type: 'feature' as const, featureId: upper.id },
      { type: 'feature' as const, featureId: lower.id },
    ],
  }

  const store = useProjectStore.getState()
  store.loadProject(project)
  store.enterSketchEdit(upper.id)

  assert(store.joinOpenFeatureEndpoints(upper.id, 'start', lower.id, 'start'), 'expected first join to succeed')
  let state = useProjectStore.getState()
  assert(state.project.features.length === 1, `expected lower feature to be absorbed, got ${state.project.features.length} features`)
  assert(state.project.features[0].id === upper.id, 'expected upper feature to remain active')
  assert(!state.project.features[0].sketch.profile.closed, 'first join should leave a still-open feature')

  assert(store.joinOpenFeatureEndpoints(upper.id, 'start', upper.id, 'end'), 'expected same-feature endpoint join to close')
  state = useProjectStore.getState()
  const profile = state.project.features[0].sketch.profile
  assert(profile.closed, 'same-feature endpoint join should close the profile')
  assert(pointsApprox(profile.segments[profile.segments.length - 1].to, profile.start), 'closed profile should end at its start point')
}

function testJoinDuringHistoryTransactionCommitsAsOneUndoStep(): void {
  console.log('Testing open join respects active history transaction...')
  const upper = makeFeature('upper', [{ x: 0, y: 0 }, { x: 10, y: 0 }])
  const lower = makeFeature('lower', [{ x: 0, y: 10 }, { x: 10, y: 10 }])
  const project = {
    ...newProject('open join transaction', 'mm'),
    features: [upper, lower],
    featureTree: [
      { type: 'feature' as const, featureId: upper.id },
      { type: 'feature' as const, featureId: lower.id },
    ],
  }

  const store = useProjectStore.getState()
  store.loadProject(project)
  store.enterSketchEdit(upper.id)
  store.beginHistoryTransaction()

  assert(store.joinOpenFeatureEndpoints(upper.id, 'start', lower.id, 'start'), 'expected transaction join to succeed')
  assert(useProjectStore.getState().history.past.length === 0, 'join should not push history while transaction is open')

  store.commitHistoryTransaction()
  assert(useProjectStore.getState().history.past.length === 1, 'transaction should commit one undo step')
}

function testDeleteSegmentOpensClosedProfile(): void {
  console.log('Testing segment delete opens a closed profile...')
  const square = makeFeature('square', [{ x: 0, y: 0 }, { x: 10, y: 0 }])
  square.sketch.profile = polygonProfile([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ])
  const project = {
    ...newProject('delete segment', 'mm'),
    features: [square],
    featureTree: [{ type: 'feature' as const, featureId: square.id }],
  }

  const store = useProjectStore.getState()
  store.loadProject(project)
  store.enterSketchEdit(square.id)
  store.deleteFeatureSegment(square.id, 1)

  const profile = useProjectStore.getState().project.features[0].sketch.profile
  assert(!profile.closed, 'deleted segment should leave profile open')
  assert(pointsApprox(profile.start, { x: 10, y: 10 }), 'open profile should start after deleted segment')
  assert(pointsApprox(profile.segments[profile.segments.length - 1].to, { x: 10, y: 0 }), 'open profile should end before deleted segment')
}

function testDeleteSegmentSplitsOpenProfile(): void {
  console.log('Testing segment delete splits an open profile...')
  const path = makeFeature('path', [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
  ])
  const project = {
    ...newProject('delete open segment', 'mm'),
    features: [path],
    featureTree: [{ type: 'feature' as const, featureId: path.id }],
  }

  const store = useProjectStore.getState()
  store.loadProject(project)
  store.enterSketchEdit(path.id)
  store.deleteFeatureSegment(path.id, 1)

  const features = useProjectStore.getState().project.features
  assert(features.length === 2, `expected split delete to create two features, got ${features.length}`)
  assert(pointsApprox(features[0].sketch.profile.start, { x: 0, y: 0 }), 'first split should keep original start')
  assert(pointsApprox(features[0].sketch.profile.segments[0].to, { x: 10, y: 0 }), 'first split should end before deleted segment')
  assert(pointsApprox(features[1].sketch.profile.start, { x: 20, y: 0 }), 'second split should start after deleted segment')
  assert(pointsApprox(features[1].sketch.profile.segments[0].to, { x: 30, y: 0 }), 'second split should keep trailing segment')
}

function testDisconnectClosedProfileDuplicatesAnchor(): void {
  console.log('Testing disconnect opens a closed profile at an anchor...')
  const square = makeFeature('square', [{ x: 0, y: 0 }, { x: 10, y: 0 }])
  square.sketch.profile = polygonProfile([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ])
  const project = {
    ...newProject('disconnect closed', 'mm'),
    features: [square],
    featureTree: [{ type: 'feature' as const, featureId: square.id }],
  }

  const store = useProjectStore.getState()
  store.loadProject(project)
  store.enterSketchEdit(square.id)
  store.disconnectFeaturePoint(square.id, 1)

  const profile = useProjectStore.getState().project.features[0].sketch.profile
  assert(!profile.closed, 'disconnect should leave profile open')
  assert(pointsApprox(profile.start, { x: 10, y: 0 }), 'disconnect should start at selected anchor')
  assert(pointsApprox(profile.segments[profile.segments.length - 1].to, profile.start), 'disconnect should duplicate selected anchor at path end')
}

function testDisconnectSplitsOpenProfile(): void {
  console.log('Testing disconnect splits an open profile...')
  const path = makeFeature('path', [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  ])
  const project = {
    ...newProject('disconnect open', 'mm'),
    features: [path],
    featureTree: [{ type: 'feature' as const, featureId: path.id }],
  }

  const store = useProjectStore.getState()
  store.loadProject(project)
  store.enterSketchEdit(path.id)
  store.disconnectFeaturePoint(path.id, 1)

  const features = useProjectStore.getState().project.features
  assert(features.length === 2, `expected disconnect to create two features, got ${features.length}`)
  assert(pointsApprox(features[0].sketch.profile.start, { x: 0, y: 0 }), 'first split should keep original start')
  assert(pointsApprox(features[0].sketch.profile.segments[0].to, { x: 10, y: 0 }), 'first split should end at duplicated anchor')
  assert(pointsApprox(features[1].sketch.profile.start, { x: 10, y: 0 }), 'second split should start at duplicated anchor')
  assert(pointsApprox(features[1].sketch.profile.segments[0].to, { x: 20, y: 0 }), 'second split should keep trailing segment')
}

testJoinOpenProfilesOrientsSelectedEndpointsTogether()
testStoreJoinAbsorbsFeatureThenClosesPath()
testJoinDuringHistoryTransactionCommitsAsOneUndoStep()
testDeleteSegmentOpensClosedProfile()
testDeleteSegmentSplitsOpenProfile()
testDisconnectClosedProfileDuplicatesAnchor()
testDisconnectSplitsOpenProfile()

console.log('open profile edit tests passed')
