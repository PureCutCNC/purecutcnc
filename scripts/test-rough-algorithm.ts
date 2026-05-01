/**
 * Rough Surface — Algorithm Diagnostic Script
 *
 * Simulates the exact slice+offset algorithm from roughSurface.ts
 * on a KNOWN non-prismatic shape (cone) created directly via Manifold,
 * bypassing the STL loading pipeline.
 *
 * This isolates whether the algorithm itself is correct.
 *
 * Run: npx tsx scripts/test-rough-algorithm.ts
 */

import ManifoldModule from 'manifold-3d'
import type { Manifold as ManifoldSolid, ManifoldToplevel } from 'manifold-3d'
import ClipperLib from 'clipper-lib'
import { DEFAULT_CLIPPER_SCALE } from '../src/engine/toolpaths/geometry.ts'

// ── Clipper helpers (mirrors pocket.ts) ─────────────────────────────────

interface ClipperPath extends Array<{ X: number; Y: number }> {}

function offsetPaths(paths: ClipperPath[], delta: number): ClipperPath[] {
  if (paths.length === 0) return []
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  return solution as ClipperPath[]
}

function polygonSummary(pts: Array<{ x: number; y: number }>, label: string): void {
  const xs = pts.map(p => p.x)
  const ys = pts.map(p => p.y)
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length
  const cy = ys.reduce((a, b) => a + b, 0) / ys.length
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const width = maxX - minX
  const height = maxY - minY
  const area = Math.abs(
    pts.reduce((sum, p, i) => {
      const next = pts[(i + 1) % pts.length]
      return sum + p.x * next.y - next.x * p.y
    }, 0) / 2
  )
  console.log(
    `  ${label}: verts=${pts.length} center=(${cx.toFixed(4)}, ${cy.toFixed(4)}) ` +
    `bounds=[${minX.toFixed(4)}..${maxX.toFixed(4)}, ${minY.toFixed(4)}..${maxY.toFixed(4)}] ` +
    `w=${width.toFixed(4)} h=${height.toFixed(4)} area=${area.toFixed(4)}`
  )
}

