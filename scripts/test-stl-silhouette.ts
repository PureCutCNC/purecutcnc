/**
 * Test script for STL silhouette rendering.
 *
 * Loads an STL file, extracts the top-down profile (footprint), prints
 * profile statistics, and writes PNG bitmaps of the filled silhouette
 * so you can visually inspect the result.
 *
 * Outputs TWO orientations so you can compare:
 *   /tmp/stl-silhouette.png            ← current (no Y-flip)
 *   /tmp/stl-silhouette-flipped.png    ← with Y-flip   (canvas Y+ down)
 *   /tmp/stl-silhouette.svg            ← vector outline
 *
 * Usage:
 *   npx tsx scripts/test-stl-silhouette.ts
 *
 * Output:
 *   - prints profile info to console
 *   - writes /tmp/stl-silhouette.png          (open in any image viewer)
 *   - writes /tmp/stl-silhouette-flipped.png  (Y-flipped version)
 *   - writes /tmp/stl-silhouette.svg          (vector format, open in browser/Inkscape)
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { extractStlProfileAndBounds } from '../src/import/stl'
import { renderSilhouetteToDataUrl } from '../src/import/stl'
import { profileVertices, getProfileBounds, polygonProfile, type Point, type SketchProfile } from '../src/types/project'

// ── Configuration ──────────────────────────────────────────────────────────
const STL_PATH = '/Users/frankp/Projects/purecutcnc/work/Oldman-splash-final.STL'
const STL_SCALE = 1
const STL_AXIS_SWAP: 'none' | 'yz' | 'xz' | 'xy' = 'none'
const OUTPUT_PNG = '/tmp/stl-silhouette.png'
const OUTPUT_PNG_FLIPPED = '/tmp/stl-silhouette-flipped.png'
const OUTPUT_SVG = '/tmp/stl-silhouette.svg'
const OUTPUT_JSON = '/tmp/stl-silhouette-points.json'
const MAX_IMG_PX = 1024 // match renderSilhouetteToDataUrl

// ── Minimal pure-JS PNG encoder (no external dependencies) ─────────────────

/** Write a 24-bit RGB PNG file using built-in zlib. */
function writePNG(filePath: string, pixels: Buffer, width: number, height: number): void {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  // Helper: write a PNG chunk (length + type + data + CRC)
  function writeChunk(type: string, data: Buffer): Buffer {
    const typeBuf = Buffer.from(type, 'ascii')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const crcData = Buffer.concat([typeBuf, data])
    // CRC32 computation
    let crc = 0xFFFFFFFF
    for (let i = 0; i < crcData.length; i++) {
      crc ^= crcData[i]
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
      }
    }
    crc ^= 0xFFFFFFFF
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc >>> 0, 0)
    return Buffer.concat([length, typeBuf, data, crcBuf])
  }

  // IHDR chunk
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)        // width
  ihdr.writeUInt32BE(height, 4)       // height
  ihdr[8] = 8                          // bit depth
  ihdr[9] = 2                          // color type: RGB (no alpha)
  ihdr[10] = 0                         // compression: deflate
  ihdr[11] = 0                         // filter: adaptive
  ihdr[12] = 0                         // interlace: none

  // Raw scanline data: prepend filter byte 0 (None) to each row
  const rowSize = 1 + width * 3
  const rawData = Buffer.alloc(rowSize * height)
  for (let y = 0; y < height; y++) {
    rawData[y * rowSize] = 0 // filter type: None
    pixels.copy(rawData, y * rowSize + 1, y * width * 3, (y + 1) * width * 3)
  }

  // Compress with zlib (deflate)
  const compressed = zlib.deflateSync(rawData, { level: 6 })

  // Assemble the file
  const chunks = [
    signature,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', compressed),
    writeChunk('IEND', Buffer.alloc(0)),
  ]
  fs.writeFileSync(filePath, Buffer.concat(chunks))
  const sizeKB = fs.statSync(filePath).size / 1024
  console.log(`  Wrote PNG:  ${filePath} (${width}×${height}, ${sizeKB.toFixed(0)} KB)`)
}

// ── Bitmap rendering helpers ───────────────────────────────────────────────

