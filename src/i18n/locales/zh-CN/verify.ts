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

import type { verifyEn } from '../en/verify'

/** Simplified Chinese Verify mode translations (issue #1269). */
export const verifyZhCN: Record<keyof typeof verifyEn, string> = {
  'verify.mode': '校验',
  'verify.modeTitle': '校验路径：比较模型、内部刀路和导出程序',
  'verify.panelLabel': '校验导出路径',
  'verify.comparisonLabel': '比较',
  'verify.comparison.modelInternal': '模型 ↔ 内部',
  'verify.comparison.modelExported': '模型 ↔ 导出',
  'verify.comparison.internalExported': '内部 ↔ 导出',
  'verify.comparisonHint.modelInternal': '由生成的刀路切削的毛坯，与模型比较。',
  'verify.comparisonHint.modelExported': '由导出程序（回读）切削的毛坯，与模型比较。',
  'verify.comparisonHint.internalExported': '导出程序与生成的刀路比较。',
  'verify.scopeUpto': '截至 {operation} 的所有可见操作',
  'verify.scopeAll': '{setup} 的所有可见操作',
  'verify.run': '运行校验',
  'verify.cancel': '取消',
  'verify.running': '正在校验… 第 {done} / {total} 项',
  'verify.idle': '校验仅在您要求时运行。请选择一种比较并运行。',
  'verify.failed': '校验未能完成。请重试；详细信息见控制台。',
  'verify.stale.projectEdited': '已过期：此结果之后项目已更改。请重新运行校验以更新。',
  'verify.stale.requestChanged': '已过期：此结果属于其他比较、操作、装夹或精度。请重新运行校验以更新。',
  'verify.summary': '{verified} 项已校验 · {deviation} 项有偏差 · {unverified} 项未校验',
  'verify.runUnverified': '未校验：{reason}',
  'verify.resultsLabel': '校验结果',
  'verify.legendLabel': '颜色图例',
  'verify.verdict.verified': '已校验',
  'verify.verdict.deviation': '偏差',
  'verify.verdict.unverified': '未校验',
  'verify.kind.gouge': '过切',
  'verify.kind.intendedLeftover': '预留余量',
  'verify.kind.unintendedLeftover': '非预期残料',
  'verify.kind.missingCut': '缺失切削',
  'verify.kind.extraCut': '多余切削',
  'verify.kind.feed': '进给',
  'verify.kind.unverified': '未校验的操作',
  'verify.findingRegion': '{area} · 最大 {size}',
  'verify.findingDistance': '距另一路径 {size}',
  'verify.findingNoCounterpart': '另一路径上没有对应的切削',
  'verify.findingFeed': '进给 {actual}，应为 {expected}',
  'verify.findingFeedMissing': '未给出进给；应为 {expected}',
  'verify.moreDeviations': '另有 {count} 处偏差未列出',
  'verify.noFindings': '无偏差',
  'verify.unattributed': '没有任何操作切削的材料',
  'verify.findingFocus': '在视图中显示',
  'verify.reasonAtLine': '{reason}（第 {line} 行）',
  'verify.reason.aroundSetup': '环绕装夹暂不与模型比较',
  'verify.reason.rotaryOperation': '旋转操作暂不与模型比较',
  'verify.reason.rotaryMotion': '某个移动在切削时转动旋转轴',
  'verify.reason.unsupportedSetup': '无法加工此装夹方向',
  'verify.reason.uptoOperationNotFound': '所选操作没有可回放的内容',
  'verify.reason.noModel': '项目没有可比较的模型',
  'verify.reason.exportUnsupported': '导出程序包含无法回读的结构',
  'verify.reason.exportFailed': '无法生成或回读程序',
  'verify.reason.noCutMoves': '两条路径都没有切削移动',
  'verify.reason.unparsedText': '程序包含非 G 代码文本',
  'verify.reason.unsupportedCommand': '无法重建 {command} 的运动',
  'verify.reason.machineCoordinateRetract': '机床坐标退刀（G53）',
  'verify.reason.machineCoordinateMove': '不是退刀的机床坐标移动',
  'verify.reason.rapidAfterMachineRetract': 'G53 退刀后的快速移动未给出 Z',
  'verify.reason.workZUnknown': 'G53 退刀后的进给移动未给出 Z',
  'verify.reason.motionWithoutMode': '在设置任何运动模式之前出现坐标',
  'verify.reason.inverseTimeFeedMissing': '反时进给移动缺少自己的 F',
  'verify.reason.arcCentreMissing': '圆弧缺少圆心或半径',
  'verify.reason.arcRadiusTooSmall': '圆弧半径不足以连接其端点',
  'verify.reason.cannedCycleIncomplete': '固定循环缺少所需的 Z、R 或 Q',
  'verify.reason.cannedCycleWithRotary': '固定循环同时转动旋转轴',
  'verify.reason.cannedRetractModeAssumed': '固定循环前没有 G98/G99；按 G98 处理',
  'verify.reason.chipBreakRetractApproximate': '断屑退刀按近似方式读取',
  'verify.reason.probeMove': '探测移动',
  'verify.reason.touchOffZ': 'Z 对刀',
  'verify.reason.rotaryZeroed': '程序中将旋转轴归零',
  'verify.reason.workOffsetChange': '程序中更改了工件坐标系',
  'verify.reason.parseFailure': '无法读取程序',
  'verify.reason.unsupportedStatement': '无法重建的语句',
  'verify.reason.emptyProgram': '后处理器未写出程序',
  'verify.reason.operationRefused': '后处理器拒绝了该操作',
  'verify.reason.postFailed': '后处理器失败',
  'verify.reason.noTool': '该操作没有可用刀具',
  'verify.reason.axisNotStated': '程序从未给出 {axis} 轴',
  'verify.reason.manualIndexTurnRemoved': '手动分度的初始转动已从角度中移除',
  'verify.reason.noToolpath': '无法生成其刀路',
  'verify.reason.noMachine': '导出未选择机床',
  'verify.reason.noOperations': '截至所选操作没有带刀路的可见操作',
}
