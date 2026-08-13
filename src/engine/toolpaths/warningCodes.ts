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
  // clearing-operation entry strategies
  | 'entryStrategyFallback'

  | 'entryHelixDiameterClamped'
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
  // trochoidal edge route
  | 'edgeTrochoidalWidthTooSmall'
  | 'edgeTrochoidalWidthNarrow'
  | 'edgeTrochoidalWidthLeavesCore'
  | 'edgeTrochoidalAdvanceRange'
  | 'edgeTrochoidalParametersInvalid'
  | 'edgeTrochoidalEntryStrategyUnsupported'
  | 'edgeTrochoidalInvalidGuide'
  | 'edgeTrochoidalMoveBudget'
  | 'edgeTrochoidalEntryBudget'
  | 'edgeTrochoidalTabsRequireHelix'
  | 'edgeTrochoidalTabUnsafe'
  /** A smooth tab was used on a trochoidal Edge Route. Trochoidal roughing owns
   *  its own tab motion in the guide domain — it fragments the guide around each
   *  tab before any orbit exists — so the shared smooth ramp cannot apply. The
   *  conservative rectangular hold is used instead, and this says so: a smooth
   *  selection is never silently ignored. */
  | 'edgeTrochoidalSmoothTabFallback'
  | 'edgeTrochoidalSkippedSpan'
  | 'edgeTrochoidalNoSurvivingSpan'
  | 'edgeTrochoidalSafetyCheck'
  // engrave (follow_line) trochoidal
  | 'carveTrochoidalWidthTooSmall'
  | 'carveTrochoidalWidthNarrow'
  | 'carveTrochoidalWidthLeavesCore'
  | 'carveTrochoidalAdvanceRange'
  | 'carveTrochoidalEntryStrategyUnsupported'
  | 'carveTrochoidalInvalidGuide'
  | 'carveTrochoidalMoveBudget'
  | 'carveTrochoidalEntryBudget'
  /** Fail closed, not warn. A V-bit has no constant cutting diameter, so
   *  R = (W − D) / 2 computed from its nominal diameter produces a groove
   *  that is wrong at every Z. The operation must refuse to generate a
   *  toolpath rather than emit one that is not to size. */
  | 'carveTrochoidalNeedsConstantDiameterTool'
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
  | 'tabsBlockFinalDepth'
  // corner relief (dogbone / T-bone / longest edge)
  /** Adjacent edges are too short to hold the notch this style would cut. */
  | 'cornerReliefCornerTooTight'
  /** The pass's own tool-centre path never turns this corner, so there is no
   *  descend point on it. */
  | 'cornerReliefNoWallPath'
  /** The general guard: the main path never cut at the descend point at or below
   *  the deepest relief level, so descending there would enter uncut material. */
  | 'cornerReliefCornerNotCut'
  /** The descend point or the excursion falls inside a tab footprint. */
  | 'cornerReliefCornerObstructed'
  /** The operation's tool carries no usable stepdown, so a relief pass would be
   *  one full-depth slot per corner. Relief is skipped instead. */
  | 'cornerReliefNoStepdown'
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
  | 'drillHelicalToolUnsupported'
  | 'drillHelicalBoreTooSmall'
  | 'drillHelicalBoreTooLarge'
  | 'drillHelicalBoreUnmachinable'
  | 'drillRetractBelowStockTop'
  // countersinking (issue #489) — every one of these fails closed: the target,
  // or the whole operation, emits no motion rather than an approximate cut.
  | 'drillCountersinkNeedsVBit'
  | 'drillCountersinkDiameterPositive'
  | 'drillCountersinkExceedsToolDiameter'
  | 'drillCountersinkDepthExceedsToolMax'
  | 'drillCountersinkNotLargerThanHole'
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
  | 'postArcNoCapability'
  | 'postArcFallbackLinear'
  // simulation replay / booklet report
  | 'replayNoTool'
  | 'bookletNoTool'
  | 'bookletNoToolpath'
  // store rest-operation creation
  | 'restOperationNotFound'
  | 'restOnlyPocketEdgeTargets'
  | 'restTrochoidalUnsupported'

export interface ToolpathWarning {
  code: ToolpathWarningCode
  params?: Record<string, string | number>
}
