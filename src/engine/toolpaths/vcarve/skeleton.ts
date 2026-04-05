import type { Point } from '../../../types/project'
import type {
  EdgeEventCandidate,
  PreparedVCarveRegion,
  SkeletonGraph,
  SplitEventCandidate,
  WavefrontRing,
} from './types'
import { add, cross, distance, dot, leftNormal, rayLineIntersection, removeCollinearVertices, rightNormal, scale, sub } from './geometry'
import { buildInitialWavefront, buildWavefrontRing } from './wavefront'

const EVENT_EPSILON = 1e-7
const ITERATION_MULTIPLIER = 24
const MIN_ITERATIONS = 512

interface ActiveVertex {
  id: number
  sourceIndex: number
  point: Point
  prevId: number
  nextId: number
  reflex: boolean
  bisectorDirection: Point
  speedScale: number
}

interface ActiveRing {
  id: number
  hole: boolean
  offset: number
  vertices: ActiveVertex[]
}

interface SolverState {
  offset: number
  nextVertexId: number
  rings: ActiveRing[]
  graph: SkeletonGraph
}

function moveVertex(vertex: ActiveVertex, delta: number): Point {
  return add(vertex.point, scale(vertex.bisectorDirection, vertex.speedScale * delta))
}

function toActiveRing(ring: WavefrontRing, ringId: number): ActiveRing {
  const vertices: ActiveVertex[] = ring.vertices.map((vertex) => ({
    id: vertex.index,
    sourceIndex: vertex.index,
    point: { x: vertex.point.x, y: vertex.point.y },
    prevId: vertex.prevIndex,
    nextId: vertex.nextIndex,
    reflex: vertex.reflex,
    bisectorDirection: vertex.bisectorDirection,
    speedScale: vertex.speedScale,
  }))
  return {
    id: ringId,
    hole: ring.hole,
    offset: 0,
    vertices,
  }
}

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y }
}

function pointKey(point: Point): string {
  const scale = 1 / EVENT_EPSILON
  return `${Math.round(point.x * scale)}:${Math.round(point.y * scale)}`
}

function removeCollinearVerticesPreserving(points: Point[], preserved: Set<string>): Point[] {
  const cleaned = removeCollinearVertices(points)
  if (preserved.size === 0 || cleaned.length === points.length) {
    return cleaned
  }

  const ring = points
  if (ring.length < 3) {
    return ring
  }

  const result: Point[] = []
  for (let index = 0; index < ring.length; index += 1) {
    const prev = ring[(index - 1 + ring.length) % ring.length]
    const current = ring[index]
    const next = ring[(index + 1) % ring.length]
    if (preserved.has(pointKey(current))) {
      result.push(current)
      continue
    }
    const a = sub(current, prev)
    const b = sub(next, current)
    if (Math.abs(cross(a, b)) <= EVENT_EPSILON && dot(a, b) >= 0) {
      continue
    }
    result.push(current)
  }

  return result.length >= 3 ? result : ring
}

function buildInitialState(region: PreparedVCarveRegion): SolverState {
  const rings = buildInitialWavefront(region).map((ring, index) => toActiveRing(ring, index))
  const maxVertexId = rings.reduce((maxId, ring) => {
    const ringMax = ring.vertices.reduce((localMax, vertex) => Math.max(localMax, vertex.id), -1)
    return Math.max(maxId, ringMax)
  }, -1)

  return {
    offset: 0,
    nextVertexId: maxVertexId + 1,
    rings,
    graph: {
      arcs: [],
      nodes: [],
    },
  }
}

function appendNode(graph: SkeletonGraph, point: Point, radius: number): void {
  graph.nodes.push({
    point: clonePoint(point),
    radius,
  })
}

function appendArc(graph: SkeletonGraph, start: Point, end: Point, startRadius: number, endRadius: number): void {
  if (distance(start, end) <= EVENT_EPSILON) {
    appendNode(graph, end, endRadius)
    return
  }
  graph.arcs.push({
    start: clonePoint(start),
    end: clonePoint(end),
    startRadius,
    endRadius,
  })
}

function getVertexMap(ring: ActiveRing): Map<number, ActiveVertex> {
  return new Map(ring.vertices.map((vertex) => [vertex.id, vertex]))
}

