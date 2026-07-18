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

import type { camEn } from '../../i18n/locales/en/cam'
import { camT } from './camI18n'

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

const OP_PARAM_REF_KEY: Record<OperationParamRefKind, keyof typeof camEn> = {
  stepdown: 'cam.paramRef.stepdown',
  stepover: 'cam.paramRef.stepover',
  maxDepth: 'cam.paramRef.maxDepth',
  retractHeight: 'cam.paramRef.retractHeight',
  peckDepth: 'cam.paramRef.peckDepth',
  feed: 'cam.paramRef.feed',
  plungeFeed: 'cam.paramRef.plungeFeed',
  slotFeed: 'cam.paramRef.slotFeed',
  rpm: 'cam.paramRef.rpm',
  dwell: 'cam.paramRef.dwell',
  cutDirection: 'cam.paramRef.cutDirection',
  pattern: 'cam.paramRef.pattern',
  machiningOrder: 'cam.paramRef.machiningOrder',
  rasterAngle: 'cam.paramRef.rasterAngle',
  finishWalls: 'cam.paramRef.finishWalls',
  finishFloor: 'cam.paramRef.finishFloor',
  stockRadial: 'cam.paramRef.stockRadial',
  stockAxial: 'cam.paramRef.stockAxial',
  adaptiveSpacing: 'cam.paramRef.adaptiveSpacing',
  adaptiveRefinement: 'cam.paramRef.adaptiveRefinement',
  maxRings: 'cam.paramRef.maxRings',
  drillType: 'cam.paramRef.drillType',
}

export function operationParamRefLabel(kind: OperationParamRefKind): string {
  return camT(OP_PARAM_REF_KEY[kind])
}
