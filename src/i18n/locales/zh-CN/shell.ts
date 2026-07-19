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

import type { shellEn } from '../en/shell'

/**
 * Simplified Chinese app-shell translations. Typed as a complete record of the
 * English shell module's keys, so adding an English key without its Chinese
 * translation is a compile error — extraction and translation land together.
 * Terminology follows `src/i18n/GLOSSARY.md`; zh has no grammatical plural, so
 * `.one`/`.other` variants intentionally share one string.
 */
export const shellZhCN: Record<keyof typeof shellEn, string> = {
  'file.newProject': '新建项目',
  'file.openProject': '打开项目',
  'file.importGeometry': '导入图形',
  'file.exportModel': '导出模型',
  'file.printDesign': '打印设计',
  'file.saveProject': '保存项目',
  'file.saveProjectDirty': '保存项目（有未保存的更改）',
  'file.undo': '撤销',
  'file.redo': '重做',

  'shell.topBar.openProjectPanel': '打开项目面板',
  'shell.topBar.openOperationsPanel': '打开加工操作面板',
  'shell.topBar.operations': '加工操作',
  'shell.topBar.renameProject': '重命名项目',
  'shell.topBar.saved': '已保存',
  'shell.topBar.unsaved': '未保存',
  'shell.topBar.savedTitle': '项目已保存',
  'shell.topBar.unsavedTitle': '项目有未保存的更改',
  'shell.topBar.projectLabel': '项目',
  'shell.topBar.tabSketch': '草图',
  'shell.topBar.tab3d': '3D',
  'shell.topBar.tabSim': '仿真',
  'shell.topBar.zoomToModel': '缩放至模型',
  'shell.topBar.zoomSelected': '框选缩放',
  'shell.topBar.cancelZoomSelected': '取消框选缩放',

  'shell.snap.enable': '启用捕捉',
  'shell.snap.disable': '禁用捕捉',
  'shell.snap.settingsTooltip': '捕捉设置',
  'shell.snap.enabledAria.one': '捕捉已启用（{count} 种模式）',
  'shell.snap.enabledAria.other': '捕捉已启用（{count} 种模式）',
  'shell.snap.disabledAria': '捕捉已禁用',
  'shell.snap.enabledButton': '已启用',
  'shell.snap.disabledButton': '已禁用',
  'shell.snap.grid': '捕捉到网格',
  'shell.snap.gridShort': '网格',
  'shell.snap.point': '捕捉到点',
  'shell.snap.pointShort': '点',
  'shell.snap.line': '捕捉到线',
  'shell.snap.lineShort': '线',
  'shell.snap.midpoint': '捕捉到中点',
  'shell.snap.midpointShort': '中点',
  'shell.snap.center': '捕捉到圆心',
  'shell.snap.centerShort': '圆心',
  'shell.snap.intersection': '捕捉到交点',
  'shell.snap.intersectionShort': '交点',
  'shell.snap.perpendicular': '捕捉到垂足',
  'shell.snap.perpendicularShort': '垂足',

  'shell.measure.tooltip': '测量与标注',
  'shell.measure.aria': '测量与标注',
  'shell.measure.tapeMeasure': '卷尺测量',
  'shell.measure.tapeMeasureOn': '卷尺测量（进行中）',
  'shell.measure.stopTapeMeasure': '停止卷尺测量',
  'shell.measure.addDimension': '添加标注',
  'shell.measure.closeDimensionMenu': '关闭标注菜单',
  'shell.measure.cancelDimension': '取消{dimension}',
  'shell.measure.dimAligned': '对齐标注',
  'shell.measure.dimHorizontal': '水平标注',
  'shell.measure.dimVertical': '垂直标注',
  'shell.measure.dimRadius': '半径标注',
  'shell.measure.dimDiameter': '直径标注',
  'shell.measure.dimAngle': '角度标注',
  'shell.measure.deleteDimension': '删除标注',
  'shell.measure.deleteDimensionArmed': '删除标注（点击一个）',
  'shell.measure.deleteDimensionClickOne': '点击要删除的标注',
  'shell.measure.showHideDimensions': '显示/隐藏标注',
  'shell.measure.showOrHideAria': '显示或隐藏标注',
  'shell.measure.showDimensionsCount.one': '显示标注（{count}）',
  'shell.measure.showDimensionsCount.other': '显示标注（{count}）',
  'shell.measure.hideDimensionsCount.one': '隐藏标注（{count}）',
  'shell.measure.hideDimensionsCount.other': '隐藏标注（{count}）',

  'appearance.tooltip': '外观',
  'appearance.heading': '外观',
  'appearance.menuAria': '外观主题',
  'appearance.current': '外观：{name}',
  'appearance.darkLabel': '深色',
  'appearance.darkDetail': '适合弱光车间',
  'appearance.lightLabel': '浅色',
  'appearance.lightDetail': '仿绘图纸',
  'appearance.systemLabel': '跟随系统',
  'appearance.systemDetail': '匹配此设备',
  'appearance.customThemesHeading': '自定义主题',
  'appearance.darkFamily': '深色系',
  'appearance.lightFamily': '浅色系',
  'appearance.manageThemes': '管理主题…',
  'appearance.manageThemesDetail': '创建、编辑、导入、导出',

  'language.tooltip': '语言',
  'language.heading': '语言',
  'language.menuAria': '界面语言',
  'language.current': '语言：{name}',
  'language.customHeading': '自定义语言',

  'mobileBlocker.eyebrow': '仅支持桌面浏览器',
  'mobileBlocker.title': 'PureCutCNC 不支持在手机上使用。',
  'mobileBlocker.body': '浏览器版应用专为桌面尺寸的工作区设计，在手机屏幕上表现不佳。请使用桌面浏览器，或安装适用于 macOS、Windows 或 Linux 的桌面版。',
  'mobileBlocker.downloads': '桌面版下载',
  'mobileBlocker.website': '项目网站',

  'platform.confirmDiscard': '您有未保存的更改。要放弃更改并继续吗？',
  'platform.readProjectFailed': '读取项目文件失败。',
  'platform.openProjectFailed': '打开项目文件失败。',
  'platform.readFileError': '读取“{name}”失败。文件可能过大或无法访问。',
}
