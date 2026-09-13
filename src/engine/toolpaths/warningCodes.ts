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
  /** Non-target subtract features carved below the deepest target, so the
   *  operation resolved bands past its target's bottom Z (issue #526). Eating
   *  an island or widening the boundary stays quiet — only the depth the user
   *  cannot predict from the target is worth saying. */
  | 'regionExtendedBySubtractDepth'
  /** A chain of touching non-target subtracts ran past the hop limit, so the
   *  region stops short of geometry the model says is void (issue #751 §3).
   *  Measured cost is not the reason for the limit — a 50-link chain resolves
   *  in 11.5 ms — it is a rail against a pocket silently growing across a part.
   *  Said aloud because truncating quietly is the same silent under-fold the
   *  transitive discovery was added to remove. */
  | 'subtractChainLimitReached'
  // shared helpers
  | 'cutDepthExceedsToolMax'
  // clearing-operation entry strategies
  | 'entryStrategyFallback'

  | 'entryHelixDiameterClamped'
  // clearing-operation XY leads (issue #695)
  /** The operation asked for an XY lead its kind/pattern does not carry. */
  | 'xyLeadUnsupported'
  /** A region mask is in force; XY leads are disabled while it is. */
  | 'xyLeadRegionMask'
  /** No candidate lead stayed inside the safe domain within the budget, so the
   *  ordinary direct entry/retract was emitted and the ring order kept. */
  | 'xyLeadNoViablePath'
  /** An edge route asked for a lead it cannot afford: the descent is a single
   *  plunge to depth, so staging it off the wall trades a sliver-engagement
   *  plunge for a full-width one. Lifted once edge routes gain a helix or ramp
   *  entry (#708). */
  | 'xyLeadNeedsRampedEntry'
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
  /** The advance is degenerate for the cutter, not merely fine: the orbit
   *  advances less than 1% of the cutter diameter per loop, so the same arc is
   *  traced over and over. Distinct from the point ceiling on purpose — the
   *  ceiling is about how big a job is, this is about a defective parameter,
   *  and it fires on guides far too short to reach any ceiling (issue #662). */
  | 'edgeTrochoidalAdvanceDegenerate'
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
  // pocket trochoidal clearing
  | 'pocketTrochoidalInvalidGuide'
  | 'pocketTrochoidalMoveBudget'
  | 'pocketTrochoidalEntryBudget'
  | 'pocketTrochoidalWidthTooSmall'
  | 'pocketTrochoidalWidthLeavesCore'
  | 'pocketTrochoidalStepoverHigh'
  | 'pocketTrochoidalCornerReliefUnsupported'
  | 'pocketTrochoidalTightSpot'
  | 'pocketTrochoidalAdvanceDegenerate'
  | 'carveTrochoidalEntryStrategyUnsupported'
  | 'carveTrochoidalInvalidGuide'
  /** As `edgeTrochoidalAdvanceDegenerate`, for trochoidal Engrave. */
  | 'carveTrochoidalAdvanceDegenerate'
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
  /** Fail closed, not warn. Island offsetting is superlinear in the contour
   *  vertex count entering one `ClipperOffset.Execute`, so a mesh dense enough
   *  past this budget spins for minutes and the browser kills the script
   *  (issue #673). A partial 3D rough path is not safe to run, so the operation
   *  refuses instead of emitting what it managed before the level that blew the
   *  budget. */
  | 'surface3dMeshTooDense'
  // finish surface
  | 'finishScallopHeightOutOfRange'
  | 'finishSlopeInvalid'
  | 'finishSlopeEmpty'
  | 'finishSlopeTooComplex'
  | 'finishNeedsModel'
  | 'finishNotMesh'
  | 'finishNoDepthInPocket'
  /** The waterline adaptive refinement asked to cover more ground than its
   *  budget allows, so every band was machined at a proportionally coarser
   *  spacing than the one requested. Warn, not refuse: the program is safe and
   *  complete, it is just not the finish that was asked for, and that has to be
   *  visible without Debug toolpath (issue #698). */
  | 'waterlineRefinementCoarsened'
  /** The catastrophic ring backstop fired — the refinement was cut short rather
   *  than merely coarsened, so part of the surface carries no refinement at all.
   *  Distinct from `waterlineRefinementCoarsened` on purpose: one says the
   *  finish is uniformly coarser, this one says it is uneven (issue #698). */
  | 'waterlineRefinementTruncated'
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
  | 'drillSkippedUnderClamp'
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
  | 'clampBlockedCut'
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
  | 'constantScallopResolutionTooCoarse'
  | 'constantScallopEmpty'
  | 'cleanupStockToLeaveOffsets'
  | 'cleanupNoContours'
  | 'pocketNoFloorRegion'
  | 'pocketNoFloorSegments'
  /** No corner on a Pocket wall ring could be rounded with a contained cleanup,
   * so the ring kept its legacy sharp geometry. Individual corners declining is
   * normal (every reflex corner does) and stays quiet; this fires only when the
   * whole ring came back with nothing cleaned. */
  | 'pocketWallCornerCleanupFallback'
  /** The cutter does not fit between an island and the pocket wall, so the
   * island finish pass was trimmed back to where it does fit. The rounded
   * finish offsets its island rings straight off the island, a construction
   * that cannot see the wall — untrimmed it ran the cutter outside the pocket
   * and gouged it (issue #746). Trimming is silent stock left behind unless it
   * is said out loud, hence the warning rather than a quiet clip. */
  | 'pocketFinishIslandWallTooTight'
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

export type ToolpathWarningSeverity = 'warning' | 'error'

/**
 * Codes that do not merely annotate a program but make it unsafe to save.
 *
 * The default is a warning, and a new code belongs here only when the program
 * is wrong rather than merely imperfect: promoting a code can block an export
 * that works for someone today, so each promotion is its own decision (issue
 * #755).
 *
 * - `postToolChangesDisabled` — the G-code cuts the second operation's paths
 *   with the first operation's tool. Nothing in the program pauses the machine
 *   for a change, so the part is machined with the wrong cutter.
 */
const ERROR_CODES: ReadonlySet<ToolpathWarningCode> = new Set<ToolpathWarningCode>([
  'postToolChangesDisabled',
])

/**
 * How a code should be presented, and whether it blocks an export. One lookup
 * so a code carries the same severity everywhere it is shown.
 */
export function warningSeverity(code: ToolpathWarningCode): ToolpathWarningSeverity {
  return ERROR_CODES.has(code) ? 'error' : 'warning'
}