function ringVertexOrder(ring: ActiveRing): ActiveVertex[] {
  if (ring.vertices.length === 0) {
    return []
  }
  const map = getVertexMap(ring)
  const start = ring.vertices[0]
  const ordered: ActiveVertex[] = []
  const seen = new Set<number>()
  let current: ActiveVertex | undefined = start
  while (current && !seen.has(current.id)) {
    ordered.push(current)
    seen.add(current.id)
    current = map.get(current.nextId)
  }
  return ordered.length === ring.vertices.length ? ordered : ring.vertices
}

function edgeEventForVertex(ring: ActiveRing, vertex: ActiveVertex): EdgeEventCandidate | null {
  if (!Number.isFinite(vertex.speedScale) || vertex.speedScale <= 0) {
    return null
  }
  const map = getVertexMap(ring)
  const prev = map.get(vertex.prevId)
  const next = map.get(vertex.nextId)
  if (!prev || !next) {
    return null
  }

  const left = rayLineIntersection(vertex.point, vertex.bisectorDirection, prev.point, prev.bisectorDirection)
  const right = rayLineIntersection(vertex.point, vertex.bisectorDirection, next.point, next.bisectorDirection)
  const candidate = [left, right]
    .filter((hit): hit is NonNullable<typeof hit> => hit !== null)
    .filter((hit) => hit.rayT > EVENT_EPSILON)
    .sort((a, b) => a.rayT - b.rayT)[0]
  if (!candidate) {
    return null
  }

  const time = candidate.rayT / vertex.speedScale
  if (!(time > EVENT_EPSILON) || !Number.isFinite(time)) {
    return null
  }

  return {
    vertexIndex: vertex.id,
    time,
    point: candidate.point,
  }
}

function movedEdgeEndpoints(ring: ActiveRing, edgeIndex: number, delta: number): { start: Point; end: Point } | null {
  const ordered = ringVertexOrder(ring)
  const startVertex = ordered[edgeIndex]
  const endVertex = ordered[(edgeIndex + 1) % ordered.length]
  if (!startVertex || !endVertex) {
    return null
  }
  return {
    start: moveVertex(startVertex, delta),
    end: moveVertex(endVertex, delta),
  }
}

function splitEventForVertexAgainstEdge(
  ring: ActiveRing,
  ordered: ActiveVertex[],
  vertexIndex: number,
  edgeIndex: number,
): SplitEventCandidate | null {
  const vertex = ordered[vertexIndex]
  if (!vertex.reflex || !Number.isFinite(vertex.speedScale) || vertex.speedScale <= 0) {
    return null
  }

  const edgeStartVertex = ordered[edgeIndex]
  const edgeEndVertex = ordered[(edgeIndex + 1) % ordered.length]
  if (!edgeStartVertex || !edgeEndVertex) {
    return null
  }

  if (
    edgeStartVertex.id === vertex.id
    || edgeEndVertex.id === vertex.id
    || edgeStartVertex.id === vertex.prevId
    || edgeEndVertex.id === vertex.prevId
    || edgeStartVertex.id === vertex.nextId
    || edgeEndVertex.id === vertex.nextId
  ) {
    return null
  }

  const edgeDirection = sub(edgeEndVertex.point, edgeStartVertex.point)
  const inwardNormal = ring.hole ? rightNormal(edgeDirection) : leftNormal(edgeDirection)
  const movingPointVelocity = scale(vertex.bisectorDirection, vertex.speedScale)
  const denominator = cross(edgeDirection, sub(movingPointVelocity, inwardNormal))
  if (Math.abs(denominator) <= EVENT_EPSILON) {
    return null
  }

  const numerator = -cross(edgeDirection, sub(vertex.point, edgeStartVertex.point))
  const time = numerator / denominator
  if (!(time > EVENT_EPSILON) || !Number.isFinite(time)) {
    return null
  }

  const hitPoint = add(vertex.point, scale(movingPointVelocity, time))
  const movedEdge = movedEdgeEndpoints(ring, edgeIndex, time)
  if (!movedEdge) {
    return null
  }

  const movedDirection = sub(movedEdge.end, movedEdge.start)
  const movedLengthSquared = dot(movedDirection, movedDirection)
  if (movedLengthSquared <= EVENT_EPSILON) {
    return null
  }

  const edgeT = dot(sub(hitPoint, movedEdge.start), movedDirection) / movedLengthSquared
  if (edgeT <= EVENT_EPSILON || edgeT >= 1 - EVENT_EPSILON) {
    return null
  }

  return {
    vertexIndex: vertex.id,
    edgeIndex: edgeStartVertex.id,
    time,
    point: hitPoint,
  }
}

