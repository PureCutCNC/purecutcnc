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

import type { dialogsEn } from '../en/dialogs'

/**
 * Simplified Chinese dialog translations. Typed as a complete record of the
 * English dialogs module's keys, so adding an English key without its Chinese
 * translation is a compile error — extraction and translation land together.
 * Terminology follows `src/i18n/GLOSSARY.md`; zh has no grammatical plural, so
 * `.one`/`.other` variants intentionally share one string.
 */
export const dialogsZhCN: Record<keyof typeof dialogsEn, string> = {
  // ── Common dialog strings ──
  'dialogs.common.close': '关闭',
  'dialogs.common.cancel': '取消',
  'dialogs.common.none': '无',
  'dialogs.common.millimeter': '毫米',
  'dialogs.common.inch': '英寸',

  // ── New Project dialog ──
  'dialogs.newProject.title': '新建项目',
  'dialogs.newProject.projectName': '项目名称',
  'dialogs.newProject.template': '模板',
  'dialogs.newProject.templateBlankMetric': '公制空白',
  'dialogs.newProject.templateBlankMetricMeta': '以毫米为单位的空白项目。',
  'dialogs.newProject.templateBlankImperial': '英制空白',
  'dialogs.newProject.templateBlankImperialMeta': '以英寸为单位的空白项目。',
  'dialogs.newProject.templateCurrentProject': '当前项目',
  'dialogs.newProject.templateCurrentProjectMeta': '使用当前打开的项目设置作为起始模板。',
  'dialogs.newProject.templateFile': '模板文件',
  'dialogs.newProject.templateFileNoFile': '未加载模板文件。',
  'dialogs.newProject.templateFileParseError': '模板项目文件解析失败。',
  'dialogs.newProject.templatePreview': '模板预览',
  'dialogs.newProject.previewUnits': '单位',
  'dialogs.newProject.previewStock': '毛坯',
  'dialogs.newProject.previewFeatures': '特征',
  'dialogs.newProject.previewTools': '刀具',
  'dialogs.newProject.previewOperations': '加工操作',
  'dialogs.newProject.previewMachine': '机床',
  'dialogs.newProject.previewEmpty': '加载项目文件以用作模板。',
  'dialogs.newProject.orOpenExample': '或打开示例',
  'dialogs.newProject.createProject': '创建项目',

  // ── New Project: template labels (preview title) ──
  'dialogs.newProject.templateLabel.blankMetric': '公制空白',
  'dialogs.newProject.templateLabel.blankImperial': '英制空白',
  'dialogs.newProject.templateLabel.currentProject': '当前项目设置：{name}',
  'dialogs.newProject.templateLabel.fileSetup': '模板文件设置：{name}',
  'dialogs.newProject.templateLabel.fileSetupFallback': '模板文件设置',
  'dialogs.newProject.templateFileMetaSettings': '{name}（仅设置）',

  // ── Import Geometry dialog ──
  'dialogs.importGeometry.title': '导入图形',
  'dialogs.importGeometry.sourceFile': '源文件',
  'dialogs.importGeometry.chooseFile': '选择 SVG、DXF、STL、OBJ 或 .camj',
  'dialogs.importGeometry.chooseDifferentFile': '选择其他文件',
  'dialogs.importGeometry.noFileSelected': '未选择文件。',
  'dialogs.importGeometry.settings': '设置',
  'dialogs.importGeometry.format': '格式',
  'dialogs.importGeometry.sourceUnits': '源文件单位',
  'dialogs.importGeometry.selectUnits': '选择单位',
  'dialogs.importGeometry.unitsNotDetected': '未检测到单位 — 请在导入前选择源文件单位。',
  'dialogs.importGeometry.camjImportNote': '背景、网格、机床定义和全局约束不会被导入。',
  'dialogs.importGeometry.importStock': '从源文件导入毛坯',
  'dialogs.importGeometry.stockWillBeReplaced': '当前毛坯和原点将被替换。',
  'dialogs.importGeometry.projectUnits': '项目单位',
  'dialogs.importGeometry.axisOrientation': '坐标轴方向',
  'dialogs.importGeometry.axisOriginal': '原始（Z 轴朝上）',
  'dialogs.importGeometry.axisSwapYZ': '交换 Y / Z（Y 轴朝上）',
  'dialogs.importGeometry.axisSwapXZ': '交换 X / Z',
  'dialogs.importGeometry.axisSwapXY': '交换 X / Y',
  'dialogs.importGeometry.silhouetteZSteps': '轮廓 Z 步数',
  'dialogs.importGeometry.silhouetteAuto': '自动',
  'dialogs.importGeometry.joinTolerance': '连接容差（{unit}）',
  'dialogs.importGeometry.crossLayerJoin': '跨图层连接',
  'dialogs.importGeometry.layers': '图层',
  'dialogs.importGeometry.folders': '文件夹',
  'dialogs.importGeometry.selectAll': '全选',
  'dialogs.importGeometry.deselectAll': '取消全选',
  'dialogs.importGeometry.selectAtLeastOne': '至少选择一个{type}来导入。',
  'dialogs.importGeometry.folderNoun': '文件夹',
  'dialogs.importGeometry.layerNoun': '图层',
  'dialogs.importGeometry.import': '导入',

  // ── Import Geometry: error messages ──
  'dialogs.importGeometry.error.unsupportedFormat': '不支持的导入格式。请使用 .svg、.dxf、.stl、.obj 或 .camj。',
  'dialogs.importGeometry.error.noCamjFolders': '所选 .camj 文件中未找到包含特征的文件夹。',
  'dialogs.importGeometry.error.inspectFailed': '检查图形文件失败。',
  'dialogs.importGeometry.error.chooseFile': '选择要导入的 SVG、DXF、STL、OBJ 或 .camj 文件。',
  'dialogs.importGeometry.error.sourceUnits': '无法检测源文件单位。请选择源文件单位以继续。',
  'dialogs.importGeometry.error.joinTolerance': '连接容差必须为非负数。',
  'dialogs.importGeometry.error.selectFolder': '至少选择一个要导入的文件夹，或勾选"从源文件导入毛坯"。',
  'dialogs.importGeometry.error.noFeaturesImported': '未从所选文件夹导入任何特征。',
  'dialogs.importGeometry.error.noGeometryFound': '所选文件中未找到可导入的图形。',
  'dialogs.importGeometry.error.importFailed': '导入图形文件失败。',

  // ── Import Geometry: loading stages ──
  'dialogs.importGeometry.processingModel': '正在处理模型',
  'dialogs.importGeometry.preparingImport': '正在准备导入',
  'dialogs.importGeometry.mergingFolders': '正在合并文件夹',
  'dialogs.importGeometry.importingGeometry': '正在导入图形',

  // ── Import Geometry: format labels ──
  'dialogs.importGeometry.formatLabel.camj': 'PureCutCNC 项目',
  'dialogs.importGeometry.formatLabel.unknown': '未知',

  // ── Import Geometry: import-complete alert ──
  'dialogs.importGeometry.importedFeaturesWarnings.one': '已导入 {count} 个特征，但有警告：\n\n{warnings}',
  'dialogs.importGeometry.importedFeaturesWarnings.other': '已导入 {count} 个特征，但有警告：\n\n{warnings}',

  // ── Import Geometry Mode section ──
  'dialogs.importGeometry.mode.geometryMode': '图形模式',
  'dialogs.importGeometry.mode.auto': '自动',
  'dialogs.importGeometry.mode.paths': '路径',
  'dialogs.importGeometry.mode.solidRegions': '实体区域',
  'dialogs.importGeometry.mode.explain.autoSvg': '自动：仅描边图形 → 线条；填充的封闭形状 → 自动嵌套的实体。',
  'dialogs.importGeometry.mode.explain.autoDxf': '自动：封闭轮廓 → 自动嵌套的实体。如需仅导入线条，请使用"路径"模式。',
  'dialogs.importGeometry.mode.explain.paths': '路径：所有轮廓 → 线条（不生成实体特征）。',
  'dialogs.importGeometry.mode.explain.solidRegions': '实体区域：封闭轮廓 → 自动嵌套的添加/减去实体。',
  'dialogs.importGeometry.mode.analysing': '正在分析图形…',
  'dialogs.importGeometry.mode.importSummary': '导入摘要',
  'dialogs.importGeometry.mode.totalImportable': '可导入总数',
  'dialogs.importGeometry.mode.openLines': '开放线条',
  'dialogs.importGeometry.mode.closedLines': '闭合线条',
  'dialogs.importGeometry.mode.addSolid': '添加（实体）',
  'dialogs.importGeometry.mode.subtractSolid': '减去（实体）',

  // ── Text Tool dialog ──
  'dialogs.textTool.title': '添加文字',
  'dialogs.textTool.text': '文字',
  'dialogs.textTool.fontStyle': '字体样式',
  'dialogs.textTool.font': '字体',
  'dialogs.textTool.height': '高度',
  'dialogs.textTool.operation': '操作',
  'dialogs.textTool.style.skeleton': '骨架',
  'dialogs.textTool.style.outline': '轮廓',
  'dialogs.textTool.operation.subtract': '减去',
  'dialogs.textTool.operation.add': '添加',
  'dialogs.textTool.helpText': '目前仅支持单行文字。轮廓文字生成闭合特征；骨架文字生成开放雕刻路径。',
  'dialogs.textTool.placeText': '放置文字',

  // ── Unit Conversion dialog ──
  'dialogs.unitConversion.eyebrow': '项目比例',
  'dialogs.unitConversion.title': '更改项目单位？',
  'dialogs.unitConversion.ariaChanging': '从 {from} 更改为 {to}',
  'dialogs.unitConversion.intro': '选择现有测量值应保持其物理尺寸，还是保持其数值。',
  'dialogs.unitConversion.convertHeading': '转换数值',
  'dialogs.unitConversion.convertBadge': '推荐',
  'dialogs.unitConversion.convertDescription': '保持设计、毛坯、标注和加工值的物理尺寸不变。',
  'dialogs.unitConversion.convertExample': '{from} 变为 {to}',
  'dialogs.unitConversion.keepHeading': '保持数值',
  'dialogs.unitConversion.keepDescription': '以新单位重新解释每个数值，改变项目的物理比例。',
  'dialogs.unitConversion.keepExample': '{from} 变为 {to}',

  // ── Example Project list ──
  'dialogs.exampleProject.loading': '正在加载示例…',
  'dialogs.exampleProject.noExamples': '没有可用的示例。',
  'dialogs.exampleProject.opening': '正在打开…',
  'dialogs.exampleProject.errorLoad': '加载示例失败。',
  'dialogs.exampleProject.errorOpen': '打开示例失败。',

  // ── Export G-code dialog ──
  'dialogs.export.title': '导出 G 代码',
  'dialogs.export.machine': '机床',
  'dialogs.export.machineNone': '未选择',
  'dialogs.export.change': '更改',
  'dialogs.export.origin': '原点',
  'dialogs.export.originDescription': '导出使用当前项目原点作为机床 X0 Y0 Z0。',
  'dialogs.export.originNote': '在草图或项目树中编辑原点，以更改导出所用的工件零点。',
  'dialogs.export.projectUnits': '项目单位',
  'dialogs.export.operations': '加工操作',
  'dialogs.export.noOperations': '没有可导出的加工操作。请在加工操作面板中添加。',
  'dialogs.export.options': '选项',
  'dialogs.export.emitToolChanges': '输出换刀指令（M6）',
  'dialogs.export.emitCoolant': '输出冷却液指令',
  'dialogs.export.warnings': '警告',
  'dialogs.export.preview': '预览（前 30 行）',
  'dialogs.export.previewPlaceholder': '在项目设置中选择机床以生成 G 代码预览。',
  'dialogs.export.previewTruncated': '...',
  'dialogs.export.movesLines': '{moves} 次移动，共 {lines} 行',
  'dialogs.export.warning.noOperations': '未选择加工操作。请至少勾选一个要导出的操作。',
  'dialogs.export.warning.noMachine': '未选择机床。请在导出前在项目设置中选择一个。',
  'dialogs.export.export': '导出 {ext}',

  // ── Export: operation reasons ──
  'dialogs.export.operationDisabled': '操作已关闭',
  'dialogs.export.noToolAssigned': '未分配刀具',

  // ── Model Export dialog ──
  'dialogs.modelExport.title': '导出模型',
  'dialogs.modelExport.format': '格式',
  'dialogs.modelExport.fileName': '文件名',
  'dialogs.modelExport.fileNameHint': '保存为 {filename}。保存位置将在下一个对话框中选择。',
  'dialogs.modelExport.curveQuality': '曲线质量',
  'dialogs.modelExport.curveQualityHint': '控制圆弧和贝塞尔曲线的细分精细度。越精细 = 三角形越多，曲线越平滑。',
  'dialogs.modelExport.summary': '摘要',
  'dialogs.modelExport.exportedSize': '导出尺寸：{width} × {height} {unit}（1:1）',
  'dialogs.modelExport.exportedSizeNote': '可编辑的矢量路径；隐藏的特征不会包含在内，标注遵循草图设置。',
  'dialogs.modelExport.assembling': '正在组合网格…',
  'dialogs.modelExport.triangles': '{count} 个三角形',
  'dialogs.modelExport.estimatedSize': '预估文件大小：{size}',
  'dialogs.modelExport.warnings': '警告',
  'dialogs.modelExport.error': '错误',
  'dialogs.modelExport.noGeometry': '没有可导出的实体图形 — 请先添加可见特征。',
  'dialogs.modelExport.exporting': '正在导出…',
  'dialogs.modelExport.export': '导出 .{ext}',

  // ── Model Export: STL options ──
  'dialogs.modelExport.stlEncoding': 'STL 编码',
  'dialogs.modelExport.stlBinary': '二进制（推荐 — 更小、更快）',
  'dialogs.modelExport.stlAscii': 'ASCII（人类可读）',
  'dialogs.modelExport.contents': '内容',
  'dialogs.modelExport.includeImportedMeshes': '包含导入的网格',

  // ── Model Export: SVG options ──
  'dialogs.modelExport.svgArea': '导出区域',
  'dialogs.modelExport.svgContent': '内容',
  'dialogs.modelExport.svgContent.tabs': '桥接',
  'dialogs.modelExport.svgContent.clamps': '夹具',
  'dialogs.modelExport.svgContent.featureLabels': '特征标签',
  'dialogs.modelExport.svgContent.grid': '网格',
  'dialogs.modelExport.svgContent.color': '彩色',
  'dialogs.modelExport.svgContent.monochrome': '单色',

  // ── Model Export: curve quality labels ──
  'dialogs.modelExport.curveQuality.coarse': '粗糙（10° — 与 3D 视口匹配）',
  'dialogs.modelExport.curveQuality.normal': '正常（5°）',
  'dialogs.modelExport.curveQuality.fine': '精细（2°）',
  'dialogs.modelExport.curveQuality.veryFine': '非常精细（1°）',

  // ── Print Design dialog ──
  'dialogs.printDesign.title': '打印设计',
  'dialogs.printDesign.paper': '纸张',
  'dialogs.printDesign.customSize': '自定义尺寸',
  'dialogs.printDesign.size': '尺寸（{unit}）',
  'dialogs.printDesign.customPaperWidth': '自定义纸张宽度（{unit}）',
  'dialogs.printDesign.customPaperHeight': '自定义纸张高度（{unit}）',
  'dialogs.printDesign.portrait': '纵向',
  'dialogs.printDesign.landscape': '横向',
  'dialogs.printDesign.margins': '页边距（{unit}）',
  'dialogs.printDesign.printArea': '打印区域',
  'dialogs.printDesign.printArea.visible': '可见设计范围',
  'dialogs.printDesign.printArea.stock': '毛坯范围',
  'dialogs.printDesign.printArea.view': '当前草图视图',
  'dialogs.printDesign.currentViewUnavailable': '当前草图视图在草图画布打开时可用。',
  'dialogs.printDesign.scale': '比例',
  'dialogs.printDesign.fitToPage': '适应页面',
  'dialogs.printDesign.actualSize': '实际尺寸（1:1）',
  'dialogs.printDesign.custom': '自定义',
  'dialogs.printDesign.customScaleAria': '自定义比例（比例、百分比或倍数）',
  'dialogs.printDesign.offsetXY': '偏移 X / Y（{unit}）',
  'dialogs.printDesign.offsetX': '水平偏移（{unit}）',
  'dialogs.printDesign.offsetY': '垂直偏移（{unit}）',
  'dialogs.printDesign.content': '内容',
  'dialogs.printDesign.content.grid': '网格',
  'dialogs.printDesign.content.backdrop': '背景图像',
  'dialogs.printDesign.content.featureLabels': '特征标签',
  'dialogs.printDesign.content.tabs': '桥接',
  'dialogs.printDesign.content.clamps': '夹具',
  'dialogs.printDesign.content.toolpaths': '刀路叠加',
  'dialogs.printDesign.content.titleBlock': '标题栏',
  'dialogs.printDesign.content.color': '彩色',
  'dialogs.printDesign.content.monochrome': '单色',
  'dialogs.printDesign.printedSize': '打印尺寸：{width} × {height} {unit}，比例 {scale}',
  'dialogs.printDesign.close': '关闭',
  'dialogs.printDesign.print': '打印…',

  // ── Print Design: warnings ──
  'dialogs.printDesign.warning.customScale': '无法识别自定义比例 — 请输入比例（如 1:2）、百分比（如 50%）或倍数（如 0.5）。',
  'dialogs.printDesign.warning.clipped': '在此纸张和所选比例下，图纸被裁剪。请使用"适应页面"、减小比例或选择更大的纸张尺寸。',

  // ── Print Design: disabled tooltips ──
  'dialogs.printDesign.noTabs': '此项目中无桥接',
  'dialogs.printDesign.noClamps': '此项目中无夹具',
  'dialogs.printDesign.noToolpaths': '草图视图中无可见刀路',
  'dialogs.printDesign.noBackdrop': '此项目中无背景图像',

  // ── Machine Editor dialog ──
  'dialogs.machineEditor.title': '编辑机床：{name}',
  'dialogs.machineEditor.general': '常规',
  'dialogs.machineEditor.name': '名称',
  'dialogs.machineEditor.fileExtension': '文件扩展名',
  'dialogs.machineEditor.mmCommand': '单位 — 毫米指令',
  'dialogs.machineEditor.inchCommand': '单位 — 英寸指令',
  'dialogs.machineEditor.program': '程序',
  'dialogs.machineEditor.header': '程序头',
  'dialogs.machineEditor.operationHeader': '操作头',
  'dialogs.machineEditor.footer': '程序尾',
  'dialogs.machineEditor.toolChange': '换刀',
  'dialogs.machineEditor.toolChangeCommands': '指令',
  'dialogs.machineEditor.coolant': '冷却液',
  'dialogs.machineEditor.floodOn': '切削液开',
  'dialogs.machineEditor.mistOn': '油雾开',
  'dialogs.machineEditor.coolantOff': '冷却液关',
  'dialogs.machineEditor.advanced': '高级（原始 JSON）',
  'dialogs.machineEditor.variablesReference': '变量参考',
  'dialogs.machineEditor.save': '保存',
  'dialogs.machineEditor.invalidJson': '无效的 JSON 语法',

  // ── Machine Manager dialog ──
  'dialogs.machineManager.title': '管理机床',
  'dialogs.machineManager.builtin': '内置',
  'dialogs.machineManager.custom': '自定义',
  'dialogs.machineManager.active': '当前使用',
  'dialogs.machineManager.fileExtension': '文件扩展名',
  'dialogs.machineManager.description': '描述',
  'dialogs.machineManager.vendor': '厂商',
  'dialogs.machineManager.builtinHint': '内置定义为只读。请复制以创建可编辑的副本。',
  'dialogs.machineManager.useThisMachine': '使用此机床',
  'dialogs.machineManager.edit': '编辑',
  'dialogs.machineManager.duplicateToEdit': '复制以编辑',
  'dialogs.machineManager.duplicate': '复制',
  'dialogs.machineManager.importMachine': '导入机床',
  'dialogs.machineManager.exportMachine': '导出机床',
  'dialogs.machineManager.removeMachine': '移除机床',
  'dialogs.machineManager.done': '完成',
  'dialogs.machineManager.empty': '没有机床定义。请导入一个以开始使用。',
  'dialogs.machineManager.emptyDetail': '从列表中选择一个机床或导入一个。',
  'dialogs.machineManager.invalidImport': '无效的机床定义 JSON：{message}',
}