/** Test whether a point is inside a polygon using the ray-casting algorithm. */
function pointInPolygon(px: number, py: number, verts: Point[]): boolean {
  let inside = false
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x, yi = verts[i].y
    const xj = verts[j].x, yj = verts[j].y
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

interface RenderResult {
  pixels: Buffer
  filledCount: number
  totalPixels: number
  fillPercent: number
}

/** Generate a flat RGB pixel buffer (filled polygon on black background). */
function renderSilhouettePixels(
  verts: Point[],
  bbox: { minX: number; maxX: number; minY: number; maxY: number },
  imgW: number,
  imgH: number,
  flipY: boolean,
): RenderResult {
  const scaleX = imgW / (bbox.maxX - bbox.minX)
  const scaleY = imgH / (bbox.maxY - bbox.minY)
  const originX = -bbox.minX
  const originY = -bbox.minY

  function sx(x: number): number { return Math.round((x + originX) * scaleX) }
  function sy(y: number): number {
    const raw = Math.round((y + originY) * scaleY)
    return flipY ? (imgH - 1 - raw) : raw
  }

  const pixels = Buffer.alloc(imgW * imgH * 3, 0) // black background

  // Fill color: #4a7fa8 (same as renderSilhouetteToDataUrl)
  const fillR = 0x4a, fillG = 0x7f, fillB = 0xa8

  let filledCount = 0

  // Scanline fill: for each pixel, test if center is inside polygon
  for (let py = 0; py < imgH; py++) {
    for (let px = 0; px < imgW; px++) {
      // Convert pixel center to model coordinates
      const mx = px / scaleX - originX
      const my = py / scaleY - originY
      if (pointInPolygon(mx, my, verts)) {
        const idx = (py * imgW + px) * 3
        pixels[idx] = fillR
        pixels[idx + 1] = fillG
        pixels[idx + 2] = fillB
        filledCount++
      }
    }
  }

  const totalPixels = imgW * imgH
  const fillPercent = (filledCount / totalPixels) * 100

  return { pixels, filledCount, totalPixels, fillPercent }
}

/** Write an SVG file showing the polygon fill (no stroke, so fill is clearly visible). */
function writeSVG(
  filePath: string,
  verts: Point[],
  bbox: { minX: number; maxX: number; minY: number; maxY: number },
): void {
  const pad = 10
  const svgW = Math.round(bbox.maxX - bbox.minX + pad * 2)
  const svgH = Math.round(bbox.maxY - bbox.minY + pad * 2)
  const pointsStr = verts.map((v) => `${(v.x - bbox.minX + pad).toFixed(3)},${(v.y - bbox.minY + pad).toFixed(3)}`).join(' ')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
  <rect width="100%" height="100%" fill="#0f151d"/>
  <!-- No stroke here — fill-only so you can clearly see the solid shape -->
  <polygon points="${pointsStr}" fill="#4a7fa8"/>
</svg>`
  fs.writeFileSync(filePath, svg)
  console.log(`  Wrote SVG:  ${filePath} (${svgW}×${svgH})`)
}

// ── Profile → Point[] (unwrap from SketchProfile) ─────────────────────────
function profileToPoints(profile: SketchProfile): Point[] {
  const verts = profileVertices(profile)
  // profileVertices returns segments[0].end, segments[1].end, ...
  // but the profile.start is the first vertex
  return [profile.start, ...verts]
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  console.log('='.repeat(60))
  console.log('STL Silhouette Test')
  console.log('='.repeat(60))

  // 1. Load file
  if (!fs.existsSync(STL_PATH)) {
    console.error(`ERROR: File not found: ${STL_PATH}`)
    process.exit(1)
  }
  const fileSize = fs.statSync(STL_PATH).size
  console.log(`\n📂 STL file: ${STL_PATH} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`)

  // 2. Convert to base64
  const buffer = fs.readFileSync(STL_PATH)
  const base64 = buffer.toString('base64')
  console.log(`   Base64 size: ${(base64.length / 1024 / 1024).toFixed(1)} MB`)

  // 3. Extract profile
  console.log(`\n🔍 Extracting profile (scale=${STL_SCALE}, axisSwap=${STL_AXIS_SWAP})...`)
  const startTime = Date.now()
  let result: { profile: any; z_bottom: number; z_top: number } | null = null
  try {
    result = await extractStlProfileAndBounds(base64, STL_SCALE, STL_AXIS_SWAP, (pct) => {
      // progress callback
    })
  } catch (err) {
    console.error('  ERROR during extractStlProfileAndBounds:', err)
    process.exit(1)
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  if (!result) {
    console.error('  ERROR: extractStlProfileAndBounds returned null (empty profile)')
    process.exit(1)
  }

  const { profile, z_bottom, z_top } = result
  const verts = profileToPoints(profile)
  const bounds = getProfileBounds(profile)

  console.log(`   Done in ${elapsed}s`)
  console.log(`   Profile vertices: ${verts.length}`)
  console.log(`   Profile bounds:`)
  console.log(`     minX = ${bounds.minX.toFixed(4)}`)
  console.log(`     maxX = ${bounds.maxX.toFixed(4)}`)
  console.log(`     minY = ${bounds.minY.toFixed(4)}`)
  console.log(`     maxY = ${bounds.maxY.toFixed(4)}`)
  console.log(`     width  = ${(bounds.maxX - bounds.minX).toFixed(4)}`)
  console.log(`     height = ${(bounds.maxY - bounds.minY).toFixed(4)}`)
  console.log(`   Z range: ${z_bottom.toFixed(4)} → ${z_top.toFixed(4)}`)
  console.log(`   Profile closed: ${profile.closed}`)

  // 4. Try renderSilhouetteToDataUrl (should work in browser, but in Node.js
  //    document.createElement('canvas') will throw → returns null)
  console.log(`\n🖼️  Testing renderSilhouetteToDataUrl...`)
  let dataUrl: string | null = null
  try {
    dataUrl = renderSilhouetteToDataUrl(profile)
  } catch (err: any) {
    console.log(`   (Expected in Node.js: ${err?.message ?? err})`)
  }
  if (dataUrl) {
    console.log(`   ✅ Success! Data URL length: ${dataUrl.length} chars`)
    const b64data = dataUrl.replace(/^data:image\/png;base64,/, '')
    const pngPath = '/tmp/stl-silhouette-from-canvas.png'
    fs.writeFileSync(pngPath, Buffer.from(b64data, 'base64'))
    console.log(`   Wrote PNG: ${pngPath}`)
  } else {
    console.log(`   ⚠️  renderSilhouetteToDataUrl returned null (expected in Node.js, no DOM canvas)`)
    console.log(`   → Writing PNG bitmap via scanline fill instead`)
  }

  // 5. Compute image dimensions (matching renderSilhouetteToDataUrl logic)
  const bboxW = bounds.maxX - bounds.minX
  const bboxH = bounds.maxY - bounds.minY
  let imgW: number, imgH: number
  if (bboxW >= bboxH) {
    imgW = MAX_IMG_PX
    imgH = Math.max(1, Math.round(MAX_IMG_PX * (bboxH / bboxW)))
  } else {
    imgH = MAX_IMG_PX
    imgW = Math.max(1, Math.round(MAX_IMG_PX * (bboxW / bboxH)))
  }
  console.log(`\n📐 Silhouette image size: ${imgW}×${imgH} px`)

  // 6. Render silhouette pixels — TWO orientations
  console.log(`\n💾 Rendering silhouette (no Y-flip — matches renderSilhouetteToDataUrl)...`)
  const resultNoFlip = renderSilhouettePixels(verts, bounds, imgW, imgH, false)
  console.log(`   Filled pixels: ${resultNoFlip.filledCount} / ${resultNoFlip.totalPixels} (${resultNoFlip.fillPercent.toFixed(2)}%)`)

  console.log(`\n💾 Rendering silhouette (WITH Y-flip — canvas Y+ down convention)...`)
  const resultFlipped = renderSilhouettePixels(verts, bounds, imgW, imgH, true)
  console.log(`   Filled pixels: ${resultFlipped.filledCount} / ${resultFlipped.totalPixels} (${resultFlipped.fillPercent.toFixed(2)}%)`)

  // 7. Write PNGs
  console.log(`\n💾 Writing output files...`)
  writePNG(OUTPUT_PNG, resultNoFlip.pixels, imgW, imgH)
  writePNG(OUTPUT_PNG_FLIPPED, resultFlipped.pixels, imgW, imgH)

  // 8. Write profile vertices as JSON (for HTML diagnostic page)
  const jsonData = JSON.stringify({
    vertices: verts,
    bounds,
    imgW,
    imgH,
  })
  fs.writeFileSync(OUTPUT_JSON, jsonData)
  console.log(`  Wrote JSON: ${OUTPUT_JSON} (${(jsonData.length / 1024).toFixed(0)} KB, ${verts.length} vertices)`)

  // 9. Write SVG (vector format, no stroke — fill only)
  writeSVG(OUTPUT_SVG, verts, bounds)

  // 9. Summary
  // 10. Write an HTML diagnostic page that uses Canvas2D fill() API
  const htmlPath = '/tmp/stl-silhouette-diag.html'
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>STL Silhouette Diagnostic</title>
<style>
  body { background: #111; color: #ccc; font-family: sans-serif; padding: 20px; }
  h2 { color: #4a7fa8; }
  canvas { border: 1px solid #333; margin: 10px; }
  .row { display: flex; flex-wrap: wrap; gap: 20px; }
  .info { color: #888; font-size: 13px; }
</style>
</head>
<body>
<h1>STL Silhouette Diagnostic</h1>
<p>Vertices: ${verts.length} | Bounds: ${bounds.minX.toFixed(2)},${bounds.minY.toFixed(2)} → ${bounds.maxX.toFixed(2)},${bounds.maxY.toFixed(2)} | Size: ${bboxW.toFixed(2)}×${bboxH.toFixed(2)}</p>
<div class="row">
  <div>
    <h2>Canvas2D fill() API (matches browser)</h2>
    <canvas id="c1" width="${imgW}" height="${imgH}"></canvas>
    <div class="info">Uses ctx.beginPath() + ctx.fill() — same as SketchCanvas.tsx</div>
  </div>
  <div>
    <h2>Scanline (pointInPolygon)</h2>
    <canvas id="c2" width="${imgW}" height="${imgH}"></canvas>
    <div class="info">Filled: ${resultNoFlip.filledCount}/${resultNoFlip.totalPixels} (${resultNoFlip.fillPercent.toFixed(1)}%)</div>
  </div>
</div>
<script>
(function() {
  const verts = ${JSON.stringify(verts)};
  const bounds = ${JSON.stringify(bounds)};
  const imgW = ${imgW};
  const imgH = ${imgH};
  const scaleX = imgW / (bounds.maxX - bounds.minX);
  const scaleY = imgH / (bounds.maxY - bounds.minY);
  const originX = -bounds.minX;
  const originY = -bounds.minY;
  function sx(x) { return (x + originX) * scaleX; }
  function sy(y) { return (y + originY) * scaleY; }

  // Canvas 1: fill() API
  const c1 = document.getElementById('c1');
  const ctx1 = c1.getContext('2d');
  ctx1.fillStyle = '#0f151d';
  ctx1.fillRect(0, 0, imgW, imgH);
  ctx1.beginPath();
  ctx1.moveTo(sx(verts[0].x), sy(verts[0].y));
  for (let i = 1; i < verts.length; i++) {
    ctx1.lineTo(sx(verts[i].x), sy(verts[i].y));
  }
  ctx1.closePath();
  ctx1.fillStyle = '#4a7fa8';
  ctx1.fill();
  ctx1.strokeStyle = '#6b9fcb';
  ctx1.lineWidth = 1.5;
  ctx1.stroke();

  // Canvas 2: pointInPolygon scanline
  const c2 = document.getElementById('c2');
  const ctx2 = c2.getContext('2d');
  const imgData = ctx2.createImageData(imgW, imgH);
  const d = imgData.data;
  function pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
  for (let py = 0; py < imgH; py++) {
    for (let px = 0; px < imgW; px++) {
      const mx = px / scaleX - originX;
      const my = py / scaleY - originY;
      if (pointInPolygon(mx, my, verts)) {
        const idx = (py * imgW + px) * 4;
        d[idx] = 0x4a; d[idx+1] = 0x7f; d[idx+2] = 0xa8; d[idx+3] = 255;
      } else {
        const idx = (py * imgW + px) * 4;
        d[idx] = 0x0f; d[idx+1] = 0x15; d[idx+2] = 0x1d; d[idx+3] = 255;
      }
    }
  }
  ctx2.putImageData(imgData, 0, 0);
})();
</script>
</body>
</html>`
  fs.writeFileSync(htmlPath, html)
  console.log(`  Wrote HTML: ${htmlPath}`)

  console.log(`\n📋 Summary:`)
  console.log(`   Un-flipped (matches browser canvas orientation):`)
  console.log(`     PNG:  ${OUTPUT_PNG}`)
  console.log(`     Fill: ${resultNoFlip.fillPercent.toFixed(2)}% of image`)
  console.log(`   Y-flipped (alternative — canvas Y+ down convention):`)
  console.log(`     PNG:  ${OUTPUT_PNG_FLIPPED}`)
  console.log(`     Fill: ${resultFlipped.fillPercent.toFixed(2)}% of image`)
  console.log(`   SVG (fill-only, no stroke):`)
  console.log(`     SVG:  ${OUTPUT_SVG}`)
  console.log(`   Profile vertices: ${verts.length}`)
  console.log(`   Bounding box: ${(bboxW).toFixed(3)} × ${(bboxH).toFixed(3)} model units`)

  if (dataUrl) {
    console.log(`   ✅ renderSilhouetteToDataUrl produced a valid PNG`)
  }

  console.log('\nDone.')
}

run().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
