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

import type { languageManagerEn } from '../en/languageManager'

/** 语言管理器与自定义语言编辑器文案。 */
export const languageManagerZhCN: Record<keyof typeof languageManagerEn, string> = {
  'langManager.manageEntry': '管理语言…',
  'langManager.manageDetail': '创建、编辑、导入、导出',
  'langManager.title': '管理语言',
  'langManager.builtinBadge': '内置',
  'langManager.customBadge': '自定义',
  'langManager.progress': '已翻译 {translated} / {total}',
  'langManager.activeBadge': '当前使用',
  'langManager.use': '使用此语言',
  'langManager.duplicate': '复制并编辑',
  'langManager.duplicateHint': '复制英语将从零开始创建新语言；复制其他语言将从其现有翻译开始。',
  'langManager.edit': '编辑',
  'langManager.rename': '重命名',
  'langManager.renameLabel': '语言名称',
  'langManager.saveName': '保存名称',
  'langManager.export': '导出语言',
  'langManager.import': '导入语言',
  'langManager.delete': '删除语言',
  'langManager.done': '完成',
  'langManager.close': '关闭',
  'langManager.baseLabel': '基于',
  'langManager.tagLabel': '语言标签',
  'langManager.importFailed': '导入失败：{error}',
  'langManager.imported': '已导入“{name}”。',
  'langManager.importPlaceholderIssues.one': '已导入“{name}”，存在 {count} 处占位符不匹配 — 请打开编辑器检查。',
  'langManager.importPlaceholderIssues.other': '已导入“{name}”，存在 {count} 处占位符不匹配 — 请打开编辑器检查。',
  'langManager.deleted': '已删除“{name}”。',

  'langEditor.title': '编辑语言 — {name}',
  'langEditor.nameLabel': '语言名称',
  'langEditor.tagLabel': 'BCP-47 语言标签',
  'langEditor.tagHint': '决定文档语言属性和复数规则（例如 "de"、"pt-BR"）。',
  'langEditor.tagInvalid': '请输入有效的 BCP-47 标签，例如 "de" 或 "pt-BR"。',
  'langEditor.progress': '已翻译 {translated} / {total}',
  'langEditor.searchPlaceholder': '搜索键名和文本…',
  'langEditor.filterLabel': '显示',
  'langEditor.filterAll': '全部字符串',
  'langEditor.filterUntranslated': '仅未翻译',
  'langEditor.filterEdited': '仅已编辑',
  'langEditor.sourceLabel': '英语',
  'langEditor.baseLabel': '基础语言（{base}）',
  'langEditor.inputPlaceholder': '未翻译 — 将回退到基础语言',
  'langEditor.placeholderIssue': '占位符必须与英文原文完全一致：应为 {expected}。',
  'langEditor.placeholderIssuesBlockApply.one': '{count} 条翻译存在占位符不匹配 — 请修复后再应用。',
  'langEditor.placeholderIssuesBlockApply.other': '{count} 条翻译存在占位符不匹配 — 请修复后再应用。',
  'langEditor.resetKey': '重置',
  'langEditor.preview': '在应用中预览',
  'langEditor.previewing': '预览中 — 取消将恢复已保存的版本',
  'langEditor.apply': '应用',
  'langEditor.cancel': '取消',
  'langEditor.noMatches': '没有符合当前搜索和筛选条件的字符串。',
  'langEditor.sectionCount': '{translated}/{total}',
}
