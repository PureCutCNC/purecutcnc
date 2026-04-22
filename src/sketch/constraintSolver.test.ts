
import { propagateConstraintsOnTranslate, propagateConstraintsOnRotate, rederiveConstraintGeometry, calculateGeometricCenter, nearestVertexIndex, nearestSegmentIndex, projectPointOntoSegmentT } from './constraintSolver'
import type { SketchFeature, Point, SketchProfile } from '../types/project'

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

function testSemanticRederivation() {
  console.log('Testing Semantic Re-derivation...')

  // Rect: start(0,0), segments to (10,0),(10,5),(0,5),(0,0)
  const rectProfile: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [
      { type: 'line', to: { x: 10, y: 0 } },
      { type: 'line', to: { x: 10, y: 5 } },
      { type: 'line', to: { x: 0, y: 5 } },
      { type: 'line', to: { x: 0, y: 0 } },
    ],
    closed: true,
  }

  // Natural center (-1)
  const center = calculateGeometricCenter(rectProfile)
  assert(approx(center.x, 5), 'Center x should be 5')
  assert(approx(center.y, 2.5), 'Center y should be 2.5')

  // Nearest vertex to (9.9, 0.1) should be index 1 (10,0)
  const vi = nearestVertexIndex(rectProfile, { x: 9.9, y: 0.1 })
  assert(vi === 1, `Nearest vertex should be 1, got ${vi}`)

  // Nearest segment midpoint to (5, 0.1) should be segment 0 (midpoint (5,0))
  const si = nearestSegmentIndex(rectProfile, { x: 5, y: 0.1 })
  assert(si === 0, `Nearest segment should be 0, got ${si}`)

  // Rederive: anchor_type='anchor', anchor_index=0 -> (0,0)
  // reference_type='anchor', reference_index=-1 -> center (5,2.5)
  const ownerProfile: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [{ type: 'circle', center: { x: 0, y: 0 }, to: { x: 2, y: 0 }, clockwise: true }],
    closed: true,
  }
  const result = rederiveConstraintGeometry(ownerProfile, rectProfile, {
    id: 'c1',
    type: 'fixed_distance',
    segment_ids: [],
    value: 5,
    anchor_index: -1,
    anchor_type: 'anchor',
    reference_index: -1,
    reference_type: 'anchor',
  })
  assert(result !== null, 'Result should not be null')
  assert(result!.isValid, 'Result should be valid')
  assert(approx(result!.anchorPoint.x, 0), 'Anchor should be center of circle owner (0,0)')
  assert(approx(result!.referencePoint!.x, 5), 'Reference should be center of rect (5,2.5)')

  // Rederive: reference_type='segment', reference_index=0 -> segment (0,0)-(10,0)
  const result2 = rederiveConstraintGeometry(ownerProfile, rectProfile, {
    id: 'c2',
    type: 'fixed_distance',
    segment_ids: [],
    value: 3,
    anchor_index: -1,
    anchor_type: 'anchor',
    reference_index: 0,
    reference_type: 'segment',
  })
  assert(result2 !== null, 'Result2 should not be null')
  assert(result2!.isValid, 'Result2 should be valid')
  assert(result2!.referenceSegment !== undefined, 'Should have reference segment')
  assert(approx(result2!.referenceSegment!.a.x, 0), 'Segment a.x should be 0')
  assert(approx(result2!.referenceSegment!.b.x, 10), 'Segment b.x should be 10')

  // Out-of-bounds index should return invalid
  const result3 = rederiveConstraintGeometry(ownerProfile, rectProfile, {
    id: 'c3',
    type: 'fixed_distance',
    segment_ids: [],
    value: 3,
    anchor_index: 99,
    anchor_type: 'anchor',
    reference_index: 0,
    reference_type: 'anchor',
  })
  assert(result3 !== null, 'Result3 should not be null')
  assert(!result3!.isValid, 'Result3 should be invalid (out of bounds)')

  console.log('Semantic Re-derivation Test Passed!')
}

