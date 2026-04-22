
import { propagateConstraintsOnTranslate, propagateConstraintsOnRotate } from './constraintSolver'
import type { SketchFeature, Point } from '../types/project'

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error('Assertion failed: ' + message)
  }
}

function approx(a: number, b: number, epsilon = 1e-6) {
  return Math.abs(a - b) < epsilon
}

function transformProfile(profile: any, transformPoint: (p: Point) => Point) {
  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: profile.segments.map((s: any) => {
      if (s.type === 'circle' || s.type === 'arc') {
        return { 
          ...s, 
          center: transformPoint(s.center), 
          to: transformPoint(s.to) 
        }
      }
      return { ...s, to: transformPoint(s.to) }
    })
  }
}

function testTranslatePropagation() {
  console.log('Testing Translate Propagation...')

  const featureA: SketchFeature = {
    id: 'A',
    name: 'Rect A',
    kind: 'rect',
    operation: 'add',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 5, y: 0 } },
          { type: 'line', to: { x: 5, y: 5 } },
          { type: 'line', to: { x: 0, y: 5 } },
          { type: 'line', to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }

  const featureB: SketchFeature = {
    id: 'B',
    name: 'Circle B',
    kind: 'circle',
    operation: 'add',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 12, y: 0 },
        segments: [
          { type: 'circle', center: { x: 10, y: 0 }, to: { x: 12, y: 0 }, clockwise: true },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [
        {
          id: 'c1',
          type: 'fixed_distance',
          segment_ids: ['A'],
          value: 10,
          anchor_point: { x: 10, y: 0 }, // Center of circle
          reference_point: { x: 0, y: 0 }, // Corner of Rect A
        },
      ],
    },
  }

  const features = [featureA, featureB]
  const movedOffsets = new Map([['A', { dx: 10, dy: 5 }]])

  const nextFeatures = propagateConstraintsOnTranslate(features, movedOffsets, {
    transformProfile
  })

  const nextB = nextFeatures.find(f => f.id === 'B')!
  
  console.log('Next B start:', nextB.sketch.profile.start)
  assert(approx(nextB.sketch.profile.start.x, 22), 'B.x should be 22')
  assert(approx(nextB.sketch.profile.start.y, 5), 'B.y should be 5')
  
  console.log('Translate Propagation Test Passed!')
}

function testRotatePropagation() {
  console.log('Testing Rotate Propagation...')

  const featureA: SketchFeature = {
    id: 'A',
    name: 'Rect A',
    kind: 'rect',
    operation: 'add',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 5, y: 0 } },
          { type: 'line', to: { x: 5, y: 5 } },
          { type: 'line', to: { x: 0, y: 5 } },
          { type: 'line', to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }

  const featureB: SketchFeature = {
    id: 'B',
    name: 'Rect B (dependent)',
    kind: 'rect',
    operation: 'add',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 10, y: 0 },
        segments: [
          { type: 'line', to: { x: 15, y: 0 } },
          { type: 'line', to: { x: 15, y: 5 } },
          { type: 'line', to: { x: 10, y: 5 } },
          { type: 'line', to: { x: 10, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [
        {
          id: 'c1',
          type: 'fixed_distance',
          segment_ids: ['A'],
          value: 10,
          anchor_point: { x: 10, y: 0 },
          reference_point: { x: 0, y: 0 },
        },
      ],
    },
  }

  const features = [featureA, featureB]
  // Rotate A 90 degrees around its center (2.5, 2.5)
  const movedRotations = new Map([['A', { pivot: { x: 2.5, y: 2.5 }, angle: Math.PI / 2 }]])

  const nextFeatures = propagateConstraintsOnRotate(features, movedRotations, {
    transformProfile
  })

  const nextB = nextFeatures.find(f => f.id === 'B')!
  
  // (10, 0) rotated 90 deg around (2.5, 2.5) is (5, 10)
  // The whole Rect B should have rotated 90 deg too.
  // Corner (15, 0) rotated 90 deg around (2.5, 2.5) is (5, 15)
  
  const p0 = nextB.sketch.profile.start
  const p1 = nextB.sketch.profile.segments[0].to
  
  console.log('Next B start:', p0)
  console.log('Next B p1:', p1)
  
  assert(approx(p0.x, 5), 'B start x should be 5')
  assert(approx(p0.y, 10), 'B start y should be 10')
  assert(approx(p1.x, 5), 'B p1 x should be 5')
  assert(approx(p1.y, 15), 'B p1 y should be 15')

  console.log('Rotate Propagation Test Passed!')
}

