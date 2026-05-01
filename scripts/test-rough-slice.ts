/**
 * Rough Surface — Slice Diagnostic Script
 *
 * Tests whether Manifold.slice(height) produces DIFFERENT cross-sections
 * at different Z heights for a non-prismatic 3D shape (a cone).
 *
 * If all slices are identical, the problem is in how slice() works
 * (or how the Manifold solid is constructed).
 * If slices are different but roughSurface emits the same contour,
 * the problem is in the toolpath generation pipeline.
 *
 * Run: npx tsx scripts/test-rough-slice.ts
 */

import ManifoldModule from 'manifold-3d'
import type { Manifold as ManifoldSolid, ManifoldToplevel } from 'manifold-3d'

function polygonSummary(poly: Array<[number, number]>, label: string): void {
  const xs = poly.map((p) => p[0])
  const ys = poly.map((p) => p[1])
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length
  const cy = ys.reduce((a, b) => a + b, 0) / ys.length
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const width = maxX - minX
  const height = maxY - minY
  const area = Math.abs(
    poly.reduce((sum, p, i) => {
      const next = poly[(i + 1) % poly.length]
      return sum + p[0] * next[1] - next[0] * p[1]
    }, 0) / 2
  )
  console.log(
    `  ${label}: verts=${poly.length} center=(${cx.toFixed(4)}, ${cy.toFixed(4)}) ` +
    `bounds=[${minX.toFixed(4)}..${maxX.toFixed(4)}, ${minY.toFixed(4)}..${maxY.toFixed(4)}] ` +
    `w=${width.toFixed(4)} h=${height.toFixed(4)} area=${area.toFixed(4)}`
  )
}