function testSemanticPropagation() {
  console.log('Testing Semantic Propagation (index-based)...')

  // Rect A: vertices (0,0),(10,0),(10,5),(0,5)
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
          { type: 'line', to: { x: 10, y: 0 } },
          { type: 'line', to: { x: 10, y: 5 } },
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

  // Circle B: center at (5, -8), constrained to natural center of A at distance 10
  // Natural center of A = (5, 2.5), distance from (5,-8) to (5,2.5) = 10.5 (approx)
  // We'll set value=10 and let solver position it
  const featureB: SketchFeature = {
    id: 'B',
    name: 'Circle B',
    kind: 'circle',
    operation: 'subtract',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 7, y: 0 },
        segments: [
          { type: 'circle', center: { x: 5, y: 0 }, to: { x: 7, y: 0 }, clockwise: true },
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
          // Semantic: anchor = natural center of B (-1), reference = natural center of A (-1)
          anchor_index: -1,
          anchor_type: 'anchor' as const,
          reference_feature_id: 'A',
          reference_index: -1,
          reference_type: 'anchor' as const,
          // Cached coords (will be refreshed by propagation)
          anchor_point: { x: 5, y: 0 },
          reference_point: { x: 5, y: 2.5 },
        },
      ],
    },
  }

  const features = [featureA, featureB]
  // Move A by (20, 0) — B should follow to maintain distance 10 from A's new center
  const movedOffsets = new Map([['A', { dx: 20, dy: 0 }]])
  const nextFeatures = propagateConstraintsOnTranslate(features, movedOffsets, { transformProfile })

  const nextA = nextFeatures.find(f => f.id === 'A')!
  const nextB = nextFeatures.find(f => f.id === 'B')!
  const nextBCenter = (nextB.sketch.profile.segments[0] as any).center
  const nextACenter = calculateGeometricCenter(nextA.sketch.profile)

  // B's center should be 10 units from A's new center
  const dist = Math.hypot(nextBCenter.x - nextACenter.x, nextBCenter.y - nextACenter.y)
  assert(approx(dist, 10, 0.1), `Distance should be 10, got ${dist}`)

  console.log('Semantic Propagation Test Passed!')
}

function testSemanticInvalidation() {
  console.log('Testing Semantic Invalidation (out-of-bounds index)...')

  const ownerProfile: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [{ type: 'circle', center: { x: 0, y: 0 }, to: { x: 2, y: 0 }, clockwise: true }],
    closed: true,
  }

  // Reference profile with only 4 vertices (rect)
  const refProfile: SketchProfile = {
    start: { x: 10, y: 0 },
    segments: [
      { type: 'line', to: { x: 20, y: 0 } },
      { type: 'line', to: { x: 20, y: 5 } },
      { type: 'line', to: { x: 10, y: 5 } },
      { type: 'line', to: { x: 10, y: 0 } },
    ],
    closed: true,
  }

  // Constraint referencing vertex index 99 (out of bounds)
  const result = rederiveConstraintGeometry(ownerProfile, refProfile, {
    id: 'c1',
    type: 'fixed_distance',
    segment_ids: [],
    value: 5,
    anchor_index: -1,
    anchor_type: 'anchor' as const,
    reference_index: 99,
    reference_type: 'anchor' as const,
  })

  assert(result !== null, 'Should return a result')
  assert(!result!.isValid, 'Should be invalid')
  assert(!!result!.errorMessage, 'Should have error message')

  // Null reference profile -> invalid
  const result2 = rederiveConstraintGeometry(ownerProfile, null, {
    id: 'c2',
    type: 'fixed_distance',
    segment_ids: [],
    value: 5,
    anchor_index: -1,
    anchor_type: 'anchor' as const,
    reference_index: 0,
    reference_type: 'anchor' as const,
  })
  assert(result2 !== null, 'Should return a result for null ref')
  assert(!result2!.isValid, 'Should be invalid for null ref')

  console.log('Semantic Invalidation Test Passed!')
}

function testOwnerMovedUpdatesValue() {
  console.log('Testing Owner Moved Updates Constraint Value...')

  // Rect A at origin
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
          { type: 'line', to: { x: 10, y: 0 } },
          { type: 'line', to: { x: 10, y: 5 } },
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

  // Circle B at (20, 0), constrained to vertex 0 of A (0,0) at distance 20
  const featureB: SketchFeature = {
    id: 'B',
    name: 'Circle B',
    kind: 'circle',
    operation: 'subtract',
    z_top: 0,
    z_bottom: -10,
    visible: true,
    locked: false,
    folderId: null,
    sketch: {
      profile: {
        start: { x: 22, y: 0 },
        segments: [
          { type: 'circle', center: { x: 20, y: 0 }, to: { x: 22, y: 0 }, clockwise: true },
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
          value: 20,
          anchor_index: -1,
          anchor_type: 'anchor' as const,
          reference_feature_id: 'A',
          reference_index: 0,
          reference_type: 'anchor' as const,
          anchor_point: { x: 20, y: 0 },
          reference_point: { x: 0, y: 0 },
        },
      ],
    },
  }

  // Move B (the owner) by +5 in x — constraint value should update to 25
  const features = [featureA, featureB]
  const movedOffsets = new Map([['B', { dx: 5, dy: 0 }]])

  // Manually apply the move to B's profile first (simulating what the store does)
  const movedFeatures = features.map(f => f.id === 'B' ? {
    ...f,
    sketch: {
      ...f.sketch,
      profile: transformProfile(f.sketch.profile, (p) => ({ x: p.x + 5, y: p.y }))
    }
  } : f)

  const nextFeatures = propagateConstraintsOnTranslate(movedFeatures, movedOffsets, { transformProfile })
  const nextB = nextFeatures.find(f => f.id === 'B')!
  const constraint = nextB.sketch.constraints[0]

  // The constraint value should have been updated to reflect the new distance (25)
  assert(approx(constraint.value!, 25, 0.01), `Constraint value should be 25, got ${constraint.value}`)

  console.log('Owner Moved Updates Value Test Passed!')
}

