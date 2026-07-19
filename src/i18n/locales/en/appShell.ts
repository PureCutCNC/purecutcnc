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
 * App-shell chrome namespace: workspace tabs, layout presets, status-bar
 * visibility toggles, tablet-specific drawers and overlays, the tablet
 * ToolRail, and the toolpath-visibility panel.
 *
 * Keys are permanent identifiers: renaming one orphans it in every custom
 * language pack, so treat renames as breaking and only do them deliberately.
 */
export const appShellEn = {
  // ── Workspace tabs ──
  'appShell.workspace.sketch': 'Sketch',
  'appShell.workspace.3d': '3D View',
  'appShell.workspace.simulation': 'Simulation',
  'appShell.workspace.tabList': 'Workspace Views',

  // ── Workspace layout presets ──
  'appShell.layout.lcr': 'Show left, center, and right panels',
  'appShell.layout.lc': 'Show left and center panels',
  'appShell.layout.c': 'Show center panel only',
  'appShell.layout.cr': 'Show center and right panels',
  'appShell.layout.presets': 'Workspace layout presets',

  // ── Right sidebar ──
  'appShell.sidebar.operations': 'Operations',
  'appShell.sidebar.tools': 'Tools',
  'appShell.sidebar.tabList': 'Right Sidebar',
  'appShell.sidebar.openOperations': 'Open operations panel',
  'appShell.sidebar.closeOperations': 'Close operations panel',

  // ── Panels ──
  'appShell.panel.projectTree': 'Project Tree',
  'appShell.panel.properties': 'Properties',
  'appShell.panel.expandProperties': 'Expand properties panel',
  'appShell.panel.closeProject': 'Close project panel',
  'appShell.panel.cam': 'CAM panel',
  'appShell.panel.close': 'Close',

  // ── Drawer (tablet) ──
  'appShell.drawer.tools': 'Tools',
  'appShell.drawer.creationTools': 'Creation tools',

  // ── Status bar — stock dimensions ──
  'appShell.status.stockDim': 'Stock: {width} × {height} × {thickness} {units}',

  // ── Status bar — expand/collapse ──
  'appShell.status.expand': 'Expand status bar',
  'appShell.status.collapse': 'Collapse status bar',

  // ── Status bar — visibility section label ──
  'appShell.status.viewVisibility': 'View visibility',

  // ── Status bar — feature labels ──
  'appShell.status.featureLabels': 'Feature labels',
  'appShell.status.showFeatureLabels': 'Show feature labels',
  'appShell.status.hideFeatureLabels': 'Hide feature labels',

  // ── Status bar — grid ──
  'appShell.status.grid': 'Grid',
  'appShell.status.showGrid': 'Show grid',
  'appShell.status.hideGrid': 'Hide grid',

  // ── Status bar — stock ──
  'appShell.status.stock': 'Stock',
  'appShell.status.showStock': 'Show stock',
  'appShell.status.hideStock': 'Hide stock',

  // ── Status bar — backdrop ──
  'appShell.status.backdrop': 'Backdrop',
  'appShell.status.noBackdrop': 'No backdrop loaded',
  'appShell.status.showBackdrop': 'Show backdrop',
  'appShell.status.hideBackdrop': 'Hide backdrop',

  // ── Status bar — origin ──
  'appShell.status.origin': 'Origin',
  'appShell.status.showOrigin': 'Show origin',
  'appShell.status.hideOrigin': 'Hide origin',

  // ── Status bar — regions ──
  'appShell.status.regions': 'Regions',
  'appShell.status.noRegions': 'No regions in project',
  'appShell.status.showRegions': 'Show regions',
  'appShell.status.hideRegions': 'Hide regions',

  // ── Status bar — construction ──
  'appShell.status.construction': 'Construction',
  'appShell.status.noConstruction': 'No construction geometry in project',
  'appShell.status.showConstruction': 'Show construction geometry',
  'appShell.status.hideConstruction': 'Hide construction geometry',

  // ── Status bar — tabs ──
  'appShell.status.tabs': 'Tabs',
  'appShell.status.noTabs': 'No tabs in project',
  'appShell.status.showTabs': 'Show tabs',
  'appShell.status.hideTabs': 'Hide tabs',

  // ── Status bar — clamps ──
  'appShell.status.clamps': 'Clamps',
  'appShell.status.noClamps': 'No clamps in project',
  'appShell.status.showClamps': 'Show clamps',
  'appShell.status.hideClamps': 'Hide clamps',

  // ── Status bar — about ──
  'appShell.status.about': 'About PureCutCNC',
  'appShell.status.shellMode': 'Shell mode (dev only)',

  // ── Tablet ──
  'appShell.tablet.rotatePrompt': 'Please rotate your device to landscape mode',

  // ── Empty states ──
  'appShell.empty.camPanel': 'CAM operations and toolpaths are scheduled for Phase 4.',

  // ── Toolpath visibility ──
  'appShell.toolpath.show': 'Show',
  'appShell.toolpath.cuts': 'Cuts',
  'appShell.toolpath.rapids': 'Rapids',
  'appShell.toolpath.plunges': 'Plunges',
  'appShell.toolpath.retractions': 'Retractions',
  'appShell.toolpath.directions': 'Directions',

  // ── ToolRail ──
  'appShell.toolRail.shapes': 'Shapes',
  'appShell.toolRail.align': 'Align',
  'appShell.toolRail.distribute': 'Distribute',
  'appShell.toolRail.copy': 'Copy',
  'appShell.toolRail.move': 'Move',
  'appShell.toolRail.delete': 'Delete',
  'appShell.toolRail.resize': 'Resize',
  'appShell.toolRail.rotate': 'Rotate',
  'appShell.toolRail.mirror': 'Mirror',
  'appShell.toolRail.offset': 'Offset',
  'appShell.toolRail.constraint': 'Constraint',
  'appShell.toolRail.join': 'Join',
  'appShell.toolRail.cut': 'Cut',
  'appShell.toolRail.addPoint': 'Add point',
  'appShell.toolRail.deletePoint': 'Delete point',
  'appShell.toolRail.deleteSegment': 'Delete segment',
  'appShell.toolRail.disconnect': 'Disconnect',
  'appShell.toolRail.fillet': 'Fillet',
  'appShell.toolRail.trim': 'Trim',
  'appShell.toolRail.extend': 'Extend',
} as const satisfies Record<string, string>
