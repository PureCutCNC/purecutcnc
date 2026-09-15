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
 * Generated STEP fixtures (issue #784).
 *
 * ISO 10303-21 text in the AP214 (`AUTOMOTIVE_DESIGN`) schema, built from
 * primitives rather than checked in, so the importer tests carry no third-party
 * files and each test states the geometry and units it relies on.
 *
 * The B-rep is close to the smallest form Open CASCADE accepts as a solid:
 * planar and cylindrical faces bounded by `LINE` and `CIRCLE` edge curves with
 * no p-curves (OCCT computes those), all inside one product with an
 * `ADVANCED_BREP_SHAPE_REPRESENTATION`. Face loops run counter-clockwise about
 * the outward normal, so each solid is closed and consistently oriented.
 */

type Vec3 = readonly [number, number, number]

export type StepFixtureUnit = 'mm' | 'cm' | 'm' | 'inch' | 'foot' | 'none'

export interface StepBoxSolid {
  kind: 'box'
  name?: string
  min: Vec3
  max: Vec3
}

/** A cylinder standing on the XY plane: axis along +Z. */
export interface StepCylinderSolid {
  kind: 'cylinder'
  name?: string
  centre: readonly [number, number]
  radius: number
  zMin: number
  zMax: number
}

export type StepFixtureSolid = StepBoxSolid | StepCylinderSolid

export interface StepFixtureOptions {
  unit?: StepFixtureUnit
  productName?: string
}

/** A STEP REAL always carries a decimal point: `1.`, `-2.5`. */
function real(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`stepFixtures: non-finite value ${value}`)
  const text = String(Object.is(value, -0) ? 0 : value)
  if (/e/i.test(text)) throw new Error(`stepFixtures: ${value} would need exponent notation`)
  return text.includes('.') ? text : `${text}.`
}

function stepString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

class StepEntityWriter {
  readonly entities: string[] = []

  add(definition: string): string {
    const reference = `#${this.entities.length + 1}`
    this.entities.push(`${reference} = ${definition};`)
    return reference
  }

  point(p: Vec3): string {
    return this.add(`CARTESIAN_POINT('',(${real(p[0])},${real(p[1])},${real(p[2])}))`)
  }

  direction(d: Vec3): string {
    return this.add(`DIRECTION('',(${real(d[0])},${real(d[1])},${real(d[2])}))`)
  }

  placement(origin: Vec3, axis: Vec3, refDirection: Vec3): string {
    const location = this.point(origin)
    const axisDirection = this.direction(axis)
    const reference = this.direction(refDirection)
    return this.add(`AXIS2_PLACEMENT_3D('',${location},${axisDirection},${reference})`)
  }

  vertex(p: Vec3): string {
    return this.add(`VERTEX_POINT('',${this.point(p)})`)
  }

  lineEdge(start: string, end: string, from: Vec3, to: Vec3): string {
    const delta: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
    const length = Math.hypot(delta[0], delta[1], delta[2])
    const origin = this.point(from)
    const direction = this.direction([delta[0] / length, delta[1] / length, delta[2] / length])
    const vector = this.add(`VECTOR('',${direction},${real(length)})`)
    const line = this.add(`LINE('',${origin},${vector})`)
    return this.add(`EDGE_CURVE('',${start},${end},${line},.T.)`)
  }

  orientedEdge(edge: string, forward: boolean): string {
    return this.add(`ORIENTED_EDGE('',*,*,${edge},${forward ? '.T.' : '.F.'})`)
  }

  face(orientedEdges: readonly string[], surface: string): string {
    const loop = this.add(`EDGE_LOOP('',(${orientedEdges.join(',')}))`)
    const bound = this.add(`FACE_OUTER_BOUND('',${loop},.T.)`)
    return this.add(`ADVANCED_FACE('',(${bound}),${surface},.T.)`)
  }
}