function testPointOnSegmentRederivation() {
  console.log('Testing Point-on-Segment Re-derivation (Issue 12)...')

  // Rect: start(0,0), top edge segment 0: (0,0)->(20,0)
  const rectProfile: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [
      { type: 'line', to: { x: 20, y: 0 } },
      { type: 'line', to: { x: 20, y: 10 } },
      { type: 'line', to: { x: 0, y: 10 } },
      { type: 'line', to: { x: 0, y: 0 } },
    ],
    closed: true,
  }

  // Circle constrained to a point 30% along the top edge (x=6, y=0)
  const ownerProfile: SketchProfile = {
    start: { x: 7, y: -5 },
    segments: [{ type: 'circle', center: { x: 6, y: -5 }, to: { x: 7, y: -5 }, clockwise: true }],
    closed: true,
  }

  const result = rederiveConstraintGeometry(ownerProfile, rectProfile, {
    id: 'c1',
    type: 'fixed_distance',
    segment_ids: [],
    value: 5,
    anchor_index: -1,
    anchor_type: 'anchor' as const,
    reference_index: 0,
    reference_type: 'point_on_segment' as const,
    reference_t: 0.3,  // 30% along top edge = x=6
  })

  assert(result !== null, 'Result should not be null')
  assert(result!.isValid, 'Result should be valid')
  assert(approx(result!.referencePoint!.x, 6), `Reference point x should be 6 (30% of 20), got ${result!.referencePoint!.x}`)
  assert(approx(result!.referencePoint!.y, 0), `Reference point y should be 0, got ${result!.referencePoint!.y}`)

  // Now simulate rect being resized to width 40 (top edge: (0,0)->(40,0))
  // 30% along new edge = x=12
  const resizedRectProfile: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [
      { type: 'line', to: { x: 40, y: 0 } },
      { type: 'line', to: { x: 40, y: 10 } },
      { type: 'line', to: { x: 0, y: 10 } },
      { type: 'line', to: { x: 0, y: 0 } },
    ],
    closed: true,
  }

  const result2 = rederiveConstraintGeometry(ownerProfile, resizedRectProfile, {
    id: 'c1',
    type: 'fixed_distance',
    segment_ids: [],
    value: 5,
    anchor_index: -1,
    anchor_type: 'anchor' as const,
    reference_index: 0,
    reference_type: 'point_on_segment' as const,
    reference_t: 0.3,
  })

  assert(result2 !== null, 'Result2 should not be null')
  assert(result2!.isValid, 'Result2 should be valid')
  assert(approx(result2!.referencePoint!.x, 12), `After resize, reference point x should be 12 (30% of 40), got ${result2!.referencePoint!.x}`)

  // Test projectPointOntoSegmentT
  const t = projectPointOntoSegmentT({ x: 6, y: 2 }, { x: 0, y: 0 }, { x: 20, y: 0 })
  assert(approx(t, 0.3), `t should be 0.3, got ${t}`)

  console.log('Point-on-Segment Re-derivation Test Passed!')
}