async function run(): Promise<void> {
  console.log('=== Rough Surface — Slice Diagnostic ===\n')

  // ── 1. Load Manifold WASM ──────────────────────────────────────────────
  console.log('Loading Manifold WASM...')
  const module: ManifoldToplevel = await ManifoldModule()
  module.setup()
  console.log('Manifold ready.\n')

  // ── 2. Create a CONE (non-prismatic 3D shape) ─────────────────────────
  //    Cylinder with different top/bottom radii = frustum of a cone.
  //    Bottom radius=3, top radius=0.5, height=3.
  //    This should give different cross-sections at different Z levels.
  const coneRadiusBottom = 3
  const coneRadiusTop = 0.5
  const coneHeight = 3
  const cone = module.Manifold.cylinder(
    coneHeight,              // height
    coneRadiusBottom,        // radius (or [bottomRadius, topRadius])
    coneRadiusTop,           // top radius (0 = cone)
    64,                      // circular segments
    false                    // center (false = sits on z=0)
  )
  
  const bbox = cone.boundingBox()
  console.log(`Cone bbox: min=(${bbox.min[0].toFixed(4)}, ${bbox.min[1].toFixed(4)}, ${bbox.min[2].toFixed(4)})`)
  console.log(`          max=(${bbox.max[0].toFixed(4)}, ${bbox.max[1].toFixed(4)}, ${bbox.max[2].toFixed(4)})`)
  console.log(`          height=${(bbox.max[2] - bbox.min[2]).toFixed(4)}\n`)

  // ── 3. Slice at multiple Z levels ─────────────────────────────────────
  const sliceZs = [
    bbox.min[2] + 0.1,        // near bottom
    (bbox.min[2] + bbox.max[2]) / 3,
    (bbox.min[2] + bbox.max[2]) * 2 / 3,
    bbox.max[2] - 0.1,        // near top
  ]

  console.log('Slicing cone at different Z heights:')
  const allResults: Array<{ z: number; polys: number; totalVerts: number; areas: number[] }> = []

  for (const z of sliceZs) {
    const crossSection = cone.slice(z)
    let polygons: ReturnType<typeof crossSection.toPolygons>
    try {
      polygons = crossSection.toPolygons()
    } finally {
      crossSection.delete()
    }

    console.log(`\nZ=${z.toFixed(4)}: ${polygons.length} polygon(s)`)

    const result = {
      z,
      polys: polygons.length,
      totalVerts: 0,
      areas: [] as number[],
    }

    polygons.forEach((poly, idx) => {
      const pts = poly as Array<[number, number]>
      result.totalVerts += pts.length
      const area = Math.abs(
        pts.reduce((sum, p, i) => {
          const next = pts[(i + 1) % pts.length]
          return sum + p[0] * next[1] - next[0] * p[1]
        }, 0) / 2
      )
      result.areas.push(area)
      polygonSummary(pts, `poly[${idx}]`)
    })

    allResults.push(result)
  }

  // ── 4. Compare results ────────────────────────────────────────────────
  console.log('\n=== Comparison ===')
  for (const r of allResults) {
    const areaStr = r.areas.map((a) => a.toFixed(4)).join(', ')
    console.log(`Z=${r.z.toFixed(4)}: ${r.polys} poly(s), ${r.totalVerts} verts total, areas=[${areaStr}]`)
  }

  // Check if all polygon counts are different
  const uniqueAreas = new Set(allResults.flatMap((r) => r.areas.map((a) => Math.round(a * 1000))))
  if (uniqueAreas.size === allResults.flatMap((r) => r.areas).length) {
    console.log('\n✅ All slice areas are UNIQUE — slice() produces different cross-sections at different Z.')
  } else if (uniqueAreas.size <= 1) {
    console.log('\n❌ All slice areas are IDENTICAL — slice() produces the SAME cross-section at every Z!')
    console.log('   This means the Manifold solid has vertical walls (prismatic/extruded shape).')
  } else {
    console.log('\n⚠️  Some slice areas repeat — may indicate symmetry in the shape.')
  }

  // ── 5. Test with a SPHERE as well (guaranteed non-prismatic) ─────────
  console.log('\n--- Sphere test ---')
  const sphere = module.Manifold.sphere(2, 64)
  const sphereBbox = sphere.boundingBox()
  console.log(`Sphere bbox: min=(${sphereBbox.min[0].toFixed(4)}, ${sphereBbox.min[1].toFixed(4)}, ${sphereBbox.min[2].toFixed(4)})`)
  console.log(`             max=(${sphereBbox.max[0].toFixed(4)}, ${sphereBbox.max[1].toFixed(4)}, ${sphereBbox.max[2].toFixed(4)})`)

  const sphereZs = [
    sphereBbox.min[2] + 0.1,
    sphereBbox.min[2] + sphereBbox.max[2] * 0.5,
    sphereBbox.max[2] - 0.1,
  ]

  for (const z of sphereZs) {
    const cs = sphere.slice(z)
    let polys: ReturnType<typeof cs.toPolygons>
    try {
      polys = cs.toPolygons()
    } finally {
      cs.delete()
    }
    polys.forEach((poly, idx) => polygonSummary(poly as Array<[number, number]>, `Sphere Z=${z.toFixed(2)} poly[${idx}]`))
  }

  // ── 6. Test with TRANSFORMED sphere (like buildFeatureSolid does) ────
  console.log('\n--- Transformed sphere test (scale+translate) ---')
  const scaledSphere = sphere
    .scale([1, 1, 1])
    .translate([5, 5, 2])
  const tsBbox = scaledSphere.boundingBox()
  console.log(`Transformed sphere bbox: min=(${tsBbox.min[0].toFixed(4)}, ${tsBbox.min[1].toFixed(4)}, ${tsBbox.min[2].toFixed(4)})`)
  console.log(`                         max=(${tsBbox.max[0].toFixed(4)}, ${tsBbox.max[1].toFixed(4)}, ${tsBbox.max[2].toFixed(4)})`)

  const tsZs = [tsBbox.min[2] + 0.1, tsBbox.min[2] + (tsBbox.max[2] - tsBbox.min[2]) * 0.5, tsBbox.max[2] - 0.1]
  for (const z of tsZs) {
    const cs = scaledSphere.slice(z)
    let polys: ReturnType<typeof cs.toPolygons>
    try {
      polys = cs.toPolygons()
    } finally {
      cs.delete()
    }
    polys.forEach((poly, idx) => polygonSummary(poly as Array<[number, number]>, `TSphere Z=${z.toFixed(2)} poly[${idx}]`))
  }

  cone.delete()
  sphere.delete()
  scaledSphere.delete()

  console.log('\n=== Done ===')
}

run().catch((err) => {
  console.error('Script failed:', err)
  process.exit(1)
})
