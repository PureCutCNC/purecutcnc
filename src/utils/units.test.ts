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
 *
 * Run with: npx tsx src/utils/units.test.ts
 */

import { newProject } from '../types/project'
import type { DimensionAnnotation, Project } from '../types/project'
import { convertProjectUnits } from './units'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('FAIL: ' + msg)
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps
}

const MM_PER_INCH = 25.4

const freeDim: DimensionAnnotation = {
  id: 'dim0001',
  type: 'aligned',
  a: { kind: 'free', point: { x: 25.4, y: 50.8 } },
  b: { kind: 'free', point: { x: 0, y: 0 } },
  offset: 12.7,
  labelOffset: 5,
  textOverride: null,
  precisionOverride: null,
  visible: true,
  locked: false,
}

const anchoredAngleDim: DimensionAnnotation = {
  id: 'dim0002',
  type: 'angle',
  a: { kind: 'vertex', target: { source: 'feature', featureId: 'f0001' }, vertexIndex: 0 },
  b: { kind: 'vertex', target: { source: 'feature', featureId: 'f0001' }, vertexIndex: 1 },
  c: { kind: 'vertex', target: { source: 'feature', featureId: 'f0001' }, vertexIndex: 2 },
  offset: 25.4,
  textOverride: null,
  precisionOverride: null,
  visible: true,
  locked: false,
}

// ── mm → inch conversion of annotations ─────────────────────
{
  const base: Project = { ...newProject('units-test', 'mm'), annotations: [freeDim, anchoredAngleDim] }
  const inch = convertProjectUnits(base, 'inch')

  const a = inch.annotations[0]
  assert(a.a.kind === 'free' && approx(a.a.point.x, 25.4 / MM_PER_INCH), 'free anchor x converts to inch')
  assert(a.a.kind === 'free' && approx(a.a.point.y, 50.8 / MM_PER_INCH), 'free anchor y converts to inch')
  assert(approx(a.offset, 12.7 / MM_PER_INCH), 'offset converts to inch')
  assert(a.labelOffset !== undefined && approx(a.labelOffset, 5 / MM_PER_INCH), 'labelOffset converts to inch')

  // anchored angle dim: anchors are references (no coords) and stay intact; offset still converts
  const angle = inch.annotations[1]
  assert(angle.a.kind === 'vertex' && angle.a.vertexIndex === 0, 'anchored vertex reference unchanged')
  assert(approx(angle.offset, 25.4 / MM_PER_INCH), 'angle dim offset converts (length)')

  console.log('mm→inch annotation conversion PASS')
}

// ── round-trip mm → inch → mm is identity ───────────────────
{
  const base: Project = { ...newProject('units-test', 'mm'), annotations: [freeDim] }
  const round = convertProjectUnits(convertProjectUnits(base, 'inch'), 'mm')
  const a = round.annotations[0]
  assert(a.a.kind === 'free' && approx(a.a.point.x, 25.4, 1e-7), 'round-trip free x')
  assert(approx(a.offset, 12.7, 1e-7), 'round-trip offset')
  assert(a.labelOffset !== undefined && approx(a.labelOffset, 5, 1e-7), 'round-trip labelOffset')
  console.log('round-trip annotation conversion PASS')
}

console.log('\nall units.test.ts assertions passed')
