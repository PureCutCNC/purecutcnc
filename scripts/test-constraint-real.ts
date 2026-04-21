import { propagateConstraintsOnTranslate } from '../src/sketch/constraintSolver.ts'
import type { FeatureOffset } from '../src/sketch/constraintSolver.ts'
import type { SketchFeature, LocalConstraint, Point } from '../types/project.ts'

// Mock translateProfile
function translateProfile(profile: any, dx: number, dy: number) {
  return {
    ...profile,
    start: { x: profile.start.x + dx, y: profile.start.y + dy },
    segments: profile.segments.map((seg: any) => ({
      ...seg,
      to: { x: seg.to.x + dx, y: seg.to.y + dy },
    })),
  }
}

// Create test features similar to the JS test
function createTestScenario(): SketchFeature[] {
  const rect1: SketchFeature = {
    id: 'rect1',
    name: 'Rect 1',
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 100, y: 0 } },
          { type: 'line', to: { x: 100, y: 50 } },
          { type: 'line', to: { x: 0, y: 50 } },
        ],
        closed: true,
      },
      constraints: [],
    },
    locked: false,
  }

  const circle2: SketchFeature = {
    id: 'circle2',
    name: 'Circle 2',
    sketch: {
      profile: {
        start: { x: 110, y: 25 }, // 10 units to the right of rect1
        segments: [
          { type: 'circle', center: { x: 110, y: 25 }, to: { x: 115, y: 25 }, clockwise: true },
        ],
        closed: true,
      },
      constraints: [
        {
          id: 'c1',
          type: 'fixed_distance',
          segment_ids: ['rect1'],
          value: 10, // 10 units distance
          anchor_point: { x: 110, y: 25 }, // Circle center
          reference_point: { x: 100, y: 25 }, // Right edge of rect
        } as LocalConstraint,
      ],
    },
    locked: false,
  }

  return [rect1, circle2]
}

function main() {
  console.log('Testing actual constraint solver...')
  const features = createTestScenario()
  
  // First move: Rect 1 right by 20
  const movedOffsets = new Map<string, FeatureOffset>()
  movedOffsets.set('rect1', { dx: 20, dy: 0 })
  
  const result1 = propagateConstraintsOnTranslate(features, movedOffsets, { translateProfile })
  
  console.log('After first move:')
  const rect1After = result1.find(f => f.id === 'rect1')
  const circle2After = result1.find(f => f.id === 'circle2')
  console.log('Rect 1 position:', rect1After?.sketch.profile.start)
  console.log('Circle 2 position:', circle2After?.sketch.profile.start)
  console.log('Circle 2 constraints:', JSON.stringify(circle2After?.sketch.constraints, null, 2))
  
  // Compute actual distance
  const rectRightEdge = 20 + 100 // rect moved 20, width 100
  const circleX = circle2After?.sketch.profile.start.x ?? 0
  const distance = Math.abs(circleX - rectRightEdge)
  console.log('Actual distance:', distance)
  console.log('Expected distance: 10')
  console.log('Distance correct?', Math.abs(distance - 10) < 1e-6 ? '✓ YES' : '✗ NO')
  
  // Second move: another 20
  // Note: need to create new movedOffsets for second move (relative to current positions)
  const movedOffsets2 = new Map<string, FeatureOffset>()
  movedOffsets2.set('rect1', { dx: 20, dy: 0 })
  const result2 = propagateConstraintsOnTranslate(result1, movedOffsets2, { translateProfile })
  
  console.log('\nAfter second move:')
  const rect1After2 = result2.find(f => f.id === 'rect1')
  const circle2After2 = result2.find(f => f.id === 'circle2')
  console.log('Rect 1 position:', rect1After2?.sketch.profile.start)
  console.log('Circle 2 position:', circle2After2?.sketch.profile.start)
  const rectRightEdge2 = 40 + 100
  const circleX2 = circle2After2?.sketch.profile.start.x ?? 0
  const distance2 = Math.abs(circleX2 - rectRightEdge2)
  console.log('Actual distance:', distance2)
  console.log('Expected distance: 10')
  console.log('Distance correct?', Math.abs(distance2 - 10) < 1e-6 ? '✓ YES' : '✗ NO')
}

main()