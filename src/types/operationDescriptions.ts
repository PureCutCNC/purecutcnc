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

import type { OperationKind } from './project'

interface OperationDescription {
  title: string
  shortSummary: string
  fullDescription: string
  keyPoints: string[]
  /** File name (without path) that will be resolved from /operation-examples/ */
  exampleImageName: string
}

export const operationDescriptions: Record<OperationKind, OperationDescription> = {
  pocket: {
    title: 'Pocket',
    shortSummary: 'Clear material from inside a closed profile to a fixed depth',
    fullDescription:
      'Pocket clears the interior of one or more closed subtract profiles down to a fixed Z. Choose between offset (concentric, outside-in) or parallel (scanline) patterns; parallel takes a configurable angle.',
    keyPoints: [
      'Requires one or more closed subtract profiles',
      'Offset or parallel clearing pattern',
      'Supports rough and finish passes',
      'Best with flat endmills for clean floors',
      'Optional closed regions act as XY filters',
    ],
    exampleImageName: 'pocket-example.png',
  },
  v_carve: {
    title: 'V-Carve Offset',
    shortSummary: 'Cut inset contours at increasing depth with a V-bit',
    fullDescription:
      'V-Carve Offset follows progressively narrower inset contours of a closed profile, lowering Z on each pass so the V-bit\'s angled flank carves a clean V-groove that tapers to the centerline. Depth per pass is derived from contour spacing and the V-bit half-angle.',
    keyPoints: [
      'Requires one or more closed subtract profiles',
      'Requires a V-bit tool (set the tip angle on the tool first)',
      'Single-pass operation (no rough/finish split)',
      'Ideal for engraving, signage, and decorative edges',
      'Optional closed regions act as XY filters',
    ],
    exampleImageName: 'vcarve-offset-example.png',
  },
  v_carve_recursive: {
    title: 'V-Carve Skeleton',
    shortSummary: 'Variable-depth V-carve along the medial axis, clearing wide areas first',
    fullDescription:
      'V-Carve Skeleton computes the medial axis (skeleton) of a closed profile and cuts a V-groove whose depth tracks the local width — deeper where the shape is wide, shallower where it narrows. For wide regions, it recursively clears bulk material with larger cuts before refining narrow detail with the V-bit.',
    keyPoints: [
      'Requires one or more closed subtract profiles',
      'Requires a V-bit tool (set the tip angle on the tool first)',
      'Recursively clears wide areas with larger cuts before V-detailing narrow areas',
      'Single-pass operation (no rough/finish split)',
      'Optional closed regions act as XY filters',
    ],
    exampleImageName: 'vcarve-skeleton-example.png',
  },
  v_carve_medial: {
    title: 'V-Carve Medial',
    shortSummary: 'Geometric medial-axis V-carve with exact depth from the true skeleton',
    fullDescription:
      'V-Carve Medial computes the true medial axis of a closed profile from the Voronoi diagram of its boundary and cuts a V-groove whose depth exactly tracks the local half-width. Sharp corners receive skeleton tips that rise to the surface for crisp points; smooth curves stay clean thanks to geometric filtering. Step Size controls the skeleton sampling resolution.',
    keyPoints: [
      'Requires one or more closed subtract profiles',
      'Requires a V-bit tool (set the tip angle on the tool first)',
      'Exact depth: V flanks touch both walls everywhere along the skeleton',
      'Crisp zero-depth tips in sharp corners; no artifacts on smooth curves',
      'Single-pass operation (no rough/finish split)',
      'Optional closed regions act as XY filters',
    ],
    exampleImageName: 'vcarve-medial-example.png',
  },
  edge_route_inside: {
    title: 'Edge Route Inside',
    shortSummary: 'Cut along the inside of a closed subtract profile',
    fullDescription:
      'Edge Route Inside follows the inside edge of one or more closed subtract profiles, offset inward by the tool radius. Useful for slots, hollows, and interior profile cuts where the tool must stay inside the boundary.',
    keyPoints: [
      'Requires one or more closed subtract profiles',
      'Tool path is offset inward by the tool radius',
      'Supports rough and finish passes',
      'Optional closed regions act as XY filters',
    ],
    exampleImageName: 'edge-route-inside-example.png',
  },
  edge_route_outside: {
    title: 'Edge Route Outside',
    shortSummary: 'Cut along the outside of a closed add/model profile',
    fullDescription:
      'Edge Route Outside follows the outside edge of one or more closed add or model profiles, offset outward by the tool radius. Used to profile parts out of stock, leave clean shoulders around raised features, or cut perimeters.',
    keyPoints: [
      'Requires one or more closed add or model profiles',
      'Tool path is offset outward by the tool radius',
      'Supports rough and finish passes',
      'Optional closed regions act as XY filters',
    ],
    exampleImageName: 'edge-route-outside-example.png',
  },
  surface_clean: {
    title: 'Surface Clean',
    shortSummary: 'Clean the flat top of an add/model around taller features sitting on it',
    fullDescription:
      'Surface Clean machines the flat top surface of one or more add/model features in the area around any taller add features that sit on top of them. It produces a band of cleanup passes at each step height — useful for finishing pads, terraces, and stepped surfaces. Pattern can be offset or parallel.',
    keyPoints: [
      'Requires one or more closed add or model features',
      'Clears the area between taller features at each step height',
      'Offset or parallel clearing pattern',
      'Supports rough and finish passes',
      'Optional closed regions act as XY filters',
    ],
    exampleImageName: 'surface-clean-example.png',
  },
  follow_line: {
    title: 'Engrave',
    shortSummary: 'Trace open or closed sketch paths at a fixed depth',
    fullDescription:
      'Engrave traces along any sketch path — open or closed — at a fixed carve depth. The tool follows the path centerline; no offset. Good for text, decorative lines, alignment marks, and following complex curves on the stock surface.',
    keyPoints: [
      'Accepts open or closed path features',
      'Tool follows the path centerline (no offset)',
      'Single-pass operation (no rough/finish split)',
      'Typically shallow; stepdown applies if carve depth exceeds it',
      'Optional closed regions act as XY filters',
    ],
    exampleImageName: 'engrave-example.png',
  },
  drilling: {
    title: 'Drill',
    shortSummary: 'Drill holes at circle feature locations',
    fullDescription:
      'Drilling produces a hole at the center of each selected circle feature using a canned drill cycle. Choose the drilling method (simple G81, peck G83, dwell G82, chip-breaking G73) and depth on the operation.',
    keyPoints: [
      'Requires one or more circle features',
      'Four cycle types: simple (G81), peck (G83), dwell (G82), chip-breaking (G73)',
      'Peck and chip-breaking cycles use a peck increment',
      'Fast for repeated hole patterns',
      'Optional closed regions filter which holes are drilled',
    ],
    exampleImageName: 'drilling-example.png',
  },
  rough_surface: {
    title: '3D Surface Rough',
    shortSummary: 'Level-by-level roughing of an imported 3D model with offset clearing',
    fullDescription:
      'Rough Surface slices the imported 3D model at constant Z levels (waterline-style) and clears each level with offset passes, leaving radial and axial stock for finishing. Use larger stepdown and stepover for speed; follow with a finish operation for accuracy.',
    keyPoints: [
      'Requires an imported 3D model',
      'Waterline-style level slicing with offset clearing per level',
      'Honors radial and axial stock-to-leave for the finish pass',
      'Single-pass operation (no rough/finish split — this op is roughing)',
      'Optional closed regions act as XY filters',
    ],
    exampleImageName: 'rough-surface-example.png',
  },
  finish_surface: {
    title: '3D Surface Finish',
    shortSummary: 'Finish pass over an imported 3D model using parallel or waterline strategy',
    fullDescription:
      'Finish Surface produces the final surface on an imported 3D model. Choose parallel (scanlines at a configurable angle) for shallower geometry or waterline (constant-Z contours) for steeper walls. Use a small stepover for parallel or small stepdown for waterline.',
    keyPoints: [
      'Requires an imported 3D model',
      'Parallel (scanline) or waterline (constant-Z) pattern',
      'Single-pass operation (no rough/finish split — this op is the finish)',
      'Usually follows 3D Surface Rough',
      'Optional closed regions act as XY filters',
    ],
    exampleImageName: 'finish-surface-example.png',
  },
  finish_surface_cleanup: {
    title: '3D Surface Cleanup',
    shortSummary: 'Finish walls and floors at the deepest Z of each rough-surface step',
    fullDescription:
      'Surface Cleanup emits finish-only wall and floor passes at the deepest retained Z of each step left by the 3D rough operation. It deduplicates repeated wall/floor columns across levels so each is cut once at its lowest effective depth — cleaning up rough-surface terraces without re-roughing.',
    keyPoints: [
      'Requires an imported 3D model',
      'Independent Finish Walls and Finish Floor toggles',
      'Offset or parallel pattern for floors',
      'Typically run after 3D Surface Rough as the final pass',
      'Optional closed regions act as XY filters',
    ],
    exampleImageName: 'finish-surface-cleanup-example.png',
  },
}
