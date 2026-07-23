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
  'warnings.vcarveMedialNeedsVBit': 'V-Carve medial requires a V-bit tool',
  'warnings.vcarveBandNoDepth': 'Band {topZ} -> {bottomZ} leaves no usable V-carve depth',
  'warnings.vcarveDegenerateRegion': 'A region has degenerate XY bounds and produced no medial axis',
  'warnings.vcarveSamplingBudget': 'Sampling resolution raised to {resolution} on large regions to bound computation',
  'warnings.vcarveNoMedialAxis': 'A region produced no medial axis (feature may be thinner than the step size)',
  'warnings.vcarveMedialNoMoves': 'V-carve medial generator produced no toolpath moves',
  // v-carve (offset)
  'warnings.vcarveWrongKind': 'Only V-carve operations can be resolved by the V-carve generator',
  'warnings.vcarveNeedsVBit': 'V-Carve requires a V-bit tool',
  'warnings.contourSpacingPositive': 'Contour spacing must be greater than zero',
  'warnings.vBitInvalidSlope': 'V-bit angle produces an invalid carving slope',
  'warnings.vcarveNoMoves': 'V-carve generator produced no toolpath moves',
  // edge route
  'warnings.edgeRouteWrongKind': 'Only edge-route operations can be resolved by the edge-route generator',
  'warnings.edgeRouteNoTargets': 'Edge-route operation has no feature targets',
  'warnings.edgeRouteNoValidTargets': 'No valid target features were found for this edge-route operation',
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
  // tabs
  'warnings.tabOnlyEdgeRoute': 'Tab "{name}" is relevant to this operation, but tabs are only applied to edge-route operations right now.',
  'warnings.tabsOverlapAmbiguous': 'Tabs "{a}" and "{b}" overlap in a way that may produce ambiguous output.',
  'warnings.tabNoIntersect': 'Tab "{name}" does not intersect the selected operation toolpath.',
  'warnings.tabAboveStockTop': 'Tab "{name}" extends above stock top (Z Top {zTop}, stock top {stockTop}).',
  'warnings.tabBelowStockBottom': 'Tab "{name}" extends below stock bottom (Z Bottom {zBottom}).',
  'warnings.tabInvalidZRange': 'Tab "{name}" has invalid Z range ({zBottom} -> {zTop}).',
  'warnings.tabOutsideCutZ': 'Nearby tab {name} overlaps the toolpath footprint but is outside the cut Z range ({minZ} -> {maxZ}).',
  'warnings.tabsOutsideCutZ': '{count} nearby tabs overlap the toolpath footprint but are outside the cut Z range ({minZ} -> {maxZ}).',
  'warnings.tabsOutsideCutZList': '{count} nearby tabs overlap the toolpath footprint but are outside the cut Z range ({minZ} -> {maxZ}): {names}.',
  'warnings.tabsOutsideCutZListMore': '{count} nearby tabs overlap the toolpath footprint but are outside the cut Z range ({minZ} -> {maxZ}): {names}, and {more} more.',
  // surface clean / finish bands
  'warnings.surfaceNoCleanupRegion': 'No machinable parallel cleanup region for band {topZ} -> {bottomZ}',
  'warnings.surfaceNoCleanupSegments': 'No machinable parallel cleanup segments for band {topZ} -> {bottomZ}',
  'warnings.surfaceNoOffsetContours': 'No machinable offset contours for band {topZ} -> {bottomZ}',
  'warnings.surfaceFinishBothDisabled': 'Finish operation has both Finish Walls and Finish Floor disabled',
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
  'warnings.drillTargetsNotCircles': 'Some selected target features are not circles and were skipped',
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
  'warnings.regionClippedOne': 'Region filter clipped {count} cut move.',
  'warnings.regionClippedMany': 'Region filter clipped {count} cut moves.',
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
  // postprocessor
  'warnings.postWcsNullSelect': 'Machine definition requests {wcsCommand} in header but selectCommand is null.',
  'warnings.postToolChangesDisabled': 'Operation "{operation}" uses a different tool ("{tool}") than previous, but tool changes are disabled.',
  'warnings.postNoCoolantCommands': 'Coolant emission requested but machine definition has no coolant commands.',
  'warnings.postCannedCycleUnsupported': 'Operation "{operation}": {drillType} canned cycle not supported by machine "{machine}"; emitting expanded moves.',
  'warnings.postArcNoCapability': 'Operation "{operation}" contains circular toolpath segments but the selected machine does not support arc interpolation (G2/G3). Emitting linear moves instead.',
  // simulation replay / booklet report
  'warnings.replayNoTool': 'No tool assigned to the selected operation.',
  'warnings.bookletNoTool': 'No tool is selected for this operation.',
  'warnings.bookletNoToolpath': 'Toolpath could not be generated for this operation.',
  'warnings.restOperationNotFound': 'Operation not found',
  'warnings.restOnlyPocketEdgeTargets': 'Rest operations can only be created from pocket or edge-route operations with feature targets',
} as const satisfies Record<string, string>
