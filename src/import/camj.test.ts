/**
 * Tests for .camj folder-import inspection and merge.
 *
 * Run with: npx tsx src/import/camj.test.ts
 */

import {
  type FeatureFolder,
  type NamedDimension,
  type Operation,
  type PersistedImportedMesh,
  type Project,
  type SketchFeature,
  type Tool,
  newProject,
  rectProfile,
  stockFromFeature,
} from '../types/project'
import { inspectCamjString, mergeCamjFolders } from './camj'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('FAIL: ' + msg)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) < epsilon
}

function makeFeature(overrides: Partial<SketchFeature> & { id: string; name: string; folderId: string | null }): SketchFeature {
  return {
    id: overrides.id,
    name: overrides.name,
    kind: overrides.kind ?? 'rect',
    folderId: overrides.folderId,
    sketch: overrides.sketch ?? {
      profile: rectProfile(0, 0, 10, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: overrides.operation ?? 'add',
    z_top: overrides.z_top ?? 5,
    z_bottom: overrides.z_bottom ?? 0,
    visible: overrides.visible ?? true,
    locked: overrides.locked ?? false,
    text: overrides.text ?? null,
    stl: overrides.stl ?? null,
  }
}

function makeFolder(id: string, name: string): FeatureFolder {
  return { id, name, collapsed: false, section: 'features' }
}

function makeTool(id: string, name: string, units: 'mm' | 'inch' = 'mm'): Tool {
  return {
    id,
    name,
    units,
    type: 'flat_endmill',
    diameter: 6,
    vBitAngle: null,
    flutes: 2,
    material: 'carbide',
    defaultRpm: 18000,
    defaultFeed: 800,
    defaultPlungeFeed: 300,
    defaultStepdown: 2,
    defaultStepover: 0.4,
    maxCutDepth: 0,
  }
}

function makeOperation(id: string, name: string, featureIds: string[], toolRef: string | null): Operation {
  return {
    id,
    name,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef,
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
  }
}

function makeMesh(): PersistedImportedMesh {
  return {
    storage: 'mesh-v1',
    sourceFormat: 'stl',
    vertexCount: 3,
    triangleCount: 1,
    positions: 'AAAAAA==',
    indices: 'AAAAAA==',
    bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 },
  }
}

function makeSourceProject(units: 'mm' | 'inch' = 'mm'): Project {
  const base = newProject('Source', units)
  return {
    ...base,
    featureFolders: [makeFolder('fd-src-a', 'Bracket'), makeFolder('fd-src-b', 'Holes')],
    features: [
      makeFeature({ id: 'f-src-1', name: 'Outline', folderId: 'fd-src-a' }),
      makeFeature({ id: 'f-src-2', name: 'Slot', folderId: 'fd-src-a' }),
      makeFeature({ id: 'f-src-3', name: 'Hole', folderId: 'fd-src-b', kind: 'circle' }),
    ],
    featureTree: [
      { type: 'folder', folderId: 'fd-src-a' },
      { type: 'folder', folderId: 'fd-src-b' },
    ],
  }
}

// ---------------- inspectCamjString ----------------

function testInspectListsFoldersWithFeatures(): void {
  const source = makeSourceProject('mm')
  const inspection = inspectCamjString(JSON.stringify(source))
  assert(inspection.folderIds.length === 2, `expected 2 folders, got ${inspection.folderIds.length}`)
  assert(inspection.folderIds[0] === 'fd-src-a', `expected first folder fd-src-a, got ${inspection.folderIds[0]}`)
  assert(inspection.folderFeatureCount['fd-src-a'] === 2, 'expected Bracket to have 2 features')
  assert(inspection.folderFeatureCount['fd-src-b'] === 1, 'expected Holes to have 1 feature')
  assert(inspection.sourceUnits === 'mm', 'expected source units mm')
}

function testInspectHidesEmptyFolders(): void {
  const source = makeSourceProject('mm')
  source.featureFolders.push(makeFolder('fd-src-empty', 'Empty'))
  const inspection = inspectCamjString(JSON.stringify(source))
  assert(!inspection.folderIds.includes('fd-src-empty'), 'empty folders should not appear')
}

function testInspectRejectsBadJson(): void {
  let threw = false
  try {
    inspectCamjString('{not json')
  } catch {
    threw = true
  }
  assert(threw, 'expected inspectCamjString to throw on bad JSON')
}

function testInspectRejectsMissingFeatures(): void {
  let threw = false
  try {
    inspectCamjString(JSON.stringify({ meta: { units: 'mm' } }))
  } catch {
    threw = true
  }
  assert(threw, 'expected inspectCamjString to throw on missing features')
}

// ---------------- mergeCamjFolders ----------------

function testMergeImportsFolderWithFeatures(): void {
  const current = newProject('Target', 'mm')
  const source = makeSourceProject('mm')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: source,
    selectedFolderIds: ['fd-src-a'],
  })
  assert(result.createdFolderIds.length === 1, 'expected 1 new folder')
  assert(result.createdFeatureIds.length === 2, 'expected 2 new features')
  const newFolderId = result.createdFolderIds[0]
  assert(newFolderId !== 'fd-src-a', 'folder id should be remapped')
  assert(
    result.project.features.every((f) => f.id !== 'f-src-1' && f.id !== 'f-src-2'),
    'feature ids should all be remapped',
  )
  assert(
    result.project.features.filter((f) => f.folderId === newFolderId).length === 2,
    'both imported features should belong to the new folder',
  )
  assert(
    result.project.featureTree.some((entry) => entry.type === 'folder' && entry.folderId === newFolderId),
    'featureTree should contain the new folder entry',
  )
  assert(
    result.project.featureFolders.find((f) => f.id === newFolderId)?.name === 'Bracket',
    'folder name preserved',
  )
}