function writeBox(w: StepEntityWriter, solid: StepBoxSolid): string {
  // Corners are keyed by bits: 4 = max X, 2 = max Y, 1 = max Z.
  const corner = (key: number): Vec3 => [
    key & 4 ? solid.max[0] : solid.min[0],
    key & 2 ? solid.max[1] : solid.min[1],
    key & 1 ? solid.max[2] : solid.min[2],
  ]
  const vertices = Array.from({ length: 8 }, (_, key) => w.vertex(corner(key)))
  const edges = new Map<string, string>()
  const orientedEdge = (from: number, to: number): string => {
    const low = Math.min(from, to)
    const high = Math.max(from, to)
    const key = `${low}-${high}`
    let edge = edges.get(key)
    if (!edge) {
      edge = w.lineEdge(vertices[low], vertices[high], corner(low), corner(high))
      edges.set(key, edge)
    }
    return w.orientedEdge(edge, from === low)
  }

  const faces: Array<{ corners: [number, number, number, number], normal: Vec3, refDirection: Vec3 }> = [
    { corners: [0, 2, 6, 4], normal: [0, 0, -1], refDirection: [1, 0, 0] },
    { corners: [1, 5, 7, 3], normal: [0, 0, 1], refDirection: [1, 0, 0] },
    { corners: [0, 4, 5, 1], normal: [0, -1, 0], refDirection: [1, 0, 0] },
    { corners: [2, 3, 7, 6], normal: [0, 1, 0], refDirection: [1, 0, 0] },
    { corners: [0, 1, 3, 2], normal: [-1, 0, 0], refDirection: [0, 1, 0] },
    { corners: [4, 6, 7, 5], normal: [1, 0, 0], refDirection: [0, 1, 0] },
  ]
  const faceRefs = faces.map(({ corners, normal, refDirection }) => {
    const loop = corners.map((from, i) => orientedEdge(from, corners[(i + 1) % corners.length]))
    const plane = w.add(`PLANE('',${w.placement(corner(corners[0]), normal, refDirection)})`)
    return w.face(loop, plane)
  })

  const shell = w.add(`CLOSED_SHELL('',(${faceRefs.join(',')}))`)
  return w.add(`MANIFOLD_SOLID_BREP(${stepString(solid.name ?? '')},${shell})`)
}

function writeCylinder(w: StepEntityWriter, solid: StepCylinderSolid): string {
  const [cx, cy] = solid.centre
  const bottomSeam: Vec3 = [cx + solid.radius, cy, solid.zMin]
  const topSeam: Vec3 = [cx + solid.radius, cy, solid.zMax]
  const bottomVertex = w.vertex(bottomSeam)
  const topVertex = w.vertex(topSeam)
  const circleEdge = (vertex: string, z: number): string => {
    const circle = w.add(`CIRCLE('',${w.placement([cx, cy, z], [0, 0, 1], [1, 0, 0])},${real(solid.radius)})`)
    return w.add(`EDGE_CURVE('',${vertex},${vertex},${circle},.T.)`)
  }
  const bottomCircle = circleEdge(bottomVertex, solid.zMin)
  const topCircle = circleEdge(topVertex, solid.zMax)
  const seam = w.lineEdge(bottomVertex, topVertex, bottomSeam, topSeam)

  const bottom = w.face(
    [w.orientedEdge(bottomCircle, false)],
    w.add(`PLANE('',${w.placement([cx, cy, solid.zMin], [0, 0, -1], [1, 0, 0])})`),
  )
  const top = w.face(
    [w.orientedEdge(topCircle, true)],
    w.add(`PLANE('',${w.placement([cx, cy, solid.zMax], [0, 0, 1], [1, 0, 0])})`),
  )
  // In (angle, z) the side is a rectangle: bottom circle forward, seam up, top
  // circle back, seam down — counter-clockwise about the outward radial normal.
  const side = w.face(
    [
      w.orientedEdge(bottomCircle, true),
      w.orientedEdge(seam, true),
      w.orientedEdge(topCircle, false),
      w.orientedEdge(seam, false),
    ],
    w.add(`CYLINDRICAL_SURFACE('',${w.placement([cx, cy, solid.zMin], [0, 0, 1], [1, 0, 0])},${real(solid.radius)})`),
  )

  const shell = w.add(`CLOSED_SHELL('',(${bottom},${top},${side}))`)
  return w.add(`MANIFOLD_SOLID_BREP(${stepString(solid.name ?? '')},${shell})`)
}

