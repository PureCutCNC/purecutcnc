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
 * The angle kernel: the code a coordinator runs inline, installed with one
 * operation's own geometry (#1115 slice p-d2).
 *
 * There is deliberately no second sampler here. {@link createRotaryAngleKernel}
 * rebuilds the {@link RotarySamplingPrep} the per-angle job reads -- from the
 * payload it was sent instead of from the operation -- and calls
 * {@link runRotaryAngleJob} exactly as the synchronous and in-process serial
 * drivers do. That is the whole parity argument for this slice: the pool changes
 * *where* a job runs, never *what* it computes, so a plan, a triangle traversal,
 * a Float32 write or a warning cannot differ between the two.
 *
 * What a worker owns is its own copy of everything mutable:
 *
 * - the candidate `subset` buffer the job fills for each angle;
 * - the along-mode `turned` vertex buffer;
 * - the fused raster geometry and its cell-range caches (`axisCells`,
 *   `axisBBoxCells`), which the raster kernel rebuilds whenever the cell size or
 *   grid origin changes -- per worker, so two workers never share them;
 * - the height-map scratch the raster allocates per angle.
 *
 * Nothing is shared with the coordinator or with another worker, which is why no
 * `SharedArrayBuffer` and no cross-origin isolation are involved.
 */

import { barCentre, barPivotZ } from '../../types/barStock'
import type { RotaryAngleJob, RotaryAngleSample, RotarySamplingPrep } from './rotarySampling'
import { runRotaryAngleJob } from './rotarySampling'
import type { RotaryAnglePlanPayload, RotaryAngleSetupPayload, RotaryStripPlanValue } from './rotaryAngleProtocol'
import { ROTARY_ANGLE_PROTOCOL_VERSION, describeRotaryAngleSetup } from './rotaryAngleProtocol'

/** One worker's installed operation. */
export interface RotaryAngleKernel {
  /** Sample one batch; results keep their jobs' indices, in the order given. */
  run(jobs: readonly RotaryAngleJob[]): RotaryAngleSample[]
  /** Sample against a newer strip plan (the same reach would never be sent). */
  applyPlan(plan: RotaryAnglePlanPayload): void
  /** Batches served, for a worker's own diagnostics. */
  batches(): number
}

const EMPTY_FLOAT64 = new Float64Array(0)
const EMPTY_FLOAT32 = new Float32Array(0)
const EMPTY_UINT32 = new Uint32Array(0)

/** A plan rebuilt from its payload; the fields the per-angle job never reads stay empty. */
function planFromPayload(plan: RotaryAnglePlanPayload): RotaryStripPlanValue {
  return {
    across: plan.across ?? EMPTY_FLOAT64,
    up: plan.up ?? EMPTY_FLOAT64,
    hull: plan.hull,
    minAlong: plan.minAlong,
    maxAlong: plan.maxAlong,
    bucketBits: plan.bucketBits,
    bucketWords: plan.bucketWords,
    always: plan.always,
    bucketWidth: plan.bucketWidth,
  }
}

/**
 * Install one operation's setup in this realm.
 *
 * Throws on a payload that cannot sample: around mode without raster records,
 * along mode without its mesh and cross-section, or another protocol version. A
 * throw here is a *setup* failure -- the pool's signal to rerun serially -- not a
 * computation error.
 */
export function createRotaryAngleKernel(setup: RotaryAngleSetupPayload): RotaryAngleKernel {
  if (setup.protocolVersion !== ROTARY_ANGLE_PROTOCOL_VERSION) {
    throw new Error(
      `rotary angle kernel: protocol version ${setup.protocolVersion} is not ${ROTARY_ANGLE_PROTOCOL_VERSION}`,
    )
  }
  if (setup.mode === 'around' && setup.raster === undefined) {
    throw new Error(`rotary angle kernel: around mode needs raster records (${describeRotaryAngleSetup(setup)})`)
  }
  if (setup.mode === 'along' && (setup.mesh === undefined
    || setup.plan.across === undefined || setup.plan.up === undefined)) {
    throw new Error(`rotary angle kernel: along mode needs the mesh and its cross-section (${describeRotaryAngleSetup(setup)})`)
  }
  let plan = planFromPayload(setup.plan)
  const positions = setup.mesh?.positions ?? EMPTY_FLOAT32
  const index = setup.mesh?.index ?? EMPTY_UINT32
  const triangleCount = setup.mode === 'around'
    ? Math.floor((setup.raster?.along.length ?? 0) / 3)
    : Math.floor(index.length / 3)
  // `runRotaryAngleJob` reads only these fields of the prep: the mesh, the
  // stock, the tool, the along positions, the centre and pivot, the mode's
  // geometry switch, the retained-wall offset, the raster/scratch workspace and
  // the requested cell size. `planFor` exists to satisfy the interface; the job
  // is always handed the plan the batch named.
  const prep: RotarySamplingPrep = {
    mesh: { positions, index },
    stock: setup.stock,
    tool: setup.tool,
    along: setup.along,
    requestedCellSize: setup.requestedCellSize,
    conservativeCellBounds: setup.mode === 'around',
    // A worker's rows are not cached: the map cache is a main-thread workspace
    // optimisation (#1103 ca-e), and a worker's prep is rebuilt from a payload
    // whose workspace is a copy the parent never sees. So the worker never reads
    // or writes a cache -- and, when the parent asked for maps, it hands each map
    // it builds back instead (#1103 slice ca-i): the pool caches it in the
    // parent workspace, in job order, which is what makes the cache state after a
    // batch the one a serial batch would have left.
    angleMaps: 'off',
    ...(setup.emitAngleMaps === true ? { emitAngleMaps: true } : {}),
    ...(setup.wallTriangleStart !== undefined ? { wallTriangleStart: setup.wallTriangleStart } : {}),
    workspace: {
      subset: new Uint32Array(2 * triangleCount),
      ...(setup.raster !== undefined ? { raster: { section: setup.raster.section, along: setup.raster.along } } : {}),
    },
    centre: barCentre(setup.stock),
    pivot: barPivotZ(setup.stock),
    // Along mode projects its candidates into this buffer; around mode fuses the
    // projection into the raster and needs none.
    turned: setup.mode === 'along' ? new Float32Array(positions.length) : null,
    planFor: () => plan,
  }
  let served = 0
  return {
    run(jobs) {
      const samples: RotaryAngleSample[] = []
      for (const job of jobs) samples.push(runRotaryAngleJob(prep, plan, job))
      served += 1
      return samples
    },
    applyPlan(next) {
      plan = planFromPayload(next)
    },
    batches: () => served,
  }
}