export function enumerateSplitEvents(ring: WavefrontRing): SplitEventCandidate[] {
  const stateRing = toActiveRing(ring, 0)
  return enumerateSplitEventsFromActiveRing(stateRing)
}

function enumerateSplitEventsFromActiveRing(ring: ActiveRing): SplitEventCandidate[] {
  const ordered = ringVertexOrder(ring)
  const candidates: SplitEventCandidate[] = []
  for (let vertexIndex = 0; vertexIndex < ordered.length; vertexIndex += 1) {
    for (let edgeIndex = 0; edgeIndex < ordered.length; edgeIndex += 1) {
      const candidate = splitEventForVertexAgainstEdge(ring, ordered, vertexIndex, edgeIndex)
      if (candidate) {
        candidates.push(candidate)
      }
    }
  }
  return candidates.sort((a, b) => a.time - b.time)
}

export function enumerateEdgeEvents(ring: WavefrontRing): EdgeEventCandidate[] {
  const stateRing = toActiveRing(ring, 0)
  return enumerateEdgeEventsFromActiveRing(stateRing)
}

function enumerateEdgeEventsFromActiveRing(ring: ActiveRing): EdgeEventCandidate[] {
  return ringVertexOrder(ring)
    .map((vertex) => edgeEventForVertex(ring, vertex))
    .filter((candidate): candidate is EdgeEventCandidate => candidate !== null)
    .sort((a, b) => a.time - b.time)
}

function collectNextEventTime(ring: ActiveRing): number | null {
  const edgeTime = enumerateEdgeEventsFromActiveRing(ring)[0]?.time ?? null
  const splitTime = enumerateSplitEventsFromActiveRing(ring)[0]?.time ?? null
  if (edgeTime === null) {
    return splitTime
  }
  if (splitTime === null) {
    return edgeTime
  }
  return Math.min(edgeTime, splitTime)
}

function collectEventClusters(ordered: ActiveVertex[], eventVertexIds: Set<number>): ActiveVertex[][] {
  if (ordered.length === 0 || eventVertexIds.size === 0) {
    return []
  }
  if (eventVertexIds.size === ordered.length) {
    return [ordered.slice()]
  }

  const startIndex = ordered.findIndex((vertex) => !eventVertexIds.has(vertex.id))
  if (startIndex < 0) {
    return [ordered.slice()]
  }

  const clusters: ActiveVertex[][] = []
  let currentCluster: ActiveVertex[] = []
  for (let step = 1; step <= ordered.length; step += 1) {
    const vertex = ordered[(startIndex + step) % ordered.length]
    if (eventVertexIds.has(vertex.id)) {
      currentCluster.push(vertex)
      continue
    }
    if (currentCluster.length > 0) {
      clusters.push(currentCluster)
      currentCluster = []
    }
  }

  return clusters
}

function uniquePoints(points: Point[]): Point[] {
  const deduped = new Map<string, Point>()
  for (const point of points) {
    deduped.set(pointKey(point), point)
  }
  return [...deduped.values()]
}

function closestPoint(target: Point, candidates: Point[]): Point {
  let best = candidates[0]
  let bestDistance = distance(target, best)
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const candidateDistance = distance(target, candidate)
    if (candidateDistance < bestDistance) {
      best = candidate
      bestDistance = candidateDistance
    }
  }
  return best
}

function advanceRing(ring: ActiveRing, delta: number): ActiveRing {
  return {
    id: ring.id,
    hole: ring.hole,
    offset: ring.offset + delta,
    vertices: ringVertexOrder(ring).map((vertex) => ({
      ...vertex,
      point: moveVertex(vertex, delta),
    })),
  }
}

