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

import type { sketchEn } from '../en/sketch'

/**
 * Simplified Chinese sketch-surface translations. Typed as a complete record of
 * the English sketch module's keys, so adding an English key without its Chinese
 * translation is a compile error — extraction and translation land together.
 * Terminology follows `src/i18n/GLOSSARY.md`; zh has no grammatical plural, so
 * `.one`/`.other` variants intentionally share one string.
 */
export const sketchZhCN: Record<keyof typeof sketchEn, string> = {
  'sketch.target.createFeatures': '创建特征',
  'sketch.target.createLines': '创建线条',
  'sketch.target.createRegions': '创建区域',
  'sketch.target.createConstruction': '创建构造线',
  'sketch.target.feature': '特征',
  'sketch.target.line': '线条',
  'sketch.target.region': '区域',
  'sketch.target.construction': '构造线',

  'sketch.shape.rectangle': '矩形',
  'sketch.shape.circle': '圆形',
  'sketch.shape.ellipse': '椭圆',
  'sketch.shape.polygon': '多边形',
  'sketch.shape.spline': '样条曲线',
  'sketch.shape.composite': '复合形状',
  'sketch.shape.text': '文字',
  'sketch.shape.slot': '槽孔',
  'sketch.shape.regularPolygon': '正多边形',
  'sketch.shape.gear': '齿轮',
  'sketch.shape.roundedRect': '圆角矩形',
  'sketch.shape.chamferedRect': '倒角矩形',

  'sketch.creation.addShape': '添加{target}{shape}',
  'sketch.creation.cancel': '取消{shape}',
  'sketch.creation.cancelTool': '取消{shape}工具',
  'sketch.creation.chooseTarget': '选择{target}形状',
  'sketch.creation.closeDrawer': '关闭形状抽屉',

  'sketch.transform.copy': '复制所选特征',
  'sketch.transform.cancelCopy': '取消复制',
  'sketch.transform.move': '移动所选特征',
  'sketch.transform.cancelMove': '取消移动',
  'sketch.transform.delete': '删除所选特征',
  'sketch.transform.resize': '缩放所选特征',
  'sketch.transform.cancelResize': '取消缩放',
  'sketch.transform.rotate': '旋转所选特征',
  'sketch.transform.cancelRotate': '取消旋转',
  'sketch.transform.mirror': '镜像所选特征',
  'sketch.transform.cancelMirror': '取消镜像',

  'sketch.boolean.join': '合并闭合特征',
  'sketch.boolean.cancelJoin': '取消合并',
  'sketch.boolean.cut': '切割特征',
  'sketch.boolean.cancelCut': '取消切割',
  'sketch.boolean.offset': '创建偏移特征',
  'sketch.boolean.cancelOffset': '取消偏移',

  'sketch.arrange.align': '对齐所选特征',
  'sketch.arrange.distribute': '分布所选特征',
  'sketch.arrange.closeAlignMenu': '关闭对齐菜单',
  'sketch.arrange.closeDistributeMenu': '关闭分布菜单',

  'sketch.edit.addPoint': '添加点',
  'sketch.edit.cancelAddPoint': '取消添加点',
  'sketch.edit.deletePoint': '删除点',
  'sketch.edit.cancelDeletePoint': '取消删除点',
  'sketch.edit.deleteSegment': '删除线段',
  'sketch.edit.cancelDeleteSegment': '取消删除线段',
  'sketch.edit.disconnect': '断开连接',
  'sketch.edit.cancelDisconnect': '取消断开连接',
  'sketch.edit.fillet': '圆角',
  'sketch.edit.cancelFillet': '取消圆角',
  'sketch.edit.chamfer': '倒角',
  'sketch.edit.cancelChamfer': '取消倒角',
  'sketch.edit.trim': '修剪至切割边',
  'sketch.edit.cancelTrim': '取消修剪',
  'sketch.edit.trimDisabled': '修剪 — 仅限开口轮廓',
  'sketch.edit.extend': '延伸至目标',
  'sketch.edit.cancelExtend': '取消延伸',
  'sketch.edit.extendDisabled': '延伸 — 仅限开口轮廓',

  'sketch.constraint.add': '添加约束',
  'sketch.constraint.cancel': '取消约束',

  'sketch.align.left': '左对齐',
  'sketch.align.centerHorizontal': '水平居中',
  'sketch.align.right': '右对齐',
  'sketch.align.top': '顶部对齐',
  'sketch.align.centerVertical': '垂直居中',
  'sketch.align.bottom': '底部对齐',

  'sketch.distribute.horizontalGaps': '水平分布（等间距）',
  'sketch.distribute.horizontalCenters': '水平分布（等中心距）',
  'sketch.distribute.verticalGaps': '垂直分布（等间距）',
  'sketch.distribute.verticalCenters': '垂直分布（等中心距）',

  'sketch.backdrop.move': '移动背景图',
  'sketch.backdrop.cancelMove': '取消移动背景图',
  'sketch.backdrop.delete': '删除背景图',
  'sketch.backdrop.resize': '缩放背景图',
  'sketch.backdrop.cancelResize': '取消缩放背景图',
  'sketch.backdrop.rotate': '旋转背景图',
  'sketch.backdrop.cancelRotate': '取消旋转背景图',
}
