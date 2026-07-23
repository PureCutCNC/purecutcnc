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

import type { camEn } from '../en/cam'

/**
 * Simplified Chinese CAM translations. Typed as a complete record of the
 * English cam module's keys, so adding an English key without its Chinese
 * translation is a compile error — extraction and translation land together.
 * Terminology follows `src/i18n/GLOSSARY.md`; zh has no grammatical plural, so
 * `.one`/`.other` variants intentionally share one string.
 */
export const camZhCN: Record<keyof typeof camEn, string> = {
  // ── Tool type labels ──
  'cam.toolType.flatEndmill': '平底立铣刀',
  'cam.toolType.ballEndmill': '球头立铣刀',
  'cam.toolType.vBit': 'V形刀',
  'cam.toolType.drill': '钻头',

  // ── Drill type labels ──
  'cam.drillType.simple': '简单（G81）',
  'cam.drillType.peck': '啄钻（G83）',
  'cam.drillType.dwell': '暂停（G82）',
  'cam.drillType.chipBreaking': '断屑（G73）',

  // ── Operation kind labels ──
  'cam.opLabel.pocket': '挖槽',
  'cam.opLabel.vCarve': 'V雕（偏移）',
  'cam.opLabel.vCarveMedial': 'V雕（中轴）',
  'cam.opLabel.edgeRouteInside': '内缘走刀',
  'cam.opLabel.edgeRouteOutside': '外缘走刀',
  'cam.opLabel.surfaceClean': '表面清理',
  'cam.opLabel.roughSurface': '3D 曲面粗加工',
  'cam.opLabel.finishSurface': '3D 曲面精加工',
  'cam.opLabel.finishSurfaceCleanup': '3D 曲面清理',
  'cam.opLabel.followLine': '雕刻',
  'cam.opLabel.drilling': '钻孔',

  // ── Operation button labels ──
  'cam.opButton.pocket': '挖槽',
  'cam.opButton.vCarve': 'V雕（偏移）',
  'cam.opButton.vCarveMedial': 'V雕（中轴）',
  'cam.opButton.edgeIn': '内缘',
  'cam.opButton.edgeOut': '外缘',
  'cam.opButton.surface': '表面',
  'cam.opButton.roughSurface': '3D 曲面粗',
  'cam.opButton.finishSurface': '3D 曲面精',
  'cam.opButton.finishSurfaceCleanup': '3D 曲面清理',
  'cam.opButton.engrave': '雕刻',
  'cam.opButton.drill': '钻孔',

  // ── Quick operation labels ──
  'cam.quickOp.pocket': '创建挖槽',
  'cam.quickOp.edgeRouteInside': '创建内缘走刀',
  'cam.quickOp.edgeRouteOutside': '创建外缘走刀',
  'cam.quickOp.vCarve': '创建 V雕（偏移）',
  'cam.quickOp.vCarveMedial': '创建 V雕（中轴）',
  'cam.quickOp.surfaceClean': '创建表面清理',
  'cam.quickOp.followLine': '创建雕刻',
  'cam.quickOp.drilling': '创建钻孔',
  'cam.quickOp.roughSurface': '创建曲面粗加工',
  'cam.quickOp.finishSurface': '创建曲面精加工',
  'cam.quickOp.finishSurfaceCleanup': '创建曲面清理',

  // ── Pocket pattern labels ──
  'cam.pocketPattern.offset': '偏移',
  'cam.pocketPattern.parallel': '平行',
  'cam.pocketPattern.waterline': '水平线',

  // ── Pass labels ──
  'cam.pass.rough': '粗加工',
  'cam.pass.finish': '精加工',

  // ── Panel chrome ──
  'cam.panel.emptyOperation': '选择一个加工操作以编辑其参数。',
  'cam.panel.emptyTool': '选择一把刀具以编辑其属性。',
  'cam.panel.operations': '加工操作',
  'cam.panel.tools': '刀具',
  'cam.panel.operationsEmpty':
    '选择兼容的图形，然后添加加工操作。挖槽和内缘走刀需要减法特征。外缘走刀需要加法特征。表面清理接受加法特征。',
  'cam.panel.cam': 'CAM',
  'cam.panel.properties': '属性',
  'cam.panel.export': '导出',
  'cam.panel.add': '添加',
  'cam.panel.addHint': '请先选择图形，然后选择加工操作类型',
  'cam.panel.showAllToolpaths': '显示所有刀路',
  'cam.panel.hideAllToolpaths': '隐藏所有刀路',
  'cam.panel.exportGcodeForOperation': '导出此操作的 G代码',
  'cam.panel.exportGcodeForSelected': '导出所选操作的 G代码',
  'cam.panel.exportGcodeFor': '导出 {name} 的 G代码',
  'cam.panel.expandOperationProps': '展开操作属性',
  'cam.panel.expandToolProps': '展开刀具属性',
  'cam.panel.operationProperties': '操作属性',
  'cam.panel.toolProperties': '刀具属性',
  'cam.panel.close': '关闭',

  // ── Operation property labels ──
  'cam.operation.name': '名称',
  'cam.operation.description': '描述',
  'cam.operation.kind': '类型',
  'cam.operation.pass': '工序',
  'cam.operation.maxCarveDepth': '最大雕刻深度',
  'cam.operation.carveDepth': '雕刻深度',
  'cam.operation.target': '目标',
  'cam.operation.targetSource': '目标来源',
  'cam.operation.useCurrentSelection': '使用当前选择',
  'cam.operation.targetUpdated': '✓ 目标已更新',
  'cam.operation.restMachining': '残料加工',
  'cam.operation.createRestOp': '创建残料操作',
  'cam.operation.booklet': '加工手册',
  'cam.operation.exportPdf': '导出 PDF',
  'cam.operation.exporting': '导出中…',
  'cam.operation.toolpathWarnings': '刀路警告',
  'cam.operation.tool': '刀具',
  'cam.operation.noTool': '无刀具',
  'cam.operation.enabled': '启用',
  'cam.operation.stepdown': '下刀步距',
  'cam.operation.contourSpacing': '轮廓间距',
  'cam.operation.stepoverRatio': '横向步距比',
  'cam.operation.advanced': '高级',
  'cam.operation.pattern': '模式',
  'cam.operation.angle': '角度',
  'cam.operation.cutDirection': '切削方向',
  'cam.operation.conventional': '逆铣',
  'cam.operation.climb': '顺铣',
  'cam.operation.machiningOrder': '加工顺序',
  'cam.operation.featureFirst': '按特征',
  'cam.operation.levelFirst': '按层',
  'cam.operation.roundOutsideCorners': '圆角拐角',
  'cam.operation.drillType': '钻孔类型',
  'cam.operation.peckDepth': '啄钻深度',
  'cam.operation.dwellTime': '暂停时间（秒）',
  'cam.operation.retractHeight': '退刀高度',
  'cam.operation.finishWalls': '精修侧壁',
  'cam.operation.finishFloor': '精修底面',
  'cam.operation.debugToolpath': '调试刀路',
  'cam.operation.feed': '进给',
  'cam.operation.plungeFeed': '插铣进给',
  'cam.operation.slotFeed': '满刀进给（%）',
  'cam.operation.slotFeedTooltip':
    '满刀切削时的进给百分比：每段最内层环、未清理的交叉区域、平行边界通道和第一条填充线。100 表示不降低进给。',
  'cam.operation.rpm': '转速',
  'cam.operation.stockToLeaveRadial': '径向余量',
  'cam.operation.stockToLeaveAxial': '轴向余量',
  'cam.operation.adaptiveRefinement': '自适应细化',
  'cam.operation.adaptiveRefinementTooltip': '在浅坡面和模型尖端添加投影水平环。',
  'cam.operation.adaptiveSpacing': '自适应间距',
  'cam.operation.adaptiveSpacingTooltip': '投影环间距（项目单位）。',
  'cam.operation.maxRingsBand': '最大环数/层',
  'cam.operation.maxRingsTooltip': '单个带或尖端中的最大投影环数。使用 0 表示默认上限。',
  'cam.operation.tabs': '桥接',
  'cam.operation.autoPlaceTabs': '自动放置桥接',
  'cam.operation.arcFitting': '圆弧拟合 (G2/G3)',
  'cam.operation.arcFittingTip':
    '仅导出：在控制器支持时将接近共线的线性移动替换为圆弧移动。不影响显示或模拟的刀路。',

  // ── Region note ──
  'cam.regionNote.badge': '掩膜',
  'cam.regionNote.text': '区域用于限制操作可切削的范围——不是要加工的几何体。',

  // ── Operation target summary ──
  'cam.target.stock': '毛坯',
  'cam.target.noFeatures': '无特征',
  'cam.target.noMachiningTarget': '无加工目标',
  'cam.target.filters': '{machiningSummary}；过滤器：{regionNames}',

  // ── Tool property labels ──
  'cam.tool.name': '名称',
  'cam.tool.type': '类型',
  'cam.tool.units': '单位',
  'cam.tool.unitsMm': '毫米',
  'cam.tool.unitsInch': '英寸',
  'cam.tool.diameter': '直径',
  'cam.tool.vAngle': 'V形角',
  'cam.tool.flutes': '刃数',
  'cam.tool.material': '材质',
  'cam.tool.materialCarbide': '硬质合金',
  'cam.tool.materialHss': '高速钢',
  'cam.tool.defaultRpm': '默认转速',
  'cam.tool.defaultFeed': '默认进给',
  'cam.tool.plungeFeed': '插铣进给',
  'cam.tool.stepdown': '下刀步距',
  'cam.tool.maxCutDepth': '最大切削深度',
  'cam.tool.stepoverRatio': '横向步距比',

  // ── Tool panel chrome ──
  'cam.tools.addTool': '添加刀具',
  'cam.tools.importFromLibrary': '从库导入',
  'cam.tools.loading': '加载中…',
  'cam.tools.loadingLibrary': '正在加载捆绑的刀具库…',
  'cam.tools.allTypes': '所有类型',
  'cam.tools.allUnits': '所有单位',
  'cam.tools.noFilterMatch': '没有匹配筛选条件的刀具。',
  'cam.tools.empty': '尚无刀具。添加第一把刀具以开始建立刀具库。',
  'cam.tools.imported': '已导入',
  'cam.tools.import': '导入',
  'cam.tools.duplicateTool': '复制刀具',
  'cam.tools.toolUsedByOperation': '刀具正在被操作使用',
  'cam.tools.deleteTool': '删除刀具',

  // ── Operation tree row actions ──
  'cam.treeRow.hideToolpath': '隐藏刀路',
  'cam.treeRow.showToolpath': '显示刀路',
  'cam.treeRow.hide': '隐藏',
  'cam.treeRow.show': '显示',
  'cam.treeRow.toolpathFor': '{action}{name} 的刀路',
  'cam.treeRow.off': '关闭',
  'cam.treeRow.duplicateOperation': '复制操作',
  'cam.treeRow.deleteOperation': '删除操作',
  'cam.treeRow.dragToReorder': '拖动以重新排序',

  // ── Add operation menu ──
  'cam.addMenu.operation': '加工操作',
  'cam.addMenu.roughPass': '粗加工',
  'cam.addMenu.finishPass': '精加工',
  'cam.addMenu.bothPasses': '两者',
  'cam.addMenu.roughPassHint': '粗加工（{hint}）',
  'cam.addMenu.finishPassHint': '精加工（{hint}）',
  'cam.addMenu.bothPassesHint': '两者（{hint}）',
  'cam.addMenu.roughPassTitle': '粗加工',
  'cam.addMenu.finishPassTitle': '精加工',
  'cam.addMenu.bothPassesTitle': '粗加工和精加工',
  'cam.addMenu.add': '添加',
  'cam.addMenu.addHint': '添加 {label}（{hint}）',
  'cam.addMenu.addLabel': '添加 {label}',
  'cam.addMenu.selectAll': '全选',
  'cam.addMenu.selectAllHint': '选择所有与 {label} 兼容的特征',
  'cam.addMenu.collapseInfo': '收起 {label} 信息',
  'cam.addMenu.expandInfo': '展开 {label} 信息',
  'cam.addMenu.missingImage': '缺少图片：',
  'cam.addMenu.keyPoints': '要点：',
  'cam.addMenu.exampleImage': '{title} 示例',

  // ── Validation hints: empty selection ──
  'cam.hint.empty.drilling': '请先选择一个或多个圆形特征',
  'cam.hint.empty.followLine': '请先选择一个或多个开放或闭合特征；闭合区域为可选过滤器',
  'cam.hint.empty.surfaceClean': '请先选择一个或多个加法/模型特征；闭合区域为可选过滤器',
  'cam.hint.empty.vCarve': '请先选择一个或多个闭合的减法或线条特征',
  'cam.hint.empty.roughSurface': '请先选择一个导入的模型特征',
  'cam.hint.empty.default': '请先选择一个或多个兼容的特征',

  // ── Validation hints: construction ──
  'cam.hint.construction': '构造几何体不会被加工——请先取消选择构造特征',

  // ── Validation hints: drilling ──
  'cam.hint.drilling': '钻孔需要圆形特征；闭合区域为可选过滤器',

  // ── Validation hints: follow_line ──
  'cam.hint.followLine': '雕刻需要至少一个路径特征；闭合区域为可选过滤器',

  // ── Validation hints: surface_clean ──
  'cam.hint.surfaceCleanNoFeature': '表面清理需要至少一个加法/模型特征；区域仅为过滤器',
  'cam.hint.surfaceCleanWrongOp': '表面清理仅接受加法/模型特征加可选的闭合区域',
  'cam.hint.surfaceCleanClosedOnly': '表面清理仅接受闭合轮廓',

  // ── Validation hints: v_carve / v_carve_medial ──
  'cam.hint.vCarveRequiresClosed': '{kind}需要至少一个闭合的减法或线条特征；区域仅为过滤器',
  'cam.hint.vCarveWrongFeature': '{kind}仅接受闭合的减法或线条特征加可选的闭合区域',

  // ── Validation hints: rough_surface ──
  'cam.hint.roughSurfaceNoModel': '曲面粗加工需要至少一个导入的模型特征；闭合区域为可选过滤器',

  // ── Validation hints: finish_surface / finish_surface_cleanup ──
  'cam.hint.finishSurfaceCount': '{kind}需要恰好一个导入的模型特征；闭合区域为可选过滤器',
  'cam.hint.finishSurfaceWrong': '{kind}仅接受一个导入模型加可选的闭合区域',

  // ── Validation hints: generic ──
  'cam.hint.noSubtractFeature': '请选择至少一个减法特征；闭合区域为可选过滤器',
  'cam.hint.noAddFeature': '请选择至少一个加法特征；闭合区域为可选过滤器',
  'cam.hint.noAddModelFeature': '请选择至少一个加法/模型特征；闭合区域为可选过滤器',
  'cam.hint.onlySubtract': '此操作仅接受减法特征加可选的闭合区域',
  'cam.hint.onlyAdd': '此操作仅接受加法特征加可选的闭合区域',
  'cam.hint.onlyAddModel': '此操作仅接受加法/模型特征加可选的闭合区域',
  'cam.hint.closedProfilesOnly': '{kind}仅接受闭合轮廓',

  // ── Validation hints: shared ──
  'cam.hint.regionNotClosed': '区域过滤器必须是闭合轮廓',
  'cam.hint.featuresNotFound': '找不到一个或多个所选特征',
  'cam.hint.selectCompatible': '请在特征树或草图中选择一个或多个兼容的特征',
  'cam.hint.notCompatible': '当前选择与此操作不兼容',

  // ── Booklet export ──
  'cam.booklet.building': '正在生成手册…',
  'cam.booklet.exported': '手册已导出：{path}',
  'cam.booklet.cancelled': '手册导出已取消',
  'cam.booklet.failed': '手册导出失败',

  // ── Rest machining ──
  'cam.restOp.created.one': '已创建残料操作，包含 {count} 个区域；请选择较小的刀具',
  'cam.restOp.created.other': '已创建残料操作，包含 {count} 个区域；请选择较小的刀具',
  'cam.restOp.empty': '未找到此刀具无法到达的挖槽区域',

  // ── Library ──
  'cam.library.failed': '加载刀具库失败。',

  // ── Parameter reference diagram labels ──
  'cam.paramRef.stepdown': '下刀步距参考',
  'cam.paramRef.stepover': '横向步距参考',
  'cam.paramRef.maxDepth': '最大深度参考',
  'cam.paramRef.retractHeight': '退刀高度参考',
  'cam.paramRef.peckDepth': '啄钻深度参考',
  'cam.paramRef.feed': '进给参考',
  'cam.paramRef.plungeFeed': '插铣进给参考',
  'cam.paramRef.slotFeed': '满刀进给参考',
  'cam.paramRef.rpm': '转速参考',
  'cam.paramRef.dwell': '暂停参考',
  'cam.paramRef.cutDirection': '切削方向参考',
  'cam.paramRef.pattern': '模式参考',
  'cam.paramRef.machiningOrder': '加工顺序参考',
  'cam.paramRef.rasterAngle': '扫描角度参考',
  'cam.paramRef.finishWalls': '精修侧壁参考',
  'cam.paramRef.finishFloor': '精修底面参考',
  'cam.paramRef.stockRadial': '径向余量参考',
  'cam.paramRef.stockAxial': '轴向余量参考',
  'cam.paramRef.adaptiveSpacing': '自适应间距参考',
  'cam.paramRef.adaptiveRefinement': '自适应细化参考',
  'cam.paramRef.maxRings': '最大环数参考',
  'cam.paramRef.drillType': '钻孔类型参考',

  // ── Operation descriptions ──
  'cam.opDesc.pocket.title': '挖槽',
  'cam.opDesc.pocket.fullDescription':
    '挖槽将闭合减法轮廓内部清除至固定 Z 深度。可选择偏移（同心、由外向内）或平行（扫描线）模式；平行模式可配置角度。',
  'cam.opDesc.pocket.keyPoint.0': '需要一个或多个闭合的减法轮廓',
  'cam.opDesc.pocket.keyPoint.1': '偏移或平行清除模式',
  'cam.opDesc.pocket.keyPoint.2': '支持粗加工和精加工',
  'cam.opDesc.pocket.keyPoint.3': '建议使用平底立铣刀以获得干净的底面',
  'cam.opDesc.pocket.keyPoint.4': '可选的闭合区域作为 XY 过滤器',

  'cam.opDesc.vCarve.title': 'V雕（偏移）',
  'cam.opDesc.vCarve.fullDescription':
    'V雕（偏移）沿闭合轮廓逐步缩小的内缩轮廓走刀，每刀降低 Z 高度，使 V形刀的斜面切出干净的 V形槽，逐渐收窄至中心线。每刀深度由轮廓间距和 V形刀半角计算得出。',
  'cam.opDesc.vCarve.keyPoint.0': '需要一个或多个闭合的减法轮廓',
  'cam.opDesc.vCarve.keyPoint.1': '需要 V形刀（请先在刀具上设置刀尖角度）',
  'cam.opDesc.vCarve.keyPoint.2': '单工序操作（无粗/精加工分开）',
  'cam.opDesc.vCarve.keyPoint.3': '适用于雕刻、标牌和装饰性边缘',
  'cam.opDesc.vCarve.keyPoint.4': '可选的闭合区域作为 XY 过滤器',

  'cam.opDesc.vCarveMedial.title': 'V雕（中轴）',
  'cam.opDesc.vCarveMedial.fullDescription':
    'V雕（中轴）从闭合轮廓的 Voronoi 图计算真实中轴，并切削出深度精确跟踪局部半宽的 V形槽。尖角处中轴骨架升起至表面以获得锐利端点；光滑曲线通过几何过滤保持干净。采样分辨率自动适配每个形状的尺寸。',
  'cam.opDesc.vCarveMedial.keyPoint.0': '需要一个或多个闭合的减法轮廓',
  'cam.opDesc.vCarveMedial.keyPoint.1': '需要 V形刀（请先在刀具上设置刀尖角度）',
  'cam.opDesc.vCarveMedial.keyPoint.2': '精确深度：V形刀两侧沿骨架处处贴合轮廓壁',
  'cam.opDesc.vCarveMedial.keyPoint.3': '自动形状缩放采样确保细小文字干净',
  'cam.opDesc.vCarveMedial.keyPoint.4': '尖角处锐利零深度端点；光滑曲线无伪影',
  'cam.opDesc.vCarveMedial.keyPoint.5': '单工序操作（无粗/精加工分开）',
  'cam.opDesc.vCarveMedial.keyPoint.6': '可选的闭合区域作为 XY 过滤器',

  'cam.opDesc.edgeRouteInside.title': '内缘走刀',
  'cam.opDesc.edgeRouteInside.fullDescription':
    '内缘走刀沿一个或多个闭合减法轮廓的内侧边缘走刀，向内侧偏移刀具半径。适用于槽、凹槽和刀具必须保持在边界内的内部轮廓切削。',
  'cam.opDesc.edgeRouteInside.keyPoint.0': '需要一个或多个闭合的减法轮廓',
  'cam.opDesc.edgeRouteInside.keyPoint.1': '刀路向内侧偏移刀具半径',
  'cam.opDesc.edgeRouteInside.keyPoint.2': '支持粗加工和精加工',
  'cam.opDesc.edgeRouteInside.keyPoint.3': '可选的闭合区域作为 XY 过滤器',

  'cam.opDesc.edgeRouteOutside.title': '外缘走刀',
  'cam.opDesc.edgeRouteOutside.fullDescription':
    '外缘走刀沿一个或多个闭合加法或模型轮廓的外侧边缘走刀，向外侧偏移刀具半径。用于将零件从毛坯中切出、在凸起特征周围留出干净肩部或切削周边。',
  'cam.opDesc.edgeRouteOutside.keyPoint.0': '需要一个或多个闭合的加法或模型轮廓',
  'cam.opDesc.edgeRouteOutside.keyPoint.1': '刀路向外侧偏移刀具半径',
  'cam.opDesc.edgeRouteOutside.keyPoint.2': '支持粗加工和精加工',
  'cam.opDesc.edgeRouteOutside.keyPoint.3': '可选的闭合区域作为 XY 过滤器',

  'cam.opDesc.surfaceClean.title': '表面清理',
  'cam.opDesc.surfaceClean.fullDescription':
    '表面清理加工一个或多个加法/模型特征的平坦顶面，清除位于其上方的更高加法特征周围的区域。在每个台阶高度产生一圈清理刀路——适用于修整平台、阶梯和台阶表面。模式可选偏移或平行。',
  'cam.opDesc.surfaceClean.keyPoint.0': '需要一个或多个闭合的加法或模型特征',
  'cam.opDesc.surfaceClean.keyPoint.1': '在每个台阶高度清除较高特征之间的区域',
  'cam.opDesc.surfaceClean.keyPoint.2': '偏移或平行清除模式',
  'cam.opDesc.surfaceClean.keyPoint.3': '支持粗加工和精加工',
  'cam.opDesc.surfaceClean.keyPoint.4': '可选的闭合区域作为 XY 过滤器',

  'cam.opDesc.followLine.title': '雕刻',
  'cam.opDesc.followLine.fullDescription':
    '雕刻沿任意草图路径——开放或闭合——以固定切削深度走刀。刀具沿路径中心线运行，无偏移。适用于文字、装饰线条、定位标记以及沿毛坯表面跟随复杂曲线。',
  'cam.opDesc.followLine.keyPoint.0': '接受开放或闭合路径特征',
  'cam.opDesc.followLine.keyPoint.1': '刀具沿路径中心线走刀（无偏移）',
  'cam.opDesc.followLine.keyPoint.2': '单工序操作（无粗/精加工分开）',
  'cam.opDesc.followLine.keyPoint.3': '通常较浅；若雕刻深度超过下刀步距则会分层',
  'cam.opDesc.followLine.keyPoint.4': '可选的闭合区域作为 XY 过滤器',

  'cam.opDesc.drilling.title': '钻孔',
  'cam.opDesc.drilling.fullDescription':
    '钻孔使用固定循环在每个选定圆形特征的中心钻出一个孔。在操作中选择钻孔方式（简单 G81、啄钻 G83、暂停 G82、断屑 G73）和深度。',
  'cam.opDesc.drilling.keyPoint.0': '需要一个或多个圆形特征',
  'cam.opDesc.drilling.keyPoint.1': '四种循环类型：简单（G81）、啄钻（G83）、暂停（G82）、断屑（G73）',
  'cam.opDesc.drilling.keyPoint.2': '啄钻和断屑循环使用啄钻增量',
  'cam.opDesc.drilling.keyPoint.3': '适合重复孔模式',
  'cam.opDesc.drilling.keyPoint.4': '可选的闭合区域过滤要钻孔的位置',

  'cam.opDesc.roughSurface.title': '3D 曲面粗加工',
  'cam.opDesc.roughSurface.fullDescription':
    '曲面粗加工以恒定 Z 层（水平线风格）切片导入的 3D 模型，并用偏移刀路清除每一层，为精加工留出径向和轴向余量。使用较大的下刀步距和横向步距以提高速度；后续使用精加工操作以保证精度。',
  'cam.opDesc.roughSurface.keyPoint.0': '需要一个导入的 3D 模型',
  'cam.opDesc.roughSurface.keyPoint.1': '水平线风格分层切片，每层偏移清除',
  'cam.opDesc.roughSurface.keyPoint.2': '为精加工保留径向和轴向余量',
  'cam.opDesc.roughSurface.keyPoint.3': '单工序操作（无粗/精加工分开——此操作本身就是粗加工）',
  'cam.opDesc.roughSurface.keyPoint.4': '可选的闭合区域作为 XY 过滤器',

  'cam.opDesc.finishSurface.title': '3D 曲面精加工',
  'cam.opDesc.finishSurface.fullDescription':
    '曲面精加工在导入的 3D 模型上生成最终表面。选择平行（可配置角度的扫描线）用于较浅的几何体，或水平线（恒定 Z 轮廓）用于较陡的壁面。平行模式使用较小的横向步距，水平线模式使用较小的下刀步距。',
  'cam.opDesc.finishSurface.keyPoint.0': '需要一个导入的 3D 模型',
  'cam.opDesc.finishSurface.keyPoint.1': '平行（扫描线）或水平线（恒定 Z）模式',
  'cam.opDesc.finishSurface.keyPoint.2': '单工序操作（无粗/精加工分开——此操作就是精加工）',
  'cam.opDesc.finishSurface.keyPoint.3': '通常在 3D 曲面粗加工之后运行',
  'cam.opDesc.finishSurface.keyPoint.4': '可选的闭合区域作为 XY 过滤器',

  'cam.opDesc.finishSurfaceCleanup.title': '3D 曲面清理',
  'cam.opDesc.finishSurfaceCleanup.fullDescription':
    '曲面清理在 3D 粗加工操作留下的每个台阶的最深保留 Z 处生成仅精修的壁面和底面刀路。它去重跨层的重复壁/底柱，使每处在最低有效深度仅切削一次——清理粗加工留下的阶梯而不重新粗加工。',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.0': '需要一个导入的 3D 模型',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.1': '独立的精修侧壁和精修底面开关',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.2': '底面的偏移或平行模式',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.3': '通常在 3D 曲面粗加工之后作为最后一道工序运行',
  'cam.opDesc.finishSurfaceCleanup.keyPoint.4': '可选的闭合区域作为 XY 过滤器',
}