function collapseEdgeCluster(ring: ActiveRing, time: number, graph: SkeletonGraph): ActiveRing | null {
  const ordered = ringVertexOrder(ring)
  const edgeEvents = enumerateEdgeEventsFromActiveRing(ring)
    .filter((event) => Math.abs(event.time - time) <= EVENT_EPSILON)
  if (edgeEvents.length === 0) {
    return null
  }

  const eventVertexIds = new Set(edgeEvents.map((event) => event.vertexIndex))
  const eventClusters = collectEventClusters(ordered, eventVertexIds)
  const advanced = advanceRing(ring, time)
  const advancedMap = getVertexMap(advanced)
  const nextVertices: ActiveVertex[] = []

  for (const vertex of ordered) {
    const moved = advancedMap.get(vertex.id)
    if (!moved) {
      continue
    }
    if (!eventVertexIds.has(vertex.id)) {
      nextVertices.push(moved)
    }
  }

  const allEventVertices = eventVertexIds.size === ordered.length
  for (const cluster of eventClusters) {
    const clusterMoved = cluster
      .map((vertex) => advancedMap.get(vertex.id)?.point ?? null)
      .filter((point): point is Point => point !== null)
    const collapsePoints = uniquePoints(clusterMoved)
    if (collapsePoints.length === 0) {
      continue
    }

    if (allEventVertices && collapsePoints.length > 2 && cluster.every((vertex) => !vertex.reflex)) {
      const centroid = collapsePoints.reduce((sum, point) => add(sum, point), { x: 0, y: 0 })
      const center = scale(centroid, 1 / collapsePoints.length)
      appendNode(graph, center, ring.offset + time)
      continue
    }

    if (collapsePoints.length === 1) {
      const center = collapsePoints[0]
      for (const vertex of cluster) {
        appendArc(graph, vertex.point, center, ring.offset, ring.offset + time)
      }
      appendNode(graph, center, ring.offset + time)
      continue
    }

    for (const vertex of cluster) {
      const moved = advancedMap.get(vertex.id)
      if (!moved) {
        continue
      }
      const target = closestPoint(moved.point, collapsePoints)
      appendArc(graph, vertex.point, target, ring.offset, ring.offset + time)
    }

    if (collapsePoints.length === 2) {
      appendArc(graph, collapsePoints[0], collapsePoints[1], ring.offset + time, ring.offset + time)
    } else {
      collapsePoints.forEach((point) => appendNode(graph, point, ring.offset + time))
    }
  }

  const deduped: ActiveVertex[] = []
  for (const vertex of nextVertices) {
    const last = deduped[deduped.length - 1]
    if (!last || distance(last.point, vertex.point) > EVENT_EPSILON) {
      deduped.push(vertex)
    }
  }
  if (deduped.length > 1 && distance(deduped[0].point, deduped[deduped.length - 1].point) <= EVENT_EPSILON) {
    deduped.pop()
  }

  const collapsePoints = uniquePoints(
    eventClusters.flatMap((cluster) => cluster
      .map((vertex) => advancedMap.get(vertex.id)?.point ?? null)
      .filter((point): point is Point => point !== null)),
  )
  if (deduped.length === 0 && collapsePoints.length === 2 && distance(collapsePoints[0], collapsePoints[1]) > EVENT_EPSILON) {
    appendArc(graph, collapsePoints[0], collapsePoints[1], ring.offset + time, ring.offset + time)
    return null
  }

  if (deduped.length === 2) {
    appendArc(graph, deduped[0].point, deduped[1].point, ring.offset + time, ring.offset + time)
    return null
  }

  if (deduped.length < 3) {
    return null
  }

  return rebuildActiveRingFromMovedVertices(ring.id, ring.hole, ring.offset + time, deduped)
}

function defaultIterationLimit(region: PreparedVCarveRegion): number {
  const totalVertices = region.outer.length + region.holes.reduce((sum, hole) => sum + hole.length, 0)
  return Math.max(MIN_ITERATIONS, totalVertices * ITERATION_MULTIPLIER)
}