function testMergeRenamesOnNameCollision(): void {
  const current: Project = {
    ...newProject('Target', 'mm'),
    featureFolders: [makeFolder('fd-existing', 'Bracket')],
    features: [
      makeFeature({ id: 'f-existing', name: 'Outline', folderId: 'fd-existing' }),
    ],
    featureTree: [{ type: 'folder', folderId: 'fd-existing' }],
  }
  const source = makeSourceProject('mm')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: source,
    selectedFolderIds: ['fd-src-a'],
  })
  const newFolder = result.project.featureFolders.find((f) => result.createdFolderIds.includes(f.id))!
  assert(newFolder.name === 'Bracket 2', `expected suffixed folder name, got ${newFolder.name}`)
  const newOutline = result.project.features.find((f) => result.createdFeatureIds.includes(f.id) && f.name.startsWith('Outline'))!
  assert(newOutline.name === 'Outline 2', `expected suffixed feature name, got ${newOutline.name}`)
}

function testMergeCopiesReferencedMeshAssets(): void {
  const source = makeSourceProject('mm')
  source.modelAssets = { 'mesh-src-1': makeMesh(), 'mesh-unused': makeMesh() }
  source.features = source.features.map((f) =>
    f.id === 'f-src-1'
      ? { ...f, kind: 'stl', stl: { meshAssetId: 'mesh-src-1', scale: 1 } }
      : f,
  )
  const current = newProject('Target', 'mm')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: source,
    selectedFolderIds: ['fd-src-a'],
  })
  const stlFeature = result.project.features.find((f) => result.createdFeatureIds.includes(f.id) && f.stl)!
  const remappedAssetId = stlFeature.stl!.meshAssetId!
  assert(remappedAssetId !== 'mesh-src-1', 'mesh asset id should be remapped')
  assert(result.project.modelAssets[remappedAssetId] !== undefined, 'mesh asset should be copied under new id')
  assert(result.project.modelAssets['mesh-unused'] === undefined, 'unreferenced asset should not be copied')
}

