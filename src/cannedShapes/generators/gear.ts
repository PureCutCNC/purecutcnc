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
 * Gear as a canned shape (issue #1112 slice E).
 *
 * The gear and its bore are one feature: the generator emits the old
 * `buildGearProfile` outline at the definition origin and, when a bore is set,
 * a concentric circle after it. The canned model assigns the outer outline the
 * feature's operation and the bore the opposite one by nesting depth, which is
 * exactly the decision's rule: an Add gear has a Subtract bore and a Subtract
 * gear has an Add island.
 *
 * The outline is *the same* `buildGearProfile` the one-shot command used, so an
 * operation on a canned gear cuts what it cut before (issue #1112 plan).
 */

import { circleProfile, type CannedShapeParams } from '../../types/project'
import {
  buildGearProfile,
  gearModule,
  normalizeGearCreationParams,
  validateGearProfileParams,
  type GearCreationParams,
  type GearCrestForm,
  type GearRootForm,
  type GearToothFlankProfile,
} from '../../sketch/gearProfile'
import { defineCannedShape, type CannedShapeOutline } from '../types'

/** Registry key stored in `CannedShapeData.kind`. */
export const GEAR_CANNED_KIND = 'gear'

/**
 * Stored parameters. `outsideRadius` is the creation panel's size; the centre
 * is placement and lives in the instance transform, not here.
 */
export type GearCannedParams = CannedShapeParams & GearCreationParams & {
  outsideRadius: number
}

const FLANK_PROFILES: readonly GearToothFlankProfile[] = ['involute', 'straight']
const ROOT_FORMS: readonly GearRootForm[] = ['rounded', 'flat', 'sharp']
const CREST_FORMS: readonly GearCrestForm[] = ['flat', 'rounded']

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isGearCannedParams(raw: CannedShapeParams): raw is GearCannedParams {
  return isFiniteNumber(raw.teeth)
    && isFiniteNumber(raw.wholeDepth)
    && isFiniteNumber(raw.pressureAngleDeg)
    && isFiniteNumber(raw.rootFilletRadius)
    && isFiniteNumber(raw.crestRadius)
    && isFiniteNumber(raw.boreDiameter)
    && isFiniteNumber(raw.outsideRadius)
    && FLANK_PROFILES.includes(raw.flankProfile as GearToothFlankProfile)
    && ROOT_FORMS.includes(raw.rootForm as GearRootForm)
    && CREST_FORMS.includes(raw.crestForm as GearCrestForm)
}

/**
 * Validate and normalize stored parameters. Returns `null` for a parameter set
 * the old gear builder would have refused, so a corrupt file cannot make the
 * shape silently draw something different.
 */
export function normalizeGearCannedParams(raw: CannedShapeParams): GearCannedParams | null {
  if (!isGearCannedParams(raw)) return null
  if (!(raw.outsideRadius > 0)) return null
  const params = normalizeGearCreationParams(raw)
  const errors = validateGearProfileParams({
    ...params,
    center: { x: 0, y: 0 },
    outsideRadius: raw.outsideRadius,
  })
  if (errors.length > 0) return null
  return { ...params, outsideRadius: raw.outsideRadius }
}

function generateGearOutlines(params: GearCannedParams): CannedShapeOutline[] {
  const outlines: CannedShapeOutline[] = [
    {
      profile: buildGearProfile({ ...params, center: { x: 0, y: 0 } }),
      name: 'Gear',
    },
  ]
  if (params.boreDiameter > 0) {
    outlines.push({
      profile: circleProfile(0, 0, params.boreDiameter / 2),
      name: 'Gear Bore',
    })
  }
  return outlines
}

export const gearCannedShape = defineCannedShape<GearCannedParams>({
  kind: GEAR_CANNED_KIND,
  labelKey: 'canned.gear.name',
  generate: (params) => {
    try {
      return generateGearOutlines(params)
    } catch {
      // `normalizeParams` already refuses invalid sets; this keeps a future
      // builder change from turning a corrupt file into a crash on redraw.
      return []
    }
  },
  normalizeParams: normalizeGearCannedParams,
  convertParams: (params, convertLength) => ({
    ...params,
    outsideRadius: convertLength(params.outsideRadius),
    wholeDepth: convertLength(params.wholeDepth),
    rootFilletRadius: convertLength(params.rootFilletRadius),
    crestRadius: convertLength(params.crestRadius),
    boreDiameter: convertLength(params.boreDiameter),
  }),
  summary: (params) => ({
    key: 'canned.gear.summary',
    values: {
      teeth: params.teeth,
      module: Math.round(gearModule(params.outsideRadius, params.teeth) * 1000) / 1000,
    },
  }),
})
