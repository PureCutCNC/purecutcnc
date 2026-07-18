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
 * Dialogs namespace: project dialogs (new/import/text-tool/unit-conversion/examples),
 * export dialogs (G-code/model/print), and machine definition editor/manager.
 *
 * Keys are permanent identifiers: renaming one orphans it in every custom
 * language pack, so treat renames as breaking and only do them deliberately.
 */
export const dialogsEn = {
  // ── Common dialog strings ──
  'dialogs.common.close': 'Close',
  'dialogs.common.cancel': 'Cancel',
  'dialogs.common.none': 'None',
  'dialogs.common.millimeter': 'Millimeter',
  'dialogs.common.inch': 'Inch',

  // ── New Project dialog ──
  'dialogs.newProject.title': 'New Project',
  'dialogs.newProject.projectName': 'Project Name',
  'dialogs.newProject.template': 'Template',
  'dialogs.newProject.templateBlankMetric': 'Blank Metric',
  'dialogs.newProject.templateBlankMetricMeta': 'Empty project in millimeters.',
  'dialogs.newProject.templateBlankImperial': 'Blank Imperial',
  'dialogs.newProject.templateBlankImperialMeta': 'Empty project in inches.',
  'dialogs.newProject.templateCurrentProject': 'Current Project',
  'dialogs.newProject.templateCurrentProjectMeta': 'Use the open project settings as a starting template.',
  'dialogs.newProject.templateFile': 'Template File',
  'dialogs.newProject.templateFileNoFile': 'No template file loaded.',
  'dialogs.newProject.templateFileParseError': 'Failed to parse template project file.',
  'dialogs.newProject.templatePreview': 'Template Preview',
  'dialogs.newProject.previewUnits': 'Units',
  'dialogs.newProject.previewStock': 'Stock',
  'dialogs.newProject.previewFeatures': 'Features',
  'dialogs.newProject.previewTools': 'Tools',
  'dialogs.newProject.previewOperations': 'Operations',
  'dialogs.newProject.previewMachine': 'Machine',
  'dialogs.newProject.previewEmpty': 'Load a project file to use it as a template.',
  'dialogs.newProject.orOpenExample': 'Or open an example',
  'dialogs.newProject.createProject': 'Create Project',

  // ── New Project: template labels (preview title) ──
  'dialogs.newProject.templateLabel.blankMetric': 'Blank Metric',
  'dialogs.newProject.templateLabel.blankImperial': 'Blank Imperial',
  'dialogs.newProject.templateLabel.currentProject': 'Current Project Setup: {name}',
  'dialogs.newProject.templateLabel.fileSetup': 'Template File Setup: {name}',
  'dialogs.newProject.templateLabel.fileSetupFallback': 'Template File Setup',
  'dialogs.newProject.templateFileMetaSettings': '{name} (settings only)',

  // ── Import Geometry dialog ──
  'dialogs.importGeometry.title': 'Import Geometry',
  'dialogs.importGeometry.sourceFile': 'Source File',
  'dialogs.importGeometry.chooseFile': 'Choose SVG, DXF, STL, OBJ, or .camj',
  'dialogs.importGeometry.chooseDifferentFile': 'Choose Different File',
  'dialogs.importGeometry.noFileSelected': 'No file selected.',
  'dialogs.importGeometry.settings': 'Settings',
  'dialogs.importGeometry.format': 'Format',
  'dialogs.importGeometry.sourceUnits': 'Source Units',
  'dialogs.importGeometry.selectUnits': 'Select units',
  'dialogs.importGeometry.unitsNotDetected': 'Units not detected — choose the source units before importing.',
  'dialogs.importGeometry.camjImportNote': 'Backdrop, grid, machine definitions, and global constraints are not imported.',
  'dialogs.importGeometry.importStock': 'Import stock from source',
  'dialogs.importGeometry.stockWillBeReplaced': 'Current stock and origin will be replaced.',
  'dialogs.importGeometry.projectUnits': 'Project Units',
  'dialogs.importGeometry.axisOrientation': 'Axis Orientation',
  'dialogs.importGeometry.axisOriginal': 'Original (Z-Up)',
  'dialogs.importGeometry.axisSwapYZ': 'Swap Y / Z (Y-Up)',
  'dialogs.importGeometry.axisSwapXZ': 'Swap X / Z',
  'dialogs.importGeometry.axisSwapXY': 'Swap X / Y',
  'dialogs.importGeometry.silhouetteZSteps': 'Silhouette Z Steps',
  'dialogs.importGeometry.silhouetteAuto': 'Auto',
  'dialogs.importGeometry.joinTolerance': 'Join Tolerance ({unit})',
  'dialogs.importGeometry.crossLayerJoin': 'Cross-Layer Join',
  'dialogs.importGeometry.layers': 'Layers',
  'dialogs.importGeometry.folders': 'Folders',
  'dialogs.importGeometry.selectAll': 'Select all',
  'dialogs.importGeometry.deselectAll': 'Deselect all',
  'dialogs.importGeometry.selectAtLeastOne': 'Select at least one {type} to import.',
  'dialogs.importGeometry.import': 'Import',

  // ── Import Geometry: error messages (set via setDialogError) ──
  'dialogs.importGeometry.error.unsupportedFormat': 'Unsupported import format. Use .svg, .dxf, .stl, .obj, or .camj.',
  'dialogs.importGeometry.error.noCamjFolders': 'No folders with features found in the selected .camj file.',
  'dialogs.importGeometry.error.inspectFailed': 'Failed to inspect geometry file.',
  'dialogs.importGeometry.error.chooseFile': 'Choose an SVG, DXF, STL, OBJ, or .camj file to import.',
  'dialogs.importGeometry.error.sourceUnits': 'Source units could not be detected. Choose the source units to continue.',
  'dialogs.importGeometry.error.joinTolerance': 'Join tolerance must be a non-negative number.',
  'dialogs.importGeometry.error.selectFolder': 'Select at least one folder to import, or check "Import stock from source".',
  'dialogs.importGeometry.error.noFeaturesImported': 'No features were imported from the selected folders.',
  'dialogs.importGeometry.error.noGeometryFound': 'No importable geometry found in the selected file.',
  'dialogs.importGeometry.error.importFailed': 'Failed to import geometry file.',

  // ── Import Geometry: loading stages ──
  'dialogs.importGeometry.processingModel': 'Processing model',
  'dialogs.importGeometry.preparingImport': 'Preparing import',
  'dialogs.importGeometry.mergingFolders': 'Merging folders',
  'dialogs.importGeometry.importingGeometry': 'Importing geometry',

  // ── Import Geometry: format labels (descriptive, not acronyms) ──
  'dialogs.importGeometry.formatLabel.camj': 'PureCutCNC Project',
  'dialogs.importGeometry.formatLabel.unknown': 'Unknown',

  // ── Import Geometry: import-complete alert ──
  'dialogs.importGeometry.importedFeaturesWarnings.one': 'Imported {count} feature with warnings:\n\n{warnings}',
  'dialogs.importGeometry.importedFeaturesWarnings.other': 'Imported {count} features with warnings:\n\n{warnings}',

  // ── Import Geometry Mode section ──
  'dialogs.importGeometry.mode.geometryMode': 'Geometry Mode',
  'dialogs.importGeometry.mode.auto': 'Auto',
  'dialogs.importGeometry.mode.paths': 'Paths',
  'dialogs.importGeometry.mode.solidRegions': 'Solid regions',
  'dialogs.importGeometry.mode.explain.autoSvg': 'Auto: stroke-only geometry → Lines; filled closed shapes → nesting-aware solids.',
  'dialogs.importGeometry.mode.explain.autoDxf': 'Auto: closed profiles → nesting-aware solids. Use Paths for line-only import.',
  'dialogs.importGeometry.mode.explain.paths': 'Paths: all profiles → Lines (no solid features).',
  'dialogs.importGeometry.mode.explain.solidRegions': 'Solid regions: closed profiles → nesting-aware Add/Subtract solids.',
  'dialogs.importGeometry.mode.analysing': 'Analysing geometry…',
  'dialogs.importGeometry.mode.importSummary': 'Import Summary',
  'dialogs.importGeometry.mode.totalImportable': 'Total importable',
  'dialogs.importGeometry.mode.openLines': 'Open Lines',
  'dialogs.importGeometry.mode.closedLines': 'Closed Lines',
  'dialogs.importGeometry.mode.addSolid': 'Add (solid)',
  'dialogs.importGeometry.mode.subtractSolid': 'Subtract (solid)',

  // ── Text Tool dialog ──
  'dialogs.textTool.title': 'Add Text',
  'dialogs.textTool.text': 'Text',
  'dialogs.textTool.fontStyle': 'Font Style',
  'dialogs.textTool.font': 'Font',
  'dialogs.textTool.height': 'Height',
  'dialogs.textTool.operation': 'Operation',
  'dialogs.textTool.style.skeleton': 'Skeleton',
  'dialogs.textTool.style.outline': 'Outline',
  'dialogs.textTool.operation.subtract': 'Subtract',
  'dialogs.textTool.operation.add': 'Add',
  'dialogs.textTool.helpText': 'Single-line text for now. Outline text generates closed features; skeleton text generates open engraving paths.',
  'dialogs.textTool.placeText': 'Place Text',

  // ── Unit Conversion dialog ──
  'dialogs.unitConversion.eyebrow': 'Project scale',
  'dialogs.unitConversion.title': 'Change project units?',
  'dialogs.unitConversion.ariaChanging': 'Changing from {from} to {to}',
  'dialogs.unitConversion.intro': 'Choose whether the existing measurements should keep their physical size or keep their written numbers.',
  'dialogs.unitConversion.convertHeading': 'Convert values',
  'dialogs.unitConversion.convertBadge': 'Recommended',
  'dialogs.unitConversion.convertDescription': 'Preserves the physical size of the design, stock, dimensions, and machining values.',
  'dialogs.unitConversion.convertExample': '{from} becomes {to}',
  'dialogs.unitConversion.keepHeading': 'Keep numeric values',
  'dialogs.unitConversion.keepDescription': 'Reinterprets every number in the new units, changing the project\'s physical scale.',
  'dialogs.unitConversion.keepExample': '{from} becomes {to}',

  // ── Example Project list ──
  'dialogs.exampleProject.loading': 'Loading examples…',
  'dialogs.exampleProject.noExamples': 'No examples available.',
  'dialogs.exampleProject.opening': 'Opening…',
  'dialogs.exampleProject.errorLoad': 'Failed to load examples.',
  'dialogs.exampleProject.errorOpen': 'Failed to open example.',

  // ── Export G-code dialog ──
  'dialogs.export.title': 'Export G-code',
  'dialogs.export.machine': 'Machine',
  'dialogs.export.machineNone': 'None selected',
  'dialogs.export.change': 'Change',
  'dialogs.export.origin': 'Origin',
  'dialogs.export.originDescription': 'Export uses the current project origin as machine X0 Y0 Z0.',
  'dialogs.export.originNote': 'Edit Origin in the sketch or project tree to change the work zero used for export.',
  'dialogs.export.projectUnits': 'Project Units',
  'dialogs.export.operations': 'Operations',
  'dialogs.export.noOperations': 'No operations to export. Add one in the Operations panel.',
  'dialogs.export.options': 'Options',
  'dialogs.export.emitToolChanges': 'Emit tool changes (M6)',
  'dialogs.export.emitCoolant': 'Emit coolant commands',
  'dialogs.export.warnings': 'Warnings',
  'dialogs.export.preview': 'Preview (First 30 lines)',
  'dialogs.export.previewPlaceholder': 'Select a machine in Project Settings to generate G-code preview.',
  'dialogs.export.previewTruncated': '...',
  'dialogs.export.movesLines': '{moves} moves, {lines} lines total',
  'dialogs.export.warning.noOperations': 'No operations selected. Check at least one operation to export.',
  'dialogs.export.warning.noMachine': 'No machine selected. Select one in Project Settings before exporting.',
  'dialogs.export.export': 'Export {ext}',

  // ── Export: operation reasons (from exportOperationSelection.ts) ──
  'dialogs.export.operationDisabled': 'Operation is off',
  'dialogs.export.noToolAssigned': 'No tool assigned',

  // ── Model Export dialog ──
  'dialogs.modelExport.title': 'Export Model',
  'dialogs.modelExport.format': 'Format',
  'dialogs.modelExport.fileName': 'File name',
  'dialogs.modelExport.fileNameHint': 'Saved as {filename}. The location is chosen in the next dialog.',
  'dialogs.modelExport.curveQuality': 'Curve quality',
  'dialogs.modelExport.curveQualityHint': 'Controls how finely arcs and bezier curves are tessellated. Finer = more triangles, smoother curves.',
  'dialogs.modelExport.summary': 'Summary',
  'dialogs.modelExport.exportedSize': 'Exported size: {width} × {height} {unit} at 1:1',
  'dialogs.modelExport.exportedSizeNote': 'Editable vector paths; hidden features are left out and dimensions follow the sketch setting.',
  'dialogs.modelExport.assembling': 'Assembling mesh…',
  'dialogs.modelExport.triangles': '{count} triangles',
  'dialogs.modelExport.estimatedSize': 'Estimated file size: {size}',
  'dialogs.modelExport.warnings': 'Warnings',
  'dialogs.modelExport.error': 'Error',
  'dialogs.modelExport.noGeometry': 'No solid geometry to export — add visible features first.',
  'dialogs.modelExport.exporting': 'Exporting…',
  'dialogs.modelExport.export': 'Export .{ext}',

  // ── Model Export: STL options ──
  'dialogs.modelExport.stlEncoding': 'STL encoding',
  'dialogs.modelExport.stlBinary': 'Binary (recommended — smaller, faster)',
  'dialogs.modelExport.stlAscii': 'ASCII (human-readable)',
  'dialogs.modelExport.contents': 'Contents',
  'dialogs.modelExport.includeImportedMeshes': 'Include imported meshes',

  // ── Model Export: SVG options ──
  'dialogs.modelExport.svgArea': 'Export area',
  'dialogs.modelExport.svgContent': 'Content',
  'dialogs.modelExport.svgContent.tabs': 'Tabs',
  'dialogs.modelExport.svgContent.clamps': 'Clamps',
  'dialogs.modelExport.svgContent.featureLabels': 'Feature labels',
  'dialogs.modelExport.svgContent.grid': 'Grid',
  'dialogs.modelExport.svgContent.color': 'Color',
  'dialogs.modelExport.svgContent.monochrome': 'Monochrome',

  // ── Model Export: curve quality labels ──
  'dialogs.modelExport.curveQuality.coarse': 'Coarse (10° — matches 3D viewport)',
  'dialogs.modelExport.curveQuality.normal': 'Normal (5°)',
  'dialogs.modelExport.curveQuality.fine': 'Fine (2°)',
  'dialogs.modelExport.curveQuality.veryFine': 'Very fine (1°)',

  // ── Print Design dialog ──
  'dialogs.printDesign.title': 'Print Design',
  'dialogs.printDesign.paper': 'Paper',
  'dialogs.printDesign.customSize': 'Custom size',
  'dialogs.printDesign.size': 'Size ({unit})',
  'dialogs.printDesign.customPaperWidth': 'Custom paper width ({unit})',
  'dialogs.printDesign.customPaperHeight': 'Custom paper height ({unit})',
  'dialogs.printDesign.portrait': 'Portrait',
  'dialogs.printDesign.landscape': 'Landscape',
  'dialogs.printDesign.margins': 'Margins ({unit})',
  'dialogs.printDesign.printArea': 'Print area',
  'dialogs.printDesign.printArea.visible': 'Visible design extents',
  'dialogs.printDesign.printArea.stock': 'Stock extents',
  'dialogs.printDesign.printArea.view': 'Current sketch view',
  'dialogs.printDesign.currentViewUnavailable': 'Current sketch view is available when the sketch canvas is open.',
  'dialogs.printDesign.scale': 'Scale',
  'dialogs.printDesign.fitToPage': 'Fit to page',
  'dialogs.printDesign.actualSize': 'Actual size (1:1)',
  'dialogs.printDesign.custom': 'Custom',
  'dialogs.printDesign.customScaleAria': 'Custom scale (ratio, percentage, or factor)',
  'dialogs.printDesign.offsetXY': 'Offset X / Y ({unit})',
  'dialogs.printDesign.offsetX': 'Horizontal offset ({unit})',
  'dialogs.printDesign.offsetY': 'Vertical offset ({unit})',
  'dialogs.printDesign.content': 'Content',
  'dialogs.printDesign.content.grid': 'Grid',
  'dialogs.printDesign.content.backdrop': 'Backdrop image',
  'dialogs.printDesign.content.featureLabels': 'Feature labels',
  'dialogs.printDesign.content.tabs': 'Tabs',
  'dialogs.printDesign.content.clamps': 'Clamps',
  'dialogs.printDesign.content.toolpaths': 'Toolpath overlays',
  'dialogs.printDesign.content.titleBlock': 'Title block',
  'dialogs.printDesign.content.color': 'Color',
  'dialogs.printDesign.content.monochrome': 'Monochrome',
  'dialogs.printDesign.printedSize': 'Printed size: {width} × {height} {unit} at {scale}',
  'dialogs.printDesign.close': 'Close',
  'dialogs.printDesign.print': 'Print…',

  // ── Print Design: warnings ──
  'dialogs.printDesign.warning.customScale': 'Custom scale not recognized — enter a ratio like 1:2, a percentage like 50%, or a factor like 0.5.',
  'dialogs.printDesign.warning.clipped': 'The drawing is clipped on this paper at the selected scale. Use Fit to page, reduce the scale, or choose a larger paper size.',

  // ── Print Design: disabled tooltips ──
  'dialogs.printDesign.noTabs': 'No tabs in this project',
  'dialogs.printDesign.noClamps': 'No clamps in this project',
  'dialogs.printDesign.noToolpaths': 'No toolpaths are visible in the sketch view',
  'dialogs.printDesign.noBackdrop': 'No backdrop image in this project',

  // ── Machine Editor dialog ──
  'dialogs.machineEditor.title': 'Edit Machine: {name}',
  'dialogs.machineEditor.general': 'General',
  'dialogs.machineEditor.name': 'Name',
  'dialogs.machineEditor.fileExtension': 'File Extension',
  'dialogs.machineEditor.mmCommand': 'Units — mm command',
  'dialogs.machineEditor.inchCommand': 'Units — inch command',
  'dialogs.machineEditor.program': 'Program',
  'dialogs.machineEditor.header': 'Header',
  'dialogs.machineEditor.operationHeader': 'Operation Header',
  'dialogs.machineEditor.footer': 'Footer',
  'dialogs.machineEditor.toolChange': 'Tool Change',
  'dialogs.machineEditor.toolChangeCommands': 'Commands',
  'dialogs.machineEditor.coolant': 'Coolant',
  'dialogs.machineEditor.floodOn': 'Flood On',
  'dialogs.machineEditor.mistOn': 'Mist On',
  'dialogs.machineEditor.coolantOff': 'Coolant Off',
  'dialogs.machineEditor.advanced': 'Advanced (raw JSON)',
  'dialogs.machineEditor.variablesReference': 'Variables reference',
  'dialogs.machineEditor.save': 'Save',
  'dialogs.machineEditor.invalidJson': 'Invalid JSON syntax',

  // ── Machine Manager dialog ──
  'dialogs.machineManager.title': 'Manage Machines',
  'dialogs.machineManager.builtin': 'Built-in',
  'dialogs.machineManager.custom': 'Custom',
  'dialogs.machineManager.active': 'Active',
  'dialogs.machineManager.fileExtension': 'File extension',
  'dialogs.machineManager.description': 'Description',
  'dialogs.machineManager.vendor': 'Vendor',
  'dialogs.machineManager.builtinHint': 'Built-in definitions are read-only. Duplicate to create an editable copy.',
  'dialogs.machineManager.useThisMachine': 'Use this machine',
  'dialogs.machineManager.edit': 'Edit',
  'dialogs.machineManager.duplicateToEdit': 'Duplicate to edit',
  'dialogs.machineManager.duplicate': 'Duplicate',
  'dialogs.machineManager.importMachine': 'Import machine',
  'dialogs.machineManager.exportMachine': 'Export machine',
  'dialogs.machineManager.removeMachine': 'Remove machine',
  'dialogs.machineManager.done': 'Done',
  'dialogs.machineManager.empty': 'No machine definitions. Import one to get started.',
  'dialogs.machineManager.emptyDetail': 'Select a machine from the list or import one.',
  'dialogs.machineManager.invalidImport': 'Invalid machine definition JSON: {message}',
} as const satisfies Record<string, string>
