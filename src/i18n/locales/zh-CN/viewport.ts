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

import type { viewportEn } from '../en/viewport'

/**
 * Simplified Chinese viewport translations. Typed as a complete record of the
 * English viewport module's keys, so adding an English key without its Chinese
 * translation is a compile error — extraction and translation land together.
 * Terminology follows `src/i18n/GLOSSARY.md`; zh has no grammatical plural, so
 * `.one`/`.other` variants intentionally share one string.
 */
export const viewportZhCN: Record<keyof typeof viewportEn, string> = {
  'viewport.presets.top': '俯视图',
  'viewport.presets.bottom': '仰视图',
  'viewport.presets.front': '前视图',
  'viewport.presets.back': '后视图',
  'viewport.presets.right': '右视图',
  'viewport.presets.left': '左视图',
  'viewport.presets.iso': '等轴测视图',

  'viewport.sim.modeLabel': '仿真模式',
  'viewport.sim.modeSelected': '已选中',
  'viewport.sim.modeVisible': '可见',
  'viewport.sim.detailLabel': '细节',
  'viewport.sim.detailTitle': '仿真细节',
  'viewport.sim.playTool': '播放刀具',
  'viewport.sim.playToolDisabledMode': '切换到"已选中"模式以使用刀具播放',
  'viewport.sim.playToolDisabledNoOp': '选择一个有有效刀路的操作来播放',
  'viewport.sim.playToolToggle': '切换刀具播放',
  'viewport.sim.webglUnavailableTitle': '3D 仿真不可用',
  'viewport.sim.webglUnavailableBody': '此视图需要 WebGL2，但您的浏览器或显卡驱动未提供。请尝试更新浏览器或在设置中启用硬件加速。',
  'viewport.sim.webglLostTitle': '3D 图形上下文丢失',
  'viewport.sim.webglLostBody': '正在等待浏览器恢复 — 播放已暂停。如果此消息持续显示，请重新加载应用。',
  'viewport.sim.play': '播放',
  'viewport.sim.pause': '暂停',
  'viewport.sim.stop': '停止并重置',
  'viewport.sim.progressAria': '播放进度',
  'viewport.sim.speedLabel': '速度',
  'viewport.sim.speedTooltipFeed': '操作进给速度倍数（{feed} = 1×）。当前：{multiplier}',
  'viewport.sim.speedTooltipFallback': '默认进给速度倍数（{feed} = 1×）。当前：{multiplier}',
  'viewport.sim.speedAria': '播放速度倍数',
  'viewport.sim.stepLabel': '步长',
  'viewport.sim.stepTooltip': '刀具每帧移动的最大距离。越小运动越平滑，越大播放越快。',
  'viewport.sim.feedTooltip': '当前移动的切削进给。缩小的槽切会在此显示其缩放后的进给；颜色点标记移动类型（快速移动无进给）。',
  'viewport.sim.moveKindIdle': '空闲',

  'viewport.about.ariaLabel': '关于 PureCutCNC',
  'viewport.about.title': '关于',
  'viewport.about.close': '关闭',
  'viewport.about.version': '版本 {version}',
  'viewport.about.tagline': '面向 CNC 爱好者的 2.5D CAD/CAM — 在网页或桌面上，将草图与加工融为一个工作流程。',
  'viewport.about.releaseLabel': '发布',
  'viewport.about.releasedLabel': '发布日期',
  'viewport.about.website': '网站',
  'viewport.about.source': '源码',
  'viewport.about.releases': '发布记录',
  'viewport.about.license': '许可证（Apache-2.0）',
  'viewport.about.supportText': 'PureCutCNC 始终免费 — 但开发和维护需要实际的时间和金钱。如果它对您有帮助，一杯咖啡就能让它持续下去。',
  'viewport.about.buyCoffee': '请开发者喝杯咖啡',

  'viewport.empty.title': '开始设计零件',
  'viewport.empty.subtitle': '绘制形状、导入文件或打开一个成品示例，查看完整的工作流程。',
  'viewport.empty.drawTitle': '绘制形状',
  'viewport.empty.drawMeta': '在画布上绘制一个矩形',
  'viewport.empty.importTitle': '导入文件',
  'viewport.empty.importMeta': 'SVG、DXF、OBJ、STL 或 CAMJ 文件',
  'viewport.empty.examplesLabel': '打开示例…',

  'viewport.error.eyebrow': '出了些问题',
  'viewport.error.title': '抱歉 — PureCutCNC 无法在此设备上启动。',
  'viewport.error.body': '这通常意味着您的浏览器或操作系统不支持该应用所需的 3D 图形功能。请尝试在较新的台式机或平板上使用最新版本的 Chrome、Edge 或 Firefox，或使用我们的桌面版。',
  'viewport.error.showDetails': '显示技术详情',
  'viewport.error.reload': '重新加载',
  'viewport.error.desktopDownloads': '桌面版下载',
  'viewport.error.projectWebsite': '项目网站',

  'viewport.error.userAgent': '用户代理：',
  'viewport.error.timestamp': '时间戳：',
}
