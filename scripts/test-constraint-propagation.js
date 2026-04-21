/**
 * Test script for constraint propagation bug
 * 
 * This script simulates moving a parent feature (Rect 1) multiple times
 * and checks if a constrained child feature (Circle 2) maintains its
 * distance constraint across multiple moves.
 * 
 * Run with: node scripts/test-constraint-propagation.js
 */

// Mock the constraint solver functions
function translateProfile(profile, dx, dy) {
  return {
    ...profile,
    start: { x: profile.start.x + dx, y: profile.start.y + dy },
    segments: profile.segments.map(seg => ({
      ...seg,
      to: { x: seg.to.x + dx, y: seg.to.y + dy },
    })),
  }
}

function translateAnchorFields(constraint, dx, dy) {
  if (constraint.type !== 'fixed_distance' || !constraint.anchor_point) return constraint
  return {
    ...constraint,
    anchor_point: {
      x: constraint.anchor_point.x + dx,
      y: constraint.anchor_point.y + dy,
    },
  }
}

function translateReferenceFields(constraint, refFeatureId, dx, dy) {
  if (constraint.type !== 'fixed_distance' || constraint.segment_ids.length === 0 || constraint.segment_ids[0] !== refFeatureId) {
    return constraint
  }
  const next = { ...constraint }
  if (constraint.reference_point) {
    next.reference_point = {
      x: constraint.reference_point.x + dx,
      y: constraint.reference_point.y + dy,
    }
  }
  return next
}

function solveFeatureTranslation(anchor, reference, targetDistance) {
  const dx = anchor.x - reference.x
  const dy = anchor.y - reference.y
  const currentDistance = Math.hypot(dx, dy)
  
  if (currentDistance < 1e-9) return { dx: 0, dy: 0 }
  
  const scale = targetDistance / currentDistance
  const targetX = reference.x + dx * scale
  const targetY = reference.y + dy * scale
  
  return {
    dx: targetX - anchor.x,
    dy: targetY - anchor.y,
  }
}

// Create test features
function createTestScenario() {
  const rect1 = {
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
  }

  const circle2 = {
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
        },
      ],
    },
  }

  return [rect1, circle2]
}

// Simulate propagateConstraintsOnTranslate
function propagateConstraints(features, movedOffsets) {
  const byId = new Map(features.map(f => [f.id, { ...f }]))
  const movedIds = new Set(movedOffsets.keys())

  console.log('\n=== Starting propagateConstraints ===')
  console.log('Moved features:', Array.from(movedIds))
  console.log('Move offsets:', Array.from(movedOffsets.entries()))

  // Step 1: Clear constraints on moved features
  for (const [id, feature] of byId) {
    if (movedIds.has(id)) {
      console.log(`\nClearing constraints on moved feature: ${id}`)
      const kept = feature.sketch.constraints.filter(c => c.type !== 'fixed_distance')
      if (kept.length !== feature.sketch.constraints.length) {
        byId.set(id, { ...feature, sketch: { ...feature.sketch, constraints: kept } })
      }
      continue
    }

    // Step 2: Update reference AND anchor points for features that reference moved features
    let changed = false
    const nextConstraints = feature.sketch.constraints.map(c => {
      if (c.type !== 'fixed_distance' || c.segment_ids.length === 0) return c
      const offset = movedOffsets.get(c.segment_ids[0])
      if (!offset) return c
      changed = true
      console.log(`\nUpdating reference AND anchor points for ${id} constraint:`)
      console.log('  Old reference:', c.reference_point)
      console.log('  Old anchor:', c.anchor_point)
      // Update both reference AND anchor points to maintain relative position
      const withUpdatedRef = translateReferenceFields(c, c.segment_ids[0], offset.dx, offset.dy)
      const updated = translateAnchorFields(withUpdatedRef, offset.dx, offset.dy)
      console.log('  New reference:', updated.reference_point)
      console.log('  New anchor:', updated.anchor_point)
      return updated
    })
    if (changed) {
      byId.set(id, { ...feature, sketch: { ...feature.sketch, constraints: nextConstraints } })
    }
  }

  // Step 3: Build dependency graph
  const dependents = new Map()
  for (const feature of byId.values()) {
    for (const c of feature.sketch.constraints) {
      if (c.type !== 'fixed_distance') continue
      for (const refId of c.segment_ids) {
        if (!dependents.has(refId)) {
          dependents.set(refId, new Set())
        }
        dependents.get(refId).add(feature.id)
      }
    }
  }

  // Step 4: Solve constraints for dependent features
  const queue = []
  for (const id of movedIds) {
    for (const dep of dependents.get(id) ?? []) {
      if (!movedIds.has(dep)) {
        queue.push(dep)
      }
    }
  }

  console.log('\nProcessing dependent features:', queue)

  while (queue.length > 0) {
    const fid = queue.shift()
    const feature = byId.get(fid)
    if (!feature) continue

    console.log(`\n=== Solving constraints for ${fid} ===`)

    for (const c of feature.sketch.constraints) {
      if (c.type !== 'fixed_distance' || !c.anchor_point || !c.reference_point) continue

      console.log('Constraint:', {
        anchor: c.anchor_point,
        reference: c.reference_point,
        targetDistance: c.value,
      })

      const { dx, dy } = solveFeatureTranslation(c.anchor_point, c.reference_point, c.value)
      
      console.log('Solver result:', { dx, dy })
      console.log('Current distance:', Math.hypot(c.anchor_point.x - c.reference_point.x, c.anchor_point.y - c.reference_point.y))
      console.log('Target distance:', c.value)

      if (Math.hypot(dx, dy) < 1e-7) {
        console.log('No movement needed')
        continue
      }

      const nextProfile = translateProfile(feature.sketch.profile, dx, dy)
      const nextConstraints = feature.sketch.constraints.map(c2 => translateAnchorFields(c2, dx, dy))

      console.log('Old anchor:', c.anchor_point)
      console.log('New anchor:', nextConstraints[0].anchor_point)
      console.log('Old profile start:', feature.sketch.profile.start)
      console.log('New profile start:', nextProfile.start)

      byId.set(fid, {
        ...feature,
        sketch: { ...feature.sketch, profile: nextProfile, constraints: nextConstraints },
      })
    }
  }

  return Array.from(byId.values())
}

