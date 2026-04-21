/**
 * Integration test for constraint propagation using the actual constraint solver
 * 
 * This test uses ts-node to import the TypeScript source directly.
 * Run with: node scripts/test-constraint-integration.cjs
 */

// Register ts-node to handle TypeScript imports
require('ts-node').register({
  project: 'tsconfig.app.json',
  transpileOnly: true,
});

// Now we can require TypeScript files
const { propagateConstraintsOnTranslate } = require('../src/sketch/constraintSolver.ts');
const { translateProfile: realTranslateProfile } = require('../src/sketch/constraintSolver.ts');

// Use the real translateProfile function from constraintSolver if available,
// otherwise fall back to mock
function translateProfile(profile, dx, dy) {
  if (realTranslateProfile && typeof realTranslateProfile === 'function') {
    return realTranslateProfile(profile, dx, dy);
  }
  // Mock implementation as fallback
  return {
    ...profile,
    start: { x: profile.start.x + dx, y: profile.start.y + dy },
    segments: profile.segments.map(seg => ({
      ...seg,
      to: { x: seg.to.x + dx, y: seg.to.y + dy },
    })),
  };
}

// Create test features similar to the original test
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
    locked: false,
  };

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
    locked: false,
  };

  return [rect1, circle2];
}

function runTest() {
  console.log('================================================================================');
  console.log('CONSTRAINT PROPAGATION INTEGRATION TEST');
  console.log('Using actual constraint solver from src/sketch/constraintSolver.ts');
  console.log('================================================================================\n');

  const features = createTestScenario();
  
  // Helper to compute rectangle right edge position
  const getRectRightEdge = (rectFeature) => {
    return rectFeature.sketch.profile.start.x + 100; // rectangle width is 100
  };

  // Initial state
  console.log('### INITIAL STATE ###');
  const rect1 = features[0];
  const circle2 = features[1];
  console.log('Rect 1 position:', rect1.sketch.profile.start);
  console.log('Circle 2 position:', circle2.sketch.profile.start);
  console.log('Circle 2 constraint:', JSON.stringify(circle2.sketch.constraints[0], null, 2));
  console.log('Initial distance from Circle to Rect right edge:', Math.abs(circle2.sketch.profile.start.x - getRectRightEdge(rect1)));
  console.log('Expected distance: 10');
  console.log('');

  // First move: Rect 1 right by 20 units
  console.log('================================================================================');
  console.log('### FIRST MOVE: Move Rect 1 right by 20 units ###');
  console.log('================================================================================');
  
  const movedOffsets1 = new Map();
  movedOffsets1.set('rect1', { dx: 20, dy: 0 });
  
  const result1 = propagateConstraintsOnTranslate(features, movedOffsets1, { translateProfile });
  
  const rect1After1 = result1.find(f => f.id === 'rect1');
  const circle2After1 = result1.find(f => f.id === 'circle2');
  
  console.log('After first move:');
  console.log('Rect 1 position:', rect1After1.sketch.profile.start);
  console.log('Circle 2 position:', circle2After1.sketch.profile.start);
  console.log('Circle 2 constraints:', JSON.stringify(circle2After1.sketch.constraints, null, 2));
  
  const distance1 = Math.abs(circle2After1.sketch.profile.start.x - getRectRightEdge(rect1After1));
  console.log('Actual distance from Circle to Rect right edge:', distance1);
  console.log('Expected distance: 10');
  console.log('Distance correct?', Math.abs(distance1 - 10) < 1e-6 ? '✓ YES' : '✗ NO');
  console.log('');

  // Second move: another 20 units
  console.log('================================================================================');
  console.log('### SECOND MOVE: Move Rect 1 right by another 20 units ###');
  console.log('================================================================================');
  
  const movedOffsets2 = new Map();
  movedOffsets2.set('rect1', { dx: 20, dy: 0 });
  
  const result2 = propagateConstraintsOnTranslate(result1, movedOffsets2, { translateProfile });
  
  const rect1After2 = result2.find(f => f.id === 'rect1');
  const circle2After2 = result2.find(f => f.id === 'circle2');
  
  console.log('After second move:');
  console.log('Rect 1 position:', rect1After2.sketch.profile.start);
  console.log('Circle 2 position:', circle2After2.sketch.profile.start);
  console.log('Circle 2 constraints:', JSON.stringify(circle2After2.sketch.constraints, null, 2));
  
  const distance2 = Math.abs(circle2After2.sketch.profile.start.x - getRectRightEdge(rect1After2));
  console.log('Actual distance from Circle to Rect right edge:', distance2);
  console.log('Expected distance: 10');
  console.log('Distance correct?', Math.abs(distance2 - 10) < 1e-6 ? '✓ YES' : '✗ NO');
  console.log('');

  // Third move: another 20 units
  console.log('================================================================================');
  console.log('### THIRD MOVE: Move Rect 1 right by another 20 units ###');
  console.log('================================================================================');
  
  const movedOffsets3 = new Map();
  movedOffsets3.set('rect1', { dx: 20, dy: 0 });
  
  const result3 = propagateConstraintsOnTranslate(result2, movedOffsets3, { translateProfile });
  
  const rect1After3 = result3.find(f => f.id === 'rect1');
  const circle2After3 = result3.find(f => f.id === 'circle2');
  
  console.log('After third move:');
  console.log('Rect 1 position:', rect1After3.sketch.profile.start);
  console.log('Circle 2 position:', circle2After3.sketch.profile.start);
  console.log('Circle 2 constraints:', JSON.stringify(circle2After3.sketch.constraints, null, 2));
  
  const distance3 = Math.abs(circle2After3.sketch.profile.start.x - getRectRightEdge(rect1After3));
  console.log('Actual distance from Circle to Rect right edge:', distance3);
  console.log('Expected distance: 10');
  console.log('Distance correct?', Math.abs(distance3 - 10) < 1e-6 ? '✓ YES' : '✗ NO');
  
  console.log('\n================================================================================');
  console.log('TEST COMPLETE');
  console.log('================================================================================');
}

// Run the test
try {
  runTest();
} catch (error) {
  console.error('Test failed with error:', error);
  process.exit(1);
}