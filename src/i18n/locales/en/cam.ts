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
 * CAM namespace: operation/tool panels, operation add menu, operation parameter
 * reference diagrams, operation validity hints, and operation description copy.
 *
 * Keys are permanent identifiers: renaming one orphans it in every custom
 * language pack, so treat renames as breaking and only do them deliberately.
 */
export const camEn = {
  'cam.operation.slopeFilter': 'Filter by surface slope',
  'cam.operation.slopeMin': 'Minimum slope (°)',
  'cam.operation.slopeMax': 'Maximum slope (°)',
  'cam.operation.slopeHelp': 'Slope follows the tool-tip contact surface, measured from horizontal. The cutter can extend across the boundary. Clear both bounds to disable. Height maps cannot represent undercuts. Boundaries follow the displayed height-map resolution.',

  // ── Tool type labels ──
  'cam.toolType.flatEndmill': 'Flat endmill',
  'cam.toolType.ballEndmill': 'Ball endmill',
  'cam.toolType.vBit': 'V-Bit',
  'cam.toolType.drill': 'Drill',

  // ── Drill type labels ──
  'cam.drillType.simple': 'Simple (G81)',
  'cam.drillType.peck': 'Peck (G83)',
  'cam.drillType.dwell': 'Dwell (G82)',
  'cam.drillType.chipBreaking': 'Chip breaking (G73)',
  'cam.drillType.helical': 'Helical',
  'cam.drillType.countersink': 'Countersink',

  // ── Operation kind labels (full, for the Kind field and operationValidity) ──
  'cam.opLabel.pocket': 'Pocket',
  'cam.opLabel.vCarve': 'V-carve offset',
  'cam.opLabel.vCarveMedial': 'V-carve medial',
  'cam.opLabel.edgeRouteInside': 'Edge route inside',
  'cam.opLabel.edgeRouteOutside': 'Edge route outside',
  'cam.opLabel.surfaceClean': 'Surface clean',
  'cam.opLabel.roughSurface': '3D surface rough',
  'cam.opLabel.finishSurface': '3D surface finish',
  'cam.opLabel.finishSurfaceCleanup': '3D surface cleanup',
  'cam.opLabel.followLine': 'Engrave',
  'cam.opLabel.drilling': 'Drill',

  // ── Operation button labels (compact, for the Add menu) ──
  'cam.opButton.pocket': 'Pocket',
  'cam.opButton.vCarve': 'V-carve offset',
  'cam.opButton.vCarveMedial': 'V-carve medial',
  'cam.opButton.edgeIn': 'Edge in',
  'cam.opButton.edgeOut': 'Edge out',
  'cam.opButton.surface': 'Surface',
  'cam.opButton.roughSurface': '3D surface rough',
  'cam.opButton.finishSurface': '3D surface finish',
  'cam.opButton.finishSurfaceCleanup': '3D surface cleanup',
  'cam.opButton.engrave': 'Engrave',
  'cam.opButton.drill': 'Drill',

  // ── Quick operation labels ("Create …") ──
  'cam.quickOp.pocket': 'Create pocket',
  'cam.quickOp.edgeRouteInside': 'Create inside route',
  'cam.quickOp.edgeRouteOutside': 'Create outside route',
  'cam.quickOp.vCarve': 'Create V-carve (offset)',
  'cam.quickOp.vCarveMedial': 'Create V-carve (medial)',
  'cam.quickOp.surfaceClean': 'Create surface clean',
  'cam.quickOp.followLine': 'Create engraving',
  'cam.quickOp.drilling': 'Create drilling',
  // The 3D kinds reuse the CAM panel's `cam.opLabel.*` names verbatim, so an
  // operation is called the same thing wherever it is created (issue #398).
  'cam.quickOp.roughSurface': 'Create 3D surface rough',
  'cam.quickOp.finishSurface': 'Create 3D surface finish',
  'cam.quickOp.finishSurfaceCleanup': 'Create 3D surface cleanup',
  // ── Quick operation group headings (feature context menu) ──
  'cam.quickOp.group.twoD': '2D operations',
  'cam.quickOp.group.threeD': '3D operations',

  // ── Pocket pattern labels ──
  'cam.pocketPattern.offset': 'Offset',
  'cam.pocketPattern.parallel': 'Parallel',
  'cam.pocketPattern.constantScallop': 'Constant scallop',
  'cam.pocketPattern.waterline': 'Waterline',
  'cam.pocketPattern.seededOffset': 'Seeded circles',

  // ── Pass labels ──
  'cam.pass.rough': 'Rough',
  'cam.pass.finish': 'Finish',

  // ── Panel chrome ──
  'cam.panel.emptyOperation': 'Select an operation to edit its parameters.',
  'cam.panel.emptyTool': 'Select a tool to edit its properties.',
  'cam.panel.operations': 'Operations',
  'cam.panel.tools': 'Tools',
  'cam.panel.operationsEmpty': 'Select compatible geometry, then add an operation. Pocket and inside route require subtract features. Outside route requires add features. Surface clean accepts add features.',
  'cam.panel.cam': 'CAM',
  'cam.panel.properties': 'Properties',
  'cam.panel.export': 'Export',
  'cam.panel.add': 'Add',
  'cam.panel.addHint': 'Select geometry first, then choose an operation type',
  'cam.panel.showAllToolpaths': 'Show all toolpaths',
  'cam.panel.hideAllToolpaths': 'Hide all toolpaths',
  'cam.panel.exportGcodeForOperation': 'Export G-code for this operation',
  'cam.panel.exportGcodeForSelected': 'Export G-code for selected operation',
  'cam.panel.exportGcodeFor': 'Export G-code for {name}',
  'cam.panel.exportBookletForOperation': 'Export booklet (PDF) for this operation',
  'cam.panel.exportBookletForSelected': 'Export booklet (PDF) for selected operation',
  'cam.panel.exportBookletFor': 'Export booklet (PDF) for {name}',
  'cam.panel.expandOperationProps': 'Expand operation properties',
  'cam.panel.expandToolProps': 'Expand tool properties',
  'cam.panel.operationProperties': 'Operation properties',
  'cam.panel.toolProperties': 'Tool properties',
  'cam.panel.close': 'Close',

  // ── Operation property labels ──
  'cam.operation.name': 'Name',
  'cam.operation.description': 'Description',
  'cam.operation.kind': 'Kind',
  'cam.operation.pass': 'Pass',
  'cam.operation.maxCarveDepth': 'Max carve depth',
  'cam.operation.carveDepth': 'Carve depth',
  'cam.operation.target': 'Target',
  'cam.operation.targetSource': 'Target source',
  'cam.operation.useCurrentSelection': 'Use current selection',
  'cam.operation.targetUpdated': '✓ Target updated',
  'cam.operation.restMachining': 'Rest machining',
  'cam.operation.restTrochoidalUnavailable': 'Rest machining is unavailable for trochoidal edge routing.',
  'cam.operation.createRestOp': 'Create rest operation',
  'cam.operation.exporting': 'Exporting...',
  'cam.operation.toolpathWarnings': 'Toolpath warnings',
  'cam.operation.tool': 'Tool',
  'cam.operation.noTool': 'No tool',
  'cam.operation.enabled': 'Enabled',
  'cam.operation.stepdown': 'Stepdown',
  'cam.operation.edgeStrategy': 'Strategy',
  'cam.operation.edgeStrategyContour': 'Contour',
  'cam.operation.edgeStrategyTrochoidal': 'Trochoidal',
  'cam.operation.trochoidalCutWidth': 'Trochoidal cut width',
  'cam.operation.trochoidalCutWidthBelowFloor': 'Cut width is below the {minimum} minimum for this tool; no toolpath will be generated.',
  'cam.operation.trochoidalAdvancePercent': 'Advance per loop (% of tool diameter)',
  'cam.operation.trochoidalAdvanceDistance': 'Advance per loop (distance)',
  'cam.operation.trochoidalAdvanceTooltip': 'Stored as a percentage of tool diameter, so it follows the assigned tool. The distance below is derived.',
  'cam.operation.carveStrategy': 'Strategy',
  'cam.operation.carveStrategyDirect': 'Direct',
  'cam.operation.carveStrategyTrochoidal': 'Trochoidal (slot)',
  'cam.operation.carveChannelWidth': 'Channel width',
  'cam.operation.carveChannelWidthNote': 'Trochoidal cuts a {width} channel, not a tool-width groove. Thin engraved text will not survive it.',
  'cam.operation.carveTrochoidalNeedsConstantDiameterTool': 'Trochoidal engraving needs a constant-diameter cutter; assign an end mill or switch to Direct.',
  'cam.operation.contourSpacing': 'Contour spacing',
  'cam.operation.stepoverRatio': 'Stepover ratio',
  'cam.operation.group.identity': 'Identity',
  'cam.operation.group.target': 'What it cuts',
  'cam.operation.group.tool': 'Tool',
  'cam.operation.group.depth': 'Depth',
  'cam.operation.group.feeds': 'Speeds & feeds',
  'cam.operation.group.strategy': 'Strategy',
  'cam.operation.group.entry': 'Entry & retract',
  'cam.operation.group.corners': 'Corners',
  'cam.operation.group.drilling': 'Drilling',
  'cam.operation.group.output': 'Output',
  'cam.operation.entryStrategy': 'Entry strategy',
  'cam.operation.entryPlunge': 'Plunge',
  'cam.operation.entryHelix': 'Helix',
  'cam.operation.entryRamp': 'Ramp',
  'cam.operation.entryRampAngle': 'Ramp angle (°)',
  'cam.operation.entryHelixDiameter': 'Helix diameter (%)',
  'cam.operation.pattern': 'Pattern',
  'cam.operation.angle': 'Angle',
  'cam.operation.cutDirection': 'Cut direction',
  'cam.operation.conventional': 'Conventional',
  'cam.operation.climb': 'Climb',
  'cam.operation.machiningOrder': 'Machining order',
  'cam.operation.featureFirst': 'Feature first',
  'cam.operation.levelFirst': 'Level first',
  'cam.operation.roundOutsideCorners': 'Round corners',
  'cam.operation.roundLinkCorners': 'Round link junctions',
  'cam.operation.cleanWallCorners': 'Round wall corners',
  'cam.operation.cleanWallCornersTooltip': 'Also rounds the ring that defines the wall, cleaning each corner immediately afterwards so the wall keeps its full coverage. Lowers peak cutter load at the corners; costs a little cycle time.',
  'cam.operation.cornerRelief': 'Corner relief',
  'cam.operation.cornerReliefNone': 'None',
  'cam.operation.cornerReliefDogbone': 'Dogbone',
  'cam.operation.cornerReliefTBone': 'T-bone',
  'cam.operation.cornerReliefLongestEdge': 'T-bone, longest edge',
  'cam.operation.cornerReliefTooltip': 'Cuts a relief at every inside corner of the cleared area, as an extra stepped pass after the main path, sized to this operation’s tool. Dogbone puts the relief on the diagonal and removes the least material. T-bone keeps it in one face instead, and pays for that with a slot a full cutter radius deep and two radii wide in that face — about 2.3× the material a dogbone removes. Longest edge is T-bone on the longer of the two walls, where that slot does less damage.',
  'cam.operation.drillType': 'Drill type',
  'cam.operation.peckDepth': 'Peck depth',
  'cam.operation.dwellTime': 'Dwell time (s)',
  'cam.operation.countersinkDiameter': 'Countersink diameter',
  'cam.operation.countersinkDepth': 'Countersink depth',
  'cam.operation.countersinkNeedsVBit': 'Countersinking needs a V-bit. Assign one to this operation.',
  'cam.operation.countersinkExceedsTool': 'Countersink diameter is wider than the V-bit ({toolDiameter}); the cutter cannot open the mouth that far.',
  'cam.operation.retractHeight': 'Retract height',
  'cam.operation.finishWalls': 'Finish walls',
  'cam.operation.finishFloor': 'Finish floor',
  'cam.operation.debugToolpath': 'Debug toolpath',
  'cam.operation.feed': 'Feed',
  'cam.operation.plungeFeed': 'Plunge feed',
  'cam.operation.slotFeed': 'Slot feed (%)',
  'cam.operation.slotFeedTooltip': "Feed percentage for fully engaged (slotting) cuts: each section's innermost loop, uncleared crossings, the parallel boundary pass, and the first fill line. 100 disables the reduction.",
  'cam.operation.engagementMode': 'Feed reduction',
  'cam.operation.engagementModeLegacy': 'Slots only',
  'cam.operation.engagementModeEngagementFeed': 'By engagement',
  'cam.operation.rpm': 'RPM',
  'cam.operation.stockToLeaveRadial': 'Stock to leave radial',
  'cam.operation.stockToLeaveAxial': 'Stock to leave axial',
  'cam.operation.adaptiveRefinement': 'Adaptive refinement',
  'cam.operation.adaptiveRefinementTooltip': 'Adds projected waterline rings on shallow slopes and model tips.',
  'cam.operation.adaptiveSpacing': 'Adaptive spacing',
  'cam.operation.adaptiveSpacingTooltip': 'Projected ring spacing in project units.',
  'cam.operation.maxRingsBand': 'Max rings / band',
  'cam.operation.maxRingsTooltip': 'Maximum projected rings in one band or tip. Use 0 for the default cap.',
  'cam.operation.tabs': 'Tabs',
  'cam.operation.autoPlaceTabs': 'Auto place tabs',
  'cam.operation.arcFitting': 'Arc fitting (G2/G3)',
  'cam.operation.arcFittingTip': 'Export-only: fits contiguous linear moves that approximate a circular path into G2/G3 arc moves where the controller supports it. Does not affect the displayed or simulated toolpath.',

  // ── Region note ──
  'cam.regionNote.badge': 'mask',
  'cam.regionNote.text': 'Regions limit where this operation may cut — not shapes to machine.',

  // ── Operation target summary ──
  'cam.target.stock': 'Stock',
  'cam.target.noFeatures': 'No features',
  'cam.target.noMachiningTarget': 'No machining target',
  'cam.target.filters': '{machiningSummary}; filters: {regionNames}',

  // ── Tool property labels ──
  'cam.tool.name': 'Name',
  'cam.tool.type': 'Type',
  'cam.tool.units': 'Units',
  'cam.tool.unitsMm': 'Millimeters',
  'cam.tool.unitsInch': 'Inches',
  'cam.tool.diameter': 'Diameter',
  'cam.tool.vAngle': 'V angle',
  'cam.tool.flutes': 'Flutes',
  'cam.tool.material': 'Material',
  'cam.tool.materialCarbide': 'Carbide',
  'cam.tool.materialHss': 'HSS',
  'cam.tool.defaultRpm': 'Default RPM',
  'cam.tool.defaultFeed': 'Default feed',
  'cam.tool.plungeFeed': 'Plunge feed',
  'cam.tool.stepdown': 'Stepdown',
  'cam.tool.maxCutDepth': 'Max cut depth',
  'cam.tool.stepoverRatio': 'Stepover ratio',

  // ── Tool panel chrome ──
  'cam.tools.addTool': 'Add tool',
  'cam.tools.importFromLibrary': 'Import from library…',
  'cam.tools.allTypes': 'All types',
  'cam.tools.allUnits': 'All units',
  'cam.tools.empty': 'No tools yet. Add the first tool to start building the library.',
  'cam.tools.duplicateTool': 'Duplicate tool',
  'cam.tools.toolUsedByOperation': 'Tool is used by an operation',
  'cam.tools.deleteTool': 'Delete tool',

  // ── Operation tree row actions ──
  'cam.treeRow.hideToolpath': 'Hide toolpath',
  'cam.treeRow.showToolpath': 'Show toolpath',
  'cam.treeRow.hide': 'Hide',
  'cam.treeRow.show': 'Show',
  'cam.treeRow.toolpathFor': '{action} toolpath for {name}',
  'cam.treeRow.off': 'Off',
  'cam.treeRow.duplicateOperation': 'Duplicate operation',
  'cam.treeRow.deleteOperation': 'Delete operation',
  'cam.treeRow.dragToReorder': 'Drag to reorder',

  // ── Add operation menu ──
  'cam.addMenu.operation': 'Operation',
  'cam.addMenu.roughPass': 'Rough',
  'cam.addMenu.finishPass': 'Finish',
  'cam.addMenu.bothPasses': 'Both',
  'cam.addMenu.roughPassHint': 'Rough pass ({hint})',
  'cam.addMenu.finishPassHint': 'Finish pass ({hint})',
  'cam.addMenu.bothPassesHint': 'Both passes ({hint})',
  'cam.addMenu.roughPassTitle': 'Rough pass',
  'cam.addMenu.finishPassTitle': 'Finish pass',
  'cam.addMenu.bothPassesTitle': 'Both rough and finish passes',
  'cam.addMenu.add': 'Add',
  'cam.addMenu.addHint': 'Add {label} ({hint})',
  'cam.addMenu.addLabel': 'Add {label}',
  'cam.addMenu.selectAll': 'Select all',
  'cam.addMenu.selectAllHint': 'Select all features compatible with {label}',
  'cam.addMenu.collapseInfo': 'Collapse {label} info',
  'cam.addMenu.expandInfo': 'Expand {label} info',
  'cam.addMenu.missingImage': 'Missing image:',
  'cam.addMenu.keyPoints': 'Key points:',
  'cam.addMenu.exampleImage': '{title} example',

  // ── Validation hints: empty selection ──
  'cam.hint.empty.drilling': 'Select one or more circle features first',
  'cam.hint.empty.followLine': 'Select one or more open or closed features first; closed regions are optional filters',
  'cam.hint.empty.surfaceClean': 'Select one or more add/model features first; closed regions are optional filters',
  'cam.hint.empty.vCarve': 'Select one or more closed subtract or line features first',
  'cam.hint.empty.roughSurface': 'Select an imported model feature first',
  'cam.hint.empty.default': 'Select one or more compatible features first',

  // ── Validation hints: construction ──
  'cam.hint.construction': 'Construction geometry is never machined — deselect construction features first',

  // ── Validation hints: drilling ──
  'cam.hint.drilling': 'Drilling requires circle features; closed regions are optional filters',

  // ── Validation hints: follow_line ──
  'cam.hint.followLine': 'Engrave requires at least one path feature; closed regions are optional filters',

  // ── Validation hints: surface_clean ──
  'cam.hint.surfaceCleanNoFeature': 'Surface clean requires at least one add/model feature; regions are only filters',
  'cam.hint.surfaceCleanWrongOp': 'Surface clean only accepts add/model features plus optional closed regions',
  'cam.hint.surfaceCleanClosedOnly': 'Surface clean only accepts closed profiles',

  // ── Validation hints: v_carve / v_carve_medial ──
  'cam.hint.vCarveRequiresClosed': '{kind} requires at least one closed subtract or line feature; regions are only filters',
  'cam.hint.vCarveWrongFeature': '{kind} only accepts closed subtract or line features plus optional closed regions',

  // ── Validation hints: rough_surface ──
  'cam.hint.roughSurfaceNoModel': 'Rough surface requires at least one imported model feature; closed regions are optional filters',

  // ── Validation hints: finish_surface / finish_surface_cleanup ──
  'cam.hint.finishSurfaceCount': '{kind} requires exactly one imported model feature; closed regions are optional filters',
  'cam.hint.finishSurfaceWrong': '{kind} only accepts one imported model plus optional closed regions',

  // ── Validation hints: generic (pocket, edge_route) ──
  'cam.hint.noSubtractFeature': 'Select at least one subtract feature; closed regions are optional filters',
  'cam.hint.noAddFeature': 'Select at least one add feature; closed regions are optional filters',
  'cam.hint.noAddModelFeature': 'Select at least one add/model feature; closed regions are optional filters',
  'cam.hint.onlySubtract': 'This operation only accepts subtract features plus optional closed regions',
  'cam.hint.onlyAdd': 'This operation only accepts add features plus optional closed regions',
  'cam.hint.onlyAddModel': 'This operation only accepts add/model features plus optional closed regions',
  'cam.hint.closedProfilesOnly': '{kind} only accepts closed profiles',

  // ── Validation hints: shared ──
  'cam.hint.regionNotClosed': 'Region filters must be closed profiles',
  'cam.hint.featuresNotFound': 'One or more selected features not found',
  'cam.hint.selectCompatible': 'Select one or more compatible features in the tree or sketch',
  'cam.hint.notCompatible': 'Current selection is not compatible with this operation',

  // ── Booklet export ──
  'cam.booklet.building': 'Building booklet...',
  'cam.booklet.exported': 'Booklet exported: {path}',
  'cam.booklet.cancelled': 'Booklet export cancelled',
  'cam.booklet.failed': 'Failed to export booklet',

  // ── Rest machining ──
  'cam.restOp.created.one': 'Created rest operation with {count} region; choose a smaller tool',
  'cam.restOp.created.other': 'Created rest operation with {count} regions; choose a smaller tool',
  'cam.restOp.empty': 'No unreachable pocket areas found for this tool',

  // ── Library ──
  'cam.library.failed': 'Failed to load tool library.',

  // ── Parameter reference diagram labels ──
  'cam.paramRef.stepdown': 'Stepdown reference',
  'cam.paramRef.edgeStrategy': 'Strategy',
  'cam.paramRef.trochoidalCutWidth': 'Trochoidal cut width',
  'cam.paramRef.trochoidalAdvance': 'Advance per loop',
  'cam.paramRef.stepover': 'Stepover reference',
  'cam.paramRef.maxDepth': 'Max depth reference',
  'cam.paramRef.retractHeight': 'Retract height reference',
  'cam.paramRef.peckDepth': 'Peck depth reference',
  'cam.paramRef.feed': 'Feed reference',
  'cam.paramRef.plungeFeed': 'Plunge feed reference',
  'cam.paramRef.entryStrategy': 'Entry strategy reference',
  'cam.paramRef.entryRampAngle': 'Entry ramp angle reference',
  'cam.paramRef.entryHelixDiameter': 'Entry helix diameter reference',
  'cam.paramRef.slotFeed': 'Slot feed reference',
  'cam.paramRef.engagementMode': 'Feed reduction reference',
  'cam.paramRef.rpm': 'RPM reference',
  'cam.paramRef.dwell': 'Dwell reference',
  'cam.paramRef.cutDirection': 'Cut direction reference',
  'cam.paramRef.pattern': 'Pattern reference',
  'cam.paramRef.machiningOrder': 'Machining order reference',
  'cam.paramRef.rasterAngle': 'Raster angle reference',
  'cam.paramRef.cornerRelief': 'Corner relief reference',
  'cam.paramRef.finishWalls': 'Finish walls reference',
  'cam.paramRef.finishFloor': 'Finish floor reference',
  'cam.paramRef.stockRadial': 'Stock radial reference',
  'cam.paramRef.stockAxial': 'Stock axial reference',
  'cam.paramRef.adaptiveSpacing': 'Adaptive spacing reference',
  'cam.paramRef.adaptiveRefinement': 'Adaptive refinement reference',
  'cam.paramRef.maxRings': 'Max rings reference',
  'cam.paramRef.drillType': 'Drill type reference',
  'cam.paramRef.countersinkDiameter': 'Countersink diameter reference',

  // ── Operation descriptions (OperationAddMenu expanded cards) ──
  // Pocket
  'cam.opDesc.pocket.title': 'Pocket',
  'cam.opDesc.pocket.fullDescription': 'The pocket operation clears the interior of one or more closed subtract profiles down to a fixed Z. Choose between offset (concentric, outside-in) or parallel (scanline) patterns; parallel takes a configurable angle.',
  'cam.opDesc.pocket.keyPoint.0': 'Requires one or more closed subtract profiles',
  'cam.opDesc.pocket.keyPoint.1': 'Offset or parallel clearing pattern',
  'cam.opDesc.pocket.keyPoint.2': 'Supports rough and finish passes',
  'cam.opDesc.pocket.keyPoint.3': 'Best with flat endmills for clean floors',
  'cam.opDesc.pocket.keyPoint.4': 'Optional closed regions act as XY filters',

  // V-Carve offset
  'cam.opDesc.vCarve.title': 'V-carve offset',
  'cam.opDesc.vCarve.fullDescription': "The V-carve offset operation follows progressively narrower inset contours of a closed profile, lowering Z on each pass so the V-bit's angled flank carves a clean V-groove that tapers to the centerline. Depth per pass is derived from contour spacing and the V-bit half-angle.",
  'cam.opDesc.vCarve.keyPoint.0': 'Requires one or more closed subtract profiles',
  'cam.opDesc.vCarve.keyPoint.1': 'Requires a V-bit tool (set the tip angle on the tool first)',
  'cam.opDesc.vCarve.keyPoint.2': 'Single-pass operation (no rough/finish split)',
  'cam.opDesc.vCarve.keyPoint.3': 'Ideal for engraving, signage, and decorative edges',
  'cam.opDesc.vCarve.keyPoint.4': 'Optional closed regions act as XY filters',

  // V-Carve medial
  'cam.opDesc.vCarveMedial.title': 'V-carve medial',
  'cam.opDesc.vCarveMedial.fullDescription': "The V-carve medial operation computes the true medial axis of a closed profile from the Voronoi diagram of its boundary and cuts a V-groove whose depth exactly tracks the local half-width. Sharp corners receive skeleton tips that rise to the surface for crisp points; smooth curves stay clean thanks to geometric filtering. Sampling resolution adjusts automatically to each shape's size.",
  'cam.opDesc.vCarveMedial.keyPoint.0': 'Requires one or more closed subtract profiles',
  'cam.opDesc.vCarveMedial.keyPoint.1': 'Requires a V-bit tool (set the tip angle on the tool first)',
  'cam.opDesc.vCarveMedial.keyPoint.2': 'Exact depth: V flanks touch both walls everywhere along the skeleton',
  'cam.opDesc.vCarveMedial.keyPoint.3': 'Automatic shape-scaled sampling keeps small lettering clean',
  'cam.opDesc.vCarveMedial.keyPoint.4': 'Crisp zero-depth tips in sharp corners; no artifacts on smooth curves',
  'cam.opDesc.vCarveMedial.keyPoint.5': 'Single-pass operation (no rough/finish split)',
  'cam.opDesc.vCarveMedial.keyPoint.6': 'Optional closed regions act as XY filters',

  // Edge route inside
  'cam.opDesc.edgeRouteInside.title': 'Edge route inside',
  'cam.opDesc.edgeRouteInside.fullDescription': 'The edge route inside operation follows the inside edge of one or more closed subtract profiles. A contour pass offsets inward by the tool radius; rough passes can instead use trochoidal loops to reduce radial engagement while leaving stock for a contour finish.',
  'cam.opDesc.edgeRouteInside.keyPoint.0': 'Requires one or more closed subtract profiles',
  'cam.opDesc.edgeRouteInside.keyPoint.1': 'Contour or trochoidal roughing strategy',
  'cam.opDesc.edgeRouteInside.keyPoint.2': 'Trochoidal roughing uses Helix or Plunge entry; tabs require Helix',
  'cam.opDesc.edgeRouteInside.keyPoint.3': 'Finish passes always use a contour',
  'cam.opDesc.edgeRouteInside.keyPoint.4': 'Regions are supported by contour routing only',

  // Edge route outside
  'cam.opDesc.edgeRouteOutside.title': 'Edge route outside',
  'cam.opDesc.edgeRouteOutside.fullDescription': 'The edge route outside operation follows the outside edge of one or more closed add or model profiles. A contour pass offsets outward by the tool radius; rough passes can instead use trochoidal loops to reduce radial engagement while leaving stock for a contour finish.',
  'cam.opDesc.edgeRouteOutside.keyPoint.0': 'Requires one or more closed add or model profiles',
  'cam.opDesc.edgeRouteOutside.keyPoint.1': 'Contour or trochoidal roughing strategy',
  'cam.opDesc.edgeRouteOutside.keyPoint.2': 'Trochoidal roughing uses Helix or Plunge entry; tabs require Helix',
  'cam.opDesc.edgeRouteOutside.keyPoint.3': 'Finish passes always use a contour',
  'cam.opDesc.edgeRouteOutside.keyPoint.4': 'Regions are supported by contour routing only',

  // Surface clean
  'cam.opDesc.surfaceClean.title': 'Surface clean',
  'cam.opDesc.surfaceClean.fullDescription': 'The surface clean operation machines the flat top surface of one or more add/model features in the area around any taller add features that sit on top of them. It produces a band of cleanup passes at each step height — useful for finishing pads, terraces, and stepped surfaces. Pattern can be offset or parallel.',
  'cam.opDesc.surfaceClean.keyPoint.0': 'Requires one or more closed add or model features',
  'cam.opDesc.surfaceClean.keyPoint.1': 'Clears the area between taller features at each step height',
  'cam.opDesc.surfaceClean.keyPoint.2': 'Offset or parallel clearing pattern',
  'cam.opDesc.surfaceClean.keyPoint.3': 'Supports rough and finish passes',
  'cam.opDesc.surfaceClean.keyPoint.4': 'Optional closed regions act as XY filters',

  // Engrave
  'cam.opDesc.followLine.title': 'Engrave',
  'cam.opDesc.followLine.fullDescription': 'The engrave operation traces along any sketch path — open or closed — at a fixed carve depth. Direct follows the centerline for text, decorative lines, alignment marks, and following complex curves on the stock surface. Trochoidal cuts a wider channel with overlapping orbits, for functional slots (T-track, inlay, dado, wire routing) where the groove is meant to be wider than the cutter.',
  'cam.opDesc.followLine.keyPoint.0': 'Accepts open or closed path features',
  'cam.opDesc.followLine.keyPoint.1': 'Direct follows the centerline; Trochoidal cuts a wider slot',
  'cam.opDesc.followLine.keyPoint.2': 'Single-pass operation (no rough/finish split)',
  'cam.opDesc.followLine.keyPoint.3': 'Typically shallow; stepdown applies if carve depth exceeds it',
  'cam.opDesc.followLine.keyPoint.4': 'Optional closed regions act as XY filters',

  // Drilling
  'cam.opDesc.drilling.title': 'Drill',
  'cam.opDesc.drilling.fullDescription': 'The drilling operation produces a hole at the center of each selected circle feature using a canned drill cycle. Choose the drilling method (simple G81, peck G83, dwell G82, chip-breaking G73) and depth on the operation.',
  'cam.opDesc.drilling.keyPoint.0': 'Requires one or more circle features',
  'cam.opDesc.drilling.keyPoint.1': 'Four cycle types: simple (G81), peck (G83), dwell (G82), chip-breaking (G73)',
  'cam.opDesc.drilling.keyPoint.2': 'Peck and chip-breaking cycles use a peck increment',
  'cam.opDesc.drilling.keyPoint.3': 'Fast for repeated hole patterns',
  'cam.opDesc.drilling.keyPoint.4': 'Optional closed regions filter which holes are drilled',

  // 3D Surface rough
  'cam.opDesc.roughSurface.title': '3D surface rough',
  'cam.opDesc.roughSurface.fullDescription': 'The rough surface operation slices the imported 3D model at constant Z levels (waterline-style) and clears each level with offset passes, leaving radial and axial stock for finishing. Use larger stepdown and stepover for speed; follow with a finish operation for accuracy.',
  'cam.opDesc.roughSurface.keyPoint.0': 'Requires an imported 3D model',
  'cam.opDesc.roughSurface.keyPoint.1': 'Waterline-style level slicing with offset clearing per level',
  'cam.opDesc.roughSurface.keyPoint.2': 'Honors radial and axial stock-to-leave for the finish pass',
  'cam.opDesc.roughSurface.keyPoint.3': 'Single-pass operation (no rough/finish split — this op is roughing)',
  'cam.opDesc.roughSurface.keyPoint.4': 'Optional closed regions act as XY filters',

  // 3D Surface finish
  'cam.opDesc.finishSurface.title': '3D surface finish',
  'cam.opDesc.finishSurface.fullDescription': 'The finish surface operation produces the final surface on an imported 3D model. Choose parallel (scanlines at a configurable angle) for shallower geometry, constant scallop (passes spaced evenly along the surface itself) for sculpted and carved tops, or waterline (constant-Z contours) for steeper walls. Use a small stepover for parallel and constant scallop, or a small stepdown for waterline.',
  'cam.opDesc.finishSurface.keyPoint.0': 'Requires an imported 3D model',
  'cam.opDesc.finishSurface.keyPoint.1': 'Parallel (scanline) or waterline (constant-Z) pattern',
  'cam.opDesc.finishSurface.keyPoint.2': 'Single-pass operation (no rough/finish split — this op is the finish)',
  'cam.opDesc.finishSurface.keyPoint.3': 'Usually follows 3D surface rough',
  'cam.opDesc.finishSurface.keyPoint.4': 'Optional closed regions act as XY filters',

  // 3D Surface cleanup
  'cam.opDesc.finishSurfaceCleanup.title': '3D surface cleanup',
  'cam.opDesc.finishSurfaceCleanup.fullDescription': 'The surface cleanup operation emits finish-only wall and floor passes at the deepest retained Z of each step left by the 3D rough operation. It deduplicates repeated wall/floor columns across levels so each is cut once at its lowest effective depth — cleaning up rough-surface terraces without re-roughing.',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.0': 'Requires an imported 3D model',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.1': 'Independent finish walls and finish floor toggles',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.2': 'Offset or parallel pattern for floors',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.3': 'Typically run after 3D surface rough as the final pass',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.4': 'Optional closed regions act as XY filters',
  // ── Library import dialog ──
  'cam.tools.dialogTitle': 'Import tools from library',
  'cam.tools.searchPlaceholder': 'Search by name or diameter…',
  'cam.tools.searchAria': 'Search library tools',
  'cam.tools.inProject': 'In project',
  'cam.tools.new': 'New',
  'cam.tools.selectedCount.one': '1 tool selected',
  'cam.tools.selectedCount.other': '{count} tools selected',
  'cam.tools.importAction.one': 'Import tool',
  'cam.tools.importAction.other': 'Import {count} tools',
  'cam.tools.loadingDialog': 'Loading tool library…',
  'cam.tools.retry': 'Retry',
  'cam.tools.noMatch': 'No library tools match the current filters.',
  'cam.tools.clearFilters': 'Clear filters',
  'cam.tools.allImported': 'All matching library tools are already in the project.',
  'cam.tools.noImportable': 'The selected tools are already in the project.',
  'cam.tools.close': 'Close',
  'cam.tools.fluteCount.one': '{count} flute',
  'cam.tools.fluteCount.other': '{count} flutes',
  'cam.tools.maxCutDepthPrefix': 'max',
} as const satisfies Record<string, string>