function testSegmentSidePreservation() {
  console.log('Testing Segment Side Preservation (Issue 14)...')

  // Rect A: top edge segment 0 is (0,0)->(20,0), normal points upward (negative Y in screen coords)
  // Circle B is ABOVE the top edge (negative Y = above in screen coords), constrained at signed dist = -5
  let featureA: SketchFeature = {
    id: 'A', name: 'Rect A', kind: 'rect', operation: 'add',
    z_top: 0, z_bottom: -10, visible: true, locked: false, folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 20, y: 0 } },
          { type: 'line', to: { x: 20, y: 10 } },
          { type: 'line', to: { x: 0, y: 10 } },
          { type: 'line', to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
  }

  // Circle B center at (10, -5) — above the top edge (y=-5 is above y=0 in screen coords)
  // Segment normal for top edge (0,0)->(20,0): nx=0, ny=-1 (pointing up/negative Y)
  // signed dist = ((-5) - 0) * (-1) = 5... wait, let's compute:
  // nx = -(0-0)/20 = 0, ny = (20-0)/20 = 1 — normal points in +Y direction
  // signed dist from (10,-5) to segment: (-5 - 0)*1 = -5 (below the normal = above the edge visually)
  // So value = -5 means the circle is on the negative-normal side
  let featureB: SketchFeature = {
    id: 'B', name: 'Circle B', kind: 'circle', operation: 'subtract',
    z_top: 0, z_bottom: -10, visible: true, locked: false, folderId: null,
    sketch: {
      profile: {
        start: { x: 11, y: -5 },
        segments: [{ type: 'circle', center: { x: 10, y: -5 }, to: { x: 11, y: -5 }, clockwise: true }],
        closed: true,
      },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [],
      constraints: [
        {
          id: 'c1', type: 'fixed_distance', segment_ids: ['A'],
          value: -5,  // signed: negative side of segment normal
          anchor_index: -1, anchor_type: 'anchor' as const,
          reference_feature_id: 'A',
          reference_index: 0, reference_type: 'segment' as const,
          anchor_point: { x: 10, y: -5 },
          reference_point: { x: 10, y: 0 },
          reference_segment: { a: { x: 0, y: 0 }, b: { x: 20, y: 0 } },
        },
      ],
    },
  }

  // Simulate rect being resized: top edge moves to y=3 (shrinking from top)
  // Circle should stay on the negative-normal side (y < 3), at distance 5 from new edge
  // New top edge: (0,3)->(20,3), normal still +Y
  // Circle should end up at y = 3 + (-5) = -2
  const resizedA: SketchFeature = {
    ...featureA,
    sketch: {
      ...featureA.sketch,
      profile: {
        start: { x: 0, y: 3 },
        segments: [
          { type: 'line', to: { x: 20, y: 3 } },
          { type: 'line', to: { x: 20, y: 10 } },
          { type: 'line', to: { x: 0, y: 10 } },
          { type: 'line', to: { x: 0, y: 3 } },
        ],
        closed: true,
      },
    },
  }

  const features = [resizedA, featureB]
  const movedOffsets = new Map([['A', { dx: 0, dy: 0 }]])
  const nextFeatures = propagateConstraintsOnTranslate(features, movedOffsets, { transformProfile })

  const nextB = nextFeatures.find(f => f.id === 'B')!
  const nextCenter = (nextB.sketch.profile.segments[0] as any).center

  // Circle should be at y = 3 + (-5) = -2 (still on negative-normal side)
  assert(approx(nextCenter.y, -2, 0.1), `Circle y should be -2 (negative side preserved), got ${nextCenter.y}`)
  assert(nextCenter.y < 3, `Circle should remain on negative side of segment (y < 3), got y=${nextCenter.y}`)

  console.log('Segment Side Preservation Test Passed!')
}

function testFrozenInvalidFeature() {
  console.log('Testing Frozen Invalid Feature (Issue 7)...')

  // Rect A at origin
  const featureA: SketchFeature = {
    id: 'A', name: 'Rect A', kind: 'rect', operation: 'add',
    z_top: 0, z_bottom: -10, visible: true, locked: false, folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 10, y: 0 } },
          { type: 'line', to: { x: 10, y: 5 } },
          { type: 'line', to: { x: 0, y: 5 } },
          { type: 'line', to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
  }

  // Circle B constrained to A, but constraint is marked invalid due to STRUCTURAL reason (reference deleted)
  const featureB: SketchFeature = {
    id: 'B', name: 'Circle B', kind: 'circle', operation: 'subtract',
    z_top: 0, z_bottom: -10, visible: true, locked: false, folderId: null,
    sketch: {
      profile: {
        start: { x: 17, y: 0 },
        segments: [{ type: 'circle', center: { x: 15, y: 0 }, to: { x: 17, y: 0 }, clockwise: true }],
        closed: true,
      },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [],
      constraints: [
        {
          id: 'c1', type: 'fixed_distance', segment_ids: ['A'],
          value: 10,
          anchor_index: -1, anchor_type: 'anchor' as const,
          reference_feature_id: 'A',
          reference_index: 99,  // out-of-bounds index — structural invalidity
          reference_type: 'anchor' as const,
          anchor_point: { x: 15, y: 0 },
          reference_point: { x: 0, y: 0 },
          is_invalid: true,
          error_message: 'Reference index out of bounds',
        },
      ],
    },
  }

  const features = [featureA, featureB]
  // Move A by +20 — B should NOT follow because its constraint is invalid
  const movedOffsets = new Map([['A', { dx: 20, dy: 0 }]])
  const nextFeatures = propagateConstraintsOnTranslate(features, movedOffsets, { transformProfile })

  const nextB = nextFeatures.find(f => f.id === 'B')!
  const nextBCenter = (nextB.sketch.profile.segments[0] as any).center

  // B should stay at x=15 (frozen)
  assert(approx(nextBCenter.x, 15), `B should be frozen at x=15, got ${nextBCenter.x}`)
  assert(approx(nextBCenter.y, 0), `B should be frozen at y=0, got ${nextBCenter.y}`)

  console.log('Frozen Invalid Feature Test Passed!')
}

