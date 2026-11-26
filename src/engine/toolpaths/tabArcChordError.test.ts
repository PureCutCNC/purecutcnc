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

// Tabs split edge-route chords into fresh moves. Each flat piece of a
// sampled circle chord must keep that chord's export allowance, or the
// pieces either side of a tab post as G1 (#1253 review).

import assert from 'node:assert/strict'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { projectWithFeatures } from '../../test/projectFixtures'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import type { TabShape } from '../../types/project'
import { computeOperationToolpath } from './generateOperation'

const center = { x: 110, y: 90 }
const radius = 45
const tool = { ...defaultTool('mm', 1), id: 't1', diameter: 6.35 }
const routeRadius = radius + tool.diameter / 2
const base = newProject('Tabs keep chord allowances', 'mm')

for (const shape of ['rect', 'smooth'] as TabShape[]) {
  const project = projectWithFeatures({
    ...base,
    stock: { ...base.stock, thickness: 18, profile: rectProfile(0, 0, 230, 200) },
    tools: [tool],
    origin: { name: 'Origin', x: 0, y: 200, z: 18, visible: true },
    // Straddles the route at the circle's east and north sides.
    tabs: [
      { id: 'east', name: 'East', x: center.x + routeRadius - 6, y: center.y - 4, w: 12, h: 8,
        z_top: 14, z_bottom: 12, visible: true, shape },
      { id: 'north', name: 'North', x: center.x - 4, y: center.y + routeRadius - 6, w: 8, h: 12,
        z_top: 14, z_bottom: 12, visible: true, shape },
    ],
  }, [{
    id: 'target', name: 'Target', folderId: null, kind: 'composite', operation: 'add',
    z_top: 18, z_bottom: 12, locked: false, visible: true,
    sketch: {
      profile: circleProfile(center.x, center.y, radius), origin: { x: 0, y: 0 }, orientationAngle: 0,
      dimensions: [], constraints: [],
    },
  }])
  const operation = {
    ...defaultOperationForTarget(project, 'edge_route_outside', 'finish', { source: 'features', featureIds: ['target'] }, 0),
    entryStrategy: 'plunge' as const,
    arcFittingEnabled: true,
  }
  const envelope = computeOperationToolpath(project, operation)
  assert(envelope)
  // A tab splits a chord at a point inside it, up to one sagitta off the circle.
  const sagitta = routeRadius * (1 - Math.cos(Math.PI / 72))
  const offset = (p: { x: number; y: number }): number => routeRadius - Math.hypot(p.x - center.x, p.y - center.y)
  const onRoute = (p: { x: number; y: number }): boolean => offset(p) > -0.01 && offset(p) < sagitta + 0.01
  const flat = envelope.result.moves.filter(move => move.kind === 'cut'
    && Math.abs(move.from.z - 12) < 1e-9 && Math.abs(move.to.z - 12) < 1e-9
    && onRoute(move.from) && onRoute(move.to))
  const pieces = flat.filter(move => offset(move.from) > 0.005 || offset(move.to) > 0.005)
  assert(pieces.length >= 4, `${shape}: tabs must split chords at the floor (got ${pieces.length})`)
  const missing = flat.filter(move => move.arcChordError === undefined)
  assert.equal(missing.length, 0, `${shape}: ${missing.length} of ${flat.length} floor chords lost their allowance`)
  console.log(`Tab splits keep chord allowances (${shape}): PASSED`)
}
