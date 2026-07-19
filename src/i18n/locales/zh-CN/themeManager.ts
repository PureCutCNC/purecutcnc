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

import type { themeManagerEn } from '../en/themeManager'

/** 主题管理器、主题编辑器与预览样例文案。 */
export const themeManagerZhCN: Record<keyof typeof themeManagerEn, string> = {
  'themeManager.dialogAria': '管理主题',
  'themeManager.title': '管理主题',
  'themeManager.close': '关闭',
  'themeManager.listAria': '主题',
  'themeManager.builtinBadge': '内置',
  'themeManager.customBadge': '自定义',
  'themeManager.activeBadge': '当前使用',
  'themeManager.nameLabel': '主题名称',
  'themeManager.saveName': '保存名称',
  'themeManager.familyLabel': '色系',
  'themeManager.basedOnLabel': '基于',
  'themeManager.changedColorsLabel': '已修改颜色',
  'themeManager.builtinHint': '内置主题为只读。复制后即可编辑。',
  'themeManager.resetNotice': '已将“{name}”重置为其 {base} 基础配色。',
  'themeManager.importFailed': '导入失败：{error}',
  'themeManager.imported': '已导入“{name}”。',
  'themeManager.use': '使用此主题',
  'themeManager.edit': '编辑',
  'themeManager.duplicateToEdit': '复制并编辑',
  'themeManager.duplicate': '复制',
  'themeManager.rename': '重命名',
  'themeManager.resetToBase': '重置为基础配色',
  'themeManager.import': '导入主题',
  'themeManager.export': '导出主题',
  'themeManager.delete': '删除主题',
  'themeManager.systemAria': '系统模式配对',
  'themeManager.modeTitle': '模式',
  'themeManager.fixedMode': '固定主题',
  'themeManager.systemMode': '跟随系统深色/浅色',
  'themeManager.lightSlot': '浅色主题',
  'themeManager.darkSlot': '深色主题',
  'themeManager.systemPrefersDark': '此设备当前偏好深色模式。',
  'themeManager.systemPrefersLight': '此设备当前偏好浅色模式。',
  'themeManager.done': '完成',

  'themeEditor.title': '编辑主题',
  'themeEditor.dialogAria': '编辑主题 {name}',
  'themeEditor.previewingLive': '正在实时预览你的编辑。',
  'themeEditor.colorsWrong': '颜色显示异常？',
  'themeEditor.restoreSaved': '恢复已保存的颜色',
  'themeEditor.basedOn.one': '基于 {base} · 已修改 {count} 项颜色',
  'themeEditor.basedOn.other': '基于 {base} · 已修改 {count} 项颜色',
  'themeEditor.contrastAria': '对比度检查',
  'themeEditor.contrastTitle': '可读性检查',
  'themeEditor.allChecksPass': '全部 {count} 项检查通过。',
  'themeEditor.blockedLabel': '已阻止：',
  'themeEditor.warningLabel': '警告：',
  'themeEditor.ratioNeeds': '{measured}:1，需要 {required}:1',
  'themeEditor.deltaNeeds': 'ΔE {measured}，需要 {required}',
  'themeEditor.ratioRecommended': '{measured}:1，建议 {required}:1',
  'themeEditor.deltaRecommended': 'ΔE {measured}，建议 {required}',
  'themeEditor.contrastNote': '对代表性状态的自动抽查 — 并非完整的 WCAG 覆盖。',
  'themeEditor.checksFailing.one': '{count} 项可读性检查未通过',
  'themeEditor.checksFailing.other': '{count} 项可读性检查未通过',
  'themeEditor.cancel': '取消',
  'themeEditor.apply': '应用主题',
  'themeEditor.fixBlockedTitle': '请先修复被阻止的可读性检查，然后再应用',
  'themeEditor.giveNameTitle': '请为主题命名',
  'themeEditor.colorPickerAria': '{label} 颜色选择器',
  'themeEditor.baseValueTitle': '基础值：{value}',
  'themeEditor.resetFieldAria': '将 {label} 重置为基础值',
  'themeEditor.resetFieldTitle': '重置为基础值（{value}）',

  'themePreview.panelTitle': '面板与文本',
  'themePreview.panelText': '面板表面上的主要文本。',
  'themePreview.panelTextDim': '用于提示的弱化辅助文本。',
  'themePreview.controlsTitle': '控件',
  'themePreview.primary': '主要',
  'themePreview.secondary': '次要',
  'themePreview.disabled': '已禁用',
  'themePreview.selectedItem': '选中项',
  'themePreview.focusedControl': '获得焦点的控件',
  'themePreview.messagesTitle': '消息',
  'themePreview.positive': '成功：刀路已生成。',
  'themePreview.warning': '警告：每刀切深过浅。',
  'themePreview.danger': '危险：检测到压板碰撞。',
  'themePreview.canvasTitle': '草图画布',
  'themePreview.legendLine': '线条',
  'themePreview.legendRegion': '区域',
  'themePreview.legendConstruction': '构造',
  'themePreview.legendAdd': '添加',
  'themePreview.legendCut': '切割',
}
