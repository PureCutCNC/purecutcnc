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
 * App-shell namespace: top command bars (desktop + tablet global toolbar),
 * file/history commands, snap + measure controls, appearance + language
 * menus, the phone-blocker screen, and platform dialog text.
 *
 * Keys are permanent identifiers: renaming one orphans it in every custom
 * language pack, so treat renames as breaking and only do them deliberately.
 */
export const shellEn = {
  'file.newProject': 'New project',
  'file.openProject': 'Open project',
  'file.importGeometry': 'Import geometry',
  'file.exportModel': 'Export model',
  'file.printDesign': 'Print design',
  'file.saveProject': 'Save project',
  'file.saveProjectDirty': 'Save project with unsaved changes',
  'file.undo': 'Undo',
  'file.redo': 'Redo',

  'shell.topBar.openProjectPanel': 'Open project panel',
  'shell.topBar.openOperationsPanel': 'Open operations panel',
  'shell.topBar.operations': 'Operations',
  'shell.topBar.renameProject': 'Rename project',
  'shell.topBar.saved': 'Saved',
  'shell.topBar.unsaved': 'Unsaved',
  'shell.topBar.savedTitle': 'Project is saved',
  'shell.topBar.unsavedTitle': 'Project has unsaved changes',
  'shell.topBar.projectLabel': 'Project',
  'shell.topBar.tabSketch': 'Sketch',
  'shell.topBar.tab3d': '3D',
  'shell.topBar.tabSim': 'Sim',
  'shell.topBar.zoomToModel': 'Zoom to model',
  'shell.topBar.zoomSelected': 'Zoom selected',
  'shell.topBar.cancelZoomSelected': 'Cancel zoom selected',

  'shell.snap.enable': 'Enable snapping',
  'shell.snap.disable': 'Disable snapping',
  'shell.snap.settingsTooltip': 'Snap settings',
  'shell.snap.enabledAria.one': 'Snapping enabled ({count} mode)',
  'shell.snap.enabledAria.other': 'Snapping enabled ({count} modes)',
  'shell.snap.disabledAria': 'Snapping disabled',
  'shell.snap.enabledButton': 'Enabled',
  'shell.snap.disabledButton': 'Disabled',
  'shell.snap.grid': 'Snap to grid',
  'shell.snap.gridShort': 'Grid',
  'shell.snap.point': 'Snap to point',
  'shell.snap.pointShort': 'Point',
  'shell.snap.line': 'Snap to line',
  'shell.snap.lineShort': 'Line',
  'shell.snap.midpoint': 'Snap to midpoint',
  'shell.snap.midpointShort': 'Midpoint',
  'shell.snap.center': 'Snap to center',
  'shell.snap.centerShort': 'Center',
  'shell.snap.intersection': 'Snap to intersection',
  'shell.snap.intersectionShort': 'Intersection',
  'shell.snap.perpendicular': 'Snap perpendicular',
  'shell.snap.perpendicularShort': 'Perpendicular',

  'shell.measure.tooltip': 'Measure & dimensions',
  'shell.measure.aria': 'Measure and dimensions',
  'shell.measure.tapeMeasure': 'Tape measure',
  'shell.measure.tapeMeasureOn': 'Tape measure (on)',
  'shell.measure.stopTapeMeasure': 'Stop tape measure',
  'shell.measure.addDimension': 'Add dimension',
  'shell.measure.closeDimensionMenu': 'Close dimension menu',
  'shell.measure.cancelDimension': 'Cancel {dimension}',
  'shell.measure.dimAligned': 'Aligned dimension',
  'shell.measure.dimHorizontal': 'Horizontal dimension',
  'shell.measure.dimVertical': 'Vertical dimension',
  'shell.measure.dimRadius': 'Radius dimension',
  'shell.measure.dimDiameter': 'Diameter dimension',
  'shell.measure.dimAngle': 'Angle dimension',
  'shell.measure.deleteDimension': 'Delete dimension',
  'shell.measure.deleteDimensionArmed': 'Delete dimension (click one)',
  'shell.measure.deleteDimensionClickOne': 'Click a dimension to delete',
  'shell.measure.showHideDimensions': 'Show/hide dimensions',
  'shell.measure.showOrHideAria': 'Show or hide dimensions',
  'shell.measure.showDimensionsCount.one': 'Show dimensions ({count})',
  'shell.measure.showDimensionsCount.other': 'Show dimensions ({count})',
  'shell.measure.hideDimensionsCount.one': 'Hide dimensions ({count})',
  'shell.measure.hideDimensionsCount.other': 'Hide dimensions ({count})',

  'appearance.tooltip': 'Appearance',
  'appearance.heading': 'Appearance',
  'appearance.menuAria': 'Appearance theme',
  'appearance.current': 'Appearance: {name}',
  'appearance.darkLabel': 'Dark',
  'appearance.darkDetail': 'Low-light workshop',
  'appearance.lightLabel': 'Light',
  'appearance.lightDetail': 'Drafting paper',
  'appearance.systemLabel': 'System',
  'appearance.systemDetail': 'Match this device',
  'appearance.customThemesHeading': 'Custom themes',
  'appearance.darkFamily': 'Dark family',
  'appearance.lightFamily': 'Light family',
  'appearance.manageThemes': 'Manage themes…',
  'appearance.manageThemesDetail': 'Create, edit, import, export',

  'language.tooltip': 'Language',
  'language.heading': 'Language',
  'language.menuAria': 'Interface language',
  'language.current': 'Language: {name}',
  'language.customHeading': 'Custom languages',

  'mobileBlocker.eyebrow': 'Desktop Browser Only',
  'mobileBlocker.title': 'PureCutCNC is not supported on phones.',
  'mobileBlocker.body': 'The browser app is designed for a desktop-sized workspace and does not behave well on phone screens. Use a desktop browser or install a desktop build for macOS, Windows, or Linux.',
  'mobileBlocker.downloads': 'Desktop Downloads',
  'mobileBlocker.website': 'Project Website',

  'platform.confirmDiscard': 'You have unsaved changes. Discard them and continue?',
  'platform.readProjectFailed': 'Failed to read project file.',
  'platform.openProjectFailed': 'Failed to open project file.',
  'platform.readFileError': 'Failed to read "{name}". The file may be too large or inaccessible.',
} as const satisfies Record<string, string>