// Run the test
function runTest() {
  console.log('='.repeat(80))
  console.log('CONSTRAINT PROPAGATION TEST')
  console.log('='.repeat(80))

  let features = createTestScenario()

  console.log('\n### INITIAL STATE ###')
  console.log('Rect 1 position:', features[0].sketch.profile.start)
  console.log('Circle 2 position:', features[1].sketch.profile.start)
  console.log('Circle 2 constraint:', features[1].sketch.constraints[0])

  // First move: Move Rect 1 right by 20 units
  console.log('\n\n' + '='.repeat(80))
  console.log('### FIRST MOVE: Move Rect 1 right by 20 units ###')
  console.log('='.repeat(80))
  
  features[0].sketch.profile = translateProfile(features[0].sketch.profile, 20, 0)
  features = propagateConstraints(features, new Map([['rect1', { dx: 20, dy: 0 }]]))

  console.log('\n### AFTER FIRST MOVE ###')
  console.log('Rect 1 position:', features[0].sketch.profile.start)
  console.log('Circle 2 position:', features[1].sketch.profile.start)
  console.log('Circle 2 constraints:', features[1].sketch.constraints)
  
  const dist1 = Math.hypot(
    features[1].sketch.profile.start.x - (features[0].sketch.profile.start.x + 100),
    features[1].sketch.profile.start.y - features[0].sketch.profile.start.y
  )
  console.log('Actual distance from Circle to Rect right edge:', dist1)
  console.log('Expected distance: 10')
  console.log('Distance correct?', Math.abs(dist1 - 10) < 0.01 ? '✓ YES' : '✗ NO')

  // Second move: Move Rect 1 right by another 20 units
  console.log('\n\n' + '='.repeat(80))
  console.log('### SECOND MOVE: Move Rect 1 right by another 20 units ###')
  console.log('='.repeat(80))
  
  features[0].sketch.profile = translateProfile(features[0].sketch.profile, 20, 0)
  features = propagateConstraints(features, new Map([['rect1', { dx: 20, dy: 0 }]]))

  console.log('\n### AFTER SECOND MOVE ###')
  console.log('Rect 1 position:', features[0].sketch.profile.start)
  console.log('Circle 2 position:', features[1].sketch.profile.start)
  console.log('Circle 2 constraints:', features[1].sketch.constraints)
  
  const dist2 = Math.hypot(
    features[1].sketch.profile.start.x - (features[0].sketch.profile.start.x + 100),
    features[1].sketch.profile.start.y - features[0].sketch.profile.start.y
  )
  console.log('Actual distance from Circle to Rect right edge:', dist2)
  console.log('Expected distance: 10')
  console.log('Distance correct?', Math.abs(dist2 - 10) < 0.01 ? '✓ YES' : '✗ NO')

  // Third move: Move Rect 1 right by another 20 units
  console.log('\n\n' + '='.repeat(80))
  console.log('### THIRD MOVE: Move Rect 1 right by another 20 units ###')
  console.log('='.repeat(80))
  
  features[0].sketch.profile = translateProfile(features[0].sketch.profile, 20, 0)
  features = propagateConstraints(features, new Map([['rect1', { dx: 20, dy: 0 }]]))

  console.log('\n### AFTER THIRD MOVE ###')
  console.log('Rect 1 position:', features[0].sketch.profile.start)
  console.log('Circle 2 position:', features[1].sketch.profile.start)
  console.log('Circle 2 constraints:', features[1].sketch.constraints)
  
  const dist3 = Math.hypot(
    features[1].sketch.profile.start.x - (features[0].sketch.profile.start.x + 100),
    features[1].sketch.profile.start.y - features[0].sketch.profile.start.y
  )
  console.log('Actual distance from Circle to Rect right edge:', dist3)
  console.log('Expected distance: 10')
  console.log('Distance correct?', Math.abs(dist3 - 10) < 0.01 ? '✓ YES' : '✗ NO')

  console.log('\n' + '='.repeat(80))
  console.log('TEST COMPLETE')
  console.log('='.repeat(80))
}

runTest()