function testMultiConstraintPropagation() {
  console.log('Testing Multi-Constraint Propagation...')

  const featureA: SketchFeature = {
    id: 'A',
    name: 'Rect A',
    kind: 'rect',
    operation: 'add',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: { start: { x: 0, y: 0 }, segments: [], closed: true },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }

  const featureB: SketchFeature = {
    id: 'B',
    name: 'Rect B',
    kind: 'rect',
    operation: 'add',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: { start: { x: 20, y: 0 }, segments: [], closed: true },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }

  const featureC: SketchFeature = {
    id: 'C',
    name: 'Circle C',
    kind: 'circle',
    operation: 'add',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 12, y: 0 },
        segments: [{ type: 'circle', center: { x: 10, y: 0 }, to: { x: 12, y: 0 }, clockwise: true } as any],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [
        {
          id: 'c1',
          type: 'fixed_distance',
          segment_ids: ['A'],
          value: 10,
          anchor_point: { x: 10, y: 0 },
          reference_point: { x: 0, y: 0 },
        },
        {
          id: 'c2',
          type: 'fixed_distance',
          segment_ids: ['B'],
          value: 10,
          anchor_point: { x: 10, y: 0 },
          reference_point: { x: 20, y: 0 },
        },
      ],
    },
  }

  const features = [featureA, featureB, featureC]
  // Move A +10x, Keep B at 0,0
  const movedOffsets = new Map([['A', { dx: 10, dy: 0 }]])

  const nextFeatures = propagateConstraintsOnTranslate(features, movedOffsets, {
    transformProfile
  })

  const nextC = nextFeatures.find(f => f.id === 'C')!
  const nextCenter = (nextC.sketch.profile.segments[0] as any).center
  
  console.log('Next C center:', nextCenter)
  
  // A moved +10x. B moved 0.
  // C initial guess (average) is +5x.
  // Solver will find +5x as the solution that best satisfies distance 10 from both.
  assert(approx(nextCenter.x, 15), 'C should move to 15 (middle ground)')

  console.log('Multi-Constraint Propagation Test Passed!')
}

function testRepeatedMoves() {
  console.log('Testing 10 Repeated Moves...')

  let featureA: SketchFeature = {
    id: 'A',
    name: 'Rect A',
    kind: 'rect',
    operation: 'add',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 5, y: 0 } },
          { type: 'line', to: { x: 5, y: 5 } },
          { type: 'line', to: { x: 0, y: 5 } },
          { type: 'line', to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }

  let featureB: SketchFeature = {
    id: 'B',
    name: 'Circle B',
    kind: 'circle',
    operation: 'add',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 12, y: 0 },
        segments: [
          { type: 'circle', center: { x: 10, y: 0 }, to: { x: 12, y: 0 }, clockwise: true },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [
        {
          id: 'c1',
          type: 'fixed_distance',
          segment_ids: ['A'],
          value: 10,
          anchor_point: { x: 10, y: 0 },
          reference_point: { x: 0, y: 0 },
        },
      ],
    },
  }

  let features = [featureA, featureB]
  const dx = 1.0
  const dy = 0.5

  for (let i = 1; i <= 10; i++) {
    // Manually move A in the input list
    features = features.map(f => f.id === 'A' ? {
      ...f,
      sketch: {
        ...f.sketch,
        profile: transformProfile(f.sketch.profile, (p) => ({ x: p.x + dx, y: p.y + dy }))
      }
    } : f)

    const movedOffsets = new Map([['A', { dx, dy }]])
    features = propagateConstraintsOnTranslate(features, movedOffsets, { transformProfile })
    
    const currentA = features.find(f => f.id === 'A')!
    const currentB = features.find(f => f.id === 'B')!
    
    // Feature B should have moved by the same total offset as A
    // Total offset after i steps is (i*dx, i*dy)
    assert(approx(currentA.sketch.profile.start.x, i * dx), `A.x should be ${i * dx} at step ${i}, got ${currentA.sketch.profile.start.x}`)
    assert(approx(currentB.sketch.profile.start.x, 12 + i * dx), `B.x should be ${12 + i * dx} at step ${i}, got ${currentB.sketch.profile.start.x}`)
    
    // Check constraint value hasn't drifted
    const constraint = currentB.sketch.constraints[0]
    assert(approx(constraint.value!, 10), `Constraint value should stay 10 at step ${i}, got ${constraint.value}`)
  }

  console.log('10 Repeated Moves Test Passed!')
}

