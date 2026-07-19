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

import type { featureTreeEn } from '../en/featureTree'

/**
 * Simplified Chinese feature-tree translations. Typed as a complete record of
 * the English featureTree module's keys, so adding an English key without its
 * Chinese translation is a compile error — extraction and translation land
 * together. Terminology follows `src/i18n/GLOSSARY.md`; zh has no grammatical
 * plural, so `.one`/`.other` variants intentionally share one string.
 */
export const featureTreeZhCN: Record<keyof typeof featureTreeEn, string> = {
  // ── Tree section labels ──
  'featureTree.tree.project': '项目',
  'featureTree.tree.grid': '网格',
  'featureTree.tree.stock': '毛坯',
  'featureTree.tree.origin': '原点',
  'featureTree.tree.backdrop': '背景',
  'featureTree.tree.features': '特征',
  'featureTree.tree.regions': '区域',
  'featureTree.tree.construction': '构造',
  'featureTree.tree.tabs': '桥接',
  'featureTree.tree.clamps': '夹具',

  // ── Tree branch abbreviations ──
  'featureTree.tree.branch.project': '项',
  'featureTree.tree.branch.grid': '网',
  'featureTree.tree.branch.stock': '坯',
  'featureTree.tree.branch.origin': '原',
  'featureTree.tree.branch.backdrop': '背',
  'featureTree.tree.branch.features': '特',
  'featureTree.tree.branch.regions': '域',
  'featureTree.tree.branch.construction': '构',
  'featureTree.tree.branch.tabs': '桥',
  'featureTree.tree.branch.clamps': '夹',
  'featureTree.tree.branch.tab': '节',
  'featureTree.tree.branch.clamp': '节',
  'featureTree.tree.branch.feature': '节',

  // ── Tree empty states ──
  'featureTree.tree.empty.features': '暂无特征节点。',
  'featureTree.tree.empty.regions': '暂无区域。',
  'featureTree.tree.empty.construction': '暂无构造几何。',
  'featureTree.tree.empty.tabs': '暂无桥接。',
  'featureTree.tree.empty.clamps': '暂无夹具。',
  'featureTree.tree.empty.folder': '空文件夹。',

  // ── Tree warning ──
  'featureTree.tree.warning.firstFeaturePrefix': '⚠ 第一个 2.5D 特征必须是 ',
  'featureTree.tree.warning.firstFeatureSuffix': '。3D 模型在修复前无法构建。',

  // ── TreeRow: folder chevron ──
  'featureTree.treeRow.folder.expand': '展开文件夹',
  'featureTree.treeRow.folder.collapse': '折叠文件夹',

  // ── TreeRow: drag grip ──
  'featureTree.treeRow.grip.dragToReorder': '拖动以重新排序',

  // ── TreeRow: region badge ──
  'featureTree.treeRow.badge.region.include': '包含',
  'featureTree.treeRow.badge.region.exclude': '排除',
  'featureTree.treeRow.badge.region.includeTooltip': '包含区域 — 将此区域添加到当前区域遮罩中。',
  'featureTree.treeRow.badge.region.excludeTooltip': '排除区域 — 从当前区域遮罩中减去此区域。',

  // ── TreeRow: construction badge ──
  'featureTree.treeRow.badge.construction.label': '参考',
  'featureTree.treeRow.badge.construction.tooltip': '构造 — 草图参考几何。可对其捕捉、镜像和标注；不会被加工。',

  // ── TreeRow: linked-instance badge ──
  'featureTree.treeRow.badge.linked': '关联 — {count} 个实例共享此定义',

  // ── TreeRow: show / hide all ──
  'featureTree.treeRow.showAll.features': '显示所有特征',
  'featureTree.treeRow.showAll.regions': '显示所有区域',
  'featureTree.treeRow.showAll.construction': '显示所有构造几何',
  'featureTree.treeRow.showAll.tabs': '显示所有桥接',
  'featureTree.treeRow.showAll.clamps': '显示所有夹具',
  'featureTree.treeRow.hideAll.features': '隐藏所有特征',
  'featureTree.treeRow.hideAll.regions': '隐藏所有区域',
  'featureTree.treeRow.hideAll.construction': '隐藏所有构造几何',
  'featureTree.treeRow.hideAll.tabs': '隐藏所有桥接',
  'featureTree.treeRow.hideAll.clamps': '隐藏所有夹具',

  // ── TreeRow: add folder ──
  'featureTree.treeRow.addFolder.default': '添加文件夹',
  'featureTree.treeRow.addFolder.regions': '添加区域文件夹',
  'featureTree.treeRow.addFolder.construction': '添加构造文件夹',

  // ── TreeRow: add entry (tab / clamp) ──
  'featureTree.treeRow.addEntry.tab': '添加桥接',
  'featureTree.treeRow.addEntry.clamp': '添加夹具',

  // ── TreeRow: operation button tooltips ──
  'featureTree.treeRow.operation.lineClosedTooltip': '线条 — 闭合路径，可用于雕刻、轮廓和 V雕加工操作',
  'featureTree.treeRow.operation.lineOpenTooltip': '线条 — 开放轮廓（仅可在线条 ↔ 构造之间切换）',
  'featureTree.treeRow.operation.modelTooltip': '模型 — 导入的 3D 对象（已锁定）',
  'featureTree.treeRow.operation.addFirstSolidTooltip': '添加 — 首个实体（Subtract 不可用；转换为非实体角色以解锁）',
  'featureTree.treeRow.operation.addTooltip': '特征添加材料',
  'featureTree.treeRow.operation.subtractTooltip': '特征移除材料',
  'featureTree.treeRow.operation.constructionTooltip': '构造 — 草图参考几何（不会被加工）',
  'featureTree.treeRow.operation.regionTooltip': '区域 — 限制加工操作的作用范围（不会被加工）',
  'featureTree.treeRow.operation.modelLockedAria': '模型 — 操作已锁定',
  'featureTree.treeRow.operation.changeAria': '更改操作',

  // ── TreeRow: operation menu item labels ──
  'featureTree.operation.add': '添加',
  'featureTree.operation.subtract': '减去',
  'featureTree.operation.line': '线条',
  'featureTree.operation.region': '区域遮罩',
  'featureTree.operation.construction': '构造',

  // ── TreeRow: operation menu item tooltips ──
  'featureTree.treeRow.operation.menuLineOpenTooltip': '线条 — 开放路径，可通过雕刻操作加工',
  'featureTree.treeRow.operation.menuAddTooltip': '添加 — 特征添加材料',
  'featureTree.treeRow.operation.menuSubtractTooltip': '减去 — 特征移除材料',
  'featureTree.treeRow.operation.menuSubtractDisabledTooltip': 'Subtract 不可用 — 首个实体必须是 Add 或转换为非实体角色',
  'featureTree.treeRow.operation.menuLineClosedTooltip': '线条 — 闭合路径，可通过雕刻/轮廓操作加工',
  'featureTree.treeRow.operation.menuRegionTooltip': '区域遮罩 — 特征过滤加工操作',
  'featureTree.treeRow.operation.menuConstructionTooltip': '构造 — 草图参考几何，不会被加工',

  // ── TreeRow: other buttons ──
  'featureTree.treeRow.selectAllInFolder': '选中文件夹中的所有特征',
  'featureTree.treeRow.group': '成组特征',
  'featureTree.treeRow.ungroup': '取消成组',
  'featureTree.treeRow.editSketch': '编辑草图',
  'featureTree.treeRow.moreActions': '更多操作',
  'featureTree.treeRow.hideEntry': '隐藏条目',
  'featureTree.treeRow.showEntry': '显示条目',

  // ── Properties: common field labels ──
  'featureTree.properties.name': '名称',
  'featureTree.properties.units': '单位',
  'featureTree.properties.width': '宽度',
  'featureTree.properties.height': '高度',
  'featureTree.properties.thickness': '厚度',
  'featureTree.properties.color': '颜色',
  'featureTree.properties.visible': '可见',
  'featureTree.properties.locked': '锁定',
  'featureTree.properties.z': 'Z',
  'featureTree.properties.zTop': 'Z 顶',
  'featureTree.properties.zBottom': 'Z 底',
  'featureTree.properties.zRange': 'Z 范围',
  'featureTree.properties.image': '图像',
  'featureTree.properties.opacity': '不透明度',
  'featureTree.properties.angle': '角度',
  'featureTree.properties.folder': '文件夹',
  'featureTree.properties.folders': '文件夹',
  'featureTree.properties.features': '特征',
  'featureTree.properties.clamps': '夹具',
  'featureTree.properties.tabs': '桥接',
  'featureTree.properties.operation': '操作',
  'featureTree.properties.selection': '选择',
  'featureTree.properties.editSketch': '编辑草图',
  'featureTree.properties.text': '文本',
  'featureTree.properties.style': '样式',
  'featureTree.properties.font': '字体',
  'featureTree.properties.sourceFeature': '源特征',
  'featureTree.properties.expanded': '已展开',

  // ── Properties: project-specific ──
  'featureTree.properties.safeZ': '安全 Z',
  'featureTree.properties.opClearZ': '操作净空 Z',
  'featureTree.properties.clampClearXY': '夹具净空 XY',
  'featureTree.properties.clampClearZ': '夹具净空 Z',
  'featureTree.properties.machine': '机床',
  'featureTree.properties.gridExtent': '网格范围',
  'featureTree.properties.majorLines': '主刻度线',
  'featureTree.properties.minorLines': '次刻度线',
  'featureTree.properties.snapIncrement': '捕捉增量',
  'featureTree.properties.showFeatureInfo': '在草图中显示特征信息',

  // ── Properties: units ──
  'featureTree.properties.units.mm': '毫米',
  'featureTree.properties.units.inch': '英寸',

  // ── Properties: machine ──
  'featureTree.properties.machine.none': '无',
  'featureTree.properties.machine.refresh': '刷新机床定义',
  'featureTree.properties.machine.manage': '管理机床…',
  'featureTree.properties.machine.builtin': '内置',
  'featureTree.properties.machine.custom': '自定义',
  'featureTree.properties.machine.duplicateHint': '复制后编辑',

  // ── Properties: origin ──
  'featureTree.properties.origin.placeOrigin': '放置原点',
  'featureTree.properties.origin.presets': '预设',
  'featureTree.properties.origin.topLeft': '左上角',
  'featureTree.properties.origin.centerTop': '顶部居中',
  'featureTree.properties.origin.bottomLeft': '左下角',

  // ── Properties: stock ──
  'featureTree.properties.stock.editSketch': '编辑草图',
  'featureTree.properties.stock.resetToRect': '重置为矩形',
  'featureTree.properties.stock.nameDisabled': '毛坯',

  // ── Properties: backdrop ──
  'featureTree.properties.backdrop.noImage': '未加载图像',
  'featureTree.properties.backdrop.loadImage': '加载图像',
  'featureTree.properties.backdrop.replaceImage': '替换图像',
  'featureTree.properties.backdrop.loading': '正在加载图像…',
  'featureTree.properties.backdrop.move': '移动',
  'featureTree.properties.backdrop.resize': '调整大小',
  'featureTree.properties.backdrop.rotate': '旋转',
  'featureTree.properties.backdrop.delete': '删除',
  'featureTree.properties.backdrop.decoding': '正在解码背景图像…',
  'featureTree.properties.backdrop.mustBeImage': '背景必须是 PNG 或 JPEG 图像。',
  'featureTree.properties.backdrop.readFailed': '读取背景图像失败。',
  'featureTree.properties.backdrop.decodeFailed': '解码背景图像失败。',

  // ── Properties: single feature ──
  'featureTree.properties.shape': '形状',
  'featureTree.properties.shapeShared.one': '形状（与 {count} 个实例共享）',
  'featureTree.properties.shapeShared.other': '形状（与 {count} 个实例共享）',
  'featureTree.properties.instance': '实例',
  'featureTree.properties.expandText': '将文本展开为特征',
  'featureTree.properties.makeUnique': '设为唯一',
  'featureTree.properties.deleteFeature': '删除特征',
  'featureTree.properties.deleteSelected': '删除所选',
  'featureTree.properties.editSketchDisabledMulti': '多选时禁用',

  // ── Properties: multi-select ──
  'featureTree.properties.multi.group': '分组',
  'featureTree.properties.multi.ungroup': '取消分组',
  'featureTree.properties.multi.deleteGroup': '删除分组',
  'featureTree.properties.multi.featuresCount': '{count} 个特征',
  'featureTree.properties.multi.editSketchDisabled': '编辑草图仅适用于单个特征',
  'featureTree.properties.multi.openProfiles': '开放轮廓',
  'featureTree.properties.multi.containsModel': '包含模型特征',
  'featureTree.properties.multi.modelLockedTooltip': '模型条目无法在此更改操作类型',

  // ── Properties: select values ──
  'featureTree.properties.select.mixedFolders': '混合文件夹',
  'featureTree.properties.select.root': '根',
  'featureTree.properties.select.mixedOperations': '混合操作',
  'featureTree.properties.select.mixedModes': '混合模式',
  'featureTree.properties.select.mixedValues': '混合值',

  // ── Properties: operation select ──
  'featureTree.properties.operation.subtract': '减去',
  'featureTree.properties.operation.add': '添加',
  'featureTree.properties.operation.line': '线条',
  'featureTree.properties.operation.region': '区域遮罩',
  'featureTree.properties.operation.construction': '构造',
  'featureTree.properties.operation.model': '模型',
  'featureTree.properties.operation.modelLockedTooltip': '模型特征是导入的 3D 对象，无法更改操作类型',

  // ── Properties: mask mode ──
  'featureTree.properties.maskMode': '遮罩模式',
  'featureTree.properties.maskMode.include': '包含',
  'featureTree.properties.maskMode.exclude': '排除',

  // ── Properties: text feature ──
  'featureTree.properties.text.skeleton': '骨架',
  'featureTree.properties.text.outline': '轮廓',

  // ── Properties: Z locked fields ──
  'featureTree.properties.z.notMachined': '不加工',
  'featureTree.properties.z.notMachinedTooltip': '构造几何是草图参考 — 没有加工深度',
  'featureTree.properties.z.followsStock': '跟随毛坯（{thickness} 到 0）',
  'featureTree.properties.z.followsStockTooltip': '区域是贯穿毛坯的垂直过滤器；其 Z 范围自动跟随毛坯',

  // ── Properties: role notes ──
  'featureTree.properties.regionNote.badge': '遮罩',
  'featureTree.properties.regionNote.text': '区域是一种过滤器：它限制加工操作的作用范围，而非待加工的形状。',
  'featureTree.properties.constructionNote.badge': '参考',
  'featureTree.properties.constructionNote.text': '构造几何是草图参考：可对其捕捉、镜像和标注。不会被加工。',

  // ── Properties: warnings ──
  'featureTree.properties.warning.selfIntersect': '此轮廓自相交。3D/CAM 结果可能无效。',
  'featureTree.properties.warning.exceedsStock': '此轮廓超出毛坯边界。',

  // ── Properties: constraints ──
  'featureTree.properties.constraints.title': '约束',
  'featureTree.properties.constraints.delete': '删除约束',
  'featureTree.properties.constraints.type.intersect': '交',
  'featureTree.properties.constraints.type.perp': '垂',
  'featureTree.properties.constraints.type.line': '线',
  'featureTree.properties.constraints.type.midpt': '中',
  'featureTree.properties.constraints.type.center': '心',
  'featureTree.properties.constraints.type.point': '点',
  'featureTree.properties.constraints.tooltip.distanceIntersection': '到交点的距离',
  'featureTree.properties.constraints.tooltip.perpendicularSegment': '到线段的垂直距离',
  'featureTree.properties.constraints.tooltip.pointOnSegment': '到线段上点的距离（{percent}%）',
  'featureTree.properties.constraints.tooltip.segmentMidpoint': '到线段中点的距离',
  'featureTree.properties.constraints.tooltip.featureCenter': '到特征中心的距离',
  'featureTree.properties.constraints.tooltip.distanceVertex': '到顶点的距离',
  'featureTree.properties.constraints.tooltip.invalid': '无效',
  'featureTree.properties.constraints.world': '世界',

  // ── Properties: empty state ──
  'featureTree.properties.empty': '选择项目、网格、毛坯或树中的特征以编辑其属性。',

  // ── Properties: name disabled placeholders ──
  'featureTree.properties.name.grid': '网格',
  'featureTree.properties.name.features': '特征',
  'featureTree.properties.name.clamps': '夹具',
  'featureTree.properties.name.tabs': '桥接',

  // ── Properties: actions (folder/clamp/tab) ──
  'featureTree.properties.actions.addFolder': '添加文件夹',
  'featureTree.properties.actions.addTab': '添加桥接',
  'featureTree.properties.actions.addClamp': '添加夹具',
  'featureTree.properties.actions.deleteFolder': '删除文件夹',
  'featureTree.properties.actions.deleteClamp': '删除夹具',
  'featureTree.properties.actions.deleteTab': '删除桥接',

  // ── Context menu: top-level items ──
  'featureTree.contextMenu.makeUnique': '设为唯一',
  'featureTree.contextMenu.selectLinked': '选择关联实例',
  'featureTree.contextMenu.createOperation': '创建加工操作',
  'featureTree.contextMenu.editSketch': '编辑草图',
  'featureTree.contextMenu.addConstraint': '添加约束',
  'featureTree.contextMenu.copy': '复制',
  'featureTree.contextMenu.copySelected': '复制所选',
  'featureTree.contextMenu.copyGroup': '复制分组',
  'featureTree.contextMenu.move': '移动',
  'featureTree.contextMenu.moveSelected': '移动所选',
  'featureTree.contextMenu.moveGroup': '移动分组',
  'featureTree.contextMenu.resize': '调整大小',
  'featureTree.contextMenu.rotate': '旋转',
  'featureTree.contextMenu.mirror': '镜像',
  'featureTree.contextMenu.offset': '偏移',
  'featureTree.contextMenu.addToFolder': '添加到文件夹',
  'featureTree.contextMenu.createNewFolder': '新建…',
  'featureTree.contextMenu.group': '分组',
  'featureTree.contextMenu.join': '合并',
  'featureTree.contextMenu.cut': '切割',
  'featureTree.contextMenu.useAsStock': '设为毛坯',
  'featureTree.contextMenu.delete': '删除',
  'featureTree.contextMenu.deleteSelected': '删除所选',
  'featureTree.contextMenu.deleteGroup': '删除分组',

  // ── Context menu: tooltips ──
  'featureTree.contextMenu.lockedTooltip': '锁定的特征无法移动',
  'featureTree.contextMenu.groupDisabledTooltip': '选择两个或更多特征以分组',
  'featureTree.contextMenu.sectionsMixedTooltip': '特征、区域和构造几何只能与同类成组',
  'featureTree.contextMenu.addToFolderMixedTooltip': '特征、区域和构造几何各有独立文件夹 — 请选择一种类型',
  'featureTree.contextMenu.joinDisabledTooltip': '选择两个或更多特征以合并',
  'featureTree.contextMenu.useAsStockDisabledTooltip': '特征必须是闭合轮廓的添加操作',

  // ── Z-range slider ──
  'featureTree.zRange.zTop': 'Z 顶',
  'featureTree.zRange.zBottom': 'Z 底',
  'featureTree.zRange.handleTopAria': 'Z 顶滑块',
  'featureTree.zRange.handleBottomAria': 'Z 底滑块',
}
