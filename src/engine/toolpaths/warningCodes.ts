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
 * Structured toolpath/postprocessor warnings. The engine emits `{ code,
 * params }` values and stays free of i18n imports; presentation maps codes
 * to localized text via `src/i18n/warningText.ts`, and
 * `src/i18n/locales/<locale>/warnings.ts` carries one message per code (the i18n
 * test suite asserts full coverage of this union). Params are inserted
 * verbatim — user-authored names and numeric values are data, never
 * translated.
 */
export type ToolpathWarningCode =
  // resolver
  | 'targetsMissingOrWrongRole'
  | 'closedProfilesOnly'
  | 'bandEmptySubject'
  | 'bandNoRegions'
  | 'resolverNoBands'
  // shared helpers
  | 'cutDepthExceedsToolMax'
  // developer diagnostics (debugToolpath) — untranslated passthrough
  | 'debug'
  // shared generator preconditions
  | 'noToolAssigned'
  | 'vBitAngleRange'
  | 'maxCarveDepthPositive'
  // v-carve medial
  | 'vcarveMedialWrongKind'
  | 'vcarveMedialNeedsVBit'
  | 'vcarveBandNoDepth'
  | 'vcarveDegenerateRegion'
  | 'vcarveSamplingBudget'
  | 'vcarveNoMedialAxis'
  | 'vcarveMedialNoMoves'
  // v-carve (offset)
  | 'vcarveWrongKind'
  | 'vcarveNeedsVBit'
  | 'contourSpacingPositive'
  | 'vBitInvalidSlope'
  | 'vcarveNoMoves'
  // edge route
  | 'edgeRouteWrongKind'
  | 'edgeRouteNoTargets'
  | 'toolDiameterPositive'
  | 'stepdownPositive'
  | 'edgeRouteNoValidTargets'
  // 3D surface roughing (stepdown)
  | 'targetsNotFound'
  | 'stepoverRatioRange'
  | 'operationStepoverRatioRange'
  | 'surface3dNeedsModel'
  | 'surface3dNotMesh'
  | 'surface3dLoadFailed'
  | 'surface3dStockToLeaveTooLarge'
  | 'surface3dDegenerateBoundary'
  | 'surface3dNoDepthInPocket'
  | 'surface3dNoStepLevels'
  | 'surface3dOpenMesh'
  | 'surface3dFloorCollapsed'
  | 'surface3dNoLevels'
  // finish surface
  | 'finishNeedsModel'
  | 'finishNotMesh'
  | 'finishNoDepthInPocket'
  // tabs
  | 'tabOnlyEdgeRoute'
  | 'tabsOverlapAmbiguous'
  | 'tabNoIntersect'
  | 'tabAboveStockTop'
  | 'tabBelowStockBottom'
  | 'tabInvalidZRange'
  | 'tabOutsideCutZ'
  | 'tabsOutsideCutZ'
  | 'tabsOutsideCutZList'
  | 'tabsOutsideCutZListMore'
  // surface clean / finish bands
  | 'surfaceNoCleanupRegion'
  | 'surfaceNoCleanupSegments'
  | 'surfaceNoOffsetContours'
  | 'surfaceFinishBothDisabled'
  | 'surfaceCleanWrongKind'
  | 'surfaceCleanNoTargets'
  | 'surfaceCleanNoValidTargets'
  | 'surfaceBandNoFinishDepth'
  | 'surfaceBandNoRoughDepth'
  | 'surfaceNoFinishContours'
  // drilling
  | 'drillBottomAboveTop'
  | 'drillNoCenter'
  | 'cutDepthExceedsToolMaxForFeature'
  | 'drillNoTargets'
  | 'drillWrongKind'
  | 'drillNoValidCircles'
  | 'drillPeckDepthPositive'
  | 'drillNotDrillBit'
  | 'drillTargetsNotCircles'
  // carving (follow-line)
  | 'carveDepthClamped'
  | 'carveNotEnoughGeometry'
  | 'carveDepthPositive'
  | 'carveNoTargets'
  | 'carveWrongKind'
  | 'carveNoValidTargets'
  | 'targetsMissing'
  // rest regions
  | 'restOnlyEdgeRoute'
  | 'restOnlyPocket'
  | 'restNoValidOutsideTargets'
  // clamps / regions
  | 'clampCrossedOne'
  | 'clampCrossedMany'
  | 'regionClippedOne'
  | 'regionClippedMany'
  // surface-clean resolver
  | 'surfaceTargetsWrongRole'
  | 'surfaceClosedProfilesOnly'
  | 'surfaceNoBands'
  // region resolver
  | 'resolverOnlyInsideEdge'
  | 'resolverOnlyPocketVcarve'
  | 'resolverNoValidKindTargets'
  | 'resolverNoValidSubtracts'
  | 'resolverNoTargets'
  // edge route (bands)
  | 'edgeMixedDepthSpans'
  | 'edgeNoCombinedContour'
  | 'edgeFeatureNoCutDepth'
  | 'edgeBandNoCutDepth'
  | 'edgeNoContourForFeature'
  | 'edgeNoInsideContour'
  | 'edgeClosedProfilesOnly'
  // finish surface parallel / cleanup / pocket floors
  | 'surfaceHeightMapReduced'
  | 'surfaceSilhouetteDegenerate'
  | 'cleanupStockToLeaveOffsets'
  | 'cleanupNoContours'
  | 'pocketNoFloorRegion'
  | 'pocketNoFloorSegments'
  // clamps travel / postprocessor
  | 'clampTravelLimitExceeded'
  | 'postWcsNullSelect'
  | 'postToolChangesDisabled'
  | 'postNoCoolantCommands'
  | 'postCannedCycleUnsupported'
  // simulation replay / booklet report
  | 'replayNoTool'
  | 'bookletNoTool'
  | 'bookletNoToolpath'
  // store rest-operation creation
  | 'restOperationNotFound'
  | 'restOnlyPocketEdgeTargets'

export interface ToolpathWarning {
  code: ToolpathWarningCode
  params?: Record<string, string | number>
}