function testRepeatedRotates() {
  console.log('Testing 10 Repeated Rotates...')

  let featureA: SketchFeature = {
    id: 'A',
    name: 'Rect A',
    kind: 'rect',
    operation: 'add',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 5, y: 0 } },
          { type: 'line', to: { x: 5, y: 5 } },
          { type: 'line', to: { x: 0, y: 5 } },
          { type: 'line', to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }

  let featureB: SketchFeature = {
    id: 'B',
    name: 'Circle B',
    kind: 'circle',
    operation: 'add',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 12, y: 0 },
        segments: [
          { type: 'circle', center: { x: 10, y: 0 }, to: { x: 12, y: 0 }, clockwise: true },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [
        {
          id: 'c1',
          type: 'fixed_distance',
          segment_ids: ['A'],
          value: 10,
          anchor_point: { x: 10, y: 0 },
          reference_point: { x: 0, y: 0 },
        },
      ],
    },
  }

  let features = [featureA, featureB]
  const pivot = { x: 2.5, y: 2.5 }
  const angle = Math.PI / 10 // 18 degrees per step

  for (let i = 1; i <= 10; i++) {
    // Manually rotate A in the input list
    features = features.map(f => f.id === 'A' ? {
      ...f,
      sketch: {
        ...f.sketch,
        profile: transformProfile(f.sketch.profile, (p) => {
          const localX = p.x - pivot.x
          const localY = p.y - pivot.y
          const cos = Math.cos(angle)
          const sin = Math.sin(angle)
          return {
            x: pivot.x + localX * cos - localY * sin,
            y: pivot.y + localX * sin + localY * cos,
          }
        })
      }
    } : f)

    const movedRotations = new Map([['A', { pivot, angle }]])
    features = propagateConstraintsOnRotate(features, movedRotations, { transformProfile })
    
    const currentB = features.find(f => f.id === 'B')!
    const nextCenter = (currentB.sketch.profile.segments[0] as any).center
    
    // After i steps, total rotation is i * angle
    const expectedAngle = i * angle
    const cosTotal = Math.cos(expectedAngle)
    const sinTotal = Math.sin(expectedAngle)
    const ex = pivot.x + 7.5 * cosTotal - (-2.5) * sinTotal
    const ey = pivot.y + 7.5 * sinTotal + (-2.5) * cosTotal
    
    assert(approx(nextCenter.x, ex), `B center x should be ${ex} at step ${i}, got ${nextCenter.x}`)
    assert(approx(nextCenter.y, ey), `B center y should be ${ey} at step ${i}, got ${nextCenter.y}`)

    const constraint = currentB.sketch.constraints[0]
    assert(approx(constraint.value!, 10), `Constraint value should stay 10 at step ${i}, got ${constraint.value}`)
  }

  console.log('10 Repeated Rotates Test Passed!')
}

function testSmallFeatures() {
  console.log('Testing Small Features (0.125 in circles in 1.25 in rect)...')

  const featureA: SketchFeature = {
    id: 'A',
    name: 'Small Rect',
    kind: 'rect',
    operation: 'add',
    z_top: 0,
    z_bottom: -0.5,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 1.25, y: 0 } },
          { type: 'line', to: { x: 1.25, y: 1.25 } },
          { type: 'line', to: { x: 0, y: 1.25 } },
          { type: 'line', to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }

  const featureB: SketchFeature = {
    id: 'B',
    name: 'Small Circle',
    kind: 'circle',
    operation: 'subtract',
    z_top: 0,
    z_bottom: -0.5,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 0.625 + 0.125, y: 0.625 },
        segments: [
          { type: 'circle', center: { x: 0.625, y: 0.625 }, to: { x: 0.625 + 0.125, y: 0.625 }, clockwise: true },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [
        {
          id: 'c1',
          type: 'fixed_distance',
          segment_ids: ['A'],
          value: 0.625,
          anchor_point: { x: 0.625, y: 0.625 },
          reference_point: { x: 0, y: 0.625 }, // constrained to middle of left edge
        },
      ],
    },
  }

  let features = [featureA, featureB]
  for (let i = 1; i <= 5; i++) {
    const movedOffsets = new Map([['A', { dx: 0.1, dy: 0.1 }]])
    features = propagateConstraintsOnTranslate(features, movedOffsets, { transformProfile })
    
    const currentB = features.find(f => f.id === 'B')!
    const center = (currentB.sketch.profile.segments[0] as any).center
    assert(approx(center.x, 0.625 + i * 0.1), `Circle center x should be ${0.625 + i * 0.1}`)
  }

  console.log('Small Features Test Passed!')
}