async function run(): Promise<void> {
  console.log('=== Rough Surface — Algorithm Diagnostic ===\n')

  // ── 1. Load Manifold WASM ──────────────────────────────────────────────
  console.log('Loading Manifold WASM...')
  const module: ManifoldToplevel = await ManifoldModule()
  module.setup()
  console.log('Manifold ready.\n')

  // ── 2. Create a CONE ───────────────────────────────────────────────────
  //    Width=4 at bottom, tapers to width=0.5 at top, height=2.
  //    This simulates a simple "cat-like" shape that changes with Z.
  const cone = module.Manifold.cylinder(2, 2, 0.25, 32, false)
  const bbox = cone.boundingBox()
  console.log('=== Source Shape: Cone ===')
  console.log(`  bbox: z=[${bbox.min[2].toFixed(4)}, ${bbox.max[2].toFixed(4)}], height=${(bbox.max[2] - bbox.min[2]).toFixed(4)}`)

  // ── 3. Simulate roughSurface algorithm ─────────────────────────────────
  //    Parameters matching a typical operation
  const toolRadius = 0.125    // 1/4" tool
  const radialLeave = 0.01
  const axialLeave = 0.01
  const stepdown = 0.25
  const safeZ = 1.0

  const modelTopZ = bbox.max[2]
  const modelBottomZ = bbox.min[2]
  const effectiveBottom = modelBottomZ + axialLeave

  console.log(`  modelTopZ=${modelTopZ.toFixed(4)}, modelBottomZ=${modelBottomZ.toFixed(4)}, effectiveBottom=${effectiveBottom.toFixed(4)}`)
  console.log(`  toolRadius=${toolRadius}, radialLeave=${radialLeave}, stepdown=${stepdown}`)

  // ── 4. Generate step levels (same as pocket.ts generateStepLevels) ────
  const stepLevels: number[] = []
  for (let z = modelTopZ; z > effectiveBottom + 0.0001; z -= stepdown) {
    stepLevels.push(z)
  }
  if (stepLevels.length === 0 || stepLevels[stepLevels.length - 1] > effectiveBottom + 0.0001) {
    stepLevels.push(effectiveBottom)
  }
  console.log(`\nStep levels: ${stepLevels.map(z => z.toFixed(4)).join(', ')}`)

  const offsetDelta = Math.round((toolRadius + radialLeave) * DEFAULT_CLIPPER_SCALE)
  console.log(`offsetDelta (clipper units) = ${offsetDelta}\n`)

  // ── 5. Per-level: slice → offset → print ─────────────────────────────
  let prevArea = -1
  let sameCount = 0
  let totalMoves = 0

  for (const z of stepLevels) {
    console.log(`--- Z=${z.toFixed(4)} ---`)

    // Slice
    const crossSection = cone.slice(z)
    let slicePolygons: ReturnType<typeof crossSection.toPolygons>
    try {
      slicePolygons = crossSection.toPolygons()
    } finally {
      crossSection.delete()
    }

    if (slicePolygons.length === 0) {
      console.log('  No slice polygons (empty)')
      continue
    }

    // Convert to clipper coords
    const slicePaths: ClipperPath[] = slicePolygons.map((poly) =>
      (poly as Array<[number, number]>).map((pt) => ({
        X: Math.round(pt[0] * DEFAULT_CLIPPER_SCALE),
        Y: Math.round(pt[1] * DEFAULT_CLIPPER_SCALE),
      }))
    )

    // Print raw slice (first polygon only for brevity)
    if (slicePaths.length > 0 && slicePaths[0].length > 0) {
      const pts = slicePaths[0].map(p => ({ x: p.X / DEFAULT_CLIPPER_SCALE, y: p.Y / DEFAULT_CLIPPER_SCALE }))
      polygonSummary(pts, `raw-slice[0]`)
    }

    // Offset
    const offset = offsetPaths(slicePaths, offsetDelta)
    if (offset.length === 0) {
      console.log('  No offset polygons')
      continue
    }

    // Print offset results
    offset.forEach((path, idx) => {
      const pts = path.map(p => ({ x: p.X / DEFAULT_CLIPPER_SCALE, y: p.Y / DEFAULT_CLIPPER_SCALE }))
      if (pts.length < 3) return
      polygonSummary(pts, `offset[${idx}]`)
      totalMoves += pts.length
    })

    // Check for identical area (vertical wall detection)
    const firstOffset = offset[0]
    if (firstOffset && firstOffset.length >= 3) {
      const pts = firstOffset.map(p => ({ x: p.X / DEFAULT_CLIPPER_SCALE, y: p.Y / DEFAULT_CLIPPER_SCALE }))
      const area = Math.abs(
        pts.reduce((sum, p, i) => {
          const next = pts[(i + 1) % pts.length]
          return sum + p.x * next.y - next.x * p.y
        }, 0) / 2
      )
      if (Math.abs(area - prevArea) < 0.01) {
        sameCount++
      }
      prevArea = area
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n=== Summary ===`)
  if (sameCount >= stepLevels.length - 1) {
    console.log(`❌ VERTICAL WALL DETECTED: ${sameCount}/${stepLevels.length} levels have the same offset area.`)
    console.log(`   The algorithm is emitting the same shape at every level.`)
  } else {
    console.log(`✅ DIFFERENT SHAPES: ${sameCount}/${stepLevels.length} duplicate areas — algorithm is producing different contours at different Z.`)
  }
  console.log(`Total move points emitted: ${totalMoves}`)

  cone.delete()
  console.log('\n=== Done ===')
}

run().catch((err) => {
  console.error('Script failed:', err)
  process.exit(1)
})
