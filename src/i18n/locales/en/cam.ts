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
  // ── Tool type labels ──
  'cam.toolType.flatEndmill': 'Flat Endmill',
  'cam.toolType.ballEndmill': 'Ball Endmill',
  'cam.toolType.vBit': 'V-Bit',
  'cam.toolType.drill': 'Drill',

  // ── Drill type labels ──
  'cam.drillType.simple': 'Simple (G81)',
  'cam.drillType.peck': 'Peck (G83)',
  'cam.drillType.dwell': 'Dwell (G82)',
  'cam.drillType.chipBreaking': 'Chip breaking (G73)',

  // ── Operation kind labels (full, for the Kind field and operationValidity) ──
  'cam.opLabel.pocket': 'Pocket',
  'cam.opLabel.vCarve': 'V-Carve offset',
  'cam.opLabel.vCarveMedial': 'V-Carve medial',
  'cam.opLabel.edgeRouteInside': 'Edge route inside',
  'cam.opLabel.edgeRouteOutside': 'Edge route outside',
  'cam.opLabel.surfaceClean': 'Surface clean',
  'cam.opLabel.roughSurface': '3D Surface rough',
  'cam.opLabel.finishSurface': '3D Surface finish',
  'cam.opLabel.finishSurfaceCleanup': '3D Surface cleanup',
  'cam.opLabel.followLine': 'Engrave',
  'cam.opLabel.drilling': 'Drill',

  // ── Operation button labels (compact, for the Add menu) ──
  'cam.opButton.pocket': 'Pocket',
  'cam.opButton.vCarve': 'V-Carve offset',
  'cam.opButton.vCarveMedial': 'V-Carve medial',
  'cam.opButton.edgeIn': 'Edge in',
  'cam.opButton.edgeOut': 'Edge out',
  'cam.opButton.surface': 'Surface',
  'cam.opButton.roughSurface': '3D Surface rough',
  'cam.opButton.finishSurface': '3D Surface finish',
  'cam.opButton.finishSurfaceCleanup': '3D Surface cleanup',
  'cam.opButton.engrave': 'Engrave',
  'cam.opButton.drill': 'Drill',

  // ── Quick operation labels ("Create …") ──
  'cam.quickOp.pocket': 'Create Pocket',
  'cam.quickOp.edgeRouteInside': 'Create Inside Route',
  'cam.quickOp.edgeRouteOutside': 'Create Outside Route',
  'cam.quickOp.vCarve': 'Create V-Carve (offset)',
  'cam.quickOp.vCarveMedial': 'Create V-Carve (medial)',
  'cam.quickOp.surfaceClean': 'Create Surface Clean',
  'cam.quickOp.followLine': 'Create Engraving',
  'cam.quickOp.drilling': 'Create Drilling',
  'cam.quickOp.roughSurface': 'Create Rough Surface',
  'cam.quickOp.finishSurface': 'Create Finish Surface',
  'cam.quickOp.finishSurfaceCleanup': 'Create Finish Surface Cleanup',

  // ── Pocket pattern labels ──
  'cam.pocketPattern.offset': 'Offset',
  'cam.pocketPattern.parallel': 'Parallel',
  'cam.pocketPattern.waterline': 'Waterline',

  // ── Pass labels ──
  'cam.pass.rough': 'Rough',
  'cam.pass.finish': 'Finish',

  // ── Panel chrome ──
  'cam.panel.emptyOperation': 'Select an operation to edit its parameters.',
  'cam.panel.emptyTool': 'Select a tool to edit its properties.',
  'cam.panel.operations': 'Operations',
  'cam.panel.tools': 'Tools',
  'cam.panel.operationsEmpty':
    'Select compatible geometry, then add an operation. Pocket and inside route require subtract features. Outside route requires add features. Surface clean accepts add features.',
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
  'cam.panel.expandOperationProps': 'Expand operation properties',
  'cam.panel.expandToolProps': 'Expand tool properties',
  'cam.panel.operationProperties': 'Operation Properties',
  'cam.panel.toolProperties': 'Tool Properties',
  'cam.panel.close': 'Close',

  // ── Operation property labels ──
  'cam.operation.name': 'Name',
  'cam.operation.description': 'Description',
  'cam.operation.kind': 'Kind',
  'cam.operation.pass': 'Pass',
  'cam.operation.maxCarveDepth': 'Max Carve Depth',
  'cam.operation.carveDepth': 'Carve Depth',
  'cam.operation.target': 'Target',
  'cam.operation.targetSource': 'Target Source',
  'cam.operation.useCurrentSelection': 'Use current selection',
  'cam.operation.targetUpdated': '✓ Target updated',
  'cam.operation.restMachining': 'Rest Machining',
  'cam.operation.createRestOp': 'Create rest operation',
  'cam.operation.booklet': 'Booklet',
  'cam.operation.exportPdf': 'Export PDF',
  'cam.operation.exporting': 'Exporting...',
  'cam.operation.toolpathWarnings': 'Toolpath warnings',
  'cam.operation.tool': 'Tool',
  'cam.operation.noTool': 'No Tool',
  'cam.operation.enabled': 'Enabled',
  'cam.operation.stepdown': 'Stepdown',
  'cam.operation.contourSpacing': 'Contour Spacing',
  'cam.operation.stepoverRatio': 'Stepover Ratio',
  'cam.operation.advanced': 'Advanced',
  'cam.operation.pattern': 'Pattern',
  'cam.operation.angle': 'Angle',
  'cam.operation.cutDirection': 'Cut Direction',
  'cam.operation.conventional': 'Conventional',
  'cam.operation.climb': 'Climb',
  'cam.operation.machiningOrder': 'Machining Order',
  'cam.operation.featureFirst': 'Feature first',
  'cam.operation.levelFirst': 'Level first',
  'cam.operation.roundOutsideCorners': 'Round outside corners',
  'cam.operation.drillType': 'Drill Type',
  'cam.operation.peckDepth': 'Peck Depth',
  'cam.operation.dwellTime': 'Dwell Time (s)',
  'cam.operation.retractHeight': 'Retract Height',
  'cam.operation.finishWalls': 'Finish Walls',
  'cam.operation.finishFloor': 'Finish Floor',
  'cam.operation.debugToolpath': 'Debug toolpath',
  'cam.operation.feed': 'Feed',
  'cam.operation.plungeFeed': 'Plunge Feed',
  'cam.operation.slotFeed': 'Slot Feed (%)',
  'cam.operation.slotFeedTooltip':
    "Feed percentage for fully engaged (slotting) cuts: each section's innermost loop, uncleared crossings, the parallel boundary pass, and the first fill line. 100 disables the reduction.",
  'cam.operation.rpm': 'RPM',
  'cam.operation.stockToLeaveRadial': 'Stock To Leave Radial',
  'cam.operation.stockToLeaveAxial': 'Stock To Leave Axial',
  'cam.operation.adaptiveRefinement': 'Adaptive refinement',
  'cam.operation.adaptiveRefinementTooltip':
    'Adds projected waterline rings on shallow slopes and model tips.',
  'cam.operation.adaptiveSpacing': 'Adaptive Spacing',
  'cam.operation.adaptiveSpacingTooltip': 'Projected ring spacing in project units.',
  'cam.operation.maxRingsBand': 'Max Rings / Band',
  'cam.operation.maxRingsTooltip':
    'Maximum projected rings in one band or tip. Use 0 for the default cap.',
  'cam.operation.tabs': 'Tabs',
  'cam.operation.autoPlaceTabs': 'Auto place tabs',

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
  'cam.tool.vAngle': 'V Angle',
  'cam.tool.flutes': 'Flutes',
  'cam.tool.material': 'Material',
  'cam.tool.materialCarbide': 'Carbide',
  'cam.tool.materialHss': 'HSS',
  'cam.tool.defaultRpm': 'Default RPM',
  'cam.tool.defaultFeed': 'Default Feed',
  'cam.tool.plungeFeed': 'Plunge Feed',
  'cam.tool.stepdown': 'Stepdown',
  'cam.tool.maxCutDepth': 'Max Cut Depth',
  'cam.tool.stepoverRatio': 'Stepover Ratio',

  // ── Tool panel chrome ──
  'cam.tools.addTool': 'Add Tool',
  'cam.tools.importFromLibrary': 'Import from Library',
  'cam.tools.loading': 'Loading...',
  'cam.tools.loadingLibrary': 'Loading bundled tool library...',
  'cam.tools.allTypes': 'All Types',
  'cam.tools.allUnits': 'All Units',
  'cam.tools.noFilterMatch': 'No tools match the selected filters.',
  'cam.tools.empty': 'No tools yet. Add the first tool to start building the library.',
  'cam.tools.imported': 'Imported',
  'cam.tools.import': 'Import',
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
  'cam.hint.roughSurfaceNoModel':
    'Rough surface requires at least one imported model feature; closed regions are optional filters',

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
  'cam.restOp.created': 'Created rest operation with {count} region{plural}; choose a smaller tool',
  'cam.restOp.empty': 'No unreachable pocket areas found for this tool',

  // ── Library ──
  'cam.library.failed': 'Failed to load tool library.',

  // ── Parameter reference diagram labels ──
  'cam.paramRef.stepdown': 'Stepdown reference',
  'cam.paramRef.stepover': 'Stepover reference',
  'cam.paramRef.maxDepth': 'Max depth reference',
  'cam.paramRef.retractHeight': 'Retract height reference',
  'cam.paramRef.peckDepth': 'Peck depth reference',
  'cam.paramRef.feed': 'Feed reference',
  'cam.paramRef.plungeFeed': 'Plunge feed reference',
  'cam.paramRef.slotFeed': 'Slot feed reference',
  'cam.paramRef.rpm': 'RPM reference',
  'cam.paramRef.dwell': 'Dwell reference',
  'cam.paramRef.cutDirection': 'Cut direction reference',
  'cam.paramRef.pattern': 'Pattern reference',
  'cam.paramRef.machiningOrder': 'Machining order reference',
  'cam.paramRef.rasterAngle': 'Raster angle reference',
  'cam.paramRef.finishWalls': 'Finish walls reference',
  'cam.paramRef.finishFloor': 'Finish floor reference',
  'cam.paramRef.stockRadial': 'Stock radial reference',
  'cam.paramRef.stockAxial': 'Stock axial reference',
  'cam.paramRef.adaptiveSpacing': 'Adaptive spacing reference',
  'cam.paramRef.adaptiveRefinement': 'Adaptive refinement reference',
  'cam.paramRef.maxRings': 'Max rings reference',
  'cam.paramRef.drillType': 'Drill type reference',

  // ── Operation descriptions (OperationAddMenu expanded cards) ──
  // Pocket
  'cam.opDesc.pocket.title': 'Pocket',
  'cam.opDesc.pocket.fullDescription':
    'Pocket clears the interior of one or more closed subtract profiles down to a fixed Z. Choose between offset (concentric, outside-in) or parallel (scanline) patterns; parallel takes a configurable angle.',
  'cam.opDesc.pocket.keyPoint.0': 'Requires one or more closed subtract profiles',
  'cam.opDesc.pocket.keyPoint.1': 'Offset or parallel clearing pattern',
  'cam.opDesc.pocket.keyPoint.2': 'Supports rough and finish passes',
  'cam.opDesc.pocket.keyPoint.3': 'Best with flat endmills for clean floors',
  'cam.opDesc.pocket.keyPoint.4': 'Optional closed regions act as XY filters',

  // V-Carve offset
  'cam.opDesc.vCarve.title': 'V-Carve Offset',
  'cam.opDesc.vCarve.fullDescription':
    "V-Carve Offset follows progressively narrower inset contours of a closed profile, lowering Z on each pass so the V-bit's angled flank carves a clean V-groove that tapers to the centerline. Depth per pass is derived from contour spacing and the V-bit half-angle.",
  'cam.opDesc.vCarve.keyPoint.0': 'Requires one or more closed subtract profiles',
  'cam.opDesc.vCarve.keyPoint.1': 'Requires a V-bit tool (set the tip angle on the tool first)',
  'cam.opDesc.vCarve.keyPoint.2': 'Single-pass operation (no rough/finish split)',
  'cam.opDesc.vCarve.keyPoint.3': 'Ideal for engraving, signage, and decorative edges',
  'cam.opDesc.vCarve.keyPoint.4': 'Optional closed regions act as XY filters',

  // V-Carve medial
  'cam.opDesc.vCarveMedial.title': 'V-Carve Medial',
  'cam.opDesc.vCarveMedial.fullDescription':
    "V-Carve Medial computes the true medial axis of a closed profile from the Voronoi diagram of its boundary and cuts a V-groove whose depth exactly tracks the local half-width. Sharp corners receive skeleton tips that rise to the surface for crisp points; smooth curves stay clean thanks to geometric filtering. Sampling resolution adjusts automatically to each shape's size.",
  'cam.opDesc.vCarveMedial.keyPoint.0': 'Requires one or more closed subtract profiles',
  'cam.opDesc.vCarveMedial.keyPoint.1': 'Requires a V-bit tool (set the tip angle on the tool first)',
  'cam.opDesc.vCarveMedial.keyPoint.2': 'Exact depth: V flanks touch both walls everywhere along the skeleton',
  'cam.opDesc.vCarveMedial.keyPoint.3': 'Automatic shape-scaled sampling keeps small lettering clean',
  'cam.opDesc.vCarveMedial.keyPoint.4': 'Crisp zero-depth tips in sharp corners; no artifacts on smooth curves',
  'cam.opDesc.vCarveMedial.keyPoint.5': 'Single-pass operation (no rough/finish split)',
  'cam.opDesc.vCarveMedial.keyPoint.6': 'Optional closed regions act as XY filters',

  // Edge route inside
  'cam.opDesc.edgeRouteInside.title': 'Edge Route Inside',
  'cam.opDesc.edgeRouteInside.fullDescription':
    'Edge Route Inside follows the inside edge of one or more closed subtract profiles, offset inward by the tool radius. Useful for slots, hollows, and interior profile cuts where the tool must stay inside the boundary.',
  'cam.opDesc.edgeRouteInside.keyPoint.0': 'Requires one or more closed subtract profiles',
  'cam.opDesc.edgeRouteInside.keyPoint.1': 'Tool path is offset inward by the tool radius',
  'cam.opDesc.edgeRouteInside.keyPoint.2': 'Supports rough and finish passes',
  'cam.opDesc.edgeRouteInside.keyPoint.3': 'Optional closed regions act as XY filters',

  // Edge route outside
  'cam.opDesc.edgeRouteOutside.title': 'Edge Route Outside',
  'cam.opDesc.edgeRouteOutside.fullDescription':
    'Edge Route Outside follows the outside edge of one or more closed add or model profiles, offset outward by the tool radius. Used to profile parts out of stock, leave clean shoulders around raised features, or cut perimeters.',
  'cam.opDesc.edgeRouteOutside.keyPoint.0': 'Requires one or more closed add or model profiles',
  'cam.opDesc.edgeRouteOutside.keyPoint.1': 'Tool path is offset outward by the tool radius',
  'cam.opDesc.edgeRouteOutside.keyPoint.2': 'Supports rough and finish passes',
  'cam.opDesc.edgeRouteOutside.keyPoint.3': 'Optional closed regions act as XY filters',

  // Surface clean
  'cam.opDesc.surfaceClean.title': 'Surface Clean',
  'cam.opDesc.surfaceClean.fullDescription':
    'Surface Clean machines the flat top surface of one or more add/model features in the area around any taller add features that sit on top of them. It produces a band of cleanup passes at each step height — useful for finishing pads, terraces, and stepped surfaces. Pattern can be offset or parallel.',
  'cam.opDesc.surfaceClean.keyPoint.0': 'Requires one or more closed add or model features',
  'cam.opDesc.surfaceClean.keyPoint.1': 'Clears the area between taller features at each step height',
  'cam.opDesc.surfaceClean.keyPoint.2': 'Offset or parallel clearing pattern',
  'cam.opDesc.surfaceClean.keyPoint.3': 'Supports rough and finish passes',
  'cam.opDesc.surfaceClean.keyPoint.4': 'Optional closed regions act as XY filters',

  // Engrave
  'cam.opDesc.followLine.title': 'Engrave',
  'cam.opDesc.followLine.fullDescription':
    'Engrave traces along any sketch path — open or closed — at a fixed carve depth. The tool follows the path centerline; no offset. Good for text, decorative lines, alignment marks, and following complex curves on the stock surface.',
  'cam.opDesc.followLine.keyPoint.0': 'Accepts open or closed path features',
  'cam.opDesc.followLine.keyPoint.1': 'Tool follows the path centerline (no offset)',
  'cam.opDesc.followLine.keyPoint.2': 'Single-pass operation (no rough/finish split)',
  'cam.opDesc.followLine.keyPoint.3': 'Typically shallow; stepdown applies if carve depth exceeds it',
  'cam.opDesc.followLine.keyPoint.4': 'Optional closed regions act as XY filters',

  // Drilling
  'cam.opDesc.drilling.title': 'Drill',
  'cam.opDesc.drilling.fullDescription':
    'Drilling produces a hole at the center of each selected circle feature using a canned drill cycle. Choose the drilling method (simple G81, peck G83, dwell G82, chip-breaking G73) and depth on the operation.',
  'cam.opDesc.drilling.keyPoint.0': 'Requires one or more circle features',
  'cam.opDesc.drilling.keyPoint.1':
    'Four cycle types: simple (G81), peck (G83), dwell (G82), chip-breaking (G73)',
  'cam.opDesc.drilling.keyPoint.2': 'Peck and chip-breaking cycles use a peck increment',
  'cam.opDesc.drilling.keyPoint.3': 'Fast for repeated hole patterns',
  'cam.opDesc.drilling.keyPoint.4': 'Optional closed regions filter which holes are drilled',

  // 3D Surface rough
  'cam.opDesc.roughSurface.title': '3D Surface Rough',
  'cam.opDesc.roughSurface.fullDescription':
    'Rough Surface slices the imported 3D model at constant Z levels (waterline-style) and clears each level with offset passes, leaving radial and axial stock for finishing. Use larger stepdown and stepover for speed; follow with a finish operation for accuracy.',
  'cam.opDesc.roughSurface.keyPoint.0': 'Requires an imported 3D model',
  'cam.opDesc.roughSurface.keyPoint.1': 'Waterline-style level slicing with offset clearing per level',
  'cam.opDesc.roughSurface.keyPoint.2': 'Honors radial and axial stock-to-leave for the finish pass',
  'cam.opDesc.roughSurface.keyPoint.3': 'Single-pass operation (no rough/finish split — this op is roughing)',
  'cam.opDesc.roughSurface.keyPoint.4': 'Optional closed regions act as XY filters',

  // 3D Surface finish
  'cam.opDesc.finishSurface.title': '3D Surface Finish',
  'cam.opDesc.finishSurface.fullDescription':
    'Finish Surface produces the final surface on an imported 3D model. Choose parallel (scanlines at a configurable angle) for shallower geometry or waterline (constant-Z contours) for steeper walls. Use a small stepover for parallel or small stepdown for waterline.',
  'cam.opDesc.finishSurface.keyPoint.0': 'Requires an imported 3D model',
  'cam.opDesc.finishSurface.keyPoint.1': 'Parallel (scanline) or waterline (constant-Z) pattern',
  'cam.opDesc.finishSurface.keyPoint.2': 'Single-pass operation (no rough/finish split — this op is the finish)',
  'cam.opDesc.finishSurface.keyPoint.3': 'Usually follows 3D Surface Rough',
  'cam.opDesc.finishSurface.keyPoint.4': 'Optional closed regions act as XY filters',

  // 3D Surface cleanup
  'cam.opDesc.finishSurfaceCleanup.title': '3D Surface Cleanup',
  'cam.opDesc.finishSurfaceCleanup.fullDescription':
    'Surface Cleanup emits finish-only wall and floor passes at the deepest retained Z of each step left by the 3D rough operation. It deduplicates repeated wall/floor columns across levels so each is cut once at its lowest effective depth — cleaning up rough-surface terraces without re-roughing.',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.0': 'Requires an imported 3D model',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.1': 'Independent Finish Walls and Finish Floor toggles',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.2': 'Offset or parallel pattern for floors',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.3': 'Typically run after 3D Surface Rough as the final pass',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.4': 'Optional closed regions act as XY filters',
} as const satisfies Record<string, string>
