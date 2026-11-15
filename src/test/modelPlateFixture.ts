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
 * A project holding one imported model with known pockets and holes, for the
 * model-recognition tests (issue #1206). Node-only test support: the plate is
 * cut by Manifold, so its mesh is what a tessellated solid really looks like.
 *
 * The plate is 60 x 40 x 20 with its corner at `origin`, and carries:
 * - a blind pocket, X 5..25, Y 5..15, floor at Z 12, with a round boss
 *   (centre 15, 10, radius 2) standing 4 high on that floor;
 * - a through hole, centre (40, 10), radius 3;
 * - a counterbore, centre (40, 30): radius 5.5 down to Z 14, radius 3.3 through.
 *
 * `undersidePocket` adds a 10 x 8 pocket, X 45..55, Y 16..24, cut 5 deep into
 * the plate's underside (floor at Z 5), for the Bottom-face slice (issue #1206
 * slice 4). It overlaps none of the shapes above.
 *
 * `plateModelProjectWithVolume` returns the same project with the model's own
 * volume from Manifold, so a test can compare a part recreated from the
 * detected features with the part it came from.
 */

import { getManifoldModule } from '../engine/csg'
import { serializeImportedMesh } from '../engine/importedMesh'
import { newProject, rectProfile, type Project, type SketchFeature } from '../types/project'
import { projectWithFeatures } from './projectFixtures'

export const PLATE = { width: 60, depth: 40, height: 20 } as const
export const PLATE_MODEL_ID = 'model1'

export interface PlateFixtureOptions {
  units?: 'mm' | 'inch'
  /** Where the plate's corner sits in the project. */
  origin?: { x: number; y: number }
  /** Facets per circle. The default is fine; 12 is a coarse STL. */
  segments?: number
  /** Cut a pocket into the plate's underside (issue #1206 slice 4). */
  undersidePocket?: boolean
  /** Extra features to put in the tree after the model. */
  after?: SketchFeature[]
}

export async function plateModelProject(options: PlateFixtureOptions = {}): Promise<Project> {
  return (await buildPlateFixture(options)).project
}

export interface PlateFixture {
  project: Project
  /** The fixture model's own volume, in the project's units cubed. */
  volume: number
}

/**
 * The same project, plus the model's own volume from Manifold, for a test that
 * recreates the part from its detected features and compares the two.
 */
export async function plateModelProjectWithVolume(options: PlateFixtureOptions = {}): Promise<PlateFixture> {
  return buildPlateFixture(options)
}

async function buildPlateFixture(options: PlateFixtureOptions = {}): Promise<PlateFixture> {
  const units = options.units ?? 'mm'
  const origin = options.origin ?? { x: 0, y: 0 }
  // The inch project is the same part, 25.4 times smaller in numbers.
  const unit = units === 'mm' ? 1 : 1 / 25.4
  const { Manifold } = await getManifoldModule()
  const cylinder = (x: number, y: number, z: number, radius: number, height: number) => (
    Manifold.cylinder(height, radius, radius, options.segments ?? 48).translate([x, y, z])
  )
  const pocket = Manifold.cube([20, 10, 8]).translate([5, 5, 12]).subtract(cylinder(15, 10, 12, 2, 4))
  const cut = Manifold.cube([PLATE.width, PLATE.depth, PLATE.height])
    .subtract(pocket)
    .subtract(cylinder(40, 10, -5, 3, 30))
    .subtract(cylinder(40, 30, 14, 5.5, 10))
    .subtract(cylinder(40, 30, -5, 3.3, 30))
  // A pocket opening downward: the Top look never reaches it, the Bottom one
  // does. Kept out of the way of the pocket, both holes and the counterbore.
  const nearSide = options.undersidePocket
    ? cut.subtract(Manifold.cube([10, 8, 5]).translate([45, 16, 0]))
    : cut
  const solid = nearSide
    .scale([unit, unit, unit])
    .translate([origin.x, origin.y, 0])
  const mesh = solid.getMesh()
  const volume = solid.volume()

  const width = PLATE.width * unit
  const depth = PLATE.depth * unit
  const height = PLATE.height * unit
  const assetId = 'plate-mesh'
  const model = {
    id: PLATE_MODEL_ID,
    name: 'Plate',
    kind: 'stl',
    folderId: null,
    stl: {
      format: 'stl',
      meshAssetId: assetId,
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: origin.x, y: origin.y },
        { x: origin.x + width, y: origin.y },
        { x: origin.x + width, y: origin.y + depth },
        { x: origin.x, y: origin.y + depth },
      ]],
    },
    sketch: {
      profile: rectProfile(origin.x, origin.y, width, depth),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: height,
    z_bottom: 0,
    visible: true,
    locked: false,
  } as unknown as SketchFeature

  const project = projectWithFeatures({
    ...newProject('model-recognition-plate', units),
    modelAssets: {
      [assetId]: serializeImportedMesh({
        positions: new Float32Array(mesh.vertProperties),
        index: new Uint32Array(mesh.triVerts),
        bounds: {
          minX: origin.x, maxX: origin.x + width,
          minY: origin.y, maxY: origin.y + depth,
          minZ: 0, maxZ: height,
        },
      }, 'stl'),
    },
  }, [model, ...(options.after ?? [])])
  project.stock.thickness = height
  return { project, volume }
}
