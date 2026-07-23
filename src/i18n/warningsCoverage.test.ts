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

import { warningsEn } from './locales/en/warnings'
import { warningsZhCN } from './locales/zh-CN/warnings'
import { interpolate } from './catalog'
import type { ToolpathWarning, ToolpathWarningCode } from '../engine/toolpaths/warningCodes'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// A value of the union type used purely to force this test to fail to
// compile if the union and this list drift apart: every member listed here
// is checked against the catalog, and the exhaustiveness helper below
// ensures the list IS the union.
const ALL_CODES = [
  'targetsMissingOrWrongRole', 'closedProfilesOnly', 'bandEmptySubject', 'bandNoRegions', 'resolverNoBands',
  'resolverOnlyInsideEdge', 'resolverOnlyPocketVcarve', 'resolverNoValidKindTargets', 'resolverNoValidSubtracts', 'resolverNoTargets',
  'cutDepthExceedsToolMax', 'cutDepthExceedsToolMaxForFeature', 'debug',
  'noToolAssigned', 'vBitAngleRange', 'maxCarveDepthPositive', 'toolDiameterPositive', 'stepdownPositive',
  'targetsNotFound', 'targetsMissing', 'stepoverRatioRange', 'operationStepoverRatioRange',
  'vcarveMedialWrongKind', 'vcarveMedialNeedsVBit', 'vcarveBandNoDepth', 'vcarveDegenerateRegion',
  'vcarveSamplingBudget', 'vcarveNoMedialAxis', 'vcarveMedialNoMoves',
  'vcarveWrongKind', 'vcarveNeedsVBit', 'contourSpacingPositive', 'vBitInvalidSlope', 'vcarveNoMoves',
  'edgeRouteWrongKind', 'edgeRouteNoTargets', 'edgeRouteNoValidTargets',
  'edgeMixedDepthSpans', 'edgeNoCombinedContour', 'edgeFeatureNoCutDepth', 'edgeBandNoCutDepth',
  'edgeNoContourForFeature', 'edgeNoInsideContour', 'edgeClosedProfilesOnly',
  'surface3dNeedsModel', 'surface3dNotMesh', 'surface3dLoadFailed', 'surface3dStockToLeaveTooLarge',
  'surface3dDegenerateBoundary', 'surface3dNoDepthInPocket', 'surface3dNoStepLevels', 'surface3dOpenMesh',
  'surface3dFloorCollapsed', 'surface3dNoLevels',
  'tabOnlyEdgeRoute', 'tabsOverlapAmbiguous', 'tabNoIntersect', 'tabAboveStockTop', 'tabBelowStockBottom',
  'tabInvalidZRange', 'tabOutsideCutZ', 'tabsOutsideCutZ', 'tabsOutsideCutZList', 'tabsOutsideCutZListMore',
  'surfaceNoCleanupRegion', 'surfaceNoCleanupSegments', 'surfaceNoOffsetContours', 'surfaceFinishBothDisabled',
  'surfaceCleanWrongKind', 'surfaceCleanNoTargets', 'surfaceCleanNoValidTargets',
  'surfaceBandNoFinishDepth', 'surfaceBandNoRoughDepth', 'surfaceNoFinishContours',
  'surfaceTargetsWrongRole', 'surfaceClosedProfilesOnly', 'surfaceNoBands',
  'drillBottomAboveTop', 'drillNoCenter', 'drillNoTargets', 'drillWrongKind', 'drillNoValidCircles',
  'drillPeckDepthPositive', 'drillNotDrillBit', 'drillTargetsNotCircles',
  'carveDepthClamped', 'carveNotEnoughGeometry', 'carveDepthPositive', 'carveNoTargets', 'carveWrongKind',
  'carveNoValidTargets',
  'restOnlyEdgeRoute', 'restOnlyPocket', 'restNoValidOutsideTargets',
  'clampCrossedOne', 'clampCrossedMany', 'clampTravelLimitExceeded', 'regionClippedOne', 'regionClippedMany',
  'finishNeedsModel', 'finishNotMesh', 'finishNoDepthInPocket',
  'surfaceHeightMapReduced', 'surfaceSilhouetteDegenerate', 'cleanupStockToLeaveOffsets', 'cleanupNoContours',
  'pocketNoFloorRegion', 'pocketNoFloorSegments',
  'postWcsNullSelect', 'postToolChangesDisabled', 'postNoCoolantCommands', 'postCannedCycleUnsupported',
  'postArcNoCapability',
  'replayNoTool', 'bookletNoTool', 'bookletNoToolpath',
  'restOperationNotFound', 'restOnlyPocketEdgeTargets',
] as const satisfies readonly ToolpathWarningCode[]

// Exhaustiveness both ways: the list is assignable to the union (satisfies
// above) and the union is assignable to the list's member type (below), so
// adding a code without listing it here fails to compile.
type ListedCode = (typeof ALL_CODES)[number]
const exhaustive: readonly ListedCode[] = [] as readonly ToolpathWarningCode[]
void exhaustive

// Every code has an English message and (via the zh module's Record type) a
// Chinese one; assert the runtime maps agree too.
for (const code of ALL_CODES) {
  const key = `warnings.${code}`
  assert(key in warningsEn, `en warnings catalog covers ${key}`)
  assert(key in warningsZhCN, `zh-CN warnings catalog covers ${key}`)
}

// No orphans: every warnings.* key (except the moveKind word table) matches
// a code in the union.
const codeSet = new Set<string>(ALL_CODES)
for (const key of Object.keys(warningsEn)) {
  if (key.startsWith('warnings.moveKind.')) continue
  const code = key.slice('warnings.'.length)
  assert(codeSet.has(code), `catalog key ${key} corresponds to a ToolpathWarningCode`)
}

// The debug passthrough renders its text verbatim in both locales.
const debugWarning: ToolpathWarning = { code: 'debug', params: { text: 'Debug: xyz 42' } }
assert(interpolate(warningsEn['warnings.debug'], debugWarning.params) === 'Debug: xyz 42', 'en debug passthrough')
assert(interpolate(warningsZhCN['warnings.debug'], debugWarning.params) === 'Debug: xyz 42', 'zh debug passthrough')

console.log('warnings coverage tests passed')
