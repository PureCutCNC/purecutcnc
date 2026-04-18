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

/**
 * Targeted icon redraw tool.
 *
 * Authors individual icons as SVG path strings (industry-standard authoring
 * format) and rewrites ONLY the matching feature folders inside
 * `src/assets/icons.camj`. Every other icon is preserved byte-for-byte.
 *
 * Authoring:
 *   - Add entries to the ICON_DESIGNS registry below. Each entry maps an icon
 *     id (the folder name, e.g. "composite") to an array of SVG path `d`
 *     strings. Each path becomes one feature in that folder.
 *   - The canvas is 24×24 (SVG viewBox 0 0 24 24). Remember the internal
 *     coordinate system is screen-space: y grows DOWNWARD.
 *   - Icons are stroked (fill="none", stroke="currentColor", stroke-width 1.5,
 *     round caps/joins). Keep paths as outline geometry, not filled shapes.
 *
 * Run: `node scripts/redraw-icons.js`
 * Then: `npm run sync-icons` (to regenerate public/icons.svg).
 */

import fs from 'fs';
import { svgPathToProfiles } from './lib/svg-path.js';

const camjPath = 'src/assets/icons.camj';

/**
 * Icon design registry.
 *
 * Key = folder name (same as the <symbol id>). Value = array of SVG path `d`
 * strings. Paths are stroked, not filled. Keep all geometry within [1..23]
 * roughly so 1.5px strokes don't clip at the 24×24 canvas edge.
 */
const ICON_DESIGNS = {
  // --- Priority 1 redraws ---------------------------------------------------

  // composite — union of two overlapping simple shapes (circle + rounded square)
  // with a seam line showing they're composed. Reads cleanly at 16px.
  composite: [
    // Rounded square at top-left
    'M 3 6 a 2 2 0 0 1 2 -2 h 8 a 2 2 0 0 1 2 2 v 8 a 2 2 0 0 1 -2 2 h -8 a 2 2 0 0 1 -2 -2 Z',
    // Circle at bottom-right, overlapping
    'M 21 15 a 6 6 0 1 1 -12 0 a 6 6 0 0 1 12 0 Z',
  ],

  // rotate — circular arrow, the universal "rotate" glyph.
  // 3/4 clockwise arc from top to left, then chevron arrowhead at the end
  // pointing in the direction of continued motion (upward).
  rotate: [
    'M 12 4 A 8 8 0 1 1 4 12',
    // Arrowhead apex at (4,12), wings trailing down-left and down-right
    'M 1 15 L 4 12 L 7 15',
  ],

  // cut — scissors. Loops on the left, blades crossing at a pivot,
  // tips pointing right. Reads as the universal "cut" glyph.
  cut: [
    // Upper finger loop (circle around (5, 7), radius 3)
    'M 8 7 a 3 3 0 1 1 -6 0 a 3 3 0 0 1 6 0 Z',
    // Lower finger loop (circle around (5, 17), radius 3)
    'M 8 17 a 3 3 0 1 1 -6 0 a 3 3 0 0 1 6 0 Z',
    // Upper blade — from upper-loop edge, across pivot (14,12), to tip (20,17)
    'M 8 7 L 20 17',
    // Lower blade — from lower-loop edge, across pivot, to tip (20,7)
    'M 8 17 L 20 7',
  ],

  // fillet — L-bracket with a clear rounded inner corner
  fillet: [
    // Horizontal top-right leg
    'M 20 5 L 11 5',
    // Quarter-circle arc rounding the corner (radius 6)
    'M 11 5 A 6 6 0 0 0 5 11',
    // Vertical bottom-left leg
    'M 5 11 L 5 20',
  ],

  // spline — clean S-curve with two endpoint handles (Bezier control-point idiom)
  spline: [
    // Smooth S-curve
    'M 4 18 C 8 18 8 6 12 6 S 16 18 20 18',
    // Endpoint dot (left)
    'M 5 18 a 1 1 0 1 1 -2 0 a 1 1 0 0 1 2 0 Z',
    // Endpoint dot (right)
    'M 21 18 a 1 1 0 1 1 -2 0 a 1 1 0 0 1 2 0 Z',
  ],

  // point-add — a path segment with a vertex node on it, and a plus badge
  // clearly separated above the node (not overlapping). Reads as
  // "add a point/vertex to the path".
  'point-add': [
    // Path segment
    'M 4 18 L 20 18',
    // Vertex node on the path (centered at 12,18, radius 2.5)
    'M 14.5 18 A 2.5 2.5 0 1 1 9.5 18 A 2.5 2.5 0 1 1 14.5 18 Z',
    // Plus badge above the node
    'M 12 4 L 12 10',
    'M 9 7 L 15 7',
  ],

  // point-delete — same path + vertex, with an × badge above the node.
  'point-delete': [
    // Path segment
    'M 4 18 L 20 18',
    // Vertex node on the path
    'M 14.5 18 A 2.5 2.5 0 1 1 9.5 18 A 2.5 2.5 0 1 1 14.5 18 Z',
    // × badge above the node
    'M 9.5 4.5 L 14.5 9.5',
    'M 14.5 4.5 L 9.5 9.5',
  ],

  // --- Snap modes -----------------------------------------------------------
  // CAD-standard snap marker conventions:
  //   square  = endpoint / point
  //   triangle = midpoint
  //   circle  = center
  //   X       = intersection / none
  //   right-angle square = perpendicular

  // snap (category / generic snap) — horseshoe magnet, the universal snap glyph.
  // Traversed: top-left pole cap → down inner-left → inner U-arc (bulging down,
  // L→R so sweep=0) → up inner-right → top-right pole cap → down outer-right →
  // outer U-arc (bulging down, R→L so sweep=1) → close.
  snap: [
    'M 5 5 L 9 5 L 9 12 A 3 3 0 0 0 15 12 L 15 5 L 19 5 L 19 12 A 7 7 0 0 1 5 12 Z',
  ],

  // snap-point — a line segment with a square endpoint marker (CAD "endpoint")
  'snap-point': [
    // Diagonal line ending in the marker
    'M 3 20 L 17 6',
    // 6×6 square marker centered on the endpoint (17, 6)
    'M 14 3 L 20 3 L 20 9 L 14 9 Z',
  ],

  // snap-grid — 3×3 dot grid (Figma/Sketch grid-snap idiom).
  // Dots are 4×4 squares centered at (5, 12, 19), spaced 7 apart so they
  // use the full canvas and read at toolbar sizes.
  'snap-grid': [
    'M 3 3 L 7 3 L 7 7 L 3 7 Z',
    'M 10 3 L 14 3 L 14 7 L 10 7 Z',
    'M 17 3 L 21 3 L 21 7 L 17 7 Z',
    'M 3 10 L 7 10 L 7 14 L 3 14 Z',
    'M 10 10 L 14 10 L 14 14 L 10 14 Z',
    'M 17 10 L 21 10 L 21 14 L 17 14 Z',
    'M 3 17 L 7 17 L 7 21 L 3 21 Z',
    'M 10 17 L 14 17 L 14 21 L 10 21 Z',
    'M 17 17 L 21 17 L 21 21 L 17 21 Z',
  ],

  // snap-line — a line with a diamond snap marker ON the line
  'snap-line': [
    // Diagonal line (45°) so midpoint lands exactly on (12,12)
    'M 4 20 L 20 4',
    // Diamond marker centered on (12,12) — half-diagonal 4 for visibility at toolbar sizes
    'M 12 8 L 16 12 L 12 16 L 8 12 Z',
  ],

  // snap-midpoint — line + triangle marker (CAD "midpoint")
  'snap-midpoint': [
    // Diagonal line (45°), midpoint at (12,12)
    'M 4 20 L 20 4',
    // Triangle centered at (12,12): apex (12,7.5), base (8,14.25)-(16,14.25)
    // Larger than before — base 8, height 6.75 — so it's clearly visible at 16–18px
    'M 12 7.5 L 16 14.25 L 8 14.25 Z',
  ],

  // snap-perpendicular — horizontal line + vertical line + right-angle square
  'snap-perpendicular': [
    // Primary (horizontal) line
    'M 4 18 L 20 18',
    // Perpendicular line rising from midpoint
    'M 12 18 L 12 6',
    // Right-angle indicator in the corner (L-mark)
    'M 14 18 L 14 16 L 12 16',
  ],
};