function writeLengthUnit(w: StepEntityWriter, unit: Exclude<StepFixtureUnit, 'none'>): string {
  const conversion = (name: string, millimetres: number): string => {
    const millimetre = w.add('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )')
    const measure = w.add(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(${real(millimetres)}),${millimetre})`)
    const exponents = w.add('DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.)')
    return w.add(`( CONVERSION_BASED_UNIT(${stepString(name)},${measure}) LENGTH_UNIT() NAMED_UNIT(${exponents}) )`)
  }
  switch (unit) {
    case 'mm':
      return w.add('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )')
    case 'cm':
      return w.add('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.CENTI.,.METRE.) )')
    case 'm':
      return w.add('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) )')
    case 'inch':
      return conversion('INCH', 25.4)
    case 'foot':
      return conversion('FOOT', 304.8)
  }
}

function writeContext(w: StepEntityWriter, unit: StepFixtureUnit): string {
  if (unit === 'none') {
    return w.add("( GEOMETRIC_REPRESENTATION_CONTEXT(3) REPRESENTATION_CONTEXT('Context #1','3D Context') )")
  }
  const length = writeLengthUnit(w, unit)
  const angle = w.add('( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )')
  const solidAngle = w.add('( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )')
  const uncertainty = w.add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${length},'distance_accuracy_value','confusion accuracy')`,
  )
  return w.add(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty})) `
    + `GLOBAL_UNIT_ASSIGNED_CONTEXT((${length},${angle},${solidAngle})) `
    + "REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY') )",
  )
}

function writeProduct(w: StepEntityWriter, name: string, representation: string): void {
  const applicationContext = w.add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')")
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${applicationContext})`)
  const productContext = w.add(`PRODUCT_CONTEXT('',${applicationContext},'mechanical')`)
  const product = w.add(`PRODUCT(${stepString(name)},${stepString(name)},'',(${productContext}))`)
  const formation = w.add(`PRODUCT_DEFINITION_FORMATION('','',${product})`)
  const definitionContext = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',${applicationContext},'design')`)
  const definition = w.add(`PRODUCT_DEFINITION('design','',${formation},${definitionContext})`)
  const definitionShape = w.add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`)
  w.add(`SHAPE_DEFINITION_REPRESENTATION(${definitionShape},${representation})`)
}

function part21(entities: readonly string[]): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('PureCutCNC test fixture'),'2;1');",
    "FILE_NAME('fixture.step','2026-01-01T00:00:00',(''),(''),'','PureCutCNC tests','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    ...entities,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n')
}

/** One product holding every solid in a single B-rep shape representation. */
export function stepFile(solids: readonly StepFixtureSolid[], options: StepFixtureOptions = {}): string {
  const w = new StepEntityWriter()
  const context = writeContext(w, options.unit ?? 'mm')
  const origin = w.placement([0, 0, 0], [0, 0, 1], [1, 0, 0])
  const items = solids.map((solid) => (solid.kind === 'box' ? writeBox(w, solid) : writeCylinder(w, solid)))
  const representation = w.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${[origin, ...items].join(',')}),${context})`)
  writeProduct(w, options.productName ?? 'Part', representation)
  return part21(w.entities)
}

/** A product whose only geometry is an open polyline: nothing in it can tessellate. */
export function stepWireframeFile(options: StepFixtureOptions = {}): string {
  const w = new StepEntityWriter()
  const context = writeContext(w, options.unit ?? 'mm')
  const points = [w.point([0, 0, 0]), w.point([10, 0, 0]), w.point([10, 10, 0])]
  const polyline = w.add(`POLYLINE('',(${points.join(',')}))`)
  const curveSet = w.add(`GEOMETRIC_CURVE_SET('',(${polyline}))`)
  const representation = w.add(`GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION('',(${curveSet}),${context})`)
  writeProduct(w, options.productName ?? 'Wireframe', representation)
  return part21(w.entities)
}
