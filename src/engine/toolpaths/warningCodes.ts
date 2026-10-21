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
  | 'plasmaTopOnly'
  | 'plasmaHoleBeforePart'
  | 'plasmaPartialDepth'
  | 'plasmaStraightLead'
  | 'plasmaInvalid'
  | 'plasmaOpenPath'
  | 'plasmaNoLead'
  | 'plasmaSmallHole'
  | 'plasmaCentrePierce'
  | 'plasmaLeadOutOmitted'
  /** This operation cuts an outline while a later plasma operation of the
   *  same setup cuts a contour inside it (issue #958). Inside one operation
   *  the cut order puts inside contours first; across operations the user's
   *  operation order decides, and an outline cut first leaves a loose part
   *  whose holes can no longer be cut in place. A warning, not an export
   *  block: the program is the one the operation list asks for. */
  | 'plasmaOutlineBeforeHole'
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
  | 'edgeNoCombinedContour'
  | 'edgeFeatureNoCutDepth'
  | 'edgeBandNoCutDepth'
  | 'edgeNoContourForFeature'
  | 'edgeRouteBlockedByParts'
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
  // machining setups (issue #946)
  /** A target was drawn on the other face and does not go through the stock,
   *  so the operation's setup cannot reach it. Nothing is generated: motion
   *  for the wrong side is worse than no motion. */
  | 'setupTargetNotThrough'
  /** A Bottom setup of a rotary bar project flips the part about the other
   *  horizontal axis than the bar lies along, so its A180 instruction (which
   *  turns the bar about its own axis) does not describe the turn its
   *  transform applies. The stored setup is left as the user made it and the
   *  export names it; the fix is the setup's flip axis (#1054 slice 2). A
   *  warning, not an error: the program is still the user's to run. */
  | 'setupFlipAxisMismatch'
  /** Around needs a bar — round or square — lying along the setup's axis for
   *  the operation to cut. A warning, as it always was: the operation produces
   *  no motion, but the code's severity is part of the frozen round/flat
   *  contract. The **square** blank's own new refusals (#1016 C2-S4: a wrapped
   *  2D operation, a non-model target, or a physical workholding/clamp setup
   *  the guard refuses) report `postSetupOperationRefused` instead, so only
   *  they block a save. */
  | 'aroundStockMismatch'
  /** A radial cut must stop above the bar centreline. */
  | 'aroundCentreline'
  /** The operation's generated cut reaches the bar's centreline although its
   *  stored target stops short: a depth the operation works out itself, such
   *  as an Engrave's carve depth or a countersink's derived plunge. No motion
   *  is generated (issue #395). */
  | 'aroundCutReachesCentreline'
  /** Rotary finishing needs a cutter whose contact the sampler models: a ball
   *  nose or a flat end mill. A V-bit's height depends on its own profile and a
   *  drill has no boundary cut, so the sampler's value is not a safe tip
   *  height for either. The operation emits no motion rather than an
   *  approximate pass (issue #1015). */
  | 'rotaryToolUnsupported'
  /** The model reaches below the bar's centreline where the pass samples. A
   *  tool tip cannot go below the axis without the bar's far side coming back
   *  up into it, so a clamped point leaves that place uncut; the first such
   *  place is named (issue #1015). */
  | 'rotaryBelowCentreline'
  /** End supports and workholding leave no model extent to machine. */
  | 'rotaryNoRoom'
  /** Part of the target mesh lies outside the bar — farther from its axis than
   *  the bar's radius, or past one of its ends. The sampler only sees the bar's
   *  own surface there, so those parts are machined as air; the operation still
   *  runs and says so (issue #1015). */
  | 'rotaryModelOutsideBar'
  /** The operation's radial stock to leave is not a usable allowance: it is
   *  not finite, it is negative, or it makes the sampler's tool radius zero or
   *  negative. Sampling with that radius would read "no model" everywhere, and
   *  the rough would cut the whole pass down to the axis, so it refuses with
   *  no motion instead (issue #1016 C2 correction M1). */
  | 'rotaryStockToLeaveInvalid'
  /** A program was asked to hold operations of more than one setup. The
   *  operator turns the part by hand between setups, so one program must
   *  never run across the turn. */
  | 'postMixedSetups'
  /** A **square** blank's Around face was asked for a job it does not
   *  support (#1016 C2-S4): a non-rotary kind, a target that is not a real
   *  model, or a physical workholding / ordinary-clamp setup this build cannot
   *  hold. The file would be missing a pass.
   *
   * The physical workholding verdicts have their own codes below, so the
   * operation names the actual problem; this one stays the fallback for the
   * remaining square reasons (an unreadable blank, non-finite project
   * clearances, a malformed clamp row, a stale cutter) and for
   * `setupTargetNotThrough`. */
  | 'postSetupOperationRefused'
  /** A square blank's chuck or tailstock outer diameter is smaller than the
   *  blank's corner envelope, so its corners would pass through the jaws as
   *  the blank turns (#1016 C2 F3). Params: operation, clamp, diameter and the
   *  required corner diameter, both formatted in project units. */
  | 'workholdingDiameter'
  /** A square blank's chuck or tailstock is off the true centreline or its
   *  height is not derived from the pivot (#1016 C2 F3). Params: operation,
   *  clamp. */
  | 'workholdingPlacement'
  /** An ordinary clamp reaches into the region the square blank sweeps as it
   *  turns, grown by the cutter body and the project's clamp clearance
   *  (#1016 C2 F3). Params: operation, clamp. */
  | 'ordinaryClampOverlap'
  /** The program is for a second setup that declares no registration
   *  reference: nothing records how the turned part is located. */
  | 'postSetupNoRegistration'
  /** The project's type and the machine it has selected disagree (issue
   *  #1028): the program would be cut on a machine the job is not set up for,
   *  so the export is refused rather than written. Params: the machine's name
   *  and the project type it does not suit. */
  | 'exportMachineTypeMismatch'
  // clamps travel / postprocessor
  | 'clampTravelLimitExceeded'
  | 'postWcsNullSelect'
  | 'postToolChangesDisabled'
  | 'postNoCoolantCommands'
  /** A milling operation was exported to a plasma machine. It has no torch
   *  path, so it is left out of the program (issue #959). */
  | 'postPlasmaOperationSkipped'
  /** A plasma cut was exported to a machine that is not a plasma table. It
   *  has no spindle path, so it is left out of the program rather than run
   *  1.5 mm above the stock (issue #960). */
  | 'postPlasmaCutSkipped'
  /** A plasma operation's tool has no QtPlasmaC material number, so the
   *  program cannot select the material it cuts with (issue #959). */
  | 'postPlasmaMaterialMissing'
  /** A G-code pierce operation has no effective cut feed: it is missing,
   *  non-finite, non-positive, or positive but rounds to zero at the
   *  definition's emitted precision. The program would cut with F0. G-code
   *  piercing owns the cut feed, unlike controller piercing, which takes it
   *  from the material table (issue #983). */
  | 'postPlasmaCutFeedMissing'
  /** The same for the plunge (drop) feed: the torch would drop from pierce
   *  height to cut height with F0 (issue #983). */
  | 'postPlasmaPlungeFeedMissing'
  /** A G-code pierce operation has cuts but no rapid to read its safe height
   *  from, so the retracts between them cannot be placed and the cuts are not
   *  written. The #957 toolpath ends every contour with a rapid, so this
   *  guards a toolpath that reached the emitter in another shape (issue
   *  #983). */
  | 'postPlasmaSafeHeightMissing'
  /** Rotary refusals (issue #393). Each skips the operation and names it: a
   *  program that guessed at the stock's angle, or at a feed that is not the
   *  one the cut needs, cuts the part wrong. */
  /** The toolpath turns the stock, but this machine has no rotary axis. */
  | 'postRotaryNoAxis'
  /** The toolpath has a turning feed move and the controller has no
   *  inverse-time feed, so no correct feed word can be written for it. */
  | 'postRotaryNoInverseTime'
  /** The operation moves along the project axis whose motor drives the rotary,
   *  so that travel does not exist on this machine. */
  | 'postRotaryBorrowedAxisTravel'
  /** A turning cut measures its feed from the bar's centreline, and the stock
   *  is not a round bar. */
  | 'postRotaryNeedsRoundStock'
  /** The operation starts cutting at an angle the program has not turned the
   *  bar to: the controller is at another angle, or at an unknown one because
   *  no rapid has established it yet (issue #393, rule 2). */
  | 'postRotaryAngleNotEstablished'
  /** One of the machine's own template lines (a header, tool-change or other
   *  command) writes the machine's rotary word, so it would turn the bar behind
   *  the planner's back. Every operation is refused on a borrowed motor, and on
   *  a machine with its own axis the program is refused once any exported
   *  operation carries an angle (issue #393, rule 3c). */
  | 'postRotaryTemplateUsesBorrowedAxis'
  /** A drilling operation has drill holes but no expanded moves. Canned cycles
   *  are never written on a machine whose rotary borrows a motor, so the holes
   *  would be silently dropped; the operation is refused instead (issue #393,
   *  rule 3b). */
  | 'postRotaryDrillNotExpanded'
  /** The toolpath carries an angle about the bar's own axis, but the machine
   *  turns the stock about the other horizontal axis: the angle means a
   *  different motion on this machine, so the operation is not exported
   *  (issue #395). */
  | 'postRotaryAxisMismatch'
  /** A square blank's corners sweep `barMaxRadius` about the true pivot as the
   *  blank turns. A supplied or stale path that changes A while the cutter's
   *  lowest point is below that corner envelope would drive the standing
   *  corners through the cutter, so the operation is refused rather than
   *  posted (issue #1016 C2 correction M1). */
  | 'postRotarySquareTurnBelowEnvelope'
  /** A bar turn (the manual-index opening turn or the closing unwind) has no
   *  honest clearance retract: no tool-length compensation is active, so a
   *  work-coordinate retract would not describe the tip, and the machine has
   *  no machine-coordinate rapid to the Safe Z. The program is refused rather
   *  than turned with a clearance nobody can prove (issue #1054 fix 2). */
  | 'postRotaryTurnWithoutClearance'
  | 'postNoToolChangeCommands'
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
 * - `exportMachineTypeMismatch` — the machine selected for the project cannot
 *   run the job it holds: a plasma machine on a milling project, or a machine
 *   with no rotary on a rotary one. Publishing the program would invite a cut
 *   on the wrong machine (issue #1028).
 * - `postToolChangesDisabled` — the G-code cuts the second operation's paths
 *   with the first operation's tool. Nothing in the program pauses the machine
 *   for a change, so the part is machined with the wrong cutter.
 * - `postMixedSetups` — the program runs operations of two setups back to
 *   back, with nothing between them to turn the part: the second setup's
 *   paths are cut into the wrong face (issue #946).
 * - `postSetupOperationRefused` — an operation in the program has no motion
 *   because its setup may not cut it, so the saved file would quietly lack a
 *   pass the operation list promises (issue #946).
 * - `workholdingDiameter`, `workholdingPlacement`, `ordinaryClampOverlap` — a
 *   square blank's physical setup is not one this build can hold: the blank's
 *   standing corners would pass through a too-small support, the support is not
 *   at the pivot, or an ordinary clamp reaches into the swept envelope. The
 *   operation generates no motion, so the same missing-pass reasoning applies
 *   and each names the actual problem (issue #1016 C2 F3).
 * - `postPlasmaMaterialMissing` — QtPlasmaC would fire the torch with
 *   whatever material happens to be loaded: the wrong cut feed, heights and
 *   pierce delay for the sheet on the table (issue #959).
 * - `postPlasmaCutFeedMissing` / `postPlasmaPlungeFeedMissing` — a G-code
 *   pierce program would command F0 on a cut or on the drop to cut height, so
 *   the torch fires and the machine then does not move (issue #983).
 * - `postPlasmaSafeHeightMissing` — a G-code pierce operation's cuts are left
 *   out because no safe height could be read for them, so the saved file
 *   would quietly lack that operation's cuts (issue #983).
 * - `postRotaryNoAxis`, `postRotaryNoInverseTime`, `postRotaryBorrowedAxisTravel`,
 *   `postRotaryNeedsRoundStock`, `postRotaryAngleNotEstablished`,
 *   `postRotaryTemplateUsesBorrowedAxis`, `postRotaryDrillNotExpanded`,
 *   `postRotaryAxisMismatch`, `postRotarySquareTurnBelowEnvelope` and
 *   `postRotaryTurnWithoutClearance` — a rotary operation or turn the machine
 *   cannot run safely is left out of the program (issues #393, #1016 C2 M1,
 *   #1054 fix 2). The file would otherwise be saved without that pass, or
 *   turned at a height nobody can prove.
 *
 * `aroundStockMismatch` stays a **warning**, as it was before #1016 C2-S4: a
 * round bar or a block in an Around setup is a note about a job the setup does
 * not describe, and promoting the code globally would have changed existing
 * round/flat programs' severity (a frozen contract). The square blank's own
 * new refusals do not reuse it — they report `postSetupOperationRefused`
 * (already an error), so only the square case blocks a save.
 */
const ERROR_CODES: ReadonlySet<ToolpathWarningCode> = new Set<ToolpathWarningCode>([
  'exportMachineTypeMismatch',
  'postToolChangesDisabled',
  'postMixedSetups',
  'postSetupOperationRefused',
  'workholdingDiameter',
  'workholdingPlacement',
  'ordinaryClampOverlap',
  'postPlasmaMaterialMissing',
  'postPlasmaCutFeedMissing',
  'postPlasmaPlungeFeedMissing',
  'postPlasmaSafeHeightMissing',
  'postRotaryNoAxis',
  'postRotaryNoInverseTime',
  'postRotaryBorrowedAxisTravel',
  'postRotaryNeedsRoundStock',
  'postRotaryAngleNotEstablished',
  'postRotaryTemplateUsesBorrowedAxis',
  'postRotaryDrillNotExpanded',
  'postRotaryAxisMismatch',
  'postRotarySquareTurnBelowEnvelope',
  'postRotaryTurnWithoutClearance',
])

/**
 * How a code should be presented, and whether it blocks an export. One lookup
 * so a code carries the same severity everywhere it is shown.
 */
export function warningSeverity(code: ToolpathWarningCode): ToolpathWarningSeverity {
  return ERROR_CODES.has(code) ? 'error' : 'warning'
}