function testComplexMultiDependencyRepeatedMoves() {
  console.log('Testing Complex Multi-Dependency Repeated Moves (User Data)...')
  
  // Feature A (Rect 1)
  let featureA: SketchFeature = {
    id: 'f0001', name: 'Rect 1', kind: 'rect', operation: 'add', z_top: 0.75, z_bottom: 0, visible: true, locked: false, folderId: null,
    sketch: {
      profile: {
        start: { x: 0.375, y: 1.25 },
        segments: [
          { type: 'line', to: { x: 1.75, y: 1.25 } },
          { type: 'line', to: { x: 1.75, y: 1.75 } },
          { type: 'line', to: { x: 0.375, y: 1.75 } },
          { type: 'line', to: { x: 0.375, y: 1.25 } }
        ],
        closed: true
      },
      origin: { x: 0, y: 0 }, orientationAngle: 90, dimensions: [], constraints: []
    }
  }

  // Feature B (Circle 2) -> depends on Rect 1
  let featureB: SketchFeature = {
    id: 'f0002', name: 'Circle 2', kind: 'circle', operation: 'subtract', z_top: 0.75, z_bottom: 0, visible: true, locked: false, folderId: null,
    sketch: {
      profile: {
        start: { x: 1.375, y: 1.5 },
        segments: [{ type: 'circle', center: { x: 1.25, y: 1.5 }, to: { x: 1.375, y: 1.5 }, clockwise: true }],
        closed: true
      },
      origin: { x: 0, y: 0 }, orientationAngle: 90, dimensions: [],
      constraints: [
        {
          id: 'c0003', type: 'fixed_distance', segment_ids: ['f0001'], value: 0.25,
          anchor_point: { x: 1.25, y: 1.5 }, reference_point: { x: 1.25, y: 1.25 },
          reference_segment: { a: { x: 0.375, y: 1.25 }, b: { x: 1.75, y: 1.25 } }
        }
      ]
    }
  }

  // Feature C (Circle 4) -> depends on Circle 2 AND Rect 1
  let featureC: SketchFeature = {
    id: 'f0008', name: 'Circle 4', kind: 'circle', operation: 'subtract', z_top: 0.75, z_bottom: 0, visible: true, locked: false, folderId: null,
    sketch: {
      profile: {
        start: { x: 1, y: 1.5 },
        segments: [{ type: 'circle', center: { x: 0.875, y: 1.5 }, to: { x: 1, y: 1.5 }, clockwise: true }],
        closed: true
      },
      origin: { x: 0, y: 0 }, orientationAngle: 90, dimensions: [],
      constraints: [
        {
          id: 'c0009', type: 'fixed_distance', segment_ids: ['f0002'], value: 0.375,
          anchor_point: { x: 0.875, y: 1.5 }, reference_point: { x: 1.25, y: 1.5 }
        },
        {
          id: 'c0010', type: 'fixed_distance', segment_ids: ['f0001'], value: 0.25,
          anchor_point: { x: 0.875, y: 1.5 }, reference_point: { x: 0.875, y: 1.25 },
          reference_segment: { a: { x: 0.375, y: 1.25 }, b: { x: 1.75, y: 1.25 } }
        }
      ]
    }
  }

  let features = [featureA, featureB, featureC]
  const dx = 0.5
  const dy = 0.25

  for (let i = 1; i <= 10; i++) {
    // Manually move A in the list
    features = features.map(f => f.id === 'f0001' ? {
      ...f,
      sketch: {
        ...f.sketch,
        profile: transformProfile(f.sketch.profile, (p) => ({ x: p.x + dx, y: p.y + dy }))
      }
    } : f)

    const movedOffsets = new Map([['f0001', { dx, dy }]])
    features = propagateConstraintsOnTranslate(features, movedOffsets, { transformProfile })
    
    // Circle 4 (featureC) should move by the same cumulative amount (i*dx, i*dy)
    const currentC = features.find(f => f.id === 'f0008')!
    assert(approx(currentC.sketch.profile.start.x, 1.0 + i * dx), `C.x should be ${1.0 + i * dx} at step ${i}, got ${currentC.sketch.profile.start.x}`)
    assert(approx(currentC.sketch.profile.start.y, 1.5 + i * dy), `C.y should be ${1.5 + i * dy} at step ${i}, got ${currentC.sketch.profile.start.y}`)
  }

  console.log('Complex Multi-Dependency Repeated Moves Passed!')
}

try {
  testTranslatePropagation()
  testRotatePropagation()
  testMultiConstraintPropagation()
  testRepeatedMoves()
  testRepeatedRotates()
  testSmallFeatures()
  testComplexMultiDependencyRepeatedMoves()
} catch (e) {
  console.error(e)
}
