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
 * Sketch-surface namespace: creation shape picker, sketch-editing toolbars,
 * feature transform/edit commands, alignment/distribution, backdrop
 * manipulation, and shared command descriptors.
 *
 * Keys are permanent identifiers: renaming one orphans it in every custom
 * language pack, so treat renames as breaking and only do them deliberately.
 */
export const sketchEn = {
  'sketch.target.createFeatures': 'Create features',
  'sketch.target.createLines': 'Create lines',
  'sketch.target.createRegions': 'Create regions',
  'sketch.target.createConstruction': 'Create construction geometry',
  'sketch.target.feature': 'feature',
  'sketch.target.line': 'line',
  'sketch.target.region': 'region',
  'sketch.target.construction': 'construction',

  'sketch.shape.rectangle': 'rectangle',
  'sketch.shape.circle': 'circle',
  'sketch.shape.ellipse': 'ellipse',
  'sketch.shape.polygon': 'polygon',
  'sketch.shape.spline': 'spline',
  'sketch.shape.composite': 'composite',
  'sketch.shape.text': 'text',
  'sketch.shape.slot': 'slot',
  'sketch.shape.regularPolygon': 'regular polygon',
  'sketch.shape.gear': 'gear',
  'sketch.shape.roundedRect': 'rounded rectangle',
  'sketch.shape.chamferedRect': 'chamfered rectangle',

  'sketch.creation.addShape': 'Add {target} {shape}',
  'sketch.creation.cancel': 'Cancel {shape}',
  'sketch.creation.cancelTool': 'Cancel {shape} tool',
  'sketch.creation.chooseTarget': 'Choose {target} shape',
  'sketch.creation.closeDrawer': 'Close shape drawer',

  'sketch.transform.copy': 'Copy selected features',
  'sketch.transform.cancelCopy': 'Cancel copy',
  'sketch.transform.move': 'Move selected features',
  'sketch.transform.cancelMove': 'Cancel move',
  'sketch.transform.delete': 'Delete selected features',
  'sketch.transform.resize': 'Resize selected features',
  'sketch.transform.cancelResize': 'Cancel resize',
  'sketch.transform.rotate': 'Rotate selected features',
  'sketch.transform.cancelRotate': 'Cancel rotate',
  'sketch.transform.mirror': 'Mirror selected features',
  'sketch.transform.cancelMirror': 'Cancel mirror',

  'sketch.boolean.join': 'Join closed features',
  'sketch.boolean.cancelJoin': 'Cancel join',
  'sketch.boolean.cut': 'Cut features',
  'sketch.boolean.cancelCut': 'Cancel cut',
  'sketch.boolean.offset': 'Create offset feature',
  'sketch.boolean.cancelOffset': 'Cancel offset',

  'sketch.arrange.align': 'Align selected features',
  'sketch.arrange.distribute': 'Distribute selected features',
  'sketch.arrange.closeAlignMenu': 'Close alignment menu',
  'sketch.arrange.closeDistributeMenu': 'Close distribute menu',

  'sketch.edit.addPoint': 'Add point',
  'sketch.edit.cancelAddPoint': 'Cancel add point',
  'sketch.edit.deletePoint': 'Delete point',
  'sketch.edit.cancelDeletePoint': 'Cancel delete point',
  'sketch.edit.deleteSegment': 'Delete segment',
  'sketch.edit.cancelDeleteSegment': 'Cancel delete segment',
  'sketch.edit.disconnect': 'Disconnect point',
  'sketch.edit.cancelDisconnect': 'Cancel disconnect',
  'sketch.edit.fillet': 'Round corner / fillet',
  'sketch.edit.cancelFillet': 'Cancel fillet',
  'sketch.edit.chamfer': 'Chamfer corner',
  'sketch.edit.cancelChamfer': 'Cancel chamfer',
  'sketch.edit.trim': 'Trim to cutting edge',
  'sketch.edit.cancelTrim': 'Cancel trim',
  'sketch.edit.trimDisabled': 'Trim — open profiles only',
  'sketch.edit.extend': 'Extend to target',
  'sketch.edit.cancelExtend': 'Cancel extend',
  'sketch.edit.extendDisabled': 'Extend — open profiles only',

  'sketch.constraint.add': 'Add constraint',
  'sketch.constraint.cancel': 'Cancel constraint',

  'sketch.align.left': 'Align left',
  'sketch.align.centerHorizontal': 'Align center horizontally',
  'sketch.align.right': 'Align right',
  'sketch.align.top': 'Align top',
  'sketch.align.centerVertical': 'Align center vertically',
  'sketch.align.bottom': 'Align bottom',

  'sketch.distribute.horizontalGaps': 'Distribute horizontally (equal gaps)',
  'sketch.distribute.horizontalCenters': 'Distribute horizontally (equal centers)',
  'sketch.distribute.verticalGaps': 'Distribute vertically (equal gaps)',
  'sketch.distribute.verticalCenters': 'Distribute vertically (equal centers)',

  'sketch.backdrop.move': 'Move backdrop',
  'sketch.backdrop.cancelMove': 'Cancel move backdrop',
  'sketch.backdrop.delete': 'Delete backdrop',
  'sketch.backdrop.resize': 'Resize backdrop',
  'sketch.backdrop.cancelResize': 'Cancel resize backdrop',
  'sketch.backdrop.rotate': 'Rotate backdrop',
  'sketch.backdrop.cancelRotate': 'Cancel rotate backdrop',
} as const satisfies Record<string, string>
