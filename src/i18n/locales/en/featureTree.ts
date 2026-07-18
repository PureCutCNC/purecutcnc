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
 * Feature-tree namespace: tree section/row labels, empty states, TreeRow
 * component tooltips/badges, operation names and descriptions, the properties
 * panel, the feature context menu, and the Z-range slider.
 *
 * Keys are permanent identifiers: renaming one orphans it in every custom
 * language pack, so treat renames as breaking and only do them deliberately.
 */
export const featureTreeEn = {
  // ── Tree section labels ──
  'featureTree.tree.project': 'Project',
  'featureTree.tree.grid': 'Grid',
  'featureTree.tree.stock': 'Stock',
  'featureTree.tree.origin': 'Origin',
  'featureTree.tree.backdrop': 'Backdrop',
  'featureTree.tree.features': 'Features',
  'featureTree.tree.regions': 'Regions',
  'featureTree.tree.construction': 'Construction',
  'featureTree.tree.tabs': 'Tabs',
  'featureTree.tree.clamps': 'Clamps',

  // ── Tree branch abbreviations ──
  'featureTree.tree.branch.project': 'proj',
  'featureTree.tree.branch.grid': 'grid',
  'featureTree.tree.branch.stock': 'root',
  'featureTree.tree.branch.origin': 'orig',
  'featureTree.tree.branch.backdrop': 'back',
  'featureTree.tree.branch.features': 'feat',
  'featureTree.tree.branch.regions': 'regn',
  'featureTree.tree.branch.construction': 'cnst',
  'featureTree.tree.branch.tabs': 'root',
  'featureTree.tree.branch.clamps': 'clmp',
  'featureTree.tree.branch.tab': 'node',
  'featureTree.tree.branch.clamp': 'node',
  'featureTree.tree.branch.feature': 'node',

  // ── Tree empty states ──
  'featureTree.tree.empty.features': 'No feature nodes yet.',
  'featureTree.tree.empty.regions': 'No regions yet.',
  'featureTree.tree.empty.construction': 'No construction geometry yet.',
  'featureTree.tree.empty.tabs': 'No tabs yet.',
  'featureTree.tree.empty.clamps': 'No clamps yet.',
  'featureTree.tree.empty.folder': 'Empty folder.',

  // ── Tree warning ──
  'featureTree.tree.warning.firstFeaturePrefix': '⚠ First 2.5D feature must be ',
  'featureTree.tree.warning.firstFeatureSuffix': '. The 3D model will not build until this is fixed.',

  // ── TreeRow: folder chevron ──
  'featureTree.treeRow.folder.expand': 'Expand folder',
  'featureTree.treeRow.folder.collapse': 'Collapse folder',

  // ── TreeRow: drag grip ──
  'featureTree.treeRow.grip.dragToReorder': 'Drag to reorder',

  // ── TreeRow: region badge ──
  'featureTree.treeRow.badge.region.include': 'include',
  'featureTree.treeRow.badge.region.exclude': 'exclude',
  'featureTree.treeRow.badge.region.includeTooltip': 'Include region — adds this area to the active region mask.',
  'featureTree.treeRow.badge.region.excludeTooltip': 'Exclude region — subtracts this area from the active region mask.',

  // ── TreeRow: construction badge ──
  'featureTree.treeRow.badge.construction.label': 'ref',
  'featureTree.treeRow.badge.construction.tooltip': 'Construction — sketch reference geometry. Snap, mirror, and dimension against it; never machined.',

  // ── TreeRow: linked-instance badge ──
  'featureTree.treeRow.badge.linked': 'Linked — {count} instances share this definition',

  // ── TreeRow: show / hide all ──
  'featureTree.treeRow.showAll.features': 'Show all features',
  'featureTree.treeRow.showAll.regions': 'Show all regions',
  'featureTree.treeRow.showAll.construction': 'Show all construction geometry',
  'featureTree.treeRow.showAll.tabs': 'Show all tabs',
  'featureTree.treeRow.showAll.clamps': 'Show all clamps',
  'featureTree.treeRow.hideAll.features': 'Hide all features',
  'featureTree.treeRow.hideAll.regions': 'Hide all regions',
  'featureTree.treeRow.hideAll.construction': 'Hide all construction geometry',
  'featureTree.treeRow.hideAll.tabs': 'Hide all tabs',
  'featureTree.treeRow.hideAll.clamps': 'Hide all clamps',

  // ── TreeRow: add folder ──
  'featureTree.treeRow.addFolder.default': 'Add folder',
  'featureTree.treeRow.addFolder.regions': 'Add region folder',
  'featureTree.treeRow.addFolder.construction': 'Add construction folder',

  // ── TreeRow: add entry (tab / clamp) ──
  'featureTree.treeRow.addEntry.tab': 'Add tab',
  'featureTree.treeRow.addEntry.clamp': 'Add clamp',

  // ── TreeRow: operation button tooltips ──
  'featureTree.treeRow.operation.lineClosedTooltip': 'Line — closed path usable by engrave, profile, and V-carve operations',
  'featureTree.treeRow.operation.lineOpenTooltip': 'Line — open profile (Line ↔ Construction only)',
  'featureTree.treeRow.operation.modelTooltip': 'Model — imported 3D object (locked)',
  'featureTree.treeRow.operation.addFirstSolidTooltip': 'Add — first solid (Subtract unavailable; convert to a non-solid role to unlock)',
  'featureTree.treeRow.operation.addTooltip': 'Feature adds material',
  'featureTree.treeRow.operation.subtractTooltip': 'Feature subtracts material',
  'featureTree.treeRow.operation.constructionTooltip': 'Construction — sketch reference geometry (never machined)',
  'featureTree.treeRow.operation.regionTooltip': 'Region — limits where operations may cut (not machined)',
  'featureTree.treeRow.operation.modelLockedAria': 'Model — operation locked',
  'featureTree.treeRow.operation.changeAria': 'Change operation',

  // ── TreeRow: operation menu item labels ──
  'featureTree.operation.add': 'Add',
  'featureTree.operation.subtract': 'Subtract',
  'featureTree.operation.line': 'Line',
  'featureTree.operation.region': 'Region mask',
  'featureTree.operation.construction': 'Construction',

  // ── TreeRow: operation menu item tooltips ──
  'featureTree.treeRow.operation.menuLineOpenTooltip': 'Line — open path machined by engrave operations',
  'featureTree.treeRow.operation.menuAddTooltip': 'Add — feature adds material',
  'featureTree.treeRow.operation.menuSubtractTooltip': 'Subtract — feature removes material',
  'featureTree.treeRow.operation.menuSubtractDisabledTooltip': 'Subtract unavailable — the first solid must be Add or converted to a non-solid role',
  'featureTree.treeRow.operation.menuLineClosedTooltip': 'Line — closed path machined by engrave/contour operations',
  'featureTree.treeRow.operation.menuRegionTooltip': 'Region mask — feature filters machining operations',
  'featureTree.treeRow.operation.menuConstructionTooltip': 'Construction — sketch reference geometry, never machined',

  // ── TreeRow: other buttons ──
  'featureTree.treeRow.selectAllInFolder': 'Select all features in folder',
  'featureTree.treeRow.group': 'Group features',
  'featureTree.treeRow.ungroup': 'Ungroup features',
  'featureTree.treeRow.editSketch': 'Edit sketch',
  'featureTree.treeRow.moreActions': 'More actions',
  'featureTree.treeRow.hideEntry': 'Hide entry',
  'featureTree.treeRow.showEntry': 'Show entry',

  // ── Properties: common field labels ──
  'featureTree.properties.name': 'Name',
  'featureTree.properties.units': 'Units',
  'featureTree.properties.width': 'Width',
  'featureTree.properties.height': 'Height',
  'featureTree.properties.thickness': 'Thickness',
  'featureTree.properties.color': 'Color',
  'featureTree.properties.visible': 'Visible',
  'featureTree.properties.locked': 'Locked',
  'featureTree.properties.z': 'Z',
  'featureTree.properties.zTop': 'Z Top',
  'featureTree.properties.zBottom': 'Z Bottom',
  'featureTree.properties.zRange': 'Z Range',
  'featureTree.properties.image': 'Image',
  'featureTree.properties.opacity': 'Opacity',
  'featureTree.properties.angle': 'Angle',
  'featureTree.properties.folder': 'Folder',
  'featureTree.properties.folders': 'Folders',
  'featureTree.properties.features': 'Features',
  'featureTree.properties.clamps': 'Clamps',
  'featureTree.properties.tabs': 'Tabs',
  'featureTree.properties.operation': 'Operation',
  'featureTree.properties.selection': 'Selection',
  'featureTree.properties.editSketch': 'Edit Sketch',
  'featureTree.properties.text': 'Text',
  'featureTree.properties.style': 'Style',
  'featureTree.properties.font': 'Font',
  'featureTree.properties.sourceFeature': 'Source Feature',
  'featureTree.properties.expanded': 'Expanded',

  // ── Properties: project-specific ──
  'featureTree.properties.safeZ': 'Safe Z',
  'featureTree.properties.opClearZ': 'Op Clear Z',
  'featureTree.properties.clampClearXY': 'Clamp Clear XY',
  'featureTree.properties.clampClearZ': 'Clamp Clear Z',
  'featureTree.properties.machine': 'Machine',
  'featureTree.properties.gridExtent': 'Grid Extent',
  'featureTree.properties.majorLines': 'Major Lines',
  'featureTree.properties.minorLines': 'Minor Lines',
  'featureTree.properties.snapIncrement': 'Snap Increment',
  'featureTree.properties.showFeatureInfo': 'Show feature info in sketch',

  // ── Properties: units ──
  'featureTree.properties.units.mm': 'Millimeters',
  'featureTree.properties.units.inch': 'Inches',

  // ── Properties: machine ──
  'featureTree.properties.machine.none': 'None',
  'featureTree.properties.machine.refresh': 'Refresh machine definitions',
  'featureTree.properties.machine.manage': 'Manage machines…',
  'featureTree.properties.machine.builtin': 'Built-in',
  'featureTree.properties.machine.custom': 'Custom',
  'featureTree.properties.machine.duplicateHint': 'duplicate to edit',

  // ── Properties: origin ──
  'featureTree.properties.origin.placeOrigin': 'Place Origin',
  'featureTree.properties.origin.presets': 'Presets',
  'featureTree.properties.origin.topLeft': 'Top Left',
  'featureTree.properties.origin.centerTop': 'Center Top',
  'featureTree.properties.origin.bottomLeft': 'Bottom Left',

  // ── Properties: stock ──
  'featureTree.properties.stock.editSketch': 'Edit Sketch',
  'featureTree.properties.stock.resetToRect': 'Reset to Rectangle',
  'featureTree.properties.stock.nameDisabled': 'Stock',

  // ── Properties: backdrop ──
  'featureTree.properties.backdrop.noImage': 'No image loaded',
  'featureTree.properties.backdrop.loadImage': 'Load Image',
  'featureTree.properties.backdrop.replaceImage': 'Replace Image',
  'featureTree.properties.backdrop.loading': 'Loading Image…',
  'featureTree.properties.backdrop.move': 'Move',
  'featureTree.properties.backdrop.resize': 'Resize',
  'featureTree.properties.backdrop.rotate': 'Rotate',
  'featureTree.properties.backdrop.delete': 'Delete',
  'featureTree.properties.backdrop.decoding': 'Decoding backdrop image…',
  'featureTree.properties.backdrop.mustBeImage': 'Backdrop must be a PNG or JPEG image.',
  'featureTree.properties.backdrop.readFailed': 'Failed to read backdrop image.',
  'featureTree.properties.backdrop.decodeFailed': 'Failed to decode backdrop image.',

  // ── Properties: single feature ──
  'featureTree.properties.shape': 'Shape',
  'featureTree.properties.shapeShared.one': 'Shape (shared with {count} instance)',
  'featureTree.properties.shapeShared.other': 'Shape (shared with {count} instances)',
  'featureTree.properties.instance': 'Instance',
  'featureTree.properties.expandText': 'Expand Text to Features',
  'featureTree.properties.makeUnique': 'Make Unique',
  'featureTree.properties.deleteFeature': 'Delete Feature',
  'featureTree.properties.deleteSelected': 'Delete Selected',
  'featureTree.properties.editSketchDisabledMulti': 'Disabled for multi-select',

  // ── Properties: multi-select ──
  'featureTree.properties.multi.group': 'Group',
  'featureTree.properties.multi.ungroup': 'Ungroup',
  'featureTree.properties.multi.deleteGroup': 'Delete Group',
  'featureTree.properties.multi.featuresCount': '{count} Features',
  'featureTree.properties.multi.editSketchDisabled': 'Edit Sketch is only available for a single feature',
  'featureTree.properties.multi.openProfiles': 'Open profiles',
  'featureTree.properties.multi.containsModel': 'Contains model features',

  // ── Properties: select values ──
  'featureTree.properties.select.mixedFolders': 'Mixed folders',
  'featureTree.properties.select.root': 'Root',
  'featureTree.properties.select.mixedOperations': 'Mixed operations',
  'featureTree.properties.select.mixedModes': 'Mixed modes',
  'featureTree.properties.select.mixedValues': 'Mixed values',

  // ── Properties: operation select ──
  'featureTree.properties.operation.subtract': 'Subtract',
  'featureTree.properties.operation.add': 'Add',
  'featureTree.properties.operation.line': 'Line',
  'featureTree.properties.operation.region': 'Region mask',
  'featureTree.properties.operation.construction': 'Construction',
  'featureTree.properties.operation.model': 'Model',

  // ── Properties: mask mode ──
  'featureTree.properties.maskMode': 'Mask mode',
  'featureTree.properties.maskMode.include': 'Include',
  'featureTree.properties.maskMode.exclude': 'Exclude',

  // ── Properties: text feature ──
  'featureTree.properties.text.skeleton': 'Skeleton',
  'featureTree.properties.text.outline': 'Outline',

  // ── Properties: Z locked fields ──
  'featureTree.properties.z.notMachined': 'Not machined',
  'featureTree.properties.z.notMachinedTooltip': 'Construction geometry is a sketch reference — it has no machining depth',
  'featureTree.properties.z.followsStock': 'Follows stock ({thickness} to 0)',
  'featureTree.properties.z.followsStockTooltip': 'Regions are vertical filters through the stock; their Z range follows the stock automatically',

  // ── Properties: role notes ──
  'featureTree.properties.regionNote.badge': 'mask',
  'featureTree.properties.regionNote.text': 'A region is a filter: it limits where operations may cut, not a shape to machine.',
  'featureTree.properties.constructionNote.badge': 'ref',
  'featureTree.properties.constructionNote.text': 'Construction geometry is a sketch reference: snap, mirror, and dimension against it. It is never machined.',

  // ── Properties: warnings ──
  'featureTree.properties.warning.selfIntersect': 'This profile self-intersects. 3D/CAM results may be invalid.',
  'featureTree.properties.warning.exceedsStock': 'This profile extends outside the stock boundary.',

  // ── Properties: constraints ──
  'featureTree.properties.constraints.title': 'Constraints',
  'featureTree.properties.constraints.delete': 'Delete constraint',
  'featureTree.properties.constraints.type.intersect': 'intersect',
  'featureTree.properties.constraints.type.perp': 'perp',
  'featureTree.properties.constraints.type.line': 'line',
  'featureTree.properties.constraints.type.midpt': 'midpt',
  'featureTree.properties.constraints.type.center': 'center',
  'featureTree.properties.constraints.type.point': 'point',
  'featureTree.properties.constraints.tooltip.distanceIntersection': 'Distance to intersection',
  'featureTree.properties.constraints.tooltip.perpendicularSegment': 'Perpendicular distance to segment',
  'featureTree.properties.constraints.tooltip.pointOnSegment': 'Distance to point on segment ({percent}%)',
  'featureTree.properties.constraints.tooltip.segmentMidpoint': 'Distance to segment midpoint',
  'featureTree.properties.constraints.tooltip.featureCenter': 'Distance to feature center',
  'featureTree.properties.constraints.tooltip.distanceVertex': 'Distance to vertex',
  'featureTree.properties.constraints.tooltip.invalid': 'Invalid',

  // ── Properties: empty state ──
  'featureTree.properties.empty': 'Select Project, Grid, Stock, or a feature in the tree to edit its properties.',

  // ── Properties: name disabled placeholders ──
  'featureTree.properties.name.grid': 'Grid',
  'featureTree.properties.name.features': 'Features',
  'featureTree.properties.name.clamps': 'Clamps',
  'featureTree.properties.name.tabs': 'Tabs',

  // ── Properties: actions (folder/clamp/tab) ──
  'featureTree.properties.actions.addFolder': 'Add Folder',
  'featureTree.properties.actions.addTab': 'Add Tab',
  'featureTree.properties.actions.addClamp': 'Add Clamp',
  'featureTree.properties.actions.deleteFolder': 'Delete Folder',
  'featureTree.properties.actions.deleteClamp': 'Delete Clamp',
  'featureTree.properties.actions.deleteTab': 'Delete Tab',

  // ── Context menu: top-level items ──
  'featureTree.contextMenu.makeUnique': 'Make Unique',
  'featureTree.contextMenu.selectLinked': 'Select Linked Instances',
  'featureTree.contextMenu.createOperation': 'Create operation',
  'featureTree.contextMenu.editSketch': 'Edit Sketch',
  'featureTree.contextMenu.addConstraint': 'Add Constraint',
  'featureTree.contextMenu.copy': 'Copy',
  'featureTree.contextMenu.copySelected': 'Copy Selected',
  'featureTree.contextMenu.copyGroup': 'Copy Group',
  'featureTree.contextMenu.move': 'Move',
  'featureTree.contextMenu.moveSelected': 'Move Selected',
  'featureTree.contextMenu.moveGroup': 'Move Group',
  'featureTree.contextMenu.resize': 'Resize',
  'featureTree.contextMenu.rotate': 'Rotate',
  'featureTree.contextMenu.mirror': 'Mirror',
  'featureTree.contextMenu.offset': 'Offset',
  'featureTree.contextMenu.addToFolder': 'Add to folder',
  'featureTree.contextMenu.createNewFolder': 'Create new…',
  'featureTree.contextMenu.group': 'Group',
  'featureTree.contextMenu.join': 'Join',
  'featureTree.contextMenu.cut': 'Cut',
  'featureTree.contextMenu.useAsStock': 'Use as Stock',
  'featureTree.contextMenu.delete': 'Delete',
  'featureTree.contextMenu.deleteSelected': 'Delete Selected',
  'featureTree.contextMenu.deleteGroup': 'Delete Group',

  // ── Context menu: tooltips ──
  'featureTree.contextMenu.lockedTooltip': 'Locked features cannot be moved',
  'featureTree.contextMenu.groupDisabledTooltip': 'Select two or more features to group',
  'featureTree.contextMenu.sectionsMixedTooltip': 'Features, regions, and construction geometry only group with their own kind',
  'featureTree.contextMenu.addToFolderMixedTooltip': 'Features, regions, and construction geometry keep separate folders — select one kind',
  'featureTree.contextMenu.joinDisabledTooltip': 'Select two or more features to join',
  'featureTree.contextMenu.useAsStockDisabledTooltip': 'Feature must be an add operation with a closed profile',

  // ── Z-range slider ──
  'featureTree.zRange.zTop': 'Z Top',
  'featureTree.zRange.zBottom': 'Z Bottom',
  'featureTree.zRange.handleTopAria': 'Z Top handle',
  'featureTree.zRange.handleBottomAria': 'Z Bottom handle',
} as const satisfies Record<string, string>
