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
 * Toolpath/postprocessor warning messages, one key per
 * `ToolpathWarningCode` (`warnings.<code>`), plus the `warnings.moveKind.*`
 * words injected by `src/i18n/warningText.ts`. English values are
 * byte-identical to the strings the engine emitted before the structured
 * conversion. `warnings.debug` is a developer-diagnostic passthrough and is
 * never translated.
 */
export const warningsEn = {
  'warnings.debug': '{text}',
  // resolver
  'warnings.targetsMissingOrWrongRole': 'Some selected target features are missing or are not {roles} features',
  'warnings.closedProfilesOnly': '{operation} operations only support closed target profiles',
  'warnings.bandEmptySubject': 'Band {topZ} -> {bottomZ} resolved to empty subject geometry',
  'warnings.bandNoRegions': 'Band {topZ} -> {bottomZ} resolved to no machinable regions',
  'warnings.resolverNoBands': '{operation} resolver produced no depth bands',
  'warnings.resolverOnlyInsideEdge': 'Only inside edge-route operations can be resolved by this region resolver',
  'warnings.resolverOnlyPocketVcarve': 'Only pocket and V-carve operations can be resolved by this region resolver',
  'warnings.resolverNoValidKindTargets': 'No valid {kind} features were found for this {operation} operation',
  'warnings.resolverNoValidSubtracts': 'No valid subtract features were found for this {operation} operation',
  'warnings.resolverNoTargets': '{operation} operation has no feature targets',
  // shared
  'warnings.cutDepthExceedsToolMax': 'Cut depth {depth} {units} exceeds tool max cut depth {max} {units}',
  'warnings.cutDepthExceedsToolMaxForFeature': '{name}: Cut depth {depth} {units} exceeds tool max cut depth {max} {units}',
  'warnings.entryStrategyFallback': 'The selected entry move did not fit inside the available cutting area, so a safer fallback entry was used.',
  'warnings.entryHelixDiameterClamped': 'The helix entry diameter was reduced from {requestedDiameter} to {actualDiameter} to fit the cutting area.',
  'warnings.noToolAssigned': 'No tool assigned to this operation',
  'warnings.vBitAngleRange': 'V-bit angle must be between 0 and 180 degrees',
  'warnings.maxCarveDepthPositive': 'Max carve depth must be greater than zero',
  'warnings.toolDiameterPositive': 'Tool diameter must be greater than zero',
  'warnings.stepdownPositive': 'Operation stepdown must be greater than zero',
  'warnings.targetsNotFound': 'One or more target features not found',
  'warnings.targetsMissing': 'Some selected target features are missing',
  'warnings.stepoverRatioRange': 'Stepover ratio must be between 0 and 1',
  'warnings.operationStepoverRatioRange': 'Operation stepover ratio must be between 0 and 1',
  // v-carve medial
  'warnings.vcarveMedialWrongKind': 'Only V-carve medial operations can be resolved by the medial-axis generator',
  'warnings.vcarveMedialNeedsVBit': 'V-carve medial requires a V-bit tool',
  'warnings.vcarveBandNoDepth': 'Band {topZ} -> {bottomZ} leaves no usable V-carve depth',
  'warnings.vcarveDegenerateRegion': 'A region has degenerate XY bounds and produced no medial axis',
  'warnings.vcarveSamplingBudget': 'Sampling resolution raised to {resolution} on large regions to bound computation',
  'warnings.vcarveNoMedialAxis': 'A region produced no medial axis (feature may be thinner than the step size)',
  'warnings.vcarveMedialNoMoves': 'V-carve medial generator produced no toolpath moves',
  // v-carve (offset)
  'warnings.vcarveWrongKind': 'Only V-carve operations can be resolved by the V-carve generator',
  'warnings.vcarveNeedsVBit': 'V-carve requires a V-bit tool',
  'warnings.contourSpacingPositive': 'Contour spacing must be greater than zero',
  'warnings.vBitInvalidSlope': 'V-bit angle produces an invalid carving slope',
  'warnings.vcarveNoMoves': 'V-carve generator produced no toolpath moves',
  // edge route
  'warnings.edgeRouteWrongKind': 'Only edge-route operations can be resolved by the edge-route generator',
  'warnings.edgeRouteNoTargets': 'Edge-route operation has no feature targets',
  'warnings.edgeRouteNoValidTargets': 'No valid target features were found for this edge-route operation',
  'warnings.edgeTrochoidalWidthTooSmall': 'Trochoidal cut width must be at least 1.15 times the tool diameter.',
  'warnings.edgeTrochoidalWidthNarrow': 'Trochoidal cut width is narrow; 1.25 times the tool diameter or wider is recommended.',
  'warnings.edgeTrochoidalWidthLeavesCore': 'Trochoidal cut width is more than twice the tool diameter; each helical entry leaves an uncut core the next loops must plough through. Reduce the cut width or pre-drill the entry.',
  'warnings.edgeTrochoidalAdvanceRange': 'Trochoidal advance must be greater than 0 and no more than one tool diameter.',
  'warnings.edgeTrochoidalParametersInvalid': 'Trochoidal routing requires positive feed, plunge feed, and RPM values.',
  'warnings.edgeTrochoidalEntryStrategyUnsupported': 'Trochoidal routing supports Helix or Plunge entry only.',
  'warnings.edgeTrochoidalInvalidGuide': 'Trochoidal routing requires a single valid closed guide.',
  'warnings.edgeTrochoidalAdvanceDegenerate': 'The trochoidal advance near ({x}, {y}) is too small for this cutter: the orbit moves forward less than 1% of the tool diameter per loop, so it re-cuts the same material instead of progressing. Raise the advance per loop.',
  'warnings.edgeTrochoidalMoveBudget': 'Trochoidal routing needs more points than one operation allows. Raise the advance per loop, raise the stepdown so there are fewer Z levels, or use a larger cutter.',
  'warnings.edgeTrochoidalEntryBudget': 'The trochoidal entry near ({x}, {y}) does not fit in what is left of the operation point budget. Raise the advance per loop, raise the stepdown so there are fewer Z levels, or use a larger cutter.',
  'warnings.edgeTrochoidalTabsRequireHelix': 'Trochoidal routing requires Helix entry when tabs are active.',
  'warnings.edgeTrochoidalTabUnsafe': 'Trochoidal tab clearance is unsafe near ({x}, {y}).',
  'warnings.edgeTrochoidalSmoothTabFallback': 'Tab "{name}" is set to Smooth, but trochoidal edge route cuts it as Rectangular. The toolpath steps over this tab instead of ramping.',
  'warnings.edgeTrochoidalSkippedSpan': 'The trochoidal span near ({x}, {y}) is too short for a safe helical entry and was skipped.',
  'warnings.edgeTrochoidalNoSurvivingSpan': 'No trochoidal guide span near ({x}, {y}) can safely establish an entry cavity.',
  'warnings.edgeTrochoidalSafetyCheck': 'Trochoidal safety verification failed near ({x}, {y}); no path was generated.',
  // engrave (follow_line) trochoidal
  'warnings.carveTrochoidalWidthTooSmall': 'Trochoidal engraving cut width must be at least 1.15 times the tool diameter.',
  'warnings.carveTrochoidalWidthNarrow': 'Trochoidal engraving cut width is narrow; 1.25 times the tool diameter or wider is recommended.',
  'warnings.carveTrochoidalWidthLeavesCore': 'Trochoidal engraving cut width is more than twice the tool diameter; each helical entry leaves an uncut core the next loops must plough through. Reduce the cut width or pre-drill the entry.',
  'warnings.carveTrochoidalAdvanceRange': 'Trochoidal engraving advance must be greater than 0 and no more than one tool diameter.',
  'warnings.carveTrochoidalEntryStrategyUnsupported': 'Trochoidal engraving supports Helix or Plunge entry only.',
  'warnings.carveTrochoidalInvalidGuide': 'The engraving path near ({x}, {y}) is not a valid trochoidal guide.',
  'warnings.carveTrochoidalAdvanceDegenerate': 'The trochoidal engraving advance near ({x}, {y}) is too small for this cutter: the orbit moves forward less than 1% of the tool diameter per loop, so it re-cuts the same material instead of progressing. Raise the advance per loop.',
  'warnings.carveTrochoidalMoveBudget': 'Trochoidal engraving near ({x}, {y}) needs more points than one operation allows. Raise the advance per loop, raise the stepdown so there are fewer Z levels, or use a larger cutter.',
  'warnings.carveTrochoidalEntryBudget': 'The trochoidal engraving entry near ({x}, {y}) does not fit in what is left of the operation point budget. Raise the advance per loop, raise the stepdown so there are fewer Z levels, or use a larger cutter.',
  'warnings.carveTrochoidalNeedsConstantDiameterTool': 'Trochoidal engraving needs a constant-diameter cutter. A V-bit has no fixed cutting diameter, so the channel width would be wrong at every depth. Use an end mill or switch the strategy to Direct.',
  'warnings.edgeMixedDepthSpans': 'Selected outside edge targets have different effective depth spans. Combined outside routing is not supported for mixed-depth targets yet; generating separate contours may cut internal overlap. Split the operation by depth or align target tops/bottoms.',
  'warnings.edgeNoCombinedContour': 'No valid combined outer contour could be generated for the selected outside edge targets',
  'warnings.edgeFeatureNoCutDepth': '{name} leaves no cut depth after axial stock-to-leave',
  'warnings.edgeBandNoCutDepth': 'Band {topZ} -> {bottomZ} leaves no cut depth after axial stock-to-leave',
  'warnings.edgeNoContourForFeature': 'No valid contour could be generated for {name}',
  'warnings.edgeNoInsideContour': 'No valid inside contour could be generated for band {topZ} -> {bottomZ}',
  'warnings.edgeClosedProfilesOnly': 'Edge-route operations only support closed target profiles',
  // 3D surface roughing (stepdown)
  'warnings.surface3dNeedsModel': '{operation} requires a model feature to be selected',
  'warnings.surface3dNotMesh': 'Model feature must be an imported mesh model',
  'warnings.surface3dLoadFailed': 'Failed to load model geometry',
  'warnings.surface3dStockToLeaveTooLarge': 'Axial stock-to-leave exceeds model height — nothing to cut',
  'warnings.surface3dDegenerateBoundary': 'Computed outer boundary is degenerate — model silhouette may be too small',
  'warnings.surface3dNoDepthInPocket': 'Containing subtract feature leaves no machining depth for this model',
  'warnings.surface3dNoStepLevels': 'No step levels generated',
  'warnings.surface3dOpenMesh': 'Model has open/non-watertight slices; roughing used conservative silhouette protection',
  'warnings.surface3dFloorCollapsed': 'Critical cleanup floor at Z={z} collapsed after inset and was skipped',
  'warnings.surface3dNoLevels': 'No machinable 3D surface levels were found',
  'warnings.surface3dMeshTooDense': 'Mesh is too detailed for 3D surface machining at Z={z} ({vertices} contour points against a budget of {budget}) — reduce the mesh detail before importing, or restrict the operation to a region',
  // tabs
  'warnings.tabOnlyEdgeRoute': 'Tab "{name}" is relevant to this operation, but tabs are only applied to edge-route operations right now.',
  'warnings.tabsOverlapAmbiguous': 'Tabs "{a}" and "{b}" overlap in a way that may produce ambiguous output.',
  'warnings.tabNoIntersect': 'Tab "{name}" does not intersect the selected operation toolpath.',
  'warnings.tabAboveStockTop': 'Tab "{name}" extends above stock top (Z top {zTop}, stock top {stockTop}).',
  'warnings.tabBelowStockBottom': 'Tab "{name}" extends below stock bottom (Z bottom {zBottom}).',
  'warnings.tabInvalidZRange': 'Tab "{name}" has invalid Z range ({zBottom} -> {zTop}).',
  'warnings.tabOutsideCutZ': 'Nearby tab {name} overlaps the toolpath footprint but is outside the cut Z range ({minZ} -> {maxZ}).',
  'warnings.tabsOutsideCutZ': '{count} nearby tabs overlap the toolpath footprint but are outside the cut Z range ({minZ} -> {maxZ}).',
  'warnings.tabsOutsideCutZList': '{count} nearby tabs overlap the toolpath footprint but are outside the cut Z range ({minZ} -> {maxZ}): {names}.',
  'warnings.tabsOutsideCutZListMore': '{count} nearby tabs overlap the toolpath footprint but are outside the cut Z range ({minZ} -> {maxZ}): {names}, and {more} more.',
  'warnings.tabsBlockFinalDepth': 'Tabs cover the whole final pass of "{name}", so it never reaches full depth and the part will not be cut free. Use fewer or narrower tabs.',
  // surface clean / finish bands
  'warnings.surfaceNoCleanupRegion': 'No machinable parallel cleanup region for band {topZ} -> {bottomZ}',
  'warnings.surfaceNoCleanupSegments': 'No machinable parallel cleanup segments for band {topZ} -> {bottomZ}',
  // corner relief
  'warnings.cornerReliefCornerTooTight': 'Corner relief skipped at ({x}, {y}): the adjacent edges are too short to hold the relief notch',
  'warnings.cornerReliefNoWallPath': 'Corner relief skipped at ({x}, {y}): this operation’s tool path does not turn that corner',
  'warnings.cornerReliefCornerNotCut': 'Corner relief skipped at ({x}, {y}): the operation never cuts there at full depth, so descending would enter uncut material',
  'warnings.cornerReliefCornerObstructed': 'Corner relief skipped at ({x}, {y}): a tab covers the corner',
  'warnings.cornerReliefNoStepdown': 'Corner relief skipped: tool {tool} has no stepdown, so the relief pass would cut to full depth in one step',
  'warnings.surfaceNoOffsetContours': 'No machinable offset contours for band {topZ} -> {bottomZ}',
  'warnings.surfaceFinishBothDisabled': 'Finish operation has both finish walls and finish floor disabled',
  'warnings.surfaceCleanWrongKind': 'Only surface-clean operations can be resolved by the surface-clean resolver',
  'warnings.surfaceCleanNoTargets': 'Surface-clean operation has no feature targets',
  'warnings.surfaceCleanNoValidTargets': 'No valid add features were found for this surface-clean operation',
  'warnings.surfaceBandNoFinishDepth': 'Band {topZ} -> {bottomZ} leaves no finish depth after axial stock-to-leave',
  'warnings.surfaceBandNoRoughDepth': 'Band {topZ} -> {bottomZ} leaves no roughing depth after axial stock-to-leave',
  'warnings.surfaceNoFinishContours': 'No finish contours available for band {topZ} -> {bottomZ}',
  'warnings.surfaceTargetsWrongRole': 'Some selected target features are missing or are not add/model features',
  'warnings.surfaceClosedProfilesOnly': 'Surface-clean operations only support closed target profiles',
  'warnings.surfaceNoBands': 'Surface-clean resolver produced no depth bands',
  // drilling
  'warnings.drillBottomAboveTop': '{name} bottom Z is not below top Z; skipping',
  'warnings.drillNoCenter': '{name} is marked as a circle but has no resolvable center',
  'warnings.drillNoTargets': 'Drilling operation has no feature targets',
  'warnings.drillWrongKind': 'Only drilling operations can be resolved by the drilling generator',
  'warnings.drillNoValidCircles': 'No valid circle features were found for this drilling operation',
  'warnings.drillPeckDepthPositive': 'Peck depth must be greater than zero for peck / chip-breaking drilling; falling back to a single plunge',
  'warnings.drillNotDrillBit': 'Selected tool is not a drill bit — drilling cycles typically require a drill tool',
  'warnings.drillHelicalToolUnsupported': 'Helical boring requires a flat endmill; falling back to a simple plunge',
  'warnings.drillHelicalBoreTooSmall': 'Selected circle diameter ({holeDiameter}) is not larger than the tool diameter ({toolDiameter}); helical boring skipped — hole must be strictly larger than the endmill',
  'warnings.drillHelicalBoreTooLarge': 'Selected circle diameter ({holeDiameter}) exceeds 2× the tool diameter ({maxDiameter}); helical boring is limited to 2× the endmill diameter — use inside edge cut instead',
  'warnings.drillHelicalBoreUnmachinable': 'The requested helical bore cannot be generated within the move limit; no output produced for this target',
  'warnings.drillRetractBelowStockTop': 'Retract height ({requested}) is at or below the top of the material; the retract plane is clamped to {clamped} above it so the tool does not enter the part at rapid. Set a positive distance above the material surface.',
  'warnings.drillTargetsNotCircles': 'Some selected target features are not circles and were skipped',
  // countersinking
  'warnings.drillCountersinkNeedsVBit': 'Countersinking requires a V-bit; assign one to this operation — no countersink was cut',
  'warnings.drillCountersinkDiameterPositive': 'Countersink diameter must be greater than zero — no countersink was cut',
  'warnings.drillCountersinkExceedsToolDiameter': 'Countersink diameter ({requested}) is wider than the V-bit ({toolDiameter}); the cutter cannot open the mouth that far — no countersink was cut',
  'warnings.drillCountersinkDepthExceedsToolMax': 'Countersink plunge {depth} {units} exceeds the tool max cut depth {max} {units} — no countersink was cut',
  'warnings.drillCountersinkNotLargerThanHole': '{name}: countersink diameter ({requested}) does not exceed the hole diameter ({holeDiameter}); there is no seat to cut — skipped',
  // carving (follow-line)
  'warnings.carveDepthClamped': '{name} carve depth exceeds stock bottom; clamped to Z 0',
  'warnings.carveNotEnoughGeometry': '{name} does not contain enough geometry for follow-line carving',
  'warnings.carveDepthPositive': 'Carve depth must be greater than zero',
  'warnings.carveNoTargets': 'Follow-line operation has no feature targets',
  'warnings.carveWrongKind': 'Only follow-line operations can be resolved by the carving generator',
  'warnings.carveNoValidTargets': 'No valid target features were found for this follow-line operation',
  // rest regions
  'warnings.restOnlyEdgeRoute': 'Rest regions can only be generated for edge-route operations',
  'warnings.restOnlyPocket': 'Rest regions can only be generated for pocket operations',
  'warnings.restNoValidOutsideTargets': 'No valid add/model features were found for this outside edge-route operation',
  // clamps / regions
  'warnings.clampCrossedOne': 'Clamp "{name}" is crossed by {count} {moveKind} move below required clearance (min Z {minZ}, required Z {requiredZ}).',
  'warnings.clampCrossedMany': 'Clamp "{name}" is crossed by {count} {moveKind} moves below required clearance (min Z {minZ}, required Z {requiredZ}).',
  'warnings.clampTravelLimitExceeded': 'Clamp "{name}" requires clearance Z {requiredZ}, which exceeds project max travel Z {maxZ}.',
  'warnings.moveKind.rapid': 'rapid',
  'warnings.moveKind.plunge': 'plunge',
  'warnings.moveKind.lead_in': 'lead-in',
  'warnings.moveKind.lead_out': 'lead-out',
  'warnings.moveKind.cut': 'cut',
  // finish surface
  'warnings.finishNeedsModel': 'Finish surface requires a model feature and optionally one or more region features',
  'warnings.finishNotMesh': 'Finish surface requires an imported mesh model feature',
  'warnings.finishNoDepthInPocket': 'Containing subtract feature leaves no finish depth for this model',
  'warnings.surfaceHeightMapReduced': 'Finish surface height map reduced from {from} to about {to} cells for performance',
  'warnings.surfaceSilhouetteDegenerate': 'Model silhouette is degenerate — no finish surface coverage generated',
  'warnings.cleanupStockToLeaveOffsets': '3D surface cleanup uses stock-to-leave values; non-zero radial or axial leave offsets cleanup from the final surface',
  'warnings.cleanupNoContours': 'No cleanup contours available for this 3D surface operation',
  // pocket floors
  'warnings.pocketNoFloorRegion': 'No machinable parallel floor region for band {topZ} -> {bottomZ}',
  'warnings.pocketNoFloorSegments': 'No machinable parallel floor segments for band {topZ} -> {bottomZ}',
  'warnings.pocketWallCornerCleanupFallback': 'A rounded pocket wall corner could not be cleaned safely; the sharp wall path was kept for that ring',
  // postprocessor
  'warnings.postWcsNullSelect': 'Machine definition requests {wcsCommand} in header but selectCommand is null.',
  'warnings.postToolChangesDisabled': 'Operation "{operation}" uses a different tool ("{tool}") than previous, but tool changes are disabled.',
  'warnings.postNoCoolantCommands': 'Coolant emission requested but machine definition has no coolant commands.',
  'warnings.postCannedCycleUnsupported': 'Operation "{operation}": {drillType} canned cycle not supported by machine "{machine}"; emitting expanded moves.',
  'warnings.postArcNoCapability': 'Operation "{operation}" contains linear moves that could be fitted as arcs, but the selected machine does not support arc interpolation (G2/G3). Emitting linear moves instead.',
  'warnings.postArcFallbackLinear': 'Operation "{operation}" had {count} fitted arc run(s) that the selected controller would reject after number rounding. Those spans were emitted as linear moves instead.',
  // simulation replay / booklet report
  'warnings.replayNoTool': 'No tool assigned to the selected operation.',
  'warnings.bookletNoTool': 'No tool is selected for this operation.',
  'warnings.bookletNoToolpath': 'Toolpath could not be generated for this operation.',
  'warnings.restOperationNotFound': 'Operation not found',
  'warnings.restOnlyPocketEdgeTargets': 'Rest operations can only be created from pocket or edge-route operations with feature targets',
  'warnings.restTrochoidalUnsupported': 'Rest machining is unavailable for trochoidal edge routing because its swept channel cannot yet be represented as a rest region.',
} as const satisfies Record<string, string>
