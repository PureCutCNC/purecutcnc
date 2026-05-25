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
    shortSummary: 'Remove material from a closed profile to a fixed depth',
    fullDescription:
      'Pocket cuts rectangular or complex cavities into your stock. Select a closed subtract feature and define the depth. The toolpath will clear the interior using offset or parallel patterns, working from the outside inward.',
    keyPoints: [
      'Requires a closed subtract profile',
      'Sets a fixed cutting depth',
      'Supports rough and finish passes',
      'Works with flat endmills for clean walls',
    ],
    exampleImageName: 'pocket-example.png',
  },
  v_carve: {
    title: 'V-Carve Offset',
    shortSummary: 'Follow closed contours at a V-bit angle to create decorative grooves',
    fullDescription:
      'V-Carve uses a V-shaped bit to cut along the perimeter of closed profiles. The tool plunges straight down and retracts, creating a V-groove. Perfect for decorative text and ornamental edges.',
    keyPoints: [
      'Requires closed subtract profiles',
      'Uses V-bit tool (set tool angle before adding)',
      'Single-pass operation',
      'Ideal for engraving and decorative edges',
    ],
    exampleImageName: 'vcarve-offset-example.png',
  },
  v_carve_recursive: {
    title: 'V-Carve Skeleton',
    shortSummary: 'Cut variable-depth V-grooves that follow the skeleton/medial axis of shapes',
    fullDescription:
      'V-Carve Skeleton computes the medial axis (skeleton) of your profile and creates a variable-depth V-groove that adapts to the feature\'s geometry. The cut depth increases as the tool follows wider regions and decreases in narrower areas.',
    keyPoints: [
      'Requires closed subtract profiles',
      'Creates adaptive V-grooves following shape geometry',
      'Produces smooth, flowing decorative cuts',
      'Single-pass operation',
    ],
    exampleImageName: 'vcarve-skeleton-example.png',
  },
  edge_route_inside: {
    title: 'Edge Route Inside',
    shortSummary: 'Cut the inside perimeter of closed profiles',
    fullDescription:
      'Routes the inner edge of closed subtract profiles. The tool stays just inside the profile boundary, useful for creating slot walls, hollow pockets, or decorative grooves on the interior of shapes.',
    keyPoints: [
      'Requires closed subtract profiles',
      'Cuts on the inside edge only',
      'Supports rough and finish passes',
      'Works with flat or ball endmills',
    ],
    exampleImageName: 'edge-route-inside-example.png',
  },
  edge_route_outside: {
    title: 'Edge Route Outside',
    shortSummary: 'Cut the outside perimeter of features',
    fullDescription:
      'Routes the outer edge of closed add or model features. The tool stays just outside the profile boundary, ideal for profiling parts out of stock or creating ledges and steps.',
    keyPoints: [
      'Requires closed add/model profiles',
      'Cuts on the outside edge only',
      'Supports rough and finish passes',
      'Works with flat or ball endmills',
    ],
    exampleImageName: 'edge-route-outside-example.png',
  },
  surface_clean: {
    title: 'Surface Clean',
    shortSummary: 'Clean up surfaces between features',
    fullDescription:
      'Surface clean removes material in the open areas between subtract features on an add feature. Useful for creating flat, finished surfaces where multiple pockets or profiles meet.',
    keyPoints: [
      'Requires closed add/model features',
      'Cleans flat or stepped surfaces',
      'Supports rough and finish passes',
      'Works well after pockets or inside routes',
    ],
    exampleImageName: 'surface-clean-example.png',
  },
  follow_line: {
    title: 'Engrave',
    shortSummary: 'Trace open or closed paths on the surface (e.g., text, lines)',
    fullDescription:
      'Follow line / Engrave traces along any sketch path without removing significant material. Perfect for etching text, decorative lines, or following complex curves on the stock surface.',
    keyPoints: [
      'Works with open or closed paths',
      'Ideal for text and decorative engraving',
      'Typically shallow passes',
      'Supports rough and finish passes',
    ],
    exampleImageName: 'engrave-example.png',
  },
  drilling: {
    title: 'Drill',
    shortSummary: 'Drill holes at circle feature locations',
    fullDescription:
      'Drilling creates precise holes at each circle feature in your sketch. Choose your drill bit, depth, and drilling method (simple, peck, dwell, chip-breaking). Closed regions act as optional filters.',
    keyPoints: [
      'Requires one or more circle features',
      'Multiple drilling methods: simple, peck, dwell, chip-breaking',
      'Specify depth and peck increment',
      'Fast operation for repeated hole patterns',
    ],
    exampleImageName: 'drilling-example.png',
  },
  rough_surface: {
    title: '3D Surface Rough',
    shortSummary: 'Rough machine an imported 3D model with ball or flat endmill',
    fullDescription:
      'Rough surface removes material from an imported STL/3D model using aggressive cuts to get close to the final shape. Use a larger cutting stepdown and stepover for speed. A finishing pass typically follows.',
    keyPoints: [
      'Requires an imported 3D model (STL)',
      'Uses waterline or offset patterns',
      'Aggressive cutting for speed',
      'Follow with finish surface for accuracy',
    ],
    exampleImageName: 'rough-surface-example.png',
  },
  finish_surface: {
    title: '3D Surface Finish',
    shortSummary: 'Finish machine an imported 3D model for a smooth surface',
    fullDescription:
      'Finish surface makes fine cutting passes over an imported 3D model for superior surface accuracy and finish quality. Use smaller stepdown and stepover values. Typically follows a rough surface operation.',
    keyPoints: [
      'Requires an imported 3D model (STL)',
      'Fine cutting with small stepover',
      'Produces excellent surface finish',
      'Usually follows rough surface operation',
    ],
    exampleImageName: 'finish-surface-example.png',
  },
  finish_surface_cleanup: {
    title: '3D Surface Cleanup',
    shortSummary: 'Clean up inaccessible areas missed by finish surface',
    fullDescription:
      'Cleanup passes remove small remaining peaks that the main finish pass could not reach. Uses aggressive plunges at step locations. Typically the final pass on a 3D model.',
    keyPoints: [
      'Requires an imported 3D model (STL)',
      'Targets hard-to-reach peaks',
      'Removes final material imperfections',
      'Usually the last operation on 3D work',
    ],
    exampleImageName: 'finish-surface-cleanup-example.png',
  },
}
