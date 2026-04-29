import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import { polygonProfile } from '../src/types/project.ts'
import type { Operation, Project, SketchFeature, Tool } from '../src/types/project.ts'

function makeProject(feature: SketchFeature, tool: Tool, operation: Operation): Project {
  return {
    version: '1.0',
    meta: {
      name: 'debug',
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      units: 'inch',
      showFeatureInfo: false,
      maxTravelZ: 3,
      operationClearanceZ: 0.25,
      clampClearanceXY: 0.125,
      clampClearanceZ: 0.125,
      machineDefinitions: [],
      selectedMachineId: null,
    },
    grid: {
      extent: 100,
      majorSpacing: 1,
      minorSpacing: 0.25,
      snapEnabled: false,
      snapIncrement: 0.25,
    },
    stock: {
      profile: polygonProfile([
        { x: -1, y: -1 },
        { x: 6, y: -1 },
        { x: 6, y: 5 },
        { x: -1, y: 5 },
      ]),
      thickness: 0.75,
      material: 'debug',
      color: '#000',
      visible: true,
      origin: { x: 0, y: 0 },
    },
    origin: {
      name: 'origin',
      x: 0,
      y: 0,
      z: 0,
      visible: true,
    },
    backdrop: null,
    dimensions: {},
    features: [feature],
    featureFolders: [],
    featureTree: [{ type: 'feature', featureId: feature.id }],
    global_constraints: [],
    tools: [tool],
    operations: [operation],
    tabs: [],
    clamps: [],
    ai_history: [],
  }
}

const cShape = polygonProfile([
  { x: 4.0, y: 3.8 },
  { x: 3.4, y: 4.0 },
  { x: 1.2, y: 4.0 },
  { x: 0.4, y: 3.2 },
  { x: 0.4, y: 0.8 },
  { x: 1.2, y: 0.0 },
  { x: 3.4, y: 0.0 },
  { x: 4.0, y: 0.2 },
  { x: 3.7, y: 0.8 },
  { x: 3.2, y: 0.6 },
  { x: 1.7, y: 0.6 },
  { x: 1.1, y: 1.2 },
  { x: 1.1, y: 2.8 },
  { x: 1.7, y: 3.4 },
  { x: 3.2, y: 3.4 },
  { x: 3.7, y: 3.2 },
])

const feature: SketchFeature = {
  id: 'feature-1',
  name: 'C',
  kind: 'polygon',
  text: null,
  folderId: null,
  sketch: {
    profile: cShape,
    origin: { x: 0, y: 0 },
    orientationAngle: 90,
    dimensions: [],
    constraints: [],
  },
  operation: 'subtract',
  z_top: 0.75,
  z_bottom: 0,
  visible: true,
  locked: false,
}

const tool: Tool = {
  id: 'tool-1',
  name: '60 V',
  units: 'inch',
  type: 'v_bit',
  diameter: 0.25,
  vBitAngle: 60,
  flutes: 2,
  material: 'carbide',
  defaultRpm: 18000,
  defaultFeed: 18,
  defaultPlungeFeed: 8,
  defaultStepdown: 0.05,
  defaultStepover: 0.04,
  maxCutDepth: 0.25,
}

const operation: Operation = {
  id: 'op-1',
  name: 'VCarve recursive',
  kind: 'v_carve_recursive',
  pass: 'finish',
  enabled: true,
  showToolpath: true,
  debugToolpath: false,
  target: { source: 'features', featureIds: [feature.id] },
  toolRef: tool.id,
  stepdown: tool.defaultStepdown,
  stepover: 0.4,
  feed: tool.defaultFeed,
  plungeFeed: tool.defaultPlungeFeed,
  rpm: tool.defaultRpm,
  pocketPattern: 'offset',
  pocketAngle: 0,
  stockToLeaveRadial: 0,
  stockToLeaveAxial: 0,
  finishWalls: false,
  finishFloor: false,
  carveDepth: 0,
  maxCarveDepth: 0.25,
}

const project = makeProject(feature, tool, operation)
const result = generateVCarveRecursiveToolpath(project, operation)
const suspicious = result.moves
  .map((move, index) => ({
    index,
    kind: move.kind,
    lengthXY: Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y),
    dz: move.to.z - move.from.z,
    from: move.from,
    to: move.to,
  }))
  .filter((move) => move.kind === 'cut' && move.lengthXY > operation.stepover * 1.5)
  .sort((a, b) => b.lengthXY - a.lengthXY)

console.log(`moves=${result.moves.length}`)
console.log(`warnings=${result.warnings.join(' | ')}`)
console.log(`suspiciousCuts=${suspicious.length}`)
for (const move of suspicious.slice(0, 40)) {
  console.log(JSON.stringify(move))
}