function testMergeCopiesReferencedDimensions(): void {
  const source = makeSourceProject('mm')
  const dim: NamedDimension = { id: 'dim-src-1', name: 'depth', value: 5, formula: null }
  source.dimensions = { 'dim-src-1': dim, 'dim-unused': { id: 'dim-unused', name: 'x', value: 1, formula: null } }
  source.features = source.features.map((f) =>
    f.id === 'f-src-1' ? { ...f, z_top: 'dim-src-1' as const } : f,
  )
  const current = newProject('Target', 'mm')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: source,
    selectedFolderIds: ['fd-src-a'],
  })
  const imported = result.project.features.find((f) => result.createdFeatureIds.includes(f.id) && typeof f.z_top === 'string')!
  const remappedDimId = imported.z_top as string
  assert(remappedDimId !== 'dim-src-1', 'dimension id should be remapped')
  assert(result.project.dimensions[remappedDimId]?.value === 5, 'dimension value should be preserved')
  assert(result.project.dimensions['dim-unused'] === undefined, 'unreferenced dimension should not be copied')
}

function testMergeImportsToolAndOperation(): void {
  const source = makeSourceProject('mm')
  source.tools = [makeTool('t-src-1', 'Endmill'), makeTool('t-unused', 'Unused')]
  source.operations = [
    makeOperation('op-src-1', 'Pocket A', ['f-src-1', 'f-src-2'], 't-src-1'),
    makeOperation('op-src-2', 'Pocket B', ['f-src-3'], 't-src-1'),
  ]
  const current = newProject('Target', 'mm')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: source,
    selectedFolderIds: ['fd-src-a'],
  })
  // Only Pocket A should come across — it targets features inside fd-src-a.
  const importedOps = result.project.operations
  assert(importedOps.length === 1, `expected 1 operation, got ${importedOps.length}`)
  const op = importedOps[0]
  assert(op.id !== 'op-src-1', 'operation id should be remapped')
  assert(op.target.source === 'features', 'expected feature-targeted operation')
  const importedFeatureIds = new Set(result.createdFeatureIds)
  if (op.target.source === 'features') {
    assert(op.target.featureIds.length === 2, `expected 2 target ids, got ${op.target.featureIds.length}`)
    assert(op.target.featureIds.every((id) => importedFeatureIds.has(id)), 'op target ids should be remapped to new feature ids')
  }
  // Tool should have been imported with new id.
  const newTools = result.project.tools.filter((t) => t.id !== 't-src-1' && t.name.startsWith('Endmill'))
  assert(newTools.length === 1, `expected 1 imported tool, got ${newTools.length}`)
  assert(op.toolRef === newTools[0].id, 'operation toolRef should be remapped to new tool id')
  // The unused tool should not be imported.
  assert(!result.project.tools.some((t) => t.name === 'Unused'), 'unused tool should not be imported')
}

function testMergeSkipsOperationsTargetingNonImportedFeatures(): void {
  const source = makeSourceProject('mm')
  source.tools = [makeTool('t-src-1', 'Endmill')]
  source.operations = [
    makeOperation('op-mixed', 'Pocket Mixed', ['f-src-1', 'f-src-3'], 't-src-1'),
  ]
  const current = newProject('Target', 'mm')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: source,
    selectedFolderIds: ['fd-src-a'],
  })
  assert(result.project.operations.length === 0, 'mixed-target operation should be skipped')
  assert(result.project.tools.length === 0, 'tool only referenced by skipped operation should not be imported')
}

function testMergeSkipsStockTargetedOperations(): void {
  const source = makeSourceProject('mm')
  source.tools = [makeTool('t-src-1', 'Endmill')]
  source.operations = [
    {
      ...makeOperation('op-stock', 'Stock Op', [], 't-src-1'),
      target: { source: 'stock' },
    },
  ]
  const current = newProject('Target', 'mm')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: source,
    selectedFolderIds: ['fd-src-a'],
  })
  assert(result.project.operations.length === 0, 'stock-targeted operation should be skipped')
}

function testMergeScalesUnitsMmToInch(): void {
  const source = makeSourceProject('mm')
  const current = newProject('Target', 'inch')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: source,
    selectedFolderIds: ['fd-src-a'],
  })
  const imported = result.project.features.find((f) => result.createdFeatureIds.includes(f.id) && f.name.startsWith('Outline'))!
  // Source rect 10×10 mm → 10/25.4 in
  const expected = 10 / 25.4
  const lastSeg = imported.sketch.profile.segments[1]
  assert(approx((lastSeg as { to: { x: number } }).to.x, expected, 1e-6), `expected mm→inch scale on profile, got ${(lastSeg as { to: { x: number } }).to.x}`)
  assert(approx(imported.z_top as number, 5 / 25.4, 1e-6), 'z_top should be scaled mm→inch')
}