// ---------------------------------------------------------------------------

function profilesToFeatures(iconId, folderId, paths) {
  const features = [];
  let pathIndex = 0;

  for (const d of paths) {
    const profiles = svgPathToProfiles(d);
    let subIndex = 0;

    for (const profile of profiles) {
      const suffixA = pathIndex > 0 ? `_${pathIndex}` : '';
      const suffixB = subIndex > 0 ? `_${subIndex}` : '';
      const featureId = `icon_${iconId}${suffixA}${suffixB}`;
      const name = `${iconId}_shape_${pathIndex}${subIndex > 0 ? `_${subIndex}` : ''}`;

      features.push({
        id: featureId,
        name,
        kind: 'composite',
        folderId,
        sketch: {
          profile: {
            start: { x: profile.start.x, y: profile.start.y },
            segments: profile.segments.map((s) => {
              const seg = { type: s.type, to: { x: s.to.x, y: s.to.y } };
              if (s.control1) seg.control1 = { x: s.control1.x, y: s.control1.y };
              if (s.control2) seg.control2 = { x: s.control2.x, y: s.control2.y };
              if (s.center) seg.center = { x: s.center.x, y: s.center.y };
              if ('clockwise' in s) seg.clockwise = s.clockwise;
              return seg;
            }),
            closed: !!profile.closed,
          },
          origin: { x: 0, y: 0 },
          orientationAngle: 0,
          dimensions: [],
          constraints: [],
        },
        operation: 'add',
        z_top: 0,
        z_bottom: -1,
        visible: false,
        locked: false,
      });

      subIndex += 1;
    }
    pathIndex += 1;
  }

  return features;
}

function main() {
  const project = JSON.parse(fs.readFileSync(camjPath, 'utf-8'));

  // Build folder-name → folderId lookup
  const folderByName = new Map();
  for (const folder of project.featureFolders) {
    folderByName.set(folder.name, folder.id);
  }

  const redrawn = [];
  const missing = [];

  for (const [iconId, paths] of Object.entries(ICON_DESIGNS)) {
    const folderId = folderByName.get(iconId);
    if (!folderId) {
      missing.push(iconId);
      continue;
    }

    // Drop all existing features for this folder
    project.features = project.features.filter((f) => f.folderId !== folderId);

    // Append the new features for this icon
    const newFeatures = profilesToFeatures(iconId, folderId, paths);
    project.features.push(...newFeatures);

    redrawn.push({ id: iconId, features: newFeatures.length });
  }

  fs.writeFileSync(camjPath, JSON.stringify(project, null, 2));

  for (const { id, features } of redrawn) {
    console.log(`  redrew ${id} (${features} feature${features === 1 ? '' : 's'})`);
  }
  if (missing.length) {
    console.warn(`\n  WARNING: no folder found for: ${missing.join(', ')}`);
  }
  console.log(`\nRedrew ${redrawn.length} icon${redrawn.length === 1 ? '' : 's'} in ${camjPath}`);
  console.log(`Run \`npm run sync-icons\` to regenerate public/icons.svg.`);
}

main();
