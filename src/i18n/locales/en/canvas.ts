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
 * Canvas namespace: sketch-canvas workflow/creation panels, constraint &&
 * driving-dimension panels, gear parameter panel, pickers, badges, context
 * menus, manual entry, and the depth-colour legend.
 *
 * Keys are permanent identifiers: renaming one orphans it in every custom
 * language pack, so treat renames as breaking and only do them deliberately.
 */
export const canvasEn = {
  // ── Creation target badge ──
  'canvas.target.drawingFeatures': 'Drawing features',
  'canvas.target.drawingLines': 'Drawing lines',
  'canvas.target.drawingRegions': 'Drawing regions',
  'canvas.target.drawingConstruction': 'Drawing construction',

  // ── Depth legend ──
  'canvas.legend.heading': 'Feature Colors',
  'canvas.legend.collapseAria': 'Collapse feature color legend',
  'canvas.legend.collapseTitle': 'Collapse legend',
  'canvas.legend.subtract': 'Subtract',
  'canvas.legend.addFeature': 'Add feature',
  'canvas.legend.regionInclude': 'Region include',
  'canvas.legend.regionExclude': 'Region exclude',
  'canvas.legend.importedModel': 'Imported model',
  'canvas.legend.selected': 'Selected',

  // ── Overlap feature picker ──
  'canvas.overlap.title': 'Select feature',
  'canvas.overlap.dialogAria': 'Select feature',
  'canvas.overlap.listAria': 'Overlapping features',
  'canvas.overlap.step.one': '{count} feature overlaps here. Choose one to select.',
  'canvas.overlap.step.other': '{count} features overlap here. Choose one to select.',
  'canvas.overlap.moveLabel': 'Move feature selection controls',
  'canvas.overlap.selectAria': 'Select {name}, {kind}',
  'canvas.overlap.cancel': 'Cancel',
  'canvas.overlap.kind.rect': 'Rectangle',
  'canvas.overlap.kind.circle': 'Circle',
  'canvas.overlap.kind.ellipse': 'Ellipse',
  'canvas.overlap.kind.polygon': 'Polygon',
  'canvas.overlap.kind.spline': 'Spline',
  'canvas.overlap.kind.composite': 'Composite path',
  'canvas.overlap.kind.text': 'Text',
  'canvas.overlap.kind.stl': 'STL model',

  // ── Common button labels ──
  'canvas.common.confirm': 'Confirm',
  'canvas.common.cancel': 'Cancel',
  'canvas.common.apply': 'Apply',
  'canvas.common.done': 'Done',
  'canvas.common.finish': 'Finish',
  'canvas.common.undo': 'Undo',
  'canvas.common.next': 'Next',
  'canvas.common.moveControls': 'Move workflow controls',

  // ── Common field labels ──
  'canvas.field.width': 'Width',
  'canvas.field.height': 'Height',
  'canvas.field.radius': 'Radius',
  'canvas.field.length': 'Length',
  'canvas.field.angle': 'Angle',
  'canvas.field.angleDeg': 'Angle °',
  'canvas.field.distance': 'Distance',
  'canvas.field.diameter': 'Diameter',
  'canvas.field.copies': 'Copies',
  'canvas.field.scale': 'Scale',

  // ── Shape names (title case, for panel titles) ──
  'canvas.shape.rectangle': 'Rectangle',
  'canvas.shape.circle': 'Circle',
  'canvas.shape.ellipse': 'Ellipse',
  'canvas.shape.tab': 'Tab',
  'canvas.shape.clamp': 'Clamp',
  'canvas.shape.polygon': 'Polygon',
  'canvas.shape.spline': 'Spline',
  'canvas.shape.slot': 'Slot',
  'canvas.shape.gear': 'Gear',
  'canvas.shape.roundedRectangle': 'Rounded Rectangle',
  'canvas.shape.chamferedRectangle': 'Chamfered Rectangle',
  'canvas.shape.composite': 'Composite',

  // ── Composite mode labels ──
  'canvas.composite.mode.line': 'Line',
  'canvas.composite.mode.arc': 'Arc',
  'canvas.composite.mode.spline': 'Spline',

  // ── Creation workflow panel ──
  'canvas.creation.step.enterDimensions': 'Enter dimensions',
  'canvas.creation.step.clickFirstPoint': 'Click first point',
  'canvas.creation.step.clickFirstCorner': 'Click first corner',
  'canvas.creation.step.clickCenterPoint': 'Click center point',
  'canvas.creation.step.clickArcCurvature': 'Click arc curvature point',
  'canvas.creation.step.addPoints': 'Add {mode} points',
  'canvas.creation.step.addOneMore': 'Add one more point',
  'canvas.creation.step.addPointsOrClose': 'Add points or close',
  'canvas.creation.step.setRadiusOrDimensions': 'Click to set radius or enter dimensions',
  'canvas.creation.step.setRadiiOrDimensions': 'Click to set radii or enter dimensions',
  'canvas.creation.step.setRadius': 'Click to set radius',
  'canvas.creation.step.setCornerOrDimensions': 'Click opposite corner or enter dimensions',
  'canvas.creation.step.slotFirstEnd': 'Click first end center',
  'canvas.creation.step.slotSecondEnd': 'Click second end center or enter dimensions',
  'canvas.creation.step.slotSetWidth': 'Move cursor to set width, click to commit',
  'canvas.creation.step.gearSetRadius': 'Click to set outside radius or enter radius',
  'canvas.creation.step.gearParams': 'Set gear parameters',
  'canvas.creation.moveLabel': 'Move creation controls',
  'canvas.creation.dimensionsButton': 'Dimensions',
  'canvas.creation.radiusButton': 'Radius',
  'canvas.creation.widthButton': 'Width',
  'canvas.creation.confirmGear': 'Confirm',

  // ── Place Origin / Place Text panels ──
  'canvas.placement.originTitle': 'Place Origin',
  'canvas.placement.textTitle': 'Place Text',
  'canvas.placement.originStep': 'Click the sketch to place machine X0 Y0. Z remains manual in Properties.',
  'canvas.placement.textStep': 'Tap the sketch to place the text.',
  'canvas.placement.cancel': 'Cancel',

  // ── Constraint panel ──
  'canvas.constraint.title': 'Constraint',
  'canvas.constraint.editTitle': 'Edit Constraint',
  'canvas.constraint.step.pickAnchor': 'Pick anchor point',
  'canvas.constraint.step.pickReference': 'Pick reference point',
  'canvas.constraint.step.setDistance': 'Set distance',
  'canvas.constraint.moveLabel': 'Move constraint edit controls',
  'canvas.constraint.apply': 'Apply',
  'canvas.constraint.cancel': 'Cancel',
  'canvas.constraint.confirm': 'Confirm',
  'canvas.constraint.summary.anchor': 'Tap a snap point on this feature.',
  'canvas.constraint.summary.reference': 'Tap a snap point on another feature.',

  // ── Driving dimension panel ──
  'canvas.driving.title.resizeStock': 'Resize Stock',
  'canvas.driving.title.editDimension': 'Edit Dimension',
  'canvas.driving.step.setValue': 'Set value',
  'canvas.driving.moveLabel': 'Move driving edit controls',
  'canvas.driving.flipHeldPoint': 'Flip held point',
  'canvas.driving.apply': 'Apply',
  'canvas.driving.cancel': 'Cancel',
  'canvas.driving.holdingSide': 'Holding {side} side',
  // Display labels for internal HeldSide values
  'canvas.driving.heldSide.left': 'left',
  'canvas.driving.heldSide.right': 'right',
  'canvas.driving.heldSide.top': 'top',
  'canvas.driving.heldSide.bottom': 'bottom',
  'canvas.driving.holdLabel.left': 'Hold left',
  'canvas.driving.holdLabel.right': 'Hold right',
  'canvas.driving.holdLabel.top': 'Hold top',
  'canvas.driving.holdLabel.bottom': 'Hold bottom',
  'canvas.driving.holdLabel.start': 'Hold start',
  'canvas.driving.holdLabel.end': 'Hold end',
  'canvas.driving.holdLabel.firstRay': 'Hold first ray',
  'canvas.driving.holdLabel.secondRay': 'Hold second ray',

  // ── Offset workflow panel ──
  'canvas.offset.title': 'Offset',
  'canvas.offset.step.setDistance': 'Set distance',
  'canvas.offset.step.previewDistance': 'Preview distance',
  'canvas.offset.moveLabel': 'Move offset controls',
  'canvas.offset.confirm': 'Confirm',
  'canvas.offset.distanceButton': 'Distance',
  'canvas.offset.cancel': 'Cancel',
  'canvas.offset.summary': 'Move inside or outside the feature to preview. Click to commit.',

  // ── Join workflow panel ──
  'canvas.join.title': 'Join',
  'canvas.join.step.selectFeatures': 'Select features',
  'canvas.join.moveLabel': 'Move join controls',
  'canvas.join.confirm': 'Confirm',
  'canvas.join.cancel': 'Cancel',
  'canvas.join.keepOriginals': 'Keep originals',
  'canvas.join.summary.tooFew': 'Select at least two closed features.',
  'canvas.join.summary.count.one': '{count} closed feature selected.',
  'canvas.join.summary.count.other': '{count} closed features selected.',

  // ── Cut workflow panel ──
  'canvas.cut.title': 'Cut',
  'canvas.cut.step.selectCutters': 'Select cutters',
  'canvas.cut.step.selectTargets': 'Select targets',
  'canvas.cut.moveLabel': 'Move cut controls',
  'canvas.cut.next': 'Next',
  'canvas.cut.confirm': 'Confirm',
  'canvas.cut.cancel': 'Cancel',
  'canvas.cut.keepOriginals': 'Keep originals',
  'canvas.cut.summary.noCutters': 'Select features to mark cutters.',
  'canvas.cut.summary.cutters.one': '{count} cutter selected.',
  'canvas.cut.summary.cutters.other': '{count} cutters selected.',
  'canvas.cut.summary.cuttersLocked.one': '{count} cutter locked. Select target features.',
  'canvas.cut.summary.cuttersLocked.other': '{count} cutters locked. Select target features.',
  'canvas.cut.summary.targets.one': '{count} target selected.',
  'canvas.cut.summary.targets.other': '{count} targets selected.',

  // ── Move / Copy workflow panel ──
  'canvas.move.title.copy': 'Copy',
  'canvas.move.title.move': 'Move',
  'canvas.move.step.setDistance': 'Set distance',
  'canvas.move.step.selectFrom': 'Select from point',
  'canvas.move.step.selectTarget': 'Select target point',
  'canvas.move.step.setCopyCount': 'Set copy count',
  'canvas.move.moveLabel': 'Move {mode} controls',
  'canvas.move.confirm': 'Confirm',
  'canvas.move.cancel': 'Cancel',
  'canvas.move.summary.selectTarget': 'Select a target point to set the direction and default distance.',

  // ── Transform workflow panel ──
  'canvas.transform.title.resize': 'Resize',
  'canvas.transform.title.mirror': 'Mirror',
  'canvas.transform.title.rotate': 'Rotate',
  'canvas.transform.step.setScale': 'Set scale',
  'canvas.transform.step.setAngle': 'Set angle',
  'canvas.transform.step.setCopyCount': 'Set copy count',
  'canvas.transform.step.selectFirstReference': 'Select first reference',
  'canvas.transform.step.selectSecondReference': 'Select second reference',
  'canvas.transform.step.scaleToCommit': 'Scale to commit',
  'canvas.transform.step.selectFirstLinePoint': 'Select first line point',
  'canvas.transform.step.selectSecondLinePoint': 'Select second line point',
  'canvas.transform.step.selectOrigin': 'Select origin',
  'canvas.transform.step.selectReferenceDirection': 'Select reference direction',
  'canvas.transform.step.rotateToCommit': 'Rotate to commit',
  'canvas.transform.moveLabel': 'Move {mode} controls',
  'canvas.transform.confirm': 'Confirm',
  'canvas.transform.scaleButton': 'Scale',
  'canvas.transform.angleButton': 'Angle',
  'canvas.transform.cancel': 'Cancel',
  'canvas.transform.keepOriginals': 'Keep originals',
  'canvas.transform.summary.resize': 'Move along the reference line to preview, then click to commit.',
  'canvas.transform.summary.mirror': 'Move to preview, then click the second mirror line point.',
  'canvas.transform.summary.rotateCopy': 'Move to preview the rotated copy, then click to set angle.',
  'canvas.transform.summary.rotate': 'Move to preview, then click to commit.',

  // ── Edit workflow panel ──
  'canvas.edit.title': 'Edit',
  'canvas.edit.step.enterDimensions': 'Enter dimensions',
  'canvas.edit.step.enterRadius': 'Enter radius',
  'canvas.edit.step.enterDistance': 'Enter distance',
  'canvas.edit.step.clickToAddPoints': 'Click to add points',
  'canvas.edit.step.clickToDeletePoints': 'Click to delete points',
  'canvas.edit.step.clickToDeleteSegments': 'Click to delete segments',
  'canvas.edit.step.clickAnchorToSplit': 'Click an anchor to split',
  'canvas.edit.step.filletCorner': 'Click a corner',
  'canvas.edit.step.filletSecond': 'Click second point or enter radius',
  'canvas.edit.step.chamferCorner': 'Click a corner',
  'canvas.edit.step.chamferSecond': 'Click second point or enter distance',
  'canvas.edit.step.trimSubject': 'Click the part of the segment to remove',
  'canvas.edit.step.trimReference': 'Click the cutting segment',
  'canvas.edit.step.extendSubject': 'Click near the open end of the segment to extend',
  'canvas.edit.step.extendReference': 'Click the target segment to reach',
  'canvas.edit.step.default': 'Drag nodes or click segments',
  'canvas.edit.apply': 'Apply',
  'canvas.edit.cancel': 'Cancel',
  'canvas.edit.confirm': 'Confirm',
  'canvas.edit.dimensionButton': 'Dimension',
  'canvas.edit.radiusButton': 'Radius',
  'canvas.edit.distanceButton': 'Distance',
  'canvas.edit.warning.selfIntersecting': 'Self-intersecting profile',
  'canvas.edit.warning.exceedsStock': 'Extends outside stock',

  // ── Dimension annotation panels ──
  'canvas.dimension.title.aligned': 'Aligned dimension',
  'canvas.dimension.title.horizontal': 'Horizontal dimension',
  'canvas.dimension.title.vertical': 'Vertical dimension',
  'canvas.dimension.title.radius': 'Radius dimension',
  'canvas.dimension.title.diameter': 'Diameter dimension',
  'canvas.dimension.title.angle': 'Angle dimension',
  'canvas.dimension.step.radiusCenter': 'Click the circle / arc center',
  'canvas.dimension.step.radiusEdge': 'Click a point on the edge',
  'canvas.dimension.step.angleVertex': 'Click the vertex',
  'canvas.dimension.step.angleFirstRay': 'Click the first ray point',
  'canvas.dimension.step.angleSecondRay': 'Click the second ray point',
  'canvas.dimension.step.clickToPlace': 'Click to place',
  'canvas.dimension.step.firstPoint': 'Click the first point',
  'canvas.dimension.step.secondPoint': 'Click the second point',
  'canvas.dimension.step.setOffset': 'Click to set the offset',
  'canvas.dimension.addCancel': 'Cancel',
  'canvas.dimension.addSummary': 'Click points to anchor the dimension to geometry. Esc to cancel.',

  'canvas.dimension.deleteTitle': 'Delete dimension',
  'canvas.dimension.deleteStep': 'Click a dimension to delete',
  'canvas.dimension.deleteDone': 'Done',
  'canvas.dimension.deleteSummary': 'Click each dimension you want to remove. Esc or Done to finish.',

  // ── Tape measure panel ──
  'canvas.tape.title': 'Tape measure',
  'canvas.tape.step.first': 'Click the first point',
  'canvas.tape.step.second': 'Click the second point',
  'canvas.tape.done': 'Done',
  'canvas.tape.summary': 'Snaps to geometry. The measurement stays until your next click — Esc or Done to exit.',

  // ── Paste / clipboard placement panel ──
  'canvas.paste.title': 'Paste features',
  'canvas.paste.step': 'Click in the sketch to place',
  'canvas.paste.cancel': 'Cancel',
  'canvas.paste.summary': 'Move the pointer to preview the paste location.',

  // ── Gear parameter panel ──
  'canvas.gear.summary': 'Outside radius {length}',
  'canvas.gear.toothCount': 'Tooth count',
  'canvas.gear.wholeDepth': 'Whole depth',
  'canvas.gear.flankProfile': 'Tooth flank profile',
  'canvas.gear.pressureAngle': 'Pressure angle',
  'canvas.gear.rootForm': 'Root form',
  'canvas.gear.rootFilletRadius': 'Root fillet radius',
  'canvas.gear.crestForm': 'Crest form',
  'canvas.gear.crestRadius': 'Crest radius',
  'canvas.gear.boreDiameter': 'Bore diameter',
  'canvas.gear.flank.involute': 'Involute',
  'canvas.gear.flank.straight': 'Straight-sided',
  'canvas.gear.root.rounded': 'Rounded root fillet',
  'canvas.gear.root.flat': 'Flat root',
  'canvas.gear.root.sharp': 'Sharp root',
  'canvas.gear.crest.flat': 'Flat crest',
  'canvas.gear.crest.rounded': 'Rounded crest',
  // Gear reference diagram aria-labels
  'canvas.gear.ref.teeth': 'Tooth count reference',
  'canvas.gear.ref.wholeDepth': 'Whole depth reference',
  'canvas.gear.ref.flankProfile': 'Tooth flank profile reference',
  'canvas.gear.ref.pressureAngle': 'Pressure angle reference',
  'canvas.gear.ref.rootForm': 'Root form reference',
  'canvas.gear.ref.rootFilletRadius': 'Root fillet radius reference',
  'canvas.gear.ref.crestForm': 'Crest form reference',
  'canvas.gear.ref.crestRadius': 'Crest radius reference',
  'canvas.gear.ref.boreDiameter': 'Bore diameter reference',

  // ── Creation parameter references ──
  'canvas.param.ngonSides': 'Sides (3-50)',
  'canvas.param.cornerRadius': 'Corner radius',
  'canvas.param.chamfer': 'Chamfer',
  'canvas.param.ref.ngonSides': 'Polygon side count reference',
  'canvas.param.ref.roundRectCorner': 'Rounded rectangle corner radius reference',
  'canvas.param.ref.chamferRectCorner': 'Chamfered rectangle corner reference',

  // ── Warnings ──
  'canvas.warning.selfIntersect': 'This profile self-intersects. 3D/CAM results may be invalid.',
  'canvas.warning.exceedsStock': 'This profile extends outside the stock boundary.',

  // ── Axis lock ──
  'canvas.axisLock.lock': 'Lock',
  'canvas.axisLock.lockX': 'Lock X',
  'canvas.axisLock.lockY': 'Lock Y',
  'canvas.axisLock.cycleAria': 'Click to cycle axis lock (Alt)',
  'canvas.axisLock.multiSelect': 'Multi',
  'canvas.axisLock.multiSelectTitle': 'Toggle multi-select',
  'canvas.axisLock.multiSelectDisabledTitle': 'Multi-select is automatic for Join and Cut',

  // ── Canvas-drawn preview labels ──
  'canvas.preview.pendingRectangle': 'Pending rectangle',
  'canvas.preview.pendingTab': 'Pending tab',
  'canvas.preview.pendingClamp': 'Pending clamp',
  'canvas.preview.pendingEllipse': 'Pending ellipse',
  'canvas.preview.pendingCircle': 'Pending circle',
  'canvas.preview.pendingPolygon': 'Pending polygon',
  'canvas.preview.movePreview': 'Move preview',
  'canvas.preview.copyPreview': 'Copy preview',
  'canvas.preview.pastePreview': 'Paste preview',
  'canvas.preview.resizePreview': 'Resize preview',
  'canvas.preview.rotatePreview': 'Rotate preview',
  'canvas.preview.mirrorPreview': 'Mirror preview',
  'canvas.preview.filletPreview': 'Fillet preview',
  'canvas.preview.chamferPreview': 'Chamfer preview',
  'canvas.preview.offsetInPreview': 'Offset in preview',
  'canvas.preview.offsetOutPreview': 'Offset out preview',
} as const satisfies Record<string, string>