function testMergeScalesToolUnits(): void {
  const source = makeSourceProject('mm')
  source.tools = [makeTool('t-src-1', 'Endmill', 'mm')]
  source.operations = [makeOperation('op-src-1', 'Pocket A', ['f-src-1', 'f-src-2'], 't-src-1')]
  const current = newProject('Target', 'inch')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: source,
    selectedFolderIds: ['fd-src-a'],
  })
  const importedTool = result.project.tools.find((t) => t.name.startsWith('Endmill'))!
  assert(importedTool.units === 'inch', 'imported tool units should match target project')
  assert(approx(importedTool.diameter, 6 / 25.4, 1e-6), `tool diameter should be scaled mm→inch, got ${importedTool.diameter}`)
}

function testMergeHidesLooseFeatures(): void {
  const source = makeSourceProject('mm')
  // Add a loose (folderId: null) feature to the source.
  source.features.push(makeFeature({ id: 'f-loose', name: 'Loose', folderId: null }))
  source.featureTree.push({ type: 'feature', featureId: 'f-loose' })
  const inspection = inspectCamjString(JSON.stringify(source))
  assert(!inspection.folderIds.includes('f-loose'), 'loose features should not appear in folder list')

  // And mergeCamjFolders should never bring it across regardless of selection.
  const current = newProject('Target', 'mm')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: source,
    selectedFolderIds: ['fd-src-a', 'fd-src-b'],
  })
  assert(
    !result.project.features.some((f) => result.createdFeatureIds.includes(f.id) && f.name.startsWith('Loose')),
    'loose feature should not be imported',
  )
}

function testMergeEmptySelectionReturnsUnchanged(): void {
  const current = newProject('Target', 'mm')
  const source = makeSourceProject('mm')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: source,
    selectedFolderIds: [],
  })
  assert(result.createdFolderIds.length === 0, 'no folders should be created on empty selection')
  assert(result.createdFeatureIds.length === 0, 'no features should be created on empty selection')
  assert(result.project === current, 'project should be unchanged on empty selection')
  assert(result.stockReplaced === false, 'stock should not be replaced on empty selection')
}

// ---------------- stock import ----------------

function makeFeatureBasedStockProject(units: 'mm' | 'inch' = 'mm'): Project {
  const base = makeSourceProject(units)
  const stockFeature = makeFeature({
    id: 'f-stock-src',
    name: 'StockFromFeature',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 80, 60),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    z_top: 20,
    z_bottom: 0,
  })
  return {
    ...base,
    stock: {
      ...stockFromFeature(stockFeature),
      material: 'walnut',
      color: '#a87f5b',
      visible: false,
      origin: { x: 1, y: 2 },
    },
  }
}

function testInspectReportsStockIsFeatureBased(): void {
  const source = makeFeatureBasedStockProject('mm')
  const inspection = inspectCamjString(JSON.stringify(source))
  assert(inspection.stockIsFeatureBased === true, 'expected stockIsFeatureBased=true for feature-based stock')
}

function testInspectReportsStockNotFeatureBasedForRectStock(): void {
  const source = makeSourceProject('mm')
  const inspection = inspectCamjString(JSON.stringify(source))
  assert(inspection.stockIsFeatureBased === false, 'expected stockIsFeatureBased=false for rect stock')
}