export function solveSkeletonGraph(region: PreparedVCarveRegion, maxIterations?: number): SkeletonGraph {
  const state = buildInitialState(region)
  const iterationLimit = Number.isFinite(maxIterations) && (maxIterations ?? 0) > 0
    ? Math.ceil(maxIterations as number)
    : defaultIterationLimit(region)
  let iterations = 0

  while (state.rings.length > 0 && iterations < iterationLimit) {
    iterations += 1
    const nextRings: ActiveRing[] = []

    for (const ring of state.rings) {
      const nextTime = collectNextEventTime(ring)
      if (nextTime === null || !Number.isFinite(nextTime)) {
        continue
      }

      const splitEvents = enumerateSplitEventsFromActiveRing(ring).filter((event) => Math.abs(event.time - nextTime) <= EVENT_EPSILON)
      if (splitEvents.length > 0) {
        const splitRings = splitRingAtEvent(ring, nextTime, splitEvents[0], state.graph)
        nextRings.push(...splitRings)
        continue
      }

      const collapsed = collapseEdgeCluster(ring, nextTime, state.graph)
      if (collapsed) {
        nextRings.push(collapsed)
      }
    }

    state.offset += 1
    state.rings = nextRings
  }

  return state.graph
}

export function solveEdgeSkeletonPreview(region: PreparedVCarveRegion, maxIterations = 64): SkeletonGraph {
  return solveSkeletonGraph(region, maxIterations)
}

function rebuildActiveRingFromPoints(
  ringId: number,
  hole: boolean,
  offset: number,
  points: Point[],
  preservedPointKeys: Set<string> = new Set(),
): ActiveRing | null {
  const cleaned = removeCollinearVerticesPreserving(points, preservedPointKeys)
  if (cleaned.length < 3) {
    return null
  }
  const perimeter = cleaned.reduce((sum, point, index) => sum + distance(point, cleaned[(index + 1) % cleaned.length]), 0)
  if (!(perimeter > EVENT_EPSILON * 100)) {
    return null
  }

  const rebuilt = buildWavefrontRing(cleaned, hole)
  const active = toActiveRing(rebuilt, ringId)
  active.offset = offset
  return active
}

function rebuildActiveRingFromMovedVertices(ringId: number, hole: boolean, offset: number, vertices: ActiveVertex[]): ActiveRing | null {
  const points = vertices.map((vertex) => vertex.point)
  return rebuildActiveRingFromPoints(ringId, hole, offset, points)
}

function splitRingAtEvent(ring: ActiveRing, time: number, event: SplitEventCandidate, graph: SkeletonGraph): ActiveRing[] {
  const advanced = advanceRing(ring, time)
  const ordered = ringVertexOrder(advanced)
  const reflexIndex = ordered.findIndex((vertex) => vertex.id === event.vertexIndex)
  const edgeStartIndex = ordered.findIndex((vertex) => vertex.id === event.edgeIndex)
  if (reflexIndex < 0 || edgeStartIndex < 0 || ordered.length < 4) {
    return []
  }

  const reflexSource = ringVertexOrder(ring).find((vertex) => vertex.id === event.vertexIndex)
  if (reflexSource) {
    appendArc(graph, reflexSource.point, event.point, ring.offset, ring.offset + time)
  } else {
    appendNode(graph, event.point, ring.offset + time)
  }

  const firstLoop: Point[] = [clonePoint(event.point)]
  for (let index = (reflexIndex + 1) % ordered.length; ; index = (index + 1) % ordered.length) {
    firstLoop.push(clonePoint(ordered[index].point))
    if (index === edgeStartIndex) {
      break
    }
  }
  firstLoop.push(clonePoint(event.point))

  const secondLoop: Point[] = [clonePoint(event.point)]
  for (let index = (edgeStartIndex + 1) % ordered.length; index !== reflexIndex; index = (index + 1) % ordered.length) {
    secondLoop.push(clonePoint(ordered[index].point))
  }
  secondLoop.push(clonePoint(event.point))

  const nextRings: ActiveRing[] = []
  const preserved = new Set([pointKey(event.point)])
  const loopA = rebuildActiveRingFromPoints(ring.id * 2 + 1, ring.hole, ring.offset + time, firstLoop, preserved)
  if (loopA) {
    nextRings.push(loopA)
  }
  const loopB = rebuildActiveRingFromPoints(ring.id * 2 + 2, ring.hole, ring.offset + time, secondLoop, preserved)
  if (loopB) {
    nextRings.push(loopB)
  }
  return nextRings
}
