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

export const OPERATION_PARAM_REF_KINDS = [
  'stepdown',
  'stepover',
  'maxDepth',
  'retractHeight',
  'peckDepth',
  'feed',
  'plungeFeed',
  'slotFeed',
  'rpm',
  'dwell',
  'cutDirection',
  'pattern',
  'machiningOrder',
  'rasterAngle',
  'finishWalls',
  'finishFloor',
  'stockRadial',
  'stockAxial',
  'adaptiveSpacing',
  'adaptiveRefinement',
  'maxRings',
  'drillType',
] as const

export type OperationParamRefKind = typeof OPERATION_PARAM_REF_KINDS[number]

const OP_PARAM_REF_LABELS: Record<OperationParamRefKind, string> = {
  stepdown: 'Stepdown reference',
  stepover: 'Stepover reference',
  maxDepth: 'Max depth reference',
  retractHeight: 'Retract height reference',
  peckDepth: 'Peck depth reference',
  feed: 'Feed reference',
  plungeFeed: 'Plunge feed reference',
  slotFeed: 'Slot feed reference',
  rpm: 'RPM reference',
  dwell: 'Dwell reference',
  cutDirection: 'Cut direction reference',
  pattern: 'Pattern reference',
  machiningOrder: 'Machining order reference',
  rasterAngle: 'Raster angle reference',
  finishWalls: 'Finish walls reference',
  finishFloor: 'Finish floor reference',
  stockRadial: 'Stock radial reference',
  stockAxial: 'Stock axial reference',
  adaptiveSpacing: 'Adaptive spacing reference',
  adaptiveRefinement: 'Adaptive refinement reference',
  maxRings: 'Max rings reference',
  drillType: 'Drill type reference',
}

export function operationParamRefLabel(kind: OperationParamRefKind): string {
  return OP_PARAM_REF_LABELS[kind]
}