function testZeroSeedDoesNotUpdateValues() {
  console.log('Testing Zero-Seed Does Not Update Constraint Values (Issue 8)...')

  // Rect A at origin
  const featureA: SketchFeature = {
    id: 'A', name: 'Rect A', kind: 'rect', operation: 'add',
    z_top: 0, z_bottom: -10, visible: true, locked: false, folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 10, y: 0 } },
          { type: 'line', to: { x: 10, y: 10 } },
          { type: 'line', to: { x: 0, y: 10 } },
          { type: 'line', to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
  }

  // Circle B with TWO constraints to A: one to vertex 0 (0,0) at distance 5, one to vertex 1 (10,0) at distance 5
  const featureB: SketchFeature = {
    id: 'B', name: 'Circle B', kind: 'circle', operation: 'subtract',
    z_top: 0, z_bottom: -10, visible: true, locked: false, folderId: null,
    sketch: {
      profile: {
        start: { x: 6, y: 0 },
        segments: [{ type: 'circle', center: { x: 5, y: 0 }, to: { x: 6, y: 0 }, clockwise: true }],
        closed: true,
      },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [],
      constraints: [
        {
          id: 'c1', type: 'fixed_distance', segment_ids: ['A'],
          value: 5,
          anchor_index: -1, anchor_type: 'anchor' as const,
          reference_feature_id: 'A',
          reference_index: 0, reference_type: 'anchor' as const,
          anchor_point: { x: 5, y: 0 },
          reference_point: { x: 0, y: 0 },
        },
        {
          id: 'c2', type: 'fixed_distance', segment_ids: ['A'],
          value: 5,
          anchor_index: -1, anchor_type: 'anchor' as const,
          reference_feature_id: 'A',
          reference_index: 1, reference_type: 'anchor' as const,
          anchor_point: { x: 5, y: 0 },
          reference_point: { x: 10, y: 0 },
        },
      ],
    },
  }

  const features = [featureA, featureB]
  // Zero-displacement seed on B (simulating updateConstraintValue re-deriving reference geometry)
  const movedOffsets = new Map([['B', { dx: 0, dy: 0 }]])
  const nextFeatures = propagateConstraintsOnTranslate(features, movedOffsets, { transformProfile })

  const nextB = nextFeatures.find(f => f.id === 'B')!
  // Both constraint values should remain 5 — not updated by the zero-seed
  assert(approx(nextB.sketch.constraints[0].value!, 5), `c1 value should stay 5, got ${nextB.sketch.constraints[0].value}`)
  assert(approx(nextB.sketch.constraints[1].value!, 5), `c2 value should stay 5, got ${nextB.sketch.constraints[1].value}`)

  console.log('Zero-Seed Does Not Update Values Test Passed!')
}

try {
  testTranslatePropagation()
  testRotatePropagation()
  testMultiConstraintPropagation()
  testRepeatedMoves()
  testRepeatedRotates()
  testSmallFeatures()
  testComplexMultiDependencyRepeatedMoves()
  testSemanticRederivation()
  testSemanticPropagation()
  testSemanticInvalidation()
  testOwnerMovedUpdatesValue()
  testFrozenInvalidFeature()
  testZeroSeedDoesNotUpdateValues()
  testPointOnSegmentRederivation()
  testSegmentSidePreservation()
} catch (e) {
  console.error(e)
}