function testMergeImportsStockReplacesCurrent(): void {
  const current = newProject('Target', 'mm')
  const sourceFeaturedStockProject = makeFeatureBasedStockProject('mm')
  // Give the source project a custom origin so we can verify it comes across.
  sourceFeaturedStockProject.origin = { name: 'CustomOrigin', x: 7, y: 3, z: 11, visible: true }
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: sourceFeaturedStockProject,
    selectedFolderIds: ['fd-src-a'],
    importStock: true,
  })
  assert(result.stockReplaced === true, 'expected stockReplaced=true')
  const stock = result.project.stock
  assert(!!stock.sourceFeatureId, 'expected new stock to have sourceFeatureId')
  assert(stock.sourceFeatureId !== 'f-stock-src', 'expected sourceFeatureId to be remapped')
  assert(stock.sourceFeature?.id === stock.sourceFeatureId, 'sourceFeature.id should match sourceFeatureId')
  assert(stock.material === 'walnut', 'material should be preserved from source')
  assert(stock.color === '#a87f5b', 'color should be preserved from source')
  assert(stock.visible === false, 'visible should be preserved from source')
  assert(approx(stock.thickness, 20), `thickness should match source z_top, got ${stock.thickness}`)
  // Origin is imported verbatim from source.
  assert(result.project.origin.name === 'CustomOrigin', 'origin name should be imported verbatim')
  assert(approx(result.project.origin.x, 7, 1e-6), `origin.x should match source, got ${result.project.origin.x}`)
  assert(approx(result.project.origin.y, 3, 1e-6), `origin.y should match source, got ${result.project.origin.y}`)
  assert(approx(result.project.origin.z, 11, 1e-6), `origin.z should match source, got ${result.project.origin.z}`)
}

function testMergeImportsStockWithoutFolders(): void {
  const current = newProject('Target', 'mm')
  const sourceFeaturedStockProject = makeFeatureBasedStockProject('mm')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: sourceFeaturedStockProject,
    selectedFolderIds: [],
    importStock: true,
  })
  assert(result.stockReplaced === true, 'stock-only import should mark stockReplaced')
  assert(result.createdFolderIds.length === 0, 'stock-only import should not create folders')
  assert(result.createdFeatureIds.length === 0, 'stock-only import should not create features')
}

function testMergeImportsStockMmToInchScales(): void {
  const current = newProject('Target', 'inch')
  const sourceFeaturedStockProject = makeFeatureBasedStockProject('mm')
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: sourceFeaturedStockProject,
    selectedFolderIds: [],
    importStock: true,
  })
  const stock = result.project.stock
  // 80mm → 80/25.4 in for the rect width
  const expectedWidth = 80 / 25.4
  const lastSeg = stock.profile.segments[0]
  assert(approx((lastSeg as { to: { x: number } }).to.x, expectedWidth, 1e-6), `stock profile should scale mm→inch, got ${(lastSeg as { to: { x: number } }).to.x}`)
  assert(approx(stock.thickness, 20 / 25.4, 1e-6), `stock thickness should scale mm→inch, got ${stock.thickness}`)
}

function testMergeStockImportNoOpWhenSourceNotFeatureBased(): void {
  const current = newProject('Target', 'mm')
  const source = makeSourceProject('mm') // rect-only stock
  const result = mergeCamjFolders({
    currentProject: current,
    sourceProject: source,
    selectedFolderIds: ['fd-src-a'],
    importStock: true,
  })
  assert(result.stockReplaced === false, 'stock should not be replaced when source is not feature-based')
  assert(result.project.stock === current.stock, 'current stock should be untouched')
  assert(result.warnings.some((w) => w.toLowerCase().includes('stock')), 'expected stock-related warning')
}

testInspectListsFoldersWithFeatures()
testInspectHidesEmptyFolders()
testInspectRejectsBadJson()
testInspectRejectsMissingFeatures()
testMergeImportsFolderWithFeatures()
testMergeRenamesOnNameCollision()
testMergeCopiesReferencedMeshAssets()
testMergeCopiesReferencedDimensions()
testMergeImportsToolAndOperation()
testMergeSkipsOperationsTargetingNonImportedFeatures()
testMergeSkipsStockTargetedOperations()
testMergeScalesUnitsMmToInch()
testMergeScalesToolUnits()
testMergeHidesLooseFeatures()
testMergeEmptySelectionReturnsUnchanged()
testInspectReportsStockIsFeatureBased()
testInspectReportsStockNotFeatureBasedForRectStock()
testMergeImportsStockReplacesCurrent()
testMergeImportsStockWithoutFolders()
testMergeImportsStockMmToInchScales()
testMergeStockImportNoOpWhenSourceNotFeatureBased()
console.log('camj import tests passed')
